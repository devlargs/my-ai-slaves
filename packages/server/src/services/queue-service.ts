import {
  type Account,
  type ActivityEntry,
  type CreateTaskRequest,
  type DiffResponse,
  formatLocalIso,
  type HistoryItem,
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
import type { RepoGit } from "./repo-git";

const LIVE_BUFFER_LIMIT = 5000;
const MAX_TIMER_MS = 60 * 60 * 1000;

interface LiveRun {
  taskId: string;
  repo: string;
  /** Every repo the run reaches (the main one + the task's other repos): busy until it ends. */
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
  git: RepoGit;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  broadcaster: Broadcaster;
  attachments: AttachmentStore;
  prompts: PromptLibrary;
  now?: () => Date;
}

/** The repo's committer setting; null fields fall back to your git config. */
const identityOf = (repo: Repo) => ({ name: repo.committerName, email: repo.committerEmail });

const pushCapped = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > LIVE_BUFFER_LIMIT) list.splice(0, list.length - LIVE_BUFFER_LIMIT);
};

/**
 * Owns queue.json and every task run.
 * - 1 running task per repo, `maxParallelTasks` overall, pending tasks start in queue order.
 * - Runs happen in the repo exactly as it's checked out. The app never creates, switches, resets, commits
 *   or deletes branches (in the main repo or a cross-repo task's other repos): the ticked repo prompts
 *   tell the agent how to handle changes. It only records where the checkout was, to show a diff.
 * - Usage limit / logged out mid-run → mark the account and re-run the same prompt on the next account
 *   in the chain (or wait until one frees up).
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
          await this.deps.git.removeLegacyWorktree(repo, wt.path, `${task.title} (moved off worktree)`, identityOf(repo));
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
    const extraRepos: Task["extraRepos"] = [];
    for (const extra of await this.deps.repos.extras(repo, req.extraRepos)) {
      const list = await this.deps.repos.prompts(extra.id);
      const ticked = req.extraRepoPromptIds?.[extra.id];
      extraRepos.push({ repo: extra.id, promptIds: ticked === undefined ? await list.defaultIds() : await list.validate(ticked) });
    }

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
        extraRepos,
        status: "pending",
        message,
        attachments,
        promptIds,
        repoPromptIds,
        accountOverride: override,
        currentAccount: null,
        checkout: null,
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
      data: { title: created.title, message, accountOverride: override, attachments, promptIds, repoPromptIds, extraRepos },
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
      await this.removeTask(id);
      this.log({ taskId: id, repo: task.repo, account: null, event: "cancelled", detail: "Cancelled before it ran." });
      this.deps.broadcaster.taskStatus(id, "failed", "Cancelled");
    }
    await this.publish();
    void this.tick();
  }

  /** Run the original message again in a new session. The repo is left as it is. */
  async retry(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status !== "interrupted" && task.status !== "needs-review") {
      throw conflict(`Only interrupted or needs-review tasks can be retried (this one is ${task.status}).`);
    }
    await this.updateTask(id, (t) => {
      t.status = "pending";
      t.session = null;
      t.pendingReply = null;
      t.replies = [];
      t.currentAccount = null;
    });
    this.buffers.delete(id);
    this.log({ taskId: id, repo: task.repo, account: null, event: "queued", detail: "Retry: running the task again in a new session." });
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

  /** What changed in the checkout since the task started. Read-only. */
  async diff(id: string): Promise<DiffResponse> {
    const task = await this.getTask(id);
    const repo = await this.deps.repos.get(task.repo);
    if (task.checkout) {
      const changes = await this.deps.git.changesSince(repo, task.checkout);
      return { ...changes, startedOn: task.checkout, repoPath: repo.path };
    }
    if (task.branch) {
      // A task from an older version that still has its ai/ branch: shown, never touched.
      return { patch: await this.deps.git.legacyDiff(repo, task.branch), ref: task.branch.name, from: task.branch.baseCommit, startedOn: null, repoPath: repo.path };
    }
    throw conflict("This task hasn't run yet.");
  }

  /** You're done with it: off the queue, into History as done. Nothing in the repo is touched. */
  async markFinished(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status !== "needs-review" && task.status !== "interrupted") {
      throw conflict(`This task is ${task.status}; only a task waiting for review or interrupted can be marked finished.`);
    }
    await this.removeTask(id);
    this.log({ taskId: id, repo: task.repo, account: task.currentAccount, event: "marked-finished", detail: "Marked finished." });
    this.deps.broadcaster.taskStatus(id, "done", "Marked finished");
    await this.publish();
  }

  /** Remove a task from the queue in any state. A running task is stopped first. The repo is left as it is. */
  async discard(id: string): Promise<void> {
    let task = await this.getTask(id);
    const wasRunning = task.status === "running";
    if (wasRunning) task = await this.stopForDiscard(id);
    await this.removeTask(id);
    this.log({
      taskId: id,
      repo: task.repo,
      account: task.currentAccount,
      event: "discarded",
      detail: wasRunning ? "Stopped and discarded. The repo was left as it is." : "Discarded. The repo was left as it is.",
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
        branch: ((started?.data?.ref ?? started?.data?.branch) as string | undefined) ?? null,
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
      // Two agents in one checkout would trip over each other: a repo is in one running task at a time.
      const taskRepos = [task.repo, ...task.extraRepos.map((x) => x.repo)];
      const busy = taskRepos.find((id) => busyRepos.has(id));
      if (busy) {
        notes.set(task.id, busy === task.repo ? "Waiting for the other task on this repo to finish." : `Waiting for the other task on ${busy} to finish.`);
        continue;
      }
      const missingExtra = await this.unavailableExtra(task, repos);
      if (missingExtra) {
        notes.set(task.id, missingExtra);
        continue;
      }
      const repo = repos.find((r) => r.id === task.repo);
      if (!repo) {
        notes.set(task.id, `Repo "${task.repo}" is no longer registered.`);
        continue;
      }
      // A repo that can't be reached right now (SSH host down, folder gone): wait, it's re-checked.
      const availability = this.deps.repos.availabilityOf(repo.id);
      if (availability?.state === "unreachable") {
        notes.set(task.id, `Unable to load ${repo.name} at this time (${availability.message ?? "unreachable"}). Retrying automatically.`);
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

  /** An other repo that is gone or can't be reached right now (its state is never checked or changed). */
  private async unavailableExtra(task: Task, repos: Repo[]): Promise<string | null> {
    for (const { repo: id } of task.extraRepos) {
      const repo = repos.find((r) => r.id === id);
      if (!repo) return `Repo "${id}" is no longer registered.`;
      const availability = this.deps.repos.availabilityOf(repo.id);
      if (availability?.state === "unreachable") {
        return `Unable to load ${repo.name} at this time (${availability.message ?? "unreachable"}). Retrying automatically.`;
      }
    }
    return null;
  }

  // ── running ──────────────────────────────────────────────────────────────

  private async startRun(task: Task, repo: Repo, account: Account, isReply: boolean): Promise<void> {
    const settings = await this.stores.settings.read();
    const buffer: OutputBuffer = isReply ? (this.buffers.get(task.id) ?? { events: [], raw: [] }) : { events: [], raw: [] };
    this.buffers.set(task.id, buffer);

    const repoList = await this.deps.repos.list();
    const extras = task.extraRepos.flatMap((x) => {
      const r = repoList.find((e) => e.id === x.repo);
      return r ? [{ repo: r, promptIds: x.promptIds }] : [];
    });
    const heldRepos = [repo.id, ...extras.map((x) => x.repo.id)];
    try {
      await this.updateTask(task.id, (t) => {
        t.status = "running";
        t.currentAccount = account.id;
      });
      // Where the checkout is (read only, never switched): the diff shows what changed since the first run.
      const where = await this.deps.git.where(repo).catch(() => null);
      if (!task.checkout && where) {
        await this.updateTask(task.id, (t) => {
          t.checkout = where;
        });
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
      // The other repos' ticked prompts (how to handle changes there), after the main repo's.
      const repoSent = repoBound.prompts.map((p) => ({ repo: repo.id, id: p.id, name: p.name, body: p.body }));
      if (!isReply) {
        for (const x of extras) {
          const got = await (await this.deps.repos.prompts(x.repo.id)).resolve(x.promptIds);
          if (got.missing.length) {
            this.log({
              taskId: task.id,
              repo: repo.id,
              account: account.id,
              event: "warning",
              detail: `Repo prompt(s) no longer in ${x.repo.id}'s list, not sent: ${got.missing.join(", ")}`,
            });
          }
          repoSent.push(...got.prompts.map((p) => ({ repo: x.repo.id, id: p.id, name: p.name, body: p.body })));
        }
      }
      const assembled = isReply
        ? this.deps.assembler.forReply(task.pendingReply ?? "", runPaths, boundBodies)
        : await this.deps.assembler.forTask(task.message, {
            repoPrompts: repoSent.map((p) => p.body),
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
          ref: where?.ref ?? null,
          commit: where?.commit ?? null,
          cwd: repo.path,
          extraRepos: extras.map((x) => ({ repo: x.repo.id, path: x.repo.path })),
          layers: assembled.layers,
          boundPrompts: bound.prompts.map((p) => ({ id: p.id, name: p.name })),
          repoPrompts: repoSent.map((p) => ({ repo: p.repo, id: p.id, name: p.name })),
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
        taskId: task.id,
        repo: repo.id,
        repos: heldRepos,
        account,
        handle,
        isReply,
        cancelRequested: false,
      };
      this.live.set(task.id, run);

      // Your side of the conversation, shown in the live output right where this run starts.
      const sent: StreamEvent = {
        kind: "user",
        text: isReply ? (task.pendingReply ?? "") : task.message,
        reply: isReply,
        attachments: runFiles.map((a) => a.name),
        prompts: isReply ? bound.prompts.map((p) => p.name) : [...repoSent.map((p) => p.name), ...bound.prompts.map((p) => p.name)],
      };
      pushCapped(buffer.events, sent);
      this.deps.broadcaster.taskEvent(task.id, sent);
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
      // Couldn't start (CLI setup…). Treat as a failed run.
      await this.finishRun(
        { taskId: task.id, repo: repo.id, repos: heldRepos, account, handle: null as never, isReply, cancelRequested: false },
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

        // Fresh runs start over on the next account (the repo is left as it is); replies keep their
        // session and wait for a same-CLI account.
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
