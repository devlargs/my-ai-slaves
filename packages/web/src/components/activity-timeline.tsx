import type { ActivityEntry } from "@my-ai-slaves/shared";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn, formatTime } from "@/lib/utils";

const eventVariant: Partial<Record<ActivityEntry["event"], BadgeVariant>> = {
  queued: "secondary",
  started: "signal",
  fallback: "warning",
  "limit-hit": "warning",
  waiting: "warning",
  warning: "warning",
  finished: "success",
  kept: "success",
  pushed: "success",
  "marked-finished": "success",
  failed: "destructive",
  cancelled: "outline",
  interrupted: "destructive",
  discarded: "outline",
};

/** A long run logs thousands of entries (one per tool call). Past this many, the middle stays folded until asked for. */
const FOLD_OVER = 300;
/** Entries kept in view at each end of a folded log: how it started, and how it ended. */
const FOLD_KEEP = 100;

export function ActivityTimeline({ entries }: { entries: ActivityEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  if (entries.length === 0) return <p className="text-[13px] text-muted-foreground">No activity recorded yet.</p>;
  const folded = !showAll && entries.length > FOLD_OVER;
  const hidden = folded ? entries.length - 2 * FOLD_KEEP : 0;
  // Rows are keyed by their place in the whole log, so unfolding keeps the ones already there.
  const row = (entry: ActivityEntry, i: number) => <TimelineRow key={i} entry={entry} />;
  return (
    <ol className="flex flex-col divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface">
      {folded ? entries.slice(0, FOLD_KEEP).map(row) : entries.map(row)}
      {folded && (
        <li className="bg-paper-2/60 px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-ink hover:underline"
          >
            Show the <span className="num">{hidden.toLocaleString()}</span> entries in between
          </button>
        </li>
      )}
      {folded && entries.slice(-FOLD_KEEP).map((entry, i) => row(entry, entries.length - FOLD_KEEP + i))}
    </ol>
  );
}

// Memoized, and skipped by the browser while scrolled out of view: the list can be long.
const TimelineRow = memo(function TimelineRow({ entry }: { entry: ActivityEntry }) {
  const prompt = entry.event === "started" && typeof entry.data?.prompt === "string" ? entry.data.prompt : null;
  // The agent's messages and final result are markdown: shown rendered, not as JSON.
  const agentText =
    entry.event === "message" && typeof entry.data?.text === "string"
      ? entry.data.text
      : entry.event === "finished" && typeof entry.data?.result === "string" && entry.data.result.trim()
        ? entry.data.result
        : null;
  const extra = entry.data && !prompt && agentText === null ? entry.data : null;
  const [open, setOpen] = useState(false);
  const expandable = prompt !== null || agentText !== null || (extra !== null && Object.keys(extra).length > 0);

  return (
    <li className="offscreen-skip px-3 py-2">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-start gap-2 text-left", expandable && "cursor-pointer")}
      >
        <span className="num mt-0.5 w-24 shrink-0 font-mono text-[11px] text-muted-foreground">{formatTime(entry.at)}</span>
        <Badge variant={eventVariant[entry.event] ?? "outline"} className="mt-px shrink-0">
          {entry.event}
        </Badge>
        <span className="min-w-0 flex-1 break-words text-[13px] text-ink">
          {entry.detail}
          {entry.account && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">@{entry.account}</span>}
        </span>
        {expandable && (
          <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
        )}
      </button>
      {open && prompt !== null && (
        <div className="mt-2">
          <div className="label-mono mb-1.5">Prompt sent to the CLI</div>
          <pre className="scroll-quiet max-h-80 overflow-auto rounded-md bg-paper-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">{prompt}</pre>
        </div>
      )}
      {open && agentText !== null && (
        <div className="scroll-quiet mt-2 max-h-[32rem] overflow-auto rounded-md border border-rule bg-paper px-3 py-2.5">
          <Markdown>{agentText}</Markdown>
        </div>
      )}
      {open && extra && (
        <pre className="scroll-quiet mt-2 max-h-80 overflow-auto rounded-md bg-paper-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {JSON.stringify(extra, null, 2)}
        </pre>
      )}
    </li>
  );
});
