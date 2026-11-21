import type {
  AccountView,
  ClientMessage,
  LoginState,
  QueuedTaskStatus,
  RawLine,
  ServerMessage,
  StreamEvent,
  TaskView,
} from "@my-ai-slaves/shared";
import type { WebSocket } from "ws";
import type { Broadcaster } from "../services/common";

interface Client {
  socket: WebSocket;
  queue: boolean;
  accounts: boolean;
  tasks: Set<string>;
  /** Tasks whose raw CLI lines this client is showing. */
  rawTasks: Set<string>;
}

export interface HubSources {
  listQueue(): Promise<TaskView[]>;
  listAccounts(): Promise<AccountView[]>;
  replay(taskId: string): { events: StreamEvent[]; raw: RawLine[] };
}

/** One WebSocket per browser tab: queue/account lists, login progress, task streams. */
export class WsHub implements Broadcaster {
  private readonly clients = new Set<Client>();
  private sources: HubSources | null = null;

  setSources(sources: HubSources): void {
    this.sources = sources;
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
  }

  /** Serialised once (not once per client), and not at all when nobody is listening. */
  private broadcast(filter: (c: Client) => boolean, message: ServerMessage): void {
    let json: string | null = null;
    for (const c of this.clients) {
      if (!filter(c) || c.socket.readyState !== c.socket.OPEN) continue;
      json ??= JSON.stringify(message);
      c.socket.send(json);
    }
  }

  handle(socket: WebSocket): void {
    const client: Client = { socket, queue: false, accounts: false, tasks: new Set(), rawTasks: new Set() };
    this.clients.add(client);
    socket.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      void this.onMessage(client, msg).catch((error) => console.error(`[ws] ${(error as Error).message}`));
    });
    socket.on("close", () => this.clients.delete(client));
  }

  private async onMessage(client: Client, msg: ClientMessage): Promise<void> {
    const sources = this.sources;
    if (!sources) return;
    if (msg.type === "unsubscribe") {
      // Closing a task's view also ends its raw lines.
      if (msg.topic === "task") client.tasks.delete(msg.taskId);
      client.rawTasks.delete(msg.taskId);
      return;
    }
    if (msg.topic === "queue") {
      client.queue = true;
      this.send(client, { type: "queue.updated", tasks: await sources.listQueue() });
    } else if (msg.topic === "accounts") {
      client.accounts = true;
      this.send(client, { type: "accounts.updated", accounts: await sources.listAccounts() });
    } else if (msg.topic === "task") {
      client.tasks.add(msg.taskId);
      this.send(client, { type: "task.replay", taskId: msg.taskId, events: sources.replay(msg.taskId).events });
    } else if (msg.topic === "task-raw") {
      client.rawTasks.add(msg.taskId);
      this.send(client, { type: "task.raw-replay", taskId: msg.taskId, raw: sources.replay(msg.taskId).raw });
    }
  }

  // ── Broadcaster ──────────────────────────────────────────────────────────
  queueUpdated(tasks: TaskView[]): void {
    this.broadcast((c) => c.queue, { type: "queue.updated", tasks });
  }
  accountsUpdated(accounts: AccountView[]): void {
    this.broadcast((c) => c.accounts, { type: "accounts.updated", accounts });
  }
  loginUpdated(login: LoginState): void {
    this.broadcast((c) => c.accounts, { type: "login.updated", login });
  }
  taskEvent(taskId: string, event: StreamEvent): void {
    this.broadcast((c) => c.tasks.has(taskId), { type: "task.event", taskId, event });
  }
  taskRaw(taskId: string, raw: RawLine): void {
    // Only to views showing raw output: with none open (the usual case) this costs nothing.
    this.broadcast((c) => c.rawTasks.has(taskId), { type: "task.raw", taskId, raw });
  }
  taskStatus(taskId: string, status: QueuedTaskStatus | "done" | "failed", detail: string | null): void {
    this.broadcast((c) => c.queue || c.tasks.has(taskId), { type: "task.status", taskId, status, detail });
  }
  notify(taskId: string, title: string, body: string): void {
    this.broadcast((c) => c.queue, { type: "notify", taskId, title, body });
  }
}
