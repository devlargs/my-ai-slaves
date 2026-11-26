/**
 * Request bodies of the REST API (see api.ts for the routes). The server validates every body with
 * these schemas and the web app's types are inferred from them, so the two can't drift apart.
 */
import { z } from "zod";
import { ProviderId } from "./common";
import { LabelColor } from "./repos";

const PromptIds = z.array(z.string());

// ── Accounts ────────────────────────────────────────────────────────────────
/** POST /api/accounts */
export const CreateAccountRequest = z.object({
  label: z.string(),
  provider: ProviderId,
  /** SSH host for an account that uses that server's own login; omit for this Mac. */
  host: z.string().min(1).nullable().optional(),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

/** PUT /api/accounts/order, /api/tasks/order, /api/prompts/order, /api/repos/:id/prompts/order */
export const ReorderRequest = z.object({ ids: z.array(z.string()) });
export type ReorderRequest = z.infer<typeof ReorderRequest>;

/** PUT /api/visibility: hide or show one repo or one subscription (Settings → Security). */
export const SetVisibilityRequest = z.object({
  kind: z.enum(["repo", "account"]),
  id: z.string().min(1),
  hidden: z.boolean(),
});
export type SetVisibilityRequest = z.infer<typeof SetVisibilityRequest>;

/** POST /api/logins/:loginId/code */
export const LoginCodeRequest = z.object({ code: z.string() });
export type LoginCodeRequest = z.infer<typeof LoginCodeRequest>;

// ── Repos ───────────────────────────────────────────────────────────────────
/** POST /api/repos */
export const RegisterRepoRequest = z.object({
  path: z.string(),
  /** SSH host from ~/.ssh/config; omit for a repo on this Mac. */
  host: z.string().min(1).nullable().optional(),
});
export type RegisterRepoRequest = z.infer<typeof RegisterRepoRequest>;

/** PATCH /api/repos/:id */
export const UpdateRepoRequest = z.object({
  /** Display name in the app only (the folder isn't renamed). Empty string = back to the folder name. */
  name: z.string().optional(),
  defaultBranch: z.string().min(1).optional(),
  accountChain: z.array(z.string()).optional(),
  /** One of Settings' committers; null = the default committer. */
  committerId: z.string().max(100).nullable().optional(),
  /** Replaces the repo's labels (trimmed, deduped case-insensitively, blanks dropped). */
  labels: z.array(z.string().max(40)).max(20).optional(),
});
export type UpdateRepoRequest = z.infer<typeof UpdateRepoRequest>;

/** PUT /api/label-colors */
export const SetLabelColorRequest = z.object({
  label: z.string().max(40),
  /** "gray" (or null) = back to the plain pill. */
  color: LabelColor.nullable(),
});
export type SetLabelColorRequest = z.infer<typeof SetLabelColorRequest>;

/** POST /api/repos/:id/scripts/run | /scripts/stop */
export const ScriptRequest = z.object({ script: z.string().min(1) });
export type ScriptRequest = z.infer<typeof ScriptRequest>;

// ── Git (the graph view; only run on a click) ───────────────────────────────
/** fetch = `git fetch --all --prune`; pull-ff = merge, fast-forward if possible; pull-ff-only; pull-rebase. */
export const PullMode = z.enum(["fetch", "pull-ff", "pull-ff-only", "pull-rebase"]);
export type PullMode = z.infer<typeof PullMode>;

const RefName = z.string().min(1).max(250);
const Sha = z.string().regex(/^[0-9a-f]{40,64}$/i);
const StashIndex = z.number().int().min(0).max(100_000);
const LongText = z.string().max(100_000);

/** POST /api/repos/:id/git/pull */
export const GitPullRequest = z.object({ mode: PullMode });
export type GitPullRequest = z.infer<typeof GitPullRequest>;

/** POST /api/repos/:id/git/branch (creates it at HEAD and checks it out) */
export const GitBranchRequest = z.object({ name: RefName });
export type GitBranchRequest = z.infer<typeof GitBranchRequest>;

/** POST /api/repos/:id/git/stage | /git/unstage: null = every change; paths relative to the repo root, taken literally. */
export const GitPathsRequest = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(20_000).nullable() });
export type GitPathsRequest = z.infer<typeof GitPathsRequest>;

/** POST /api/repos/:id/git/commit (commits what's staged) */
export const GitCommitRequest = z.object({
  /** First line of the message. */
  summary: z.string().min(1).max(1000),
  /** The message body, after a blank line. */
  description: LongText.optional(),
  /** Replace the last commit instead of adding one. */
  amend: z.boolean().optional(),
  /** Skip the repo's commit hooks. */
  noVerify: z.boolean().optional(),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

export const RebaseAction = z.enum(["pick", "reword", "squash", "fixup", "drop"]);
export type RebaseAction = z.infer<typeof RebaseAction>;

/** One line of an interactive rebase, in the order the commits are replayed (oldest first). */
export const RebaseStep = z.object({
  hash: Sha,
  action: RebaseAction,
  /** New message for "reword". */
  message: LongText.optional(),
});
export type RebaseStep = z.infer<typeof RebaseStep>;

/**
 * The graph's right-click menu on a branch or commit (like GitKraken's). Only run on a click, refused
 * with 409 while a task runs in the repo. A rebase, cherry-pick or revert that stops on a conflict
 * is aborted, so the repo is left as it was. A merge that stops on conflicts is left in progress:
 * resolve the files (staging one marks it resolved), then commit it, or abort it with `merge-abort`.
 * POST /api/repos/:id/git/ref GitRefAction → GitActionResult
 *
 * `branch` = a local branch name ("main"); `ref` = a local branch or a remote-tracking ref
 * ("origin/main"); `commit` = a full commit hash.
 */
export const GitRefAction = z.discriminatedUnion("op", [
  /** Fast-forward a local branch to its upstream (the checked-out one is pulled, fast-forward if possible). */
  z.object({ op: z.literal("pull"), branch: RefName }),
  /** Push a local branch to its upstream, or to the given remote (and set it as upstream) when it has none. */
  z.object({ op: z.literal("push"), branch: RefName, remote: RefName.optional() }),
  /** "origin/main": tracks it when it exists, else pushes the branch there and tracks it. */
  z.object({ op: z.literal("set-upstream"), branch: RefName, upstream: RefName }),
  /** Merge `ref` into the checked-out branch. */
  z.object({ op: z.literal("merge"), ref: RefName }),
  /** Abort the merge in progress (`git merge --abort`): the repo goes back to how it was before it. */
  z.object({ op: z.literal("merge-abort") }),
  /** Rebase the checked-out branch onto `ref`. */
  z.object({ op: z.literal("rebase"), ref: RefName }),
  /** Rebase the checked-out branch onto `ref`, with the commits reordered / squashed / reworded / dropped. */
  z.object({ op: z.literal("interactive-rebase"), ref: RefName, steps: z.array(RebaseStep).min(1).max(2000) }),
  /** Check out a local branch; a remote one gets a local tracking branch (or checks out the existing one). */
  z.object({ op: z.literal("checkout"), ref: RefName }),
  /** A new branch at `commit`, checked out. */
  z.object({ op: z.literal("create-branch"), name: RefName, commit: Sha }),
  z.object({ op: z.literal("cherry-pick"), commit: Sha }),
  /** Move the checked-out branch to `commit` (hard = local changes are thrown away). */
  z.object({ op: z.literal("reset"), commit: Sha, mode: z.enum(["soft", "mixed", "hard"]) }),
  z.object({ op: z.literal("revert"), commit: Sha }),
  z.object({ op: z.literal("rename-branch"), branch: RefName, name: RefName }),
  /** Delete a local branch (even when unmerged), or a remote one (`git push <remote> --delete`). */
  z.object({ op: z.literal("delete-branch"), ref: RefName, remote: z.boolean().optional() }),
  /** A lightweight tag, or an annotated one when `message` is given. */
  z.object({ op: z.literal("tag"), name: RefName, commit: Sha, message: LongText.optional() }),
  /**
   * The sidebar's Stashes menu. `stash` = the stash commit's hash (checked against `index`, so a list
   * that changed meanwhile is refused). Apply keeps the stash, Pop drops it once it applied cleanly.
   */
  /** The toolbar's Stash: every uncommitted change (untracked files too) goes into a new stash@{0}. */
  z.object({ op: z.literal("stash-save"), message: LongText.optional() }),
  z.object({ op: z.literal("stash-apply"), index: StashIndex, stash: Sha, pop: z.boolean().optional() }),
  z.object({ op: z.literal("stash-drop"), index: StashIndex, stash: Sha }),
  /** New message for a stash (it moves to the top of the list, stash@{0}). */
  z.object({ op: z.literal("stash-rename"), index: StashIndex, stash: Sha, message: z.string().min(1).max(100_000) }),
]);
export type GitRefAction = z.infer<typeof GitRefAction>;

// ── Prompts ─────────────────────────────────────────────────────────────────
/** POST /api/prompts */
export const CreatePromptRequest = z.object({
  name: z.string().max(120),
  body: z.string().max(200_000),
  /** Uploaded attachments (POST /api/attachments) sent with the prompt; on an update, replaces them. */
  attachmentIds: z.array(z.string()).optional(),
});
export type CreatePromptRequest = z.infer<typeof CreatePromptRequest>;
/** PATCH /api/prompts/:id */
export const UpdatePromptRequest = CreatePromptRequest.partial();
export type UpdatePromptRequest = z.infer<typeof UpdatePromptRequest>;

/** POST /api/repos/:id/prompts */
export const CreateRepoPromptRequest = CreatePromptRequest.extend({
  /** Pre-ticked when you queue a task on this repo. */
  default: z.boolean().optional(),
});
export type CreateRepoPromptRequest = z.infer<typeof CreateRepoPromptRequest>;
/** PATCH /api/repos/:id/prompts/:promptId */
export const UpdateRepoPromptRequest = CreateRepoPromptRequest.partial();
export type UpdateRepoPromptRequest = z.infer<typeof UpdateRepoPromptRequest>;

// ── Tasks ───────────────────────────────────────────────────────────────────
/** POST /api/prompt/preview: what a task with these choices would send. */
export const PromptPreviewRequest = z.object({
  repo: z.string(),
  message: z.string(),
  /** Ids from POST /api/attachments. */
  attachmentIds: z.array(z.string()).optional(),
  /** Saved prompts to bind (ids from GET /api/prompts). */
  promptIds: PromptIds.optional(),
  /** The repo's prompts to send (ids from GET /api/repos/:id/prompts); omitted = the repo's default ones. */
  repoPromptIds: PromptIds.optional(),
  /** Other repos (same machine as `repo`) opened in the same run, as they are: no branch handling. */
  extraRepos: z.array(z.string()).optional(),
  /** Per other repo, its prompts to send (they say how to handle changes there); left out = its defaults. */
  extraRepoPromptIds: z.record(z.string(), PromptIds).optional(),
});
export type PromptPreviewRequest = z.infer<typeof PromptPreviewRequest>;

/** POST /api/tasks */
export const CreateTaskRequest = PromptPreviewRequest.extend({
  accountOverride: z.string().nullable().optional(),
  /** Save it as a draft: it sits in the queue and never runs until it's loaded back and queued. */
  draft: z.boolean().optional(),
  /** The draft this replaces (it was loaded into the composer): removed in the same step. */
  replacesDraft: z.string().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

/** POST /api/tasks/:id/reply */
export const ReplyRequest = z.object({
  message: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  promptIds: PromptIds.optional(),
});
export type ReplyRequest = z.infer<typeof ReplyRequest>;

/** POST /api/tasks/:id/discard */
export const DiscardRequest = z.object({ confirm: z.literal(true) });
export type DiscardRequest = z.infer<typeof DiscardRequest>;

// ── Ask mode ────────────────────────────────────────────────────────────────
/** POST /api/ask: a new chat with its first question (runs at once). */
export const CreateAskRequest = z.object({
  message: z.string(),
  repo: z.string().min(1).nullable().optional(),
  accountOverride: z.string().min(1).nullable().optional(),
});
export type CreateAskRequest = z.infer<typeof CreateAskRequest>;

/** POST /api/ask/:id/messages: a follow-up in the same session. */
export const AskFollowUpRequest = z.object({ message: z.string() });
export type AskFollowUpRequest = z.infer<typeof AskFollowUpRequest>;

/** PATCH /api/ask/:id */
export const UpdateAskRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  accountOverride: z.string().min(1).nullable().optional(),
});
export type UpdateAskRequest = z.infer<typeof UpdateAskRequest>;
