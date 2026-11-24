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
import { PREVIEWABLE_IMAGE_TYPES } from "@my-ai-slaves/shared";
import { memo, useEffect, useRef, useState } from "react";
import { AttachmentList } from "@/components/attachments";
import { Markdown } from "@/components/markdown";
import { Switch } from "@/components/ui/switch";
import { type LiveItem, type LiveState, useStoreTransition, ws } from "@/lib/store";
import { cn } from "@/lib/utils";

const NO_ITEMS: LiveItem[] = [];
const NO_RAW: LiveState["raw"] = [];
/** Rows rendered at first; a long run's earlier rows load on demand, so the page stays light. */
const ITEM_WINDOW = 150;
const RAW_WINDOW = 1000;

/** What your messages are labelled in the output (a task's first message and replies, or a chat's questions). */
export interface UserLabels {
  first: string;
  reply: string;
}
const TASK_LABELS: UserLabels = { first: "Your task", reply: "Your reply" };

export function LiveOutput({
  taskId,
  labels = TASK_LABELS,
  emptyText = "No output yet. It streams here while the task runs.",
}: {
  taskId: string;
  labels?: UserLabels;
  emptyText?: string;
}) {
  const [raw, setRaw] = useState(false);
  const [itemLimit, setItemLimit] = useState(ITEM_WINDOW);
  const [rawLimit, setRawLimit] = useState(RAW_WINDOW);
  // The CLI's raw lines are most of what a run sends, and only this view shows them: they are
  // asked for (and kept in memory) only while it's switched on.
  useEffect(() => (raw ? ws.subscribeTaskRaw(taskId) : undefined), [raw, taskId]);
  // Rendered as transitions: typing and clicks go first.
  const items = useStoreTransition((s) => s.live[taskId]?.items ?? NO_ITEMS, [taskId]);
  const streaming = useStoreTransition((s) => s.live[taskId]?.streaming ?? "", [taskId]);
  const rawLines = useStoreTransition((s) => (raw ? (s.live[taskId]?.raw ?? NO_RAW) : NO_RAW), [taskId, raw]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const itemCount = items.length;
  const rawCount = rawLines.length;
  const streamingLength = streaming.length;
  const hiddenItems = Math.max(0, items.length - itemLimit);
  const hiddenRaw = Math.max(0, rawLines.length - rawLimit);
  const shownItems = hiddenItems > 0 ? items.slice(hiddenItems) : items;
  const shownRaw = hiddenRaw > 0 ? rawLines.slice(hiddenRaw) : rawLines;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when content grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [itemCount, rawCount, streamingLength, raw]);

  const showEarlier = (hidden: number, step: number, more: (step: number) => void) =>
    hidden > 0 && (
      <button
        type="button"
        onClick={() => {
          stick.current = false;
          more(step);
        }}
        className="mb-1 cursor-pointer self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-ink hover:underline"
      >
        Show {Math.min(hidden, step)} earlier of {hidden}
      </button>
    );

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
        {raw && rawLines.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No raw output kept for this task.</p>
        ) : !raw && items.length === 0 && !streaming ? (
          <p className="p-4 text-[13px] text-muted-foreground">{emptyText}</p>
        ) : raw ? (
          <pre className="flex min-h-full flex-col bg-paper-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-ink-2">
            {showEarlier(hiddenRaw, RAW_WINDOW * 2, (step) => setRawLimit((n) => n + step))}
            {shownRaw.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <RawRow key={hiddenRaw + i} line={r} />
            ))}
          </pre>
        ) : (
          <div className="flex max-w-3xl flex-col gap-2 px-4 py-3.5">
            {showEarlier(hiddenItems, ITEM_WINDOW * 2, (step) => setItemLimit((n) => n + step))}
            {shownItems.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only
              <div key={hiddenItems + i} className="offscreen-skip">
                <LiveRow item={item} labels={labels} />
              </div>
            ))}
            {streaming && (
              <div>
                <StreamingMarkdown text={streaming} />
                <span className="mt-1 inline-block h-3.5 w-0.75 animate-pulse rounded-full bg-signal align-middle motion-reduce:animate-none" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The reply being generated, split into blocks at blank lines (outside code fences). Finished blocks
 * are memoized, so each token re-parses only the last block, not the whole message so far.
 */
function StreamingMarkdown({ text }: { text: string }) {
  const blocks: string[] = [];
  let start = 0;
  let fenced = false;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const end = text.indexOf("\n", lineStart);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(lineStart, lineEnd);
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.trim() === "" && lineStart > start) {
      blocks.push(text.slice(start, lineStart));
      start = lineEnd + 1;
    }
    if (end === -1) break;
    lineStart = end + 1;
  }
  if (start < text.length) blocks.push(text.slice(start));
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only
        <Markdown key={i}>{block}</Markdown>
      ))}
    </div>
  );
}

// Raw lines are appended, never changed: each row renders once instead of on every flush (up to
// 1000 rows, ten times a second while a task runs).
const RawRow = memo(function RawRow({ line }: { line: LiveState["raw"][number] }) {
  return <div className={cn("offscreen-skip", line.src === "stderr" && "text-danger-ink")}>{line.line}</div>;
});

// Items never change once added (a finished tool call is replaced by a new object), so a row
// re-renders only when its own item does, and old messages aren't re-parsed on every token.
const LiveRow = memo(function LiveRow({ item, labels }: { item: LiveItem; labels: UserLabels }) {
  switch (item.type) {
    case "user":
      return (
        <div className="my-1.5 ml-auto flex w-fit max-w-[85%] min-w-0 flex-col gap-1.5 rounded-lg border border-rule-strong bg-paper-3 px-3 py-2">
          <span className="label-mono text-[10px] text-muted-foreground">{item.reply ? labels.reply : labels.first}</span>
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
                  <span className="truncate">{item.attachments.map((a) => a.name).join(", ")}</span>
                </span>
              )}
            </div>
          )}
          <AttachmentList files={item.attachments.filter((a) => PREVIEWABLE_IMAGE_TYPES.includes(a.mime))} />
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
