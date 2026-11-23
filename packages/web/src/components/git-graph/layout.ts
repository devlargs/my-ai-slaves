import type { GraphCommit } from "@my-ai-slaves/shared";

export const PAGE = 300;
export const ROW = 28;
const LANE = 28;
const PAD = 14;
/** Radius of the author's avatar that marks each commit on its lane. */
export const DOT = 12;
export const OVERSCAN = 12;
/** Width of the branch / tag column. */
export const REF_COL = 208;
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
export function layout(commits: GraphCommit[], pinned: string | null = null): { rows: Row[]; width: number } {
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

export const x = (lane: number) => PAD + lane * LANE;
/** Lane 0's placeholder while a pinned branch's tip is still further down. */
const PIN = "\0pin";

/** The synthetic "// WIP" commit at the top of the graph: the checkout's uncommitted changes. */
export const WIP = "WIP";
export function wipCommit(head: string | null): GraphCommit {
  return { hash: WIP, parents: head ? [head] : [], author: "", email: "", avatar: "", date: "", subject: "// WIP", refs: [] };
}

export function edgePath(e: Edge): string {
  const mid = ROW / 2;
  if (e.through) return `M${x(e.from)} 0V${ROW}`;
  const [y1, y2] = e.half === "top" ? [0, mid] : [mid, ROW];
  const [x1, x2] = [x(e.from), x(e.to)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const c = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${c} ${x2} ${c} ${x2} ${y2}`;
}
