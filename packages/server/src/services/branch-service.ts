import { rm } from "node:fs/promises";
import type { Repo, Task } from "@my-ai-slaves/shared";
import { type GitIdentity, gitIdentityEnv } from "../providers/types";
import { badRequest } from "./common";
import { git, gitOk, run } from "./git";

export type TaskBranch = NonNullable<Task["branch"]>;

/** Trailer/footer lines AI CLIs add to commit messages. Removed before Keep / Push. */
export const AI_TRAILER_LINE =
  /^\s*(co-authored-by:.*(claude|cursor|anthropic|openai|copilot|gemini|\bai\b).*|made with cursor.*|🤖 generated with.*|generated with \[?claude code.*|claude-session:.*)\s*$/i;

export function stripAiLines(message: string): string {
  const kept = message
    .split("\n")
    .filter((line) => !AI_TRAILER_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${kept}\n`;
}

/** Refuse to ever commit, reset or delete anything that isn't one of our ai/ branches. */
function assertAiBranch(name: string) {
  if (!name.startsWith("ai/")) throw new Error(`Refusing to touch non-ai branch "${name}".`);
}

/** The repo has uncommitted changes, so a task can't switch branches in it right now. */
export class DirtyRepoError extends Error {
  constructor(repo: Repo) {
    super(`${repo.name} has uncommitted changes. Commit or stash them; tasks switch branches in your checkout.`);
  }
}

export interface SettleResult {
  committed: boolean;
  /** Set when the repo wasn't on the task's branch (the agent switched branches): nothing was touched. */
  warning: string | null;
}

/**
 * Tasks work directly in the repository: each run checks out `ai/<task-id>` created from the repo's
 * base branch, and when it ends the work is committed on that branch and the branch you were on is
 * checked out again. No worktrees. main/master are never committed to.
 */
export class BranchService {
  /** True when there are no uncommitted changes (ignored files don't count). */
  async isClean(repo: Repo): Promise<boolean> {
    return (await git(["status", "--porcelain"], repo.path)).trim() === "";
  }

  /** The checked-out branch name, or the commit when HEAD is detached. */
  async currentRef(repo: Repo): Promise<string> {
    try {
      return (await git(["symbolic-ref", "--short", "-q", "HEAD"], repo.path)).trim();
    } catch {
      return (await git(["rev-parse", "HEAD"], repo.path)).trim();
    }
  }

  /**
   * Check out the task's branch for a run.
   * - first run: create `ai/<task-id>` from the base branch;
   * - `fromScratch` (retry, fallback to another account): reset that branch to the base commit;
   * - otherwise (a reply): continue on the branch as it is.
   */
  async checkoutForRun(repo: Repo, taskId: string, existing: TaskBranch | null, fromScratch: boolean): Promise<TaskBranch> {
    if (!(await this.isClean(repo))) throw new DirtyRepoError(repo);
    const returnTo = await this.currentRef(repo);
    if (existing && !fromScratch) {
      await git(["checkout", existing.name], repo.path);
      return { ...existing, returnTo: returnTo === existing.name ? existing.returnTo : returnTo };
    }

    const name = existing?.name ?? `ai/${taskId}`;
    assertAiBranch(name);
    let baseCommit = existing?.baseCommit ?? null;
    if (!baseCommit) {
      try {
        baseCommit = (await git(["rev-parse", "--verify", `${repo.defaultBranch}^{commit}`], repo.path)).trim();
      } catch {
        throw badRequest(`Base branch "${repo.defaultBranch}" not found in ${repo.path}. Fix it on the Repos page.`);
      }
    }
    // -B: create, or reset a leftover branch of the same name to the base commit.
    await git(["checkout", "-B", name, baseCommit], repo.path);
    return { name, base: repo.defaultBranch, baseCommit, returnTo: returnTo === name ? null : returnTo };
  }

  /** After a run: commit what the agent left on the task branch, then go back to the branch you were on. */
  async settle(repo: Repo, br: TaskBranch, message: string, identity?: GitIdentity | null): Promise<SettleResult> {
    const current = await this.currentRef(repo);
    if (current !== br.name) {
      return {
        committed: false,
        warning: `${repo.name} is on "${current}", not "${br.name}" (the agent switched branches). Nothing was committed or checked out; check the repo.`,
      };
    }
    let committed = false;
    if (!(await this.isClean(repo))) {
      await git(["add", "--all"], repo.path);
      // --no-verify: the agent's work is committed as-is on its own ai/ branch; review happens in the app.
      await run("git", ["commit", "--no-verify", "-m", message], repo.path, {
        env: { ...process.env, ...gitIdentityEnv(identity) },
      });
      committed = true;
    }
    if (br.returnTo && br.returnTo !== br.name) await git(["checkout", br.returnTo], repo.path);
    return { committed, warning: null };
  }

  /** Start over: the task branch points at the base commit again. */
  async resetToBase(repo: Repo, br: TaskBranch): Promise<void> {
    assertAiBranch(br.name);
    if ((await this.currentRef(repo)) === br.name) {
      await git(["reset", "--hard", br.baseCommit], repo.path);
      await git(["clean", "-fd"], repo.path);
    } else {
      await git(["branch", "-f", br.name, br.baseCommit], repo.path);
    }
  }

  async deleteBranch(repo: Repo, br: TaskBranch): Promise<void> {
    assertAiBranch(br.name);
    if ((await this.currentRef(repo)) === br.name) {
      await git(["checkout", br.returnTo ?? br.base], repo.path);
    }
    await gitOk(["branch", "-D", br.name], repo.path);
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

  /** Everything the task changed: base commit vs the task branch. */
  async diff(repo: Repo, br: TaskBranch): Promise<string> {
    return git(["diff", "--no-color", "--no-ext-diff", br.baseCommit, br.name, "--"], repo.path);
  }

  /**
   * Safety net for "no AI attribution": rebuilds the task's commits without AI co-author lines,
   * keeping authors, committers, dates and trees. Uses plumbing only, so your checkout (even with
   * uncommitted changes) is never touched. Returns how many commits had such lines.
   */
  async stripAiTrailers(repo: Repo, br: TaskBranch): Promise<number> {
    assertAiBranch(br.name);
    const lines = (await git(["rev-list", "--reverse", "--parents", `${br.baseCommit}..${br.name}`], repo.path))
      .trim()
      .split("\n")
      .filter(Boolean);
    const commits = lines.map((l) => l.split(" "));
    if (commits.some((c) => c.length !== 2)) return 0; // merges: leave history alone

    const messages = await Promise.all(commits.map(([sha]) => git(["log", "-1", "--format=%B", sha as string], repo.path)));
    const dirty = messages.filter((m) => m.split("\n").some((l) => AI_TRAILER_LINE.test(l))).length;
    if (dirty === 0) return 0;

    const oldTip = (await git(["rev-parse", br.name], repo.path)).trim();
    const mapped = new Map<string, string>();
    for (const [i, [sha, parent]] of commits.entries()) {
      const meta = (
        await git(["log", "-1", "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%T", "--date=raw", sha as string], repo.path)
      )
        .trim()
        .split("\0");
      const [an, ae, ad, cn, ce, cd, tree] = meta as [string, string, string, string, string, string, string];
      const newParent = mapped.get(parent as string) ?? (parent as string);
      const created = await run("git", ["commit-tree", tree, "-p", newParent, "-m", stripAiLines(messages[i] ?? "").trimEnd()], repo.path, {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: an,
          GIT_AUTHOR_EMAIL: ae,
          GIT_AUTHOR_DATE: ad,
          GIT_COMMITTER_NAME: cn,
          GIT_COMMITTER_EMAIL: ce,
          GIT_COMMITTER_DATE: cd,
        },
      });
      mapped.set(sha as string, created.stdout.trim());
    }
    const newTip = mapped.get(commits.at(-1)?.[0] as string) as string;
    await git(["update-ref", `refs/heads/${br.name}`, newTip, oldTip], repo.path);
    return dirty;
  }

  /** Push the ai/ branch and open a PR/MR with gh/glab when possible; otherwise return a compare URL. */
  async push(repo: Repo, br: TaskBranch, title: string): Promise<{ url: string | null; output: string }> {
    assertAiBranch(br.name);
    const log: string[] = [];
    const pushed = await run("git", ["push", "-u", "origin", br.name], repo.path);
    log.push(pushed.stderr.trim(), pushed.stdout.trim());

    const remote = (await git(["remote", "get-url", "origin"], repo.path)).trim();
    const web = remoteToWeb(remote);
    try {
      if (web?.kind === "github") {
        const out = await run("gh", ["pr", "create", "--head", br.name, "--base", br.base, "--title", title, "--body", ""], repo.path);
        log.push(out.stdout.trim());
        return { url: lastUrl(out.stdout) ?? web.compare(br), output: log.filter(Boolean).join("\n") };
      }
      if (web?.kind === "gitlab") {
        const out = await run(
          "glab",
          ["mr", "create", "--source-branch", br.name, "--target-branch", br.base, "--title", title, "--description", "", "--yes"],
          repo.path,
        );
        log.push(out.stdout.trim());
        return { url: lastUrl(out.stdout) ?? web.compare(br), output: log.filter(Boolean).join("\n") };
      }
    } catch (error) {
      log.push(`Could not open the PR/MR automatically: ${(error as Error).message}`);
    }
    return { url: web?.compare(br) ?? lastUrl(log.join("\n")), output: log.filter(Boolean).join("\n") };
  }
}

function lastUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/\S+/g);
  return urls?.at(-1) ?? null;
}

function remoteToWeb(remote: string): { kind: "github" | "gitlab" | "other"; compare(br: TaskBranch): string } | null {
  // git@host:group/repo.git  |  https://host/group/repo.git  |  ssh://git@host/group/repo.git
  const match = /^(?:git@([^:]+):|(?:ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) return null;
  const host = match[1] ?? match[2] ?? "";
  const base = `https://${host}/${match[3] ?? ""}`;
  if (host.includes("github")) {
    return { kind: "github", compare: (br) => `${base}/compare/${br.base}...${br.name}?expand=1` };
  }
  if (host.includes("gitlab")) {
    return {
      kind: "gitlab",
      compare: (br) =>
        `${base}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(br.name)}&merge_request[target_branch]=${encodeURIComponent(br.base)}`,
    };
  }
  return { kind: "other", compare: () => base };
}
