import {
  AlertTriangleIcon,
  CheckIcon,
  CpuIcon,
  FilePenIcon,
  LoaderIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Switch } from "@/components/ui/switch";
import { type LiveItem, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function LiveOutput({ taskId }: { taskId: string }) {
  const live = useStore((s) => s.live[taskId]);
  const [raw, setRaw] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const itemCount = live?.items.length ?? 0;
  const rawCount = live?.raw.length ?? 0;
  const streamingLength = live?.streaming.length ?? 0;

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
        {!live || (live.items.length === 0 && !live.streaming && live.raw.length === 0) ? (
          <p className="p-4 text-[13px] text-muted-foreground">No output yet. It streams here while the task runs.</p>
        ) : raw ? (
          <pre className="min-h-full bg-paper-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ink-2">
            {live.raw.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <div key={i} className={cn(r.src === "stderr" && "text-danger-ink")}>
                {r.line}
              </div>
            ))}
          </pre>
        ) : (
          <div className="flex max-w-3xl flex-col gap-2 px-4 py-3.5">
            {live.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <LiveRow key={i} item={item} />
            ))}
            {live.streaming && (
              <div>
                <Markdown>{live.streaming}</Markdown>
                <span className="mt-1 inline-block h-3.5 w-[3px] animate-pulse rounded-full bg-signal align-middle motion-reduce:animate-none" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LiveRow({ item }: { item: LiveItem }) {
  switch (item.type) {
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
}
