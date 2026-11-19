import { rm } from "node:fs/promises";
import type { Repo, Task } from "@my-ai-slaves/shared";
import { type GitIdentity, gitIdentityEnv } from "../providers/types";
import { runOn } from "../remote/machine";
import { git, gitOk, run } from "./git";

export type TaskCheckout = NonNullable<Task["checkout"]>;
export type LegacyTaskBranch = NonNullable<Task["branch"]>;

/** At most this many untracked files are shown in a task's diff. */
const UNTRACKED_LIMIT = 200;

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
