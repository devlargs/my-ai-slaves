import type { Attachment, Repo, RepoPrompt, SavedPrompt, StreamEvent, Task } from "@my-ai-slaves/shared";
import { type AssembledPrompt, assemblePrompt, assembleReply } from "./prompt-assembler";

/**
 * "What does this run send": everything a run's prompt, files and log entry are made of, worked out
 * from data that was already read (no I/O here, so the prompt rules in CLAUDE.md are tested directly).
 * QueueService reads the inputs, locates the files, then spawns the CLI with the plan.
 */

/** A cross-repo task's other repo and the prompt ids ticked for it. */
export interface ExtraRepo {
  repo: Repo;
  promptIds: string[];
}

/** One repo's ticked prompts, as resolved from its list (`knowledge/<repo>.json`). */
export interface ResolvedRepoPrompts {
  repo: string;
  prompts: RepoPrompt[];
  missing: string[];
}

export interface RunInputs {
  task: Task;
  isReply: boolean;
  extras: ExtraRepo[];
  /** `settings.json` → `basePrompt` (unused for a reply: its session already has it). */
  globalBase: string;
  /** The saved prompts bound to this message (the task's, or the latest reply's), current text. */
  bound: { prompts: SavedPrompt[]; missing: string[] };
  /** The main repo's ticked prompts first, then each other repo's, in the task's order. */
  repoPrompts: ResolvedRepoPrompts[];
  /** A reply's session may refer back to earlier files: the prompts bound to earlier messages. */
  earlierBound: SavedPrompt[];
}

/** A ticked repo prompt, tagged with the repo it belongs to. */
export interface TickedPrompt {
  repo: string;
  id: string;
  name: string;
  body: string;
  attachments: Attachment[];
}

export interface RunFiles {
  /** The repo prompts sent in this run (none for a reply). */
  repoSent: TickedPrompt[];
  /** Listed under "Attached files:": the ticked / bound prompts' files first, then the message's. */
  runFiles: Attachment[];
  /** Every file the run can read: this run's, and those of the task's earlier messages and prompts. */
  allFiles: Attachment[];
  /** Deleted prompts that were ticked or bound: logged as warnings, never sent. */
  warnings: string[];
}

export interface RunPlan extends RunFiles {
  assembled: AssembledPrompt;
  /** `--add-dir`: the other repos, then each attachment's folder (deduplicated). */
  addDirs: string[];
  /** Your side of the conversation, shown in the live output where this run starts. */
  sent: StreamEvent;
}

/** Where each attachment is on the machine the CLI runs on (`AttachmentStore.locate`). */
export type LocatedFiles = Map<string, { path: string; dir: string }>;

export function uniqueFiles(files: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  return files.filter((a) => !seen.has(a.id) && Boolean(seen.add(a.id)));
}

/** The files a run sends and can read, and the warnings for prompts that are gone. */
export function runFiles({ task, isReply, bound, repoPrompts, earlierBound }: RunInputs): RunFiles {
  const warnings: string[] = [];
  if (bound.missing.length) {
    warnings.push(`Saved prompt(s) no longer in the library, not sent: ${bound.missing.join(", ")}`);
  }
  // A reply's session already has the repo prompts: they're only read for their files, which stay readable.
  if (!isReply) {
    for (const r of repoPrompts) {
      if (r.missing.length) warnings.push(`Repo prompt(s) no longer in ${r.repo}'s list, not sent: ${r.missing.join(", ")}`);
    }
  }
  const repoTicked = repoPrompts.flatMap((r) =>
    r.prompts.map((p) => ({ repo: r.repo, id: p.id, name: p.name, body: p.body, attachments: p.attachments })),
  );
  const repoSent = isReply ? [] : repoTicked;
  // A prompt's files go with it, before the message's own (the same order as the text).
  const files = uniqueFiles([
    ...repoSent.flatMap((p) => p.attachments),
    ...bound.prompts.flatMap((p) => p.attachments),
    ...(isReply ? (task.replies.at(-1)?.attachments ?? []) : task.attachments),
  ]);
  const allFiles = uniqueFiles([
    ...files,
    ...task.attachments,
    ...task.replies.flatMap((r) => r.attachments),
    ...repoTicked.flatMap((p) => p.attachments),
    ...earlierBound.flatMap((p) => p.attachments),
  ]);
  return { repoSent, runFiles: files, allFiles, warnings };
}

/**
 * The run's prompt, extra directories and "you said" event. Throws `EmptyMessageError` when there is
 * nothing to send.
 */
export function planRun(inputs: RunInputs, located: LocatedFiles): RunPlan {
  const { task, isReply, extras, globalBase, bound } = inputs;
  const files = runFiles(inputs);
  const runPaths = files.runFiles.map((a) => located.get(a.id)?.path as string);
  const boundBodies = bound.prompts.map((p) => p.body);
  const message = isReply ? (task.pendingReply ?? "") : task.message;
  const assembled = isReply
    ? assembleReply(message, runPaths, boundBodies)
    : assemblePrompt({
        globalBase,
        repoPrompts: files.repoSent.map((p) => p.body),
        boundPrompts: boundBodies,
        message,
        otherRepos: extras.map((x) => ({ name: x.repo.name, path: x.repo.path })),
        attachmentPaths: runPaths,
      });
  const addDirs = [...new Set([...extras.map((x) => x.repo.path), ...files.allFiles.map((a) => located.get(a.id)?.dir as string)])];
  const sent: StreamEvent = {
    kind: "user",
    text: message,
    reply: isReply,
    attachments: files.runFiles.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
    prompts: [...files.repoSent.map((p) => p.name), ...bound.prompts.map((p) => p.name)],
  };
  return { ...files, assembled, addDirs, sent };
}
