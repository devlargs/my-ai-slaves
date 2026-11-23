import type { TokenUsage } from "@my-ai-slaves/shared";

type Json = Record<string, unknown>;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
}

export function addUsage(into: TokenUsage, add: TokenUsage): TokenUsage {
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
  if (add.costUsd !== null) into.costUsd = (into.costUsd ?? 0) + add.costUsd;
  return into;
}

export const hasTokens = (u: TokenUsage): boolean =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0;

/** Anthropic API `usage` (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens). */
export function fromAnthropicUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Json;
  return {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    costUsd: null,
  };
}

/**
 * Claude's result `modelUsage` (per model: inputTokens, outputTokens, cacheReadInputTokens,
 * cacheCreationInputTokens, costUSD). Unlike the result's `usage`, it includes subagent requests.
 */
export function fromClaudeModelUsage(modelUsage: unknown): TokenUsage | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const total = emptyUsage();
  let any = false;
  for (const value of Object.values(modelUsage as Json)) {
    if (!value || typeof value !== "object") continue;
    const m = value as Json;
    any = true;
    addUsage(total, {
      inputTokens: count(m.inputTokens),
      outputTokens: count(m.outputTokens),
      cacheReadTokens: count(m.cacheReadInputTokens),
      cacheWriteTokens: count(m.cacheCreationInputTokens),
      costUsd: typeof m.costUSD === "number" ? m.costUSD : null,
    });
  }
  return any ? total : null;
}

/** A camelCase usage object (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens), if the CLI sends one. */
export function fromCamelUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Json;
  const result: TokenUsage = {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cacheReadTokens: count(u.cacheReadTokens),
    cacheWriteTokens: count(u.cacheWriteTokens),
    costUsd: null,
  };
  return hasTokens(result) ? result : null;
}
