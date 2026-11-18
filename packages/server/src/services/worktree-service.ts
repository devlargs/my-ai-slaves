import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Repo, Task } from "@my-ai-slaves/shared";
import { badRequest } from "./common";
import { gitIdentityEnv, type GitIdentity } from "../providers/types";
import { git, gitOk, run } from "./git";
import { AI_TRAILER_LINE } from "./strip-ai-trailers.mjs";

const STRIP_SCRIPT = fileURLToPath(new URL("./strip-ai-trailers.mjs", import.meta.url));

type Worktree = NonNullable<Task["worktree"]>;

/** Refuse to ever commit/push anything that isn't one of our ai/ branches. */
function assertAiBranch(wt: Worktree) {
  if (!wt.branch.startsWith("ai/")) throw new Error(`Refusing to touch non-ai branch "${wt.branch}".`);
}

/**
 * One git worktree per task under .data/worktrees/<repo>/<task-id>, on branch ai/<task-id>.
 * Your main working tree and main/master are never checked out, committed to, or reset.
 */
export class WorktreeService {
  constructor(private readonly worktreesDir: string) {}

  async create(repo: Repo, taskId: string): Promise<Worktree> {
    const path = join(this.worktreesDir, repo.id, taskId);
    const branch = `ai/${taskId}`;
    let baseCommit: string;
    try {
      baseCommit = (await git(["rev-parse", "--verify", `${repo.defaultBranch}^{commit}`], repo.path)).trim();
    } catch {
      throw badRequest(`Base branch "${repo.defaultBranch}" not found in ${repo.path}. Fix it on the Repos page.`);
    }

    // Clean up leftovers from a crash or an earlier attempt with the same id.
    await gitOk(["worktree", "remove", "--force", path], repo.path);
    await rm(path, { recursive: true, force: true });
    await gitOk(["worktree", "prune"], repo.path);
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo.path)) {
      await git(["branch", "-D", branch], repo.path);
    }

    await mkdir(dirname(path), { recursive: true });
    await git(["worktree", "add", "-b", branch, path, baseCommit], repo.path);
    return { path, branch, baseBranch: repo.defaultBranch, baseCommit };
  }

  /** Throw away everything the agent did: branch back to the base commit, untracked files removed. */
  async reset(wt: Worktree): Promise<void> {
    assertAiBranch(wt);
    await git(["reset", "--hard", wt.baseCommit], wt.path);
    await git(["clean", "-fd"], wt.path);
  }

  /** Everything vs the base commit: agent commits, uncommitted edits, and new files. */
  async diff(wt: Worktree): Promise<string> {
    await git(["add", "--intent-to-add", "--all"], wt.path);
    return git(["diff", "--no-color", "--no-ext-diff", wt.baseCommit, "--"], wt.path);
  }

  /** Commit anything the agent left uncommitted, on the ai/ branch, as the repo's committer. */
  async commitLeftovers(wt: Worktree, message: string, identity?: GitIdentity | null): Promise<boolean> {
    assertAiBranch(wt);
    const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], wt.path)).trim();
    if (current !== wt.branch) throw new Error(`Worktree is on "${current}", expected "${wt.branch}". Not committing.`);
    const status = await git(["status", "--porcelain"], wt.path);
    if (!status.trim()) return false;
    await git(["add", "--all"], wt.path);
    // --no-verify: repo hooks usually need node_modules, which a fresh worktree doesn't have.
    await run("git", ["commit", "--no-verify", "-m", message], wt.path, {
      env: { ...process.env, ...gitIdentityEnv(identity) },
    });
    return true;
  }

  /**
   * Safety net for "no AI attribution": the CLIs are told not to add it, but a repo's own
   * CLAUDE.md can override that. Rewrites only this task's unpushed ai/ commits, and only if one
   * actually carries such a line. Authors, committers and dates are kept.
   */
  async stripAiTrailers(wt: Worktree): Promise<number> {
    assertAiBranch(wt);
    const range = `${wt.baseCommit}..HEAD`;
    const log = await git(["log", "--format=%H%x00%B%x01", range], wt.path);
    const dirty = log
      .split("\x01")
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry.split("\x00")[1]?.split("\n").some((l) => AI_TRAILER_LINE.test(l)));
    if (dirty.length === 0) return 0;
    await run(
      "git",
      ["filter-branch", "-f", "--msg-filter", `${JSON.stringify(process.execPath)} ${JSON.stringify(STRIP_SCRIPT)}`, "--", range],
      wt.path,
      { env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: "1" } },
    );
    return dirty.length;
  }

  async remove(repo: Repo, wt: Worktree, options: { deleteBranch: boolean }): Promise<void> {
    await gitOk(["worktree", "remove", "--force", wt.path], repo.path);
    await rm(wt.path, { recursive: true, force: true });
    await gitOk(["worktree", "prune"], repo.path);
    if (options.deleteBranch) {
      assertAiBranch(wt);
      await gitOk(["branch", "-D", wt.branch], repo.path);
    }
  }

  /** Push the ai/ branch and open a PR/MR with gh/glab when possible; otherwise return a compare URL. */
  async push(wt: Worktree, title: string): Promise<{ url: string | null; output: string }> {
    assertAiBranch(wt);
    const log: string[] = [];
    const pushed = await run("git", ["push", "-u", "origin", wt.branch], wt.path);
    log.push(pushed.stderr.trim(), pushed.stdout.trim());

    const remote = (await git(["remote", "get-url", "origin"], wt.path)).trim();
    const web = remoteToWeb(remote);

    try {
      if (web?.kind === "github") {
        const out = await run("gh", ["pr", "create", "--head", wt.branch, "--base", wt.baseBranch, "--title", title, "--body", ""], wt.path);
        log.push(out.stdout.trim());
        return { url: lastUrl(out.stdout) ?? web.compare(wt), output: log.filter(Boolean).join("\n") };
      }
      if (web?.kind === "gitlab") {
        const out = await run(
          "glab",
          ["mr", "create", "--source-branch", wt.branch, "--target-branch", wt.baseBranch, "--title", title, "--description", "", "--yes"],
          wt.path,
        );
        log.push(out.stdout.trim());
        return { url: lastUrl(out.stdout) ?? web.compare(wt), output: log.filter(Boolean).join("\n") };
      }
    } catch (error) {
      log.push(`Could not open the PR/MR automatically: ${(error as Error).message}`);
    }
    return { url: web?.compare(wt) ?? lastUrl(log.join("\n")), output: log.filter(Boolean).join("\n") };
  }
}

function lastUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/\S+/g);
  return urls?.at(-1) ?? null;
}

function remoteToWeb(remote: string): { kind: "github" | "gitlab" | "other"; compare(wt: Worktree): string } | null {
  // git@host:group/repo.git  |  https://host/group/repo.git  |  ssh://git@host/group/repo.git
  const match = /^(?:git@([^:]+):|(?:ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) return null;
  const host = match[1] ?? match[2] ?? "";
  const path = match[3] ?? "";
  const base = `https://${host}/${path}`;
  if (host.includes("github")) {
    return { kind: "github", compare: (wt) => `${base}/compare/${wt.baseBranch}...${wt.branch}?expand=1` };
  }
  if (host.includes("gitlab")) {
    return {
      kind: "gitlab",
      compare: (wt) =>
        `${base}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(wt.branch)}&merge_request[target_branch]=${encodeURIComponent(wt.baseBranch)}`,
    };
  }
  return { kind: "other", compare: () => base };
}
