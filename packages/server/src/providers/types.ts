import type { Account, ProviderId, RawLine, SettingsFile, StreamEvent } from "@my-ai-slaves/shared";

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Variables to set for the command (on top of the machine's own environment). */
  extraEnv: Record<string, string>;
  cwd?: string | null;
  /** SSH host to run on; null/undefined = this Mac. */
  host?: string | null;
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
  /** Local accounts: absolute path of the isolated CLI config dir. Remote (server's own login): null. */
  configDir: string | null;
}

export interface RunInput extends AccountContext {
  /** Fully assembled prompt, sent verbatim. */
  prompt: string;
  /** Working directory: the repository itself (checked out on the task branch). */
  cwd: string;
  /** Continue an earlier CLI session (follow-up reply). */
  resume: { sessionId: string; fromConfigDir: string | null } | null;
  /** Extra folders the CLI may read (the task's attachment folders). */
  addDirs?: string[];
  /** Author/committer for any commit the agent makes (the repo's setting). */
  gitIdentity?: GitIdentity | null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/** GIT_AUTHOR_* / GIT_COMMITTER_* override git config for every git command the agent runs. */
export function gitIdentityEnv(identity: GitIdentity | null | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (identity?.name) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_COMMITTER_NAME = identity.name;
  }
  if (identity?.email) {
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return env;
}

export interface AuthInfo {
  state: "logged-in" | "logged-out" | "unknown";
  email: string | null;
  plan: string | null;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** One-time setup before a run (e.g. turning off the CLI's commit attribution). */
  prepare?(ctx: AccountContext, settings: SettingsFile): Promise<void>;
  run(input: RunInput, settings: SettingsFile): RunHandle;
  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec;
  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec;
  checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthInfo>;
}
