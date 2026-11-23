import { z } from "zod";
import { Attachment } from "./attachment";
import { ProviderId, Timestamp, timestampNow } from "./common";

/** `draft`: saved from the composer to finish later; never runs (clicking it loads it back into the composer). */
export const QueuedTaskStatus = z.enum(["draft", "pending", "running", "needs-review", "interrupted"]);
export type QueuedTaskStatus = z.infer<typeof QueuedTaskStatus>;

/** Statuses a task can have anywhere (done/failed only exist in activity history). */
export const TaskStatus = z.enum([...QueuedTaskStatus.options, "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Where the repo's checkout was when the task started (read-only: the app never switches branches).
 * Its diff shows what changed since.
 */
export const TaskCheckout = z.object({
  /** The branch that was checked out (or the commit, when detached). */
  ref: z.string().min(1),
  commit: z.string().min(1),
});

/** Legacy: the `ai/<task-id>` branch older versions created. Only read (diff); never touched. */
export const TaskBranch = z.object({
  /** `ai/<task-id>` */
  name: z.string().min(1),
  /** The repo's base branch it was created from. */
  base: z.string().min(1),
  baseCommit: z.string().min(1),
  /** The branch (or commit) that was checked out before the last run; checked out again after it. */
  returnTo: z.string().nullable().default(null),
});

/** Old worktree record, only read once on startup to move the task onto its branch. */
export const LegacyTaskWorktree = z.object({
  path: z.string(),
  branch: z.string(),
  baseBranch: z.string(),
  baseCommit: z.string(),
});

export const TaskSession = z.object({
  provider: ProviderId,
  account: z.string(),
  sessionId: z.string(),
});

/**
 * Another repo opened in the same run (cross-repo work), as it is: the app never creates, switches or
 * commits branches there. Its ticked prompts are sent and say how to handle changes in it.
 */
export const TaskExtraRepo = z.object({
  repo: z.string(),
  /** That repo's prompts ticked for this task (ids from knowledge/<repo>.json), sent in its order. */
  promptIds: z.array(z.string()).default([]),
});

export const TaskReply = z.object({
  at: Timestamp,
  message: z.string(),
  attachments: z.array(Attachment).default([]),
  /** Saved prompts bound to this reply (ids from prompts.json). */
  promptIds: z.array(z.string()).default([]),
});

export const Task = z.object({
  id: z.string().regex(/^task_\d{4,}_[a-z0-9-]*$/),
  title: z.string(),
  /** The main repo: the CLI runs in it, with its account chain and repo prompts. */
  repo: z.string(),
  /** Other repos on the same machine the run can reach, opened as they are (no branch handling). */
  extraRepos: z.array(TaskExtraRepo).default([]),
  status: QueuedTaskStatus,
  message: z.string(),
  /** Files attached to the task message. */
  attachments: z.array(Attachment).default([]),
  /** Saved prompts bound to the task message (ids from prompts.json), sent in library order. */
  promptIds: z.array(z.string()).default([]),
  /**
   * The repo's prompts ticked for this task (ids from knowledge/<repo>.json), sent in the repo's order.
   * null = queued before repos had several prompts: the repo's default prompts are sent.
   */
  repoPromptIds: z.array(z.string()).nullable().default(null),
  accountOverride: z.string().nullable().default(null),
  currentAccount: z.string().nullable().default(null),
  /** Where the checkout was when the task's first run started. */
  checkout: TaskCheckout.nullable().default(null),
  /** Legacy (older versions created an ai/ branch per task); kept only so its diff can be shown. */
  branch: TaskBranch.nullable().default(null),
  /** Legacy (pre-branch) field; migrated and removed on startup. */
  worktree: LegacyTaskWorktree.nullable().optional(),
  session: TaskSession.nullable().default(null),
  replies: z.array(TaskReply).default([]),
  /** A reply waiting to be sent to the existing CLI session (status is pending while set). */
  pendingReply: z.string().nullable().default(null),
  /**
   * Usage-limit / logged-out fallbacks since the task last finished a run. Capped (see QueueService)
   * so a run whose failure only looks like a limit can't be re-run on every account forever.
   */
  fallbacks: z.int().min(0).default(0),
  /** Set when the app quit for an update mid-run: the run starts again when the app is back. */
  resumeOnStart: z.boolean().default(false),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type Task = z.infer<typeof Task>;

export const QueueFile = z.object({
  nextTaskNumber: z.int().min(1).default(1),
  tasks: z.array(Task).default([]),
});
export type QueueFile = z.infer<typeof QueueFile>;
