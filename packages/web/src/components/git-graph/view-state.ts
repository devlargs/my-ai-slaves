import type { GraphCommit, RemoteBranch, RepoGraph, StashEntry } from "@my-ai-slaves/shared";
import { storageGet } from "@/lib/utils";

/** One label on a commit: a branch shown once even when it's both local and on remotes (laptop + cloud icons). */
export interface RefGroup {
  name: string;
  kind: "branch" | "tag" | "detached";
  local: boolean;
  remotes: string[];
  /** The checked-out branch. */
  head: boolean;
}

export function groupRefs(refs: string[], remoteRefs: Map<string, RemoteBranch>): RefGroup[] {
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

export interface TreeNode<T> {
  name: string;
  path: string;
  children: TreeNode<T>[];
  item?: T;
}

/** Splits "fix/announce-banner" style names into folders, folders first, then by name. */
export function buildTree<T>(items: T[], nameOf: (item: T) => string): TreeNode<T>[] {
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

/** "WIP on main: 59bf2b5 Merge …" → "59bf2b5 Merge …", "On main: my message" → "my message" (as GitKraken lists them). */
export function stashLabel(st: StashEntry): string {
  return st.message.replace(/^(?:WIP on|On) [^:]*: /, "") || st.message;
}

/** A stash as a commit row, for the details pane. */
export function stashCommit(st: StashEntry): GraphCommit {
  return {
    hash: st.hash,
    parents: st.base ? [st.base] : [],
    author: st.author,
    email: st.email,
    avatar: st.avatar,
    date: st.date,
    subject: st.message,
    refs: [],
  };
}

/** What was right-clicked: a branch label (local and/or on remotes) or a commit row. */
export interface MenuTarget {
  commit: string;
  /** Local branch name, when the label is (or has) a local branch. */
  local: string | null;
  /** Remote-tracking refs on the label ("origin/main"). */
  remotes: string[];
}
export const targetName = (t: MenuTarget) => t.local ?? t.remotes[0] ?? null;
/** The refs Hide / Solo / Pin act on: the local branch and its remote copies. */
export const targetKeys = (t: MenuTarget) => [...(t.local ? [t.local] : []), ...t.remotes];

/** Which branches the graph shows (GitKraken's Hide / Solo / Pin to Left), remembered per repo. */
export interface GraphView {
  hidden: string[];
  solo: string[];
  pinned: string | null;
  /** Stash commit hashes hidden from the sidebar's Stashes group (the stash's Hide). */
  hiddenStashes: string[];
}
const EMPTY_VIEW: GraphView = { hidden: [], solo: [], pinned: null, hiddenStashes: [] };
export const viewKey = (repoId: string) => `git-graph.view.${repoId}`;
export function storedView(repoId: string): GraphView {
  try {
    const v = JSON.parse(storageGet(viewKey(repoId)) ?? "null") as Partial<GraphView> | null;
    if (!v) return EMPTY_VIEW;
    const list = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : []);
    return {
      hidden: list(v.hidden),
      solo: list(v.solo),
      pinned: typeof v.pinned === "string" ? v.pinned : null,
      hiddenStashes: list(v.hiddenStashes),
    };
  } catch {
    return EMPTY_VIEW;
  }
}

/** The ref key ("main", "origin/main") → its commit. */
export function refCommits(graph: RepoGraph): Map<string, string> {
  return new Map([...graph.local.map((b) => [b.name, b.commit] as const), ...graph.remote.map((b) => [b.ref, b.commit] as const)]);
}

/**
 * The commits to draw with branches hidden or soloed: those reachable (in the loaded page) from the
 * branches still shown, plus tags and the checked-out commit (unless soloing).
 */
export function visibleCommits(graph: RepoGraph, view: GraphView): GraphCommit[] {
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
