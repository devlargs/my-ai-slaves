/**
 * REST contract. All routes are under /api, JSON in and out. Request bodies are zod schemas in
 * schemas/requests.ts (validated by the server, their types used by the web app).
 * Errors: non-2xx status with body `ApiError`.
 */
import type { Account, AccountStatus } from "./schemas/accounts";
import type { ActivityEntry, TokenUsage } from "./schemas/activity";
import type { AskChat } from "./schemas/ask";
import type { ProviderId } from "./schemas/common";
import type { Task, TaskStatus } from "./schemas/queue";
import type { SavedPrompt as SavedPromptT } from "./schemas/prompts";
import type { KnowledgeFile, LabelColor, Repo } from "./schemas/repos";
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

// ── Data files ──────────────────────────────────────────────────────────────
/**
 * GET /api/data/recoveries → DataFileRecovery[]: data files that failed validation since the server
 * started and were backed up and repaired (oldest first; empty almost always).
 */
export interface DataFileRecovery {
  file: string;
  /** `salvaged`: only the invalid list items were dropped. `recovered`: the whole file was reset. */
  outcome: "salvaged" | "recovered";
  /** Where the original file was moved; rename it back (after fixing it) to restore it. */
  backup: string;
  /** Why the file didn't validate (its first few problems). */
  reason: string;
  /** Paths of the list items that were dropped (`salvaged` only), e.g. `repos.2`. */
  dropped: string[];
  at: string;
}

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

/** GET /api/remote/hosts: what VS Code's Remote Explorer shows (SSH hosts + remembered folders). */
export interface RemoteHost {
  host: string;
  /** HostName from ~/.ssh/config, if set. */
  hostname: string | null;
  /** Remote folders VS Code has opened on this host (newest first). */
  recentFolders: string[];
}
/** PATCH /api/repos/:id → Repo */
/** GET /api/label-colors → LabelColors · PUT /api/label-colors (body: SetLabelColorRequest) → LabelColors */
export type LabelColors = Record<string, LabelColor>;
/** DELETE /api/repos/:id → { ok: true } (refused with 409 while it has tasks in the queue) */

/** GET /api/repos/:id/graph?limit=<n> → RepoGraph (read-only `git log --all`, newest first) */
export interface GraphCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** SHA-256 of the trimmed, lowercased author email: the Gravatar id for the author's avatar. */
  avatar: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
  /** Refs pointing at this commit, as git prints them: "HEAD -> main", "origin/main", "tag: v1.0". */
  refs: string[];
}
export interface RepoGraph {
  commits: GraphCommit[];
  /** The checked-out branch (or commit, when detached). */
  head: string | null;
  /** True when there are older commits past the limit. */
  more: boolean;
  /** Local branches (`refs/heads`), sorted by name. */
  local: LocalBranch[];
  /** Remote-tracking branches (`refs/remotes`, without `<remote>/HEAD`), sorted by remote then name. */
  remote: RemoteBranch[];
  /** What the toolbar's Undo / Redo would do right now. */
  history: GitHistory;
  /** Uncommitted changes in the checkout (the graph's "// WIP" row); null when the tree is clean. */
  wip: WipSummary | null;
  /** `git stash list`, newest first (stash@{0} first). Stashes aren't drawn in the graph itself. */
  stashes: StashEntry[];
}

/** One stash (`stash@{index}`). */
export interface StashEntry {
  /** 0 = stash@{0}, the newest. */
  index: number;
  /** The stash commit. */
  hash: string;
  /** The commit it was made on (its first parent). */
  base: string;
  /** "WIP on main: 59bf2b5 Merge …" or "On main: <your message>". */
  message: string;
  /** When it was made, ISO 8601. */
  date: string;
  author: string;
  email: string;
  /** Gravatar id of the author's email (as GraphCommit.avatar). */
  avatar: string;
}

/** Counts of the checkout's uncommitted files (staged, unstaged and untracked), each path counted once. */
export interface WipSummary {
  files: number;
  added: number;
  modified: number;
  deleted: number;
}
/**
 * GET /api/repos/:id/wip → WorkingChanges (read-only `git status` + `git diff`): what isn't committed yet.
 * Untracked files count as unstaged additions. A file can be in both lists (part staged, part not).
 */
export interface WorkingChanges {
  /** The checked-out branch (or commit, when detached). */
  head: string | null;
  staged: CommitFile[];
  unstaged: CommitFile[];
  /** Index vs HEAD (`git diff --cached`). */
  stagedPatch: string;
  /** Working tree vs index (`git diff`), plus untracked files as new files. */
  unstagedPatch: string;
}

/**
 * The graph toolbar's actions. Only run when you click them (tasks never touch branches).
 * POST /api/repos/:id/git/undo | /git/redo → GitActionResult
 * POST /api/repos/:id/git/pull GitPullRequest → GitActionResult
 * POST /api/repos/:id/git/branch GitBranchRequest → GitActionResult (creates it at HEAD and checks it out)
 * All refused with 409 while a task is running in the repo.
 */
export interface GitHistory {
  /** "commit \"fix login\"", "pull", "checkout main", "create branch feat/x"; null = nothing to undo. */
  undo: string | null;
  redo: string | null;
}
/**
 * The WIP panel's actions, also only run on a click (refused with 409 while a task runs there).
 * POST /api/repos/:id/git/stage | /git/unstage GitPathsRequest → { ok: true }
 *   (null = every change; paths are relative to the repo root, taken literally)
 * POST /api/repos/:id/git/commit GitCommitRequest → GitActionResult (commits what's staged)
 */
export interface GitActionResult {
  history: GitHistory;
}

/** GET /api/repos/:id/rebase-plan?onto=<ref> → RebasePlan (read-only: the commits it would replay, oldest first) */
export interface RebasePlan {
  onto: string;
  commits: { hash: string; subject: string }[];
}
/** GET /api/repos/:id/compare/:hash → CompareResult (read-only `git diff <hash>`: the commit vs the working directory) */
export interface CompareResult {
  hash: string;
  files: CommitFile[];
  patch: string;
}
export interface LocalBranch {
  /** "main", "fix/announce-notice-banner". */
  name: string;
  commit: string;
  /** The checked-out branch. */
  current: boolean;
  /** Upstream as git shortens it ("origin/main"), null when none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream branch is gone from the remote. */
  gone: boolean;
}
export interface RemoteBranch {
  /** "origin". */
  remote: string;
  /** Branch name on the remote: "main". */
  name: string;
  /** "origin/main", as it appears in commit refs. */
  ref: string;
  commit: string;
}

/** GET /api/repos/:id/commits/:hash → CommitDetail (read-only `git show`, compared to the first parent) */
export interface CommitFile {
  /** A = added, M = modified, D = deleted, R = renamed, C = copied, T = type changed. */
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  /** The old path of a rename or copy. */
  oldPath: string | null;
}
export interface CommitDetail extends GraphCommit {
  /** The message after the subject line (may be empty). */
  body: string;
  committer: string;
  /** Committer date, ISO 8601. */
  committerDate: string;
  files: CommitFile[];
  /** Unified diff against the first parent (or against nothing, for a root commit). */
  patch: string;
}

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
/** PATCH /api/repos/:id/prompts/:promptId → RepoPrompt · DELETE → { ok } · PUT /api/repos/:id/prompts/order (ReorderRequest) */

// ── Prompt preview ──────────────────────────────────────────────────────────
/** POST /api/prompt/preview */
export interface PromptPreviewResponse {
  prompt: string;
  layers: { name: "global" | "repo" | "prompts" | "message" | "repos" | "attachments"; included: boolean }[];
}

// ── Ask mode ────────────────────────────────────────────────────────────────
/** A chat in the Ask page's list (its messages come as the chat's stream replay). */
export type AskChatView = Omit<AskChat, "messages"> & {
  messageCount: number;
  /** First line of the latest message, for the list. */
  preview: string;
};
/** GET /api/ask → AskChatView[] (newest first) */
/** POST /api/ask (body CreateAskRequest) → AskChatView */
/** POST /api/ask/:id/messages (body AskFollowUpRequest) — continues the chat's session */
/** POST /api/ask/:id/stop · PATCH /api/ask/:id (UpdateAskRequest) · DELETE /api/ask/:id */

// ── Tasks ───────────────────────────────────────────────────────────────────
export type TaskView = Task & {
  /** e.g. "All accounts in the chain are limited; next free at 15:45". null when not waiting. */
  waitingNote: string | null;
};
/** GET /api/tasks → TaskView[] (queue order) */
/** POST /api/tasks → TaskView */
/** PUT /api/tasks/order (body ReorderRequest, only pending tasks move) */
/** POST /api/tasks/:id/cancel — pending: removed from queue; running: stopped → interrupted */
/** POST /api/tasks/:id/retry — interrupted/needs-review: back to pending, runs again in a new session (the repo is left as it is) */
/** POST /api/tasks/:id/reply (body ReplyRequest) — needs-review/interrupted (with a session): resumes the CLI session */

// ── Prompt library ──────────────────────────────────────────────────────────
/**
 * GET /api/prompts → SavedPrompt[] (library order)
 * POST /api/prompts (CreatePromptRequest) → SavedPrompt
 * PATCH /api/prompts/:id (UpdatePromptRequest) → SavedPrompt
 * PUT /api/prompts/order (ReorderRequest)
 * DELETE /api/prompts/:id → { ok: true } (tasks that bound it skip it, with a warning in their history)
 */
export type SavedPromptView = SavedPromptT;

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
  /** What changed in the checkout since the task started (committed, uncommitted and new files). */
  patch: string;
  /** The branch checked out now (or the commit, when detached). */
  ref: string;
  /** The commit the changes are compared to. */
  from: string;
  /** Where the checkout was when the task started; null for a task from an older version (legacy ai/ branch). */
  startedOn: { ref: string; commit: string } | null;
  repoPath: string;
}
/** POST /api/tasks/:id/finish → { ok: true } — off the queue, into History as done; nothing in the repo is touched */
/** POST /api/tasks/:id/discard (body { confirm: true }) → { ok: true } — stops it if running, off the queue; nothing in the repo is touched */

// ── History ─────────────────────────────────────────────────────────────────
/** GET /api/history?offset=0&limit=50 → HistoryPage (newest first; tasks no longer in the queue) */
export interface HistoryPage {
  items: HistoryItem[];
  /** How many history items there are in all. */
  total: number;
  /** The offset to ask for next, or null when this page reached the end. */
  nextOffset: number | null;
}
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

/** The package manager a repo's scripts are run with (from package.json's `packageManager`, else its lockfile). */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** GET /api/repos/:id/scripts → the `scripts` of the repo's package.json, in file order. */
export interface RepoScripts {
  /** False when the repo has no package.json at its root. */
  found: boolean;
  packageManager: PackageManager;
  scripts: { name: string; command: string }[];
}

export type ScriptRunStatus = "running" | "done" | "failed" | "stopped";

/** One run of a repo script started from the app (the latest per script is kept in memory). */
export interface ScriptRunInfo {
  id: string;
  repoId: string;
  script: string;
  /** What was run, e.g. "npm run dev". */
  commandLine: string;
  status: ScriptRunStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ScriptRun extends ScriptRunInfo {
  /** stdout + stderr as it came (the last 256 KB). */
  output: string;
}

// ── Statistics ──────────────────────────────────────────────────────────────
/** One run's token usage, from the activity log. */
export interface UsageRecord {
  at: string;
  taskId: string;
  repo: string;
  /** Account (subscription) id the run used. */
  account: string;
  usage: TokenUsage;
}
/** GET /api/stats/usage → every recorded run's usage, oldest first. The page adds them up. */
export interface UsageStatsResponse {
  records: UsageRecord[];
}
