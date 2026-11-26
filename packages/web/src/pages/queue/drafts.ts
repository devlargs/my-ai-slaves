import type { TaskView } from "@my-ai-slaves/shared";
import { expandPastes, loadPastes } from "@/lib/pasted-text";
import { storageGet } from "@/lib/utils";

export const CHAIN = "__chain__";
export const REPO_KEY = "slaves.lastRepo";
export const EXTRA_REPOS_KEY = "slaves.lastExtraRepos";
/** The composer's last picked model and effort (Claude Code), kept for the next task. */
export const MODEL_KEY = "slaves.lastModel";
export const EFFORT_KEY = "slaves.lastEffort";
/** Select value for "no pick": the Settings model / the CLI's own effort. */
export const DEFAULT_PICK = "__default__";
/** Unsent text of a message box, kept so it survives switching pages (and restarts). */
export const draftKey = (box: string) => `slaves.draft.${box}`;
export const COMPOSER_DRAFT = "composer";
export const replyDraft = (taskId: string) => `reply.${taskId}`;
/** The box's text with every collapsed paste marker put back to the full pasted text. */
export const fullText = (text: string, box: string) => expandPastes(text, loadPastes(draftKey(box)));
export const readMessage = (input: React.RefObject<HTMLTextAreaElement | null>, box: string) =>
  fullText(input.current?.value ?? "", box);

export const promptCount = (task: TaskView) =>
  task.promptIds.length + (task.repoPromptIds?.length ?? 0) + task.extraRepos.reduce((n, x) => n + x.promptIds.length, 0);

export function storedExtras(): string[] {
  try {
    const list: unknown = JSON.parse(storageGet(EXTRA_REPOS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
