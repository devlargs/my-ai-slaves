import type {
  CommitDetail,
  CommitFile,
  CompareResult,
  GitCommitRequest,
  GitRefAction,
  PullMode,
  RepoGraph,
  Settings,
  StashEntry,
  WorkingChanges,
} from "@my-ai-slaves/shared";
import { GitBranchIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { cn, formatTime, storageSet } from "@/lib/utils";
import { type WipSection, WipPanel, CommitPanel, CommitFileView, ComparePanel } from "./details";
import { autoGraphWidth } from "./columns";
import { GraphHeader, useColumnWidths } from "./header";
import { PAGE, ROW, DOT, OVERSCAN, layout, x, WIP, wipCommit, edgePath } from "./layout";
import { type ActionSpec, ActionDialog, RefMenu } from "./menu";
import { RebaseDialog } from "./rebase-dialog";
import { CommitAvatar, RefCell, BranchNameInput, WipMessage } from "./rows";
import { BranchSidebar, StashMenu } from "./sidebar";
import { PULL_KEY, storedPullMode, type GitAction, GitToolbar } from "./toolbar";
import {
  groupRefs,
  stashCommit,
  type MenuTarget,
  type GraphView,
  viewKey,
  storedView,
  refCommits,
  visibleCommits,
} from "./view-state";

/**
 * GitKraken-style view of a repo: branches, the commit graph, and each commit's files and diffs. The
 * toolbar (Undo / Redo / Pull / Branch) is the only thing here that changes the repo, on a click.
 */
export function GitGraphDialog({
  repoId,
  repoName,
  open,
  onOpenChange,
}: {
  repoId: string;
  repoName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: settings } = useApi<Settings>(() => api.getSettings(), [], "settings");
  const avatars = settings?.commitAvatars ?? false;
  const [limit, setLimit] = useState(PAGE);
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [wip, setWip] = useState<WorkingChanges | null>(null);
  const [wipError, setWipError] = useState<string | null>(null);
  const [wipFile, setWipFile] = useState<{ section: WipSection; path: string } | null>(null);
  /** Bumped to read the WIP files again after staging / unstaging. */
  const [wipTick, setWipTick] = useState(0);
  const [wipBusy, setWipBusy] = useState(false);
  const [wipActionError, setWipActionError] = useState<string | null>(null);
  const details = useRef(new Map<string, CommitDetail>());
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [acting, setActing] = useState<GitAction | null>(null);
  const [pullMode, setPullMode] = useState<PullMode>(storedPullMode);
  /** The inline branch-name field: at the checked-out commit (Branch button) or a right-clicked one. */
  const [naming, setNaming] = useState<{ at: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const [stashMenu, setStashMenu] = useState<{ x: number; y: number; stash: StashEntry } | null>(null);
  const [ask, setAsk] = useState<ActionSpec | null>(null);
  const [rebaseOnto, setRebaseOnto] = useState<string | null>(null);
  const [view, setViewState] = useState<GraphView>(() => storedView(repoId));
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [compareFile, setCompareFile] = useState<string | null>(null);
  useEffect(() => setViewState(storedView(repoId)), [repoId]);
  const setView = (next: GraphView) => {
    setViewState(next);
    storageSet(viewKey(repoId), JSON.stringify(next));
  };

  const load = async (n: number): Promise<RepoGraph | null> => {
    setLoading(true);
    setError(null);
    try {
      const g = await api.getRepoGraph(repoId, n);
      setGraph(g);
      return g;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when opened or when more commits are asked for
  useEffect(() => {
    if (open) void load(limit);
  }, [open, limit, repoId]);

  useEffect(() => {
    if (!open) {
      setGraph(null);
      setSelected(null);
      setLimit(PAGE);
      setScrollTop(0);
      setNaming(null);
      setMenu(null);
      setStashMenu(null);
      setCompare(null);
      setCompareFile(null);
      details.current.clear();
    }
  }, [open]);

  // The WIP row's files and diffs: read again whenever the graph is (they change all the time).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload whenever the graph is reloaded
  useEffect(() => {
    if (selected !== WIP) {
      setWip(null);
      setWipFile(null);
      setWipActionError(null);
      return;
    }
    setWipError(null);
    let live = true;
    api.getWorkingChanges(repoId).then(
      (w) => {
        if (!live) return;
        setWip(w);
        // An open diff follows its file when it's staged / unstaged, and closes when the file is gone.
        setWipFile((f) => {
          if (!f || w[f.section].some((x) => x.path === f.path)) return f;
          const other: WipSection = f.section === "staged" ? "unstaged" : "staged";
          return w[other].some((x) => x.path === f.path) ? { section: other, path: f.path } : null;
        });
      },
      (e: unknown) => live && setWipError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [selected, repoId, graph, wipTick]);

  // The selected commit's files and diff (kept per commit: a commit never changes).
  useEffect(() => {
    setOpenFile(null);
    setDetailError(null);
    if (!selected || selected === WIP) return setDetail(null);
    const cached = details.current.get(selected);
    setDetail(cached ?? null);
    if (cached) return;
    let live = true;
    api.getCommit(repoId, selected).then(
      (d) => {
        details.current.set(selected, d);
        if (live) setDetail(d);
      },
      (e: unknown) => live && setDetailError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [selected, repoId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe only when the scrolled element is swapped
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [graph !== null, openFile === null, wipFile === null, compareFile === null]);

  const { rows, width } = useMemo(() => {
    if (!graph) return layout([]);
    const commits = visibleCommits(graph, view);
    const pinned = view.pinned ? (refCommits(graph).get(view.pinned) ?? null) : null;
    if (!graph.wip) return layout(commits, pinned);
    // The WIP row hangs off the checked-out commit (when that's shown).
    const head =
      graph.commits.find((c) => c.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> ")))?.hash ??
      graph.local.find((b) => b.current)?.commit ??
      null;
    if (head && !commits.some((c) => c.hash === head)) return layout(commits, pinned);
    return layout([wipCommit(head), ...commits], pinned);
  }, [graph, view]);
  const [cols, resizeColumn] = useColumnWidths();
  const graphWidth = cols.graph ?? autoGraphWidth(width);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.hash, i])), [rows]);
  const loaded = useMemo(() => new Set(index.keys()), [index]);
  const remoteRefs = useMemo(() => new Map((graph?.remote ?? []).map((r) => [r.ref, r])), [graph]);
  const selectedStash = selected ? graph?.stashes.find((st) => st.hash === selected) : undefined;
  const current = selected ? (rows[index.get(selected) ?? -1]?.commit ?? (selectedStash && stashCommit(selectedStash))) : undefined;

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);

  // The checked-out commit's row: where a new branch starts.
  const headRow = Math.max(0, rows.findIndex((r) => r.commit.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "))));

  const act = async (action: GitAction, name?: string) => {
    if (action === "branch" && name === undefined) {
      startNaming(null);
      return;
    }
    setActing(action);
    setError(null);
    try {
      if (action === "undo") await api.gitUndo(repoId);
      else if (action === "redo") await api.gitRedo(repoId);
      else if (action === "pull") await api.gitPull(repoId, pullMode);
      else await api.gitBranch(repoId, name!);
      setNaming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
      await load(limit);
    }
  };

  /** The inline branch name field, on the checked-out commit (at = null) or another one. */
  const startNaming = (at: string | null) => {
    setOpenFile(null);
    setWipFile(null);
    setCompareFile(null);
    setNaming({ at });
    const row = at ? (index.get(at) ?? headRow) : headRow;
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el && (row * ROW < el.scrollTop || (row + 1) * ROW > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, row * ROW - el.clientHeight / 2);
    });
  };
  const namingRow = naming ? (naming.at ? (index.get(naming.at) ?? headRow) : headRow) : headRow;

  /** A right-click menu action. Errors show above the graph (or in the dialog that asked for it). */
  const runRef = async (action: GitRefAction, fromDialog = false) => {
    setActing("ref");
    setError(null);
    try {
      await api.gitRefAction(repoId, action);
      if (action.op === "create-branch") setNaming(null);
    } catch (e) {
      if (fromDialog) throw e;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
      details.current.clear();
      await load(limit);
    }
  };

  const openMenu = (e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    e.stopPropagation();
    if (acting !== null) return;
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const openStashMenu = (e: React.MouseEvent, stash: StashEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (acting !== null) return;
    setStashMenu({ x: e.clientX, y: e.clientY, stash });
  };

  /** A stash's files and diff in the details pane (stashes aren't rows in the graph). */
  const pickStash = (stash: StashEntry) => {
    setSelected(stash.hash);
    setOpenFile(null);
    setWipFile(null);
    setCompare(null);
    setCompareFile(null);
  };

  const compareWith = async (commit: string) => {
    setError(null);
    try {
      const result = await api.compareCommit(repoId, commit);
      setSelected(null);
      setOpenFile(null);
      setWipFile(null);
      setCompare(result);
      setCompareFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Stage / unstage files (null = all), then read the WIP files again. */
  const stageFiles = async (stage: boolean, files: CommitFile[] | null) => {
    setWipBusy(true);
    setWipActionError(null);
    try {
      // Unstaging a rename takes both sides of it out of the index.
      const paths = files && [...new Set(files.flatMap((f) => (stage || !f.oldPath ? [f.path] : [f.path, f.oldPath])))];
      if (stage) await api.gitStage(repoId, paths);
      else await api.gitUnstage(repoId, paths);
    } catch (e) {
      setWipActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setWipBusy(false);
      setWipTick((t) => t + 1);
    }
  };

  const commitStaged = async (input: GitCommitRequest): Promise<boolean> => {
    setWipBusy(true);
    setWipActionError(null);
    try {
      await api.gitCommit(repoId, input);
    } catch (e) {
      setWipActionError(e instanceof Error ? e.message : String(e));
      setWipBusy(false);
      return false;
    }
    setWipBusy(false);
    setWipFile(null);
    const g = await load(limit);
    // Nothing left to commit: show the new commit, as GitKraken does.
    if (g && !g.wip) {
      const head = g.commits.find((c) => c.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> ")));
      setSelected(head?.hash ?? null);
    }
    return true;
  };

  const jump = (hash: string) => {
    const i = index.get(hash);
    if (i === undefined) return;
    setSelected(hash);
    setOpenFile(null);
    setWipFile(null);
    setCompare(null);
    setCompareFile(null);
    // The graph may be remounting (coming back from a file): scroll once it's there.
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el && (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight)) {
        el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[calc(100vh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none gap-3 p-4"
        onEscapeKeyDown={(e) => {
          // Escape in the branch name field cancels it, not the whole view.
          if (naming) {
            e.preventDefault();
            setNaming(null);
          }
        }}
      >
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle>{repoName}</DialogTitle>
          {graph?.head && (
            <Badge variant="signal" className="gap-1 font-mono">
              <GitBranchIcon className="size-3" />
              {graph.head.length === 40 ? graph.head.slice(0, 10) : graph.head}
            </Badge>
          )}
          <DialogDescription className="text-xs">
            {graph ? `${graph.commits.length}${graph.more ? "+" : ""} commits · all branches` : "Commit graph"}
          </DialogDescription>
          {acting === "ref" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" /> Working…
            </span>
          )}
          <div className="mx-auto">
            <GitToolbar
              history={graph?.history ?? null}
              acting={acting}
              pullMode={pullMode}
              onPullMode={(mode) => {
                setPullMode(mode);
                storageSet(PULL_KEY, mode);
              }}
              onAction={(a) => void act(a)}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => {
              details.current.clear();
              void load(limit);
            }}
          >
            {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Refresh
          </Button>
        </div>
        {error && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger-ink">{error}</p>}
        {!graph && loading && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        )}
        {graph && rows.length === 0 && (
          <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No commits yet.</p>
        )}
        {graph && rows.length > 0 && (
          <div className="flex min-h-0 flex-1 gap-3">
            <BranchSidebar
              graph={graph}
              loaded={loaded}
              selected={selected}
              view={view}
              onPick={jump}
              onMenu={openMenu}
              onPickStash={pickStash}
              onStashMenu={openStashMenu}
              onShowAll={() => setView({ ...view, hidden: [], solo: [] })}
              onShowStashes={() => setView({ ...view, hiddenStashes: [] })}
            />
            {compare && compareFile ? (
              <CommitFileView
                files={compare.files}
                patch={compare.patch}
                path={compareFile}
                label={`${compare.hash.slice(0, 7)} ↔ working directory`}
                onBack={() => setCompareFile(null)}
                onOpen={setCompareFile}
              />
            ) : selected === WIP && wipFile && wip ? (
              <CommitFileView
                files={wip[wipFile.section]}
                patch={wipFile.section === "staged" ? wip.stagedPatch : wip.unstagedPatch}
                path={wipFile.path}
                label={wipFile.section === "staged" ? "Staged" : "Unstaged"}
                action={{
                  label: wipFile.section === "staged" ? "Unstage File" : "Stage File",
                  disabled: wipBusy,
                  onClick: (f) => void stageFiles(wipFile.section === "unstaged", [f]),
                }}
                onBack={() => jump(WIP)}
                onOpen={(path) => setWipFile({ section: wipFile.section, path })}
              />
            ) : openFile && detail ? (
              <CommitFileView files={detail.files} patch={detail.patch} path={openFile} onBack={() => jump(detail.hash)} onOpen={setOpenFile} />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-rule bg-surface">
                <GraphHeader widths={cols} graphWidth={graphWidth} onResize={resizeColumn} />
                <div
                  ref={scroller}
                  className="min-h-0 flex-1 overflow-y-auto"
                  onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                >
                  <div className="relative" style={{ height: rows.length * ROW + (graph.more ? 44 : 0) }}>
                    {rows.slice(first, last).map((row, n) => {
                      const i = first + n;
                      const c = row.commit;
                      const isSelected = c.hash === selected;
                      const isWip = c.hash === WIP;
                      const groups = c.refs.length ? groupRefs(c.refs, remoteRefs) : [];
                      return (
                        <button
                          key={c.hash}
                          type="button"
                          onClick={() => {
                            setCompare(null);
                            setSelected(isSelected ? null : c.hash);
                          }}
                          onContextMenu={isWip ? undefined : (e) => openMenu(e, { commit: c.hash, local: null, remotes: [] })}
                          className={cn(
                            "absolute inset-x-0 flex cursor-pointer items-center text-left text-xs hover:bg-paper-2",
                            isSelected && "bg-signal-soft hover:bg-signal-soft",
                          )}
                          style={{ top: i * ROW, height: ROW }}
                        >
                          <span className="flex shrink-0 items-center overflow-hidden pl-2" style={{ width: cols.ref }}>
                            <RefCell
                              groups={groups}
                              color={row.color}
                              onMenu={(e, g) =>
                                openMenu(e, {
                                  commit: c.hash,
                                  local: g.local ? g.name : null,
                                  remotes: g.remotes.map((r) => `${r}/${g.name}`),
                                })
                              }
                            />
                          </span>
                          <svg
                            width={graphWidth}
                            height={ROW}
                            className="shrink-0 overflow-hidden"
                            viewBox={`0 0 ${graphWidth} ${ROW}`}
                            aria-hidden
                          >
                            {groups.length > 0 && (
                              <path d={`M0 ${ROW / 2}H${x(row.lane) - DOT}`} stroke={row.color} strokeOpacity={0.7} strokeWidth={1} />
                            )}
                            {row.edges.map((e, k) => (
                              <path
                                // biome-ignore lint/suspicious/noArrayIndexKey: a row's edges are rebuilt together and never reorder
                                key={k}
                                d={edgePath(e)}
                                stroke={e.color}
                                strokeWidth={2}
                                strokeDasharray={e.dashed ? "2 3" : undefined}
                                fill="none"
                              />
                            ))}
                            {isWip ? (
                              <circle
                                cx={x(row.lane)}
                                cy={ROW / 2}
                                r={DOT - 2}
                                fill="var(--color-surface)"
                                stroke={row.color}
                                strokeWidth={2}
                                strokeDasharray="3 2"
                              />
                            ) : (
                              <CommitAvatar commit={c} cx={x(row.lane)} color={row.color} avatars={avatars} />
                            )}
                          </svg>
                          {isWip && graph.wip ? (
                            <WipMessage summary={graph.wip} />
                          ) : (
                            <span className={cn("min-w-0 flex-1 truncate px-2", c.parents.length > 1 ? "text-muted-foreground" : "text-ink")}>
                              {c.subject}
                            </span>
                          )}
                          <span className="hidden shrink-0 truncate px-2 text-muted-foreground xl:block" style={{ width: cols.author }}>
                            {c.author}
                          </span>
                          <span
                            className="shrink-0 truncate px-2 text-muted-foreground"
                            style={{ width: cols.date }}
                            title={isWip ? undefined : new Date(c.date).toLocaleString()}
                          >
                            {isWip ? "" : formatTime(c.date)}
                          </span>
                          <span
                            className="hidden shrink-0 truncate px-2 font-mono text-[11px] text-muted-foreground 2xl:block"
                            style={{ width: cols.hash }}
                          >
                            {isWip ? "" : c.hash.slice(0, 7)}
                          </span>
                        </button>
                      );
                    })}
                    {naming && (
                      <div
                        className="absolute left-0 z-10 flex items-center bg-surface px-2"
                        style={{ top: namingRow * ROW, height: ROW, width: cols.ref }}
                      >
                        <BranchNameInput
                          busy={acting === "branch" || acting === "ref"}
                          onSubmit={(n) =>
                            void (naming.at ? runRef({ op: "create-branch", name: n, commit: naming.at }) : act("branch", n))
                          }
                          onCancel={() => setNaming(null)}
                        />
                      </div>
                    )}
                    {graph.more && (
                      <div className="absolute inset-x-0 flex justify-center" style={{ top: rows.length * ROW + 8 }}>
                        <Button size="sm" variant="outline" disabled={loading} onClick={() => setLimit((n) => n + PAGE)}>
                          {loading && <Loader2Icon className="animate-spin" />} Load older commits
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {compare && (
              <ComparePanel
                result={compare}
                openFile={compareFile}
                onOpenFile={setCompareFile}
                onClose={() => {
                  setCompare(null);
                  setCompareFile(null);
                }}
              />
            )}
            {!compare && current && selected === WIP && (
              <WipPanel
                repoId={repoId}
                headCommit={current.parents[0] ?? null}
                changes={wip}
                error={wipActionError ?? wipError}
                busy={wipBusy}
                openFile={wipFile}
                onOpenFile={(section, path) => setWipFile({ section, path })}
                onStage={(files) => void stageFiles(true, files)}
                onUnstage={(files) => void stageFiles(false, files)}
                onCommit={commitStaged}
              />
            )}
            {!compare && current && selected !== WIP && (
              <CommitPanel
                commit={current}
                kind={selectedStash ? "Stash" : "Commit"}
                detail={detail}
                error={detailError}
                openFile={openFile}
                onOpenFile={setOpenFile}
                onJump={jump}
                avatars={avatars}
              />
            )}
          </div>
        )}
        {graph && (
          <RefMenu
            menu={menu}
            graph={graph}
            view={view}
            onClose={() => setMenu(null)}
            onRun={runRef}
            onAsk={setAsk}
            onRebase={setRebaseOnto}
            onBranchHere={startNaming}
            onView={setView}
            onCompare={(c) => void compareWith(c)}
          />
        )}
        <StashMenu
          menu={stashMenu}
          onClose={() => setStashMenu(null)}
          onRun={runRef}
          onAsk={setAsk}
          onHide={(st) => {
            // Drop hashes of stashes that are gone (popped, dropped, re-messaged) while adding this one.
            const live = new Set(graph?.stashes.map((x) => x.hash));
            setView({ ...view, hiddenStashes: [...view.hiddenStashes.filter((h) => live.has(h)), st.hash] });
            if (selected === st.hash) setSelected(null);
          }}
        />
        <ActionDialog spec={ask} onClose={() => setAsk(null)} />
        <RebaseDialog
          repoId={repoId}
          onto={rebaseOnto}
          branch={graph?.local.find((b) => b.current)?.name ?? "HEAD"}
          onClose={() => setRebaseOnto(null)}
          onDone={() => {
            setRebaseOnto(null);
            details.current.clear();
            void load(limit);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
