import { storageGet, storageRemove, storageSet } from "@/lib/utils";

/**
 * Long text pasted into a message box shows as a short `[Pasted text #1 +204 lines]` marker (like the
 * Claude Code CLI) while the full text is kept aside, under the box's draft key, so it survives
 * leaving the page. `expandPastes` puts the full text back when the message is read to send or preview,
 * so the CLI gets exactly what was pasted. A marker the user edits or deletes is just text.
 */

/** Pastes at least this many lines, or this many characters, are collapsed. */
export const COLLAPSE_LINES = 12;
export const COLLAPSE_CHARS = 1500;

const MARKER = /\[Pasted text #(\d+) \+(\d+) lines?\]/g;

const lineCount = (text: string) => text.split(/\r\n|\r|\n/).length;

export function shouldCollapse(text: string): boolean {
  return lineCount(text) >= COLLAPSE_LINES || text.length >= COLLAPSE_CHARS;
}

export function pasteMarker(id: number, text: string): string {
  const lines = lineCount(text);
  return `[Pasted text #${id} +${lines} ${lines === 1 ? "line" : "lines"}]`;
}

const storeKey = (draftStorageKey: string) => `${draftStorageKey}.pasted`;

export function loadPastes(draftStorageKey: string): Record<string, string> {
  const raw = storageGet(storeKey(draftStorageKey));
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Keep `text` aside and return the marker to put in the box. */
export function addPaste(draftStorageKey: string, text: string): string {
  const pastes = loadPastes(draftStorageKey);
  const id = Math.max(0, ...Object.keys(pastes).map(Number).filter(Number.isFinite)) + 1;
  pastes[id] = text;
  storageSet(storeKey(draftStorageKey), JSON.stringify(pastes));
  return pasteMarker(id, text);
}

export function clearPastes(draftStorageKey: string): void {
  storageRemove(storeKey(draftStorageKey));
}

/** Replace each marker with the text it stands for. */
export function expandPastes(text: string, pastes: Record<string, string>): string {
  if (!text.includes("[Pasted text #")) return text;
  return text.replace(MARKER, (marker, id: string) => pastes[id] ?? marker);
}
