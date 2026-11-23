import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Attachment } from "@my-ai-slaves/shared";
import { createAdapters } from "../src/providers";
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
const FAKE_CLAUDE = join(fixtures, "fake-claude.mjs");
const FAKE_CURSOR = join(fixtures, "fake-cursor.mjs");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const head = (cwd: string) => sh(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();
/** The app must never create ai/ (or any) branches. */
const aiBranches = (cwd: string) => sh(cwd, "branch", "--list", "ai/*").trim();

async function makeRepo(dir: string, name = "my-repo"): Promise<string> {
  const repo = join(dir, name);
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
    git: new RepoGit(),
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

describe("QueueService: runs in the repo as it is (no branches, no worktrees)", () => {
  it("runs in the repo as it's checked out: no branch created, switched or committed", async () => {
    const { queue, stores, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "add a greeting" });
    expect(created.id).toBe("task_0001_add-a-greeting");

    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(done.branch).toBeNull();
    expect(done.checkout).toEqual({ ref: "main", commit: sh(repo.path, "rev-parse", "HEAD").trim() });

    // The CLI ran in the repo folder itself and received global + repo base prompts + the message.
    const [call] = await received();
    expect(call?.cwd).toBe(repo.path);
    expect(call?.prompt).toBe(FULL("add a greeting"));

    // What the agent left is just there, uncommitted; no branch, no commit, no worktree.
    expect(head(repo.path)).toBe("main");
    expect(aiBranches(repo.path)).toBe("");
    expect(sh(repo.path, "log", "--format=%s").trim()).toBe("init");
    expect(sh(repo.path, "status", "--porcelain").trim()).toBe("?? out-work_1-claude.txt");
    expect(sh(repo.path, "worktree", "list").trim().split("\n")).toHaveLength(1);

    const started = (await stores.activity.forTask(created.id)).find((e) => e.event === "started");
    expect(started?.data?.prompt).toBe(FULL("add a greeting"));
    expect(started?.data?.cwd).toBe(repo.path);
    expect(started?.data?.ref).toBe("main");
    expect(started?.data?.layers).toEqual([
      { name: "global", included: true },
      { name: "repo", included: true },
      { name: "prompts", included: false },
      { name: "message", included: true },
      { name: "repos", included: false },
      { name: "attachments", included: false },
    ]);

    // The diff shows what changed in the checkout since the task started, new files included.
    const diff = await queue.diff(created.id);
    expect(diff).toMatchObject({ ref: "main", startedOn: done.checkout, repoPath: repo.path });
    expect(diff.patch).toContain("out-work_1-claude.txt");
  });

  it("stays on whatever branch you're on, and the diff follows commits the agent makes", async () => {
    const { queue, repo } = await setup();
    sh(repo.path, "checkout", "-q", "-b", "feature/mine");
    const created = await queue.create({ repo: repo.id, message: "COMMIT small fix" });
    const done = await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(head(repo.path)).toBe("feature/mine");
    expect(done.checkout?.ref).toBe("feature/mine");
    expect(aiBranches(repo.path)).toBe("");
    // The agent committed by itself (its prompts said so); the app made no commit of its own.
    expect(sh(repo.path, "log", "--format=%s", "main..feature/mine").trim()).toBe("feat: agent work");
    const { patch } = await queue.diff(created.id);
    expect(patch).toContain("out-work_1-claude.txt");
    expect(patch).toContain("leftover.txt");
  });

  it("doesn't wait for or touch your uncommitted changes", async () => {
    const { queue, repo } = await setup();
    await writeFile(join(repo.path, "README.md"), "my unsaved work\n");
    const created = await queue.create({ repo: repo.id, message: "do something" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toBe("my unsaved work\n");
    expect(head(repo.path)).toBe("main");
    expect(aiBranches(repo.path)).toBe("");
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
      "repos",
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
    // The run's token usage is on its finished entry and in the Statistics records.
    expect(history.find((e) => e.event === "finished")?.data?.usage).toEqual({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.01,
    });
    expect(stores.activity.usageRecords().filter((r) => r.taskId === task.id)).toHaveLength(1);
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
      { repo: repo.id, id: "repo-rules", name: "Repo rules" },
      { repo: repo.id, id: "backend", name: "Backend" },
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
        extraRepos: [],
        checkout: null,
        accountOverride: null,
        currentAccount: null,
        branch: null,
        session: null,
        replies: [],
        pendingReply: null,
        resumeOnStart: false,
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

  it("sends a prompt's screenshots with it: repo prompts' and saved prompts' files before the message's", async () => {
    const { queue, repo, repos, prompts, attachments, received } = await setup();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const [r1, s1, s2, m1] = await Promise.all(
      ["repo.png", "saved-1.png", "saved-2.png", "message.png"].map((n) => attachments.save(png, n, "image/png")),
    );
    const list = await repos.prompts(repo.id);
    await list.update("repo-rules", { attachments: [r1 as Attachment] });
    const saved = await prompts.create("Design", "MATCH THE DESIGN", { attachments: [s1 as Attachment, s2 as Attachment] });
    expect(saved.attachments.map((a) => a.name)).toEqual(["saved-1.png", "saved-2.png"]);

    const created = await queue.create({ repo: repo.id, message: "build it", promptIds: [saved.id], attachmentIds: [m1?.id as string] });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    const [call] = await received();
    const paths = [r1, s1, s2, m1].map((a) => `- ${attachments.pathOf(a as Attachment)}`).join("\n");
    expect(call?.prompt).toBe(`GLOBAL RULES\n\nREPO RULES\n\nMATCH THE DESIGN\n\nbuild it\n\nAttached files:\n${paths}`);
    for (const a of [r1, s1, s2, m1]) {
      expect(call?.args).toEqual(expect.arrayContaining(["--add-dir", attachments.dirOf((a as Attachment).id)]));
    }

    // A reply that binds the prompt again sends its files again, but not the repo prompt's.
    await queue.reply(created.id, "again", [], [saved.id]);
    await waitFor(async () => {
      const t = (await queue.list()).find((x) => x.id === created.id);
      return t?.status === "needs-review" && t.pendingReply === null && t.replies.length === 1;
    });
    const replyPaths = [s1, s2].map((a) => `- ${attachments.pathOf(a as Attachment)}`).join("\n");
    expect((await received()).at(-1)?.prompt).toBe(`MATCH THE DESIGN\n\nagain\n\nAttached files:\n${replyPaths}`);
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

    // Nothing was reset between accounts; no branch was made.
    expect(sh(repo.path, "status", "--porcelain")).toContain("out-work_2-cursor.txt");
    expect(head(repo.path)).toBe("main");
    expect(aiBranches(repo.path)).toBe("");

    expect((await accounts.list()).find((a) => a.id === "work_1-claude")?.status).toBe("limited");
    const history = await stores.activity.forTask(created.id);
    expect(history.find((e) => e.event === "fallback")?.detail).toBe("work_1-claude hit usage limit, retrying on work_2-cursor");
  });

  it("a draft sits in the queue and never runs; queueing it replaces it with a real task", async () => {
    const { queue, repo, received } = await setup();
    const draft = await queue.create({ repo: repo.id, message: "draft me", repoPromptIds: [], draft: true });
    expect(draft.status).toBe("draft");
    await new Promise((r) => setTimeout(r, 300));
    expect((await queue.list()).map((t) => [t.id, t.status])).toEqual([[draft.id, "draft"]]);
    expect(await received()).toEqual([]);

    // Saving it again keeps its place and stays a draft.
    const again = await queue.create({ repo: repo.id, message: "draft me v2", draft: true, replacesDraft: draft.id });
    expect((await queue.list()).map((t) => [t.id, t.status])).toEqual([[again.id, "draft"]]);

    const task = await queue.create({ repo: repo.id, message: "run me", replacesDraft: again.id });
    await waitFor(taskWith(queue, task.id, "needs-review"));
    expect((await queue.list()).map((t) => t.id)).toEqual([task.id]);
    expect((await received()).map((r) => r.prompt)).toEqual([FULL("run me")]);
    await expect(queue.create({ repo: repo.id, message: "x", replacesDraft: task.id })).rejects.toThrow(/not a draft/);
  });

  it("discarding a draft leaves nothing in history", async () => {
    const { queue, repo } = await setup();
    const draft = await queue.create({ repo: repo.id, message: "never mind", draft: true });
    await queue.discard(draft.id);
    expect(await queue.list()).toEqual([]);
    expect((await queue.history()).some((h) => h.taskId === draft.id)).toBe(false);
  });

  it("removes a failed task, keeps it in history", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "FAIL now" });
    await waitFor(async () => (await queue.list()).length === 0);
    expect((await queue.history())[0]).toMatchObject({ taskId: created.id, outcome: "failed" });
    expect(aiBranches(repo.path)).toBe("");
    expect(head(repo.path)).toBe("main");
  });

  it("cancelling a running task leaves it interrupted, on your branch", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW job" });
    await waitFor(async () => queue.replay(created.id).events.length > 0);
    expect(head(repo.path)).toBe("main");
    await queue.cancel(created.id);
    await waitFor(taskWith(queue, created.id, "interrupted"));
    expect(head(repo.path)).toBe("main");
    expect(aiBranches(repo.path)).toBe("");
  });

  it("an interrupted task (first run or reply) can still get a follow-up in the same session", async () => {
    const { queue, repo, received } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW first" });
    const inits = () => queue.replay(created.id).events.filter((e) => e.kind === "init").length;
    await waitFor(async () => inits() === 1);
    await queue.cancel(created.id);
    const stopped = await waitFor(taskWith(queue, created.id, "interrupted"));
    expect(stopped.session?.sessionId).toBeTruthy();

    await queue.reply(created.id, "SLOW keep going");
    await waitFor(async () => inits() === 2);
    await queue.cancel(created.id);
    await waitFor(taskWith(queue, created.id, "interrupted"));

    await queue.reply(created.id, "follow-up");
    const done = await waitFor(async () => {
      const t = (await queue.list()).find((x) => x.id === created.id);
      return t?.status === "needs-review" && t.pendingReply === null ? t : null;
    });
    expect(done.session?.sessionId).toBe(stopped.session?.sessionId);
    expect(done.replies.map((r) => r.message)).toEqual(["SLOW keep going", "follow-up"]);
    expect((await received()).map((c) => c.prompt)).toEqual([FULL("SLOW first"), "SLOW keep going", "follow-up"]);
  });

  it("replies continue the same session, without re-sending base prompts", async () => {
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
    // Your side shows in the live output, in order, right where each run started (never sent to the CLI).
    const events = queue.replay(created.id).events;
    expect(events.filter((e) => e.kind === "user")).toEqual([
      { kind: "user", text: "first", reply: false, attachments: [], prompts: ["Repo rules"] },
      { kind: "user", text: "now the follow-up", reply: true, attachments: [], prompts: [] },
    ]);
    const replyAt = events.findIndex((e) => e.kind === "user" && e.reply);
    expect(events.slice(0, replyAt).some((e) => e.kind === "message")).toBe(true);
    expect(events.slice(replyAt).some((e) => e.kind === "message")).toBe(true);
    expect(head(repo.path)).toBe("main");
    expect(sh(repo.path, "log", "--format=%s").trim()).toBe("init");
  });

  it("the agent's own commits use the committer the repo picked", async () => {
    const { queue, repos, repo, stores } = await setup();
    await stores.settings.update((s) => {
      s.committers = [
        { id: "work", name: "Work Person", email: "work@example.com", label: "Work" },
        // The label is app-only: git gets just the name and email.
        { id: "ralph", name: "Ralph Example", email: "ralph@example.com", label: "Personal" },
      ];
      s.defaultCommitterId = "work";
    });
    await repos.update(repo.id, { committerId: "ralph" });
    const created = await queue.create({ repo: repo.id, message: "COMMIT please" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(sh(repo.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>").trim()).toBe(
      "Ralph Example <ralph@example.com>|Ralph Example <ralph@example.com>",
    );
    // The app commits nothing itself: what the agent didn't commit stays uncommitted.
    expect(sh(repo.path, "status", "--porcelain").trim()).toBe("?? leftover.txt");
  });

  it("a repo that picks no committer uses the default one", async () => {
    const { queue, repo, stores } = await setup();
    await stores.settings.update((s) => {
      s.committers = [{ id: "work", name: "Work Person", email: "work@example.com", label: null }];
      s.defaultCommitterId = "work";
    });
    const created = await queue.create({ repo: repo.id, message: "COMMIT please" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    expect(sh(repo.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>").trim()).toBe(
      "Work Person <work@example.com>|Work Person <work@example.com>",
    );
  });

  it("refuses a committer that isn't saved in settings", async () => {
    const { repos, repo } = await setup();
    await expect(repos.update(repo.id, { committerId: "nope" })).rejects.toThrow(/no longer exists/);
  });

  it("moves old per-repo committer fields into settings' committers", async () => {
    const { repos, repo, stores } = await setup();
    await stores.repos.update((f) => {
      const r = f.repos.find((x) => x.id === repo.id)!;
      r.committerName = "Old Name";
      r.committerEmail = "old@example.com";
    });
    await repos.migrateCommitters();
    const { committers } = await stores.settings.read();
    expect(committers).toEqual([{ id: expect.any(String), name: "Old Name", email: "old@example.com", label: null }]);
    const migrated = await repos.get(repo.id);
    expect(migrated.committerId).toBe(committers[0]!.id);
    expect(migrated.committerName).toBeNull();
    expect(migrated.committerEmail).toBeNull();
  });

  it("renames a repo in the app only; blank goes back to the folder name", async () => {
    const { repos, repo } = await setup();
    const renamed = await repos.update(repo.id, { name: "  Client A mobile " });
    expect(renamed.name).toBe("Client A mobile");
    expect(renamed.id).toBe(repo.id);
    expect(renamed.path).toBe(repo.path);
    const reset = await repos.update(repo.id, { name: "" });
    expect(reset.name).toBe(basename(repo.path));
  });

  it("labels a repo: trimmed, deduped ignoring case, blanks dropped; new repos have none", async () => {
    const { repos, repo } = await setup();
    expect(repo.labels).toEqual([]);
    const labelled = await repos.update(repo.id, { labels: [" Company ", "company", "", "client  A"] });
    expect(labelled.labels).toEqual(["Company", "client A"]);
    expect((await repos.get(repo.id)).labels).toEqual(["Company", "client A"]);
    expect((await repos.update(repo.id, { labels: [] })).labels).toEqual([]);
  });

  it("colours a label for every repo, matched ignoring case; gray clears it", async () => {
    const { repos } = await setup();
    expect(await repos.labelColors()).toEqual({});
    expect(await repos.setLabelColor(" Company ", "blue")).toEqual({ company: "blue" });
    expect(await repos.setLabelColor("client  A", "green")).toEqual({ company: "blue", "client a": "green" });
    expect(await repos.setLabelColor("COMPANY", "gray")).toEqual({ "client a": "green" });
    expect(await repos.setLabelColor("client a", null)).toEqual({});
    await expect(repos.setLabelColor("  ", "blue")).rejects.toThrow("Label is empty.");
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

  it("a task going to review frees its repo: the next queued task starts right away", async () => {
    const { queue, repo } = await setup();
    const a = await queue.create({ repo: repo.id, message: "one" });
    const b = await queue.create({ repo: repo.id, message: "two" });
    const c = await queue.create({ repo: repo.id, message: "three" });
    await waitFor(taskWith(queue, a.id, "needs-review"));
    await waitFor(taskWith(queue, b.id, "needs-review"));
    await waitFor(taskWith(queue, c.id, "needs-review"));
    // A reply on a task in review queues behind nothing: it runs too.
    await queue.reply(a.id, "more");
    await waitFor(async () => (await queue.list()).find((t) => t.id === a.id && t.status === "needs-review" && !t.pendingReply));
  });

  it("tasks running when the server stopped come back interrupted; the repo is left as it is", async () => {
    const { stores, queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW crash" });
    await waitFor(async () => queue.replay(created.id).events.length > 0);
    await queue.shutdown();
    await waitFor(taskWith(queue, created.id, "interrupted"));
    await writeFile(join(repo.path, "half-done.txt"), "partial\n");
    await stores.queue.update((q) => {
      q.tasks[0]!.status = "running";
    });
    const fresh = new QueueService({ ...(queue as any).deps });
    await fresh.init();
    expect((await fresh.list())[0]?.status).toBe("interrupted");
    expect(head(repo.path)).toBe("main");
    expect(sh(repo.path, "status", "--porcelain").trim()).toBe("?? half-done.txt");
  });

  it("tasks stopped by Update and restart run again on the next start", async () => {
    const { queue, repo } = await setup();
    const created = await queue.create({ repo: repo.id, message: "SLOW resume me" });
    await waitFor(async () => queue.replay(created.id).events.length > 0);
    await queue.shutdown({ resume: true });
    await waitFor(taskWith(queue, created.id, "interrupted"));
    expect((await queue.list())[0]?.resumeOnStart).toBe(true);
    const fresh = new QueueService({ ...(queue as any).deps });
    await fresh.init();
    await waitFor(async () => (await fresh.list()).find((t) => t.id === created.id && t.status !== "pending" && t.status !== "interrupted"));
    const task = (await fresh.list()).find((t) => t.id === created.id);
    expect(["running", "needs-review"]).toContain(task?.status);
    expect(task?.resumeOnStart).toBe(false);
    await fresh.shutdown();
  });

  it("discards tasks in any state, stopping a running one first", async () => {
    const { queue, repo, stores } = await setup();
    const running = await queue.create({ repo: repo.id, message: "SLOW long job" });
    const pending = await queue.create({ repo: repo.id, message: "never started" });
    await waitFor(async () => queue.replay(running.id).events.length > 0);

    await queue.discard(pending.id);
    await queue.discard(running.id);

    expect(await queue.list()).toEqual([]);
    expect(aiBranches(repo.path)).toBe("");
    expect(head(repo.path)).toBe("main");
    const outcomes = Object.fromEntries((await queue.history()).map((h) => [h.taskId, h.outcome]));
    expect(outcomes).toEqual({ [running.id]: "discarded", [pending.id]: "discarded" });
    const all = await queue.history();
    const first = await queue.historyPage(0, 1);
    expect(first).toEqual({ items: [all[0]], total: 2, nextOffset: 1 });
    expect(await queue.historyPage(1, 1)).toEqual({ items: [all[1]], total: 2, nextOffset: null });
    expect(await queue.historyPage(5, 10)).toEqual({ items: [], total: 2, nextOffset: null });
    expect((await stores.activity.forTask(running.id)).at(-1)?.detail).toContain("Stopped and discarded");
  });

  it("marks a reviewed task finished without touching the repo", async () => {
    const { queue, repo, stores } = await setup();
    const created = await queue.create({ repo: repo.id, message: "COMMIT real work" });
    await waitFor(taskWith(queue, created.id, "needs-review"));
    const before = sh(repo.path, "log", "--all", "--format=%H %D");
    await queue.markFinished(created.id);
    expect(await queue.list()).toEqual([]);
    expect(sh(repo.path, "log", "--all", "--format=%H %D")).toBe(before);
    expect(sh(repo.path, "status", "--porcelain").trim()).toBe("?? leftover.txt");
    expect((await queue.history())[0]).toMatchObject({ taskId: created.id, outcome: "done" });
    expect((await stores.activity.forTask(created.id)).at(-1)?.detail).toBe("Marked finished.");

    const pending = await queue.create({ repo: repo.id, message: "SLOW still going" });
    await expect(queue.markFinished(pending.id)).rejects.toThrow("only a task waiting for review");
    await queue.discard(pending.id);
  });

  it("cross-repo tasks open the other repos as they are and send their ticked prompts", async () => {
    const { dir, queue, repos, repo, received, stores } = await setup();
    const other = await repos.register(await makeRepo(dir, "other-repo"));
    const otherPrompts = await repos.prompts(other.id);
    await otherPrompts.create("Other rules", "OTHER RULES: branch off develop yourself", { default: true });
    await otherPrompts.create("Unused", "NOT SENT");
    // Your checkout there: on your own branch, with uncommitted edits. The app must not touch any of it.
    sh(other.path, "checkout", "-q", "-b", "feature/mine");
    await writeFile(join(other.path, "README.md"), "my edits\n");
    await expect(queue.create({ repo: repo.id, message: "x", extraRepos: ["nope"] })).rejects.toThrow('No repo "nope"');

    const task = await queue.create({ repo: repo.id, message: "TOUCH-OTHERS check both", extraRepos: [other.id, repo.id] });
    expect(task.extraRepos).toEqual([{ repo: other.id, promptIds: ["other-rules"] }]);
    await waitFor(taskWith(queue, task.id, "needs-review"));

    // The CLI runs in the main repo, gets the other one as an extra directory, its prompts, and where it is.
    const [call] = await received();
    expect(call?.cwd).toBe(repo.path);
    expect(call?.args.join(" ")).toContain(`--add-dir ${other.path}`);
    expect(call?.prompt).toBe(
      `GLOBAL RULES\n\nREPO RULES\n\nOTHER RULES: branch off develop yourself\n\nTOUCH-OTHERS check both\n\nOther repositories:\n- other-repo: ${other.path}`,
    );

    // Nothing was created, switched or committed there: what the agent left is just there, uncommitted.
    expect(head(other.path)).toBe("feature/mine");
    expect(sh(other.path, "branch", "--list", "ai/*").trim()).toBe("");
    expect(sh(other.path, "log", "--format=%s").trim()).toBe("init");
    expect(sh(other.path, "status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M README.md", "?? other-work_1-claude.txt"]);
    // The main repo works as always.
    expect(head(repo.path)).toBe("main");
    const started = (await stores.activity.forTask(task.id)).find((e) => e.event === "started");
    expect(started?.data?.repoPrompts).toEqual([
      { repo: repo.id, id: "repo-rules", name: "Repo rules" },
      { repo: other.id, id: "other-rules", name: "Other rules" },
    ]);

    await queue.markFinished(task.id);
    expect(head(other.path)).toBe("feature/mine");
  });

  it("ticks other repos' prompts per repo, and keeps a repo in one running task at a time", async () => {
    const { dir, queue, repos, repo, received } = await setup();
    const other = await repos.register(await makeRepo(dir, "other-repo"));
    const otherPrompts = await repos.prompts(other.id);
    await otherPrompts.create("Other rules", "OTHER RULES", { default: true });
    await otherPrompts.create("Deploy notes", "DEPLOY NOTES");
    await expect(
      queue.create({ repo: repo.id, message: "x", extraRepos: [other.id], extraRepoPromptIds: { [other.id]: ["nope"] } }),
    ).rejects.toThrow("Unknown repo prompt(s): nope");

    const slow = await queue.create({
      repo: repo.id,
      message: "SLOW look around",
      extraRepos: [other.id],
      extraRepoPromptIds: { [other.id]: ["deploy-notes"] },
    });
    await waitFor(taskWith(queue, slow.id, "running"));
    const [call] = await waitFor(async () => ((await received()).length ? received() : null));
    expect(call?.prompt).toContain("REPO RULES\n\nDEPLOY NOTES\n\nSLOW look around");
    const waiting = await queue.create({ repo: other.id, message: "other only" });
    await waitFor(() => queue.list().then((ts) => ts.find((t) => t.id === waiting.id && t.waitingNote?.includes("other task on this repo"))));
    // A repo in a task's list can't be removed while the task is queued.
    await expect(repos.remove(other.id)).rejects.toThrow("still has 2 task");
    await queue.discard(slow.id);
    await waitFor(taskWith(queue, waiting.id, "needs-review"));
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
        extraRepos: [],
        checkout: null,
        accountOverride: null,
        currentAccount: "work_1-claude",
        branch: null,
        worktree: { path: wtPath, branch: "ai/task_0042_old", baseBranch: "main", baseCommit: base },
        session: null,
        replies: [],
        pendingReply: null,
        resumeOnStart: false,
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
