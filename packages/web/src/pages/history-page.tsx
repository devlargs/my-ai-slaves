import type { HistoryItem } from "@my-ai-slaves/shared";
import { GitBranchIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { TaskStatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, formatTime } from "@/lib/utils";
import { TaskHistory } from "./queue-page";

export function HistoryPage() {
  const { data, loading, reload } = useApi<HistoryItem[]>(() => api.history(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const item = data?.find((h) => h.taskId === selected) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[440px] shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">History</h2>
          <span className="text-xs text-muted-foreground">{data?.length ?? 0}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void reload()} disabled={loading}>
            <RefreshCwIcon className={cn(loading && "animate-spin")} /> Refresh
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {data?.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">Finished, failed and discarded tasks show up here.</p>
          )}
          <div className="flex flex-col gap-1.5">
            {data?.map((h) => (
              <button
                type="button"
                key={h.taskId}
                onClick={() => setSelected(h.taskId)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-md border bg-card px-2.5 py-2 text-left cursor-pointer hover:bg-accent/50",
                  selected === h.taskId && "border-primary/60 ring-1 ring-primary/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={h.message}>
                    {h.title || h.message}
                  </span>
                  <TaskStatusBadge status={h.outcome} />
                </div>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                  <span>{h.repo}</span>
                  {h.lastAccount && <span>@{h.lastAccount}</span>}
                  {h.branch && (
                    <span className="flex items-center gap-0.5">
                      <GitBranchIcon className="size-3" />
                      {h.branch}
                    </span>
                  )}
                  <span className="ml-auto">{formatTime(h.endedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {item ? (
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{item.title}</h2>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {item.taskId} · queued {formatTime(item.queuedAt)} · ended {formatTime(item.endedAt)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void attempt(api.createTask({ repo: item.repo, message: item.message }), "Queued again")
                }
              >
                <RotateCcwIcon /> Queue again
              </Button>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Task message</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
                {item.message}
              </pre>
            </details>
            <TaskHistory taskId={item.taskId} />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Select a task to see its full activity.
          </div>
        )}
      </div>
    </div>
  );
}
