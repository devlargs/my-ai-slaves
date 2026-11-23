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
  /** Short tag shown next to the identity (e.g. "Work", "Personal"). App only; never sent to git or a CLI. */
  label: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .default(null)
    .transform((v) => v || null),
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
  /**
   * Show commit authors' Gravatar pictures in the commit graph. Off by default: when on, the server asks
   * gravatar.com for each author's email hash (the browser never does); when off, nothing leaves the machine.
   */
  commitAvatars: z.boolean().default(false),
  providers: z
    .object({
      "claude-code": ClaudeCodeSettings.prefault({}),
      "cursor-agent": CursorAgentSettings.prefault({}),
    })
    .prefault({}),
  updatedAt: timestampNow(),
});
export type SettingsFile = z.infer<typeof SettingsFile>;
