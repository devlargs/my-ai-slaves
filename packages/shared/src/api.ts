/**
 * REST contract. All routes are under /api, JSON in and out.
 * Errors: non-2xx status with body `ApiError`.
 */
import type { Account, AccountStatus } from "./schemas/accounts";
import type { ActivityEntry } from "./schemas/activity";
import type { ProviderId } from "./schemas/common";
import type { Task, TaskStatus } from "./schemas/queue";
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
};
/** GET /api/accounts → AccountView[] (in Settings-page order) */
/** POST /api/accounts */
export interface CreateAccountRequest {
  label: string;
  provider: ProviderId;
}
/** PUT /api/accounts/order */
export interface ReorderRequest {
  ids: string[];
}
/**
 * In-app login. The server drives the CLI's own login command in the background and reports:
 *  - "starting"   → waiting for the CLI to produce a sign-in link
 *  - "open-url"   → open `url` and sign in (Cursor finishes by itself after that)
 *  - "needs-code" → open `url`, sign in, then paste the code shown into the app (Claude)
 *  - "verifying"  → code submitted / CLI finished, checking the login
 *  - "success" | "failed" | "cancelled"
 * POST /api/accounts/:id/login → LoginState (starts a fresh login; updates arrive as `login.updated` over WS)
 * GET  /api/logins/:loginId → LoginState
 * POST /api/logins/:loginId/code (body LoginCodeRequest) → LoginState
 * POST /api/logins/:loginId/cancel → LoginState
 */
export type LoginStatus = "starting" | "open-url" | "needs-code" | "verifying" | "success" | "failed" | "cancelled";
export interface LoginState {
  loginId: string;
  accountId: string;
  provider: ProviderId;
  status: LoginStatus;
  /** Sign-in page printed by the CLI. */
  url: string | null;
  /** Short human message for the current step or the failure reason. */
  message: string | null;
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
/** GET /api/repos → Repo[] · POST /api/repos → Repo */
export interface RegisterRepoRequest {
  path: string;
}
/** PATCH /api/repos/:id → Repo */
export interface UpdateRepoRequest {
  name?: string;
  defaultBranch?: string;
  accountChain?: string[];
}
/** DELETE /api/repos/:id → { ok: true } (refused with 409 while it has tasks in the queue) */

/** GET /api/fs/browse?path=<abs> (defaults to home) */
export interface FsBrowseResponse {
  path: string;
  parent: string | null;
  isGitRepo: boolean;
  dirs: { name: string; path: string; isGitRepo: boolean }[];
}

// ── Knowledge ───────────────────────────────────────────────────────────────
/** GET /api/repos/:id/knowledge → KnowledgeFile · PUT (body UpdateKnowledgeRequest) → KnowledgeFile */
export type Knowledge = KnowledgeFile;
export interface UpdateKnowledgeRequest {
  basePrompt: string;
}

// ── Prompt preview ──────────────────────────────────────────────────────────
/** POST /api/prompt/preview */
export interface PromptPreviewRequest {
  repo: string;
  message: string;
}
export interface PromptPreviewResponse {
  prompt: string;
  layers: { name: "global" | "repo" | "message"; included: boolean }[];
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
}
/** PUT /api/tasks/order (body ReorderRequest, only pending tasks move) */
/** POST /api/tasks/:id/cancel — pending: removed from queue; running: stopped → interrupted */
/** POST /api/tasks/:id/retry — interrupted/needs-review: worktree reset, back to pending */
/** POST /api/tasks/:id/reply (body ReplyRequest) — needs-review: resumes the CLI session */
export interface ReplyRequest {
  message: string;
}
/** GET /api/tasks/:id/history → ActivityEntry[] */
export type TaskHistoryResponse = ActivityEntry[];
/** GET /api/tasks/:id/diff */
export interface DiffResponse {
  /** Unified diff of everything in the worktree vs the base commit (committed + uncommitted + untracked). */
  patch: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  worktreePath: string;
}
/** POST /api/tasks/:id/keep → { ok: true } — commits leftovers on the ai/ branch, removes the worktree, task → done */
/** POST /api/tasks/:id/push → PushResponse — commit leftovers, push, open PR/MR when gh/glab is available, task → done */
export interface PushResponse {
  url: string | null;
  output: string;
}
/** POST /api/tasks/:id/discard (body { confirm: true }) → { ok: true } — removes worktree and branch */

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
