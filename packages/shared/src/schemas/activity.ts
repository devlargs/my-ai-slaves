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
  "marked-finished",
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

/** The older activity file format (`NNNN_activity.json`, one document per file): still read, no longer written. */
export const ActivityFile = z.object({
  file: z.string().regex(/^\d{4,}_activity\.json$/),
  createdAt: Timestamp,
  entries: z.array(ActivityEntry),
});
export type ActivityFile = z.infer<typeof ActivityFile>;

/**
 * Tokens one run used, as its CLI reported them. Saved in the `data.usage` of the entry that ends the
 * run (finished, failed, cancelled, limit-hit, …); the Statistics page adds them up.
 */
export const TokenUsage = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  cacheReadTokens: z.number().nonnegative().default(0),
  cacheWriteTokens: z.number().nonnegative().default(0),
  /** The CLI's own estimate in USD (Claude only), not what a subscription is billed. */
  costUsd: z.number().nonnegative().nullable().default(null),
});
export type TokenUsage = z.infer<typeof TokenUsage>;
