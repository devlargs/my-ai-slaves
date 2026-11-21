/**
 * One WebSocket at /ws (same origin). JSON text frames.
 */
import type { AccountView, LoginState, TaskView } from "./api";
import type { QueuedTaskStatus } from "./schemas/queue";
import type { RawLine, StreamEvent } from "./stream";

export type ClientMessage =
  | { type: "subscribe"; topic: "queue" | "accounts" }
  | { type: "subscribe"; topic: "task"; taskId: string }
  | { type: "unsubscribe"; topic: "task"; taskId: string }
  /**
   * The raw CLI lines of a task, only while its "Raw output" view is open: they are most of what a
   * run sends (every token and tool chunk is a line), and nothing else shows them.
   */
  | { type: "subscribe"; topic: "task-raw"; taskId: string }
  | { type: "unsubscribe"; topic: "task-raw"; taskId: string };

export type ServerMessage =
  | { type: "queue.updated"; tasks: TaskView[] }
  | { type: "accounts.updated"; accounts: AccountView[] }
  /** Progress of an in-app login (sent to `accounts` subscribers). */
  | { type: "login.updated"; login: LoginState }
  /** Sent right after subscribing to a task: everything streamed so far. */
  | { type: "task.replay"; taskId: string; events: StreamEvent[] }
  | { type: "task.event"; taskId: string; event: StreamEvent }
  /** Sent right after subscribing to a task's raw lines: the ones kept so far. */
  | { type: "task.raw-replay"; taskId: string; raw: RawLine[] }
  /** One new raw line, to `task-raw` subscribers only. */
  | { type: "task.raw"; taskId: string; raw: RawLine }
  | { type: "task.status"; taskId: string; status: QueuedTaskStatus | "done" | "failed"; detail: string | null }
  /** Show a browser notification. */
  | { type: "notify"; taskId: string; title: string; body: string };
