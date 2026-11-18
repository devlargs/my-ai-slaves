/**
 * One WebSocket at /ws (same origin). JSON text frames.
 */
import type { AccountView, LoginState, TaskView } from "./api";
import type { QueuedTaskStatus } from "./schemas/queue";
import type { RawLine, StreamEvent } from "./stream";

export type ClientMessage =
  | { type: "subscribe"; topic: "queue" | "accounts" }
  | { type: "subscribe"; topic: "task"; taskId: string }
  | { type: "unsubscribe"; topic: "task"; taskId: string };

export type ServerMessage =
  | { type: "queue.updated"; tasks: TaskView[] }
  | { type: "accounts.updated"; accounts: AccountView[] }
  /** Progress of an in-app login (sent to `accounts` subscribers). */
  | { type: "login.updated"; login: LoginState }
  /** Sent right after subscribing to a task: everything streamed so far. */
  | { type: "task.replay"; taskId: string; events: StreamEvent[]; raw: RawLine[] }
  | { type: "task.event"; taskId: string; event: StreamEvent }
  | { type: "task.raw"; taskId: string; raw: RawLine }
  | { type: "task.status"; taskId: string; status: QueuedTaskStatus | "done" | "failed"; detail: string | null }
  /** Show a browser notification. */
  | { type: "notify"; taskId: string; title: string; body: string };
