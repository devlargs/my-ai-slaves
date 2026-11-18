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

export const SettingsFile = z.object({
  basePrompt: z.string().default(""),
  maxParallelTasks: z.int().min(1).max(16).default(2),
  limitCooldownMinutes: z.int().min(1).default(60),
  providers: z
    .object({
      "claude-code": ClaudeCodeSettings.prefault({}),
      "cursor-agent": CursorAgentSettings.prefault({}),
    })
    .prefault({}),
  updatedAt: timestampNow(),
});
export type SettingsFile = z.infer<typeof SettingsFile>;
