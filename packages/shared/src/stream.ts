/** Normalized live events from either CLI, as streamed to the browser. */
export type StreamEvent =
  | { kind: "init"; sessionId: string; model: string; permissionMode: string }
  /** Partial assistant text as it is generated. */
  | { kind: "text-delta"; text: string }
  /** A complete assistant message. Replaces any text-delta accumulated since the last message/tool. */
  | { kind: "message"; text: string }
  | { kind: "tool-start"; callId: string; tool: string; summary: string }
  | { kind: "tool-end"; callId: string; ok: boolean; summary: string }
  | { kind: "file-edit"; path: string }
  | { kind: "warning"; text: string };

export interface RawLine {
  src: "stdout" | "stderr";
  line: string;
}
