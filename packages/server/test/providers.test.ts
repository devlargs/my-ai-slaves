import { formatLocalIso } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { detectClaudeLimit } from "../src/providers/claude-code/detect-limit";
import { ClaudeStreamParser } from "../src/providers/claude-code/parse-stream";
import { detectCursorLimit } from "../src/providers/cursor-agent/detect-limit";
import { CursorStreamParser } from "../src/providers/cursor-agent/parse-stream";
import { parseResetTime } from "../src/providers/reset-time";

const ok = { code: 0, signal: null, spawnError: null };
const exit1 = { code: 1, signal: null, spawnError: null };
const lines = (parser: { onLine(l: string): unknown[] }, objs: object[]) =>
  objs.flatMap((o) => parser.onLine(JSON.stringify(o)));

describe("parseResetTime (local time, Asia/Manila in tests)", () => {
  const now = new Date("2026-11-18T10:00:00+08:00"); // Wednesday
  it("later today", () => {
    expect(parseResetTime("You've hit your session limit · resets 3:45pm", now)).toBe("2026-11-18T15:45:00+08:00");
  });
  it("earlier time means tomorrow", () => {
    expect(parseResetTime("resets 9am", now)).toBe("2026-11-19T09:00:00+08:00");
  });
  it("weekday", () => {
    expect(parseResetTime("You've hit your weekly limit · resets Mon 12:00am", now)).toBe("2026-11-23T00:00:00+08:00");
  });
  it("no time", () => {
    expect(parseResetTime("something else", now)).toBeNull();
  });
});

describe("Claude limit detection", () => {
  const now = new Date("2026-11-18T10:00:00+08:00");
  const facts = { rateLimitRejected: null, assistantErrors: [], result: null, stderrTail: "" };

  it("uses resetsAt from rate_limit_event (seconds)", () => {
    const limit = detectClaudeLimit({ ...facts, rateLimitRejected: { resetsAt: 1795500000 } }, now);
    expect(limit?.resetsAt).toBe(formatLocalIso(new Date(1795500000 * 1000)));
    // milliseconds are accepted too
    expect(detectClaudeLimit({ ...facts, rateLimitRejected: { resetsAt: 1795500000000 } }, now)?.resetsAt).toBe(limit?.resetsAt);
  });
  it("detects the 'hit your limit' text and parses its reset time", () => {
    const limit = detectClaudeLimit(
      { ...facts, result: { is_error: true, result: "You've hit your weekly limit · resets Mon 12:00am" } },
      now,
    );
    expect(limit).toEqual({ resetsAt: "2026-11-23T00:00:00+08:00", reason: "You've hit your weekly limit · resets Mon 12:00am" });
  });
  it("429 without text → limit with unknown reset", () => {
    expect(detectClaudeLimit({ ...facts, result: { is_error: true, api_error_status: 429 } }, now)?.resetsAt).toBeNull();
  });
  it("529 overloaded is not a limit", () => {
    expect(detectClaudeLimit({ ...facts, assistantErrors: ["server_error"], result: { is_error: true, api_error_status: 529 } }, now)).toBeNull();
  });
});

describe("ClaudeStreamParser", () => {
  it("normalizes a successful run", () => {
    const p = new ClaudeStreamParser("auto");
    const events = lines(p, [
      { type: "system", subtype: "init", session_id: "s1", model: "m", permissionMode: "auto" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }, parent_tool_use_id: null },
      { type: "assistant", message: { content: [{ type: "text", text: "Hi there" }, { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/x/a.ts" } }] }, parent_tool_use_id: null },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] }, parent_tool_use_id: null },
      { type: "assistant", message: { content: [{ type: "text", text: "subagent chatter" }] }, parent_tool_use_id: "t9" },
      { type: "result", subtype: "success", is_error: false, result: "Done", total_cost_usd: 0.5, session_id: "s1" },
    ]);
    expect(events.map((e: any) => e.kind)).toEqual(["init", "text-delta", "message", "tool-start", "file-edit", "tool-end"]);
    expect(p.finish(ok, "")).toEqual({ outcome: "success", sessionId: "s1", resultText: "Done", costUsd: 0.5 });
  });

  it("takes token usage from the result's modelUsage (subagents included), else its usage", () => {
    const p = new ClaudeStreamParser("auto");
    lines(p, [
      {
        type: "result", subtype: "success", is_error: false, result: "Done", total_cost_usd: 0.5, session_id: "s1",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          a: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.3 },
          b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.2 },
        },
      },
    ]);
    expect(p.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, costUsd: 0.5 });

    const q = new ClaudeStreamParser("auto");
    lines(q, [{ type: "result", subtype: "success", is_error: false, result: "x", usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7 } }]);
    expect(q.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0, costUsd: null });
  });

  it("sums a stopped run's steps, counting each message id once", () => {
    const p = new ClaudeStreamParser("auto");
    const usage = { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
    lines(p, [
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "text", text: "a" }] }, parent_tool_use_id: null },
      { type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, parent_tool_use_id: null },
      { type: "assistant", message: { id: "m2", usage, content: [] }, parent_tool_use_id: "t1" },
    ]);
    expect(p.usage).toEqual({ inputTokens: 200, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: null });
    expect(new ClaudeStreamParser("auto").usage).toBeNull();
  });

  it("warns when auto mode silently fell back", () => {
    const p = new ClaudeStreamParser("auto");
    const events = lines(p, [{ type: "system", subtype: "init", session_id: "s", model: "m", permissionMode: "default" }]);
    expect(events.map((e: any) => e.kind)).toEqual(["init", "warning"]);
  });

  it("reports logged out", () => {
    const p = new ClaudeStreamParser("auto");
    lines(p, [{ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }]);
    expect(p.finish(exit1, "").outcome).toBe("logged-out");
  });

  it("reports a limit", () => {
    const p = new ClaudeStreamParser("auto");
    lines(p, [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 4102444800 } },
      { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 3:45pm" },
    ]);
    const r = p.finish(exit1, "");
    expect(r.outcome).toBe("limit");
  });
});

describe("CursorStreamParser", () => {
  it("keeps only real deltas and emits messages at tool boundaries", () => {
    const p = new CursorStreamParser([]);
    const events = lines(p, [
      { type: "system", subtype: "init", session_id: "c1", model: "M", permissionMode: "default" },
      { type: "assistant", message: { content: [{ type: "text", text: "Rea" }] }, timestamp_ms: 1 },
      { type: "assistant", message: { content: [{ type: "text", text: "ding" }] }, timestamp_ms: 2 },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading" }] }, timestamp_ms: 3, model_call_id: "x" },
      { type: "tool_call", subtype: "started", call_id: "k", tool_call: { editToolCall: { args: { path: "a.ts" } } } },
      { type: "tool_call", subtype: "completed", call_id: "k", tool_call: { editToolCall: { args: { path: "a.ts" }, result: { success: { path: "a.ts" } } } } },
      { type: "assistant", message: { content: [{ type: "text", text: "Reading" }] } },
      { type: "result", subtype: "success", is_error: false, result: "Reading", session_id: "c1" },
    ]);
    expect(events.map((e: any) => (e.kind === "message" || e.kind === "text-delta" ? `${e.kind}:${e.text}` : e.kind))).toEqual([
      "init",
      "text-delta:Rea",
      "text-delta:ding",
      "message:Reading",
      "tool-start",
      "file-edit",
      "tool-end",
    ]);
    expect(p.finish(ok, "").outcome).toBe("success");
  });

  it("limit from stderr", () => {
    const p = new CursorStreamParser([]);
    expect(p.finish(exit1, "Error: You've reached your usage limit\n").outcome).toBe("limit");
  });

  it("custom patterns replace the defaults", () => {
    expect(detectCursorLimit("plan exhausted", ["plan exhausted"])?.reason).toBe("plan exhausted");
    expect(detectCursorLimit("usage limit", ["plan exhausted"])).toBeNull();
  });
});
