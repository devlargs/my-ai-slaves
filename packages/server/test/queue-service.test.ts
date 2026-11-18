import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { AccountService } from "../src/services/account-service";
import { nullBroadcaster } from "../src/services/common";
import { PromptAssembler } from "../src/services/prompt-assembler";
import { QueueService } from "../src/services/queue-service";
import { RepoService } from "../src/services/repo-service";
import { WorktreeService } from "../src/services/worktree-service";
import { AttachmentStore } from "../src/storage/attachment-store";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const fixtures = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const FAKE_CLAUDE = join(fixtures, "fake-claude.mjs");
const FAKE_CURSOR = join(fixtures, "fake-cursor.mjs");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function makeRepo(dir: string): Promise<string> {
  const repo = join(dir, "my-repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  return repo;
}

async function setup(chain = ["work_1-claude", "work_2-cursor"]) {
  await chmod(FAKE_CLAUDE, 0o755);
  await chmod(FAKE_CURSOR, 0o755);
  const dir = await tempDir();
  const { stores } = await openDataStores({ dataDir: join(dir, "data"), logger: memoryLogger() });
  await stores.settings.update((s) => {
    s.providers["claude-code"].binary = FAKE_CLAUDE;
    s.providers["cursor-agent"].binary = FAKE_CURSOR;
    s.basePrompt = "GLOBAL";
  });
  const adapters = createAdapters();
  const accounts = new AccountService(stores, adapters, nullBroadcaster);
  for (const label of ["work_1-claude", "work_2-cursor", "personal-claude"]) {
    await accounts.create(label, label.includes("cursor") ? "cursor-agent" : "claude-code");
  }
  const repos = new RepoService(stores);
  const repo = await repos.register(await makeRepo(dir));
  await repos.update(repo.id, { accountChain: chain });
  const assembler = new PromptAssembler({
    globalBasePrompt: async () => (await stores.settings.read()).basePrompt,
    repoBasePrompt: (r) => repos.basePromptOf(r),
  });
  const queue = new QueueService({
    stores,
    accounts,
    repos,
    worktrees: new WorktreeService(stores.paths.worktreesDir),
    assembler,
    adapters,
    broadcaster: nullBroadcaster,
    attachments: new AttachmentStore(stores.paths.attachmentsDir),
  });
  await queue.init();
  return { stores, accounts, repos, queue, repo, attachments: (queue as any).deps.attachments as AttachmentStore };
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

const taskWith = (queue: QueueService, id: string, status: string) => () =>
  queue.list().then((ts) => ts.find((t) => t.id === id && t.status === status));

describe("QueueService (fake CLIs, real git)", () => {
  it("runs a task in its own worktree and records the exact prompt", async () => {
    const { queue, stores, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "add a greeting" });
    expect(created.id).toBe("task_0001_add-a-greeting");

    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(done.currentAccount).toBe("work_1-claude");
    expect(done.worktree?.branch).toBe("ai/task_0001_add-a-greeting");
    expect(await readFile(join(done.worktree!.path, "out-work_1-claude.txt"), "utf8")).toBe("GLOBAL\n\nadd a greeting");

    // main working tree untouched
    expect(sh(repo.path, "status", "--porcelain")).toBe("");

    const history = await stores.activity.forTask(created.id);
    const started = history.find((e) => e.event === "started");
    expect(started?.data?.prompt).toBe("GLOBAL\n\nadd a greeting");
    expect(history.map((e) => e.event)).toEqual(expect.arrayContaining(["queued", "started", "message", "tool-call", "file-edit", "finished"]));

    const { patch } = await queue.diff(created.id);
    expect(patch).toContain("out-work_1-claude.txt");
  });

  it("passes attached files to the CLI as paths and readable folders", async () => {
    const { queue, stores, repo, attachments } = await setup();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const file = await attachments.save(png, "screen shot.png", "image/png");
    expect(file.mime).toBe("image/png");
    const created = await queue.create({ repo: repo.id, message: "fix what the screenshot shows", attachmentIds: [file.id] });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    const started = (await stores.activity.forTask(created.id)).find((e) => e.event === "started");
    expect(started?.data?.prompt).toBe(
      `GLOBAL\n\nfix what the screenshot shows\n\nAttached files:\n- ${attachments.pathOf(file)}`,
    );
    await expect(queue.create({ repo: repo.id, message: "x", attachmentIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(
      "missing",
    );
  });

  it("falls back to the next account on a usage limit", async () => {
    const { queue, stores, accounts, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "LIMIT:work_1-claude please" });

    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(done.currentAccount).toBe("work_2-cursor");
    // Fresh run started over: only the second account's output exists.
    expect(await readFile(join(done.worktree!.path, "out-work_2-cursor.txt"), "utf8")).toContain("LIMIT:work_1-claude");
    await expect(readFile(join(done.worktree!.path, "out-work_1-claude.txt"))).rejects.toThrow();

    const limited = (await accounts.list()).find((a) => a.id === "work_1-claude");
    expect(limited?.status).toBe("limited");
    expect(limited?.limitedUntil).toMatch(/^2100-01-01T/);

    const history = await stores.activity.forTask(created.id);
    expect(history.find((e) => e.event === "fallback")?.detail).toBe("work_1-claude hit usage limit, retrying on work_2-cursor");
  });

  it("removes a failed task from the queue and keeps it in history", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "FAIL now" });
    await waitFor(async () => (await queue.list()).length === 0);
    const history = await queue.history();
    expect(history[0]).toMatchObject({ taskId: created.id, outcome: "failed" });
    expect(sh(repo.path, "branch", "--list", "ai/*")).toBe("");
  });

  it("cancelling a running task leaves it interrupted", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW job" });
    await waitFor(taskWith(queue, created.id, "running"));
    await new Promise((r) => setTimeout(r, 300));
    await queue.cancel(created.id);
    await waitFor(taskWith(queue, created.id, "interrupted"));
  });

  it("replies resume the same session", async () => {
    const { queue, stores, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "first" });
    const first = await waitFor(taskWith(queue, created.id, "needs-review"));
    await queue.reply(created.id, "now the follow-up");
    const second = await waitFor(async () => {
      const t = (await queue.list()).find((x) => x.id === created.id);
      return t?.status === "needs-review" && t.replies.length === 1 && t.pendingReply === null ? t : null;
    });
    expect(second.session?.sessionId).toBe(first.session?.sessionId);
    const starts = (await stores.activity.forTask(created.id)).filter((e) => e.event === "started");
    expect(starts.map((e) => e.data?.prompt)).toEqual(["GLOBAL\n\nfirst", "now the follow-up"]);
  });

  it("keep commits leftovers on the ai/ branch and removes the worktree", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "keep me" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    await queue.keep(created.id);
    expect(sh(repo.path, "log", "--format=%s", "-1", "ai/task_0001_keep-me").trim()).toBe("keep me");
    expect(sh(repo.path, "log", "--format=%s", "-1", "main").trim()).toBe("init");
    expect((await queue.history())[0]).toMatchObject({ outcome: "done", branch: "ai/task_0001_keep-me" });
  });

  it("commits as the repo's committer and strips AI co-author trailers before Keep", async () => {
    const { queue, repos, repo } = await setup();
    await repos.update(repo.id, { committerName: "Ralph Example", committerEmail: "ralph@example.com" });
    const created = await queue.create({ repo: repo.id, message: "COMMIT please" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    await queue.keep(created.id);

    const branch = `ai/${created.id}`;
    const log = sh(repo.path, "log", "--format=%an <%ae>|%cn <%ce>|%B%x00", `main..${branch}`);
    const commits = log.split("\0").map((c) => c.trim()).filter(Boolean);
    expect(commits).toHaveLength(2); // the agent's commit + the leftovers commit
    for (const c of commits) {
      expect(c.startsWith("Ralph Example <ralph@example.com>|Ralph Example <ralph@example.com>|")).toBe(true);
      expect(c).not.toMatch(/co-authored-by/i);
    }
    expect(commits.some((c) => c.includes("feat: agent work"))).toBe(true);
  });

  it("discards tasks in any state, stopping a running one first", async () => {
    const { queue, repo, stores } = await setup();
    const running = await queue.create({ repo: repo.id, message: "SLOW long job" });
    const pending = await queue.create({ repo: repo.id, message: "never started" });
    await waitFor(async () => queue.replay(running.id).events.length > 0);

    await queue.discard(pending.id);
    await queue.discard(running.id);

    expect(await queue.list()).toEqual([]);
    expect(sh(repo.path, "branch", "--list", "ai/*")).toBe("");
    expect(sh(repo.path, "worktree", "list")).not.toContain("task_0001");
    const outcomes = Object.fromEntries((await queue.history()).map((h) => [h.taskId, h.outcome]));
    expect(outcomes).toEqual({ [running.id]: "discarded", [pending.id]: "discarded" });
    const last = (await stores.activity.forTask(running.id)).at(-1);
    expect(last?.detail).toContain("Stopped and discarded");
  });

  it("runs only one task per repo at a time", async () => {
    const { queue, repo } = await setup();
    const a = await queue.create({ repo: repo.id, message: "SLOW one" });
    const b = await queue.create({ repo: repo.id, message: "two" });
    await waitFor(taskWith(queue, a.id, "running"));
    const waiting = await waitFor(async () => (await queue.list()).find((t) => t.id === b.id && t.waitingNote));
    expect(waiting.status).toBe("pending");
    expect(waiting.waitingNote).toContain("other task on this repo");
    await new Promise((r) => setTimeout(r, 300));
    await queue.cancel(a.id);
    await waitFor(taskWith(queue, a.id, "interrupted"));
    // b runs once a stops
    await waitFor(taskWith(queue, b.id, "needs-review"));
  });

  it("tasks running when the server stopped come back interrupted", async () => {
    const { stores, queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW crash" });
    await waitFor(async () => queue.replay(created.id).events.length > 0); // process attached and streaming
    await queue.shutdown();
    await waitFor(taskWith(queue, created.id, "interrupted"));
    // Simulate a hard crash: queue.json still says running.
    await stores.queue.update((q) => {
      q.tasks[0]!.status = "running";
    });
    const fresh = new QueueService({ ...(queue as any).deps });
    await fresh.init();
    expect((await fresh.list())[0]?.status).toBe("interrupted");
    expect((await stores.activity.forTask(created.id)).at(-1)?.event).toBe("interrupted");
  });
});
