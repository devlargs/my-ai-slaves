import type { StreamEvent } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { type LiveState, applyEvent, emptyLive } from "@/lib/store";

function reduce(events: StreamEvent[]): LiveState {
  const live = emptyLive();
  for (const e of events) applyEvent(live, e);
  return live;
}

describe("live output reduction", () => {
  it("accumulates text deltas and replaces them with the complete message", () => {
    const live = reduce([
      { kind: "text-delta", text: "Hel" },
      { kind: "text-delta", text: "lo" },
    ]);
    expect(live.streaming).toBe("Hello");
    expect(live.items).toEqual([]);
    applyEvent(live, { kind: "message", text: "Hello!" });
    expect(live.streaming).toBe("");
    expect(live.items).toEqual([{ type: "message", text: "Hello!" }]);
  });

  it("flushes streamed text when a tool starts, and fills in the tool when it ends", () => {
    const live = reduce([
      { kind: "text-delta", text: "Reading" },
      { kind: "tool-start", callId: "t1", tool: "Read", summary: "a.ts" },
      { kind: "tool-start", callId: "t2", tool: "Bash", summary: "ls" },
      { kind: "tool-end", callId: "t1", ok: true, summary: "" },
      { kind: "tool-end", callId: "t2", ok: false, summary: "exit 1" },
      { kind: "tool-end", callId: "unknown", ok: true, summary: "ignored" },
    ]);
    expect(live.items).toEqual([
      { type: "message", text: "Reading" },
      { type: "tool", callId: "t1", tool: "Read", summary: "a.ts", ok: true, result: null },
      { type: "tool", callId: "t2", tool: "Bash", summary: "ls", ok: false, result: "exit 1" },
    ]);
  });

  it("drops whitespace-only streamed text instead of keeping an empty message", () => {
    const live = reduce([
      { kind: "text-delta", text: "  \n" },
      { kind: "tool-start", callId: "t", tool: "Read", summary: "" },
    ]);
    expect(live.items.map((i) => i.type)).toEqual(["tool"]);
  });

  it("records init, file edits, warnings and what the user sent", () => {
    const live = reduce([
      { kind: "user", text: "do it", reply: false, attachments: [], prompts: ["global"] },
      { kind: "init", sessionId: "s", model: "m", permissionMode: "default" },
      { kind: "file-edit", path: "src/a.ts" },
      { kind: "warning", text: "careful" },
      { kind: "text-delta", text: "half" },
      { kind: "user", text: "reply", reply: true, attachments: [], prompts: [] },
    ]);
    expect(live.items).toEqual([
      { type: "user", text: "do it", reply: false, attachments: [], prompts: ["global"] },
      { type: "init", model: "m", permissionMode: "default", sessionId: "s" },
      { type: "file-edit", path: "src/a.ts" },
      { type: "warning", text: "careful" },
      { type: "message", text: "half" },
      { type: "user", text: "reply", reply: true, attachments: [], prompts: [] },
    ]);
  });

  it("replaces a finished tool's item instead of mutating it, so memoized rows re-render", () => {
    const live = reduce([{ kind: "tool-start", callId: "t", tool: "Read", summary: "" }]);
    const before = live.items[0];
    applyEvent(live, { kind: "tool-end", callId: "t", ok: true, summary: "done" });
    expect(live.items[0]).not.toBe(before);
    expect(before).toMatchObject({ ok: null });
  });
});
