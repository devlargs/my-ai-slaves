import type { AccountView, AskChatView, QueuedTaskStatus, RawLine, StreamEvent, TaskView } from "@my-ai-slaves/shared";

/** Thrown by services; the HTTP layer turns it into `{ error }` with this status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m: string) => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Everything services push to connected browsers. */
export interface Broadcaster {
  queueUpdated(tasks: TaskView[]): void;
  askUpdated(chats: AskChatView[]): void;
  accountsUpdated(accounts: AccountView[]): void;
  taskEvent(taskId: string, event: StreamEvent): void;
  taskRaw(taskId: string, raw: RawLine): void;
  taskStatus(taskId: string, status: QueuedTaskStatus | "done" | "failed", detail: string | null): void;
  notify(taskId: string, title: string, body: string): void;
}

export const nullBroadcaster: Broadcaster = {
  queueUpdated: () => {},
  askUpdated: () => {},
  accountsUpdated: () => {},
  taskEvent: () => {},
  taskRaw: () => {},
  taskStatus: () => {},
  notify: () => {},
};

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug;
}

/** "HH:MM" (today) or "Mon HH:MM" for a local ISO time. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return hm;
  const withinWeek = Math.abs(d.getTime() - now.getTime()) < 6 * 24 * 3600 * 1000;
  return withinWeek
    ? `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`
    : `${d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })} ${hm}`;
}
