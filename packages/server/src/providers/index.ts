import type { ProviderId } from "@my-ai-slaves/shared";
import { ClaudeCodeAdapter } from "./claude-code/adapter";
import { CursorAgentAdapter } from "./cursor-agent/adapter";
import type { ProviderAdapter } from "./types";

export type AdapterRegistry = Record<ProviderId, ProviderAdapter>;

export function createAdapters(): AdapterRegistry {
  return { "claude-code": new ClaudeCodeAdapter(), "cursor-agent": new CursorAgentAdapter() };
}
