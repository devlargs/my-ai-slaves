import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { AccountService } from "../src/services/account-service";
import { BranchService } from "../src/services/branch-service";
import { nullBroadcaster } from "../src/services/common";
import { PromptAssembler } from "../src/services/prompt-assembler";
import { PromptLibrary } from "../src/services/prompt-library";
import { QueueService } from "../src/services/queue-service";
import { RepoService } from "../src/services/repo-service";
import { AttachmentStore } from "../src/storage/attachment-store";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const fixtures = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const FAKE_CLAUDE = join(fixtures, "fake-claude.mjs");
const FAKE_CURSOR = join(fixtures, "fake-cursor.mjs");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const head = (cwd: string) => sh(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();

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

interface Received {
  cli: "claude" | "cursor";
  label: string;
  cwd: string;
  args: string[];
  prompt: string;
}

async function setup(chain = ["work_1-claude", "work_2-cursor"]) {
  await chmod(FAKE_CLAUDE, 0o755);
  await chmod(FAKE_CURSOR, 0o755);
  const dir = await tempDir();
  // The fake CLIs append exactly what they received here.
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
  for (const label of ["work_1-claude", "work_2-cursor", "personal-claude"]) {
    await accounts.create(label, label.includes("cursor") ? "cursor-agent" : "claude-code");
  }
  const repos = new RepoService(stores);
  const repo = await repos.register(await makeRepo(dir));
  await repos.update(repo.id, { accountChain: chain });
  await (await repos.prompts(repo.id)).create("Repo rules", "REPO RULES", { default: true });
  const assembler = new PromptAssembler({
    globalBasePrompt: async () => (await stores.settings.read()).basePrompt,
  });
  const attachments = new AttachmentStore(stores.paths.attachmentsDir);
  const prompts = new PromptLibrary(stores);
  const queue = new QueueService({
    stores,
    accounts,
    repos,
    branches: new BranchService(),
    assembler,
    adapters,
    broadcaster: nullBroadcaster,
    attachments,
    prompts,
  });
  await queue.init();
  return { dir, stores, accounts, repos, queue, repo, attachments, prompts, received };
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

const FULL = (message: string) => `GLOBAL RULES\n\nREPO RULES\n\n${message}`;

describe("QueueService: branches in the repo itself (no worktrees)", () => {
  it("runs on ai/<task-id> from the base branch, commits there, and switches back", async () => {
    const { queue, stores, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "add a greeting" });
    expect(created.id).toBe("task_0001_add-a-greeting");

    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(done.branch).toMatchObject({ name: "ai/task_0001_add-a-greeting", base: "main", returnTo: "main" });

    // The CLI ran in the repo folder itself and received global + repo base prompts + the message.
    const [call] = await received();
    expect(call?.cwd).toBe(repo.path);
    expect(call?.prompt).toBe(FULL("add a greeting"));

    // The work is committed on the task branch; your checkout is back on main and clean.
    expect(sh(repo.path, "show", "ai/task_0001_add-a-greeting:out-work_1-claude.txt")).toBe(FULL("add a greeting"));
    expect(head(repo.path)).toBe("main");
    expect(sh(repo.path, "status", "--porcelain")).toBe("");
    expect(sh(repo.path, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(sh(repo.path, "log", "-1", "--format=%s", "main").trim()).toBe("init");

    const started = (await stores.activity.forTask(created.id)).find((e) => e.event === "started");
    expect(started?.data?.prompt).toBe(FULL("add a greeting"));
    expect(started?.data?.cwd).toBe(repo.path);
    expect(started?.data?.layers).toEqual([
      { name: "global", included: true },
      { name: "repo", included: true },
      { name: "prompts", included: false },
      { name: "message", included: true },
      { name: "attachments", included: false },
    ]);

    const { patch } = await queue.diff(created.id);
    expect(patch).toContain("out-work_1-claude.txt");
  });

  it("switches back to whatever branch you were on", async () => {
    const { queue, repo } = await setup();
    sh(repo.path, "checkout", "-q", "-b", "feature/mine");
    const created = await queue.create({ repo: repo.id, message: "small fix" });
    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(head(repo.path)).toBe("feature/mine");
    // ...but the task branch still starts from the base branch, not from your branch.
    expect(sh(repo.path, "merge-base", "main", done.branch!.name).trim()).toBe(sh(repo.path, "rev-parse", "main").trim());
  });

  it("waits while your checkout has uncommitted changes", async () => {
    const { queue, repo } = await setup();
    await writeFile(join(repo.path, "README.md"), "my unsaved work\n");
    const created = await queue.create({ repo: repo.id, message: "do something" });
    const waiting = await waitFor(async () => (await queue.list()).find((t) => t.id === created.id && t.waitingNote));
    expect(waiting.status).toBe("pending");
    expect(waiting.waitingNote).toContain("uncommitted changes");
    expect(head(repo.path)).toBe("main");

    sh(repo.path, "commit", "-qam", "my work");
    await queue.tick();
    await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(head(repo.path)).toBe("main");
  });

  it("passes attached files to the CLI as paths", async () => {
    const { queue, repo, attachments, received } = await setup();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const file = await attachments.save(png, "screen shot.png", "image/png");
    const created = await queue.create({ repo: repo.id, message: "fix what it shows", attachmentIds: [file.id] });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    const [call] = await received();
    expect(call?.prompt).toBe(`${FULL("fix what it shows")}\n\nAttached files:\n- ${attachments.pathOf(file)}`);
    expect(call?.args).toEqual(expect.arrayContaining(["--add-dir", attachments.dirOf(file.id)]));
    await expect(
      queue.create({ repo: repo.id, message: "x", attachmentIds: ["00000000-0000-4000-8000-000000000000"] }),
    ).rejects.toThrow("missing");
  });

  it("sends bound saved prompts between the repo base prompt and the message, in library order", async () => {
    const { queue, repo, prompts, received, stores } = await setup();
    const jira = await prompts.create("Analyze Jira ticket", "JIRA STEPS");
    const plan = await prompts.create("Plan first", "PLAN FIRST");
    // Picked in reverse order: still sent in library order.
    const created = await queue.create({ repo: repo.id, message: "FT-123", promptIds: [plan.id, jira.id] });
    expect(created.promptIds).toEqual([jira.id, plan.id]);
    await waitFor(taskWith(queue, created.id, "needs-review"));

    const [call] = await received();
    expect(call?.prompt).toBe("GLOBAL RULES\n\nREPO RULES\n\nJIRA STEPS\n\nPLAN FIRST\n\nFT-123");
    const started = (await stores.activity.forTask(created.id)).find((e) => e.event === "started");
    expect(started?.data?.boundPrompts).toEqual([
      { id: "analyze-jira-ticket", name: "Analyze Jira ticket" },
      { id: "plan-first", name: "Plan first" },
    ]);
    expect((started?.data?.layers as { name: string; included: boolean }[]).map((l) => l.name)).toEqual([
      "global",
      "repo",
      "prompts",
      "message",
      "attachments",
    ]);
  });

  it("uses a bound prompt's latest text at run time, and skips (with a warning) one deleted before it ran", async () => {
    const { queue, repo, prompts, received, stores } = await setup();
    const a = await prompts.create("Style", "OLD STYLE");
    const b = await prompts.create("Gone soon", "BYE");
    const blocker = await queue.create({ repo: repo.id, message: "SLOW first" });
    const task = await queue.create({ repo: repo.id, message: "go", promptIds: [a.id, b.id] });
    await prompts.update(a.id, { body: "NEW STYLE" });
    await prompts.remove(b.id);
    await waitFor(async () => queue.replay(blocker.id).events.length > 0);
    await queue.cancel(blocker.id);
    await waitFor(taskWith(queue, task.id, "needs-review"));

    const call = (await received()).find((c) => c.prompt.endsWith("go"));
    expect(call?.prompt).toBe("GLOBAL RULES\n\nREPO RULES\n\nNEW STYLE\n\ngo");
    const history = await stores.activity.forTask(task.id);
    expect(history.some((e) => e.event === "warning" && e.detail.includes("gone-soon"))).toBe(true);
    await expect(queue.create({ repo: repo.id, message: "x", promptIds: ["nope"] })).rejects.toThrow("Unknown saved prompt");
  });

  it("sends only the repo prompts ticked for the task, in the repo's order; omitted = the default ones", async () => {
    const { queue, repo, repos, received, stores } = await setup();
    const list = await repos.prompts(repo.id);
    const fe = await list.create("Frontend", "FRONTEND NOTES");
    const be = await list.create("Backend", "BACKEND NOTES");

    // Picked: Backend + the default "Repo rules", in reverse. Frontend not ticked, so not sent.
    const picked = await queue.create({ repo: repo.id, message: "api work", repoPromptIds: [be.id, "repo-rules"] });
    expect(picked.repoPromptIds).toEqual(["repo-rules", be.id]);
    await waitFor(taskWith(queue, picked.id, "needs-review"));
    // None ticked: no repo layer at all.
    const none = await queue.create({ repo: repo.id, message: "bare", repoPromptIds: [] });
    await waitFor(taskWith(queue, none.id, "needs-review"));
    // Not given (API / scripts): the default ones.
    const defaults = await queue.create({ repo: repo.id, message: "defaults" });
    expect(defaults.repoPromptIds).toEqual(["repo-rules"]);
    await waitFor(taskWith(queue, defaults.id, "needs-review"));

    const calls = await received();
    expect(calls.map((c) => c.prompt)).toEqual([
      "GLOBAL RULES\n\nREPO RULES\n\nBACKEND NOTES\n\napi work",
      "GLOBAL RULES\n\nbare",
      "GLOBAL RULES\n\nREPO RULES\n\ndefaults",
    ]);
    expect(calls.some((c) => c.prompt.includes("FRONTEND"))).toBe(false);
    const started = (await stores.activity.forTask(picked.id)).find((e) => e.event === "started");
    expect(started?.data?.repoPrompts).toEqual([
      { id: "repo-rules", name: "Repo rules" },
      { id: "backend", name: "Backend" },
    ]);
    await expect(queue.create({ repo: repo.id, message: "x", repoPromptIds: [fe.id, "nope"] })).rejects.toThrow("Unknown repo prompt");
  });

  it("a task queued before repos had several prompts sends the repo's default ones", async () => {
    const { queue, repo, received, stores } = await setup();
    await stores.queue.update((q) => {
      q.tasks.push({
        id: "task_0099_legacy",
        title: "legacy",
        repo: repo.id,
        status: "pending",
        message: "old task",
        attachments: [],
        promptIds: [],
        repoPromptIds: null,
        accountOverride: null,
        currentAccount: null,
        branch: null,
        session: null,
        replies: [],
        pendingReply: null,
        createdAt: "2026-11-18T10:00:00+08:00",
        updatedAt: "2026-11-18T10:00:00+08:00",
      });
    });
    await queue.init();
    await waitFor(taskWith(queue, "task_0099_legacy", "needs-review"));
    expect((await received())[0]?.prompt).toBe("GLOBAL RULES\n\nREPO RULES\n\nold task");
  });

  it("replies can bind saved prompts too", async () => {
    const { queue, repo, prompts, received } = await setup();
    const p = await prompts.create("Commit style", "CONVENTIONAL COMMITS");
    const created = await queue.create({ repo: repo.id, message: "first" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    await queue.reply(created.id, "and commit it", [], [p.id]);
    await waitFor(async () => {
      const t = (await queue.list()).find((x) => x.id === created.id);
      return t?.status === "needs-review" && t.pendingReply === null && t.replies.length === 1;
    });
    expect((await received()).at(-1)?.prompt).toBe("CONVENTIONAL COMMITS\n\nand commit it");
  });

  it("Claude never gets its worktree tools", async () => {
    const { queue, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "anything" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    const [call] = await received();
    const i = call!.args.indexOf("--disallowedTools");
    expect(call!.args.slice(i + 1, i + 4)).toEqual(["EnterWorktree", "ExitWorktree", "Bash(git worktree *)"]);
  });

  it("falls back to the next account on a usage limit; Cursor gets the same full prompt", async () => {
    const { queue, stores, accounts, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "LIMIT:work_1-claude please" });

    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(done.currentAccount).toBe("work_2-cursor");
    const calls = await received();
    expect(calls.map((c) => `${c.cli}:${c.label}`)).toEqual(["claude:work_1-claude", "cursor:work_2-cursor"]);
    expect(calls.every((c) => c.prompt === FULL("LIMIT:work_1-claude please"))).toBe(true);

    // Started over: only the second account's work is on the branch.
    const files = sh(repo.path, "ls-tree", "--name-only", done.branch!.name);
    expect(files).toContain("out-work_2-cursor.txt");
    expect(files).not.toContain("out-work_1-claude.txt");
    expect(head(repo.path)).toBe("main");

    expect((await accounts.list()).find((a) => a.id === "work_1-claude")?.status).toBe("limited");
    const history = await stores.activity.forTask(created.id);
    expect(history.find((e) => e.event === "fallback")?.detail).toBe("work_1-claude hit usage limit, retrying on work_2-cursor");
  });

  it("removes a failed task and its branch, keeps it in history", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "FAIL now" });
    await waitFor(async () => (await queue.list()).length === 0);
    expect((await queue.history())[0]).toMatchObject({ taskId: created.id, outcome: "failed" });
    expect(sh(repo.path, "branch", "--list", "ai/*")).toBe("");
    expect(head(repo.path)).toBe("main");
  });

  it("cancelling a running task leaves it interrupted and your checkout on main", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW job" });
    await waitFor(async () => queue.replay(created.id).events.length > 0);
    expect(head(repo.path)).toBe("ai/task_0001_slow-job");
    await queue.cancel(created.id);
    await waitFor(taskWith(queue, created.id, "interrupted"));
    expect(head(repo.path)).toBe("main");
  });

  it("replies continue the same session on the same branch, without re-sending base prompts", async () => {
    const { queue, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "first" });
    const first = await waitFor(taskWith(queue, created.id, "needs-review"));
    await queue.reply(created.id, "now the follow-up");
    const second = await waitFor(async () => {
      const t = (await queue.list()).find((x) => x.id === created.id);
      return t?.status === "needs-review" && t.replies.length === 1 && t.pendingReply === null ? t : null;
    });
    expect(second.session?.sessionId).toBe(first.session?.sessionId);
    expect((await received()).map((c) => c.prompt)).toEqual([FULL("first"), "now the follow-up"]);
    expect(sh(repo.path, "log", "--format=%s", `main..${second.branch!.name}`).trim().split("\n")).toEqual([
      "first: now the follow-up",
      "first",
    ]);
    expect(head(repo.path)).toBe("main");
  });

  it("commits as the repo's committer and strips AI co-author lines on Keep, even with your own edits pending", async () => {
    const { queue, repos, repo } = await setup();
    await repos.update(repo.id, { committerName: "Ralph Example", committerEmail: "ralph@example.com" });
    const created = await queue.create({ repo: repo.id, message: "COMMIT please" });
    await waitFor(taskWith(queue, created.id, "needs-review"));

    await writeFile(join(repo.path, "README.md"), "you are editing\n"); // must not block or be touched
    await queue.keep(created.id);
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toBe("you are editing\n");

    const log = sh(repo.path, "log", "--format=%an <%ae>|%cn <%ce>|%B%x00", `main..ai/${created.id}`);
    const commits = log.split("\0").map((c) => c.trim()).filter(Boolean);
    expect(commits).toHaveLength(2); // the agent's commit + what it left uncommitted
    for (const c of commits) {
      expect(c.startsWith("Ralph Example <ralph@example.com>|Ralph Example <ralph@example.com>|")).toBe(true);
      expect(c).not.toMatch(/co-authored-by/i);
    }
  });

  it("runs only one task per repo at a time", async () => {
    const { queue, repo } = await setup();
    const a = await queue.create({ repo: repo.id, message: "SLOW one" });
    const b = await queue.create({ repo: repo.id, message: "two" });
    await waitFor(taskWith(queue, a.id, "running"));
    const waiting = await waitFor(async () => (await queue.list()).find((t) => t.id === b.id && t.waitingNote));
    expect(waiting.waitingNote).toContain("other task on this repo");
    await waitFor(async () => queue.replay(a.id).events.length > 0);
    await queue.cancel(a.id);
    await waitFor(taskWith(queue, a.id, "interrupted"));
    await waitFor(taskWith(queue, b.id, "needs-review"));
    expect(head(repo.path)).toBe("main");
  });

  it("tasks running when the server stopped come back interrupted, and the repo goes back to your branch", async () => {
    const { stores, queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW crash" });
    await waitFor(async () => queue.replay(created.id).events.length > 0);
    await queue.shutdown();
    await waitFor(taskWith(queue, created.id, "interrupted"));
    // Simulate a hard crash mid-run: still marked running, still on the task branch with edits.
    sh(repo.path, "checkout", "-q", "ai/task_0001_slow-crash");
    await writeFile(join(repo.path, "half-done.txt"), "partial\n");
    await stores.queue.update((q) => {
      q.tasks[0]!.status = "running";
    });
    const fresh = new QueueService({ ...(queue as any).deps });
    await fresh.init();
    expect((await fresh.list())[0]?.status).toBe("interrupted");
    expect(head(repo.path)).toBe("main");
    expect(sh(repo.path, "show", "ai/task_0001_slow-crash:half-done.txt")).toBe("partial\n");
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
    expect(head(repo.path)).toBe("main");
    const outcomes = Object.fromEntries((await queue.history()).map((h) => [h.taskId, h.outcome]));
    expect(outcomes).toEqual({ [running.id]: "discarded", [pending.id]: "discarded" });
    expect((await stores.activity.forTask(running.id)).at(-1)?.detail).toContain("Stopped and discarded");
  });

  it("moves an old worktree task onto its branch in the repo", async () => {
    const { dir, stores, queue, repo } = await setup();
    const wtPath = join(dir, "old-worktree");
    sh(repo.path, "worktree", "add", "-q", "-b", "ai/task_0042_old", wtPath, "main");
    await writeFile(join(wtPath, "unsaved.txt"), "work in the old worktree\n");
    const base = sh(repo.path, "rev-parse", "main").trim();
    await stores.queue.update((q) => {
      q.tasks.push({
        id: "task_0042_old",
        title: "old task",
        repo: repo.id,
        status: "needs-review",
        message: "old",
        attachments: [],
        promptIds: [],
        repoPromptIds: null,
        accountOverride: null,
        currentAccount: "work_1-claude",
        branch: null,
        worktree: { path: wtPath, branch: "ai/task_0042_old", baseBranch: "main", baseCommit: base },
        session: null,
        replies: [],
        pendingReply: null,
        createdAt: "2026-11-18T10:00:00+08:00",
        updatedAt: "2026-11-18T10:00:00+08:00",
      });
    });
    const fresh = new QueueService({ ...(queue as any).deps });
    await fresh.init();

    const task = (await fresh.list()).find((t) => t.id === "task_0042_old");
    expect(task?.branch).toMatchObject({ name: "ai/task_0042_old", base: "main", baseCommit: base });
    expect(task?.worktree).toBeUndefined();
    expect(sh(repo.path, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(sh(repo.path, "show", "ai/task_0042_old:unsaved.txt")).toBe("work in the old worktree\n");
    expect((await fresh.diff("task_0042_old")).patch).toContain("unsaved.txt");
  });
});
