import { z } from "zod";
import { Attachment } from "./attachment";
import { timestampNow } from "./common";

/** A saved prompt you can bind to a task message or reply. Sent verbatim, no heading added. */
export const SavedPrompt = z.object({
  /** Slug of the name, e.g. `analyze-jira-ticket`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().min(1).max(120),
  body: z.string().default(""),
  /** Screenshots / files sent with the prompt (listed under "Attached files:" whenever it's sent). */
  attachments: z.array(Attachment).default([]),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type SavedPrompt = z.infer<typeof SavedPrompt>;

/** `.data/prompts.json`. Array order is the library order (and the order bound prompts are sent in). */
export const PromptsFile = z.object({
  prompts: z.array(SavedPrompt).default([]),
});
export type PromptsFile = z.infer<typeof PromptsFile>;
