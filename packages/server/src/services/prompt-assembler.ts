/**
 * Builds the exact text sent to a CLI: no headings, no role text, no wrapper. The output is the
 * non-empty layers (global base → ticked repo prompts → bound saved prompts → message → attachments),
 * unchanged, joined by one blank line. The only app-written text is the list of attached file
 * paths, and only when you attach files.
 */

export type PromptLayerName = "global" | "repo" | "prompts" | "message" | "attachments";

export interface PromptLayers {
  /** `settings.json` → `basePrompt` */
  globalBase: string;
  /** The repo's prompts ticked for this task (`.data/knowledge/<repo>.json`), in the repo's order. */
  repoPrompts?: string[];
  /** Saved prompts bound to this message, in library order: sent as written, joined by a blank line. */
  boundPrompts?: string[];
  /** What you typed for this task. */
  message: string;
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

/** A layer that is empty or only whitespace is skipped entirely. */
const isBlank = (text: string) => text.trim() === "";

export class EmptyMessageError extends Error {
  constructor() {
    super("The task message is empty.");
  }
}

/** Several prompts in one layer: each sent as written, blank ones skipped, one blank line between. */
const joinBound = (bound: string[]) => bound.filter((b) => !isBlank(b)).join(LAYER_SEPARATOR);

export function assemblePrompt({
  globalBase,
  repoPrompts = [],
  boundPrompts = [],
  message,
  attachmentPaths = [],
}: PromptLayers): AssembledPrompt {
  if (isBlank(message)) throw new EmptyMessageError();
  const ordered: [PromptLayerName, string][] = [
    ["global", globalBase],
    ["repo", joinBound(repoPrompts)],
    ["prompts", joinBound(boundPrompts)],
    ["message", message],
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
  if (isBlank(message)) throw new EmptyMessageError();
  const bound = joinBound(boundPrompts);
  const files = attachmentsLayer(attachmentPaths);
  return {
    prompt: [bound, message, files].filter((t) => !isBlank(t)).join(LAYER_SEPARATOR),
    layers: [
      { name: "global", included: false },
      { name: "repo", included: false },
      { name: "prompts", included: bound !== "" },
      { name: "message", included: true },
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

  /** `repoPrompts` / `boundPrompts`: the current text of the prompts ticked for this task. */
  async forTask(
    message: string,
    { repoPrompts = [], boundPrompts = [], attachmentPaths = [] }: { repoPrompts?: string[]; boundPrompts?: string[]; attachmentPaths?: string[] } = {},
  ): Promise<AssembledPrompt> {
    const globalBase = await this.sources.globalBasePrompt();
    return assemblePrompt({ globalBase, repoPrompts, boundPrompts, message, attachmentPaths });
  }

  forReply(message: string, attachmentPaths: string[] = [], boundPrompts: string[] = []): AssembledPrompt {
    return assembleReply(message, attachmentPaths, boundPrompts);
  }
}
