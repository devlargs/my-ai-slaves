import type {
  AccountView,
  Attachment,
  ClientMessage,
  RawLine,
  ServerMessage,
  StreamEvent,
  TaskView,
} from "@my-ai-slaves/shared";
import { startTransition, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isWindowActive, onWindowActive } from "./window-active";

// ── Live task output model ──────────────────────────────────────────────────

export type LiveItem =
  | { type: "init"; model: string; permissionMode: string; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool"; callId: string; tool: string; summary: string; ok: boolean | null; result: string | null }
  | { type: "file-edit"; path: string }
  | { type: "warning"; text: string }
  | { type: "user"; text: string; reply: boolean; attachments: Attachment[]; prompts: string[] };

export interface LiveState {
  items: LiveItem[];
  /** Assistant text currently being generated (text-delta). */
  streaming: string;
  /** The CLI's raw lines: only filled while the task's "Raw output" view is open. */
  raw: RawLine[];
  lastStatus: { status: string; detail: string | null } | null;
}

const RAW_CAP = 5000;
const emptyLive = (): LiveState => ({ items: [], streaming: "", raw: [], lastStatus: null });

/**
 * Applies one event to a task's live state in place. Callers pass a draft whose `items` array is
 * already their own copy (one copy per flush, not one per event: a replay can hold thousands of events).
 */
function applyEvent(live: LiveState, event: StreamEvent): void {
  const items = live.items;
  const flushStreaming = () => {
    if (live.streaming.trim()) items.push({ type: "message", text: live.streaming });
    live.streaming = "";
  };
  switch (event.kind) {
    case "text-delta":
      live.streaming += event.text;
      break;
    case "message":
      live.streaming = "";
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
    case "user":
      flushStreaming();
      items.push({ type: "user", text: event.text, reply: event.reply, attachments: event.attachments, prompts: event.prompts });
      break;
    case "init":
      items.push({ type: "init", model: event.model, permissionMode: event.permissionMode, sessionId: event.sessionId });
      break;
  }
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

// Module-level so React doesn't unsubscribe and resubscribe on every render.
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/**
 * Like useStore, but changes are rendered as a transition: React can pause that render to handle a
 * keystroke or click first. For views that change many times a second (live task output), so typing
 * and navigating never wait behind them. useSyncExternalStore renders are always blocking.
 */
export function useStoreTransition<T>(selector: (s: AppState) => T, deps: unknown[]): T {
  const [value, setValue] = useState(() => selector(state));
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied
  useEffect(() => {
    const check = () => {
      const next = selectorRef.current(state);
      startTransition(() => setValue(() => next));
    };
    check(); // pick up what changed in the selector's inputs (deps) or the store since the last render
    return subscribe(check);
  }, deps);
  return value;
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

// A running task sends a message for every token and tool call, many a second. Re-rendering the
// live output for each one would keep the main thread busy, so live messages are queued and applied
// together, at most once every LIVE_FLUSH_MS, and the live view renders them as a transition
// (useStoreTransition) that yields to typing and clicks.
type LiveMessage = Extract<
  ServerMessage,
  { type: "task.replay" | "task.event" | "task.raw-replay" | "task.raw" | "task.status" }
>;
const LIVE_FLUSH_MS = 100;
// While the window isn't the active one (another app in front, or minimized): once a second is
// plenty, and every flush costs a render, a layout and a paint.
const LIVE_FLUSH_INACTIVE_MS = 1000;
let pendingLive: LiveMessage[] = [];
let liveTimer: ReturnType<typeof setTimeout> | null = null;
/** Tasks whose view is open. Only these keep live output in memory (task.status goes to every queue view). */
const liveTasks = new Set<string>();
/** Tasks whose "Raw output" view is open. Only these are sent, and keep, the CLI's raw lines. */
const rawTasks = new Set<string>();

function queueLive(msg: LiveMessage) {
  if (!liveTasks.has(msg.taskId)) return;
  if ((msg.type === "task.raw" || msg.type === "task.raw-replay") && !rawTasks.has(msg.taskId)) return;
  pendingLive.push(msg);
  // A timer, not requestAnimationFrame: that one stops while the window is hidden and the queue would pile up.
  liveTimer ??= setTimeout(flushLive, isWindowActive() ? LIVE_FLUSH_MS : LIVE_FLUSH_INACTIVE_MS);
}

// Back in the window: show what arrived meanwhile at once, not up to a second later.
onWindowActive((active) => {
  if (!active || liveTimer === null) return;
  clearTimeout(liveTimer);
  flushLive();
});

function flushLive() {
  liveTimer = null;
  const batch = pendingLive.filter((msg) => liveTasks.has(msg.taskId));
  pendingLive = [];
  if (batch.length === 0) return;
  const live = { ...state.live };
  // Each task touched by this batch gets one draft (with its own copy of items), mutated by every
  // message for it, so a burst of tokens doesn't copy the whole item list once per token.
  const drafts = new Map<string, LiveState>();
  const draft = (taskId: string): LiveState => {
    let d = drafts.get(taskId);
    if (!d) {
      const current = live[taskId] ?? emptyLive();
      d = { ...current, items: current.items.slice() };
      drafts.set(taskId, d);
      live[taskId] = d;
    }
    return d;
  };
  // Raw lines are collected per task and appended with one copy, after the other changes.
  const rawAdds = new Map<string, RawLine[]>();
  const appendRaw = (taskId: string) => {
    const adds = rawAdds.get(taskId);
    if (!adds) return;
    rawAdds.delete(taskId);
    const d = draft(taskId);
    d.raw = [...d.raw, ...adds].slice(-RAW_CAP);
  };
  for (const msg of batch) {
    const id = msg.taskId;
    switch (msg.type) {
      case "task.replay": {
        // Everything streamed so far, again (the view just opened, or the socket reconnected).
        // Raw lines have their own replay, so the ones already here stay.
        appendRaw(id);
        const next: LiveState = { ...emptyLive(), raw: live[id]?.raw ?? [] };
        for (const e of msg.events) applyEvent(next, e);
        drafts.set(id, next);
        live[id] = next;
        break;
      }
      case "task.raw-replay":
        rawAdds.delete(id);
        draft(id).raw = msg.raw.slice(-RAW_CAP);
        break;
      case "task.event":
        appendRaw(id); // keep raw lines and events in arrival order
        applyEvent(draft(id), msg.event);
        break;
      case "task.raw": {
        const adds = rawAdds.get(id);
        if (adds) adds.push(msg.raw);
        else rawAdds.set(id, [msg.raw]);
        break;
      }
      case "task.status":
        draft(id).lastStatus = { status: msg.status, detail: msg.detail };
        break;
    }
  }
  for (const id of [...rawAdds.keys()]) appendRaw(id);
  // Unchanged items keep their array, so views selecting them don't re-render for a status or raw line.
  for (const [id, d] of drafts) {
    const before = state.live[id];
    if (before && d.items.length === before.items.length && d.items.every((item, i) => item === before.items[i])) {
      d.items = before.items;
    }
  }
  setState({ live });
}

/** A task's view closed: forget its output (re-sent as a replay when it opens again). */
function dropLive(taskId: string) {
  liveTasks.delete(taskId);
  if (!(taskId in state.live)) return;
  const live = { ...state.live };
  delete live[taskId];
  setState({ live });
}

/** A task's raw view closed: forget its raw lines (thousands of long strings). */
function dropRaw(taskId: string) {
  rawTasks.delete(taskId);
  const current = state.live[taskId];
  if (!current || current.raw.length === 0) return;
  setState({ live: { ...state.live, [taskId]: { ...current, raw: [] } } });
}

// ── Notifications ───────────────────────────────────────────────────────────

function notify(title: string, body: string) {
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
      case "task.event":
      case "task.raw-replay":
      case "task.raw":
      case "task.status":
        queueLive(msg);
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
    liveTasks.add(taskId);
    if (count === 0) this.persist(`task:${taskId}`, { type: "subscribe", topic: "task", taskId });
    return () => {
      const n = (this.taskRefs.get(taskId) ?? 1) - 1;
      if (n <= 0) {
        this.taskRefs.delete(taskId);
        this.unpersist(`task:${taskId}`);
        this.send({ type: "unsubscribe", topic: "task", taskId });
        dropLive(taskId);
      } else {
        this.taskRefs.set(taskId, n);
      }
    };
  }

  /** Receive a task's raw CLI lines (the ones kept so far, then new ones) until the returned function is called. */
  subscribeTaskRaw(taskId: string): () => void {
    rawTasks.add(taskId);
    this.persist(`raw:${taskId}`, { type: "subscribe", topic: "task-raw", taskId });
    return () => {
      this.unpersist(`raw:${taskId}`);
      this.send({ type: "unsubscribe", topic: "task-raw", taskId });
      dropRaw(taskId);
    };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}

export const ws = new WsClient();
