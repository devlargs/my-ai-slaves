import type {
  RepoGraph,
  GitActionResult,
  GitCommitRequest,
  PullMode,
  CommitDetail,
  WorkingChanges,
  RepoScripts,
  ScriptRunInfo,
  AccountView,
  Attachment,
  CreatePromptRequest,
  SavedPromptView,
  UpdatePromptRequest,
  ActivityEntry,
  CreateAccountRequest,
  CreateTaskRequest,
  DiffResponse,
  FsBrowseResponse,
  HistoryPage,
  UsageStatsResponse,
  CreateRepoPromptRequest,
  RepoPrompt,
  UpdateRepoPromptRequest,
  LabelColor,
  LabelColors,
  LoginState,
  PromptPreviewRequest,
  PromptPreviewResponse,
  RegisterRepoRequest,
  RemoteHost,
  Repo,
  RepoView,
  SessionInfo,
  Settings,
  TaskView,
  UpdateRepoRequest,
  UpdateSettingsRequest,
} from "@my-ai-slaves/shared";
import { markUnauthorized } from "./store";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    markUnauthorized();
    throw new ApiRequestError(401, "Session expired");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiRequestError(res.status, message);
  }
  return data as T;
}

const enc = encodeURIComponent;
type Ok = { ok: true };

export const api = {
  session: () => request<SessionInfo>("GET", "/session"),

  getSettings: () => request<Settings>("GET", "/settings"),
  putSettings: (body: UpdateSettingsRequest) => request<Settings>("PUT", "/settings", body),

  getAccounts: () => request<AccountView[]>("GET", "/accounts"),
  createAccount: (body: CreateAccountRequest) => request<AccountView>("POST", "/accounts", body),
  orderAccounts: (ids: string[]) => request<unknown>("PUT", "/accounts/order", { ids }),
  deleteAccount: (id: string) => request<Ok>("DELETE", `/accounts/${enc(id)}`),
  loginAccount: (id: string) => request<LoginState>("POST", `/accounts/${enc(id)}/login`),
  getLogin: (loginId: string) => request<LoginState>("GET", `/logins/${enc(loginId)}`),
  submitLoginCode: (loginId: string, code: string) => request<LoginState>("POST", `/logins/${enc(loginId)}/code`, { code }),
  cancelLogin: (loginId: string) => request<LoginState>("POST", `/logins/${enc(loginId)}/cancel`),
  checkAccount: (id: string) => request<AccountView>("POST", `/accounts/${enc(id)}/check`),
  clearLimit: (id: string) => request<AccountView>("POST", `/accounts/${enc(id)}/clear-limit`),

  getRepos: () => request<RepoView[]>("GET", "/repos"),
  registerRepo: (body: RegisterRepoRequest) => request<RepoView>("POST", "/repos", body),
  checkRepo: (id: string) => request<RepoView>("POST", `/repos/${enc(id)}/check`),
  getRepoGraph: (id: string, limit: number) => request<RepoGraph>("GET", `/repos/${enc(id)}/graph?limit=${limit}`),
  gitUndo: (id: string) => request<GitActionResult>("POST", `/repos/${enc(id)}/git/undo`),
  gitRedo: (id: string) => request<GitActionResult>("POST", `/repos/${enc(id)}/git/redo`),
  gitPull: (id: string, mode: PullMode) => request<GitActionResult>("POST", `/repos/${enc(id)}/git/pull`, { mode }),
  gitBranch: (id: string, name: string) => request<GitActionResult>("POST", `/repos/${enc(id)}/git/branch`, { name }),
  gitStage: (id: string, paths: string[] | null) => request<Ok>("POST", `/repos/${enc(id)}/git/stage`, { paths }),
  gitUnstage: (id: string, paths: string[] | null) => request<Ok>("POST", `/repos/${enc(id)}/git/unstage`, { paths }),
  gitCommit: (id: string, body: GitCommitRequest) => request<GitActionResult>("POST", `/repos/${enc(id)}/git/commit`, body),
  getWorkingChanges: (id: string) => request<WorkingChanges>("GET", `/repos/${enc(id)}/wip`),
  getCommit: (id: string, hash: string) => request<CommitDetail>("GET", `/repos/${enc(id)}/commits/${enc(hash)}`),
  getRunningScriptRepos: () => request<{ repoIds: string[] }>("GET", "/scripts/running"),
  getRepoScripts: (id: string) => request<RepoScripts>("GET", `/repos/${enc(id)}/scripts`),
  runRepoScript: (id: string, script: string) => request<ScriptRunInfo>("POST", `/repos/${enc(id)}/scripts/run`, { script }),
  stopRepoScript: (id: string, script: string) => request<Ok>("POST", `/repos/${enc(id)}/scripts/stop`, { script }),
  getLabelColors: () => request<LabelColors>("GET", "/label-colors"),
  setLabelColor: (label: string, color: LabelColor | null) =>
    request<LabelColors>("PUT", "/label-colors", { label, color }),
  getRemoteHosts: () => request<RemoteHost[]>("GET", "/remote/hosts"),
  updateRepo: (id: string, body: UpdateRepoRequest) => request<Repo>("PATCH", `/repos/${enc(id)}`, body),
  deleteRepo: (id: string) => request<Ok>("DELETE", `/repos/${enc(id)}`),
  browse: (path?: string, host?: string | null) => {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    if (host) q.set("host", host);
    const qs = q.toString();
    return request<FsBrowseResponse>("GET", `/fs/browse${qs ? `?${qs}` : ""}`);
  },

  getRepoPrompts: (repo: string) => request<RepoPrompt[]>("GET", `/repos/${enc(repo)}/prompts`),
  createRepoPrompt: (repo: string, body: CreateRepoPromptRequest) =>
    request<RepoPrompt>("POST", `/repos/${enc(repo)}/prompts`, body),
  updateRepoPrompt: (repo: string, id: string, body: UpdateRepoPromptRequest) =>
    request<RepoPrompt>("PATCH", `/repos/${enc(repo)}/prompts/${enc(id)}`, body),
  deleteRepoPrompt: (repo: string, id: string) => request<Ok>("DELETE", `/repos/${enc(repo)}/prompts/${enc(id)}`),
  orderRepoPrompts: (repo: string, ids: string[]) => request<unknown>("PUT", `/repos/${enc(repo)}/prompts/order`, { ids }),

  previewPrompt: (body: PromptPreviewRequest) => request<PromptPreviewResponse>("POST", "/prompt/preview", body),

  getTasks: () => request<TaskView[]>("GET", "/tasks"),
  createTask: (body: CreateTaskRequest) => request<TaskView>("POST", "/tasks", body),
  orderTasks: (ids: string[]) => request<unknown>("PUT", "/tasks/order", { ids }),
  cancelTask: (id: string) => request<unknown>("POST", `/tasks/${enc(id)}/cancel`),
  retryTask: (id: string) => request<unknown>("POST", `/tasks/${enc(id)}/retry`),
  replyTask: (id: string, message: string, attachmentIds: string[] = [], promptIds: string[] = []) =>
    request<unknown>("POST", `/tasks/${enc(id)}/reply`, { message, attachmentIds, promptIds }),

  getPrompts: () => request<SavedPromptView[]>("GET", "/prompts"),
  createPrompt: (body: CreatePromptRequest) => request<SavedPromptView>("POST", "/prompts", body),
  updatePrompt: (id: string, body: UpdatePromptRequest) => request<SavedPromptView>("PATCH", `/prompts/${enc(id)}`, body),
  deletePrompt: (id: string) => request<Ok>("DELETE", `/prompts/${enc(id)}`),
  orderPrompts: (ids: string[]) => request<unknown>("PUT", "/prompts/order", { ids }),
  uploadAttachment: async (file: File): Promise<Attachment> => {
    const res = await fetch(`/api/attachments?name=${enc(file.name || "pasted-image.png")}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream", "X-File-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const data = (await res.json().catch(() => null)) as (Attachment & { error?: string }) | null;
    if (!res.ok || !data) throw new ApiRequestError(res.status, data?.error ?? `Upload failed (${res.status})`);
    return data;
  },
  taskHistory: (id: string) => request<ActivityEntry[]>("GET", `/tasks/${enc(id)}/history`),
  taskDiff: (id: string) => request<DiffResponse>("GET", `/tasks/${enc(id)}/diff`),
  finishTask: (id: string) => request<Ok>("POST", `/tasks/${enc(id)}/finish`),
  discardTask: (id: string) => request<Ok>("POST", `/tasks/${enc(id)}/discard`, { confirm: true }),

  history: (offset = 0, limit = 50) => request<HistoryPage>("GET", `/history?offset=${offset}&limit=${limit}`),
  usageStats: () => request<UsageStatsResponse>("GET", "/stats/usage"),
};

/** Await an API call; on failure log it and resolve to undefined. */
export async function attempt<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.status === 401)) console.error(error);
    return undefined;
  }
}
