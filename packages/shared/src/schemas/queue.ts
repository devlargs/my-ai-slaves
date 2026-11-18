import { z } from "zod";
import { ProviderId, Timestamp, timestampNow } from "./common";

export const QueuedTaskStatus = z.enum(["pending", "running", "needs-review", "interrupted"]);
export type QueuedTaskStatus = z.infer<typeof QueuedTaskStatus>;

/** Statuses a task can have anywhere (done/failed only exist in activity history). */
export const TaskStatus = z.enum([...QueuedTaskStatus.options, "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskWorktree = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  baseCommit: z.string().min(1),
});

export const TaskSession = z.object({
  provider: ProviderId,
  account: z.string(),
  sessionId: z.string(),
});

export const TaskReply = z.object({
  at: Timestamp,
  message: z.string(),
});

export const Task = z.object({
  id: z.string().regex(/^task_\d{4,}_[a-z0-9-]*$/),
  title: z.string(),
  repo: z.string(),
  status: QueuedTaskStatus,
  message: z.string(),
  accountOverride: z.string().nullable().default(null),
  currentAccount: z.string().nullable().default(null),
  worktree: TaskWorktree.nullable().default(null),
  session: TaskSession.nullable().default(null),
  replies: z.array(TaskReply).default([]),
  /** A reply waiting to be sent to the existing CLI session (status is pending while set). */
  pendingReply: z.string().nullable().default(null),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type Task = z.infer<typeof Task>;

export const QueueFile = z.object({
  nextTaskNumber: z.int().min(1).default(1),
  tasks: z.array(Task).default([]),
});
export type QueueFile = z.infer<typeof QueueFile>;
