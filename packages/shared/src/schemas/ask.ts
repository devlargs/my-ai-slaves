import { z } from "zod";
import { Timestamp, timestampNow } from "./common";
import { TaskSession } from "./queue";

/**
 * Ask mode (`.data/ask.json`): chats for questions, not tasks. A chat needs no repo (it runs in a
 * scratch folder, `.data/ask/`); one can be attached so the agent can read it. Runs are read-only
 * (Claude in plan mode without its edit tools, Cursor in ask mode) and send only your message.
 */
export const AskChatStatus = z.enum(["idle", "running"]);
export type AskChatStatus = z.infer<typeof AskChatStatus>;

export const AskMessage = z.object({
  at: Timestamp,
  /** `error`: the run failed or was stopped; shown in the chat, never sent. */
  role: z.enum(["user", "assistant", "error"]),
  text: z.string(),
  /** The account that answered (assistant / error messages). */
  account: z.string().nullable().default(null),
});
export type AskMessage = z.infer<typeof AskMessage>;

export const AskChat = z.object({
  id: z.string().regex(/^ask_\d{4,}_[a-z0-9-]*$/),
  title: z.string(),
  /** A repo the agent may read (it runs there); null = no repo. */
  repo: z.string().nullable().default(null),
  /** Use this account first; null = any (the repo's chain, or every account on this Mac). */
  accountOverride: z.string().nullable().default(null),
  status: AskChatStatus.default("idle"),
  currentAccount: z.string().nullable().default(null),
  session: TaskSession.nullable().default(null),
  messages: z.array(AskMessage).default([]),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type AskChat = z.infer<typeof AskChat>;

export const AskFile = z.object({
  nextChatNumber: z.int().min(1).default(1),
  chats: z.array(AskChat).default([]),
});
export type AskFile = z.infer<typeof AskFile>;
