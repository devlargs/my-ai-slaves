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
      <div className="flex items-center justify-end gap-2 pb-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
        className="min-h-0 flex-1 overflow-auto rounded-md border bg-card"
      >
        {!live || (live.items.length === 0 && !live.streaming && live.raw.length === 0) ? (
          <p className="p-3 text-sm text-muted-foreground">No output yet. It streams here while the task runs.</p>
        ) : raw ? (
          <pre className="p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
            {live.raw.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <div key={i} className={cn(r.src === "stderr" && "text-destructive")}>
                {r.line}
              </div>
            ))}
          </pre>
        ) : (
          <div className="flex flex-col gap-1.5 p-2.5">
            {live.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <LiveRow key={i} item={item} />
            ))}
            {live.streaming && (
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed">
                {live.streaming}
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/60 align-middle" />
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
      return <div className="whitespace-pre-wrap text-[13px] leading-relaxed">{item.text}</div>;
    case "tool":
      return (
        <div className="flex items-start gap-2 rounded bg-muted/60 px-2 py-1 font-mono text-[11px]">
          {item.ok === null ? (
            <LoaderIcon className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : item.ok ? (
            <CheckIcon className="mt-0.5 size-3 shrink-0 text-success" />
          ) : (
            <XIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
          )}
          <WrenchIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          <span className="font-semibold">{item.tool}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.summary}>
            {item.summary}
          </span>
          {item.result && item.ok === false && (
            <span className="max-w-[40%] truncate text-destructive" title={item.result}>
              {item.result}
            </span>
          )}
        </div>
      );
    case "file-edit":
      return (
        <div className="flex items-center gap-2 px-2 font-mono text-[11px] text-primary">
          <FilePenIcon className="size-3" />
          {item.path}
        </div>
      );
    case "warning":
      return (
        <div className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {item.text}
        </div>
      );
    case "init":
      return (
        <div className="flex items-center gap-2 px-2 font-mono text-[11px] text-muted-foreground">
          <CpuIcon className="size-3" />
          {item.model} · {item.permissionMode}
        </div>
      );
  }
}
