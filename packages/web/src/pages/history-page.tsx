import type { HistoryPage as HistoryPageData } from "@my-ai-slaves/shared";
import { GitBranchIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelHeader } from "@/components/page-header";
import { TaskStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api, attempt } from "@/lib/api";
import { useApi, useRepoName } from "@/lib/hooks";
import { cn, formatTime } from "@/lib/utils";
import { TaskHistory } from "./queue-page";

/** How many history items each lazy-loaded page fetches. */
const PAGE_SIZE = 50;

export function HistoryPage() {
  // A refresh (or coming back to the page) re-fetches as many items as are already shown, so the
  // list doesn't shrink back to the first page under the user.
  const shownRef = useRef(0);
  const { data, setData, loading, reload } = useApi<HistoryPageData>(
    () => api.history(0, Math.max(PAGE_SIZE, Math.ceil(shownRef.current / PAGE_SIZE) * PAGE_SIZE)),
    [],
    "history",
  );
  shownRef.current = data?.items.length ?? 0;
  const items = data?.items;
  const repoName = useRepoName();
  const [selected, setSelected] = useState<string | null>(null);
  const item = items?.find((h) => h.taskId === selected) ?? null;

  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const nextOffset = data?.nextOffset ?? null;
  const loadMore = useCallback(async () => {
    if (nextOffset === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await attempt(api.history(nextOffset, PAGE_SIZE));
      if (!page) return;
      setData((prev) => {
        const have = new Set(prev?.items.map((h) => h.taskId));
        return {
          items: [...(prev?.items ?? []), ...page.items.filter((h) => !have.has(h.taskId))],
          total: page.total,
          nextOffset: page.nextOffset,
        };
      });
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextOffset, setData]);

  // Load the next page when the end of the list scrolls into view.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || nextOffset === null) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), {
      root: scrollRef.current,
      rootMargin: "0px 0px 300px 0px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [nextOffset, loadMore]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[440px] shrink-0 flex-col border-r border-rule">
        <PanelHeader>
          <h2 className="title-display text-[15px]">History</h2>
          <span className="num rounded-full bg-paper-2 px-1.5 text-[11px] font-medium text-muted-foreground">
            {data?.total ?? 0}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void reload()} disabled={loading}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} /> Refresh
          </Button>
        </PanelHeader>
        <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 overflow-auto px-3 py-3">
          {items?.length === 0 && (
            <p className="px-1 text-[13px] text-muted-foreground">Finished, failed and discarded tasks show up here.</p>
          )}
          <div className="flex flex-col gap-1.5">
            {items?.map((h) => (
              <button
                type="button"
                key={h.taskId}
                onClick={() => setSelected(h.taskId)}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-lg border bg-surface px-3 py-2.5 text-left transition-[border-color,box-shadow] duration-150",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]",
                  selected === h.taskId ? "border-signal/55 ring-3 ring-signal/10" : "border-rule hover:border-rule-strong",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={h.message}>
                    {h.title || h.message}
                  </span>
                  <TaskStatusBadge status={h.outcome} />
                </div>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                  <span>{repoName(h.repo)}</span>
                  {h.lastAccount && <span>· {h.lastAccount}</span>}
                  {h.branch && (
                    <span className="flex items-center gap-0.5">
                      <GitBranchIcon className="size-3" />
                      {h.branch}
                    </span>
                  )}
                  <span className="num ml-auto">{formatTime(h.endedAt)}</span>
                </div>
              </button>
            ))}
          </div>
          {nextOffset !== null && (
            <div ref={sentinelRef} className="flex justify-center py-3">
              <Button size="sm" variant="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : `Load more (${(data?.total ?? 0) - (items?.length ?? 0)} left)`}
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {item ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex items-start gap-3 border-b border-rule pb-4">
              <div className="min-w-0 flex-1">
                <h2 className="title-display text-lg leading-snug">{item.title}</h2>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {item.taskId} · queued {formatTime(item.queuedAt)} · ended {formatTime(item.endedAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void attempt(api.createTask({ repo: item.repo, message: item.message }))
                }
              >
                <RotateCcwIcon /> Queue again
              </Button>
            </div>
            <details className="group rounded-lg border border-rule bg-surface text-xs open:pb-3">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
                <span className="label-mono">Task message</span>
                <span className="ml-auto text-[11px] group-open:hidden">Show</span>
                <span className="ml-auto hidden text-[11px] group-open:inline">Hide</span>
              </summary>
              <pre className="scroll-quiet mx-3 max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
                {item.message}
              </pre>
            </details>
            <TaskHistory taskId={item.taskId} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-[13px] text-muted-foreground">
            Select a task to see its full activity.
          </div>
        )}
      </div>
    </div>
  );
}
