/**
 * REST contract. All routes are under /api, JSON in and out.
 * Errors: non-2xx status with body `ApiError`.
 */
import type { Account, AccountStatus } from "./schemas/accounts";
import type { ActivityEntry } from "./schemas/activity";
import type { ProviderId } from "./schemas/common";
import type { Task, TaskStatus } from "./schemas/queue";
import type { SavedPrompt as SavedPromptT } from "./schemas/prompts";
import type { KnowledgeFile, Repo } from "./schemas/repos";
import type { SettingsFile } from "./schemas/settings";

export interface ApiError {
  error: string;
}

/** GET /api/session — 200 when the token cookie is valid. */
export interface SessionInfo {
  ok: true;
  dataDir: string;
}

// ── Settings ────────────────────────────────────────────────────────────────
/** GET /api/settings → Settings · PUT /api/settings (body: Settings minus updatedAt) → Settings */
export type Settings = SettingsFile;
export type UpdateSettingsRequest = Omit<SettingsFile, "updatedAt">;

// ── Accounts ────────────────────────────────────────────────────────────────
/** `status` is the effective status right now (a past limitedUntil reads as available). */
export type AccountView = Account & {
  status: AccountStatus;
  /** Seconds until a limited account frees up; null when not limited. */
  secondsUntilAvailable: number | null;
  /** Who the CLI is logged in as, from its last status check (kept in memory, never saved). */
  email: string | null;
  /** e.g. "max" (Claude) or "Team: Acme" (Cursor). */
  plan: string | null;
};
/** GET /api/accounts → AccountView[] (in Settings-page order) */
/** POST /api/accounts */
export interface CreateAccountRequest {
  label: string;
  provider: ProviderId;
  /** SSH host for an account that uses that server's own login; omit for this Mac. */
  host?: string | null;
}
/** PUT /api/accounts/order */
export interface ReorderRequest {
  ids: string[];
}
/**
 * In-app login, same as running the CLI's own login: the CLI opens your browser, you sign in on the
 * provider's site, and its local callback finishes the login by itself.
 *  - "starting"  → waiting for the CLI to start the sign-in
 *  - "open-url"  → sign in in the browser tab that opened (`url` re-opens it). If `acceptsCode`, the
 *                  CLI also accepts a code pasted back (fallback when the browser can't redirect).
 *  - "verifying" → checking the login
 *  - "success" | "failed" | "cancelled"
 * POST /api/accounts/:id/login → LoginState (starts a fresh login; updates arrive as `login.updated` over WS)
 * GET  /api/logins/:loginId → LoginState
 * POST /api/logins/:loginId/code (body LoginCodeRequest) → LoginState
 * POST /api/logins/:loginId/cancel → LoginState
 */
export type LoginStatus = "starting" | "open-url" | "verifying" | "success" | "failed" | "cancelled";
export interface LoginState {
  loginId: string;
  accountId: string;
  provider: ProviderId;
  status: LoginStatus;
  /** Sign-in page printed by the CLI. */
  url: string | null;
  /** Claude: a code from the sign-in page can be pasted instead of the automatic redirect. */
  acceptsCode: boolean;
  /** Short human message for the current step or the failure reason. */
  message: string | null;
  /** Logged-in account, once known. */
  email: string | null;
  /** The CLI's output as plain text (for a collapsible "details" view). */
  output: string;
}
export interface LoginCodeRequest {
  code: string;
}
/** POST /api/accounts/:id/check → AccountView (re-runs the CLI's auth status) */
/** POST /api/accounts/:id/clear-limit → AccountView */
/** DELETE /api/accounts/:id → { ok: true } (logs the CLI out for that config dir, deletes the dir, removes it from repo chains) */

// ── Repos ───────────────────────────────────────────────────────────────────
/** Whether the repo can be reached right now (checked in the background). */
export interface RepoAvailability {
  state: "ok" | "unreachable" | "checking";
  /** Why it can't be reached (e.g. "ssh: connect to host dev: Operation timed out"). */
  message: string | null;
  checkedAt: string | null;
}
export type RepoView = Repo & { availability: RepoAvailability };
/** GET /api/repos → RepoView[] · POST /api/repos → RepoView · POST /api/repos/:id/check → RepoView */
export interface RegisterRepoRequest {
  path: string;
  /** SSH host from ~/.ssh/config; omit for a repo on this Mac. */
  host?: string | null;
}

/** GET /api/remote/hosts: what VS Code's Remote Explorer shows (SSH hosts + remembered folders). */
export interface RemoteHost {
  host: string;
  /** HostName from ~/.ssh/config, if set. */
  hostname: string | null;
  /** Remote folders VS Code has opened on this host (newest first). */
  recentFolders: string[];
}
/** PATCH /api/repos/:id → Repo */
export interface UpdateRepoRequest {
  name?: string;
  defaultBranch?: string;
  accountChain?: string[];
  /** Empty string clears it (falls back to your git config). */
  committerName?: string;
  committerEmail?: string;
}
/** DELETE /api/repos/:id → { ok: true } (refused with 409 while it has tasks in the queue) */

/** GET /api/fs/browse?path=<abs>&host=<ssh host> (defaults to home; host omitted = this Mac) */
export interface FsBrowseResponse {
  path: string;
  parent: string | null;
  isGitRepo: boolean;
  dirs: { name: string; path: string; isGitRepo: boolean }[];
}

// ── Repo prompts ────────────────────────────────────────────────────────────
/** GET /api/repos/:id/knowledge → KnowledgeFile */
export type Knowledge = KnowledgeFile;
/** GET /api/repos/:id/prompts → RepoPrompt[] (send order) · POST (CreateRepoPromptRequest) → RepoPrompt */
export interface CreateRepoPromptRequest {
  name: string;
  body: string;
  /** Pre-ticked when you queue a task on this repo. */
  default?: boolean;
}
/** PATCH /api/repos/:id/prompts/:promptId → RepoPrompt · DELETE → { ok } · PUT /api/repos/:id/prompts/order (ReorderRequest) */
export type UpdateRepoPromptRequest = Partial<CreateRepoPromptRequest>;

// ── Prompt preview ──────────────────────────────────────────────────────────
/** POST /api/prompt/preview */
export interface PromptPreviewRequest {
  repo: string;
  message: string;
  attachmentIds?: string[];
  promptIds?: string[];
  /** The repo's prompts to send; omitted = the repo's default ones. */
  repoPromptIds?: string[];
}
export interface PromptPreviewResponse {
  prompt: string;
  layers: { name: "global" | "repo" | "prompts" | "message" | "attachments"; included: boolean }[];
}

// ── Tasks ───────────────────────────────────────────────────────────────────
export type TaskView = Task & {
  /** e.g. "All accounts in the chain are limited; next free at 15:45". null when not waiting. */
  waitingNote: string | null;
};
/** GET /api/tasks → TaskView[] (queue order) */
/** POST /api/tasks → TaskView */
export interface CreateTaskRequest {
  repo: string;
  message: string;
  accountOverride?: string | null;
  /** Ids from POST /api/attachments. */
  attachmentIds?: string[];
  /** Saved prompts to bind (ids from GET /api/prompts). */
  promptIds?: string[];
  /** The repo's prompts to send (ids from GET /api/repos/:id/prompts); omitted = the repo's default ones. */
  repoPromptIds?: string[];
}
/** PUT /api/tasks/order (body ReorderRequest, only pending tasks move) */
/** POST /api/tasks/:id/cancel — pending: removed from queue; running: stopped → interrupted */
/** POST /api/tasks/:id/retry — interrupted/needs-review: task branch reset to the base commit, back to pending */
/** POST /api/tasks/:id/reply (body ReplyRequest) — needs-review: resumes the CLI session */
export interface ReplyRequest {
  message: string;
  attachmentIds?: string[];
  promptIds?: string[];
}

// ── Prompt library ──────────────────────────────────────────────────────────
/**
 * GET /api/prompts → SavedPrompt[] (library order)
 * POST /api/prompts (CreatePromptRequest) → SavedPrompt
 * PATCH /api/prompts/:id (UpdatePromptRequest) → SavedPrompt
 * PUT /api/prompts/order (ReorderRequest)
 * DELETE /api/prompts/:id → { ok: true } (tasks that bound it skip it, with a warning in their history)
 */
export type SavedPromptView = SavedPromptT;
export interface CreatePromptRequest {
  name: string;
  body: string;
}
export interface UpdatePromptRequest {
  name?: string;
  body?: string;
}

// ── Attachments ─────────────────────────────────────────────────────────────
/**
 * POST /api/attachments?name=<file name> with the raw file as the body
 * (Content-Type: application/octet-stream) → Attachment. One file per request.
 * GET /api/attachments/:id → the image bytes, only for byte-verified images (previews).
 */
/** GET /api/tasks/:id/history → ActivityEntry[] */
export type TaskHistoryResponse = ActivityEntry[];
/** GET /api/tasks/:id/diff */
export interface DiffResponse {
  /** Unified diff of the task branch vs the base commit it was created from. */
  patch: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  /** The repository the branch lives in. */
  repoPath: string;
}
/** POST /api/tasks/:id/keep → { ok: true } — the ai/ branch stays in the repo, task → done */
/** POST /api/tasks/:id/push → PushResponse — commit leftovers, push, open PR/MR when gh/glab is available, task → done */
export interface PushResponse {
  url: string | null;
  output: string;
}
/** POST /api/tasks/:id/discard (body { confirm: true }) → { ok: true } — stops it if running, deletes its ai/ branch */

// ── History ─────────────────────────────────────────────────────────────────
/** GET /api/history → HistoryItem[] (newest first; tasks no longer in the queue) */
export interface HistoryItem {
  taskId: string;
  title: string;
  repo: string;
  message: string;
  outcome: Extract<TaskStatus, "done" | "failed"> | "discarded" | "cancelled";
  lastAccount: string | null;
  branch: string | null;
  queuedAt: string;
  endedAt: string;
}
