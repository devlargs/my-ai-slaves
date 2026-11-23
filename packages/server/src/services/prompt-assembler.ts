/**
 * Builds the exact text sent to a CLI: no headings, no role text, no wrapper. The output is the
 * non-empty layers (global base → ticked repo prompts → bound saved prompts → message → other repos →
 * attachments), unchanged, joined by one blank line. The only app-written text is the two path lists:
 * the other repos' folders (only when a task spans several repos) and attached files (only when you
 * attach some).
 */

export type PromptLayerName = "global" | "repo" | "prompts" | "message" | "repos" | "attachments";

/** Another repo opened in the same run. */
export interface OtherRepo {
  name: string;
  path: string;
}

export interface PromptLayers {
  /** `settings.json` → `basePrompt` */
  globalBase: string;
  /** The repo's prompts ticked for this task (`.data/knowledge/<repo>.json`), in the repo's order. */
  repoPrompts?: string[];
  /** Saved prompts bound to this message, in library order: sent as written, joined by a blank line. */
  boundPrompts?: string[];
  /** What you typed for this task. */
  message: string;
  /** The task's other repos (cross-repo work): the CLI has to be told where they are. */
  otherRepos?: OtherRepo[];
  /** Absolute paths of files you attached (pasted / uploaded). */
  attachmentPaths?: string[];
}

export interface AssembledPrompt {
  prompt: string;
  layers: { name: PromptLayerName; included: boolean }[];
}

export const LAYER_SEPARATOR = "\n\n";

/**
 * The one piece of text the app writes itself, and only when you attach files: the CLI has to be
 * told where they are. It's a separate, visible layer in "Preview prompt".
 */
export function attachmentsLayer(paths: string[]): string {
  return paths.length ? `Attached files:\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
}

/**
 * App-written too, and only when a task spans several repos: where the other repos are. The CLI runs
 * in the main repo and gets each of these as an extra directory. A visible layer in "Preview prompt".
 */
export function otherReposLayer(repos: OtherRepo[]): string {
  return repos.length ? `Other repositories:\n${repos.map((r) => `- ${r.name}: ${r.path}`).join("\n")}` : "";
}

/** A layer that is empty or only whitespace is skipped entirely. */
const isBlank = (text: string) => text.trim() === "";

export class EmptyMessageError extends Error {
  constructor() {
    super("The task message is empty. Type a message or attach a file.");
  }
}

/** Several prompts in one layer: each sent as written, blank ones skipped, one blank line between. */
const joinBound = (bound: string[]) => bound.filter((b) => !isBlank(b)).join(LAYER_SEPARATOR);

export function assemblePrompt({
  globalBase,
  repoPrompts = [],
  boundPrompts = [],
  message,
  otherRepos = [],
  attachmentPaths = [],
}: PromptLayers): AssembledPrompt {
  // A pasted screenshot on its own is a valid task: the attachments list is then the message.
  if (isBlank(message) && attachmentPaths.length === 0) throw new EmptyMessageError();
  const ordered: [PromptLayerName, string][] = [
    ["global", globalBase],
    ["repo", joinBound(repoPrompts)],
    ["prompts", joinBound(boundPrompts)],
    ["message", message],
    ["repos", otherReposLayer(otherRepos)],
    ["attachments", attachmentsLayer(attachmentPaths)],
  ];
  return {
    prompt: ordered
      .filter(([, text]) => !isBlank(text))
      .map(([, text]) => text)
      .join(LAYER_SEPARATOR),
    layers: ordered.map(([name, text]) => ({ name, included: !isBlank(text) })),
  };
}

/**
 * A follow-up reply to a task resumes a session that already received the base prompts,
 * so only the reply itself is sent.
 */
export function assembleReply(message: string, attachmentPaths: string[] = [], boundPrompts: string[] = []): AssembledPrompt {
  if (isBlank(message) && attachmentPaths.length === 0) throw new EmptyMessageError();
  const bound = joinBound(boundPrompts);
  const files = attachmentsLayer(attachmentPaths);
  return {
    prompt: [bound, message, files].filter((t) => !isBlank(t)).join(LAYER_SEPARATOR),
    layers: [
      { name: "global", included: false },
      { name: "repo", included: false },
      { name: "prompts", included: bound !== "" },
      { name: "message", included: !isBlank(message) },
      { name: "repos", included: false },
      { name: "attachments", included: files !== "" },
    ],
  };
}

export interface BasePromptSources {
  globalBasePrompt(): Promise<string>;
}

/** Reads the global base prompt at call time, so edits apply to the next task you queue. */
export class PromptAssembler {
  constructor(private readonly sources: BasePromptSources) {}

  /** The global base prompt's current text. */
  globalBase(): Promise<string> {
    return this.sources.globalBasePrompt();
  }

  /** `repoPrompts` / `boundPrompts`: the current text of the prompts ticked for this task. */
  async forTask(message: string, layers: Omit<PromptLayers, "globalBase" | "message"> = {}): Promise<AssembledPrompt> {
    const globalBase = await this.sources.globalBasePrompt();
    return assemblePrompt({ ...layers, globalBase, message });
  }

  forReply(message: string, attachmentPaths: string[] = [], boundPrompts: string[] = []): AssembledPrompt {
    return assembleReply(message, attachmentPaths, boundPrompts);
  }
}
