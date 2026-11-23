import { afterEach, beforeEach, vi } from "vitest";

/** A Map-backed localStorage for the tests (Node has none). */
export function memoryStorage(): Map<string, string> {
  const data = new Map<string, string>();
  beforeEach(() => {
    data.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  return data;
}
