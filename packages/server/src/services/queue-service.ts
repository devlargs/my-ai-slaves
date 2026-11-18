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
import type { RepoService } from "./repo-service";
import type { WorktreeService } from "./worktree-service";

const LIVE_BUFFER_LIMIT = 5000;
const MAX_TIMER_MS = 60 * 60 * 1000;

interface LiveRun {
  taskId: string;
  repo: string;
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
  worktrees: WorktreeService;
  assembler: PromptAssembler;
  adapters: AdapterRegistry;
  broadcaster: Broadcaster;
  attachments: AttachmentStore;
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
 * - Usage limit / logged out mid-run → mark the account, reset the worktree, re-run the same prompt on
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
        status: "pending",
        message,
        attachments,
        accountOverride: override,
        currentAccount: null,
        worktree: null,
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
      data: { title: created.title, message, accountOverride: override, attachments },
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
      if (task.worktree) await this.deps.worktrees.remove(await this.deps.repos.get(task.repo), task.worktree, { deleteBranch: true });
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
    if (task.worktree) await this.deps.worktrees.reset(task.worktree);
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

  async reply(id: string, message: string, attachmentIds: string[] = []): Promise<void> {
    if (!message.trim()) throw badRequest("The reply is empty.");
    const task = await this.getTask(id);
    if (task.status !== "needs-review" || !task.session) {
      throw conflict("You can reply to a task once it's finished a run and is waiting for review.");
    }
    const attachments = await this.deps.attachments.resolve(attachmentIds);
    await this.updateTask(id, (t) => {
      t.replies.push({ at: this.stamp(), message, attachments });
      t.pendingReply = message;
      t.status = "pending";
    });
    this.log({ taskId: id, repo: task.repo, account: null, event: "reply", detail: preview(message, 200), data: { message, attachments } });
    await this.publish();
    void this.tick();
  }

  // ── review actions ───────────────────────────────────────────────────────

  private async reviewable(id: string): Promise<{ task: Task; repo: Repo; wt: NonNullable<Task["worktree"]> }> {
    const task = await this.getTask(id);
    if (task.status !== "needs-review" && task.status !== "interrupted") {
      throw conflict(`This task is ${task.status}; review actions need a finished or interrupted task.`);
    }
    if (!task.worktree) throw conflict("This task has no worktree yet.");
    return { task, repo: await this.deps.repos.get(task.repo), wt: task.worktree };
  }

  async diff(id: string): Promise<DiffResponse> {
    const task = await this.getTask(id);
    if (!task.worktree) throw conflict("This task has no worktree yet.");
    const wt = task.worktree;
    return { patch: await this.deps.worktrees.diff(wt), branch: wt.branch, baseBranch: wt.baseBranch, baseCommit: wt.baseCommit, worktreePath: wt.path };
  }

  async keep(id: string): Promise<void> {
    const { task, repo, wt } = await this.reviewable(id);
    await this.deps.worktrees.commitLeftovers(wt, task.title, identityOf(repo));
    await this.deps.worktrees.stripAiTrailers(wt);
    await this.deps.worktrees.remove(repo, wt, { deleteBranch: false });
    await this.removeTask(id);
    this.log({ taskId: id, repo: task.repo, account: task.currentAccount, event: "kept", detail: `Kept branch ${wt.branch}`, data: { branch: wt.branch } });
    this.deps.broadcaster.taskStatus(id, "done", `Kept branch ${wt.branch}`);
    await this.publish();
  }

  async push(id: string): Promise<PushResponse> {
    const { task, repo, wt } = await this.reviewable(id);
    await this.deps.worktrees.commitLeftovers(wt, task.title, identityOf(repo));
    await this.deps.worktrees.stripAiTrailers(wt);
    const result = await this.deps.worktrees.push(wt, task.title);
    await this.deps.worktrees.remove(repo, wt, { deleteBranch: false });
    await this.removeTask(id);
    this.log({
      taskId: id,
      repo: task.repo,
      account: task.currentAccount,
      event: "pushed",
      detail: result.url ? `Pushed ${wt.branch}: ${result.url}` : `Pushed ${wt.branch}`,
      data: { branch: wt.branch, url: result.url, output: result.output },
    });
    this.deps.broadcaster.taskStatus(id, "done", `Pushed ${wt.branch}`);
    await this.publish();
    return result;
  }

  async discard(id: string): Promise<void> {
    const task = await this.getTask(id);
    if (task.status === "running") throw conflict("Cancel the task before discarding it.");
    if (task.worktree) await this.deps.worktrees.remove(await this.deps.repos.get(task.repo), task.worktree, { deleteBranch: true });
    await this.removeTask(id);
    this.log({ taskId: id, repo: task.repo, account: task.currentAccount, event: "discarded", detail: "Worktree and branch removed." });
    this.deps.broadcaster.taskStatus(id, "done", "Discarded");
    await this.publish();
    void this.tick();
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
    const busyRepos = new Set([...this.live.values()].map((r) => r.repo));
    const notes = new Map<string, string>();
    let wakeAt: number | null = null;

    for (const task of tasks) {
      if (task.status !== "pending") continue;
      if (running >= settings.maxParallelTasks) {
        notes.set(task.id, `Waiting for a free slot (${running} of ${settings.maxParallelTasks} running).`);
        continue;
      }
      if (busyRepos.has(task.repo)) {
        notes.set(task.id, "Waiting for the other task on this repo to finish.");
        continue;
      }
      const repo = repos.find((r) => r.id === task.repo);
      if (!repo) {
        notes.set(task.id, `Repo "${task.repo}" is no longer registered.`);
        continue;
      }
      const isReply = task.pendingReply !== null && task.session !== null;
      const pick = pickAccount({
        candidates: [task.accountOverride, ...repo.accountChain].filter((a): a is string => !!a),
        accounts,
        now,
        provider: isReply ? task.session?.provider : undefined,
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
      busyRepos.add(task.repo);
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

  // ── running ──────────────────────────────────────────────────────────────

  private async startRun(task: Task, repo: Repo, account: Account, isReply: boolean): Promise<void> {
    const settings = await this.stores.settings.read();
    const buffer: OutputBuffer = isReply ? (this.buffers.get(task.id) ?? { events: [], raw: [] }) : { events: [], raw: [] };
    this.buffers.set(task.id, buffer);

    try {
      await this.updateTask(task.id, (t) => {
        t.status = "running";
        t.currentAccount = account.id;
      });
      let wt = task.worktree;
      if (!wt) {
        wt = await this.deps.worktrees.create(repo, task.id);
        const created = wt;
        await this.updateTask(task.id, (t) => {
          t.worktree = created;
        });
      }

      const store = this.deps.attachments;
      const runFiles = isReply ? (task.replies.at(-1)?.attachments ?? []) : task.attachments;
      const runPaths = runFiles.map((a) => store.pathOf(a));
      // The session may refer back to earlier files, so every file of the task stays readable.
      const addDirs = [...task.attachments, ...task.replies.flatMap((r) => r.attachments)].map((a) => store.dirOf(a.id));
      const assembled = isReply
        ? this.deps.assembler.forReply(task.pendingReply ?? "", runPaths)
        : await this.deps.assembler.forTask(repo.id, task.message, runPaths);

      let resume: { sessionId: string; fromConfigDir: string } | null = null;
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
        data: { prompt: assembled.prompt, kind: isReply ? "reply" : "fresh", branch: wt.branch, worktree: wt.path, layers: assembled.layers },
      });

      const adapter = this.deps.adapters[account.provider];
      await adapter.prepare?.(this.deps.accounts.context(account), settings);
      const handle = adapter.run(
        {
          ...this.deps.accounts.context(account),
          prompt: assembled.prompt,
          cwd: wt.path,
          resume,
          addDirs: [...new Set(addDirs)],
          gitIdentity: identityOf(repo),
        },
        settings,
      );
      const run: LiveRun = { taskId: task.id, repo: repo.id, account, handle, isReply, cancelRequested: false };
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
      // Couldn't even start (worktree/base branch problems). Treat as a failed run.
      this.live.delete(task.id);
      await this.finishRun(
        { taskId: task.id, repo: repo.id, account, handle: null as never, isReply, cancelRequested: false },
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
        if (!run.isReply && task.worktree) await this.deps.worktrees.reset(task.worktree);
        await this.updateTask(task.id, (t) => {
          t.status = "pending";
          t.currentAccount = null;
          if (!run.isReply) t.session = null;
        });

        const repo = (await this.deps.repos.list()).find((r) => r.id === task.repo);
        const next = repo
          ? pickAccount({
              candidates: [task.accountOverride, ...repo.accountChain].filter((a): a is string => !!a),
              accounts: await this.deps.accounts.listRaw(),
              now: this.now(),
              provider: run.isReply ? task.session?.provider : undefined,
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
          const repo = (await this.deps.repos.list()).find((r) => r.id === task.repo);
          if (repo && task.worktree) await this.deps.worktrees.remove(repo, task.worktree, { deleteBranch: true });
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
