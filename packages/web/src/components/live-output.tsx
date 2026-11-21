import {
  AlertTriangleIcon,
  CheckIcon,
  CpuIcon,
  FilePenIcon,
  LibraryBigIcon,
  LoaderIcon,
  PaperclipIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Switch } from "@/components/ui/switch";
import { type LiveItem, type LiveState, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const NO_ITEMS: LiveItem[] = [];
const NO_RAW: LiveState["raw"] = [];

export function LiveOutput({ taskId }: { taskId: string }) {
  const [raw, setRaw] = useState(false);
  // Separate selections, so a raw CLI line (most of what a run sends) only re-renders this view
  // while the raw output is shown.
  const items = useStore((s) => s.live[taskId]?.items ?? NO_ITEMS);
  const streaming = useStore((s) => s.live[taskId]?.streaming ?? "");
  const hasRaw = useStore((s) => (s.live[taskId]?.raw.length ?? 0) > 0);
  const rawLines = useStore((s) => (raw ? (s.live[taskId]?.raw ?? NO_RAW) : NO_RAW));
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const itemCount = items.length;
  const rawCount = rawLines.length;
  const streamingLength = streaming.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [itemCount, rawCount, streamingLength, raw]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end gap-2 pb-2.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none">
          Raw output
          <Switch checked={raw} onCheckedChange={setRaw} />
        </label>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scroll-quiet min-h-0 flex-1 overflow-auto rounded-lg border border-rule bg-surface"
      >
        {items.length === 0 && !streaming && !hasRaw ? (
          <p className="p-4 text-[13px] text-muted-foreground">No output yet. It streams here while the task runs.</p>
        ) : raw ? (
          <pre className="min-h-full bg-paper-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ink-2">
            {rawLines.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <div key={i} className={cn(r.src === "stderr" && "text-danger-ink")}>
                {r.line}
              </div>
            ))}
          </pre>
        ) : (
          <div className="flex max-w-3xl flex-col gap-2 px-4 py-3.5">
            {items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <LiveRow key={i} item={item} />
            ))}
            {streaming && (
              <div>
                <Markdown>{streaming}</Markdown>
                <span className="mt-1 inline-block h-3.5 w-[3px] animate-pulse rounded-full bg-signal align-middle motion-reduce:animate-none" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Items never change once added (a finished tool call is replaced by a new object), so a row
// re-renders only when its own item does, and old messages aren't re-parsed on every token.
const LiveRow = memo(function LiveRow({ item }: { item: LiveItem }) {
  switch (item.type) {
    case "user":
      return (
        <div className="my-1.5 ml-auto flex w-fit max-w-[85%] min-w-0 flex-col gap-1.5 rounded-lg border border-signal/25 bg-signal-soft/50 px-3 py-2">
          <span className="label-mono text-[10px] text-signal-ink">{item.reply ? "Your reply" : "Your task"}</span>
          <Markdown>{item.text}</Markdown>
          {(item.prompts.length > 0 || item.attachments.length > 0) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {item.prompts.length > 0 && (
                <span className="flex min-w-0 items-center gap-1" title="Prompts sent with it">
                  <LibraryBigIcon className="size-3 shrink-0" />
                  <span className="truncate">{item.prompts.join(", ")}</span>
                </span>
              )}
              {item.attachments.length > 0 && (
                <span className="flex min-w-0 items-center gap-1" title="Attached files">
                  <PaperclipIcon className="size-3 shrink-0" />
                  <span className="truncate">{item.attachments.join(", ")}</span>
                </span>
              )}
            </div>
          )}
        </div>
      );
    case "message":
      return <Markdown className="py-0.5">{item.text}</Markdown>;
    case "tool":
      return (
        <div className="flex items-start gap-2 rounded-md bg-paper-2 px-2.5 py-1.5 font-mono text-[11px] text-ink-2">
          {item.ok === null ? (
            <LoaderIcon className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : item.ok ? (
            <CheckIcon className="mt-0.5 size-3 shrink-0 text-success-ink" />
          ) : (
            <XIcon className="mt-0.5 size-3 shrink-0 text-danger-ink" />
          )}
          <WrenchIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="font-medium text-ink">{item.tool}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.summary}>
            {item.summary}
          </span>
          {item.result && item.ok === false && (
            <span className="max-w-[40%] truncate text-danger-ink" title={item.result}>
              {item.result}
            </span>
          )}
        </div>
      );
    case "file-edit":
      return (
        <div className="flex items-center gap-2 px-2.5 font-mono text-[11px] text-signal-ink">
          <FilePenIcon className="size-3" />
          {item.path}
        </div>
      );
    case "warning":
      return (
        <div className="flex items-start gap-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs leading-snug text-warning-ink">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-ink" />
          {item.text}
        </div>
      );
    case "init":
      return (
        <div className="flex items-center gap-2 px-2.5 font-mono text-[11px] text-muted-foreground">
          <CpuIcon className="size-3" />
          {item.model} · {item.permissionMode}
        </div>
      );
  }
});
