import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  CommitDetail,
  CommitFile,
  CompareResult,
  GraphCommit,
  LocalBranch,
  RebasePlan,
  RemoteBranch,
  Repo,
  RepoGraph,
  StashEntry,
  Task,
  WipSummary,
  WorkingChanges,
} from "@my-ai-slaves/shared";
import { type GitIdentity, gitIdentityEnv } from "../providers/types";
import { runOn } from "../remote/machine";
import { git, gitOk, run } from "./git";

export type TaskCheckout = NonNullable<Task["checkout"]>;
export type LegacyTaskBranch = NonNullable<Task["branch"]>;

/** At most this many untracked files are shown in a task's diff. */
const UNTRACKED_LIMIT = 200;
/** Full or abbreviated commit hash: the only thing `commit()` accepts, so it can never be read as an option. */
const HASH = /^[0-9a-f]{4,64}$/i;

/**
 * Tasks run in the repository exactly as it's checked out. The app never creates, switches, resets,
 * commits or deletes branches: the repo's prompts tell the agent how to handle changes. This only
 * reads where the checkout is and what changed, so you can review it.
 */
export class RepoGit {
  private async git(repo: Repo, args: string[], okExitCodes?: number[]): Promise<string> {
    return (await runOn(repo.host, "git", args, repo.path, { okExitCodes })).stdout;
  }

  /** The checked-out branch name, or the commit when HEAD is detached. */
  async currentRef(repo: Repo): Promise<string> {
    try {
      return (await this.git(repo, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
    } catch {
      return (await this.git(repo, ["rev-parse", "HEAD"])).trim();
    }
  }

  /** Where the checkout is right now (null for a repo without commits). Read-only. */
  async where(repo: Repo): Promise<TaskCheckout | null> {
    try {
      const commit = (await this.git(repo, ["rev-parse", "HEAD"])).trim();
      return { ref: await this.currentRef(repo), commit };
    } catch {
      return null;
    }
  }

  /**
   * What changed in the checkout since the task started: committed and uncommitted changes, plus new
   * untracked files. Compared to the commit it started on; if the agent moved to a branch that doesn't
   * contain that commit, to where that branch forked from the repo's base branch.
   */
  async changesSince(repo: Repo, start: TaskCheckout): Promise<{ patch: string; ref: string; from: string }> {
    const ref = await this.currentRef(repo);
    let from = start.commit;
    const descends = await this.git(repo, ["merge-base", "--is-ancestor", start.commit, "HEAD"]).then(
      () => true,
      () => false,
    );
    if (!descends) {
      const fork = await this.git(repo, ["merge-base", "HEAD", repo.defaultBranch]).catch(() => "");
      if (fork.trim()) from = fork.trim();
    }
    const tracked = await this.git(repo, ["diff", "--no-color", "--no-ext-diff", from, "--"]);
    const untracked = (await this.git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean)
      .slice(0, UNTRACKED_LIMIT);
    const added: string[] = [];
    for (const file of untracked) {
      // Exit code 1 = "the files differ", the normal answer here.
      added.push(await this.git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], [1]));
    }
    return { patch: [tracked, ...added].filter((p) => p.trim()).join(""), ref, from };
  }

  /**
   * The commit graph of every branch, tag and remote branch (newest first), for the repo's graph view.
   * Read-only: `git log --all`.
   */
  async graph(repo: Repo, limit: number): Promise<Omit<RepoGraph, "history">> {
    const head = await this.currentRef(repo).catch(() => null);
    // Unit separator between fields, record separator between commits: neither appears in git output.
    const format = `${["%H", "%P", "%an", "%ae", "%aI", "%s", "%D"].join("%x1f")}%x1e`;
    const out = await this.git(repo, [
      "log",
      // Stashes (and their index / untracked commits) are listed in the sidebar, not drawn.
      "--exclude=refs/stash",
      "--all",
      "--date-order",
      "--no-color",
      `--max-count=${limit + 1}`,
      `--format=${format}`,
    ]).catch((error: unknown) => {
      // A repo without commits has nothing to draw.
      if (head === null) return "";
      throw error;
    });
    const commits: GraphCommit[] = [];
    for (const record of out.split("\x1e")) {
      const fields = record.replace(/^\s+/, "").split("\x1f");
      if (fields.length < 7 || !fields[0]) continue;
      const [hash, parents, author, email, date, subject, refs] = fields as [string, string, string, string, string, string, string];
      commits.push({
        hash,
        parents: parents.split(" ").filter(Boolean),
        author,
        email,
        avatar: gravatarId(email),
        date,
        subject,
        refs: refs.split(", ").map((r) => r.trim()).filter(Boolean),
      });
    }
    const more = commits.length > limit;
    const [{ local, remote }, status, stashes] = await Promise.all([
      this.branches(repo).catch(() => ({ local: [], remote: [] })),
      this.status(repo).catch(() => ({ staged: [], unstaged: [] })),
      this.stashes(repo).catch(() => []),
    ]);
    return { commits: commits.slice(0, limit), head, more, local, remote, wip: summarize(status.staged, status.unstaged), stashes };
  }

  /** `git stash list`, newest first. Read-only. */
  async stashes(repo: Repo): Promise<StashEntry[]> {
    return parseStashList(await this.git(repo, ["stash", "list", "--no-color", `--format=${STASH_FORMAT}`]));
  }

  /** Staged and unstaged (incl. untracked) files, from `git status`. Read-only. */
  async status(repo: Repo): Promise<{ staged: CommitFile[]; unstaged: CommitFile[] }> {
    const out = await this.git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return parseStatus(out);
  }

  /** What isn't committed yet: staged and unstaged files with their diffs, for the graph's WIP row. Read-only. */
  async workingChanges(repo: Repo): Promise<WorkingChanges> {
    const diffArgs = ["--no-color", "--no-ext-diff", "-M"];
    const [head, { staged, unstaged }, stagedPatch, trackedPatch] = await Promise.all([
      this.currentRef(repo).catch(() => null),
      this.status(repo),
      this.git(repo, ["diff", "--cached", ...diffArgs, "--"]),
      this.git(repo, ["diff", ...diffArgs, "--"]),
    ]);
    const untracked = (await this.git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean)
      .slice(0, UNTRACKED_LIMIT);
    const added: string[] = [];
    for (const file of untracked) {
      // Exit code 1 = "the files differ", the normal answer here.
      added.push(await this.git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], [1]));
    }
    return {
      head,
      staged,
      unstaged,
      stagedPatch,
      unstagedPatch: [trackedPatch, ...added].filter((p) => p.trim()).join(""),
    };
  }

  /** Local and remote-tracking branches, with how far each local one is ahead of / behind its upstream. Read-only. */
  async branches(repo: Repo): Promise<{ local: LocalBranch[]; remote: RemoteBranch[] }> {
    const format = ["%(refname)", "%(objectname)", "%(HEAD)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(symref)"].join("%1f");
    const [refs, remotesOut] = await Promise.all([
      this.git(repo, ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"]),
      this.git(repo, ["remote"]).catch(() => ""),
    ]);
    // Longest first, so a remote named "a/b" wins over "a".
    const remotes = remotesOut.split(/\r?\n/).map((r) => r.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];
    for (const line of refs.split(/\r?\n/)) {
      const [refname, commit, head, upstream, track, symref] = line.split("\x1f");
      if (!refname || !commit) continue;
      if (refname.startsWith("refs/heads/")) {
        const ahead = /ahead (\d+)/.exec(track ?? "");
        const behind = /behind (\d+)/.exec(track ?? "");
        local.push({
          name: refname.slice("refs/heads/".length),
          commit,
          current: head === "*",
          upstream: upstream || null,
          ahead: ahead ? Number(ahead[1]) : 0,
          behind: behind ? Number(behind[1]) : 0,
          gone: track === "gone",
        });
      } else if (refname.startsWith("refs/remotes/")) {
        // `origin/HEAD` only points at another remote branch.
        if (symref) continue;
        const ref = refname.slice("refs/remotes/".length);
        const name = remotes.find((r) => ref.startsWith(`${r}/`)) ?? ref.split("/")[0]!;
        remote.push({ remote: name, name: ref.slice(name.length + 1), ref, commit });
      }
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    local.sort(byName);
    remote.sort((a, b) => a.remote.localeCompare(b.remote) || byName(a, b));
    return { local, remote };
  }

  /**
   * One commit: its full message, the files it touched and its diff against the first parent
   * (a merge shows what it brought into the branch). Read-only.
   */
  async commit(repo: Repo, hash: string): Promise<CommitDetail> {
    if (!HASH.test(hash)) throw new Error(`Not a commit hash: ${hash}`);
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%D", "%cn", "%cI", "%b"].join("%x1f");
    const info = await this.git(repo, ["show", "-s", "--no-color", `--format=${format}`, hash, "--"]);
    const [full, parents, author, email, date, subject, refs, committer, committerDate, body] = info.split("\x1f");
    if (!full) throw new Error(`Commit not found: ${hash}`);
    const parentList = (parents ?? "").split(" ").filter(Boolean);
    const first = parentList[0];
    // Against the first parent, or the empty tree for a root commit.
    const base = first ? [first, full] : ["--root", full];
    const diffArgs = ["--no-color", "--no-ext-diff", "-M"];
    const [names, patch] = await Promise.all([
      this.git(repo, first ? ["diff", ...diffArgs, "--name-status", "-z", ...base, "--"] : ["diff-tree", "-r", ...diffArgs, "--name-status", "-z", ...base, "--"]),
      this.git(repo, first ? ["diff", ...diffArgs, ...base, "--"] : ["diff-tree", "-r", "-p", ...diffArgs, ...base, "--"]),
    ]);
    return {
      hash: full,
      parents: parentList,
      author: author ?? "",
      email: email ?? "",
      avatar: gravatarId(email ?? ""),
      date: date ?? "",
      subject: subject ?? "",
      refs: (refs ?? "").split(", ").map((r) => r.trim()).filter(Boolean),
      committer: committer ?? "",
      committerDate: committerDate ?? "",
      body: (body ?? "").trim(),
      files: parseNameStatus(names, full),
      // diff-tree prints the commit hash first; the patch starts at the first "diff --git".
      patch: first ? patch : patch.slice(Math.max(0, patch.indexOf("diff --git"))),
    };
  }

  /** A commit compared to the working directory (`git diff <commit>`, tracked files), for "Compare commit against working directory". Read-only. */
  async compare(repo: Repo, hash: string): Promise<CompareResult> {
    if (!HASH.test(hash)) throw new Error(`Not a commit hash: ${hash}`);
    const diffArgs = ["--no-color", "--no-ext-diff", "-M"];
    const [names, patch] = await Promise.all([
      this.git(repo, ["diff", ...diffArgs, "--name-status", "-z", hash, "--"]),
      this.git(repo, ["diff", ...diffArgs, hash, "--"]),
    ]);
    return { hash, files: parseNameStatus(names, hash), patch };
  }

  /**
   * The commits an interactive rebase of the checked-out branch onto `onto` would replay, oldest first
   * (what git itself lists: no merges, nothing already upstream). Read-only.
   */
  async rebasePlan(repo: Repo, onto: string): Promise<RebasePlan> {
    if (!onto || onto.startsWith("-") || /[\s\0]/.test(onto)) throw new Error(`Not a branch or commit: ${onto}`);
    return { onto, commits: parseRebasePlan(await this.git(repo, rebasePlanArgs(onto))) };
  }

  /** Read-only diff of a branch made by an older version of the app (`ai/<task-id>`), for tasks still queued. */
  async legacyDiff(repo: Repo, br: LegacyTaskBranch): Promise<string> {
    return this.git(repo, ["diff", "--no-color", "--no-ext-diff", br.baseCommit, br.name, "--"]);
  }

  /**
   * Migration from the old worktree setup: commit what the worktree held onto its branch, then
   * remove the worktree folder. The branch stays in the repo.
   */
  async removeLegacyWorktree(repo: Repo, path: string, message: string, identity?: GitIdentity | null): Promise<void> {
    const status = await git(["status", "--porcelain"], path).catch(() => null);
    if (status?.trim()) {
      // Commit first; if this fails we throw and leave the folder alone, so no work is lost.
      await git(["add", "--all"], path);
      await run("git", ["commit", "--no-verify", "-m", message], path, {
        env: { ...process.env, ...gitIdentityEnv(identity) },
      });
    }
    await gitOk(["worktree", "remove", "--force", path], repo.path);
    await rm(path, { recursive: true, force: true });
    await gitOk(["worktree", "prune"], repo.path);
  }
}

/** `git stash list --format`: one record per stash, fields split by unit separators. */
export const STASH_FORMAT = `${["%gd", "%H", "%P", "%gs", "%aI", "%an", "%ae"].join("%x1f")}%x1e`;
export function parseStashList(out: string): StashEntry[] {
  const list: StashEntry[] = [];
  for (const record of out.split("\x1e")) {
    const [selector, hash, parents, message, date, author, email] = record.replace(/^\s+/, "").split("\x1f");
    const index = /^stash@\{(\d+)\}$/.exec(selector ?? "");
    if (!index || !hash) continue;
    list.push({
      index: Number(index[1]),
      hash,
      base: (parents ?? "").split(" ")[0] ?? "",
      message: message ?? "",
      date: date ?? "",
      author: author ?? "",
      email: email ?? "",
      avatar: gravatarId(email ?? ""),
    });
  }
  return list;
}

/** `git log` of the commits `git rebase -i <onto>` lists for the checked-out branch, oldest first. */
export const rebasePlanArgs = (onto: string) => [
  "log", "--no-color", "--reverse", "--right-only", "--topo-order", "--cherry-pick", "--no-merges",
  "--format=%H%x1f%s%x1e", `${onto}...HEAD`, "--",
];
export function parseRebasePlan(out: string): RebasePlan["commits"] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\s+/, "").split("\x1f"))
    .filter((f) => f.length >= 2 && f[0])
    .map(([hash, subject]) => ({ hash: hash!, subject: subject ?? "" }));
}

/** `git diff --name-status -z` output → files. `diff-tree` (root commits) prints the commit hash first. */
function parseNameStatus(out: string, hash: string): CommitFile[] {
  const parts = out.split("\0").filter(Boolean);
  if (parts[0] === hash) parts.shift();
  const files: CommitFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    const status = code[0] as CommitFile["status"];
    if (status === "R" || status === "C") {
      const oldPath = parts[i++] ?? "";
      files.push({ status, oldPath, path: parts[i++] ?? "" });
    } else {
      files.push({ status: "MADT".includes(status) ? status : "M", oldPath: null, path: parts[i++] ?? "" });
    }
  }
  return files;
}

/** One `git status --porcelain=v1 -z` letter → a file status. */
function statusLetter(c: string): CommitFile["status"] {
  return c === "A" || c === "D" || c === "R" || c === "C" || c === "T" ? c : "M";
}

/**
 * `git status --porcelain=v1 -z` → staged (index) and unstaged (working tree + untracked) files.
 * Renames print the new path, then the old one. Conflicted files count as unstaged.
 */
export function parseStatus(out: string): { staged: CommitFile[]; unstaged: CommitFile[] } {
  const parts = out.split("\0");
  const staged: CommitFile[] = [];
  const unstaged: CommitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const [x, y, path] = [entry[0]!, entry[1]!, entry.slice(3)];
    const oldPath = x === "R" || x === "C" ? (parts[++i] ?? null) : null;
    if (x === "!") continue;
    if (x === "?") {
      unstaged.push({ status: "A", path, oldPath: null });
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      unstaged.push({ status: "M", path, oldPath: null });
      continue;
    }
    if (x !== " ") staged.push({ status: statusLetter(x), path, oldPath });
    if (y !== " ") unstaged.push({ status: statusLetter(y), path, oldPath: null });
  }
  return { staged, unstaged };
}

/** The WIP row's counts: each path once, by what it looks like overall. */
function summarize(staged: CommitFile[], unstaged: CommitFile[]): WipSummary | null {
  const by = new Map<string, CommitFile["status"]>();
  for (const f of [...staged, ...unstaged]) {
    const before = by.get(f.path);
    // Staged as new, then edited: still a new file. Deleted anywhere: deleted.
    by.set(f.path, f.status === "D" ? "D" : before === "A" || before === "D" ? before : f.status);
  }
  if (by.size === 0) return null;
  const all = [...by.values()];
  const added = all.filter((s) => s === "A" || s === "C").length;
  const deleted = all.filter((s) => s === "D").length;
  return { files: by.size, added, deleted, modified: by.size - added - deleted };
}

/** Gravatar id: SHA-256 of the trimmed, lowercased email. */
function gravatarId(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
