import type { ActivityEntry } from "@my-ai-slaves/shared";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn, formatTime } from "@/lib/utils";

const eventVariant: Partial<Record<ActivityEntry["event"], BadgeVariant>> = {
  queued: "secondary",
  started: "default",
  fallback: "warning",
  "limit-hit": "warning",
  waiting: "warning",
  warning: "warning",
  finished: "success",
  kept: "success",
  pushed: "success",
  failed: "destructive",
  cancelled: "outline",
  interrupted: "destructive",
  discarded: "outline",
};

export function ActivityTimeline({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-1">
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
        <TimelineRow key={i} entry={entry} />
      ))}
    </ol>
  );
}

function TimelineRow({ entry }: { entry: ActivityEntry }) {
  const prompt = entry.event === "started" && typeof entry.data?.prompt === "string" ? entry.data.prompt : null;
  const extra = entry.data && !prompt ? entry.data : null;
  const [open, setOpen] = useState(false);
  const expandable = prompt !== null || (extra !== null && Object.keys(extra).length > 0);

  return (
    <li className="rounded-md border bg-card px-2.5 py-1.5">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-start gap-2 text-left", expandable && "cursor-pointer")}
      >
        <span className="mt-0.5 w-24 shrink-0 font-mono text-[11px] text-muted-foreground">{formatTime(entry.at)}</span>
        <Badge variant={eventVariant[entry.event] ?? "outline"} className="mt-px shrink-0">
          {entry.event}
        </Badge>
        <span className="min-w-0 flex-1 break-words text-[13px]">
          {entry.detail}
          {entry.account && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">@{entry.account}</span>}
        </span>
        {expandable && (
          <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && prompt !== null && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">Prompt sent to the CLI</div>
          <pre className="max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{prompt}</pre>
        </div>
      )}
      {open && extra && (
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(extra, null, 2)}
        </pre>
      )}
    </li>
  );
}
