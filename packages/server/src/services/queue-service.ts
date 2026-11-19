import {
  type Account,
  type ActivityEntry,
  type CreateTaskRequest,
  type DiffResponse,
  formatLocalIso,
  type HistoryItem,
  type PushResponse,
  type RawLine,
  type Repo,
  type StreamEvent,
  type Task,
  type TaskView,
} from "@my-ai-slaves/shared";
import type { AdapterRegistry } from "../providers";
import { preview } from "../providers/spawn";
import type { RunHandle, RunResult } from "../providers/types";
import type { NewActivityEntry } from "../storage/activity-log";
import type { AttachmentStore } from "../storage/attachment-store";
import type { DataStores } from "../storage/data-stores";
import type { AccountService } from "./account-service";
import { pickAccount } from "./account-router";
import { badRequest, type Broadcaster, conflict, notFound, shortTime, slugify } from "./common";
import type { PromptAssembler } from "./prompt-assembler";
import type { PromptLibrary } from "./prompt-library";
import type { RepoService } from "./repo-service";
import { type BranchService, DirtyRepoError, type TaskBranch } from "./branch-service";

const LIVE_BUFFER_LIMIT = 5000;
const MAX_TIMER_MS = 60 * 60 * 1000;

interface LiveRun {
  /** The task branch is checked out in the repo (so the run must be settled afterwards). */
  checkedOut: boolean;
  taskId: string;
  repo: string;
  /** Every repo the run holds (the main one + the task's other repos): busy until it ends. */
  repos: string[];
  account: Account;
  handle: RunHandle;
  isReply: boolean;
  cancelRequested: boolean;
}

interface OutputBuffer {
  events: StreamEvent[];
  raw: RawLine[];
}

export interface QueueDeps {
  stores: DataStores;
  accounts: AccountService;
  repos: RepoService;
  branches: BranchService;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  broadcaster: Broadcaster;
  attachments: AttachmentStore;
  prompts: PromptLibrary;
  now?: () => Date;
}

/** The repo's committer setting; null fields fall back to your git config. */
const identityOf = (repo: Repo) => ({ name: repo.committerName, email: repo.committerEmail });

/** A cross-repo task's other repo, resolved, with its branch (null before its first run). */
interface ExtraRepo {
  repo: Repo;
  br: TaskBranch | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const pushCapped = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > LIVE_BUFFER_LIMIT) list.splice(0, list.length - LIVE_BUFFER_LIMIT);
};

/**
 * Owns queue.json and every task run.
 * - 1 running task per repo, `maxParallelTasks` overall, pending tasks start in queue order.
 * - Each run checks out `ai/<task-id>` (from the repo's base branch) in the repo itself; afterwards the
 *   work is committed on that branch and the previous branch is checked out again.
 * - Usage limit / logged out mid-run → mark the account, reset the task branch, re-run the same prompt on
 *   the next account in the chain (or wait until one frees up).
 */
export class QueueService {
  private readonly live = new Map<string, LiveRun>();
  private readonly buffers = new Map<string, OutputBuffer>();
  private waitingNotes = new Map<string, string>();
  private ticking = false;
  private tickAgain = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get stores() {
    return this.deps.stores;
  }

  private stamp(): string {
    return formatLocalIso(this.now());
  }

  private log(entry: NewActivityEntry): void {
    this.stores.activity.append(entry).catch((error) => console.error(`[activity] ${(error as Error).message}`));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Tasks that were running when the server stopped come back as interrupted. */
  async init(): Promise<void> {
    // A repo that becomes reachable (or unreachable) again changes what can run.
    this.deps.repos.onChange(() => void this.tick());
    await this.migrateLegacyWorktrees();
    const interrupted: Task[] = [];
    await this.stores.queue.update((q) => {
      for (const task of q.tasks) {
        if (task.status === "running") {
          task.status = "interrupted";
          task.updatedAt = this.stamp();
          interrupted.push(task);
        }
      }
    });
    for (const task of interrupted) {
      // Commit what it left on its branch and give the repo back to you.
      const repo = (await this.deps.repos.list()).find((r) => r.id === task.repo);
      if (repo && task.branch) {
        const settled = await this.deps.branches
          .settle(repo, task.branch, `${task.title} (interrupted)`, identityOf(repo))
          .catch((e: Error) => ({ committed: false, warning: e.message }));
        if (settled.warning) this.log({ taskId: task.id, repo: task.repo, account: null, event: "warning", detail: settled.warning });
      }
      await this.settleExtras(task, `${task.title} (interrupted)`);
      this.log({
        taskId: task.id,
        repo: task.repo,
        account: task.currentAccount,
        event: "interrupted",
        detail: "The server stopped while this task was running. Retry it or discard it.",
      });
    }
    await this.tick();
  }

  /**
   * One-time move off worktrees: commit what an old worktree held onto its branch, remove the
   * worktree (the branch stays in the repo), and record the branch on the task.
   */
  private async migrateLegacyWorktrees(): Promise<void> {
    const { tasks } = await this.stores.queue.read();
    const legacy = tasks.filter((t) => t.worktree);
    if (legacy.length === 0) return;
    const repos = await this.deps.repos.list();
    for (const task of legacy) {
      const wt = task.worktree as NonNullable<Task["worktree"]>;
      const repo = repos.find((r) => r.id === task.repo);
      if (repo) {
        try {
          await this.deps.branches.removeLegacyWorktree(repo, wt.path, `${task.title} (moved off worktree)`, identityOf(repo));
        } catch (e) {
          console.error(`[queue] couldn't move ${task.id} off its worktree (left as is): ${(e as Error).message}`);
          continue;
        }
      }
      await this.updateTask(task.id, (t) => {
        t.branch = { name: wt.branch, base: wt.baseBranch, baseCommit: wt.baseCommit, returnTo: null };
        delete t.worktree;
      });
      this.log({
        taskId: task.id,
        repo: task.repo,
        account: null,
        event: "warning",
        detail: `Moved off its worktree: the work is on branch ${wt.branch} in the repo.`,
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([...this.live.values()].map((run) => run.handle.cancel().catch(() => {})));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async list(): Promise<TaskView[]> {
    const { tasks } = await this.stores.queue.read();
    return tasks.map((t) => ({ ...t, waitingNote: t.status === "pending" ? (this.waitingNotes.get(t.id) ?? null) : null }));
  }

  private async getTask(id: string): Promise<Task> {
    const task = (await this.stores.queue.read()).tasks.find((t) => t.id === id);
    if (!task) throw notFound(`Task "${id}" is not in the queue.`);
    return task;
  }

  replay(taskId: string): OutputBuffer {
    return this.buffers.get(taskId) ?? { events: [], raw: [] };
  }

  async publish(): Promise<void> {
    this.deps.broadcaster.queueUpdated(await this.list());
  }

  private async updateTask(id: string, change: (t: Task) => void): Promise<Task> {
    let updated: Task | undefined;
    await this.stores.queue.update((q) => {
      updated = q.tasks.find((t) => t.id === id);
      if (!updated) throw notFound(`Task "${id}" is not in the queue.`);
      change(updated);
      updated.updatedAt = this.stamp();
    });
    return updated as Task;
  }

  private async removeTask(id: string): Promise<void> {
    await this.stores.queue.update((q) => {
      q.tasks = q.tasks.filter((t) => t.id !== id);
    });
    this.buffers.delete(id);
    this.waitingNotes.delete(id);
  }

  /** The task's other repos that are still registered, with their branches. */
  private async extrasOf(task: Task): Promise<ExtraRepo[]> {
    if (task.extraRepos.length === 0) return [];
    const repos = await this.deps.repos.list();
    return task.extraRepos.flatMap((x) => {
      const repo = repos.find((r) => r.id === x.repo);
      return repo ? [{ repo, br: x.branch }] : [];
    });
  }

  /** The other repos that have a branch, for actions that only touch existing branches. */
  private async extraBranchesOf(task: Task): Promise<{ repo: Repo; br: TaskBranch }[]> {
    return (await this.extrasOf(task)).flatMap((x) => (x.br ? [{ repo: x.repo, br: x.br }] : []));
  }

  /** After a run: commit each other repo's work on its branch and check its previous branch out again. */
  private async settleExtras(task: Task, message: string): Promise<void> {
    for (const { repo, br } of await this.extraBranchesOf(task)) {
      const settled = await this.deps.branches
        .settle(repo, br, message, identityOf(repo))
        .catch((e: Error) => ({ committed: false, warning: `${repo.name}: couldn't commit or switch back: ${e.message}` }));
      if (settled.warning) this.log({ taskId: task.id, repo: task.repo, account: null, event: "warning", detail: settled.warning });
    }
  }

  private async resetExtras(task: Task): Promise<void> {
    for (const { repo, br } of await this.extraBranchesOf(task)) await this.deps.branches.resetToBase(repo, br);
  }

  private async deleteExtras(task: Task): Promise<void> {
    for (const { repo, br } of await this.extraBranchesOf(task)) await this.deps.branches.deleteBranch(repo, br);
  }

  /**
   * Keep / Push / Mark finished for the other repos: a branch the agent left commits on is kept
   * (AI co-author lines stripped) and, when pushing, pushed with its own PR/MR; an empty one (the
   * repo was only read) is deleted.
   */
  private async wrapUpExtras(task: Task, push: boolean): Promise<{ notes: string[]; pushed: PushResponse["others"]; output: string[] }> {
    const notes: string[] = [];
    const pushed: PushResponse["others"] = [];
    const output: string[] = [];
    for (const { repo, br } of await this.extraBranchesOf(task)) {
      const commits = await this.deps.branches.commitCount(repo, br);
      if (commits === null) continue;
      if (commits === 0) {
        await this.deps.branches.deleteBranch(repo, br);
        notes.push(`${repo.name}: no changes, branch deleted`);
        continue;
      }
      await this.deps.branches.stripAiTrailers(repo, br);
      if (push) {
        const result = await this.deps.branches.push(repo, br, task.title);
        pushed.push({ repo: repo.id, branch: br.name, url: result.url });
        if (result.output) output.push(`── ${repo.name} ──\n${result.output}`);
        notes.push(`${repo.name}: pushed ${br.name}${result.url ? ` (${result.url})` : ""}`);
      } else {
        notes.push(`${repo.name}: kept ${br.name} (${plural(commits, "commit")})`);
      }
    }
    return { notes, pushed, output };
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async create(req: CreateTaskRequest): Promise<TaskView> {
    const message = req.message ?? "";
    if (!message.trim()) throw badRequest("The task message is empty.");
    const repo = await this.deps.repos.get(req.repo);
    const override = req.accountOverride || null;
    if (override) await this.deps.accounts.get(override);
    if (!override && repo.accountChain.length === 0) {
      throw badRequest(`"${repo.id}" has no accounts in its chain. Add some on the Repos page.`);
    }
    const attachments = await this.deps.attachments.resolve(req.attachmentIds);
    const promptIds = await this.deps.prompts.validate(req.promptIds);
    // Not given (API, scripts) = the repo's default prompts, as the composer pre-ticks them.
    const repoPrompts = await this.deps.repos.prompts(repo.id);
    const repoPromptIds = req.repoPromptIds === undefined ? await repoPrompts.defaultIds() : await repoPrompts.validate(req.repoPromptIds);
    const extras = await this.deps.repos.extras(repo, req.extraRepos);

    const firstLine = message.trim().split("\n")[0] ?? "";
    const title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    const slug = slugify(firstLine.split(/\s+/).slice(0, 6).join(" ")) || "task";

    let task: Task | undefined;
    await this.stores.queue.update((q) => {
      const id = `task_${String(q.nextTaskNumber).padStart(4, "0")}_${slug}`;
      q.nextTaskNumber += 1;
      const stamp = this.stamp();
      task = {
        id,
        title,
        repo: repo.id,
        extraRepos: extras.map((r) => ({ repo: r.id, branch: null })),
        status: "pending",
        message,
        attachments,
        promptIds,
        repoPromptIds,
        accountOverride: override,
        currentAccount: null,
        branch: null,
        session: null,
        replies: [],
        pendingReply: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      q.tasks.push(task);
    });
    const created = task as Task;
    this.log({
      taskId: created.id,
      repo: repo.id,
      account: override,
      event: "queued",
      detail: `Queued: ${created.title}`,
      data: {
        title: created.title,
        message,
        accountOverride: override,
        attachments,
        promptIds,
        repoPromptIds,
        extraRepos: extras.map((r) => r.id),
      },
    });
    await this.publish();
    void this.tick();
    return { ...created, waitingNote: null };
  }

  /** Reorder pending tasks; others keep their relative positions. */
  async reorder(ids: string[]): Promise<void> {
    await this.stores.queue.update((q) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      const pending = q.tasks.filter((t) => t.status === "pending").sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      let i = 0;
      q.tasks = q.tasks.map((t) => (t.status === "pending" ? (pending[i++] as Task) : t));
    });
    await this.publish();
    void this.tick();
  }

  async cancel(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status === "running") {
      const run = this.live.get(id);
      if (!run) throw conflict("Task is marked running but no process is attached. Try again in a moment.");
      run.cancelRequested = true;
      await run.handle.cancel();
      return; // finishRun handles the rest
    }
    if (task.status !== "pending") throw conflict(`Only pending or running tasks can be cancelled (this one is ${task.status}).`);

    if (task.pendingReply !== null && task.session) {
      // Cancelling a queued reply: back to review, work kept.
      await this.updateTask(id, (t) => {
        t.status = "needs-review";
        t.pendingReply = null;
        t.replies = t.replies.slice(0, -1);
      });
      this.log({ taskId: id, repo: task.repo, account: null, event: "cancelled", detail: "Queued reply cancelled." });
    } else {
      if (task.branch) await this.deps.branches.deleteBranch(await this.deps.repos.get(task.repo), task.branch);
      await this.deleteExtras(task);
      await this.removeTask(id);
      this.log({ taskId: id, repo: task.repo, account: null, event: "cancelled", detail: "Cancelled before it ran." });
      this.deps.broadcaster.taskStatus(id, "failed", "Cancelled");
    }
    await this.publish();
    void this.tick();
  }

  /** Start over from the base commit with the original message. */
  async retry(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status !== "interrupted" && task.status !== "needs-review") {
      throw conflict(`Only interrupted or needs-review tasks can be retried (this one is ${task.status}).`);
    }
    if (task.branch) await this.deps.branches.resetToBase(await this.deps.repos.get(task.repo), task.branch);
    await this.resetExtras(task);
    await this.updateTask(id, (t) => {
      t.status = "pending";
      t.session = null;
      t.pendingReply = null;
      t.replies = [];
      t.currentAccount = null;
    });
    this.buffers.delete(id);
    this.log({ taskId: id, repo: task.repo, account: null, event: "queued", detail: "Retry: starting over from the base commit." });
    await this.publish();
    void this.tick();
  }

  async reply(id: string, message: string, attachmentIds: string[] = [], promptIdsIn: string[] = []): Promise<void> {
    if (!message.trim()) throw badRequest("The reply is empty.");
    const task = await this.getTask(id);
    if (task.status !== "needs-review" || !task.session) {
      throw conflict("You can reply to a task once it's finished a run and is waiting for review.");
    }
    const attachments = await this.deps.attachments.resolve(attachmentIds);
    const promptIds = await this.deps.prompts.validate(promptIdsIn);
    await this.updateTask(id, (t) => {
      t.replies.push({ at: this.stamp(), message, attachments, promptIds });
      t.pendingReply = message;
      t.status = "pending";
    });
    this.log({ taskId: id, repo: task.repo, account: null, event: "reply", detail: preview(message, 200), data: { message, attachments, promptIds } });
    await this.publish();
    void this.tick();
  }

  // ── review actions ───────────────────────────────────────────────────────

  private async reviewable(id: string): Promise<{ task: Task; repo: Repo; br: TaskBranch }> {
    const task = await this.getTask(id);
    if (task.status !== "needs-review" && task.status !== "interrupted") {
      throw conflict(`This task is ${task.status}; review actions need a finished or interrupted task.`);
    }
    if (!task.branch) throw conflict("This task has no branch yet.");
    return { task, repo: await this.deps.repos.get(task.repo), br: task.branch };
  }

  async diff(id: string): Promise<DiffResponse> {
    const task = await this.getTask(id);
    if (!task.branch) throw conflict("This task has no branch yet.");
    const repo = await this.deps.repos.get(task.repo);
    const br = task.branch;
    const others = await Promise.all(
      (await this.extraBranchesOf(task)).map(async (x) => ({
        repo: x.repo.id,
        patch: await this.deps.branches.diff(x.repo, x.br),
        branch: x.br.name,
        baseBranch: x.br.base,
        baseCommit: x.br.baseCommit,
        repoPath: x.repo.path,
      })),
    );
    return {
      patch: await this.deps.branches.diff(repo, br),
      branch: br.name,
      baseBranch: br.base,
      baseCommit: br.baseCommit,
      repoPath: repo.path,
      others,
    };
  }

  async keep(id: string): Promise<void> {
    const { task, repo, br } = await this.reviewable(id);
    await this.deps.branches.stripAiTrailers(repo, br);
    const extras = await this.wrapUpExtras(task, false);
    await this.removeTask(id);
    this.log({
      taskId: id,
      repo: task.repo,
      account: task.currentAccount,
      event: "kept",
      detail: [`Kept branch ${br.name}`, ...extras.notes].join(". "),
      data: { branch: br.name },
    });
    this.deps.broadcaster.taskStatus(id, "done", `Kept branch ${br.name}`);
    await this.publish();
  }

  async push(id: string): Promise<PushResponse> {
    const { task, repo, br } = await this.reviewable(id);
    await this.deps.branches.stripAiTrailers(repo, br);
    const result = await this.deps.branches.push(repo, br, task.title);
    const extras = await this.wrapUpExtras(task, true);
    const output = [extras.output.length ? `── ${repo.name} ──\n${result.output}` : result.output, ...extras.output]
      .filter(Boolean)
      .join("\n\n");
    await this.removeTask(id);
    this.log({
      taskId: id,
      repo: task.repo,
      account: task.currentAccount,
      event: "pushed",
      detail: [result.url ? `Pushed ${br.name}: ${result.url}` : `Pushed ${br.name}`, ...extras.notes].join(". "),
      data: { branch: br.name, url: result.url, output, others: extras.pushed },
    });
    this.deps.broadcaster.taskStatus(id, "done", `Pushed ${br.name}`);
    await this.publish();
    return { url: result.url, output, others: extras.pushed };
  }

  /**
   * You're done with it: off the queue, into History as done. A branch with commits stays (with any
   * AI co-author lines stripped); an empty one (the work landed elsewhere) is deleted, losing nothing.
   */
  async markFinished(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status !== "needs-review" && task.status !== "interrupted") {
      throw conflict(`This task is ${task.status}; only a task waiting for review or interrupted can be marked finished.`);
    }
    let detail = "Marked finished.";
    if (task.branch) {
      const repo = await this.deps.repos.get(task.repo);
      const commits = await this.deps.branches.commitCount(repo, task.branch);
      if (commits === 0) {
        await this.deps.branches.deleteBranch(repo, task.branch);
        detail = `Marked finished. Branch ${task.branch.name} had no commits, so it was deleted.`;
      } else if (commits !== null) {
        await this.deps.branches.stripAiTrailers(repo, task.branch);
        detail = `Marked finished. Branch ${task.branch.name} kept (${plural(commits, "commit")}).`;
      }
    }
    const extras = await this.wrapUpExtras(task, false);
    if (extras.notes.length) detail = `${detail} ${extras.notes.join(". ")}.`;
    await this.removeTask(id);
    this.log({ taskId: id, repo: task.repo, account: task.currentAccount, event: "marked-finished", detail, data: { branch: task.branch?.name ?? null } });
    this.deps.broadcaster.taskStatus(id, "done", detail);
    await this.publish();
  }

  /** Remove a task from the queue in any state. A running task is stopped first. */
  async discard(id: string): Promise<void> {
    let task = await this.getTask(id);
    const wasRunning = task.status === "running";
    if (wasRunning) task = await this.stopForDiscard(id);
    if (task.branch) await this.deps.branches.deleteBranch(await this.deps.repos.get(task.repo), task.branch);
    await this.deleteExtras(task);
    await this.removeTask(id);
    this.log({
      taskId: id,
      repo: task.repo,
      account: task.currentAccount,
      event: "discarded",
      detail: task.branch
        ? `${wasRunning ? "Stopped and discarded" : "Discarded"}: branch ${task.branch.name} deleted.`
        : "Discarded before it ran.",
    });
    this.deps.broadcaster.taskStatus(id, "done", "Discarded");
    await this.publish();
    void this.tick();
  }

  /**
   * Stop a running task and wait for its run to wind down (finishRun marks it interrupted).
   * Covers a task that is still starting: waits for its process to attach, then stops it.
   */
  private async stopForDiscard(id: string): Promise<Task> {
    const deadline = Date.now() + 15_000;
    let cancelled = false;
    for (;;) {
      const run = this.live.get(id);
      if (run && !cancelled) {
        cancelled = true;
        run.cancelRequested = true;
        await run.handle.cancel();
      }
      const task = await this.getTask(id);
      if (task.status !== "running") return task;
      if (Date.now() > deadline) return task; // stale "running" with no process: discard anyway
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── history ──────────────────────────────────────────────────────────────

  async history(): Promise<HistoryItem[]> {
    const inQueue = new Set((await this.stores.queue.read()).tasks.map((t) => t.id));
    const byTask = new Map<string, ActivityEntry[]>();
    for (const entry of await this.stores.activity.readAll()) {
      if (inQueue.has(entry.taskId)) continue;
      const list = byTask.get(entry.taskId);
      if (list) list.push(entry);
      else byTask.set(entry.taskId, [entry]);
    }
    const outcomes: Record<string, HistoryItem["outcome"]> = {
      kept: "done",
      pushed: "done",
      "marked-finished": "done",
      discarded: "discarded",
      failed: "failed",
      cancelled: "cancelled",
    };
    const items: HistoryItem[] = [];
    for (const [taskId, entries] of byTask) {
      const terminal = [...entries].reverse().find((e) => e.event in outcomes);
      if (!terminal) continue;
      const queued = entries.find((e) => e.event === "queued");
      const started = [...entries].reverse().find((e) => e.event === "started");
      items.push({
        taskId,
        title: String(queued?.data?.title ?? taskId),
        repo: terminal.repo,
        message: String(queued?.data?.message ?? ""),
        outcome: outcomes[terminal.event] as HistoryItem["outcome"],
        lastAccount: [...entries].reverse().find((e) => e.account)?.account ?? null,
        branch: (started?.data?.branch as string | undefined) ?? null,
        queuedAt: entries[0]?.at ?? terminal.at,
        endedAt: terminal.at,
      });
    }
    return items.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  }

  // ── scheduler ────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        await this.schedule();
      } while (this.tickAgain);
    } catch (error) {
      console.error(`[queue] scheduler error: ${(error as Error).stack ?? error}`);
    } finally {
      this.ticking = false;
    }
  }

  private async schedule(): Promise<void> {
    await this.deps.accounts.expireLimits();
    const settings = await this.stores.settings.read();
    const { tasks } = await this.stores.queue.read();
    const accounts = await this.deps.accounts.listRaw();
    const repos = await this.deps.repos.list();
    const now = this.now();

    let running = this.live.size;
    const busyRepos = new Set([...this.live.values()].flatMap((r) => r.repos));
    const notes = new Map<string, string>();
    let wakeAt: number | null = null;

    for (const task of tasks) {
      if (task.status !== "pending") continue;
      if (running >= settings.maxParallelTasks) {
        notes.set(task.id, `Waiting for a free slot (${running} of ${settings.maxParallelTasks} running).`);
        continue;
      }
      const taskRepos = [task.repo, ...task.extraRepos.map((x) => x.repo)];
      const busy = taskRepos.find((id) => busyRepos.has(id));
      if (busy) {
        notes.set(task.id, busy === task.repo ? "Waiting for the other task on this repo to finish." : `Waiting for the other task on ${busy} to finish.`);
        continue;
      }
      const repo = repos.find((r) => r.id === task.repo);
      if (!repo) {
        notes.set(task.id, `Repo "${task.repo}" is no longer registered.`);
        continue;
      }
      const blocked = await this.notReady(taskRepos, repos);
      if (blocked) {
        notes.set(task.id, blocked);
        continue;
      }
      const isReply = task.pendingReply !== null && task.session !== null;
      const pick = pickAccount({
        candidates: [task.accountOverride, ...repo.accountChain].filter((a): a is string => !!a),
        accounts,
        now,
        provider: isReply ? task.session?.provider : undefined,
        host: repo.host ?? null,
      });
      if (pick.kind === "wait") {
        notes.set(task.id, pick.until ? `${pick.reason} Next one frees up at ${shortTime(pick.until, now)}.` : pick.reason);
        if (pick.until) {
          const at = new Date(pick.until).getTime();
          if (wakeAt === null || at < wakeAt) wakeAt = at;
        }
        continue;
      }
      running += 1;
      for (const id of taskRepos) busyRepos.add(id);
      await this.startRun(task, repo, pick.account, isReply);
    }

    const changed =
      notes.size !== this.waitingNotes.size || [...notes].some(([id, note]) => this.waitingNotes.get(id) !== note);
    this.waitingNotes = notes;
    if (changed) await this.publish();

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wakeAt !== null) {
      const delay = Math.min(Math.max(wakeAt - now.getTime() + 1000, 1000), MAX_TIMER_MS);
      this.timer = setTimeout(() => void this.tick(), delay);
      this.timer.unref?.();
    }
  }

  /**
   * Why a task's repos can't take a run right now (null = they can): one is gone, can't be reached,
   * or has uncommitted changes (tasks switch branches in your checkout).
   */
  private async notReady(ids: string[], repos: Repo[]): Promise<string | null> {
    for (const id of ids) {
      const repo = repos.find((r) => r.id === id);
      if (!repo) return `Repo "${id}" is no longer registered.`;
      // A repo that can't be reached right now (SSH host down, folder gone): wait, it's re-checked.
      const availability = this.deps.repos.availabilityOf(repo.id);
      if (availability?.state === "unreachable") {
        return `Unable to load ${repo.name} at this time (${availability.message ?? "unreachable"}). Retrying automatically.`;
      }
      let clean: boolean;
      try {
        clean = await this.deps.branches.isClean(repo);
      } catch (error) {
        this.deps.repos.markUnreachable(repo, error);
        return `Unable to load ${repo.name} at this time. Retrying automatically.`;
      }
      if (!clean) return `${repo.name} has uncommitted changes. Commit or stash them; tasks switch branches in your checkout.`;
    }
    return null;
  }

  // ── running ──────────────────────────────────────────────────────────────

  private async startRun(task: Task, repo: Repo, account: Account, isReply: boolean): Promise<void> {
    const settings = await this.stores.settings.read();
    const buffer: OutputBuffer = isReply ? (this.buffers.get(task.id) ?? { events: [], raw: [] }) : { events: [], raw: [] };
    this.buffers.set(task.id, buffer);

    let checkedOut = false;
    const extras = await this.extrasOf(task);
    const heldRepos = [repo.id, ...extras.map((x) => x.repo.id)];
    try {
      await this.updateTask(task.id, (t) => {
        t.status = "running";
        t.currentAccount = account.id;
      });
      // Fresh runs (first run, retry, fallback) start the branch from the base commit; replies continue it.
      const br = await this.deps.branches.checkoutForRun(repo, task.id, task.branch, !isReply);
      checkedOut = true;
      await this.updateTask(task.id, (t) => {
        t.branch = br;
      });
      // The other repos get the same branch name, each from its own base branch.
      const switched: { repo: Repo; br: TaskBranch }[] = [];
      try {
        for (const x of extras) {
          const xbr = await this.deps.branches.checkoutForRun(x.repo, task.id, x.br, !isReply);
          switched.push({ repo: x.repo, br: xbr });
          await this.updateTask(task.id, (t) => {
            const entry = t.extraRepos.find((e) => e.repo === x.repo.id);
            if (entry) entry.branch = xbr;
          });
        }
      } catch (error) {
        // Nothing has run yet: give every repo already switched its previous branch back.
        for (const done of [...switched, { repo, br }].reverse()) await this.deps.branches.settle(done.repo, done.br, task.title).catch(() => {});
        checkedOut = false;
        throw error;
      }

      // Attached files: on this Mac they're read in place; for a remote repo they're copied to the server.
      const allFiles = [...task.attachments, ...task.replies.flatMap((r) => r.attachments)];
      const located = await this.deps.attachments.locate(repo.host ?? null, allFiles);
      const runFiles = isReply ? (task.replies.at(-1)?.attachments ?? []) : task.attachments;
      const runPaths = runFiles.map((a) => located.get(a.id)?.path as string);
      // The session may refer back to earlier files, so every file of the task stays readable.
      const addDirs = [...extras.map((x) => x.repo.path), ...allFiles.map((a) => located.get(a.id)?.dir as string)];
      // Bound saved prompts: their current text, read now (like the base prompts).
      const boundIds = isReply ? (task.replies.at(-1)?.promptIds ?? []) : task.promptIds;
      const bound = await this.deps.prompts.resolve(boundIds);
      if (bound.missing.length) {
        this.log({
          taskId: task.id,
          repo: repo.id,
          account: account.id,
          event: "warning",
          detail: `Saved prompt(s) no longer in the library, not sent: ${bound.missing.join(", ")}`,
        });
      }
      const boundBodies = bound.prompts.map((p) => p.body);
      // The repo's prompts ticked for this task, current text (a reply's session already has them).
      const repoPromptList = await this.deps.repos.prompts(repo.id);
      const repoBound = isReply
        ? { prompts: [], missing: [] }
        : await repoPromptList.resolve(task.repoPromptIds ?? (await repoPromptList.defaultIds()));
      if (repoBound.missing.length) {
        this.log({
          taskId: task.id,
          repo: repo.id,
          account: account.id,
          event: "warning",
          detail: `Repo prompt(s) no longer in ${repo.id}'s list, not sent: ${repoBound.missing.join(", ")}`,
        });
      }
      const assembled = isReply
        ? this.deps.assembler.forReply(task.pendingReply ?? "", runPaths, boundBodies)
        : await this.deps.assembler.forTask(task.message, {
            repoPrompts: repoBound.prompts.map((p) => p.body),
            boundPrompts: boundBodies,
            otherRepos: extras.map((x) => ({ name: x.repo.name, path: x.repo.path })),
            attachmentPaths: runPaths,
          });

      let resume: { sessionId: string; fromConfigDir: string | null } | null = null;
      if (isReply && task.session) {
        const from = (await this.deps.accounts.listRaw()).find((a) => a.id === task.session?.account);
        resume = {
          sessionId: task.session.sessionId,
          fromConfigDir: from ? this.deps.accounts.configDirOf(from) : this.deps.accounts.configDirOf(account),
        };
      }

      this.log({
        taskId: task.id,
        repo: repo.id,
        account: account.id,
        event: "started",
        detail: `Started on ${account.id} (${account.provider})${isReply ? ", continuing the session with your reply" : ""}`,
        data: {
          prompt: assembled.prompt,
          kind: isReply ? "reply" : "fresh",
          branch: br.name,
          baseBranch: br.base,
          cwd: repo.path,
          extraRepos: extras.map((x) => ({ repo: x.repo.id, path: x.repo.path })),
          layers: assembled.layers,
          boundPrompts: bound.prompts.map((p) => ({ id: p.id, name: p.name })),
          repoPrompts: repoBound.prompts.map((p) => ({ id: p.id, name: p.name })),
        },
      });

      const adapter = this.deps.adapters[account.provider];
      await adapter.prepare?.(this.deps.accounts.context(account), settings);
      const handle = adapter.run(
        {
          ...this.deps.accounts.context(account),
          prompt: assembled.prompt,
          cwd: repo.path,
          resume,
          addDirs: [...new Set(addDirs)],
          gitIdentity: identityOf(repo),
        },
        settings,
      );
      const run: LiveRun = {
        checkedOut: true,
        taskId: task.id,
        repo: repo.id,
        repos: heldRepos,
        account,
        handle,
        isReply,
        cancelRequested: false,
      };
      this.live.set(task.id, run);

      handle.onStream((event) => this.onEvent(run, event, buffer));
      handle.onRaw((raw) => {
        pushCapped(buffer.raw, raw);
        this.deps.broadcaster.taskRaw(task.id, raw);
      });
      this.deps.broadcaster.taskStatus(task.id, "running", `Running on ${account.id}`);
      await this.publish();

      handle.done
        .catch((error): RunResult => ({ outcome: "failed", exitCode: null, message: String(error), stderrTail: "" }))
        .then((result) => this.finishRun(run, result))
        .catch((error) => console.error(`[queue] finishing ${task.id}: ${(error as Error).stack ?? error}`));
    } catch (error) {
      this.live.delete(task.id);
      if (error instanceof DirtyRepoError) {
        // You changed files between the check and the checkout: just wait again.
        await this.updateTask(task.id, (t) => {
          t.status = "pending";
          t.currentAccount = null;
        });
        this.waitingNotes.set(task.id, error.message);
        await this.publish();
        return;
      }
      // Couldn't start (base branch missing, CLI setup…). Treat as a failed run.
      await this.finishRun(
        { checkedOut, taskId: task.id, repo: repo.id, repos: heldRepos, account, handle: null as never, isReply, cancelRequested: false },
        { outcome: "failed", exitCode: null, message: (error as Error).message, stderrTail: "" },
      );
    }
  }

  private onEvent(run: LiveRun, event: StreamEvent, buffer: OutputBuffer): void {
    pushCapped(buffer.events, event);
    this.deps.broadcaster.taskEvent(run.taskId, event);
    const base = { taskId: run.taskId, repo: run.repo, account: run.account.id };
    switch (event.kind) {
      case "message":
        this.log({ ...base, event: "message", detail: preview(event.text, 200), data: { text: event.text } });
        break;
      case "tool-start":
        this.log({ ...base, event: "tool-call", detail: `${event.tool}: ${event.summary}`.slice(0, 300), data: { callId: event.callId, tool: event.tool } });
        break;
      case "file-edit":
        this.log({ ...base, event: "file-edit", detail: event.path });
        break;
      case "warning":
        this.log({ ...base, event: "warning", detail: event.text });
        break;
      default:
        break;
    }
  }

  private async finishRun(run: LiveRun, result: RunResult): Promise<void> {
    this.live.delete(run.taskId);
    const task = (await this.stores.queue.read()).tasks.find((t) => t.id === run.taskId);
    if (!task) return;
    const account = run.account;
    const base = { taskId: task.id, repo: task.repo, account: account.id };
    const repo = (await this.deps.repos.list()).find((r) => r.id === task.repo);

    // Commit what the agent left on the task branch and check your previous branch out again.
    if (run.checkedOut && repo && task.branch) {
      const reply = run.isReply ? (task.replies.at(-1)?.message ?? "").trim().split("\n")[0] : "";
      const message = reply ? `${task.title}: ${reply}`.slice(0, 120) : task.title;
      const settled = await this.deps.branches
        .settle(repo, task.branch, message, identityOf(repo))
        .catch((e: Error) => ({ committed: false, warning: `Couldn't commit or switch back: ${e.message}` }));
      if (settled.warning) this.log({ ...base, event: "warning", detail: settled.warning });
      await this.settleExtras(task, message);
    }

    switch (result.outcome) {
      case "success": {
        await this.updateTask(task.id, (t) => {
          t.status = "needs-review";
          t.pendingReply = null;
          t.session = result.sessionId ? { provider: account.provider, account: account.id, sessionId: result.sessionId } : t.session;
        });
        this.log({
          ...base,
          event: "finished",
          detail: `Finished on ${account.id}. Ready for review.`,
          data: { result: result.resultText, costUsd: result.costUsd },
        });
        this.deps.broadcaster.taskStatus(task.id, "needs-review", "Ready for review");
        this.deps.broadcaster.notify(task.id, "Task ready for review", task.title);
        break;
      }

      case "limit":
      case "logged-out": {
        const reason = result.outcome === "limit" ? result.limit.reason : result.message;
        if (result.outcome === "limit") {
          const view = await this.deps.accounts.markLimited(account.id, result.limit.resetsAt, reason);
          this.log({
            ...base,
            event: "limit-hit",
            detail: `${account.id} hit a usage limit (${reason}). Free again at ${view.limitedUntil ? shortTime(view.limitedUntil, this.now()) : "?"}.`,
            data: { resetsAt: result.limit.resetsAt, limitedUntil: view.limitedUntil },
          });
        } else {
          await this.deps.accounts.markLoggedOut(account.id);
          this.log({ ...base, event: "warning", detail: `${account.id} is logged out (${reason}). Log in again on the Settings page.` });
        }

        // Fresh runs start over on the next account; replies keep their session and wait for a same-CLI account.
        if (!run.isReply && repo && task.branch) await this.deps.branches.resetToBase(repo, task.branch);
        if (!run.isReply) await this.resetExtras(task);
        await this.updateTask(task.id, (t) => {
          t.status = "pending";
          t.currentAccount = null;
          if (!run.isReply) t.session = null;
        });

        const next = repo
          ? pickAccount({
              candidates: [task.accountOverride, ...repo.accountChain].filter((a): a is string => !!a),
              accounts: await this.deps.accounts.listRaw(),
              now: this.now(),
              provider: run.isReply ? task.session?.provider : undefined,
              host: repo.host ?? null,
            })
          : null;
        const what = result.outcome === "limit" ? "hit usage limit" : "is logged out";
        this.log({
          ...base,
          event: "fallback",
          detail:
            next?.kind === "account"
              ? `${account.id} ${what}, retrying on ${next.account.id}`
              : `${account.id} ${what}; no other account available, waiting.`,
        });
        this.deps.broadcaster.taskStatus(task.id, "pending", `${account.id} ${what}`);
        break;
      }

      case "cancelled": {
        await this.updateTask(task.id, (t) => {
          t.status = "interrupted";
        });
        this.log({ ...base, event: "cancelled", detail: "Stopped by you. Retry or discard it." });
        this.deps.broadcaster.taskStatus(task.id, "interrupted", "Stopped");
        break;
      }

      case "failed": {
        const data = { exitCode: result.exitCode, stderrTail: result.stderrTail };
        if (run.isReply) {
          // Keep the earlier work: back to review.
          await this.updateTask(task.id, (t) => {
            t.status = "needs-review";
            t.pendingReply = null;
          });
          this.log({ ...base, event: "warning", detail: `Reply run failed: ${result.message}`, data });
          this.deps.broadcaster.taskStatus(task.id, "needs-review", `Reply failed: ${result.message}`);
        } else {
          if (repo && task.branch) await this.deps.branches.deleteBranch(repo, task.branch);
          await this.deleteExtras(task);
          await this.removeTask(task.id);
          this.log({ ...base, event: "failed", detail: result.message.slice(0, 500), data });
          this.deps.broadcaster.taskStatus(task.id, "failed", result.message);
        }
        this.deps.broadcaster.notify(task.id, "Task failed", `${task.title}: ${result.message.slice(0, 140)}`);
        break;
      }
    }

    await this.publish();
    void this.tick();
  }
}
