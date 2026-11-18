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
}

const LIMIT_TEXT = /You've hit your [\w\s]*limit[^\n]*|usage limit[^\n]*|Claude AI usage limit reached[^\n]*/i;
const LOGGED_OUT_TEXT =
  /Not logged in|Please run \/login|Login expired|OAuth token (?:revoked|has expired)|Invalid API key|Authentication required|OAuth session expired/i;

const resultText = (facts: ClaudeRunFacts) =>
  [facts.result?.result ?? "", ...(facts.result?.errors ?? []), facts.stderrTail].join("\n");

/**
 * A run counts as limited when any of these show up:
 *  - rate_limit_event with status "rejected" (uses its resetsAt)
 *  - an assistant message with error "rate_limit"
 *  - result.api_error_status 429, or "You've hit your … limit · resets …" text
 * 529/overloaded is NOT a usage limit.
 */
export function detectClaudeLimit(facts: ClaudeRunFacts, now: Date): LimitInfo | null {
  const text = resultText(facts);
  const textMatch = LIMIT_TEXT.exec(text);
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
  if (facts.assistantErrors.includes("authentication_failed")) return "Authentication failed: log in again.";
  const match = LOGGED_OUT_TEXT.exec(resultText(facts));
  return match ? match[0] : null;
}
