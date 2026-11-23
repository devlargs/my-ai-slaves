import { epochToIso, parseResetTime } from "../reset-time";
import type { LimitInfo } from "../types";

/** What the Claude stream told us about a failed run. */
export interface ClaudeRunFacts {
  /** From a `rate_limit_event` with status "rejected". */
  rateLimitRejected: { resetsAt?: number; errorCode?: string; rateLimitType?: string } | null;
  /** `error` values seen on assistant messages (e.g. "rate_limit", "authentication_failed"). */
  assistantErrors: string[];
  result: {
    is_error?: boolean;
    subtype?: string;
    result?: string;
    api_error_status?: number | null;
    errors?: string[];
  } | null;
  stderrTail: string;
  /**
   * The agent produced real output (text or a tool call, not an error message). Then the result
   * text and stderr are the agent's own words, so they are never searched for limit / login text.
   */
  agentOutput: boolean;
}

/** The CLI's own error lines: matched only at the start of a line (after an optional "Error:" / "API Error:"). */
const LINE_START = String.raw`^[ \t]*(?:(?:API )?Error:[ \t]*)?`;
const LIMIT_TEXT = new RegExp(
  `${LINE_START}(?:You've hit your [\\w ]*limit|You've reached your usage limit|Claude AI usage limit reached)[^\\n]*`,
  "im",
);
const LOGGED_OUT_TEXT = new RegExp(
  `${LINE_START}(?:Not logged in|Please run /login|Login expired|OAuth token (?:revoked|has expired)|Invalid API key|Authentication required|OAuth session expired)`,
  "im",
);

const resultText = (facts: ClaudeRunFacts) =>
  [facts.result?.result ?? "", ...(facts.result?.errors ?? []), facts.stderrTail].join("\n");

/**
 * A run counts as limited when any of these show up:
 *  - rate_limit_event with status "rejected" (uses its resetsAt)
 *  - an assistant message with error "rate_limit"
 *  - result.api_error_status 429
 *  - only when the agent produced no output: a line starting "You've hit your … limit · resets …"
 * 529/overloaded is NOT a usage limit.
 */
export function detectClaudeLimit(facts: ClaudeRunFacts, now: Date): LimitInfo | null {
  const text = resultText(facts);
  const textMatch = facts.agentOutput ? null : LIMIT_TEXT.exec(text);
  const limited =
    facts.rateLimitRejected !== null ||
    facts.assistantErrors.includes("rate_limit") ||
    facts.result?.api_error_status === 429 ||
    textMatch !== null;
  if (!limited) return null;

  const resetsAt =
    typeof facts.rateLimitRejected?.resetsAt === "number"
      ? epochToIso(facts.rateLimitRejected.resetsAt)
      : parseResetTime(text, now);
  const reason =
    textMatch?.[0].trim() ??
    (facts.rateLimitRejected?.errorCode === "credits_required"
      ? "Included usage exhausted (credits required)"
      : `Usage limit reached (${facts.rateLimitRejected?.rateLimitType ?? "rate_limit"})`);
  return { resetsAt, reason };
}

export function detectClaudeLoggedOut(facts: ClaudeRunFacts): string | null {
  if (facts.assistantErrors.includes("authentication_failed") || facts.result?.api_error_status === 401) {
    return "Authentication failed: log in again.";
  }
  if (facts.agentOutput) return null;
  const match = LOGGED_OUT_TEXT.exec(resultText(facts));
  return match ? match[0].trim() : null;
}
