import type { GraphCommit, RepoGraph, StashEntry } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import {
  buildTree,
  groupRefs,
  stashCommit,
  stashLabel,
  storedView,
  targetKeys,
  targetName,
  viewKey,
  visibleCommits,
  workingLabel,
} from "@/components/git-graph/view-state";
import { memoryStorage } from "./memory-storage";

const storage = memoryStorage();

const c = (hash: string, parents: string[] = [], refs: string[] = []): GraphCommit => ({
  hash,
  parents,
  author: "a",
  email: "a@example.com",
  avatar: "",
  date: "2026-01-01T00:00:00Z",
  subject: hash,
  refs,
});

function graph(commits: GraphCommit[], local: [string, string][], remote: [string, string, string][] = []): RepoGraph {
  return {
    commits,
    head: "main",
    more: false,
    local: local.map(([name, commit]) => ({ name, commit, current: name === "main", upstream: null, ahead: 0, behind: 0, gone: false })),
    remote: remote.map(([r, name, commit]) => ({ remote: r, name, ref: `${r}/${name}`, commit })),
    wip: null,
  } as unknown as RepoGraph;
}

describe("groupRefs", () => {
  it("shows a branch once when it is local and on remotes, the checked-out one first", () => {
    const remotes = new Map([["origin/main", { remote: "origin", name: "main", ref: "origin/main", commit: "a" }]]);
    const groups = groupRefs(["tag: v1.0", "origin/main", "origin/HEAD", "feature", "HEAD -> main"], remotes);
    expect(groups.map((g) => [g.name, g.kind])).toEqual([
      ["main", "branch"],
      ["feature", "branch"],
      ["v1.0", "tag"],
    ]);
    expect(groups[0]).toMatchObject({ local: true, head: true, remotes: ["origin"] });
  });

  it("marks a detached HEAD", () => {
    expect(groupRefs(["HEAD"], new Map())).toEqual([{ name: "HEAD", kind: "detached", local: true, remotes: [], head: true }]);
  });
});

describe("buildTree", () => {
  it("splits names into folders, folders first, then by name", () => {
    const tree = buildTree(["main", "fix/b", "fix/a", "zeta"], (s) => s);
    expect(tree.map((n) => n.name)).toEqual(["fix", "main", "zeta"]);
    expect(tree[0]!.item).toBeUndefined();
    expect(tree[0]!.children.map((n) => [n.path, n.item])).toEqual([
      ["fix/a", "fix/a"],
      ["fix/b", "fix/b"],
    ]);
  });

  it("keeps a branch named like a folder as its own leaf", () => {
    const tree = buildTree(["fix", "fix/a"], (s) => s);
    expect(tree.map((n) => [n.name, n.item ?? null])).toEqual([
      ["fix", null],
      ["fix", "fix"],
    ]);
  });
});

describe("stashes", () => {
  const st = { index: 0, hash: "s1", base: "a", message: "WIP on main: 59bf2b5 Merge x", date: "d", author: "n", email: "e", avatar: "v" } as StashEntry;
  it("labels them as GitKraken does", () => {
    expect(stashLabel(st)).toBe("59bf2b5 Merge x");
    expect(stashLabel({ ...st, message: "On main: my message" })).toBe("my message");
    expect(stashLabel({ ...st, message: "custom" })).toBe("custom");
  });
  it("turns one into a commit row on its base", () => {
    expect(stashCommit(st)).toMatchObject({ hash: "s1", parents: ["a"], subject: st.message, refs: [] });
    expect(stashCommit({ ...st, base: "" }).parents).toEqual([]);
  });
});

describe("menu targets", () => {
  it("names a label by its local branch, else its first remote", () => {
    expect(targetName({ commit: "a", local: "main", remotes: ["origin/main"] })).toBe("main");
    expect(targetName({ commit: "a", local: null, remotes: ["origin/x"] })).toBe("origin/x");
    expect(targetName({ commit: "a", local: null, remotes: [] })).toBeNull();
    expect(targetKeys({ commit: "a", local: "main", remotes: ["origin/main"] })).toEqual(["main", "origin/main"]);
  });
});

describe("storedView", () => {
  it("reads the saved view and drops anything malformed", () => {
    expect(storedView("r1")).toEqual({ hidden: [], solo: [], pinned: null, hiddenStashes: [] });
    storage.set(viewKey("r1"), JSON.stringify({ hidden: ["a", 3], solo: "x", pinned: "main", hiddenStashes: ["s"] }));
    expect(storedView("r1")).toEqual({ hidden: ["a"], solo: [], pinned: "main", hiddenStashes: ["s"] });
    storage.set(viewKey("r1"), "{not json");
    expect(storedView("r1")).toEqual({ hidden: [], solo: [], pinned: null, hiddenStashes: [] });
  });
});

describe("visibleCommits", () => {
  // main: m2 → m1 → base; feature: f1 → base; v1 tag on t1 → base.
  const commits = [c("m2", ["m1"], ["HEAD -> main"]), c("f1", ["base"]), c("t1", ["base"], ["tag: v1"]), c("m1", ["base"]), c("base")];
  const g = graph(commits, [
    ["main", "m2"],
    ["feature", "f1"],
  ], [["origin", "feature", "f1"]]);
  const hashes = (list: GraphCommit[]) => list.map((x) => x.hash);
  const view = { hidden: [], solo: [], pinned: null, hiddenStashes: [] };

  it("shows everything when nothing is hidden or soloed", () => {
    expect(visibleCommits(g, view)).toBe(commits);
  });

  it("hides a branch (with its remote copy) but keeps tags and HEAD", () => {
    expect(hashes(visibleCommits(g, { ...view, hidden: ["feature", "origin/feature"] }))).toEqual(["m2", "t1", "m1", "base"]);
  });

  it("solos a branch: only what it reaches", () => {
    expect(hashes(visibleCommits(g, { ...view, solo: ["feature"] }))).toEqual(["f1", "base"]);
  });
});

describe("workingLabel", () => {
  it("names the branch a menu action works on", () => {
    expect(workingLabel({ op: "checkout", ref: "feature" })).toBe("Checking out feature…");
    expect(workingLabel({ op: "merge", ref: "origin/main" })).toBe("Merging origin/main…");
    expect(workingLabel({ op: "stash-apply", pop: true })).toBe("Popping stash…");
  });

  it("covers the toolbar actions and falls back for the rest", () => {
    expect(workingLabel("pull")).toBe("Pulling…");
    expect(workingLabel({ op: "stash-rename" })).toBe("Working…");
  });
});
