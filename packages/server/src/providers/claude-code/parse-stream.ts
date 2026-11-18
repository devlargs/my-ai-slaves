import type { StreamEvent } from "@my-ai-slaves/shared";
import { type ExitInfo, preview, type StreamParser } from "../spawn";
import type { RunResult } from "../types";
import { type ClaudeRunFacts, detectClaudeLimit, detectClaudeLoggedOut } from "./detect-limit";

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, any>;

function summarizeToolInput(name: string, input: Json | undefined): string {
  if (!input) return "";
  const pick = input.file_path ?? input.notebook_path ?? input.path ?? input.command ?? input.pattern ?? input.url ??
    input.description ?? input.prompt;
  return preview(pick ?? input, 140);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ");
  }
  return "";
}

/**
 * Parses `claude -p --output-format stream-json --verbose --include-partial-messages`.
 * Messages from subagents (parent_tool_use_id set) are left to the raw view.
 */
export class ClaudeStreamParser implements StreamParser {
  sessionId: string | null = null;
  private readonly facts: ClaudeRunFacts = {
    rateLimitRejected: null,
    assistantErrors: [],
    result: null,
    stderrTail: "",
  };

  constructor(
    private readonly expectedPermissionMode: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onLine(line: string): StreamEvent[] {
    if (!line.trim().startsWith("{")) return [];
    const msg = JSON.parse(line) as Json;
    const topLevel = msg.parent_tool_use_id == null;

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id ?? null;
          const events: StreamEvent[] = [
            {
              kind: "init",
              sessionId: msg.session_id ?? "",
              model: msg.model ?? "",
              permissionMode: msg.permissionMode ?? "",
            },
          ];
          if (msg.permissionMode && msg.permissionMode !== this.expectedPermissionMode) {
            events.push({
              kind: "warning",
              text: `Asked for permission mode "${this.expectedPermissionMode}" but the run started in "${msg.permissionMode}" (auto mode may be unavailable for this model/account), so edits or commands may be denied.`,
            });
          }
          return events;
        }
        if (msg.subtype === "api_retry") {
          return [
            {
              kind: "warning",
              text: `API retry ${msg.attempt}/${msg.max_retries} (${msg.error ?? "error"}${msg.error_status ? ` ${msg.error_status}` : ""})`,
            },
          ];
        }
        if (msg.subtype === "permission_denied") {
          return [{ kind: "warning", text: `Permission denied: ${preview(msg.tool_name ?? msg.message ?? msg, 160)}` }];
        }
        return [];
      }

      case "stream_event": {
        const event = msg.event as Json | undefined;
        if (topLevel && event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          return [{ kind: "text-delta", text: String(event.delta.text ?? "") }];
        }
        return [];
      }

      case "assistant": {
        if (typeof msg.error === "string") this.facts.assistantErrors.push(msg.error);
        if (!topLevel) return [];
        const events: StreamEvent[] = [];
        for (const block of (msg.message?.content ?? []) as Json[]) {
          if (block.type === "text" && block.text) events.push({ kind: "message", text: block.text });
          if (block.type === "tool_use") {
            events.push({
              kind: "tool-start",
              callId: block.id,
              tool: block.name,
              summary: summarizeToolInput(block.name, block.input),
            });
            const path = block.input?.file_path ?? block.input?.notebook_path;
            if (FILE_EDIT_TOOLS.has(block.name) && path) events.push({ kind: "file-edit", path });
          }
        }
        return events;
      }

      case "user": {
        if (!topLevel) return [];
        const content = msg.message?.content;
        if (!Array.isArray(content)) return [];
        return content
          .filter((b: Json) => b.type === "tool_result")
          .map((b: Json) => ({
            kind: "tool-end" as const,
            callId: b.tool_use_id,
            ok: !b.is_error,
            summary: preview(toolResultText(b.content), 160),
          }));
      }

      case "rate_limit_event": {
        const info = msg.rate_limit_info as Json | undefined;
        if (info?.status === "rejected") {
          this.facts.rateLimitRejected = { resetsAt: info.resetsAt, errorCode: info.errorCode, rateLimitType: info.rateLimitType };
          return [{ kind: "warning", text: "Usage limit reached for this account." }];
        }
        if (info?.status === "allowed_warning") {
          const pct = typeof info.utilization === "number" ? ` (${Math.round(info.utilization * 100)}% used)` : "";
          return [{ kind: "warning", text: `Approaching this account's usage limit${pct}.` }];
        }
        return [];
      }

      case "result": {
        this.facts.result = msg;
        this.sessionId = msg.session_id ?? this.sessionId;
        return [];
      }

      default:
        return [];
    }
  }

  finish(exit: ExitInfo, stderrTail: string): RunResult {
    this.facts.stderrTail = stderrTail;
    const result = this.facts.result;

    if (result && result.subtype === "success" && !result.is_error && exit.code === 0) {
      return {
        outcome: "success",
        sessionId: this.sessionId,
        resultText: String(result.result ?? ""),
        costUsd: typeof (result as Json).total_cost_usd === "number" ? (result as Json).total_cost_usd : null,
      };
    }

    const limit = detectClaudeLimit(this.facts, this.now());
    if (limit) return { outcome: "limit", limit, sessionId: this.sessionId };

    const loggedOut = detectClaudeLoggedOut(this.facts);
    if (loggedOut) return { outcome: "logged-out", message: loggedOut };

    const message =
      result?.result ||
      result?.errors?.join("; ") ||
      (result?.subtype && result.subtype !== "success" ? `Run ended with ${result.subtype}` : "") ||
      stderrTail.trim().split("\n").at(-1) ||
      `claude exited with code ${exit.code ?? exit.signal}`;
    return { outcome: "failed", exitCode: exit.code, message, stderrTail };
  }
}
