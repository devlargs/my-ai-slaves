import type { Account, ProviderId, RawLine, SettingsFile, StreamEvent } from "@my-ai-slaves/shared";

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface LimitInfo {
  /** ISO time the CLI said the limit resets, or null (caller applies the cooldown). */
  resetsAt: string | null;
  reason: string;
}

export type RunResult =
  | { outcome: "success"; sessionId: string | null; resultText: string; costUsd: number | null }
  | { outcome: "limit"; limit: LimitInfo; sessionId: string | null }
  | { outcome: "logged-out"; message: string }
  | { outcome: "failed"; exitCode: number | null; message: string; stderrTail: string }
  | { outcome: "cancelled" };

export interface RunHandle {
  onStream(cb: (event: StreamEvent) => void): () => void;
  onRaw(cb: (raw: RawLine) => void): () => void;
  done: Promise<RunResult>;
  /** SIGINT → SIGTERM after 5s → SIGKILL after 10s. Resolves when the process has exited. */
  cancel(): Promise<void>;
}

export type ClaudeSettings = SettingsFile["providers"]["claude-code"];
export type CursorSettings = SettingsFile["providers"]["cursor-agent"];

export interface AccountContext {
  account: Account;
  /** Absolute path of the account's isolated CLI config dir. */
  configDir: string;
}

export interface RunInput extends AccountContext {
  /** Fully assembled prompt, sent verbatim. */
  prompt: string;
  /** The task's worktree. */
  cwd: string;
  /** Continue an earlier CLI session (follow-up reply). */
  resume: { sessionId: string; fromConfigDir: string } | null;
}

export type AuthState = "logged-in" | "logged-out" | "unknown";

export interface ProviderAdapter {
  readonly provider: ProviderId;
  run(input: RunInput, settings: SettingsFile): RunHandle;
  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec;
  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec;
  checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthState>;
}
