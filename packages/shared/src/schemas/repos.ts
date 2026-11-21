import { z } from "zod";
import { timestampNow } from "./common";
import { SavedPrompt } from "./prompts";

export const RepoSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);

export const Repo = z.object({
  id: RepoSlug,
  name: z.string().min(1),
  /** SSH host (from ~/.ssh/config) the repo lives on; null = this Mac. */
  host: z.string().min(1).nullable().default(null),
  /** Absolute path to the repo on that machine. */
  path: z.string().min(1),
  defaultBranch: z.string().min(1),
  /** Ordered account ids; first available one runs the task. */
  accountChain: z.array(z.string()).default([]),
  /**
   * Author + committer for every commit on this repo's tasks: one of Settings' committers.
   * null (or a deleted one) = the default committer, else your git config.
   */
  committerId: z.string().min(1).nullable().default(null),
  /** Legacy per-repo identity; moved into Settings' committers on startup. */
  committerName: z.string().min(1).nullable().default(null),
  committerEmail: z.email().nullable().default(null),
  /** Your own tags for telling repos apart (e.g. "personal", "company"). App only; never sent to a CLI. */
  labels: z.array(z.string().min(1).max(40)).default([]),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type Repo = z.infer<typeof Repo>;

export const ReposFile = z.object({
  repos: z.array(Repo).default([]),
});
export type ReposFile = z.infer<typeof ReposFile>;

/**
 * One of a repo's prompts. You tick which ones a task sends; `default` ones come pre-ticked in the
 * composer. Sent as written, no heading added.
 */
export const RepoPrompt = SavedPrompt.extend({
  default: z.boolean().default(false),
});
export type RepoPrompt = z.infer<typeof RepoPrompt>;

/**
 * `.data/knowledge/<repo>.json`. Array order is the order bound repo prompts are sent in.
 * Older files held one `basePrompt` string: it becomes a "Base prompt" entry, ticked by default,
 * so nothing that used to be sent stops being sent.
 */
export const KnowledgeFile = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { basePrompt, ...rest } = raw as Record<string, unknown>;
    if (Array.isArray(rest.prompts) || typeof basePrompt !== "string") return rest;
    return {
      ...rest,
      prompts: basePrompt.trim() ? [{ id: "base-prompt", name: "Base prompt", body: basePrompt, default: true }] : [],
    };
  },
  z.object({
    repo: RepoSlug,
    prompts: z.array(RepoPrompt).default([]),
    updatedAt: timestampNow(),
  }),
);
export type KnowledgeFile = z.infer<typeof KnowledgeFile>;
