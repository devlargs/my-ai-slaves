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

  const branchName = data?.branch ?? task.branch?.name ?? null;
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
    <div className="flex h-full min-h-0 flex-col gap-3">
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
        {branchName && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (await copyToClipboard(branchName)) toast.success("Branch name copied");
              else toast.error(`Couldn't copy. Branch: ${branchName}`);
            }}
          >
            <CopyIcon /> Copy branch name
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
          variant="signal"
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
          className="text-muted-foreground hover:bg-danger-soft hover:text-danger-ink"
          title="Discard this task?"
          description={
            <>
              Deletes branch <code className="font-mono">{task.branch?.name}</code> from the repo. This
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
        <div className="rounded-lg border border-rule bg-surface px-3 py-2.5 text-xs">
          {push.url && (
            <a
              href={push.url}
              target="_blank"
              rel="noreferrer"
              className="mb-1 flex items-center gap-1 font-medium text-signal-ink hover:underline"
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
        <p className="text-[13px] text-muted-foreground">Loading diff…</p>
      ) : files === null ? (
        <pre className="scroll-quiet min-h-0 flex-1 overflow-auto rounded-lg border border-rule bg-surface p-3 font-mono text-xs">{data?.patch}</pre>
      ) : files.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No changes on this branch yet.</p>
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
              const { add, del } = fileStats(f);
              return (
                <li key={`${f.oldPath}->${f.newPath}`}>
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
          <div className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-rule bg-surface">
            {visible.map((file) => (
              <div key={`${file.oldPath}->${file.newPath}`} className="border-b border-rule last:border-b-0">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-rule bg-paper-2 px-3 py-1.5 font-mono text-[11px] text-ink-2">
                  <span className="label-mono">{file.type}</span>
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
