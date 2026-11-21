import { z } from "zod";
import { timestampNow } from "./common";

export const ClaudeCodeSettings = z.object({
  binary: z.string().min(1).default("claude"),
  model: z.string().min(1).nullable().default(null),
  permissionMode: z
    .enum(["auto", "acceptEdits", "manual", "dontAsk", "plan", "bypassPermissions"])
    .default("auto"),
});

export const CursorAgentSettings = z.object({
  binary: z.string().min(1).default("agent"),
  model: z.string().min(1).nullable().default(null),
  permissionMode: z.enum(["auto-review", "allowlist", "force"]).default("auto-review"),
  /** Case-insensitive regexes matched against stderr. Empty = use the built-in starter list. */
  limitPatterns: z.array(z.string()).default([]),
});

/** A saved git identity (Settings page); repos pick one to commit as. */
export const Committer = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  email: z.email().max(200),
});
export type Committer = z.infer<typeof Committer>;

export const SettingsFile = z.object({
  basePrompt: z.string().default(""),
  maxParallelTasks: z.int().min(1).max(16).default(2),
  limitCooldownMinutes: z.int().min(1).default(60),
  /** Saved identities repos can commit as. */
  committers: z.array(Committer).default([]),
  /** Used by repos that don't pick one. null = your git config. */
  defaultCommitterId: z.string().min(1).nullable().default(null),
  providers: z
    .object({
      "claude-code": ClaudeCodeSettings.prefault({}),
      "cursor-agent": CursorAgentSettings.prefault({}),
    })
    .prefault({}),
  updatedAt: timestampNow(),
});
export type SettingsFile = z.infer<typeof SettingsFile>;
