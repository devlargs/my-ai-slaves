import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Repo, ScriptRunInfo } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { detectPackageManager, parseScripts, ScriptService } from "../src/services/script-service";
import { tempDir } from "./helpers";

const FAKE_SSH = join(resolve(fileURLToPath(new URL("./fixtures", import.meta.url))), "fake-ssh.mjs");

async function repoWith(scripts: Record<string, string>, extra: Record<string, string> = {}): Promise<string> {
  const dir = await tempDir();
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts }, null, 2));
  for (const [name, text] of Object.entries(extra)) await writeFile(join(dir, name), text);
  return dir;
}

const repo = (path: string, host: string | null = null) => ({ id: "demo", name: "demo", path, host }) as unknown as Repo;

function service() {
  const updates: ScriptRunInfo[] = [];
  const chunks: string[] = [];
  const scripts = new ScriptService({
    scriptUpdated: (_repoId, run) => updates.push(run),
    scriptOutput: (_repoId, _runId, chunk) => chunks.push(chunk),
  });
  const ended = (script: string) =>
    new Promise<ScriptRunInfo>((done) => {
      const check = () => {
        const last = updates.filter((u) => u.script === script).at(-1);
        if (last && last.status !== "running") done(last);
        else setTimeout(check, 25);
      };
      check();
    });
  return { scripts, updates, chunks, ended };
}

const node = (code: string) => `node -e "${code}"`;

describe("repo scripts", () => {
  it("lists package.json scripts in file order with the repo's package manager", async () => {
    const dir = await repoWith({ dev: "vite", build: "tsc && vite build" }, { "pnpm-lock.yaml": "" });
    const { scripts } = service();
    expect(await scripts.list(repo(dir))).toEqual({
      found: true,
      packageManager: "pnpm",
      scripts: [
        { name: "dev", command: "vite" },
        { name: "build", command: "tsc && vite build" },
      ],
    });
    expect((await scripts.list(repo(await tempDir()))).found).toBe(false);
  });

  it("picks the package manager from packageManager, then the lockfile", () => {
    expect(detectPackageManager({ packageManager: "yarn@4.1.0" }, ["package-lock.json"])).toBe("yarn");
    expect(detectPackageManager({}, ["bun.lock"])).toBe("bun");
    expect(detectPackageManager({}, ["yarn.lock"])).toBe("yarn");
    expect(detectPackageManager({}, [])).toBe("npm");
    expect(parseScripts({ scripts: { ok: "x", bad: 3 } })).toEqual([{ name: "ok", command: "x" }]);
  });

  it("runs a script in the repo folder and streams its output", async () => {
    const dir = await repoWith({ hello: node("console.log('hi from ' + process.cwd())"), fail: node("process.exit(3)") });
    const { scripts, chunks, ended } = service();
    const run = await scripts.run(repo(dir), "hello");
    expect(run).toMatchObject({ script: "hello", commandLine: "npm run hello", status: "running" });
    expect(await ended("hello")).toMatchObject({ status: "done", exitCode: 0 });
    expect(chunks.join("")).toContain("hi from ");
    expect(scripts.replay("demo")[0]?.output).toContain("hi from ");

    await scripts.run(repo(dir), "fail");
    expect(await ended("fail")).toMatchObject({ status: "failed", exitCode: 3 });
  }, 30_000);

  it("refuses unknown scripts and a second copy of a running one, and stops it", async () => {
    const dir = await repoWith({ serve: node("console.log('up'); setInterval(() => {}, 1000)") });
    const { scripts, ended } = service();
    await expect(scripts.run(repo(dir), "nope")).rejects.toThrow(/No script/);
    await scripts.run(repo(dir), "serve");
    await expect(scripts.run(repo(dir), "serve")).rejects.toThrow(/already running/);
    await scripts.stop("demo", "serve");
    expect(await ended("serve")).toMatchObject({ status: "stopped" });
  }, 30_000);

  it.skipIf(process.platform === "win32")("runs and stops scripts on an SSH host", async () => {
    await chmod(FAKE_SSH, 0o755);
    process.env.SLAVES_SSH_BIN = FAKE_SSH;
    const dir = await repoWith({ hello: node("console.log('remote hi')"), serve: `${node("setInterval(() => {}, 1000)")} && echo bye` });
    const { scripts, chunks, ended } = service();
    expect((await scripts.list(repo(dir, "devbox"))).scripts.map((s) => s.name)).toEqual(["hello", "serve"]);
    await scripts.run(repo(dir, "devbox"), "hello");
    expect(await ended("hello")).toMatchObject({ status: "done" });
    const out = chunks.join("");
    expect(out).toContain("remote hi");
    expect(out).not.toContain("__SLAVES_PID__");

    await scripts.run(repo(dir, "devbox"), "serve");
    await new Promise((r) => setTimeout(r, 1000)); // let the pid marker arrive
    await scripts.stop("demo", "serve");
    expect(await ended("serve")).toMatchObject({ status: "stopped" });
  }, 30_000);
});
