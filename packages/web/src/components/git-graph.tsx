import type {
  CommitDetail,
  CommitFile,
  CompareResult,
  GitCommitRequest,
  GitHistory,
  GitRefAction,
  GraphCommit,
  LocalBranch,
  PullMode,
  RebaseAction,
  RebaseStep,
  RemoteBranch,
  RepoGraph,
  WipSummary,
  WorkingChanges,
} from "@my-ai-slaves/shared";
import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloudIcon,
  CopyIcon,
  EyeOffIcon,
  FileMinusIcon,
  FilePenIcon,
  FilePlusIcon,
  FileSymlinkIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  GitCommitHorizontalIcon,
  LaptopIcon,
  ListIcon,
  PinIcon,
  Loader2Icon,
  Redo2Icon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseDiff } from "react-diff-view";
import { FileDiff, filePath } from "@/components/diff-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn, formatTime, storageGet, storageSet } from "@/lib/utils";

const PAGE = 300;
const ROW = 28;
const LANE = 28;
const PAD = 14;
/** Radius of the author's avatar that marks each commit on its lane. */
const DOT = 12;
const OVERSCAN = 12;
/** Width of the branch / tag column. */
const REF_COL = 208;
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
  /** The dotted line from the WIP row down to the checked-out commit. */
  dashed?: boolean;
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
function layout(commits: GraphCommit[], pinned: string | null = null): { rows: Row[]; width: number } {
  // The lane the WIP row opened towards the checked-out commit, drawn dotted until it gets there.
  let dashedLane: number | null = null;
  let dashedHash: string | null = null;
  // "Pin to Left": lane 0 is kept for the pinned branch (its tip, then its first parents) until it arrives.
  const pin = pinned && commits.some((c) => c.hash === pinned) ? pinned : null;
  const lanes: (string | null)[] = pin ? [PIN] : [];
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
    if (commit.hash === pin) {
      lane = 0;
      colors[0] = nextColor++;
    } else if (lane < 0) {
      lane = freeLane();
      colors[lane] = nextColor++;
    }
    const edges: Edge[] = [];
    before.forEach((h, i) => {
      if (h === null || h === PIN) return;
      if (h === commit.hash) {
        const dashed = i === dashedLane && h === dashedHash;
        edges.push({ from: i, to: lane, half: "top", dashed, color: laneColor(colors[i] ?? 0) });
        if (i !== lane) lanes[i] = null;
      }
    });
    const color = laneColor(colors[lane] ?? 0);
    // Parents outside the loaded page still get a line down, so the graph doesn't look cut off.
    const parents = commit.parents;
    lanes[lane] = parents[0] ?? null;
    if (commit.hash === WIP) {
      dashedLane = lane;
      dashedHash = parents[0] ?? null;
    } else if (lane === dashedLane) dashedLane = null;
    if (parents[0]) edges.push({ from: lane, to: lane, half: "bottom", dashed: commit.hash === WIP, color });
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
      if (h !== null && h !== PIN && h !== commit.hash && lanes[i] === h) {
        const dashed = i === dashedLane && h === dashedHash;
        edges.push({ from: i, to: i, half: "top", through: true, dashed, color: laneColor(colors[i] ?? 0) });
      }
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    maxLanes = Math.max(maxLanes, lanes.length, lane + 1);
    rows.push({ commit, lane, color, edges });
  }
  return { rows, width: PAD * 2 + (maxLanes - 1) * LANE + DOT * 2 };
}

const x = (lane: number) => PAD + lane * LANE;
/** Lane 0's placeholder while a pinned branch's tip is still further down. */
const PIN = "\0pin";

/** The synthetic "// WIP" commit at the top of the graph: the checkout's uncommitted changes. */
const WIP = "WIP";
function wipCommit(head: string | null): GraphCommit {
  return { hash: WIP, parents: head ? [head] : [], author: "", email: "", avatar: "", date: "", subject: "// WIP", refs: [] };
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";
/** Gravatar by SHA-256 email hash; authors without one get a generated identicon. */
const gravatarUrl = (hash: string, size: number) => `https://gravatar.com/avatar/${hash}?s=${size}&d=identicon`;

/**
 * The commit's mark on its lane: the author's Gravatar in a ring of the lane's colour. Under it sits the
 * author's initial, which shows while the image loads or when offline. Merges get a dashed ring.
 */
function CommitAvatar({ commit, cx, color }: { commit: GraphCommit; cx: number; color: string }) {
  const cy = ROW / 2;
  const r = DOT - 1;
  const clip = `avatar-${commit.hash}`;
  const [failed, setFailed] = useState(false);
  return (
    <g>
      <clipPath id={clip}>
        <circle cx={cx} cy={cy} r={r} />
      </clipPath>
      <circle cx={cx} cy={cy} r={r} fill="var(--color-surface)" />
      <text
        x={cx}
        y={cy}
        dy="0.35em"
        textAnchor="middle"
        fontSize={11}
        fontWeight={600}
        fill={color}
        style={{ userSelect: "none" }}
      >
        {initial(commit.author)}
      </text>
      {!failed && (
        <image
          href={gravatarUrl(commit.avatar, 48)}
          x={cx - r}
          y={cy - r}
          width={r * 2}
          height={r * 2}
          clipPath={`url(#${clip})`}
          preserveAspectRatio="xMidYMid slice"
          onError={() => setFailed(true)}
        >
          <title>{commit.author}</title>
        </image>
      )}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={commit.parents.length > 1 ? "3 2" : undefined}
      />
    </g>
  );
}

function edgePath(e: Edge): string {
  const mid = ROW / 2;
  if (e.through) return `M${x(e.from)} 0V${ROW}`;
  const [y1, y2] = e.half === "top" ? [0, mid] : [mid, ROW];
  const [x1, x2] = [x(e.from), x(e.to)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const c = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${c} ${x2} ${c} ${x2} ${y2}`;
}


// ── Branch / tag labels ──────────────────────────────────────────────────────

/** One label on a commit: a branch shown once even when it's both local and on remotes (laptop + cloud icons). */
interface RefGroup {
  name: string;
  kind: "branch" | "tag" | "detached";
  local: boolean;
  remotes: string[];
  /** The checked-out branch. */
  head: boolean;
}

function groupRefs(refs: string[], remoteRefs: Map<string, RemoteBranch>): RefGroup[] {
  const groups = new Map<string, RefGroup>();
  const branch = (name: string) => {
    let g = groups.get(`b:${name}`);
    if (!g) {
      g = { name, kind: "branch", local: false, remotes: [], head: false };
      groups.set(`b:${name}`, g);
    }
    return g;
  };
  for (const label of refs) {
    if (label === "HEAD") groups.set("HEAD", { name: "HEAD", kind: "detached", local: true, remotes: [], head: true });
    else if (label.startsWith("HEAD -> ")) Object.assign(branch(label.slice(8)), { local: true, head: true });
    else if (label.startsWith("tag: ")) groups.set(`t:${label}`, { name: label.slice(5), kind: "tag", local: false, remotes: [], head: false });
    else if (remoteRefs.has(label)) {
      const r = remoteRefs.get(label)!;
      branch(r.name).remotes.push(r.remote);
    } else if (!label.endsWith("/HEAD")) branch(label).local = true;
  }
  const rank = (g: RefGroup) => (g.head ? 0 : g.kind === "branch" ? (g.local ? 1 : 2) : g.kind === "tag" ? 3 : 4);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

function RefPill({ group, color }: { group: RefGroup; color: string }) {
  const title =
    group.kind === "tag"
      ? `Tag ${group.name}`
      : group.kind === "detached"
        ? "Detached HEAD"
        : [group.head && "checked out", group.local && "local", ...group.remotes.map((r) => `on ${r}`)].filter(Boolean).join(" · ");
  if (group.kind === "tag") {
    // Tags: the name, then the tag icon, edged in the commit's lane colour.
    return (
      <Badge
        variant="default"
        className="min-w-0 max-w-full shrink gap-1 rounded-md border font-mono text-ink"
        style={{ borderColor: color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
        title={`Tag ${group.name}`}
      >
        <span className="truncate">{group.name}</span>
        <TagIcon className="size-3 shrink-0 opacity-80" />
      </Badge>
    );
  }
  return (
    <Badge
      variant={group.head ? "signal" : "default"}
      className="min-w-0 max-w-full shrink gap-1 rounded-md font-mono"
      title={`${group.name}${title ? ` (${title})` : ""}`}
    >
      {group.head && <CheckIcon className="size-3 shrink-0" />}
      <span className="truncate">{group.name}</span>
      {group.kind === "branch" && group.local && <LaptopIcon className="size-3 shrink-0 opacity-70" />}
      {group.remotes.length > 0 && <CloudIcon className="size-3 shrink-0 opacity-70" />}
    </Badge>
  );
}

/** The commit's branch and tag labels, joined to its avatar by a line in the lane's colour. */
function RefCell({
  groups,
  color,
  onMenu,
}: {
  groups: RefGroup[];
  color: string;
  /** Right-click on a branch label. */
  onMenu?: (e: React.MouseEvent, group: RefGroup) => void;
}) {
  const [first] = groups;
  if (!first) return null;
  // A tag gets its own pill next to the branch, rather than hiding behind "+n".
  const tag = first.kind === "tag" ? undefined : groups.find((g) => g.kind === "tag");
  const shown = tag ? [first, tag] : [first];
  const rest = groups.filter((g) => !shown.includes(g));
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {shown.map((g) => (
        <span
          key={`${g.kind}:${g.name}`}
          className="flex min-w-0 shrink"
          onContextMenu={g.kind === "branch" && onMenu ? (e) => onMenu(e, g) : undefined}
        >
          <RefPill group={g} color={color} />
        </span>
      ))}
      {rest.length > 0 && (
        <Badge variant="outline" className="shrink-0 rounded-md px-1.5" title={rest.map((g) => g.name).join("\n")}>
          +{rest.length}
        </Badge>
      )}
      <span className="h-px min-w-2 flex-1 opacity-70" style={{ background: color }} />
    </span>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

const PULL_KEY = "git-graph.pull-mode";
const PULL_LABELS: Record<PullMode, string> = {
  fetch: "Fetch All",
  "pull-ff": "Pull (fast-forward if possible)",
  "pull-ff-only": "Pull (fast-forward only)",
  "pull-rebase": "Pull (rebase)",
};
const storedPullMode = (): PullMode => {
  const v = storageGet(PULL_KEY);
  return v && v in PULL_LABELS ? (v as PullMode) : "pull-ff";
};

type GitAction = "undo" | "redo" | "pull" | "branch" | "ref";

function ToolButton({
  icon,
  label,
  title,
  busy,
  disabled,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-14 cursor-pointer flex-col items-center gap-0.5 rounded-md px-2 py-1 text-[11px] text-ink-2 hover:bg-paper-2 hover:text-ink",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2 [&_svg]:size-4",
        className,
      )}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

/** Undo, Redo, Pull (with its default mode) and Branch, like GitKraken's toolbar. */
function GitToolbar({
  history,
  acting,
  pullMode,
  onPullMode,
  onAction,
}: {
  history: GitHistory | null;
  acting: GitAction | null;
  pullMode: PullMode;
  onPullMode: (mode: PullMode) => void;
  onAction: (action: GitAction) => void;
}) {
  const [menu, setMenu] = useState(false);
  const off = acting !== null || history === null;
  return (
    <div className="flex items-center gap-0.5">
      <ToolButton
        icon={<Undo2Icon />}
        label="Undo"
        title={history?.undo ? `Undo ${history.undo}` : "Nothing to undo"}
        busy={acting === "undo"}
        disabled={off || !history?.undo}
        onClick={() => onAction("undo")}
      />
      <ToolButton
        icon={<Redo2Icon />}
        label="Redo"
        title={history?.redo ? `Redo ${history.redo}` : "Nothing to redo"}
        busy={acting === "redo"}
        disabled={off || !history?.redo}
        onClick={() => onAction("redo")}
      />
      <div className="flex items-stretch">
        <ToolButton
          icon={<ArrowDownToLineIcon />}
          label={pullMode === "fetch" ? "Fetch" : "Pull"}
          title={PULL_LABELS[pullMode]}
          busy={acting === "pull"}
          disabled={off}
          onClick={() => onAction("pull")}
          className="rounded-r-none pr-1"
        />
        <Popover open={menu} onOpenChange={setMenu}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Choose what Pull does"
              disabled={off}
              className="flex cursor-pointer items-start rounded-r-md px-0.5 pt-1.5 text-ink-2 hover:bg-paper-2 hover:text-ink disabled:cursor-default disabled:opacity-40"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1.5">
            <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
              Select a default pull/fetch operation to execute when clicking this button
            </p>
            <div role="radiogroup" aria-label="Pull operation" className="flex flex-col">
              {(Object.keys(PULL_LABELS) as PullMode[]).map((mode) => {
                const on = mode === pullMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      onPullMode(mode);
                      setMenu(false);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-2 hover:bg-paper-2 hover:text-ink",
                      on && "bg-signal-soft text-ink hover:bg-signal-soft",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-signal" : "border-rule-strong",
                      )}
                    >
                      {on && <span className="size-1.5 rounded-full bg-signal" />}
                    </span>
                    {PULL_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <ToolButton
        icon={<GitBranchPlusIcon />}
        label="Branch"
        title="Create a branch here and check it out"
        busy={acting === "branch"}
        disabled={off}
        onClick={() => onAction("branch")}
      />
    </div>
  );
}

/** Inline "enter branch name" field on the checked-out commit's row. */
function BranchNameInput({ onSubmit, onCancel, busy }: { onSubmit: (name: string) => void; onCancel: () => void; busy: boolean }) {
  const [name, setName] = useState("");
  return (
    <Input
      autoFocus
      value={name}
      disabled={busy}
      placeholder="enter branch name"
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && name.trim()) onSubmit(name.trim());
      }}
      onBlur={() => !name.trim() && !busy && onCancel()}
      className="h-6 rounded-md px-2 font-mono text-xs"
    />
  );
}

// ── Branch sidebar ───────────────────────────────────────────────────────────

interface TreeNode<T> {
  name: string;
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

/** Splits "fix/announce-banner" style names into folders, folders first, then by name. */
function buildTree<T>(items: T[], nameOf: (item: T) => string): TreeNode<T>[] {
  const root: TreeNode<T> = { name: "", path: "", children: [] };
  for (const item of items) {
    const parts = nameOf(item).split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const leaf = i === parts.length - 1;
      // Each item is its own leaf; folders are shared.
      let next = leaf ? undefined : node.children.find((c) => c.name === part && c.item === undefined);
      if (!next) {
        next = { name: part, path, children: [] };
        node.children.push(next);
      }
      if (leaf) next.item = item;
      node = next;
    });
  }
  const sort = (nodes: TreeNode<T>[]) => {
    nodes.sort((a, b) => Number(a.item !== undefined) - Number(b.item !== undefined) || a.name.localeCompare(b.name));
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

function SectionHeader({
  open,
  onToggle,
  icon,
  label,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-ink-2 label-mono hover:text-ink"
    >
      {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
      {icon}
      <span className="flex-1">{label}</span>
      <span className="num text-signal-ink">{count}</span>
    </button>
  );
}

function BranchRow({
  depth,
  name,
  commit,
  current,
  loaded,
  selected,
  extra,
  hidden,
  pinned,
  onPick,
  onMenu,
}: {
  depth: number;
  name: string;
  commit: string;
  current?: boolean;
  loaded: boolean;
  selected: boolean;
  extra?: React.ReactNode;
  /** Hidden from the graph (Hide, or another branch is soloed). */
  hidden?: boolean;
  pinned?: boolean;
  onPick: (hash: string) => void;
  onMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(commit)}
      onContextMenu={onMenu}
      title={loaded ? name : `${name}: older than the loaded commits (load older commits to see it)`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-ink-2 hover:bg-paper-2 hover:text-ink",
        current && "bg-success-soft text-success-ink hover:bg-success-soft hover:text-success-ink",
        selected && !current && "bg-signal-soft text-signal-ink hover:bg-signal-soft",
        !loaded && "opacity-60",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {current ? <CheckIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0 opacity-70" />}
      <span className={cn("min-w-0 flex-1 truncate font-mono", hidden && "opacity-50")}>{name}</span>
      {pinned && <PinIcon className="size-3 shrink-0 opacity-70" aria-label="Pinned to left" />}
      {hidden && <EyeOffIcon className="size-3 shrink-0 opacity-70" aria-label="Hidden from the graph" />}
      {extra}
    </button>
  );
}

function FolderRow({ depth, name, open, onToggle }: { depth: number; name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-ink-2 hover:bg-paper-2 hover:text-ink"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {open ? <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" /> : <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />}
      <FolderIcon className="size-3.5 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
    </button>
  );
}

function BranchTree<T extends { commit: string }>({
  nodes,
  depth,
  prefix,
  closed,
  toggle,
  render,
}: {
  nodes: TreeNode<T>[];
  depth: number;
  prefix: string;
  closed: Set<string>;
  toggle: (key: string) => void;
  render: (item: T, name: string, depth: number) => React.ReactNode;
}) {
  return nodes.map((node) => {
    if (node.item) return <div key={`i:${node.path}`}>{render(node.item, node.name, depth)}</div>;
    const key = `${prefix}${node.path}`;
    const open = !closed.has(key);
    return (
      <div key={`f:${node.path}`}>
        <FolderRow depth={depth} name={node.name} open={open} onToggle={() => toggle(key)} />
        {open && <BranchTree nodes={node.children} depth={depth + 1} prefix={prefix} closed={closed} toggle={toggle} render={render} />}
      </div>
    );
  });
}

function BranchSidebar({
  graph,
  loaded,
  selected,
  view,
  onPick,
  onMenu,
  onShowAll,
}: {
  graph: RepoGraph;
  loaded: Set<string>;
  selected: string | null;
  view: GraphView;
  onPick: (hash: string) => void;
  onMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  onShowAll: () => void;
}) {
  const isHidden = (key: string) => (view.solo.length > 0 ? !view.solo.includes(key) : view.hidden.includes(key));
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const q = filter.trim().toLowerCase();
  const local = useMemo(() => graph.local.filter((b) => !q || b.name.toLowerCase().includes(q)), [graph.local, q]);
  const remote = useMemo(() => graph.remote.filter((b) => !q || b.ref.toLowerCase().includes(q)), [graph.remote, q]);
  const localTree = useMemo(() => buildTree(local, (b) => b.name), [local]);
  const remotes = useMemo(() => {
    const by = new Map<string, RemoteBranch[]>();
    for (const b of remote) by.set(b.remote, [...(by.get(b.remote) ?? []), b]);
    return [...by].map(([name, list]) => ({ name, tree: buildTree(list, (b) => b.name) }));
  }, [remote]);
  const localOpen = !closed.has("section:local");
  const remoteOpen = !closed.has("section:remote");

  const renderLocal = (b: LocalBranch, name: string, depth: number) => (
    <BranchRow
      depth={depth}
      name={name}
      commit={b.commit}
      current={b.current}
      loaded={loaded.has(b.commit)}
      selected={selected === b.commit}
      hidden={isHidden(b.name)}
      pinned={view.pinned === b.name}
      onPick={onPick}
      onMenu={(e) => onMenu(e, { commit: b.commit, local: b.name, remotes: [] })}
      extra={
        (b.ahead > 0 || b.behind > 0 || b.gone) && (
          <span
            className="num shrink-0 text-[11px] font-medium"
            title={b.gone ? `${b.upstream} is gone from the remote` : `${b.ahead} ahead, ${b.behind} behind ${b.upstream}`}
          >
            {b.gone ? "gone" : [b.ahead > 0 && `${b.ahead}↑`, b.behind > 0 && `${b.behind}↓`].filter(Boolean).join(" ")}
          </span>
        )
      }
    />
  );
  const renderRemote = (b: RemoteBranch, name: string, depth: number) => (
    <BranchRow
      depth={depth}
      name={name}
      commit={b.commit}
      loaded={loaded.has(b.commit)}
      selected={selected === b.commit}
      hidden={isHidden(b.ref)}
      pinned={view.pinned === b.ref}
      onPick={onPick}
      onMenu={(e) => onMenu(e, { commit: b.commit, local: null, remotes: [b.ref] })}
    />
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-rule p-2">
        <span className="flex items-center text-xs text-ink-2">
          Viewing <span className="num ml-1 font-medium text-signal-ink">{local.length + remote.length}</span>
          {(view.hidden.length > 0 || view.solo.length > 0) && (
            <button type="button" onClick={onShowAll} className="ml-auto cursor-pointer text-signal-ink hover:underline">
              {view.solo.length > 0 ? "Unsolo all" : "Show all"}
            </button>
          )}
        </span>
        <div className="relative">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches"
            className="h-7 pr-7 text-xs"
          />
          <SearchIcon className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-1">
        <SectionHeader
          open={localOpen}
          onToggle={() => toggle("section:local")}
          icon={<LaptopIcon className="size-3.5" />}
          label="Local"
          count={local.length}
        />
        {localOpen &&
          (local.length === 0 ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">{q ? "No match." : "No local branches."}</p>
          ) : (
            <BranchTree nodes={localTree} depth={1} prefix="local:" closed={closed} toggle={toggle} render={renderLocal} />
          ))}
        <div className="my-1 border-t border-rule" />
        <SectionHeader
          open={remoteOpen}
          onToggle={() => toggle("section:remote")}
          icon={<CloudIcon className="size-3.5" />}
          label="Remote"
          count={remote.length}
        />
        {remoteOpen &&
          (remotes.length === 0 ? (
            <p className="px-3 py-1 text-xs text-muted-foreground">{q ? "No match." : "No remotes."}</p>
          ) : (
            remotes.map((r) => {
              const key = `remote:${r.name}`;
              const open = !closed.has(key);
              return (
                <div key={r.name}>
                  <FolderRow depth={1} name={r.name} open={open} onToggle={() => toggle(key)} />
                  {open && <BranchTree nodes={r.tree} depth={2} prefix={`${key}/`} closed={closed} toggle={toggle} render={renderRemote} />}
                </div>
              );
            })
          ))}
      </div>
    </aside>
  );
}

// ── Commit details ───────────────────────────────────────────────────────────

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
interface FileAction {
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

type FileView = "path" | "tree";

function ViewToggle({ view, onView }: { view: FileView; onView: (view: FileView) => void }) {
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
function FileList({
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

function CommitFiles({
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

/** Which list of the WIP panel a file was opened from. */
type WipSection = "unstaged" | "staged";

/** The summary line's soft limit; the counter goes negative past it, like GitKraken's. */
const SUMMARY_LIMIT = 72;

/**
 * The WIP row's details, like GitKraken's: the checkout's unstaged and staged files (stage / unstage
 * one file or all of them), and a commit box that commits what's staged. Nothing changes until you click.
 */
function WipPanel({
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

function CommitPanel({
  commit,
  detail,
  error,
  openFile,
  onOpenFile,
  onJump,
}: {
  commit: GraphCommit;
  detail: CommitDetail | null;
  error: string | null;
  openFile: string | null;
  onOpenFile: (path: string) => void;
  onJump: (hash: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [commit.hash]);
  return (
    <aside className="scroll-quiet flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-rule bg-surface p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="label-mono">Commit</span>
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
          <img
            src={gravatarUrl(commit.avatar, 64)}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ink" title={commit.email}>
            {commit.author}
          </span>
          <span className="text-[11px] text-muted-foreground">authored {new Date(commit.date).toLocaleString()}</span>
          {detail && detail.committer && detail.committer !== commit.author && (
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
function CommitFileView({
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

/** The WIP row's message: "// WIP" and how many files are modified, added and deleted. */
function WipMessage({ summary }: { summary: WipSummary }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5 px-2">
      <span className="truncate text-muted-foreground italic">// WIP</span>
      {summary.modified > 0 && (
        <span className="flex items-center gap-0.5 text-warning-ink" title={`${summary.modified} modified`}>
          <FilePenIcon className="size-3" />
          <span className="num">{summary.modified}</span>
        </span>
      )}
      {summary.added > 0 && (
        <span className="flex items-center gap-0.5 text-success-ink" title={`${summary.added} added`}>
          <FilePlusIcon className="size-3" />
          <span className="num">{summary.added}</span>
        </span>
      )}
      {summary.deleted > 0 && (
        <span className="flex items-center gap-0.5 text-danger-ink" title={`${summary.deleted} deleted`}>
          <FileMinusIcon className="size-3" />
          <span className="num">{summary.deleted}</span>
        </span>
      )}
    </span>
  );
}

// ── Right-click menu (branches and commits) ─────────────────────────────────

/** What was right-clicked: a branch label (local and/or on remotes) or a commit row. */
interface MenuTarget {
  commit: string;
  /** Local branch name, when the label is (or has) a local branch. */
  local: string | null;
  /** Remote-tracking refs on the label ("origin/main"). */
  remotes: string[];
}
const targetName = (t: MenuTarget) => t.local ?? t.remotes[0] ?? null;
/** The refs Hide / Solo / Pin act on: the local branch and its remote copies. */
const targetKeys = (t: MenuTarget) => [...(t.local ? [t.local] : []), ...t.remotes];

/** Which branches the graph shows (GitKraken's Hide / Solo / Pin to Left), remembered per repo. */
interface GraphView {
  hidden: string[];
  solo: string[];
  pinned: string | null;
}
const EMPTY_VIEW: GraphView = { hidden: [], solo: [], pinned: null };
const viewKey = (repoId: string) => `git-graph.view.${repoId}`;
function storedView(repoId: string): GraphView {
  try {
    const v = JSON.parse(storageGet(viewKey(repoId)) ?? "null") as Partial<GraphView> | null;
    if (!v) return EMPTY_VIEW;
    const list = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    return { hidden: list(v.hidden), solo: list(v.solo), pinned: typeof v.pinned === "string" ? v.pinned : null };
  } catch {
    return EMPTY_VIEW;
  }
}

/** The ref key ("main", "origin/main") → its commit. */
function refCommits(graph: RepoGraph): Map<string, string> {
  return new Map([...graph.local.map((b) => [b.name, b.commit] as const), ...graph.remote.map((b) => [b.ref, b.commit] as const)]);
}

/**
 * The commits to draw with branches hidden or soloed: those reachable (in the loaded page) from the
 * branches still shown, plus tags and the checked-out commit (unless soloing).
 */
function visibleCommits(graph: RepoGraph, view: GraphView): GraphCommit[] {
  if (view.hidden.length === 0 && view.solo.length === 0) return graph.commits;
  const tips = new Set<string>();
  const byRef = refCommits(graph);
  if (view.solo.length > 0) {
    for (const key of view.solo) {
      const c = byRef.get(key);
      if (c) tips.add(c);
    }
  } else {
    const hidden = new Set(view.hidden);
    for (const [key, c] of byRef) if (!hidden.has(key)) tips.add(c);
    for (const c of graph.commits) {
      if (c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> ") || r.startsWith("tag: "))) tips.add(c.hash);
    }
  }
  const byHash = new Map(graph.commits.map((c) => [c.hash, c]));
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    const c = byHash.get(h);
    if (!c) continue;
    seen.add(h);
    stack.push(...c.parents);
  }
  return graph.commits.filter((c) => seen.has(c.hash));
}

/** A dialog's text field. */
interface Field {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  optional?: boolean;
  /** Suggestions (a datalist), e.g. the remote branches for Set Upstream. */
  options?: string[];
}
/** A confirmation or a short form before a menu action runs. */
interface ActionSpec {
  title: string;
  description?: React.ReactNode;
  fields?: Field[];
  confirmLabel: string;
  destructive?: boolean;
  run: (values: Record<string, string>) => Promise<void>;
}

function ActionDialog({ spec, onClose }: { spec: ActionSpec | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValues(Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.initial ?? ""])));
    setError(null);
    setBusy(false);
  }, [spec]);
  const ready = (spec?.fields ?? []).every((f) => f.optional || values[f.key]?.trim());
  const submit = async () => {
    if (!spec || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await spec.run(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open={spec !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogTitle>{spec?.title}</DialogTitle>
        {spec?.description && (
          <DialogDescription asChild>
            <div>{spec.description}</div>
          </DialogDescription>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {spec?.fields?.map((f, i) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs text-ink-2">
              {f.label}
              {f.multiline ? (
                <textarea
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  rows={4}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="scroll-quiet resize-y rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-signal"
                />
              ) : (
                <Input
                  autoFocus={i === 0}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  list={f.options ? `field-${f.key}` : undefined}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="font-mono"
                />
              )}
              {f.options && (
                <datalist id={`field-${f.key}`}>
                  {f.options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
            </label>
          ))}
          {error && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger-ink">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={spec?.destructive ? "destructive" : "signal"} disabled={!ready || busy}>
              {busy && <Loader2Icon className="animate-spin" />}
              {spec?.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const REBASE_ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: "pick", label: "Pick", hint: "keep the commit" },
  { value: "reword", label: "Reword", hint: "keep it, with a new message" },
  { value: "squash", label: "Squash", hint: "fold into the commit below, keeping both messages" },
  { value: "fixup", label: "Fixup", hint: "fold into the commit below, dropping this message" },
  { value: "drop", label: "Drop", hint: "remove the commit" },
];

/**
 * GitKraken's interactive rebase: the commits to replay, newest on top; pick / reword / squash /
 * fixup / drop each one and move them up or down. Nothing runs until "Start Rebase".
 */
function RebaseDialog({
  repoId,
  onto,
  branch,
  onClose,
  onDone,
}: {
  repoId: string;
  onto: string | null;
  branch: string;
  onClose: () => void;
  onDone: () => void;
}) {
  /** Oldest first, the order git replays them in. */
  const [steps, setSteps] = useState<(RebaseStep & { subject: string; original: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSteps(null);
    setError(null);
    setBusy(false);
    if (!onto) return;
    let live = true;
    api.getRebasePlan(repoId, onto).then(
      (plan) => live && setSteps(plan.commits.map((c) => ({ hash: c.hash, action: "pick", subject: c.subject, original: c.subject }))),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [repoId, onto]);

  const update = (i: number, change: Partial<RebaseStep>) =>
    setSteps((list) => list && list.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const move = (i: number, by: number) =>
    setSteps((list) => {
      if (!list || i + by < 0 || i + by >= list.length) return list;
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      return next;
    });
  const firstKept = steps?.find((s) => s.action !== "drop");
  const problem = !steps
    ? null
    : steps.length === 0
      ? "Nothing to rebase: the branch has no commits that aren't already there."
      : firstKept && (firstKept.action === "squash" || firstKept.action === "fixup")
        ? "The bottom commit can't be squashed: there's nothing below it to squash into."
        : steps.some((s) => s.action === "reword" && !s.subject.trim())
          ? "A reworded commit needs a message."
          : null;

  const start = async () => {
    if (!steps || !onto || problem) return;
    setBusy(true);
    setError(null);
    try {
      await api.gitRefAction(repoId, {
        op: "interactive-rebase",
        ref: onto,
        steps: steps.map((s) => (s.action === "reword" ? { hash: s.hash, action: s.action, message: s.subject } : { hash: s.hash, action: s.action })),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={onto !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>
          Interactive rebase <span className="font-mono text-signal-ink">{branch}</span> onto{" "}
          <span className="font-mono text-signal-ink">{onto}</span>
        </DialogTitle>
        <DialogDescription>Newest on top. Squash and fixup fold a commit into the one below it.</DialogDescription>
        {!steps && !error && (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
          </div>
        )}
        {steps && steps.length > 0 && (
          <div className="scroll-quiet flex max-h-[55vh] flex-col overflow-y-auto rounded-md border border-rule">
            {[...steps].reverse().map((s, n) => {
              const i = steps.length - 1 - n;
              return (
                <div key={s.hash} className={cn("flex items-center gap-2 border-b border-rule px-2 py-1.5 last:border-b-0", s.action === "drop" && "opacity-50")}>
                  <div className="flex flex-col">
                    <button
                      type="button"
                      title="Move up (later)"
                      disabled={busy || i === steps.length - 1}
                      onClick={() => move(i, 1)}
                      className="cursor-pointer rounded px-0.5 text-muted-foreground hover:text-ink disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Move down (earlier)"
                      disabled={busy || i === 0}
                      onClick={() => move(i, -1)}
                      className="cursor-pointer rounded px-0.5 text-muted-foreground hover:text-ink disabled:cursor-default disabled:opacity-30"
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </button>
                  </div>
                  <select
                    value={s.action}
                    disabled={busy}
                    title={REBASE_ACTIONS.find((a) => a.value === s.action)?.hint}
                    onChange={(e) => update(i, { action: e.target.value as RebaseAction })}
                    className="h-7 w-24 shrink-0 cursor-pointer rounded-md border border-rule bg-paper px-1.5 text-xs text-ink outline-none focus:border-signal"
                  >
                    {REBASE_ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{s.hash.slice(0, 7)}</span>
                  {s.action === "reword" ? (
                    <Input
                      value={s.subject}
                      disabled={busy}
                      onChange={(e) => setSteps((list) => list && list.map((x, k) => (k === i ? { ...x, subject: e.target.value } : x)))}
                      className="h-7 flex-1 text-xs"
                    />
                  ) : (
                    <span className={cn("min-w-0 flex-1 truncate text-xs text-ink", s.action === "drop" && "line-through")}>{s.original}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {(error ?? problem) && <p className="rounded-md bg-danger-soft px-2.5 py-1.5 text-xs whitespace-pre-wrap text-danger-ink">{error ?? problem}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="signal" disabled={!steps || !!problem || busy} onClick={() => void start()}>
            {busy && <Loader2Icon className="animate-spin" />} Start Rebase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Compare commit against working directory": the files that differ, like a commit's panel. */
function ComparePanel({
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

/** The right-click menu, GitKraken's items in GitKraken's order. */
function RefMenu({
  menu,
  graph,
  view,
  onClose,
  onRun,
  onAsk,
  onRebase,
  onBranchHere,
  onView,
  onCompare,
}: {
  menu: { x: number; y: number; target: MenuTarget } | null;
  graph: RepoGraph;
  view: GraphView;
  onClose: () => void;
  /** Runs it; from a dialog (`fromDialog`), errors are thrown back to show there. */
  onRun: (action: GitRefAction, fromDialog?: boolean) => Promise<void>;
  onAsk: (spec: ActionSpec) => void;
  onRebase: (onto: string) => void;
  onBranchHere: (commit: string) => void;
  onView: (view: GraphView) => void;
  onCompare: (commit: string) => void;
}) {
  if (!menu) return null;
  const t = menu.target;
  const name = targetName(t);
  const currentBranch = graph.local.find((b) => b.current) ?? null;
  const here = currentBranch?.name ?? "HEAD";
  const headCommit = currentBranch?.commit ?? graph.commits.find((c) => c.refs.includes("HEAD"))?.hash ?? null;
  const isCurrent = !!t.local && t.local === currentBranch?.name;
  const local = t.local ? graph.local.find((b) => b.name === t.local) : undefined;
  const short = t.commit.slice(0, 7);
  const keys = targetKeys(t);
  const hidden = keys.length > 0 && keys.every((k) => view.hidden.includes(k));
  const soloed = keys.length > 0 && keys.every((k) => view.solo.includes(k));
  const pinned = view.pinned !== null && keys.includes(view.pinned);
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const remoteRefs = graph.remote.map((r) => r.ref);
  const defaultRemote = graph.remote.some((r) => r.remote === "origin") ? "origin" : (graph.remote[0]?.remote ?? "origin");

  const resetSpec = (mode: "soft" | "mixed" | "hard"): ActionSpec => ({
    title: `Reset ${here} to ${short} (${mode})`,
    description:
      mode === "hard" ? (
        <>Moves {here} to this commit and <b>throws away</b> every uncommitted change. Undo brings the commits back, not the changes.</>
      ) : mode === "mixed" ? (
        <>Moves {here} to this commit. The changes of the commits after it stay in your files, unstaged.</>
      ) : (
        <>Moves {here} to this commit. The changes of the commits after it stay staged.</>
      ),
    confirmLabel: `Reset ${mode}`,
    destructive: mode === "hard",
    run: async () => onRun({ op: "reset", commit: t.commit, mode }, true),
  });

  const sections: React.ReactNode[][] = [];
  if (t.local) {
    sections.push([
      <DropdownMenuItem key="pull" disabled={!isCurrent && !local?.upstream} onSelect={() => void onRun({ op: "pull", branch: t.local! })}>
        Pull (fast-forward if possible)
      </DropdownMenuItem>,
      <DropdownMenuItem key="push" onSelect={() => void onRun({ op: "push", branch: t.local! })}>
        Push
      </DropdownMenuItem>,
      <DropdownMenuItem
        key="upstream"
        onSelect={() =>
          onAsk({
            title: `Set upstream for ${t.local}`,
            description: "Pick a remote branch to track. A branch that isn't on the remote yet is pushed there.",
            fields: [
              { key: "upstream", label: "Upstream", initial: local?.upstream ?? `${defaultRemote}/${t.local}`, options: remoteRefs },
            ],
            confirmLabel: "Set Upstream",
            run: async (v) => onRun({ op: "set-upstream", branch: t.local!, upstream: v.upstream! }, true),
          })
        }
      >
        Set Upstream
      </DropdownMenuItem>,
    ]);
  }
  if (name && !isCurrent) {
    sections.push([
      <DropdownMenuItem key="merge" onSelect={() => void onRun({ op: "merge", ref: name })}>
        Merge {name} into {here}
      </DropdownMenuItem>,
      <DropdownMenuItem key="rebase" onSelect={() => void onRun({ op: "rebase", ref: name })}>
        Rebase {here} onto {name}
      </DropdownMenuItem>,
      <DropdownMenuItem key="irebase" onSelect={() => onRebase(name)}>
        Interactive Rebase {here} onto {name}
      </DropdownMenuItem>,
    ]);
    sections.push([
      <DropdownMenuItem key="checkout" onSelect={() => void onRun({ op: "checkout", ref: name })}>
        Checkout {name}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    <DropdownMenuItem key="branch" onSelect={() => onBranchHere(t.commit)}>
      Create branch here
    </DropdownMenuItem>,
    <DropdownMenuItem key="pick" disabled={t.commit === headCommit} onSelect={() => void onRun({ op: "cherry-pick", commit: t.commit })}>
      Cherry pick commit
    </DropdownMenuItem>,
    <DropdownMenuSub key="reset">
      <DropdownMenuSubTrigger disabled={t.commit === headCommit}>Reset {here} to this commit</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={() => onAsk(resetSpec("soft"))}>Soft - keep all changes</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAsk(resetSpec("mixed"))}>Mixed - keep working copy but reset index</DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => onAsk(resetSpec("hard"))}>
          Hard - discard all changes
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>,
    <DropdownMenuItem key="revert" onSelect={() => void onRun({ op: "revert", commit: t.commit })}>
      Revert commit
    </DropdownMenuItem>,
  ]);
  if (name) {
    const remoteOnly = !t.local;
    sections.push([
      ...(t.local
        ? [
            <DropdownMenuItem
              key="rename"
              onSelect={() =>
                onAsk({
                  title: `Rename ${t.local}`,
                  fields: [{ key: "name", label: "New name", initial: t.local! }],
                  confirmLabel: "Rename",
                  run: async (v) => onRun({ op: "rename-branch", branch: t.local!, name: v.name! }, true),
                })
              }
            >
              Rename {t.local}
            </DropdownMenuItem>,
          ]
        : []),
      <DropdownMenuItem
        key="delete"
        destructive
        disabled={isCurrent}
        onSelect={() =>
          onAsk({
            title: `Delete ${name}`,
            description: remoteOnly ? (
              <>Deletes the branch on the remote (<span className="font-mono">git push --delete</span>). Everyone loses it.</>
            ) : (
              <>Deletes the local branch, even when it has commits that aren't merged anywhere. Its remote copy stays.</>
            ),
            confirmLabel: "Delete",
            destructive: true,
            run: async () => onRun({ op: "delete-branch", ref: name, remote: remoteOnly }, true),
          })
        }
      >
        Delete {name}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    ...(name
      ? [
          <DropdownMenuItem key="copyname" onSelect={() => copy(name)}>
            Copy branch name
          </DropdownMenuItem>,
        ]
      : []),
    <DropdownMenuItem key="copysha" onSelect={() => copy(t.commit)}>
      Copy commit sha
    </DropdownMenuItem>,
  ]);
  if (keys.length > 0) {
    const without = (list: string[]) => list.filter((k) => !keys.includes(k));
    sections.push([
      <DropdownMenuItem
        key="hide"
        onSelect={() => onView({ ...view, hidden: hidden ? without(view.hidden) : [...without(view.hidden), ...keys], solo: without(view.solo) })}
      >
        {hidden ? "Show" : "Hide"}
      </DropdownMenuItem>,
      <DropdownMenuItem key="pin" onSelect={() => onView({ ...view, pinned: pinned ? null : keys[0]! })}>
        {pinned ? "Unpin from Left" : "Pin to Left"}
      </DropdownMenuItem>,
      <DropdownMenuItem
        key="solo"
        onSelect={() => onView({ ...view, solo: soloed ? without(view.solo) : [...without(view.solo), ...keys], hidden: without(view.hidden) })}
      >
        {soloed ? "Unsolo" : "Solo"}
      </DropdownMenuItem>,
    ]);
  }
  sections.push([
    <DropdownMenuItem key="compare" onSelect={() => onCompare(t.commit)}>
      Compare commit against working directory
    </DropdownMenuItem>,
  ]);
  sections.push([
    <DropdownMenuItem
      key="tag"
      onSelect={() =>
        onAsk({
          title: `Create tag at ${short}`,
          fields: [{ key: "name", label: "Tag name", placeholder: "v1.0.0" }],
          confirmLabel: "Create Tag",
          run: async (v) => onRun({ op: "tag", name: v.name!, commit: t.commit }, true),
        })
      }
    >
      Create tag here
    </DropdownMenuItem>,
    <DropdownMenuItem
      key="atag"
      onSelect={() =>
        onAsk({
          title: `Create annotated tag at ${short}`,
          fields: [
            { key: "name", label: "Tag name", placeholder: "v1.0.0" },
            { key: "message", label: "Message", multiline: true },
          ],
          confirmLabel: "Create Tag",
          run: async (v) => onRun({ op: "tag", name: v.name!, commit: t.commit, message: v.message }, true),
        })
      }
    >
      Create annotated tag here
    </DropdownMenuItem>,
  ]);

  return (
    // Not modal: a menu item can open a dialog straight away without the page staying blocked.
    <DropdownMenu key={`${menu.x},${menu.y}`} open modal={false} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="max-w-[min(640px,90vw)]">
        {sections.map((items, i) => (
          <div key={i}>
            {i > 0 && <DropdownMenuSeparator />}
            {items}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────────

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
      setNaming(null);
      setMenu(null);
      setCompare(null);
      setCompareFile(null);
      details.current.clear();
    }
  }, [open]);

  // The WIP row's files and diffs: read again whenever the graph is (they change all the time).
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
  const graphWidth = Math.min(Math.max(width, 56), 240);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.hash, i])), [rows]);
  const loaded = useMemo(() => new Set(index.keys()), [index]);
  const remoteRefs = useMemo(() => new Map((graph?.remote ?? []).map((r) => [r.ref, r])), [graph]);
  const current = selected ? rows[index.get(selected) ?? -1]?.commit : undefined;

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
              onShowAll={() => setView({ ...view, hidden: [], solo: [] })}
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
                <div
                  className="flex shrink-0 items-center border-b border-rule bg-paper-2 text-[11px] text-muted-foreground label-mono"
                  style={{ height: 26 }}
                >
                  <span className="shrink-0 px-2" style={{ width: REF_COL }}>
                    Branch / tag
                  </span>
                  <span className="shrink-0 px-2.5" style={{ width: graphWidth }}>
                    Graph
                  </span>
                  <span className="min-w-0 flex-1 px-2">Commit message</span>
                  <span className="hidden w-36 shrink-0 px-2 xl:block">Author</span>
                  <span className="w-24 shrink-0 px-2">Date</span>
                  <span className="hidden w-20 shrink-0 px-2 2xl:block">Commit</span>
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
                          <span className="flex shrink-0 items-center pl-2" style={{ width: REF_COL }}>
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
                              <CommitAvatar commit={c} cx={x(row.lane)} color={row.color} />
                            )}
                          </svg>
                          {isWip && graph.wip ? (
                            <WipMessage summary={graph.wip} />
                          ) : (
                            <span className={cn("min-w-0 flex-1 truncate px-2", c.parents.length > 1 ? "text-muted-foreground" : "text-ink")}>
                              {c.subject}
                            </span>
                          )}
                          <span className="hidden w-36 shrink-0 truncate px-2 text-muted-foreground xl:block">{c.author}</span>
                          <span className="w-24 shrink-0 truncate px-2 text-muted-foreground" title={isWip ? undefined : new Date(c.date).toLocaleString()}>
                            {isWip ? "" : formatTime(c.date)}
                          </span>
                          <span className="hidden w-20 shrink-0 px-2 font-mono text-[11px] text-muted-foreground 2xl:block">
                            {isWip ? "" : c.hash.slice(0, 7)}
                          </span>
                        </button>
                      );
                    })}
                    {naming && (
                      <div
                        className="absolute left-0 z-10 flex items-center bg-surface px-2"
                        style={{ top: namingRow * ROW, height: ROW, width: REF_COL }}
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
                detail={detail}
                error={detailError}
                openFile={openFile}
                onOpenFile={setOpenFile}
                onJump={jump}
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
