import {
  type Account,
  type CreateTaskRequest,
  type DiffResponse,
  formatLocalIso,
  type HistoryItem,
  type HistoryPage,
  type RawLine,
  type Repo,
  type SettingsFile,
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
import { planRun, type ResolvedRepoPrompts, type RunInputs, runFiles } from "./run-plan";
import { hiddenRepoOf, readHidden, reorderWithin, shownHistory, shownTask } from "./visibility";

const LIVE_BUFFER_LIMIT = 5000;
// Raw lines can be huge (a tool result carrying a whole file), and every task in the queue keeps
// its buffer: capped by size as well as by count, so the server's memory stays bounded.
const RAW_BUFFER_MAX_CHARS = 4_000_000;
const MAX_TIMER_MS = 60 * 60 * 1000;
/** Usage-limit / logged-out runs allowed per account in a task's chain before the task stops re-queueing. */
const MAX_FALLBACKS_PER_ACCOUNT = 2;

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

export interface OutputBuffer {
  events: StreamEvent[];
  raw: RawLine[];
  /** Total length of the lines in `raw`. */
  rawChars: number;
}

const newBuffer = (): OutputBuffer => ({ events: [], raw: [], rawChars: 0 });

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

/** The repo's committer, else the default committer, else null (your git config). */
export const identityOf = (repo: Repo, settings: SettingsFile) => {
  const committer =
    settings.committers.find((c) => c.id === repo.committerId) ??
    settings.committers.find((c) => c.id === settings.defaultCommitterId);
  if (committer) return { name: committer.name, email: committer.email };
  return { name: repo.committerName, email: repo.committerEmail };
};

const pushCapped = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > LIVE_BUFFER_LIMIT) list.splice(0, list.length - LIVE_BUFFER_LIMIT);
};

/** Adds a raw line, then drops the oldest ones while the buffer is over either limit (the newest line always stays). */
export function pushRawCapped(buffer: OutputBuffer, line: RawLine, maxLines = LIVE_BUFFER_LIMIT, maxChars = RAW_BUFFER_MAX_CHARS): void {
  buffer.raw.push(line);
  buffer.rawChars += line.line.length;
  let drop = 0;
  while (drop < buffer.raw.length - 1 && (buffer.raw.length - drop > maxLines || buffer.rawChars > maxChars)) {
    buffer.rawChars -= (buffer.raw[drop] as RawLine).line.length;
    drop += 1;
  }
  if (drop > 0) buffer.raw.splice(0, drop);
}

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
  /** Tasks marked running whose process isn't attached yet (git, attachments, CLI setup): their repos are held too. */
  private readonly starting = new Map<string, string[]>();
  /** Accounts a running or starting task uses (the one it runs on + the one its resumed session is from). */
  private readonly heldAccounts = new Map<string, string[]>();
  /** Whether a commit-graph action is queued or running in a repo (set by the app; none in tests). */
  private repoActionInFlight: (repoId: string) => boolean = () => false;
  private readonly buffers = new Map<string, OutputBuffer>();
  private waitingNotes = new Map<string, string>();
  private ticking = false;
  private tickAgain = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: QueueDeps) {
    this.now = deps.now ?? (() => new Date());
    // Deleting an account logs it out and removes its config folder: refused while a task uses it.
    deps.accounts.useTaskLock((accountId) => this.taskUsingAccount(accountId));
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

  /**
   * Tasks that were running when the server stopped come back as interrupted, except those stopped
   * by "Update and restart": they go back in the queue and run again.
   */
  async init(): Promise<void> {
    // A repo that becomes reachable (or unreachable) again changes what can run.
    this.deps.repos.onChange(() => void this.tick());
    await this.deps.repos.migrateCommitters();
    await this.migrateLegacyWorktrees();
    const interrupted: Task[] = [];
    const resumed: Task[] = [];
    await this.stores.queue.update((q) => {
      for (const task of q.tasks) {
        if (task.resumeOnStart && (task.status === "running" || task.status === "interrupted")) {
          task.resumeOnStart = false;
          task.status = "pending";
          task.currentAccount = null;
          // A reply resumes its session with the same reply; a first run starts over in a new one.
          if (task.pendingReply === null || !task.session) task.session = null;
          task.updatedAt = this.stamp();
          resumed.push(task);
        } else if (task.status === "running") {
          task.status = "interrupted";
          task.resumeOnStart = false;
          task.updatedAt = this.stamp();
          interrupted.push(task);
        } else if (task.resumeOnStart) {
          task.resumeOnStart = false;
        }
      }
    });
    for (const task of resumed) {
      this.log({
        taskId: task.id,
        repo: task.repo,
        account: null,
        event: "queued",
        detail: "The app restarted for an update while this task was running: running it again.",
      });
    }
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
    void this.sweepAttachments();
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /** Every attachment id a queued task, reply, saved prompt or repo prompt still refers to. */
  private async attachmentsInUse(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const t of (await this.stores.queue.read()).tasks) {
      for (const a of t.attachments) ids.add(a.id);
      for (const r of t.replies) for (const a of r.attachments) ids.add(a.id);
    }
    for (const p of await this.deps.prompts.list()) for (const a of p.attachments) ids.add(a.id);
    for (const repo of await this.deps.repos.list()) {
      const list = await this.deps.repos.prompts(repo.id).catch(() => null);
      for (const p of (await list?.list()) ?? []) for (const a of p.attachments) ids.add(a.id);
    }
    return ids;
  }

  /**
   * A task left the queue: delete its files (here and on its repo's host) unless something else
   * still uses them. Never fails the action that removed the task.
   */
  private releaseAttachments(task: Task): Promise<void> {
    const ids = [...task.attachments, ...task.replies.flatMap((r) => r.attachments)].map((a) => a.id);
    if (ids.length === 0) return Promise.resolve();
    const release = (async () => {
      const inUse = await this.attachmentsInUse();
      const unused = ids.filter((id) => !inUse.has(id));
      if (unused.length === 0) return;
      const repos = await this.deps.repos.list();
      const hosts = [task.repo, ...task.extraRepos.map((e) => e.repo)]
        .map((id) => repos.find((r) => r.id === id)?.host)
        .filter((h): h is string => !!h);
      await this.deps.attachments.remove(unused, hosts);
    })().catch((error: unknown) => console.error(`[attachments] ${(error as Error).message}`));
    this.attachmentWork.add(release);
    return release.finally(() => this.attachmentWork.delete(release));
  }

  /** Cleanup still in progress (tests wait for it). */
  private readonly attachmentWork = new Set<Promise<void>>();
  async settleAttachments(): Promise<void> {
    await Promise.all([...this.attachmentWork]);
  }

  /**
   * On startup: delete attachment folders older than a day that nothing refers to (a draft never
   * queued, a file removed in the composer, a prompt's replaced screenshot), here and on every repo host.
   */
  sweepAttachments(minAgeMs?: number): Promise<void> {
    const sweep = (async () => {
      const keep = await this.attachmentsInUse();
      const hosts = (await this.deps.repos.list()).map((r) => r.host).filter((h): h is string => !!h);
      await this.deps.attachments.sweep(keep, hosts, minAgeMs);
    })().catch((error: unknown) => console.error(`[attachments] ${(error as Error).message}`));
    this.attachmentWork.add(sweep);
    return sweep.finally(() => this.attachmentWork.delete(sweep));
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
    const settings = await this.stores.settings.read();
    for (const task of legacy) {
      const wt = task.worktree as NonNullable<Task["worktree"]>;
      const repo = repos.find((r) => r.id === task.repo);
      if (repo) {
        try {
          await this.deps.git.removeLegacyWorktree(repo, wt.path, `${task.title} (moved off worktree)`, identityOf(repo, settings));
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

  /** Stops every run. `resume`: they run again on the next start (the app is restarting for an update). */
  async shutdown(opts: { resume?: boolean } = {}): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (opts.resume && this.live.size > 0) {
      const ids = new Set(this.live.keys());
      await this.stores.queue
        .update((q) => {
          for (const t of q.tasks) if (ids.has(t.id)) t.resumeOnStart = true;
        })
        .catch(() => {});
    }
    await Promise.all([...this.live.values()].map((run) => run.handle.cancel().catch(() => {})));
    await this.stores.activity.close().catch(() => {});
  }

  /** Lets the scheduler wait for a commit-graph action (pull, rebase…) in a repo before starting a task there. */
  useRepoActionLock(inFlight: (repoId: string) => boolean): void {
    this.repoActionInFlight = inFlight;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** Repos (main and extra) in a running or starting task right now. */
  busyRepoIds(): Set<string> {
    return new Set([...[...this.live.values()].flatMap((r) => r.repos), ...[...this.starting.values()].flat()]);
  }

  /** The running or starting task that uses the account (runs on it, or resumes a session from it). */
  taskUsingAccount(accountId: string): string | null {
    for (const [taskId, ids] of this.heldAccounts) if (ids.includes(accountId)) return taskId;
    return null;
  }

  /** The queue as the app shows it: tasks on a hidden repo (Settings → Security) are left out. */
  async list(): Promise<TaskView[]> {
    const { tasks } = await this.stores.queue.read();
    const hidden = await readHidden(this.stores);
    return tasks
      .filter((t) => !hiddenRepoOf(t, hidden))
      .map((t) => ({ ...shownTask(t, hidden), waitingNote: t.status === "pending" ? (this.waitingNotes.get(t.id) ?? null) : null }));
  }

  /** Status lines and notifications of a task on a hidden repo aren't sent to the page. */
  private async quiet(task: Pick<Task, "repo" | "extraRepos">): Promise<boolean> {
    return hiddenRepoOf(task, await readHidden(this.stores)) !== null;
  }

  private async getTask(id: string): Promise<Task> {
    const task = (await this.stores.queue.read()).tasks.find((t) => t.id === id);
    if (!task) throw notFound(`Task "${id}" is not in the queue.`);
    return task;
  }

  replay(taskId: string): OutputBuffer {
    return this.buffers.get(taskId) ?? newBuffer();
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
    let removed: Task | undefined;
    await this.stores.queue.update((q) => {
      removed = q.tasks.find((t) => t.id === id);
      q.tasks = q.tasks.filter((t) => t.id !== id);
    });
    this.buffers.delete(id);
    this.waitingNotes.delete(id);
    if (removed) void this.releaseAttachments(removed);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async create(req: CreateTaskRequest): Promise<TaskView> {
    const message = req.message ?? "";
    if (!message.trim() && !req.attachmentIds?.length) throw badRequest("The task message is empty. Type a message or attach a file.");
    const repo = await this.deps.repos.get(req.repo);
    const override = req.accountOverride || null;
    const draft = req.draft === true;
    if (override && (await this.deps.accounts.get(override)).hidden) throw notFound(`No account "${override}".`);
    if (req.replacesDraft !== undefined && (await this.getTask(req.replacesDraft)).status !== "draft") {
      throw conflict(`Task "${req.replacesDraft}" is not a draft.`);
    }
    // A draft never runs, so it doesn't need an account yet.
    if (!draft && !override && repo.accountChain.length === 0) {
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

    // An attachments-only task is titled after its files.
    const firstLine = message.trim().split("\n")[0] || attachments.map((a) => a.name).join(", ");
    const title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    const slug = slugify(firstLine.split(/\s+/).slice(0, 6).join(" ")) || "task";

    let task: Task | undefined;
    let replacedDraft: Task | undefined;
    await this.stores.queue.update((q) => {
      const replaced = req.replacesDraft;
      if (replaced !== undefined && !q.tasks.some((t) => t.id === replaced && t.status === "draft")) {
        throw conflict(`Task "${replaced}" is not a draft.`);
      }
      const id = `task_${String(q.nextTaskNumber).padStart(4, "0")}_${slug}`;
      q.nextTaskNumber += 1;
      const stamp = this.stamp();
      task = {
        id,
        title,
        repo: repo.id,
        extraRepos,
        status: draft ? "draft" : "pending",
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
        fallbacks: 0,
        resumeOnStart: false,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const at = replaced === undefined ? -1 : q.tasks.findIndex((t) => t.id === replaced);
      replacedDraft = at === -1 ? undefined : q.tasks[at];
      // A saved-again draft keeps its place; a queued one goes to the back like any new task.
      if (at !== -1 && draft) q.tasks.splice(at, 1, task);
      else {
        if (at !== -1) q.tasks.splice(at, 1);
        q.tasks.push(task);
      }
    });
    const created = task as Task;
    if (req.replacesDraft !== undefined) this.waitingNotes.delete(req.replacesDraft);
    // Files the edited draft no longer has (the ones it kept are in use by the new task).
    if (replacedDraft) void this.releaseAttachments(replacedDraft);
    if (draft) {
      // Nothing started, so nothing to log; it shows up in activity once it's queued.
      await this.publish();
      return { ...created, waitingNote: null };
    }
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
    const hidden = await readHidden(this.stores);
    await this.stores.queue.update((q) => {
      // Pending tasks the page didn't list (those on a hidden repo) keep their places.
      const listed = new Set(ids);
      const rest = q.tasks.filter((t) => t.status === "pending" && !listed.has(t.id) && !hiddenRepoOf(t, hidden)).map((t) => t.id);
      q.tasks = reorderWithin(q.tasks, [...ids, ...rest], (t) => t.id, (t) => t.status === "pending");
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
    // Checked inside the update, so two quick clicks can't both pass.
    const task = await this.updateTask(id, (t) => {
      if (t.status !== "interrupted" && t.status !== "needs-review") {
        throw conflict(`Only interrupted or needs-review tasks can be retried (this one is ${t.status}).`);
      }
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
    if (!message.trim() && attachmentIds.length === 0) throw badRequest("The reply is empty. Type a message or attach a file.");
    const canReply = (t: Task) => (t.status === "needs-review" || t.status === "interrupted") && !!t.session;
    const refused = () => conflict("You can reply to a task once it's waiting for review or was stopped after its session started.");
    if (!canReply(await this.getTask(id))) throw refused();
    const attachments = await this.deps.attachments.resolve(attachmentIds);
    const promptIds = await this.deps.prompts.validate(promptIdsIn);
    // Checked again inside the update: a second quick reply finds the task pending and is refused
    // instead of overwriting the first.
    const task = await this.updateTask(id, (t) => {
      if (!canReply(t)) throw refused();
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
    let task: Task | undefined;
    await this.stores.queue.update((q) => {
      task = q.tasks.find((t) => t.id === id);
      if (!task) throw notFound(`Task "${id}" is not in the queue.`);
      if (task.status !== "needs-review" && task.status !== "interrupted") {
        throw conflict(`This task is ${task.status}; only a task waiting for review or interrupted can be marked finished.`);
      }
      q.tasks = q.tasks.filter((t) => t.id !== id);
    });
    this.buffers.delete(id);
    this.waitingNotes.delete(id);
    if (!task) return;
    this.log({ taskId: id, repo: task.repo, account: task.currentAccount, event: "marked-finished", detail: "Marked finished." });
    void this.releaseAttachments(task);
    this.deps.broadcaster.taskStatus(id, "done", "Marked finished");
    await this.publish();
  }

  /** Remove a task from the queue in any state. A running task is stopped first. The repo is left as it is. */
  async discard(id: string): Promise<void> {
    let task = await this.getTask(id);
    if (task.status === "draft") {
      // Never queued or logged: it just goes.
      await this.removeTask(id);
      await this.publish();
      return;
    }
    const wasRunning = task.status === "running";
    if (wasRunning) task = await this.stopForDiscard(id);
    await this.removeTask(id);
    // A run that attached while the task was being removed: stop it (finishRun finds no task and lets it go).
    const late = this.live.get(id);
    if (late) {
      late.cancelRequested = true;
      await late.handle.cancel().catch(() => {});
    }
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

  /** Every ended task, newest first, rebuilt only when the activity log's `historyVersion` moves. */
  private historyCache: { version: number; items: HistoryItem[] } | null = null;

  async history(): Promise<HistoryItem[]> {
    const inQueue = new Set((await this.stores.queue.read()).tasks.map((t) => t.id));
    const items = shownHistory(this.endedTasks(), await readHidden(this.stores));
    return inQueue.size === 0 ? [...items] : items.filter((item) => !inQueue.has(item.taskId));
  }

  private endedTasks(): HistoryItem[] {
    const activity = this.stores.activity;
    if (this.historyCache?.version === activity.historyVersion) return this.historyCache.items;
    const outcomes: Record<string, HistoryItem["outcome"]> = {
      kept: "done",
      pushed: "done",
      "marked-finished": "done",
      discarded: "discarded",
      failed: "failed",
      cancelled: "cancelled",
    };
    // From the activity log's in-memory summaries: no re-reading every activity file per page.
    const items: HistoryItem[] = [];
    for (const s of activity.taskSummaries()) {
      // Ask-mode chats aren't tasks (they never log an ending, but older or hand-made entries might).
      if (!s.terminal || s.taskId.startsWith("ask_")) continue;
      items.push({
        taskId: s.taskId,
        title: String(s.queued?.title ?? s.taskId),
        repo: s.terminal.repo,
        message: String(s.queued?.message ?? ""),
        outcome: outcomes[s.terminal.event] as HistoryItem["outcome"],
        lastAccount: s.lastAccount,
        branch: ((s.started?.ref ?? s.started?.branch) as string | undefined) ?? null,
        queuedAt: s.firstAt,
        endedAt: s.terminal.at,
      });
    }
    items.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
    this.historyCache = { version: activity.historyVersion, items };
    return items;
  }

  /** One page of history (newest first), for the History page's lazy loading. */
  async historyPage(offset: number, limit: number): Promise<HistoryPage> {
    const all = await this.history();
    const items = all.slice(offset, offset + limit);
    const next = offset + items.length;
    return { items, total: all.length, nextOffset: items.length > 0 && next < all.length ? next : null };
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
    const hidden = await readHidden(this.stores);
    const now = this.now();

    let running = this.live.size + [...this.starting.keys()].filter((id) => !this.live.has(id)).length;
    const busyRepos = this.busyRepoIds();
    const notes = new Map<string, string>();
    let wakeAt: number | null = null;

    for (const task of tasks) {
      if (task.status !== "pending") continue;
      // A hidden repo (Settings → Security): its tasks wait until it is shown again.
      const hiddenRepo = hiddenRepoOf(task, hidden);
      if (hiddenRepo) {
        notes.set(task.id, `Waiting until ${hiddenRepo} is shown again (Settings → Security).`);
        continue;
      }
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
      // A pull, rebase… clicked in the commit graph: the task starts once it's done (RepoActions calls tick).
      // Nothing awaits between this check and startRun holding the repos, so a click can't slip in.
      const acting = taskRepos.find((id) => this.repoActionInFlight(id));
      if (acting) {
        notes.set(task.id, acting === task.repo ? "Waiting for a git action on this repo to finish." : `Waiting for a git action on ${acting} to finish.`);
        continue;
      }
      const isReply = task.pendingReply !== null && task.session !== null;
      const pick = pickAccount({
        // Hidden accounts are skipped, as if they weren't in the chain.
        candidates: [task.accountOverride, ...repo.accountChain].filter((a): a is string => !!a && !hidden.accounts.has(a)),
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
      // Being deleted (logout + folder removal in progress): nothing awaits between this and startRun.
      const usedAccounts = this.accountsFor(task, pick.account, isReply);
      if (usedAccounts.some((id) => this.deps.accounts.isRemoving(id))) {
        notes.set(task.id, "Waiting for an account being deleted.");
        continue;
      }
      running += 1;
      for (const id of taskRepos) busyRepos.add(id);
      await this.startRun(task, repo, pick.account, isReply, taskRepos, usedAccounts);
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

  /** The account a run uses, plus (for a reply) the one its session was recorded on. */
  private accountsFor(task: Task, account: Account, isReply: boolean): string[] {
    const from = isReply ? task.session?.account : undefined;
    return from && from !== account.id ? [account.id, from] : [account.id];
  }

  private async startRun(
    task: Task,
    repo: Repo,
    account: Account,
    isReply: boolean,
    taskRepos: string[],
    usedAccounts: string[],
  ): Promise<void> {
    // Held before the first await: a graph action clicked (or an account deleted) while the task starts is refused.
    this.starting.set(task.id, taskRepos);
    this.heldAccounts.set(task.id, usedAccounts);
    try {
      await this.launch(task, repo, account, isReply);
    } finally {
      this.starting.delete(task.id);
      // Never spawned: free its accounts (unless a newer run of the task, e.g. a fallback, holds them now).
      if (!this.live.has(task.id) && this.heldAccounts.get(task.id) === usedAccounts) this.heldAccounts.delete(task.id);
    }
  }

  private async launch(task: Task, repo: Repo, account: Account, isReply: boolean): Promise<void> {
    const settings = await this.stores.settings.read();
    const buffer: OutputBuffer = isReply ? (this.buffers.get(task.id) ?? newBuffer()) : newBuffer();
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

      // The prompts' current text, read now (like the base prompts). A reply's session already has the
      // repo prompts: they're still read for their attached files, which stay readable.
      const boundIds = isReply ? (task.replies.at(-1)?.promptIds ?? []) : task.promptIds;
      const repoPromptList = await this.deps.repos.prompts(repo.id);
      const repoPrompts: ResolvedRepoPrompts[] = [
        { repo: repo.id, ...(await repoPromptList.resolve(task.repoPromptIds ?? (await repoPromptList.defaultIds()))) },
      ];
      for (const x of extras) {
        repoPrompts.push({ repo: x.repo.id, ...(await (await this.deps.repos.prompts(x.repo.id)).resolve(x.promptIds)) });
      }
      const inputs: RunInputs = {
        task,
        isReply,
        extras,
        globalBase: isReply ? "" : await this.deps.assembler.globalBase(),
        bound: await this.deps.prompts.resolve(boundIds),
        repoPrompts,
        earlierBound: isReply
          ? (await this.deps.prompts.resolve([task.promptIds, ...task.replies.map((r) => r.promptIds)].flat())).prompts
          : [],
      };
      // Attached files: on this Mac they're read in place; for a remote repo they're copied to the server.
      const located = await this.deps.attachments.locate(repo.host ?? null, runFiles(inputs).allFiles);
      const plan = planRun(inputs, located);
      for (const detail of plan.warnings) {
        this.log({ taskId: task.id, repo: repo.id, account: account.id, event: "warning", detail });
      }
      const { assembled, repoSent } = plan;
      const { bound } = inputs;

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
      // Discarded (or otherwise taken off running) while it was starting: don't spawn a run nobody can see.
      const still = (await this.stores.queue.read()).tasks.find((t) => t.id === task.id);
      if (still?.status !== "running") {
        void this.tick(); // its repos are free again
        return;
      }
      const handle = adapter.run(
        {
          ...this.deps.accounts.context(account),
          prompt: assembled.prompt,
          cwd: repo.path,
          resume,
          addDirs: plan.addDirs,
          gitIdentity: identityOf(repo, settings),
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
      const sent = plan.sent;
      pushCapped(buffer.events, sent);
      this.deps.broadcaster.taskEvent(task.id, sent);
      handle.onStream((event) => this.onEvent(run, event, buffer));
      handle.onRaw((raw) => {
        pushRawCapped(buffer, raw);
        this.deps.broadcaster.taskRaw(task.id, raw);
      });
      if (!(await this.quiet(task))) this.deps.broadcaster.taskStatus(task.id, "running", `Running on ${account.id}`);
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
    // Tokens of one reply are kept as a single text-delta, so a task's replay (sent when its view
    // opens) is a few hundred events rather than one per token, and the cap keeps far more history.
    const last = buffer.events.at(-1);
    if (event.kind === "text-delta" && last?.kind === "text-delta") {
      buffer.events[buffer.events.length - 1] = { ...last, text: last.text + event.text };
    } else {
      pushCapped(buffer.events, event);
    }
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
    this.heldAccounts.delete(run.taskId);
    const task = (await this.stores.queue.read()).tasks.find((t) => t.id === run.taskId);
    if (!task) {
      void this.tick(); // discarded while it ran: its repos are free again
      return;
    }
    const account = run.account;
    const base = { taskId: task.id, repo: task.repo, account: account.id };
    const repo = (await this.deps.repos.list()).find((r) => r.id === task.repo);
    // The entry that ends the run carries its token usage, for the Statistics page.
    const usage = result.usage ? { usage: result.usage } : {};
    const hidden = await readHidden(this.stores);
    // A task on a repo that was hidden while it ran: it ends as usual, but the page isn't told.
    const quiet = hiddenRepoOf(task, hidden) !== null;

    switch (result.outcome) {
      case "success": {
        await this.updateTask(task.id, (t) => {
          t.status = "needs-review";
          t.pendingReply = null;
          t.fallbacks = 0;
          t.session = result.sessionId ? { provider: account.provider, account: account.id, sessionId: result.sessionId } : t.session;
        });
        this.log({
          ...base,
          event: "finished",
          detail: `Finished on ${account.id}. Ready for review.`,
          data: { result: result.resultText, costUsd: result.costUsd, ...usage },
        });
        if (!quiet) {
          this.deps.broadcaster.taskStatus(task.id, "needs-review", "Ready for review");
          this.deps.broadcaster.notify(task.id, "Task ready for review", task.title);
        }
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
            data: { resetsAt: result.limit.resetsAt, limitedUntil: view.limitedUntil, ...usage },
          });
        } else {
          await this.deps.accounts.markLoggedOut(account.id);
          this.log({ ...base, event: "warning", detail: `${account.id} is logged out (${reason}). Log in again on the Settings page.`, data: usage });
        }

        // Each account in the chain gets two goes (one more after its cooldown), then the task stops
        // here instead of being re-run forever: the failure may only have looked like a limit.
        const candidates = [task.accountOverride, ...(repo?.accountChain ?? [])].filter((a): a is string => !!a && !hidden.accounts.has(a));
        const maxFallbacks = MAX_FALLBACKS_PER_ACCOUNT * Math.max(1, new Set(candidates).size);
        if (task.fallbacks + 1 >= maxFallbacks) {
          const what = result.outcome === "limit" ? "a usage limit" : "a logged-out account";
          await this.failRun(
            task,
            run,
            `Stopped after ${maxFallbacks} runs that ended on ${what} (last: ${account.id}, ${reason}).`,
            usage,
          );
          break;
        }

        // Fresh runs start over on the next account (the repo is left as it is); replies keep their
        // session and wait for a same-CLI account.
        await this.updateTask(task.id, (t) => {
          t.status = "pending";
          t.currentAccount = null;
          t.fallbacks += 1;
          if (!run.isReply) t.session = null;
        });

        const next = repo
          ? pickAccount({
              candidates,
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
        if (!quiet) this.deps.broadcaster.taskStatus(task.id, "pending", `${account.id} ${what}`);
        break;
      }

      case "cancelled": {
        await this.updateTask(task.id, (t) => {
          t.status = "interrupted";
          t.fallbacks = 0;
          // Keep the session (a stopped first run has one once the CLI started it) so you can reply.
          if (result.sessionId) t.session = { provider: account.provider, account: account.id, sessionId: result.sessionId };
        });
        this.log({
          ...base,
          event: "cancelled",
          detail: task.resumeOnStart ? "Stopped to restart for an update; it runs again when the app is back." : "Stopped by you. Retry or discard it.",
          data: usage,
        });
        if (!quiet) this.deps.broadcaster.taskStatus(task.id, "interrupted", "Stopped");
        break;
      }

      case "failed": {
        await this.failRun(task, run, result.message, { exitCode: result.exitCode, stderrTail: result.stderrTail, ...usage });
        break;
      }
    }

    await this.publish();
    void this.tick();
  }

  /** A failed reply goes back to review (the earlier work stays); a failed first run leaves the queue. */
  private async failRun(task: Task, run: LiveRun, message: string, data: Record<string, unknown>): Promise<void> {
    const base = { taskId: task.id, repo: task.repo, account: run.account.id };
    const quiet = await this.quiet(task);
    if (run.isReply) {
      await this.updateTask(task.id, (t) => {
        t.status = "needs-review";
        t.pendingReply = null;
        t.fallbacks = 0;
      });
      this.log({ ...base, event: "warning", detail: `Reply run failed: ${message}`, data });
      if (!quiet) this.deps.broadcaster.taskStatus(task.id, "needs-review", `Reply failed: ${message}`);
    } else {
      await this.removeTask(task.id);
      this.log({ ...base, event: "failed", detail: message.slice(0, 500), data });
      if (!quiet) this.deps.broadcaster.taskStatus(task.id, "failed", message);
    }
    if (!quiet) this.deps.broadcaster.notify(task.id, "Task failed", `${task.title}: ${message.slice(0, 140)}`);
  }
}

/** Files in first-seen order, each once (two prompts may share a screenshot). */
