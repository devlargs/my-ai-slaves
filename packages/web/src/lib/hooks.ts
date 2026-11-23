import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LabelColor, LabelColors } from "@my-ai-slaves/shared";
import { api } from "./api";
import { ws } from "./store";

// Last result of every keyed useApi call, kept for the whole session. Opening a page again shows
// what it showed last time straight away and refreshes it in the background, instead of starting
// empty and showing "Loading…" on every visit.
const apiCache = new Map<string, unknown>();

/**
 * Fetch on mount (and when deps change); exposes reload and a local setter. With a `cacheKey`, the
 * last result is shown immediately on the next mount while a fresh copy loads (`loading` is then
 * only true while there's nothing to show yet or during a reload).
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = [], cacheKey?: string) {
  const [data, setDataState] = useState<T | undefined>(() =>
    cacheKey === undefined ? undefined : (apiCache.get(cacheKey) as T | undefined),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const keyRef = useRef(cacheKey);
  keyRef.current = cacheKey;

  const setData = useCallback((next: T | undefined | ((prev: T | undefined) => T | undefined)) => {
    setDataState((prev) => {
      const value = typeof next === "function" ? (next as (prev: T | undefined) => T | undefined)(prev) : next;
      if (keyRef.current !== undefined) {
        if (value === undefined) apiCache.delete(keyRef.current);
        else apiCache.set(keyRef.current, value);
      }
      return value;
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const key = keyRef.current;
    try {
      const result = await fetcherRef.current();
      if (key !== undefined) apiCache.set(key, result);
      // Ignore a late answer for a key the component has since moved away from.
      if (key === keyRef.current) {
        setDataState(result);
        setError(null);
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  // A changed key (e.g. another task selected) shows that key's cached data, not the previous one's.
  const [shownKey, setShownKey] = useState(cacheKey);
  if (shownKey !== cacheKey) {
    setShownKey(cacheKey);
    setDataState(cacheKey === undefined ? undefined : (apiCache.get(cacheKey) as T | undefined));
  }

  useEffect(() => {
    void reload();
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied
  }, deps);

  return { data, setData, loading, error, reload };
}

/** Subscribe to a task's live stream while mounted. */
export function useTaskSubscription(taskId: string | null) {
  useEffect(() => {
    if (!taskId) return;
    return ws.subscribeTask(taskId);
  }, [taskId]);
}

/** Re-render every second (for countdowns), only while `enabled`: an idle timer per badge adds up. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// ── Repo display names (repos can be renamed in the app; tasks store the repo id) ──
let repoNames: Record<string, string> = {};
let repoNamesLoading: Promise<void> | null = null;
const repoNameListeners = new Set<() => void>();

/** Share a freshly loaded repo list's names with every view. */
export function setRepoNames(repos: { id: string; name: string }[]) {
  repoNames = Object.fromEntries(repos.map((r) => [r.id, r.name]));
  for (const l of repoNameListeners) l();
}

/** Refetch repo names (call after registering, renaming or removing a repo). */
export function refreshRepoNames(): Promise<void> {
  repoNamesLoading = api
    .getRepos()
    .then(setRepoNames)
    .catch(() => {
      repoNamesLoading = null;
    });
  return repoNamesLoading;
}

/** id → display name lookup; falls back to the id for repos it doesn't know (e.g. removed ones). */
export function useRepoName(): (id: string) => string {
  const names = useSyncExternalStore(
    (l) => {
      repoNameListeners.add(l);
      return () => repoNameListeners.delete(l);
    },
    () => repoNames,
  );
  useEffect(() => {
    if (!repoNamesLoading) void refreshRepoNames();
  }, []);
  return (id) => names[id] ?? id;
}

// ── Repo label colours (one per label, shared by every repo; keyed by lowercased label) ──
let labelColors: LabelColors = {};
// biome-ignore lint/correctness/noUnusedVariables: read by the ??= below
let labelColorsLoading: Promise<void> | null = null;
const labelColorListeners = new Set<() => void>();

function setLabelColors(next: LabelColors) {
  labelColors = next;
  for (const l of labelColorListeners) l();
}

/** Save one label's colour ("gray" = plain) and share the result with every view. */
export async function saveLabelColor(label: string, color: LabelColor): Promise<void> {
  setLabelColors(await api.setLabelColor(label, color));
}

/** label → its colour ("gray" when it has none). */
export function useLabelColor(): (label: string) => LabelColor {
  const colors = useSyncExternalStore(
    (l) => {
      labelColorListeners.add(l);
      return () => labelColorListeners.delete(l);
    },
    () => labelColors,
  );
  useEffect(() => {
    labelColorsLoading ??= api
      .getLabelColors()
      .then(setLabelColors)
      .catch(() => {
        labelColorsLoading = null;
      });
  }, []);
  return (label) => colors[label.trim().replace(/\s+/g, " ").toLowerCase()] ?? "gray";
}
