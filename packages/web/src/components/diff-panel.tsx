import type { DiffResponse, TaskView } from "@my-ai-slaves/shared";
import {
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Diff, type FileData, Hunk, parseDiff } from "react-diff-view";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { api, attempt } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, copyToClipboard } from "@/lib/utils";

function filePath(file: FileData): string {
  return file.type === "delete" ? file.oldPath : file.newPath;
}

function fileStats(file: FileData) {
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

export function DiffPanel({ task, onDone }: { task: TaskView; onDone: () => void }) {
  const { data, loading, reload } = useApi<DiffResponse>(() => api.taskDiff(task.id), [task.id, task.updatedAt]);
  const files = useMemo(() => {
    if (!data?.patch.trim()) return [];
    try {
      return parseDiff(data.patch, { nearbySequences: "zip" });
    } catch {
      return null;
    }
  }, [data?.patch]);
  const [selected, setSelected] = useState<string | null>(null);
  const [push, setPush] = useState<{ url: string | null; output: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const worktreePath = data?.worktreePath ?? task.worktree?.path ?? null;
  const visible = files?.filter((f) => !selected || filePath(f) === selected) ?? [];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {data && (
          <span className="mr-auto flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <GitBranchIcon className="size-3" />
            {data.branch} ← {data.baseBranch}@{data.baseCommit.slice(0, 7)}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
          <RefreshCwIcon className={cn(loading && "animate-spin")} /> Refresh
        </Button>
        {worktreePath && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (await copyToClipboard(worktreePath)) toast.success("Worktree path copied");
              else toast.error(`Couldn't copy. Path: ${worktreePath}`);
            }}
          >
            <CopyIcon /> Copy worktree path
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (await attempt(api.keepTask(task.id), "Branch kept")) onDone();
            })
          }
        >
          <GitBranchIcon /> Keep branch
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const result = await attempt(api.pushTask(task.id));
              if (result) {
                setPush(result);
                toast.success(result.url ? "Pushed and opened PR/MR" : "Pushed");
              }
            })
          }
        >
          <UploadIcon /> Push + open PR/MR
        </Button>
        <ConfirmButton
          size="sm"
          variant="ghost"
          className="text-destructive"
          title="Discard this task?"
          description={
            <>
              Removes the worktree and deletes branch <code className="font-mono">{task.worktree?.branch}</code>. This
              can&apos;t be undone.
            </>
          }
          confirmLabel="Discard"
          disabled={busy}
          onConfirm={async () => {
            if (await attempt(api.discardTask(task.id), "Discarded")) onDone();
          }}
        >
          <Trash2Icon /> Discard
        </ConfirmButton>
      </div>

      {push && (
        <div className="rounded-md border bg-card p-2 text-xs">
          {push.url && (
            <a
              href={push.url}
              target="_blank"
              rel="noreferrer"
              className="mb-1 flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <ExternalLinkIcon className="size-3.5" /> {push.url}
            </a>
          )}
          {push.output && (
            <pre className="max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {push.output}
            </pre>
          )}
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading diff…</p>
      ) : files === null ? (
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-card p-2 font-mono text-xs">{data?.patch}</pre>
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes in the worktree yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          <ul className="w-56 shrink-0 overflow-auto rounded-md border bg-card p-1 text-xs">
            <li>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={cn(
                  "w-full rounded px-2 py-1 text-left cursor-pointer hover:bg-accent",
                  !selected && "bg-accent font-medium",
                )}
              >
                All files ({files.length})
              </button>
            </li>
            {files.map((f) => {
              const path = filePath(f);
              const { add, del } = fileStats(f);
              return (
                <li key={`${f.oldPath}->${f.newPath}`}>
                  <button
                    type="button"
                    onClick={() => setSelected(path)}
                    title={path}
                    className={cn(
                      "flex w-full items-center gap-1 rounded px-2 py-1 text-left cursor-pointer hover:bg-accent",
                      selected === path && "bg-accent font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{path.split("/").pop()}</span>
                    <span className="text-success">+{add}</span>
                    <span className="text-destructive">−{del}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-card">
            {visible.map((file) => (
              <div key={`${file.oldPath}->${file.newPath}`} className="border-b last:border-b-0">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted px-2 py-1 font-mono text-[11px]">
                  <span className="font-semibold uppercase text-muted-foreground">{file.type}</span>
                  {file.type === "rename" ? `${file.oldPath} → ${file.newPath}` : filePath(file)}
                </div>
                {file.isBinary ? (
                  <p className="p-2 text-xs text-muted-foreground">Binary file</p>
                ) : (
                  <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                    {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                  </Diff>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
