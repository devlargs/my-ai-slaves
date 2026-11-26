import { mkdir } from "node:fs/promises";
import {
  type Account,
  type AskChat,
  type AskChatView,
  type AskMessage,
  type CreateAskRequest,
  formatLocalIso,
  type Repo,
  type StreamEvent,
  type UpdateAskRequest,
} from "@my-ai-slaves/shared";
import type { AdapterRegistry } from "../providers";
import { preview } from "../providers/spawn";
import type { RunHandle, RunResult } from "../providers/types";
import type { NewActivityEntry } from "../storage/activity-log";
import type { DataStores } from "../storage/data-stores";
import type { AccountService } from "./account-service";
import { pickAccount } from "./account-router";
import { badRequest, type Broadcaster, conflict, notFound, shortTime, slugify } from "./common";
import { type OutputBuffer, pushRawCapped } from "./queue-service";
import type { RepoService } from "./repo-service";
import { chatHidden, readHidden } from "./visibility";

/** Activity entries of a chat without a repo are logged under this name. */
export const ASK_ACTIVITY_REPO = "ask";
/** Chat ids start with this; the WebSocket `task` topic serves both tasks and chats by id. */
export const ASK_ID_PREFIX = "ask_";
const EVENT_LIMIT = 5000;

export interface AskDeps {
  stores: DataStores;
  accounts: AccountService;
  repos: RepoService;
  adapters: AdapterRegistry;
  broadcaster: Broadcaster;
  now?: () => Date;
}

interface LiveAsk {
  chatId: string;
  account: Account;
  handle: RunHandle;
  isFollowUp: boolean;
  /** Accounts already tried for this question (a limit moves on to the next one). */
  tried: Set<string>;
  /** Assistant text seen in this run, used when the CLI's final result is empty. */
  text: string;
}

/**
 * Ask mode: chats for questions, separate from the task queue. A question runs at once (it doesn't
 * wait for a queue slot or a repo), read-only, on the first free account: the chat's account, else
 * the attached repo's chain, else every account on this Mac in Settings order. Follow-ups resume
 * the chat's CLI session. The CLI receives only your message: no base or repo prompts, no app text.
 */
export class AskService {
  private readonly live = new Map<string, LiveAsk>();
  /** Chats being set up (account picked, CLI not attached yet): a second message is refused meanwhile. */
  private readonly starting = new Set<string>();
  private readonly buffers = new Map<string, OutputBuffer>();
  private readonly now: () => Date;

  constructor(private readonly deps: AskDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get stores() {
    return this.deps.stores;
  }

  private stamp(): string {
    return formatLocalIso(this.now());
  }

  private log(entry: NewActivityEntry): void {
    this.stores.activity.append(entry).catch((error) => console.error(`[activity] ${(error as Error).message}`));
  }

  /** Chats that were answering when the server stopped are idle again, with a note in the chat. */
  async init(): Promise<void> {
    await this.stores.ask.update((f) => {
      for (const chat of f.chats) {
        if (chat.status !== "running") continue;
        chat.status = "idle";
        chat.currentAccount = null;
        chat.messages.push({ at: this.stamp(), role: "error", text: "The app stopped before this was answered. Ask again.", account: null });
      }
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.values()].map((run) => run.handle.cancel().catch(() => {})));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  static isChatId(id: string): boolean {
    return id.startsWith(ASK_ID_PREFIX);
  }

  /** The chat that is running on the account right now (account deletion is refused meanwhile). */
  chatUsingAccount(accountId: string): string | null {
    for (const run of this.live.values()) if (run.account.id === accountId) return run.chatId;
    return null;
  }

  private toView(chat: AskChat): AskChatView {
    const { messages, ...rest } = chat;
    const last = messages.at(-1);
    return {
      ...rest,
      messageCount: messages.length,
      preview: last ? preview(last.text, 120) : "",
    };
  }

  async list(): Promise<AskChatView[]> {
    const hidden = await readHidden(this.stores);
    // Chats on a hidden repo or subscription (Settings → Security) are left out.
    const chats = (await this.stores.ask.read()).chats.filter((c) => !chatHidden(c, hidden));
    return [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).map((c) => this.toView(c));
  }

  private async getChat(id: string): Promise<AskChat> {
    const chat = (await this.stores.ask.read()).chats.find((c) => c.id === id);
    if (!chat) throw notFound(`Chat "${id}" doesn't exist.`);
    return chat;
  }

  /** Everything the chat's view shows: its saved messages, then whatever streamed since the server started. */
  replay(chatId: string): OutputBuffer {
    return this.buffers.get(chatId) ?? { events: [], raw: [], rawChars: 0 };
  }

  private async bufferOf(chat: AskChat): Promise<OutputBuffer> {
    let buffer = this.buffers.get(chat.id);
    if (!buffer) {
      buffer = { events: messagesToEvents(chat.messages), raw: [], rawChars: 0 };
      this.buffers.set(chat.id, buffer);
    }
    return buffer;
  }

  /** Seed every chat's view from its saved messages (once, on startup), so a replay shows the history. */
  async loadBuffers(): Promise<void> {
    for (const chat of (await this.stores.ask.read()).chats) await this.bufferOf(chat);
  }

  async publish(): Promise<void> {
    this.deps.broadcaster.askUpdated(await this.list());
  }

  private async updateChat(id: string, change: (c: AskChat) => void): Promise<AskChat> {
    let updated: AskChat | undefined;
    await this.stores.ask.update((f) => {
      updated = f.chats.find((c) => c.id === id);
      if (!updated) throw notFound(`Chat "${id}" doesn't exist.`);
      change(updated);
      updated.updatedAt = this.stamp();
    });
    return updated as AskChat;
  }

  private push(chatId: string, buffer: OutputBuffer, event: StreamEvent): void {
    const last = buffer.events.at(-1);
    if (event.kind === "text-delta" && last?.kind === "text-delta") {
      buffer.events[buffer.events.length - 1] = { ...last, text: last.text + event.text };
    } else {
      buffer.events.push(event);
      if (buffer.events.length > EVENT_LIMIT) buffer.events.splice(0, buffer.events.length - EVENT_LIMIT);
    }
    this.deps.broadcaster.taskEvent(chatId, event);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async create(req: CreateAskRequest): Promise<AskChatView> {
    const message = req.message ?? "";
    if (!message.trim()) throw badRequest("The question is empty.");
    const repo = req.repo ? await this.deps.repos.get(req.repo) : null;
    const override = req.accountOverride || null;
    if (override && (await this.deps.accounts.get(override)).hidden) throw notFound(`No account "${override}".`);
    const firstLine = message.trim().split("\n")[0] ?? "";
    const title = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    const slug = slugify(firstLine.split(/\s+/).slice(0, 6).join(" ")) || "chat";
    let chat: AskChat | undefined;
    await this.stores.ask.update((f) => {
      const stamp = this.stamp();
      chat = {
        id: `${ASK_ID_PREFIX}${String(f.nextChatNumber).padStart(4, "0")}_${slug}`,
        title,
        repo: repo?.id ?? null,
        accountOverride: override,
        status: "idle",
        currentAccount: null,
        session: null,
        messages: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      f.nextChatNumber += 1;
      f.chats.push(chat);
    });
    const created = chat as AskChat;
    await this.ask(created.id, message);
    return this.toView(await this.getChat(created.id));
  }

  /** A question in the chat (the first one, or a follow-up that resumes its session). Runs at once. */
  async ask(id: string, message: string): Promise<void> {
    if (!message.trim()) throw badRequest("The question is empty.");
    if (this.live.has(id) || this.starting.has(id)) throw conflict("This chat is still answering. Wait for it, or stop it.");
    this.starting.add(id);
    try {
      // A new buffer is seeded from the saved messages (this one included); an existing one gets it added.
      const hadBuffer = this.buffers.has(id);
      const chat = await this.updateChat(id, (c) => {
        if (c.status === "running") throw conflict("This chat is still answering. Wait for it, or stop it.");
        c.messages.push({ at: this.stamp(), role: "user", text: message, account: null });
        c.status = "running";
      });
      const buffer = await this.bufferOf(chat);
      const sent = userEvent(message, chat.messages.filter((m) => m.role === "user").length > 1);
      if (hadBuffer) this.push(id, buffer, sent);
      else this.deps.broadcaster.taskEvent(id, sent);
      await this.publish();
      await this.start(chat, message, new Set());
    } finally {
      this.starting.delete(id);
    }
  }

  /** The accounts a chat may run on, in order, and the machine they must be on. */
  private async candidates(chat: AskChat, repo: Repo | null): Promise<{ ids: string[]; host: string | null }> {
    const accounts = await this.deps.accounts.listRaw();
    // Hidden accounts (Settings → Security) are skipped, as if they weren't in the chain.
    const shown = (list: (string | null)[]) => list.filter((id): id is string => !!id && !accounts.some((a) => a.id === id && a.hidden));
    if (repo) return { ids: shown([chat.accountOverride, ...repo.accountChain]), host: repo.host ?? null };
    return { ids: shown([chat.accountOverride, ...accounts.filter((a) => !a.host).map((a) => a.id)]), host: null };
  }

  private async start(chat: AskChat, message: string, tried: Set<string>): Promise<void> {
    const logRepo = chat.repo ?? ASK_ACTIVITY_REPO;
    const fail = async (text: string, account: string | null = null) => {
      await this.finishWith(chat.id, { role: "error", text, account }, (c) => {
        c.status = "idle";
        c.currentAccount = null;
      });
    };
    let repo: Repo | null = null;
    if (chat.repo) {
      repo = (await this.deps.repos.list()).find((r) => r.id === chat.repo) ?? null;
      if (!repo) return fail(`Repo "${chat.repo}" is no longer registered. Start a new chat.`);
    }
    await this.deps.accounts.expireLimits();
    const { ids, host } = await this.candidates(chat, repo);
    const isFollowUp = chat.session !== null;
    const pick = pickAccount({
      candidates: ids,
      accounts: await this.deps.accounts.listRaw(),
      now: this.now(),
      // A follow-up resumes the session, so it needs the same CLI.
      provider: chat.session?.provider,
      host,
      exclude: tried,
    });
    if (pick.kind === "wait") {
      const reason = ids.length === 0 ? "No accounts yet. Add one on the Settings page." : pick.reason;
      return fail(pick.until ? `${reason} Next one frees up at ${shortTime(pick.until, this.now())}.` : reason);
    }
    const account = pick.account;
    if (this.deps.accounts.isRemoving(account.id)) return fail(`${account.id} is being deleted. Ask again.`);
    tried.add(account.id);

    try {
      const settings = await this.stores.settings.read();
      const cwd = repo ? repo.path : this.stores.paths.askDir;
      if (!repo) await mkdir(cwd, { recursive: true });
      await this.updateChat(chat.id, (c) => {
        c.currentAccount = account.id;
      });
      let resume: { sessionId: string; fromConfigDir: string | null } | null = null;
      if (chat.session) {
        const from = (await this.deps.accounts.listRaw()).find((a) => a.id === chat.session?.account);
        resume = {
          sessionId: chat.session.sessionId,
          fromConfigDir: this.deps.accounts.configDirOf(from ?? account),
        };
      }
      // Every started run is logged with exactly what the CLI receives: here, only your message.
      this.log({
        taskId: chat.id,
        repo: logRepo,
        account: account.id,
        event: "started",
        detail: `Ask on ${account.id} (${account.provider})${isFollowUp ? ", continuing the chat" : ""}`,
        data: { prompt: message, kind: isFollowUp ? "reply" : "fresh", mode: "ask", cwd, title: chat.title },
      });
      const adapter = this.deps.adapters[account.provider];
      await adapter.prepare?.(this.deps.accounts.context(account), settings);
      const handle = adapter.run(
        { ...this.deps.accounts.context(account), prompt: message, cwd, resume, addDirs: [], readOnly: true },
        settings,
      );
      const run: LiveAsk = { chatId: chat.id, account, handle, isFollowUp, tried, text: "" };
      this.live.set(chat.id, run);
      const buffer = await this.bufferOf(chat);
      handle.onStream((event) => {
        if (event.kind === "message") run.text = run.text ? `${run.text}\n\n${event.text}` : event.text;
        this.push(chat.id, buffer, event);
      });
      handle.onRaw((raw) => {
        pushRawCapped(buffer, raw);
        this.deps.broadcaster.taskRaw(chat.id, raw);
      });
      this.deps.broadcaster.taskStatus(chat.id, "running", `Answering on ${account.id}`);
      await this.publish();
      handle.done
        .catch((error): RunResult => ({ outcome: "failed", exitCode: null, message: String(error), stderrTail: "" }))
        .then((result) => this.finishRun(run, message, result))
        .catch((error) => console.error(`[ask] finishing ${chat.id}: ${(error as Error).stack ?? error}`));
    } catch (error) {
      this.live.delete(chat.id);
      await fail(`Couldn't start: ${(error as Error).message}`, account.id);
    }
  }

  /** Save a message, show it in the chat (an answer already streamed is only saved), publish. */
  private async finishWith(id: string, msg: Omit<AskMessage, "at"> | null, change: (c: AskChat) => void, streamed = false): Promise<void> {
    const chat = await this.updateChat(id, (c) => {
      change(c);
      if (msg) c.messages.push({ ...msg, at: this.stamp() });
    }).catch(() => null);
    if (!chat) return; // deleted meanwhile
    if (msg && !streamed) {
      const buffer = await this.bufferOf(chat);
      this.push(id, buffer, msg.role === "error" ? { kind: "warning", text: msg.text } : { kind: "message", text: msg.text });
    }
    await this.publish();
  }

  private async finishRun(run: LiveAsk, message: string, result: RunResult): Promise<void> {
    this.live.delete(run.chatId);
    const chat = (await this.stores.ask.read()).chats.find((c) => c.id === run.chatId);
    if (!chat) return; // deleted while it ran
    const account = run.account;
    const base = { taskId: chat.id, repo: chat.repo ?? ASK_ACTIVITY_REPO, account: account.id };
    const usage = result.usage ? { usage: result.usage } : {};
    const session = (sessionId: string | null) => (sessionId ? { provider: account.provider, account: account.id, sessionId } : null);

    switch (result.outcome) {
      case "success": {
        const answer = result.resultText.trim() || run.text.trim();
        this.log({ ...base, event: "message", detail: "Answered.", data: { result: answer, costUsd: result.costUsd, ...usage } });
        // The answer already streamed as text/message events: saved, not shown twice.
        await this.finishWith(
          chat.id,
          { role: "assistant", text: answer || "(no answer)", account: account.id },
          (c) => {
            c.status = "idle";
            c.session = session(result.sessionId) ?? c.session;
          },
          run.text.trim().length > 0,
        );
        return;
      }
      case "limit":
      case "logged-out": {
        const reason = result.outcome === "limit" ? result.limit.reason : result.message;
        if (result.outcome === "limit") {
          await this.deps.accounts.markLimited(account.id, result.limit.resetsAt, reason);
          this.log({ ...base, event: "limit-hit", detail: `${account.id} hit a usage limit (${reason}).`, data: { resetsAt: result.limit.resetsAt, ...usage } });
        } else {
          await this.deps.accounts.markLoggedOut(account.id);
          this.log({ ...base, event: "warning", detail: `${account.id} is logged out (${reason}).`, data: usage });
        }
        const buffer = await this.bufferOf(chat);
        this.push(chat.id, buffer, { kind: "warning", text: `${account.id} ${result.outcome === "limit" ? "hit a usage limit" : "is logged out"}: trying the next account.` });
        // The same question on the next account (a first question starts a new session there).
        const fresh = await this.updateChat(chat.id, (c) => {
          if (!run.isFollowUp) c.session = null;
        });
        await this.start(fresh, message, run.tried);
        return;
      }
      case "cancelled": {
        this.log({ ...base, event: "warning", detail: "Stopped by you.", data: usage });
        await this.finishWith(chat.id, { role: "error", text: "Stopped.", account: account.id }, (c) => {
          c.status = "idle";
          c.session = session(result.sessionId) ?? c.session;
        });
        return;
      }
      case "failed": {
        this.log({ ...base, event: "warning", detail: `Ask failed: ${result.message.slice(0, 500)}`, data: { exitCode: result.exitCode, stderrTail: result.stderrTail, ...usage } });
        await this.finishWith(chat.id, { role: "error", text: `Failed: ${result.message.slice(0, 500)}`, account: account.id }, (c) => {
          c.status = "idle";
        });
        return;
      }
    }
  }

  async stop(id: string): Promise<void> {
    const run = this.live.get(id);
    if (!run) throw conflict("This chat isn't answering.");
    await run.handle.cancel();
  }

  async update(id: string, patch: UpdateAskRequest): Promise<AskChatView> {
    if (patch.accountOverride && (await this.deps.accounts.get(patch.accountOverride)).hidden) {
      throw notFound(`No account "${patch.accountOverride}".`);
    }
    const chat = await this.updateChat(id, (c) => {
      if (patch.title !== undefined) c.title = patch.title;
      if (patch.accountOverride !== undefined) c.accountOverride = patch.accountOverride;
    });
    await this.publish();
    return this.toView(chat);
  }

  /** Delete a chat (stopping it first if it's answering). Its activity entries stay. */
  async remove(id: string): Promise<void> {
    await this.getChat(id);
    await this.stores.ask.update((f) => {
      f.chats = f.chats.filter((c) => c.id !== id);
    });
    const run = this.live.get(id);
    if (run) await run.handle.cancel().catch(() => {});
    this.buffers.delete(id);
    await this.publish();
  }
}

const userEvent = (text: string, reply: boolean): StreamEvent => ({ kind: "user", text, reply, attachments: [], prompts: [] });

/** A chat's saved messages as the events its view draws (tool calls of earlier runs aren't kept). */
export function messagesToEvents(messages: AskMessage[]): StreamEvent[] {
  let asked = 0;
  return messages.map((m): StreamEvent => {
    if (m.role === "user") return userEvent(m.text, asked++ > 0);
    if (m.role === "error") return { kind: "warning", text: m.text };
    return { kind: "message", text: m.text };
  });
}
