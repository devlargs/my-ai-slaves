import type { StreamEvent, TokenUsage } from "@my-ai-slaves/shared";
import { type ExitInfo, preview, type StreamParser } from "../spawn";
import type { RunResult } from "../types";
import { fromCamelUsage } from "../usage";
import { detectCursorLimit, detectCursorLoggedOut } from "./detect-limit";

type Json = Record<string, any>;

const FILE_EDIT_KEYS = new Set(["writeToolCall", "editToolCall", "strReplaceToolCall", "deleteToolCall", "multiEditToolCall"]);

/** `readToolCall` → "read"; `{ function: { name } }` → that name. */
function describeTool(toolCall: Json): { key: string; name: string; args: Json; result: Json | undefined } {
  const key = Object.keys(toolCall)[0] ?? "unknown";
  const body = (toolCall[key] ?? {}) as Json;
  if (key === "function") {
    let args: Json = {};
    try {
      args = typeof body.arguments === "string" ? JSON.parse(body.arguments) : (body.arguments ?? {});
    } catch {
      args = { arguments: body.arguments };
    }
    return { key, name: String(body.name ?? "function"), args, result: body.result };
  }
  return { key, name: key.replace(/ToolCall$/, ""), args: (body.args ?? {}) as Json, result: body.result };
}

/**
 * Parses `agent -p --output-format stream-json --stream-partial-output`.
 * Assistant events with `timestamp_ms` and no `model_call_id` are the only ones carrying new text
 * (per Cursor's docs); others are duplicate flushes. Text is collected into a "message" whenever a
 * tool call starts or the run ends.
 */
export class CursorStreamParser implements StreamParser {
  sessionId: string | null = null;
  private result: Json | null = null;
  private buffer = "";
  private sawDelta = false;
  /** The agent wrote text or called a tool: its failure is then never read as a limit / logout. */
  private sawOutput = false;
  /**
   * Cursor's documented result line has no token counts; newer CLIs may add a camelCase `usage`
   * object, which is picked up when it is there.
   */
  usage: TokenUsage | null = null;

  constructor(private readonly limitPatterns: string[]) {}

  private flushText(): StreamEvent[] {
    const text = this.buffer;
    this.buffer = "";
    return text.trim() ? [{ kind: "message", text }] : [];
  }

  onLine(line: string): StreamEvent[] {
    if (!line.trim().startsWith("{")) return [];
    const msg = JSON.parse(line) as Json;

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id ?? null;
          return [
            { kind: "init", sessionId: msg.session_id ?? "", model: msg.model ?? "", permissionMode: msg.permissionMode ?? "" },
          ];
        }
        return [];

      case "assistant": {
        const text = ((msg.message?.content ?? []) as Json[])
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join("");
        if (text.trim()) this.sawOutput = true;
        const isDelta = "timestamp_ms" in msg && !("model_call_id" in msg);
        if (isDelta) {
          this.sawDelta = true;
          this.buffer += text;
          return text ? [{ kind: "text-delta", text }] : [];
        }
        // Without partial output every assistant event is a complete message.
        if (!this.sawDelta && !("model_call_id" in msg) && text) {
          return [{ kind: "message", text }];
        }
        return [];
      }

      case "tool_call": {
        this.sawOutput = true;
        const tool = describeTool((msg.tool_call ?? {}) as Json);
        if (msg.subtype === "started") {
          const events = this.flushText();
          const summary = preview(tool.args.path ?? tool.args.command ?? tool.args.pattern ?? tool.args.query ?? tool.args, 140);
          events.push({ kind: "tool-start", callId: String(msg.call_id), tool: tool.name, summary });
          if (FILE_EDIT_KEYS.has(tool.key) && typeof tool.args.path === "string") {
            events.push({ kind: "file-edit", path: tool.args.path });
          }
          return events;
        }
        if (msg.subtype === "completed") {
          const ok = tool.result ? "success" in tool.result : true;
          const detail = ok
            ? preview(tool.result?.success?.path ?? tool.result?.success ?? "", 160)
            : preview(tool.result?.error ?? tool.result ?? "", 160);
          return [{ kind: "tool-end", callId: String(msg.call_id), ok, summary: detail }];
        }
        return [];
      }

      case "result": {
        this.result = msg;
        this.usage = fromCamelUsage(msg.usage) ?? this.usage;
        this.sessionId = msg.session_id ?? this.sessionId;
        return this.flushText();
      }

      default:
        return [];
    }
  }

  finish(exit: ExitInfo, stderrTail: string): RunResult {
    if (exit.code === 0 && this.result && !this.result.is_error) {
      return {
        outcome: "success",
        sessionId: this.sessionId,
        resultText: String(this.result.result ?? ""),
        costUsd: null,
      };
    }
    // Text that only says "limit" or "401" counts only when the agent never got going: once it has
    // written or run anything, stderr and the result are its own work (a task about HTTP 429s…).
    if (!this.sawOutput) {
      const text = `${stderrTail}\n${this.result?.result ?? ""}`;
      const limit = detectCursorLimit(text, this.limitPatterns);
      if (limit) return { outcome: "limit", limit, sessionId: this.sessionId };
      const loggedOut = detectCursorLoggedOut(text);
      if (loggedOut) return { outcome: "logged-out", message: loggedOut };
    }
    return {
      outcome: "failed",
      exitCode: exit.code,
      message: stderrTail.trim().split("\n").at(-1) || `agent exited with code ${exit.code ?? exit.signal}`,
      stderrTail,
    };
  }
}
