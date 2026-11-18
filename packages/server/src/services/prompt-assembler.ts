/**
 * Builds the exact text sent to a CLI. It adds nothing of its own: no headings, no role text,
 * no wrapper. The output is the non-empty layers, unchanged, joined by one blank line.
 */

export type PromptLayerName = "global" | "repo" | "message";

export interface PromptLayers {
  /** `settings.json` → `basePrompt` */
  globalBase: string;
  /** `.data/knowledge/<repo>.json` → `basePrompt` */
  repoBase: string;
  /** What you typed for this task. */
  message: string;
}

export interface AssembledPrompt {
  prompt: string;
  layers: { name: PromptLayerName; included: boolean }[];
}

export const LAYER_SEPARATOR = "\n\n";

/** A layer that is empty or only whitespace is skipped entirely. */
const isBlank = (text: string) => text.trim() === "";

export class EmptyMessageError extends Error {
  constructor() {
    super("The task message is empty.");
  }
}

/** global base → repo base → message. Empty layers are skipped; included ones are passed through verbatim. */
export function assemblePrompt({ globalBase, repoBase, message }: PromptLayers): AssembledPrompt {
  if (isBlank(message)) throw new EmptyMessageError();
  const ordered: [PromptLayerName, string][] = [
    ["global", globalBase],
    ["repo", repoBase],
    ["message", message],
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
export function assembleReply(message: string): AssembledPrompt {
  if (isBlank(message)) throw new EmptyMessageError();
  return {
    prompt: message,
    layers: [
      { name: "global", included: false },
      { name: "repo", included: false },
      { name: "message", included: true },
    ],
  };
}

export interface BasePromptSources {
  globalBasePrompt(): Promise<string>;
  repoBasePrompt(repo: string): Promise<string>;
}

/** Reads the current base prompts at call time, so edits apply to the next task you queue. */
export class PromptAssembler {
  constructor(private readonly sources: BasePromptSources) {}

  async forTask(repo: string, message: string): Promise<AssembledPrompt> {
    const [globalBase, repoBase] = await Promise.all([
      this.sources.globalBasePrompt(),
      this.sources.repoBasePrompt(repo),
    ]);
    return assemblePrompt({ globalBase, repoBase, message });
  }

  forReply(message: string): AssembledPrompt {
    return assembleReply(message);
  }
}
