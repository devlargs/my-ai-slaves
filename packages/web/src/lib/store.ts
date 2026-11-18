import type {
  AccountView,
  ClientMessage,
  RawLine,
  ServerMessage,
  StreamEvent,
  TaskView,
} from "@my-ai-slaves/shared";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

// ── Live task output model ──────────────────────────────────────────────────

export type LiveItem =
  | { type: "init"; model: string; permissionMode: string; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool"; callId: string; tool: string; summary: string; ok: boolean | null; result: string | null }
  | { type: "file-edit"; path: string }
  | { type: "warning"; text: string };

export interface LiveState {
  items: LiveItem[];
  /** Assistant text currently being generated (text-delta). */
  streaming: string;
  raw: RawLine[];
  lastStatus: { status: string; detail: string | null } | null;
}

const RAW_CAP = 5000;
const emptyLive = (): LiveState => ({ items: [], streaming: "", raw: [], lastStatus: null });

function applyEvent(live: LiveState, event: StreamEvent): LiveState {
  const items = live.items.slice();
  let streaming = live.streaming;
  const flushStreaming = () => {
    if (streaming.trim()) items.push({ type: "message", text: streaming });
    streaming = "";
  };
  switch (event.kind) {
    case "text-delta":
      streaming += event.text;
      break;
    case "message":
      streaming = "";
      items.push({ type: "message", text: event.text });
      break;
    case "tool-start":
      flushStreaming();
      items.push({ type: "tool", callId: event.callId, tool: event.tool, summary: event.summary, ok: null, result: null });
      break;
    case "tool-end": {
      const index = items.findLastIndex((i) => i.type === "tool" && i.callId === event.callId);
      const item = items[index];
      if (item && item.type === "tool") items[index] = { ...item, ok: event.ok, result: event.summary || null };
      break;
    }
    case "file-edit":
      items.push({ type: "file-edit", path: event.path });
      break;
    case "warning":
      items.push({ type: "warning", text: event.text });
      break;
    case "init":
      items.push({ type: "init", model: event.model, permissionMode: event.permissionMode, sessionId: event.sessionId });
      break;
  }
  return { ...live, items, streaming };
}

// ── Global store ────────────────────────────────────────────────────────────

export interface AppState {
  connected: boolean;
  unauthorized: boolean;
  tasks: TaskView[];
  tasksLoaded: boolean;
  accounts: AccountView[];
  live: Record<string, LiveState>;
}

let state: AppState = {
  connected: false,
  unauthorized: false,
  tasks: [],
  tasksLoaded: false,
  accounts: [],
  live: {},
};
const listeners = new Set<() => void>();

function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

export function getState(): AppState {
  return state;
}

export function markUnauthorized() {
  if (!state.unauthorized) setState({ unauthorized: true });
}

export function setAccounts(accounts: AccountView[]) {
  setState({ accounts });
}

export function setTasks(tasks: TaskView[]) {
  setState({ tasks, tasksLoaded: true });
}

function updateLive(taskId: string, fn: (live: LiveState) => LiveState) {
  setState((s) => ({ live: { ...s.live, [taskId]: fn(s.live[taskId] ?? emptyLive()) } }));
}

// ── Notifications ───────────────────────────────────────────────────────────

function notify(title: string, body: string) {
  toast(title, { description: body });
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    // ignore
  }
}

// ── WebSocket client ────────────────────────────────────────────────────────

type MessageListener = (msg: ServerMessage) => void;

class WsClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<MessageListener>();
  /** Messages re-sent after every (re)connect, keyed so they can be removed. */
  private readonly persistent = new Map<string, ClientMessage>();
  private readonly taskRefs = new Map<string, number>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.persistent.set("queue", { type: "subscribe", topic: "queue" });
    this.persistent.set("accounts", { type: "subscribe", topic: "accounts" });
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      setState({ connected: true });
      for (const msg of this.persistent.values()) socket.send(JSON.stringify(msg));
    };
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
      for (const l of this.listeners) l(msg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      setState({ connected: false });
      this.retry += 1;
      // After a few failures, check whether the session itself is gone.
      if (this.retry === 3) {
        fetch("/api/session", { credentials: "same-origin" })
          .then((r) => {
            if (r.status === 401) markUnauthorized();
          })
          .catch(() => {});
      }
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5));
      this.timer = setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }

  private handle(msg: ServerMessage) {
    switch (msg.type) {
      case "queue.updated":
        setTasks(msg.tasks);
        break;
      case "accounts.updated":
        setAccounts(msg.accounts);
        break;
      case "task.replay":
        updateLive(msg.taskId, () => {
          let live: LiveState = { ...emptyLive(), raw: msg.raw.slice(-RAW_CAP) };
          for (const e of msg.events) live = applyEvent(live, e);
          return live;
        });
        break;
      case "task.event":
        updateLive(msg.taskId, (live) => applyEvent(live, msg.event));
        break;
      case "task.raw":
        updateLive(msg.taskId, (live) => {
          const raw = live.raw.length >= RAW_CAP ? live.raw.slice(-RAW_CAP + 1) : live.raw.slice();
          raw.push(msg.raw);
          return { ...live, raw };
        });
        break;
      case "task.status":
        updateLive(msg.taskId, (live) => ({ ...live, lastStatus: { status: msg.status, detail: msg.detail } }));
        break;
      case "notify":
        notify(msg.title, msg.body);
        break;
      default:
        break;
    }
  }

  send(msg: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  addListener(fn: MessageListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Keep `msg` subscribed across reconnects until `remove` is called. */
  persist(key: string, msg: ClientMessage) {
    this.persistent.set(key, msg);
    this.send(msg);
  }

  unpersist(key: string) {
    this.persistent.delete(key);
  }

  subscribeTask(taskId: string): () => void {
    const count = this.taskRefs.get(taskId) ?? 0;
    this.taskRefs.set(taskId, count + 1);
    if (count === 0) this.persist(`task:${taskId}`, { type: "subscribe", topic: "task", taskId });
    return () => {
      const n = (this.taskRefs.get(taskId) ?? 1) - 1;
      if (n <= 0) {
        this.taskRefs.delete(taskId);
        this.unpersist(`task:${taskId}`);
        this.send({ type: "unsubscribe", topic: "task", taskId });
      } else {
        this.taskRefs.set(taskId, n);
      }
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}

export const ws = new WsClient();
