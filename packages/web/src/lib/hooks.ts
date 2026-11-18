import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "./api";
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
