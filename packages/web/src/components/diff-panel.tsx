import type { DiffResponse, TaskView } from "@my-ai-slaves/shared";
import { CheckCheckIcon, GitBranchIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Diff, type FileData, Hunk, parseDiff } from "react-diff-view";
import { ConfirmButton } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export function filePath(file: FileData): string {
  return file.type === "delete" ? file.oldPath : file.newPath;
}

export function fileStats(file: FileData) {
  let add = 0;
  let del = 0;
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === "insert") add++;
      else if (change.type === "delete") del++;
    }
  }
  return { add, del };
}

const fileKey = (file: FileData) => `${file.oldPath}->${file.newPath}`;
const lineCount = (file: FileData) => file.hunks.reduce((n, hunk) => n + hunk.changes.length, 0);

/** A file with more changed lines than this (a lockfile, generated code) is drawn only when asked for. */
const LARGE_FILE_LINES = 1500;
/** About one diff line, for the space a file holds before its rows are drawn. */
const ROW_PX = 20;

/**
 * One file of the diff. A review can touch hundreds of files, each a table of rows, so a file's rows
 * are only built once it comes near the view (`eager` ones at once); until then it holds its place
 * with an empty box of about the right height. Built rows stay, so scrolling back is instant.
 */
export const FileDiff = memo(function FileDiff({
  file,
  eager,
  scroller,
}: {
  file: FileData;
  eager: boolean;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const lines = useMemo(() => lineCount(file), [file]);
  const [near, setNear] = useState(eager);
  const [showLarge, setShowLarge] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const draw = near || eager;

  useEffect(() => {
    const el = box.current;
    if (draw || !el) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      root: scroller.current,
      rootMargin: "800px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draw, scroller]);

  return (
    <div ref={box} className="border-b border-rule last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-rule bg-paper-2 px-3 py-1.5 font-mono text-[11px] text-ink-2">
        <span className="label-mono">{file.type}</span>
        {file.type === "rename" ? `${file.oldPath} → ${file.newPath}` : filePath(file)}
      </div>
      {file.isBinary ? (
        <p className="p-2 text-xs text-muted-foreground">Binary file</p>
      ) : lines > LARGE_FILE_LINES && !showLarge ? (
        <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          Large diff, not shown by default: <span className="num">{lines.toLocaleString()}</span> lines.
          <Button size="sm" variant="outline" onClick={() => setShowLarge(true)}>
            Show it
          </Button>
        </p>
      ) : draw ? (
        <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ) : (
        <div style={{ height: lines * ROW_PX }} aria-hidden />
      )}
    </div>
  );
});

export function DiffPanel({ task, onDone }: { task: TaskView; onDone: () => void }) {
  const { data, loading, reload } = useApi<DiffResponse>(() => api.taskDiff(task.id), [task.id, task.updatedAt], `diff:${task.id}`);
  const files = useMemo(() => {
    if (!data?.patch.trim()) return [];
    try {
      return parseDiff(data.patch, { nearbySequences: "zip" });
    } catch {
      return null;
    }
  }, [data?.patch]);
  const stats = useMemo(() => new Map((files ?? []).map((f) => [fileKey(f), fileStats(f)])), [files]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const visible = files?.filter((f) => !selected || filePath(f) === selected) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {data && (
          <span
            className="mr-auto flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground"
            title={data.startedOn ? "Everything that changed in the checkout since the task started" : "Branch from an older version of the app"}
          >
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">
              {data.startedOn
                ? `${data.ref} · changes since ${data.from.slice(0, 7)}${data.startedOn.ref !== data.ref ? ` (started on ${data.startedOn.ref})` : ""}`
                : `${data.ref} ← ${data.from.slice(0, 7)}`}
            </span>
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
          <RefreshCwIcon className={cn(loading && "animate-spin")} /> Refresh
        </Button>
        <Button
          size="sm"
          variant="signal"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await attempt(api.finishTask(task.id));
            setBusy(false);
            if (ok) onDone();
          }}
        >
          <CheckCheckIcon /> Mark as finished
        </Button>
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          title="Discard this task?"
          description="Removes it from the queue. Nothing in the repo is touched: its changes stay where the agent left them."
          confirmLabel="Discard"
          disabled={busy}
          onConfirm={async () => {
            if (await attempt(api.discardTask(task.id))) onDone();
          }}
        >
          <Trash2Icon /> Discard
        </ConfirmButton>
      </div>

      {loading && !data ? (
        <p className="text-[13px] text-muted-foreground">Loading diff…</p>
      ) : files === null ? (
        <pre className="scroll-quiet min-h-0 flex-1 overflow-auto rounded-lg border border-rule bg-surface p-3 font-mono text-xs">{data?.patch}</pre>
      ) : files.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No changes in the checkout since the task started.</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <ul className="scroll-quiet w-56 shrink-0 overflow-auto rounded-lg border border-rule bg-surface p-1.5 text-xs">
            <li>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={cn(
                  "w-full cursor-pointer rounded-md px-2 py-1.5 text-left text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink",
                  !selected && "bg-paper-2 font-medium text-ink",
                )}
              >
                All files ({files.length})
              </button>
            </li>
            {files.map((f) => {
              const path = filePath(f);
              const { add, del } = stats.get(fileKey(f)) ?? { add: 0, del: 0 };
              return (
                <li key={fileKey(f)}>
                  <button
                    type="button"
                    onClick={() => setSelected(path)}
                    title={path}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink",
                      selected === path && "bg-paper-2 font-medium text-ink",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{path.split("/").pop()}</span>
                    <span className="num text-success-ink">+{add}</span>
                    <span className="num text-danger-ink">−{del}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div ref={scroller} className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-rule bg-surface">
            {visible.map((file, i) => (
              // The first files are on screen straight away; the rest are drawn as they scroll near.
              <FileDiff key={fileKey(file)} file={file} eager={i < 2} scroller={scroller} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
