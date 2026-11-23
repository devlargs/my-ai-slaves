import type { LimitInfo } from "../types";

/**
 * Cursor documents no limit error format: a failed run exits non-zero with a message on stderr.
 * These starter patterns are guesses until we see a real one; settings.json → providers.cursor-agent.limitPatterns
 * replaces them when non-empty. They are only tried on a run that produced no agent output (see
 * CursorStreamParser.finish), and line by line.
 */
export const DEFAULT_CURSOR_LIMIT_PATTERNS = [
  "usage limit",
  "rate.?limit",
  "quota",
  "limit (?:has been )?reached",
  "hit (?:your|the) [\\w\\s]*limit",
  "out of (?:usage|credits|requests)",
  "\\b429\\b",
];

const LOGGED_OUT = /not logged in|not authenticated|authentication required|please (?:run )?.*login|unauthori[sz]ed|\b401\b/i;

function compile(patterns: string[]): RegExp[] {
  return patterns.flatMap((p) => {
    try {
      return [new RegExp(p, "i")];
    } catch {
      return [];
    }
  });
}

export function detectCursorLimit(text: string, configuredPatterns: string[]): LimitInfo | null {
  const patterns = compile(configuredPatterns.length > 0 ? configuredPatterns : DEFAULT_CURSOR_LIMIT_PATTERNS);
  const lines = text.split("\n");
  for (const re of patterns) {
    const line = lines.find((l) => re.test(l));
    if (line !== undefined) return { resetsAt: null, reason: line.trim().slice(0, 300) };
  }
  return null;
}

export function detectCursorLoggedOut(text: string): string | null {
  const line = text.split("\n").find((l) => LOGGED_OUT.test(l));
  return line ? line.trim().slice(0, 300) : null;
}
