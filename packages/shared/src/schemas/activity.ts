import { z } from "zod";
import { Timestamp } from "./common";

export const ActivityEvent = z.enum([
  "queued",
  "started",
  "fallback",
  "limit-hit",
  "message",
  "tool-call",
  "file-edit",
  "warning",
  "waiting",
  "reply",
  "finished",
  "failed",
  "cancelled",
  "interrupted",
  "kept",
  "pushed",
  "discarded",
]);
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityEntry = z.object({
  at: Timestamp,
  taskId: z.string(),
  repo: z.string(),
  account: z.string().nullable(),
  event: ActivityEvent,
  detail: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

export const ActivityFile = z.object({
  file: z.string().regex(/^\d{4,}_activity\.json$/),
  createdAt: Timestamp,
  entries: z.array(ActivityEntry),
});
export type ActivityFile = z.infer<typeof ActivityFile>;
