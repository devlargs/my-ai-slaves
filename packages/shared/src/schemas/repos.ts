import { z } from "zod";
import { timestampNow } from "./common";

export const RepoSlug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);

export const Repo = z.object({
  id: RepoSlug,
  name: z.string().min(1),
  /** Absolute path to the repo's main working tree. */
  path: z.string().min(1),
  defaultBranch: z.string().min(1),
  /** Ordered account ids; first available one runs the task. */
  accountChain: z.array(z.string()).default([]),
  /** Author + committer for every commit on this repo's tasks (agent's and the app's). null = your git config. */
  committerName: z.string().min(1).nullable().default(null),
  committerEmail: z.email().nullable().default(null),
  createdAt: timestampNow(),
  updatedAt: timestampNow(),
});
export type Repo = z.infer<typeof Repo>;

export const ReposFile = z.object({
  repos: z.array(Repo).default([]),
});
export type ReposFile = z.infer<typeof ReposFile>;

export const KnowledgeFile = z.object({
  repo: RepoSlug,
  basePrompt: z.string().default(""),
  updatedAt: timestampNow(),
});
export type KnowledgeFile = z.infer<typeof KnowledgeFile>;
