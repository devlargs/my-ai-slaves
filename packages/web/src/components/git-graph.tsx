import type { GraphCommit, RepoGraph } from "@my-ai-slaves/shared";
import { CheckIcon, CloudIcon, CopyIcon, GitBranchIcon, Loader2Icon, RefreshCwIcon, TagIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn, formatTime } from "@/lib/utils";

const PAGE = 300;
const ROW = 28;
const LANE = 14;
const PAD = 10;
const DOT = 4.5;
const OVERSCAN = 12;
/** Branch lines cycle through these hues (same lightness/chroma as the label dots). */
const HUES = [36, 250, 152, 300, 72, 200, 0, 110, 330, 180];
const laneColor = (n: number) => `oklch(62% 0.15 ${HUES[n % HUES.length]})`;

interface Edge {
  from: number;
  to: number;
  /** "top": from the row's top edge to the dot; "bottom": from the dot to the row's bottom edge. */
  half: "top" | "bottom";
  /** Pass-through lines run the full row height without touching the dot. */
  through?: boolean;
  color: string;
}
interface Row {
  commit: GraphCommit;
  lane: number;
  color: string;
  edges: Edge[];
}

/**
 * Lanes like GitKraken / `git log --graph`: each lane waits for a commit hash. A commit takes the
 * lane waiting for it (lanes of other children converge into it), hands that lane to its first
 * parent and opens (or joins) lanes for the other parents.
 */
function layout(commits: GraphCommit[]): { rows: Row[]; width: number } {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: Row[] = [];
  const freeLane = (avoid = -1) => {
    const i = lanes.findIndex((h, n) => h === null && n !== avoid);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const before = [...lanes];
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = freeLane();
      colors[lane] = nextColor++;
    }
    const edges: Edge[] = [];
    before.forEach((h, i) => {
      if (h === null) return;
      if (h === commit.hash) {
        edges.push({ from: i, to: lane, half: "top", color: laneColor(colors[i] ?? 0) });
        if (i !== lane) lanes[i] = null;
      }
    });
    const color = laneColor(colors[lane] ?? 0);
    // Parents outside the loaded page still get a line down, so the graph doesn't look cut off.
    const parents = commit.parents;
    lanes[lane] = parents[0] ?? null;
    if (parents[0]) edges.push({ from: lane, to: lane, half: "bottom", color });
    for (const parent of parents.slice(1)) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = freeLane(lane);
        lanes[target] = parent;
        colors[target] = nextColor++;
      }
      edges.push({ from: lane, to: target, half: "bottom", color: laneColor(colors[target] ?? 0) });
    }
    // Lanes that just pass by this row.
    before.forEach((h, i) => {
      if (h !== null && h !== commit.hash && lanes[i] === h) {
        edges.push({ from: i, to: i, half: "top", through: true, color: laneColor(colors[i] ?? 0) });
      }
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    maxLanes = Math.max(maxLanes, lanes.length, lane + 1);
    rows.push({ commit, lane, color, edges });
  }
  return { rows, width: PAD * 2 + (maxLanes - 1) * LANE + DOT * 2 };
}

const x = (lane: number) => PAD + lane * LANE;

function edgePath(e: Edge): string {
  const mid = ROW / 2;
  if (e.through) return `M${x(e.from)} 0V${ROW}`;
  const [y1, y2] = e.half === "top" ? [0, mid] : [mid, ROW];
  const [x1, x2] = [x(e.from), x(e.to)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const c = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${c} ${x2} ${c} ${x2} ${y2}`;
}

function RefBadge({ label, head }: { label: string; head: string | null }) {
  const isHead = label.startsWith("HEAD -> ");
  const name = isHead ? label.slice("HEAD -> ".length) : label;
  if (name.startsWith("tag: ")) {
    return (
      <Badge variant="outline" className="max-w-40 shrink-0 gap-1 font-mono" title={name.slice(5)}>
        <TagIcon className="size-3 shrink-0" />
        <span className="truncate">{name.slice(5)}</span>
      </Badge>
    );
  }
  if (name === "HEAD") {
    return (
      <Badge variant="signal" className="shrink-0 font-mono" title="Detached HEAD">
        HEAD
      </Badge>
    );
  }
  const remote = name.includes("/") && !isHead && name !== head;
  return (
    <Badge
      variant={isHead ? "signal" : "default"}
      className="max-w-48 shrink-0 gap-1 font-mono"
      title={isHead ? `${name} (checked out)` : name}
    >
      {isHead ? (
        <CheckIcon className="size-3 shrink-0" />
      ) : remote ? (
        <CloudIcon className="size-3 shrink-0 opacity-70" />
      ) : (
        <GitBranchIcon className="size-3 shrink-0 opacity-70" />
      )}
      <span className="truncate">{name}</span>
    </Badge>
  );
}

function CommitDetails({
  commit,
  onJump,
}: {
  commit: GraphCommit;
  onJump: (hash: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [commit.hash]);
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto text-sm">
      <p className="font-medium leading-snug whitespace-pre-wrap text-ink">{commit.subject}</p>
      <div className="flex flex-col gap-0.5">
        <span className="text-ink-2">{commit.author}</span>
        <span className="text-[11px] text-muted-foreground">{commit.email}</span>
        <span className="text-[11px] text-muted-foreground">{new Date(commit.date).toLocaleString()}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="label-mono text-[11px] text-muted-foreground">Commit</span>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 text-left font-mono text-xs text-ink-2 hover:text-ink"
          title="Copy the full hash"
          onClick={() => {
            void navigator.clipboard?.writeText(commit.hash).then(() => setCopied(true));
          }}
        >
          <span className="break-all">{commit.hash}</span>
          {copied ? <CheckIcon className="size-3 shrink-0 text-success-ink" /> : <CopyIcon className="size-3 shrink-0" />}
        </button>
      </div>
      {commit.parents.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="label-mono text-[11px] text-muted-foreground">
            {commit.parents.length > 1 ? "Parents (merge)" : "Parent"}
          </span>
          {commit.parents.map((p) => (
            <button
              key={p}
              type="button"
              className="w-fit cursor-pointer font-mono text-xs text-signal-ink hover:underline"
              onClick={() => onJump(p)}
            >
              {p.slice(0, 10)}
            </button>
          ))}
        </div>
      )}
      {commit.refs.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="label-mono text-[11px] text-muted-foreground">Refs</span>
          <div className="flex flex-wrap gap-1">
            {commit.refs.map((r) => (
              <span key={r} className="font-mono text-xs text-ink-2">
                {r}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Read-only GitKraken-style graph of every branch, tag and remote branch in a repo. */
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
  const [limit, setLimit] = useState(PAGE);
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const load = async (n: number) => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await api.getRepoGraph(repoId, n));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load(limit);
    // Reload only when opened or when more commits are asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, limit, repoId]);

  useEffect(() => {
    if (!open) {
      setGraph(null);
      setSelected(null);
      setLimit(PAGE);
      setScrollTop(0);
    }
  }, [open]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [graph !== null]);

  const { rows, width } = useMemo(() => layout(graph?.commits ?? []), [graph]);
  const graphWidth = Math.min(width, 320);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.hash, i])), [rows]);
  const current = selected ? rows[index.get(selected) ?? -1]?.commit : undefined;

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);

  const jump = (hash: string) => {
    const i = index.get(hash);
    if (i === undefined) return;
    setSelected(hash);
    const el = scroller.current;
    if (el && (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight)) {
      el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100vh-2rem)] max-h-none w-[calc(100vw-2rem)] max-w-none gap-3 p-4">
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle>{repoName}</DialogTitle>
          {graph?.head && (
            <Badge variant="signal" className="gap-1 font-mono">
              <GitBranchIcon className="size-3" />
              {graph.head.length === 40 ? graph.head.slice(0, 10) : graph.head}
            </Badge>
          )}
          <DialogDescription className="text-xs">
            {graph ? `${graph.commits.length}${graph.more ? "+" : ""} commits · all branches · read-only` : "Commit graph · read-only"}
          </DialogDescription>
          <Button size="sm" variant="ghost" className="ml-auto" disabled={loading} onClick={() => void load(limit)}>
            {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Refresh
          </Button>
        </div>
        {error && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger-ink">{error}</p>}
        {!graph && loading && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        )}
        {graph && graph.commits.length === 0 && (
          <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No commits yet.</p>
        )}
        {graph && graph.commits.length > 0 && (
          <div className="flex min-h-0 flex-1 gap-3">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-rule bg-surface">
              <div
                className="flex shrink-0 items-center border-b border-rule bg-paper-2 text-[11px] text-muted-foreground label-mono"
                style={{ height: 26 }}
              >
                <span className="shrink-0 px-2.5" style={{ width: graphWidth }}>
                  Graph
                </span>
                <span className="min-w-0 flex-1 px-2">Commit message</span>
                <span className="hidden w-40 shrink-0 px-2 md:block">Author</span>
                <span className="w-28 shrink-0 px-2">Date</span>
                <span className="hidden w-20 shrink-0 px-2 lg:block">Commit</span>
              </div>
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
                    return (
                      <button
                        key={c.hash}
                        type="button"
                        onClick={() => setSelected(isSelected ? null : c.hash)}
                        className={cn(
                          "absolute inset-x-0 flex cursor-pointer items-center text-left text-xs hover:bg-paper-2",
                          isSelected && "bg-signal-soft hover:bg-signal-soft",
                        )}
                        style={{ top: i * ROW, height: ROW }}
                      >
                        <svg
                          width={graphWidth}
                          height={ROW}
                          className="shrink-0 overflow-hidden"
                          viewBox={`0 0 ${graphWidth} ${ROW}`}
                          aria-hidden
                        >
                          {row.edges.map((e, k) => (
                            <path key={k} d={edgePath(e)} stroke={e.color} strokeWidth={2} fill="none" />
                          ))}
                          <circle
                            cx={x(row.lane)}
                            cy={ROW / 2}
                            r={c.parents.length > 1 ? DOT - 1.5 : DOT}
                            fill={c.parents.length > 1 ? "var(--color-surface)" : row.color}
                            stroke={row.color}
                            strokeWidth={2}
                          />
                        </svg>
                        <span className="flex min-w-0 flex-1 items-center gap-1 px-2">
                          {c.refs.map((r) => (
                            <RefBadge key={r} label={r} head={graph.head} />
                          ))}
                          <span className={cn("truncate", c.parents.length > 1 ? "text-muted-foreground" : "text-ink")}>
                            {c.subject}
                          </span>
                        </span>
                        <span className="hidden w-40 shrink-0 truncate px-2 text-muted-foreground md:block">{c.author}</span>
                        <span className="w-28 shrink-0 truncate px-2 text-muted-foreground" title={new Date(c.date).toLocaleString()}>
                          {formatTime(c.date)}
                        </span>
                        <span className="hidden w-20 shrink-0 px-2 font-mono text-[11px] text-muted-foreground lg:block">
                          {c.hash.slice(0, 7)}
                        </span>
                      </button>
                    );
                  })}
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
            {current && (
              <aside className="flex w-72 shrink-0 flex-col rounded-lg border border-rule bg-surface p-3">
                <CommitDetails commit={current} onJump={jump} />
              </aside>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
