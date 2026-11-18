import type {
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
  HistoryItem,
  Knowledge,
  LoginState,
  PromptPreviewRequest,
  PromptPreviewResponse,
  PushResponse,
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
import { toast } from "sonner";
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

  getKnowledge: (repo: string) => request<Knowledge>("GET", `/repos/${enc(repo)}/knowledge`),
  putKnowledge: (repo: string, basePrompt: string) =>
    request<Knowledge>("PUT", `/repos/${enc(repo)}/knowledge`, { basePrompt }),

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
  keepTask: (id: string) => request<Ok>("POST", `/tasks/${enc(id)}/keep`),
  pushTask: (id: string) => request<PushResponse>("POST", `/tasks/${enc(id)}/push`),
  discardTask: (id: string) => request<Ok>("POST", `/tasks/${enc(id)}/discard`, { confirm: true }),

  history: () => request<HistoryItem[]>("GET", "/history"),
};

/** Await an API call; on failure show a toast and resolve to undefined. */
export async function attempt<T>(promise: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await promise;
    if (success) toast.success(success);
    return result;
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.status === 401)) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }
}
