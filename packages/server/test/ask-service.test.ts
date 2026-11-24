import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { CursorAgentAdapter } from "../src/providers/cursor-agent/adapter";
import { AccountService } from "../src/services/account-service";
import { AskService, messagesToEvents } from "../src/services/ask-service";
import { nullBroadcaster } from "../src/services/common";
import { RepoService } from "../src/services/repo-service";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const fixtures = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const FAKE_CLAUDE = join(fixtures, "fake-claude.mjs");
const FAKE_CURSOR = join(fixtures, "fake-cursor.mjs");

interface Received {
  cli: "claude" | "cursor";
  label: string;
  cwd: string;
  args: string[];
  prompt: string;
}

async function setup(labels = ["work_1-claude", "personal-claude"]) {
  await chmod(FAKE_CLAUDE, 0o755);
  await chmod(FAKE_CURSOR, 0o755);
  const dir = await tempDir();
  const promptLog = join(dir, "received.ndjson");
  process.env.FAKE_PROMPT_LOG = promptLog;
  const received = async (): Promise<Received[]> =>
    (await readFile(promptLog, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const { stores } = await openDataStores({ dataDir: join(dir, "data"), logger: memoryLogger() });
  await stores.settings.update((s) => {
    s.providers["claude-code"].binary = FAKE_CLAUDE;
    s.providers["cursor-agent"].binary = FAKE_CURSOR;
    s.basePrompt = "GLOBAL RULES";
  });
  const adapters = createAdapters();
  const accounts = new AccountService(stores, adapters, nullBroadcaster);
  for (const label of labels) await accounts.create(label, label.includes("cursor") ? "cursor-agent" : "claude-code");
  const repos = new RepoService(stores);
  const ask = new AskService({ stores, accounts, repos, adapters, broadcaster: nullBroadcaster });
  await ask.init();
  return { dir, stores, accounts, repos, ask, received };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const idle = (ask: AskService, id: string, messages: number) => () =>
  ask.list().then((cs) => cs.find((c) => c.id === id && c.status === "idle" && c.messageCount >= messages));

describe("AskService", () => {
  it("answers a question without a repo: only the message is sent, read-only, in the scratch folder", async () => {
    const { ask, stores, received } = await setup();
    const chat = await ask.create({ message: "what is a monad?" });
    expect(chat.id).toBe("ask_0001_what-is-a-monad");
    expect(chat.repo).toBeNull();
    await waitFor(idle(ask, chat.id, 2));

    const [call] = await received();
    // No base prompt, no repo prompts, no app text: just the question.
    expect(call?.prompt).toBe("what is a monad?");
    expect(call?.cwd).toBe(await realpath(stores.paths.askDir));
    expect(call?.args).toEqual(expect.arrayContaining(["--permission-mode", "plan", "Edit", "Write", "NotebookEdit"]));

    const saved = (await stores.ask.read()).chats[0];
    expect(saved?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "what is a monad?"],
      ["assistant", "Done"],
    ]);
    expect(saved?.session?.account).toBe("work_1-claude");
    const started = (await stores.activity.forTask(chat.id)).find((e) => e.event === "started");
    expect(started?.data?.prompt).toBe("what is a monad?");
  });

  it("follows up in the same session", async () => {
    const { ask, received } = await setup();
    const chat = await ask.create({ message: "first" });
    await waitFor(idle(ask, chat.id, 2));
    await ask.ask(chat.id, "and then?");
    await waitFor(idle(ask, chat.id, 4));
    const calls = await received();
    expect(calls[1]?.prompt).toBe("and then?");
    expect(calls[1]?.args).toContain("--resume");
    expect(ask.replay(chat.id).events.filter((e) => e.kind === "user").map((e) => (e as { text: string }).text)).toEqual(["first", "and then?"]);
  });

  it("moves on to the next account when one hits its limit", async () => {
    const { ask, stores, received } = await setup();
    const chat = await ask.create({ message: "LIMIT:work_1-claude explain" });
    await waitFor(idle(ask, chat.id, 2));
    expect((await received()).map((c) => c.label)).toEqual(["work_1-claude", "personal-claude"]);
    const saved = (await stores.ask.read()).chats[0];
    expect(saved?.messages.at(-1)).toMatchObject({ role: "assistant", account: "personal-claude" });
  });

  it("runs in an attached repo, using its chain, without changing branches", async () => {
    const { ask, repos, dir, received } = await setup();
    const path = join(dir, "repo");
    await mkdir(path);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
    await writeFile(join(path, "a.txt"), "a\n");
    const repo = await repos.register(path);
    await repos.update(repo.id, { accountChain: ["personal-claude"] });
    const chat = await ask.create({ message: "what does this repo do?", repo: repo.id });
    await waitFor(idle(ask, chat.id, 2));
    const [call] = await received();
    expect(call?.label).toBe("personal-claude");
    expect(call?.cwd).toBe(repo.path);
    expect(call?.prompt).toBe("what does this repo do?");
  });

  it("shows a stopped or failed run in the chat and lets you ask again", async () => {
    const { ask, stores } = await setup();
    const chat = await ask.create({ message: "SLOW" });
    await expect(ask.ask(chat.id, "again")).rejects.toThrow(/still answering/);
    await waitFor(async () => (await stores.ask.read()).chats[0]?.currentAccount);
    await waitFor(async () => {
      try {
        await ask.stop(chat.id);
        return true;
      } catch {
        return false;
      }
    });
    await waitFor(idle(ask, chat.id, 2));
    expect((await stores.ask.read()).chats[0]?.messages.at(-1)).toMatchObject({ role: "error", text: "Stopped." });
    await ask.remove(chat.id);
    expect(await ask.list()).toEqual([]);
  });

  it("asks Cursor for its read-only mode instead of the permission setting", async () => {
    const { stores } = await setup();
    const settings = await stores.settings.read();
    settings.providers["cursor-agent"].permissionMode = "force";
    const args = new CursorAgentAdapter().buildArgs({ cwd: "/x", resume: null, readOnly: true }, settings);
    expect(args).toEqual(expect.arrayContaining(["--mode", "ask"]));
    expect(args).not.toContain("--force");
  });

  it("turns saved messages into the events a chat view draws", () => {
    const at = "2026-11-24T10:00:00+08:00";
    expect(
      messagesToEvents([
        { at, role: "user", text: "q1", account: null },
        { at, role: "assistant", text: "a1", account: "x" },
        { at, role: "user", text: "q2", account: null },
        { at, role: "error", text: "Stopped.", account: "x" },
      ]),
    ).toEqual([
      { kind: "user", text: "q1", reply: false, attachments: [], prompts: [] },
      { kind: "message", text: "a1" },
      { kind: "user", text: "q2", reply: true, attachments: [], prompts: [] },
      { kind: "warning", text: "Stopped." },
    ]);
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import("node:fs/promises");
  return rp(p);
}
