import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiRequestError, api } from "./api";
import { toast } from "sonner";
import { ws } from "./store";

/** Fetch on mount (and when deps change); exposes reload and a local setter. */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      if (!(e instanceof ApiRequestError && e.status === 401)) toast.error(message);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are caller-supplied
  useEffect(() => {
    void reload();
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

/** Re-render every second (for countdowns). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
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
