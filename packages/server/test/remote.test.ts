import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { listRemoteHosts } from "../src/remote/hosts";
import { assertHost, multiplexOptions, runOn, sendFile, shq } from "../src/remote/machine";
import { AccountService } from "../src/services/account-service";
import { RepoGit } from "../src/services/repo-git";
import { nullBroadcaster } from "../src/services/common";
import { PromptAssembler } from "../src/services/prompt-assembler";
import { PromptLibrary } from "../src/services/prompt-library";
import { QueueService } from "../src/services/queue-service";
import { RepoService } from "../src/services/repo-service";
import { AttachmentStore } from "../src/storage/attachment-store";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const fixtures = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const FAKE_SSH = join(fixtures, "fake-ssh.mjs");
const FAKE_CLAUDE = join(fixtures, "fake-claude.mjs");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const head = (cwd: string) => sh(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();

process.env.SLAVES_SSH_BIN = FAKE_SSH;

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup() {
  await chmod(FAKE_SSH, 0o755);
  await chmod(FAKE_CLAUDE, 0o755);
  const dir = await tempDir();
  await mkdir(join(dir, "remote-home"), { recursive: true });
  process.env.FAKE_REMOTE_HOME = await realpath(join(dir, "remote-home"));
  const promptLog = join(dir, "received.ndjson");
  process.env.FAKE_PROMPT_LOG = promptLog;
  const received = async () =>
    (await readFile(promptLog, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { cwd: string; prompt: string; args: string[] });

  // "Remote" repo (the fake ssh runs on this machine, under another $HOME).
  await mkdir(join(dir, "projects", "tinsel-crm-api"), { recursive: true });
  const repoPath = await realpath(join(dir, "projects", "tinsel-crm-api")); // macOS: /var → /private/var
  sh(repoPath, "init", "-q", "-b", "master");
  sh(repoPath, "config", "user.email", "t@e.com");
  sh(repoPath, "config", "user.name", "T");
  await writeFile(join(repoPath, "README.md"), "remote\n");
  sh(repoPath, "add", ".");
  sh(repoPath, "commit", "-q", "-m", "init");

  const { stores } = await openDataStores({ dataDir: join(dir, "data"), logger: memoryLogger() });
  await stores.settings.update((s) => {
    s.providers["claude-code"].binary = FAKE_CLAUDE;
  });
  const adapters = createAdapters();
  const accounts = new AccountService(stores, adapters, nullBroadcaster);
  const repos = new RepoService(stores);
  const attachments = new AttachmentStore(stores.paths.attachmentsDir);
  const prompts = new PromptLibrary(stores);
  // Remote accounts default to the server's `claude`; point them at the fake CLI here.
  const createRemote = async (label: string) => {
    const view = await accounts.create(label, "claude-code", "testhost");
    await stores.accounts.update((f) => {
      const a = f.accounts.find((x) => x.id === label);
      if (a) a.binary = FAKE_CLAUDE;
    });
    return view;
  };
  const queue = new QueueService({
    stores,
    accounts,
    repos,
    git: new RepoGit(),
    assembler: new PromptAssembler({
      globalBasePrompt: async () => "GLOBAL",
    }),
    adapters,
    broadcaster: nullBroadcaster,
    attachments,
    prompts,
  });
  await queue.init();
  return { dir, stores, accounts, repos, queue, attachments, repoPath, received, createRemote };
}

describe("remote machine plumbing", () => {
  it("quotes every argument so the remote shell takes it literally", async () => {
    const nasty = ["a b", "it's", "$HOME", "`whoami`", "; rm -rf /", "\"q\"", "line\nbreak", ""];
    const out = (await runOn("testhost", "printf", ["%s|", ...nasty], null)).stdout;
    expect(out).toBe(`${nasty.join("|")}|`);
    expect(execFileSync("sh", ["-c", `printf %s ${shq("it's $X")}`], { encoding: "utf8" })).toBe("it's $X");
  });

  it("refuses host names that could be read as ssh options or shell", () => {
    expect(() => assertHost("-oProxyCommand=touch /tmp/x")).toThrow();
    expect(() => assertHost("dev;ls")).toThrow();
    expect(assertHost("dev-server.tinselcrm.com")).toBe("dev-server.tinselcrm.com");
  });

  it("reuses one ssh connection per host, except on Windows or when the socket path would be too long", () => {
    expect(multiplexOptions("darwin", "/Users/me/.ssh/my-ai-slaves")).toEqual([
      "-o", "ControlMaster=auto", "-o", "ControlPath=/Users/me/.ssh/my-ai-slaves/%C", "-o", "ControlPersist=60",
    ]);
    expect(multiplexOptions("win32", "C:/Users/me/.ssh/my-ai-slaves")).toEqual([]);
    expect(multiplexOptions("linux", null)).toEqual([]);
    expect(multiplexOptions("linux", `/home/${"x".repeat(80)}`)).toEqual([]);
  });

  it("fails a file copy whose local file can't be read, without hanging", async () => {
    await chmod(FAKE_SSH, 0o755);
    const dir = await tempDir();
    await expect(sendFile("testhost", join(dir, "missing.png"), join(dir, "out"), "x.png")).rejects.toThrow();
  });

  it("lists hosts like Remote Explorer: ssh config (no wildcards, Include followed) + editor history", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "extra"), "Host staging\n  HostName 10.0.0.5\n");
    await writeFile(join(dir, "config"), `Host *\n  ServerAliveInterval 30\nHost dev\n  HostName 34.224.110.95\nInclude ${join(dir, "extra")}\n`);
    await writeFile(
      join(dir, "storage.json"),
      JSON.stringify({ x: ["vscode-remote://ssh-remote%2Bdev/home/rlargo/projects/tinsel-crm-api", "file:///local"] }),
    );
    const hosts = await listRemoteHosts({ sshConfig: join(dir, "config"), editorStorageDirs: [dir] });
    expect(hosts).toEqual([
      { host: "dev", hostname: "34.224.110.95", recentFolders: ["/home/rlargo/projects/tinsel-crm-api"] },
      { host: "staging", hostname: "10.0.0.5", recentFolders: [] },
    ]);
  });
});

describe("repos on an SSH host", () => {
  it("registers, browses and runs a task on the server with the server's login", async () => {
    const { accounts, repos, queue, repoPath, received, createRemote } = await setup();
    await accounts.create("mac-claude", "claude-code");
    const remoteAccount = await createRemote("dev-claude");
    expect(remoteAccount).toMatchObject({ host: "testhost", configDir: "", binary: "claude" });

    const repo = await repos.register(repoPath, "testhost");
    expect(repo).toMatchObject({ host: "testhost", path: repoPath, defaultBranch: "master", name: "tinsel-crm-api" });
    expect(repo.accountChain).toEqual(["dev-claude"]); // only accounts on that host
    expect(repo.availability.state).toBe("ok");
    await expect(repos.update(repo.id, { accountChain: ["mac-claude"] })).rejects.toThrow("different machine");

    const listing = await repos.browse(join(repoPath, ".."), "testhost");
    expect(listing.dirs).toEqual([{ name: "tinsel-crm-api", path: repoPath, isGitRepo: true }]);

    await (await repos.prompts(repo.id)).create("Rules", "REPO", { default: true });
    const task = await queue.create({ repo: repo.id, message: "fix the api" });
    const done = await waitFor(async () => (await queue.list()).find((t) => t.id === task.id && t.status === "needs-review"));
    expect(done.currentAccount).toBe("dev-claude");
    const [call] = await received();
    expect(call?.cwd).toBe(repoPath);
    expect(call?.prompt).toBe("GLOBAL\n\nREPO\n\nfix the api");
    // Run in the checkout as it is: the file is just there, no branch was made.
    expect(sh(repoPath, "status", "--porcelain").trim()).toBe("?? out-none.txt");
    expect(sh(repoPath, "branch", "--list", "ai/*").trim()).toBe("");
    expect(head(repoPath)).toBe("master");
    expect((await queue.diff(task.id)).patch).toContain("out-none.txt");
  });

  it("copies attached files to the server and points the CLI there", async () => {
    const { repos, queue, attachments, repoPath, received, createRemote } = await setup();
    await createRemote("dev-claude");
    const repo = await repos.register(repoPath, "testhost");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const file = await attachments.save(png, "bug.png", "image/png");
    const task = await queue.create({ repo: repo.id, message: "see image", attachmentIds: [file.id] });
    await waitFor(async () => (await queue.list()).find((t) => t.id === task.id && t.status === "needs-review"));
    const remoteFile = join(process.env.FAKE_REMOTE_HOME!, ".my-ai-slaves", "attachments", file.id, "bug.png");
    expect(await readFile(remoteFile)).toEqual(png);
    const [call] = await received();
    expect(call?.prompt).toContain(`Attached files:\n- ${remoteFile}`);
    expect(call?.args).toEqual(expect.arrayContaining(["--add-dir", join(process.env.FAKE_REMOTE_HOME!, ".my-ai-slaves", "attachments", file.id)]));
  });

  it("diffs every new file of a remote repo in one command, odd names included", async () => {
    const { repos, repoPath } = await setup();
    const repo = await repos.register(repoPath, "testhost");
    const names = ["a.txt", "with space.txt", "it's.txt", "$(whoami).txt"];
    for (const n of names) await writeFile(join(repoPath, n), `${n}\n`);
    const git = new RepoGit();
    const start = (await git.where(repo))!;
    const { patch } = await git.changesSince(repo, start);
    for (const n of names) expect(patch).toContain(`+${n}`);
    expect((await git.workingChanges(repo)).unstagedPatch).toContain("+with space.txt");
  });

  it("copies an attachment to a host only once", async () => {
    const { attachments } = await setup();
    const file = await attachments.save(Buffer.from("hello"), "notes.txt", "text/plain");
    const first = (await attachments.locate("testhost", [file])).get(file.id)!;
    expect(await readFile(first.path, "utf8")).toBe("hello");
    await rm(first.dir, { recursive: true });
    const second = (await attachments.locate("testhost", [file])).get(file.id)!;
    expect(second).toEqual(first);
    await expect(readFile(second.path)).rejects.toThrow();
  });

  it("deletes an attachment's copy on the host, and sweeps old ones nothing uses", async () => {
    const { attachments } = await setup();
    const file = await attachments.save(Buffer.from("hello"), "notes.txt", "text/plain");
    const copy = (await attachments.locate("testhost", [file])).get(file.id)!;
    await attachments.remove([file.id]);
    await expect(stat(copy.dir)).rejects.toThrow();
    expect(await attachments.find(file.id)).toBeNull();

    const kept = await attachments.save(Buffer.from("a"), "a.txt", "text/plain");
    const stale = await attachments.save(Buffer.from("b"), "b.txt", "text/plain");
    const located = await attachments.locate("testhost", [kept, stale]);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const a of [kept, stale]) {
      await utimes(located.get(a.id)!.dir, old, old);
      await utimes(attachments.dirOf(a.id), old, old);
    }
    expect(await attachments.sweep(new Set([kept.id]), ["testhost"])).toEqual([stale.id]);
    await expect(stat(located.get(stale.id)!.dir)).rejects.toThrow();
    expect((await stat(located.get(kept.id)!.dir)).isDirectory()).toBe(true);
  });

  it("stops a running task on the server itself", async () => {
    const { repos, queue, repoPath, createRemote } = await setup();
    await createRemote("dev-claude");
    const repo = await repos.register(repoPath, "testhost");
    const task = await queue.create({ repo: repo.id, message: "SLOW remote job" });
    await waitFor(async () => queue.replay(task.id).events.length > 0);
    const started = Date.now();
    await queue.cancel(task.id);
    await waitFor(async () => (await queue.list()).find((t) => t.id === task.id && t.status === "interrupted"));
    expect(Date.now() - started).toBeLessThan(8000); // killed via `kill -INT <pid>` on the host, not a timeout
    expect(head(repoPath)).toBe("master");
  });

  it("shows an unreachable repo and makes its tasks wait instead of failing", async () => {
    const { repos, queue, repoPath, stores, createRemote } = await setup();
    await createRemote("dev-claude");
    await expect(repos.register(repoPath, "down-host")).rejects.toThrow("Unable to reach down-host");

    const repo = await repos.register(repoPath, "testhost");
    // The server goes away (VPN off, host down...).
    await stores.repos.update((f) => {
      f.repos[0]!.host = "down-host";
    });
    await stores.accounts.update((f) => {
      f.accounts[0]!.host = "down-host";
    });
    const availability = await repos.checkAvailability((await repos.list())[0]!);
    expect(availability).toMatchObject({ state: "unreachable" });
    expect(availability.message).toContain("Operation timed out");

    const task = await queue.create({ repo: repo.id, message: "anything" });
    const waiting = await waitFor(async () => (await queue.list()).find((t) => t.id === task.id && t.waitingNote));
    expect(waiting.status).toBe("pending");
    expect(waiting.waitingNote).toContain("Unable to load tinsel-crm-api at this time");
  });
});
