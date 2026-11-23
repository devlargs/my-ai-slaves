import type {
  CommitDetail,
  CommitFile,
  CompareResult,
  GitCommitRequest,
  GraphCommit,
  WorkingChanges,
} from "@my-ai-slaves/shared";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  GitCommitHorizontalIcon,
  Loader2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiff } from "react-diff-view";
import { FileDiff, filePath } from "@/components/diff-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type FileAction, type FileView, ViewToggle, FileList, CommitFiles } from "./files";
import { initial, avatarUrl } from "./rows";

/** Which list of the WIP panel a file was opened from. */
export type WipSection = "unstaged" | "staged";

/** The summary line's soft limit; the counter goes negative past it, like GitKraken's. */
const SUMMARY_LIMIT = 72;

/**
 * The WIP row's details, like GitKraken's: the checkout's unstaged and staged files (stage / unstage
 * one file or all of them), and a commit box that commits what's staged. Nothing changes until you click.
 */
export function WipPanel({
  repoId,
  headCommit,
  changes,
  error,
  busy,
  openFile,
  onOpenFile,
  onStage,
  onUnstage,
  onCommit,
}: {
  repoId: string;
  /** The checked-out commit: what "Amend previous commit" replaces. */
  headCommit: string | null;
  changes: WorkingChanges | null;
  error: string | null;
  busy: boolean;
  openFile: { section: WipSection; path: string } | null;
  onOpenFile: (section: WipSection, path: string) => void;
  onStage: (files: CommitFile[] | null) => void;
  onUnstage: (files: CommitFile[] | null) => void;
  onCommit: (input: GitCommitRequest) => Promise<boolean>;
}) {
  const [view, setView] = useState<FileView>("path");
  const [closed, setClosed] = useState<Set<WipSection>>(new Set());
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [options, setOptions] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const total = changes ? new Set([...changes.staged, ...changes.unstaged].map((f) => f.path)).size : 0;
  const staged = changes?.staged.length ?? 0;

  // Amending starts from the last commit's message (only when nothing's written yet).
  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (!on || !headCommit || summary.trim() || description.trim()) return;
    api.getCommit(repoId, headCommit).then(
      (c) => {
        setSummary((s) => s || c.subject);
        setDescription((d) => d || c.body);
      },
      () => {},
    );
  };

  const canCommit = !busy && !!summary.trim() && (staged > 0 || amend);
  const commit = async () => {
    if (!canCommit) return;
    const ok = await onCommit({ summary: summary.trim(), description: description.trim() || undefined, amend, noVerify });
    if (ok) {
      setSummary("");
      setDescription("");
      setAmend(false);
    }
  };

  const section = (key: WipSection, label: string, files: CommitFile[]) => {
    const open = !closed.has(key);
    const all = key === "unstaged" ? "Stage All Changes" : "Unstage All Changes";
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setClosed((prev) => {
                const next = new Set(prev);
                if (!next.delete(key)) next.add(key);
                return next;
              })
            }
            className="flex flex-1 cursor-pointer items-center gap-1.5 py-1 text-left text-xs font-medium text-ink-2 hover:text-ink"
          >
            {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            {label} <span className="num text-muted-foreground">({files.length})</span>
          </button>
          {files.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => (key === "unstaged" ? onStage(null) : onUnstage(null))}
            >
              {all}
            </Button>
          )}
        </div>
        {open &&
          (files.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">None.</p>
          ) : (
            <FileList
              files={files}
              view={view}
              openFile={openFile?.section === key ? openFile.path : null}
              onOpen={(path) => onOpenFile(key, path)}
              action={{
                label: key === "unstaged" ? "Stage File" : "Unstage File",
                disabled: busy,
                onClick: (f) => (key === "unstaged" ? onStage([f]) : onUnstage([f])),
              }}
            />
          ))}
      </div>
    );
  };

  const left = SUMMARY_LIMIT - summary.length;
  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-hidden rounded-lg border border-rule bg-surface text-sm">
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2">
          <span className="label-mono text-muted-foreground">Work in progress</span>
          {changes && (
            <span>
              <span className="num font-medium text-ink">{total}</span> {total === 1 ? "file change" : "file changes"}
              {changes.head && (
                <>
                  {" "}
                  on{" "}
                  <span className="font-mono text-signal-ink">{changes.head.length === 40 ? changes.head.slice(0, 10) : changes.head}</span>
                </>
              )}
            </span>
          )}
          {busy && <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {error && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger-ink">{error}</p>}
        {!changes ? (
          !error && (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
            </div>
          )
        ) : (
          <>
            {total > 0 && <ViewToggle view={view} onView={setView} />}
            {total === 0 && <p className="text-xs text-muted-foreground">No uncommitted changes.</p>}
            {section("unstaged", "Unstaged files", changes.unstaged)}
            {section("staged", "Staged files", changes.staged)}
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-rule p-3">
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            className="accent-signal"
            checked={amend}
            disabled={!headCommit}
            onChange={(e) => toggleAmend(e.target.checked)}
          />
          Amend previous commit
        </label>
        <div className="flex flex-col rounded-md border border-rule bg-paper focus-within:border-signal">
          <div className="flex items-center gap-2 px-3">
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value.replace(/[\r\n]+/g, " "))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
              }}
              placeholder="Commit summary"
              aria-label="Commit summary"
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-muted-foreground"
            />
            <span className={cn("num text-xs", left < 0 ? "text-danger-ink" : "text-muted-foreground")}>{left}</span>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
            }}
            placeholder="Description"
            aria-label="Commit description"
            rows={4}
            className="scroll-quiet min-h-16 resize-y bg-transparent px-3 pb-2 text-xs leading-relaxed text-ink outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="button"
          onClick={() => setOptions((o) => !o)}
          className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-ink"
        >
          {options ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          Commit options
        </button>
        {options && (
          <label className="flex w-fit cursor-pointer items-center gap-2 pl-4 text-xs text-ink-2">
            <input
              type="checkbox"
              className="accent-signal"
              checked={noVerify}
              onChange={(e) => setNoVerify(e.target.checked)}
            />
            Skip Git hooks (--no-verify)
          </label>
        )}
        <Button variant="signal" disabled={!canCommit} onClick={() => void commit()} title="⌘/Ctrl + Enter">
          {busy ? <Loader2Icon className="animate-spin" /> : <GitCommitHorizontalIcon />}
          {staged === 0 && !amend
            ? "Stage Changes to Commit"
            : amend
              ? "Amend Previous Commit"
              : `Commit Changes to ${staged} ${staged === 1 ? "File" : "Files"}`}
        </Button>
      </div>
    </aside>
  );
}

export function CommitPanel({
  commit,
  kind = "Commit",
  detail,
  error,
  openFile,
  onOpenFile,
  onJump,
  avatars,
}: {
  commit: GraphCommit;
  kind?: string;
  /** Settings → "Show author avatars". */
  avatars: boolean;
  detail: CommitDetail | null;
  error: string | null;
  openFile: string | null;
  onOpenFile: (path: string) => void;
  onJump: (hash: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when another commit is shown
  useEffect(() => setCopied(false), [commit.hash]);
  return (
    <aside className="scroll-quiet flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-rule bg-surface p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="label-mono">{kind}</span>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 font-mono text-ink-2 hover:text-ink"
          title={`Copy ${commit.hash}`}
          onClick={() => {
            void navigator.clipboard?.writeText(commit.hash).then(() => setCopied(true));
          }}
        >
          {commit.hash.slice(0, 7)}
          {copied ? <CheckIcon className="size-3 text-success-ink" /> : <CopyIcon className="size-3" />}
        </button>
      </div>
      <div className="rounded-md border border-rule bg-paper-2/50 p-2.5">
        <p className="font-medium leading-snug whitespace-pre-wrap text-ink">{commit.subject}</p>
        {detail?.body && <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{detail.body}</p>}
      </div>
      <div className="flex items-start gap-2.5">
        <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-signal-soft text-sm font-medium text-signal-ink">
          {initial(commit.author)}
          {avatars && commit.avatar && (
            <img
              key={commit.avatar}
              src={avatarUrl(commit.avatar, 64)}
              alt=""
              loading="lazy"
              className="absolute inset-0 size-full"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ink" title={commit.email}>
            {commit.author}
          </span>
          <span className="text-[11px] text-muted-foreground">authored {new Date(commit.date).toLocaleString()}</span>
          {detail?.committer && detail.committer !== commit.author && (
            <span className="text-[11px] text-muted-foreground">committed by {detail.committer}</span>
          )}
        </div>
        {commit.parents.length > 0 && (
          <div className="flex shrink-0 flex-col items-end text-[11px] text-muted-foreground">
            <span>{commit.parents.length > 1 ? "parents" : "parent"}</span>
            {commit.parents.map((p) => (
              <button key={p} type="button" className="cursor-pointer font-mono text-signal-ink hover:underline" onClick={() => onJump(p)}>
                {p.slice(0, 7)}
              </button>
            ))}
          </div>
        )}
      </div>
      {commit.parents.length > 1 && <p className="text-[11px] text-muted-foreground">Merge commit: changes shown against the first parent.</p>}
      <div className="border-t border-rule" />
      {error ? (
        <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger-ink">{error}</p>
      ) : !detail ? (
        <div className="flex justify-center py-4 text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
        </div>
      ) : (
        <CommitFiles files={detail.files} openFile={openFile} onOpen={onOpenFile} />
      )}
    </aside>
  );
}

/** One file's changes in the selected commit (or the WIP's staged / unstaged list), in place of the graph. */
export function CommitFileView({
  files,
  patch,
  path,
  label,
  action,
  onBack,
  onOpen,
}: {
  files: CommitFile[];
  patch: string;
  path: string;
  /** Shown before the path, e.g. "Unstaged". */
  label?: string;
  /** "Stage File" / "Unstage File" for a WIP file. */
  action?: FileAction;
  onBack: () => void;
  onOpen: (path: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => {
    try {
      return parseDiff(patch, { nearbySequences: "zip" });
    } catch {
      return null;
    }
  }, [patch]);
  const file = parsed?.find((f) => filePath(f) === path);
  const index = files.findIndex((f) => f.path === path);
  const prev = files[index - 1];
  const next = files[index + 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll back to the top when another file opens
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [path]);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule bg-paper-2 px-2 py-1">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon /> Graph
        </Button>
        {label && <Badge variant="outline">{label}</Badge>}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2" title={path}>
          {path}
        </span>
        {action && files[index] && (
          <Button size="sm" variant="outline" disabled={action.disabled} onClick={() => action.onClick(files[index]!)}>
            {action.label}
          </Button>
        )}
        <span className="num text-[11px] text-muted-foreground">
          {index + 1} / {files.length}
        </span>
        <Button size="sm" variant="ghost" disabled={!prev} onClick={() => prev && onOpen(prev.path)}>
          Previous
        </Button>
        <Button size="sm" variant="ghost" disabled={!next} onClick={() => next && onOpen(next.path)}>
          Next
        </Button>
      </div>
      <div ref={scroller} className="scroll-quiet min-h-0 flex-1 overflow-auto">
        {file ? (
          <FileDiff key={path} file={file} eager scroller={scroller} />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            {parsed === null ? "This diff couldn't be read." : "No text changes in this file (mode change or empty file)."}
          </p>
        )}
      </div>
    </div>
  );
}

/** "Compare commit against working directory": the files that differ, like a commit's panel. */
export function ComparePanel({
  result,
  openFile,
  onOpenFile,
  onClose,
}: {
  result: CompareResult;
  openFile: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="scroll-quiet flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-rule bg-surface p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="label-mono">Compare</span>
        <span className="font-mono text-ink-2">{result.hash.slice(0, 7)}</span>
        <span>↔ working directory</span>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="border-t border-rule" />
      <CommitFiles files={result.files} openFile={openFile} onOpen={onOpenFile} />
    </aside>
  );
}
