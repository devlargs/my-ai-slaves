import { describe, expect, it } from "vitest";
import { COLLAPSE_CHARS, COLLAPSE_LINES, addPaste, clearPastes, expandPastes, loadPastes, pasteMarker, shouldCollapse } from "@/lib/pasted-text";
import { memoryStorage } from "./memory-storage";

const storage = memoryStorage();

describe("pasted text", () => {
  it("collapses long pastes only", () => {
    expect(shouldCollapse("short")).toBe(false);
    expect(shouldCollapse("x\n".repeat(COLLAPSE_LINES - 1))).toBe(true);
    expect(shouldCollapse(Array(COLLAPSE_LINES - 1).fill("x").join("\r\n"))).toBe(false);
    expect(shouldCollapse("x".repeat(COLLAPSE_CHARS))).toBe(true);
  });

  it("counts lines in the marker", () => {
    expect(pasteMarker(1, "one")).toBe("[Pasted text #1 +1 line]");
    expect(pasteMarker(2, "a\r\nb\nc")).toBe("[Pasted text #2 +3 lines]");
  });

  it("keeps pastes per draft and expands their markers back", () => {
    const a = addPaste("draft.a", "first\nsecond");
    const b = addPaste("draft.a", "third");
    expect([a, b]).toEqual(["[Pasted text #1 +2 lines]", "[Pasted text #2 +1 line]"]);
    expect(loadPastes("draft.b")).toEqual({});
    const pastes = loadPastes("draft.a");
    expect(expandPastes(`before ${a} middle ${b} after`, pastes)).toBe("before first\nsecond middle third after");
    // Unknown markers and plain text stay as they are.
    expect(expandPastes("[Pasted text #9 +1 line] and text", pastes)).toBe("[Pasted text #9 +1 line] and text");
    expect(expandPastes("no markers", pastes)).toBe("no markers");
    clearPastes("draft.a");
    expect(loadPastes("draft.a")).toEqual({});
  });

  it("numbers after the highest id kept and ignores broken storage", () => {
    storage.set("d.pasted", JSON.stringify({ 4: "x" }));
    expect(addPaste("d", "y")).toBe("[Pasted text #5 +1 line]");
    storage.set("d.pasted", "{broken");
    expect(loadPastes("d")).toEqual({});
  });

  it("text with a $ pattern is put back as is", () => {
    const m = addPaste("d", "cost $& and $1");
    expect(expandPastes(m, loadPastes("d"))).toBe("cost $& and $1");
  });
});
