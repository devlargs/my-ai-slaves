import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { CommitDetail, CommitFile, GraphCommit, LocalBranch, RemoteBranch, Repo, RepoGraph, Task } from "@my-ai-slaves/shared";
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
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%s", "%D"].join("%x1f") + "%x1e";
    const out = await this.git(repo, [
      "log",
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
    const { local, remote } = await this.branches(repo).catch(() => ({ local: [], remote: [] }));
    return { commits: commits.slice(0, limit), head, more, local, remote };
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

/** Gravatar id: SHA-256 of the trimmed, lowercased email. */
function gravatarId(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
