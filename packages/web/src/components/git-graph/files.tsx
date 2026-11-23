import type { CommitFile } from "@my-ai-slaves/shared";
import { FileMinusIcon, FilePenIcon, FilePlusIcon, FileSymlinkIcon, FolderTreeIcon, ListIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FolderRow } from "./sidebar";
import { type TreeNode, buildTree } from "./view-state";

const FILE_STATUS: Record<CommitFile["status"], { word: string; icon: typeof FilePenIcon; className: string }> = {
  A: { word: "added", icon: FilePlusIcon, className: "text-success-ink" },
  M: { word: "modified", icon: FilePenIcon, className: "text-warning-ink" },
  D: { word: "deleted", icon: FileMinusIcon, className: "text-danger-ink" },
  R: { word: "renamed", icon: FileSymlinkIcon, className: "text-signal-ink" },
  C: { word: "copied", icon: FileSymlinkIcon, className: "text-signal-ink" },
  T: { word: "type changed", icon: FilePenIcon, className: "text-warning-ink" },
};

function FileStatusIcon({ status }: { status: CommitFile["status"] }) {
  const { icon: Icon, className, word } = FILE_STATUS[status];
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-label={word} />;
}

/** A button on a file row, shown on hover (e.g. "Stage File"). */
export interface FileAction {
  label: string;
  onClick: (file: CommitFile) => void;
  disabled?: boolean;
}

function FileRow({
  file,
  label,
  depth,
  active,
  onOpen,
  action,
}: {
  file: CommitFile;
  label: React.ReactNode;
  depth: number;
  active: boolean;
  onOpen: (path: string) => void;
  action?: FileAction;
}) {
  return (
    <div
      className={cn(
        "group flex w-full items-center rounded-md text-xs text-ink-2 hover:bg-paper-2 hover:text-ink",
        active && "bg-signal-soft text-ink hover:bg-signal-soft",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(file.path)}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pr-2 text-left"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <FileStatusIcon status={file.status} />
        <span className="flex min-w-0 flex-1 font-mono">{label}</span>
      </button>
      {action && (
        <button
          type="button"
          disabled={action.disabled}
          onClick={() => action.onClick(file)}
          className="mr-1 hidden shrink-0 cursor-pointer rounded border border-rule bg-surface px-1.5 py-0.5 text-[11px] text-ink-2 group-hover:block hover:text-ink focus-visible:block disabled:cursor-default disabled:opacity-50"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export type FileView = "path" | "tree";

export function ViewToggle({ view, onView }: { view: FileView; onView: (view: FileView) => void }) {
  return (
    <div className="flex w-fit rounded-md border border-rule p-0.5">
      {(["path", "tree"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onView(v)}
          className={cn(
            "flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-ink",
            view === v && "bg-paper-2 text-ink",
          )}
        >
          {v === "path" ? <ListIcon className="size-3.5" /> : <FolderTreeIcon className="size-3.5" />}
          {v === "path" ? "Path" : "Tree"}
        </button>
      ))}
    </div>
  );
}

/** A list of changed files, as full paths or as a folder tree. */
export function FileList({
  files,
  view,
  openFile,
  onOpen,
  action,
}: {
  files: CommitFile[];
  view: FileView;
  openFile: string | null;
  onOpen: (path: string) => void;
  action?: FileAction;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files, (f) => f.path), [files]);

  const renderTree = (nodes: TreeNode<CommitFile>[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.item) {
        return (
          <FileRow
            key={`i:${node.path}`}
            file={node.item}
            label={<span className="truncate">{node.name}</span>}
            depth={depth}
            active={openFile === node.item.path}
            onOpen={onOpen}
            action={action}
          />
        );
      }
      const open = !closed.has(node.path);
      return (
        <div key={`f:${node.path}`}>
          <FolderRow
            depth={depth}
            name={node.name}
            open={open}
            onToggle={() =>
              setClosed((prev) => {
                const next = new Set(prev);
                if (!next.delete(node.path)) next.add(node.path);
                return next;
              })
            }
          />
          {open && renderTree(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <div className="flex flex-col">
      {view === "path"
        ? files.map((f) => {
            const slash = f.path.lastIndexOf("/");
            return (
              <FileRow
                key={f.path}
                file={f}
                depth={0}
                active={openFile === f.path}
                onOpen={onOpen}
                action={action}
                label={
                  // A long folder path gives way first, so the file name stays readable.
                  <>
                    {slash >= 0 && <span className="min-w-0 truncate text-muted-foreground">{f.path.slice(0, slash + 1)}</span>}
                    <span className="max-w-full shrink-0 truncate">{f.path.slice(slash + 1)}</span>
                  </>
                }
              />
            );
          })
        : renderTree(tree, 0)}
    </div>
  );
}

export function CommitFiles({
  files,
  openFile,
  onOpen,
}: {
  files: CommitFile[];
  openFile: string | null;
  onOpen: (path: string) => void;
}) {
  const [view, setView] = useState<FileView>("path");
  const counts = useMemo(() => {
    const by = new Map<CommitFile["status"], number>();
    for (const f of files) by.set(f.status, (by.get(f.status) ?? 0) + 1);
    return [...by];
  }, [files]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        {counts.length === 0 && <span className="text-muted-foreground">No file changes.</span>}
        {counts.map(([status, n]) => (
          <span key={status} className="flex items-center gap-1">
            <FileStatusIcon status={status} />
            <span className="num">{n}</span> {FILE_STATUS[status].word}
          </span>
        ))}
      </div>
      {files.length > 0 && <ViewToggle view={view} onView={setView} />}
      <FileList files={files} view={view} openFile={openFile} onOpen={onOpen} />
    </div>
  );
}
