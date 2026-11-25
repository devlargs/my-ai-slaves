import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GitHistory, GitRefAction, PullMode, RebaseStep, Repo } from "@my-ai-slaves/shared";
import { type GitIdentity, gitIdentityEnv } from "../providers/types";
import { runOn } from "../remote/machine";
import { badRequest, conflict } from "./common";
import { CommandError } from "./git";
import { parseRebasePlan, parseStashList, rebasePlanArgs, STASH_FORMAT } from "./repo-git";

/**
 * The graph toolbar (Undo, Redo, Pull, Branch), the WIP panel (stage, unstage, commit), the right-click
 * menus, the toolbar's Stash / Pop and the Stashes group (apply, pop, delete, edit message). These are
 * the only places the app changes a repo, and only when you click them (tasks never do). Undo/Redo work like GitKraken's:
 *
 * - Actions done here (pull, new branch) go on an undo stack.
 * - Anything done outside (an agent's or your own commit, checkout, pull, merge, reset) is read
 *   from HEAD's reflog, so "the last action of the repository" can be undone too.
 * - Undo/Redo's own git commands are tagged in the reflog (GIT_REFLOG_ACTION) and never read back
 *   as actions. When the reflog moves for any other reason, the history is rebuilt from it and the
 *   redo stack is dropped.
 *
 * Undoing a commit is a soft reset (its changes stay staged); undoing a pull, merge or reset is
 * `reset --keep` (refuses rather than overwrite local changes); undoing a checkout checks out the
 * previous branch; undoing a new branch checks out where you were and deletes it (only while it
 * still points at the commit it was created on).
 */

/** Reflog message prefix of Undo/Redo's own commands. */
export const REFLOG_TAG = "my-ai-slaves";
/** How far back the reflog is read for undo steps. */
const DEPTH = 20;
const SHA = /^[0-9a-f]{40,64}$/i;

type Action =
  | { kind: "reset"; mode: "soft" | "keep"; before: string; after: string; label: string }
  | { kind: "checkout"; from: string; to: string; label: string }
  | { kind: "branch"; name: string; commit: string; from: string; label: string };

interface History {
  undo: Action[];
  redo: Action[];
  /** The newest reflog entry when the history was last in step with the repo. */
  marker: string;
}

interface ReflogEntry {
  id: string;
  hash: string;
  subject: string;
}

const PULL_ARGS: Record<Exclude<PullMode, "fetch">, string[]> = {
  "pull-ff": ["pull", "--no-rebase", "--ff", "--no-edit"],
  "pull-ff-only": ["pull", "--ff-only"],
  "pull-rebase": ["pull", "--rebase"],
};

/** A branch or commit name read from the reflog; never something git could take for an option. */
const safeRef = (ref: string) => !!ref && !ref.startsWith("-") && !/[\s\0]/.test(ref);

/** Paths per git call when staging / unstaging, so a long list never hits Windows' command-line limit. */
const PATH_BATCH = 100;
const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export interface CommitInput {
  summary: string;
  description?: string;
  /** Replace the last commit (`--amend`) instead of adding one. */
  amend?: boolean;
  /** Skip the repo's pre-commit / commit-msg hooks (`--no-verify`). */
  noVerify?: boolean;
}

export class RepoActions {
  private readonly histories = new Map<string, History>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Actions clicked and not finished yet, per repo (queued behind another one or running). */
  private readonly pending = new Map<string, number>();
  private readonly idleListeners: Array<(repoId: string) => void> = [];

  constructor(private readonly busy: (repoId: string) => boolean = () => false) {}

  /** Whether an action is queued or running in the repo: the scheduler waits for it before starting a task there. */
  inFlight(repoId: string): boolean {
    return (this.pending.get(repoId) ?? 0) > 0;
  }

  /** Called when a repo's last action ends, so tasks waiting on it can start. */
  onIdle(listener: (repoId: string) => void): void {
    this.idleListeners.push(listener);
  }

  private async git(repo: Repo, args: string[], opts: { env?: Record<string, string>; ok?: number[]; timeoutMs?: number } = {}) {
    const extraEnv = { GIT_TERMINAL_PROMPT: "0", ...opts.env };
    return (await runOn(repo.host, "git", args, repo.path, { extraEnv, okExitCodes: opts.ok, timeoutMs: opts.timeoutMs })).stdout;
  }

  /** Undo/Redo's own commands: tagged so the reflog reader skips them. */
  private tagged(repo: Repo, args: string[]) {
    return this.git(repo, args, { env: { GIT_REFLOG_ACTION: REFLOG_TAG } });
  }

  /** One action at a time per repo (a double click must not undo twice). */
  private exclusive<T>(repo: Repo, work: () => Promise<T>): Promise<T> {
    // Counted from the click (synchronously), so a task can't start in the repo while it waits or runs.
    this.pending.set(repo.id, (this.pending.get(repo.id) ?? 0) + 1);
    const prev = this.locks.get(repo.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => {
        if (this.busy(repo.id)) throw conflict("A task is running in this repo. Wait for it to finish first.");
        return work();
      })
      .finally(() => {
        const left = (this.pending.get(repo.id) ?? 1) - 1;
        if (left > 0) {
          this.pending.set(repo.id, left);
          return;
        }
        this.pending.delete(repo.id);
        if (this.locks.get(repo.id) === next) this.locks.delete(repo.id);
        for (const listener of this.idleListeners) listener(repo.id);
      });
    this.locks.set(repo.id, next);
    return next;
  }

  private async reflog(repo: Repo, n: number): Promise<ReflogEntry[]> {
    const out = await this.git(repo, ["log", "-g", "--date=raw", `-n${n}`, "--format=%H%x1f%gs%x1f%gd%x1e", "HEAD", "--"]).catch(() => "");
    return out
      .split("\x1e")
      .map((r) => r.replace(/^\s+/, "").split("\x1f"))
      .filter((f) => f.length >= 3 && f[0])
      .map(([hash, subject, selector]) => ({ hash: hash!, subject: subject!, id: `${selector}|${hash}|${subject}` }));
  }

  private async marker(repo: Repo): Promise<string> {
    return (await this.reflog(repo, 1))[0]?.id ?? "";
  }

  private async head(repo: Repo): Promise<string> {
    return (await this.git(repo, ["rev-parse", "HEAD"])).trim();
  }

  private async currentRef(repo: Repo): Promise<string> {
    const branch = (await this.git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], { ok: [1] })).trim();
    return branch || this.head(repo);
  }

  private async exists(repo: Repo, ref: string): Promise<boolean> {
    return (await this.git(repo, ["rev-parse", "-q", "--verify", ref], { ok: [1] })).trim() !== "";
  }

  /** The history, rebuilt from the reflog when the repo moved since we last looked. */
  private async sync(repo: Repo): Promise<History> {
    const entries = await this.reflog(repo, DEPTH + 1);
    const top = entries[0]?.id ?? "";
    const known = this.histories.get(repo.id);
    if (known && known.marker === top) return known;
    const undo: Action[] = [];
    for (let i = 0; i + 1 < entries.length; i++) {
      const action = fromReflog(entries[i]!, entries[i + 1]!.hash);
      if (!action) break;
      undo.unshift(action);
    }
    const history = { undo, redo: [], marker: top };
    this.histories.set(repo.id, history);
    return history;
  }

  private view(h: History): GitHistory {
    return { undo: h.undo.at(-1)?.label ?? null, redo: h.redo.at(-1)?.label ?? null };
  }

  async history(repo: Repo): Promise<GitHistory> {
    return this.view(await this.sync(repo));
  }

  undo(repo: Repo): Promise<GitHistory> {
    return this.exclusive(repo, async () => {
      const h = await this.sync(repo);
      const action = h.undo.at(-1);
      if (!action) throw conflict("Nothing to undo.");
      await this.revert(repo, action);
      h.undo.pop();
      h.redo.push(action);
      h.marker = await this.marker(repo);
      return this.view(h);
    });
  }

  redo(repo: Repo): Promise<GitHistory> {
    return this.exclusive(repo, async () => {
      const h = await this.sync(repo);
      const action = h.redo.at(-1);
      if (!action) throw conflict("Nothing to redo.");
      await this.apply(repo, action);
      h.redo.pop();
      h.undo.push(action);
      h.marker = await this.marker(repo);
      return this.view(h);
    });
  }

  private async revert(repo: Repo, a: Action): Promise<void> {
    if (a.kind === "reset") {
      if ((await this.head(repo)) !== a.after) throw conflict("The repository changed since. Refresh and try again.");
      await this.tagged(repo, ["reset", `--${a.mode}`, a.before, "--"]);
    } else if (a.kind === "checkout") {
      await this.tagged(repo, ["checkout", a.from, "--"]);
    } else {
      if ((await this.currentRef(repo)) === a.name) await this.tagged(repo, ["checkout", a.from, "--"]);
      const tip = (await this.git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${a.name}`], { ok: [1] })).trim();
      if (tip && tip !== a.commit) throw conflict(`${a.name} has new commits; it was left as it is.`);
      if (tip) await this.git(repo, ["branch", "-D", "--", a.name]);
    }
  }

  private async apply(repo: Repo, a: Action): Promise<void> {
    if (a.kind === "reset") {
      if ((await this.head(repo)) !== a.before) throw conflict("The repository changed since. Refresh and try again.");
      await this.tagged(repo, ["reset", `--${a.mode}`, a.after, "--"]);
    } else if (a.kind === "checkout") {
      await this.tagged(repo, ["checkout", a.to, "--"]);
    } else {
      if (await this.exists(repo, `refs/heads/${a.name}`)) throw conflict(`A branch named ${a.name} already exists.`);
      await this.tagged(repo, ["checkout", "-b", a.name, a.commit, "--"]);
    }
  }

  /** Fetch all remotes, or pull the checked-out branch the chosen way. A failed merge/rebase is aborted. */
  pull(repo: Repo, mode: PullMode, identity: GitIdentity | null): Promise<GitHistory> {
    return this.exclusive(repo, () => this.pullHere(repo, mode, identity));
  }

  private async pullHere(repo: Repo, mode: PullMode, identity: GitIdentity | null): Promise<GitHistory> {
    {
      const h = await this.sync(repo);
      if (mode === "fetch") {
        await this.git(repo, ["fetch", "--all", "--prune"], { timeoutMs: 300_000 });
        return this.view(h);
      }
      await this.notMidOperation(repo);
      const before = await this.head(repo);
      try {
        await this.git(repo, PULL_ARGS[mode], { env: gitIdentityEnv(identity), timeoutMs: 300_000 });
      } catch (error) {
        // Leave the repo as it was rather than half-merged.
        if (await this.exists(repo, "MERGE_HEAD")) await this.git(repo, ["merge", "--abort"]).catch(() => {});
        if (await this.exists(repo, "REBASE_HEAD")) await this.git(repo, ["rebase", "--abort"]).catch(() => {});
        throw error;
      }
      const after = await this.head(repo);
      if (after !== before) {
        h.undo.push({ kind: "reset", mode: "keep", before, after, label: "pull" });
        h.redo = [];
      }
      h.marker = await this.marker(repo);
      return this.view(h);
    }
  }

  /**
   * Stage files (`git add -A`, so deletions and untracked files count), or every change when `paths`
   * is null. Paths are taken literally (no globs), relative to the repo root.
   */
  stage(repo: Repo, paths: string[] | null): Promise<void> {
    return this.exclusive(repo, async () => {
      if (paths === null) {
        await this.git(repo, ["add", "-A"]);
        return;
      }
      for (const batch of chunks(checkPaths(paths), PATH_BATCH)) {
        await this.git(repo, ["--literal-pathspecs", "add", "-A", "--", ...batch]);
      }
    });
  }

  /** Unstage files (back to the working tree, nothing is lost), or everything when `paths` is null. */
  unstage(repo: Repo, paths: string[] | null): Promise<void> {
    return this.exclusive(repo, async () => {
      const born = await this.exists(repo, "HEAD");
      const list = paths === null ? null : checkPaths(paths);
      if (!born) {
        // No commit yet: nothing to reset to, so take the files out of the index instead.
        if (list === null) await this.git(repo, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]);
        else for (const batch of chunks(list, PATH_BATCH)) await this.git(repo, ["--literal-pathspecs", "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...batch]);
        return;
      }
      if (list === null) await this.git(repo, ["reset", "-q", "HEAD", "--"]);
      else for (const batch of chunks(list, PATH_BATCH)) await this.git(repo, ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...batch]);
    });
  }

  /**
   * Commit what's staged, with the repo's committer. The summary is the first line, the description
   * the body. Undo (from the reflog) takes it back as a soft reset.
   */
  commit(repo: Repo, input: CommitInput, identity: GitIdentity | null): Promise<GitHistory> {
    return this.exclusive(repo, async () => {
      const summary = input.summary.trim();
      const description = (input.description ?? "").trim();
      if (!summary) throw badRequest("Write a commit summary first.");
      if (/[\r\n]/.test(summary)) throw badRequest("The commit summary is a single line.");
      if (input.amend && !(await this.exists(repo, "HEAD"))) throw conflict("There's no commit to amend yet.");
      if (!input.amend) {
        const staged = await this.git(repo, ["diff", "--cached", "--name-only", "-z", "--"]);
        if (!staged) throw conflict("Nothing is staged. Stage the files to commit first.");
      }
      const args = ["commit", "-m", summary];
      if (description) args.push("-m", description);
      if (input.amend) args.push("--amend");
      if (input.noVerify) args.push("--no-verify");
      // Hooks (lint-staged and the like) can take a while.
      await this.git(repo, args, { env: { ...gitIdentityEnv(identity), GIT_EDITOR: "true" }, timeoutMs: 300_000 });
      return this.view(await this.sync(repo));
    });
  }

  /** A new branch at HEAD, checked out (like `git checkout -b`). */
  createBranch(repo: Repo, name: string): Promise<GitHistory> {
    return this.exclusive(repo, () => this.branchHere(repo, name, null));
  }

  /** A new branch at `at` (HEAD when null), checked out. */
  private async branchHere(repo: Repo, name: string, at: string | null): Promise<GitHistory> {
    const clean = await this.newBranchName(repo, name);
    const h = await this.sync(repo);
    const from = await this.currentRef(repo);
    const commit = at ?? (await this.head(repo));
    await this.git(repo, at ? ["checkout", "-b", clean, at, "--"] : ["checkout", "-b", clean, "--"]);
    h.undo.push({ kind: "branch", name: clean, commit, from, label: `create branch ${clean}` });
    h.redo = [];
    h.marker = await this.marker(repo);
    return this.view(h);
  }

  private async newBranchName(repo: Repo, name: string): Promise<string> {
    const clean = name.trim();
    const valid = safeRef(clean) && (await this.git(repo, ["check-ref-format", "--branch", clean]).then(() => true, () => false));
    if (!valid) throw badRequest(`"${clean}" isn't a valid branch name.`);
    if (await this.exists(repo, `refs/heads/${clean}`)) throw conflict(`A branch named ${clean} already exists.`);
    return clean;
  }

  /** Refuses while a merge, rebase, cherry-pick or revert is half done (left by something outside the app). */
  private async notMidOperation(repo: Repo): Promise<void> {
    for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (await this.exists(repo, ref)) {
        throw conflict("A merge, rebase, cherry-pick or revert is in progress in this repo. Finish or abort it first.");
      }
    }
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const path = (await this.git(repo, ["rev-parse", "--git-path", dir])).trim();
      if (path && (await this.dirExists(repo, path))) throw conflict("A rebase is in progress in this repo. Finish or abort it first.");
    }
  }

  /** Whether a folder exists (relative paths are from the repo root), here or on the repo's server. */
  private async dirExists(repo: Repo, path: string): Promise<boolean> {
    if (!repo.host) return existsSync(isAbsolute(path) ? path : join(repo.path, path));
    const out = await runOn(repo.host, "sh", ["-c", 'test -d "$1" && echo yes', "sh", path], repo.path, { okExitCodes: [1] });
    return out.stdout.trim() === "yes";
  }

  /** `stash@{n}`, once it's checked that it still is the stash that was clicked. */
  private async stashRef(repo: Repo, index: number, hash: string): Promise<string> {
    const list = parseStashList(await this.git(repo, ["stash", "list", "--no-color", `--format=${STASH_FORMAT}`]));
    if (list.find((s) => s.index === index)?.hash !== hash) throw conflict("The stash list changed. Refresh and try again.");
    return `stash@{${index}}`;
  }

  /** The branch's upstream: remote name and the branch's ref there, or null. */
  private async upstreamOf(repo: Repo, branch: string): Promise<{ remote: string; ref: string } | null> {
    const out = await this.git(repo, [
      "for-each-ref",
      "--format=%(upstream:remotename)%1f%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ]);
    const [remote, ref] = out.trim().split("\x1f");
    return remote && ref && safeRef(remote) && safeRef(ref) ? { remote, ref } : null;
  }

  private async remotes(repo: Repo): Promise<string[]> {
    return (await this.git(repo, ["remote"])).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  }

  /** "origin/feat/x" → { remote: "origin", name: "feat/x" } (the longest matching remote wins). */
  private async splitRemoteRef(repo: Repo, ref: string): Promise<{ remote: string; name: string }> {
    const remote = (await this.remotes(repo))
      .filter((r) => ref.startsWith(`${r}/`) && ref.length > r.length + 1)
      .sort((a, b) => b.length - a.length)[0];
    if (!remote) throw badRequest(`"${ref}" isn't a branch on a remote of this repo.`);
    return { remote, name: ref.slice(remote.length + 1) };
  }

  /** A branch or remote branch that exists, for merge / rebase / checkout. */
  private async checkRef(repo: Repo, ref: string): Promise<"local" | "remote"> {
    if (!safeRef(ref)) throw badRequest(`"${ref}" isn't a branch.`);
    if (await this.exists(repo, `refs/heads/${ref}`)) return "local";
    if (await this.exists(repo, `refs/remotes/${ref}`)) return "remote";
    throw conflict(`There's no branch named ${ref}. Refresh and try again.`);
  }

  private async checkCommit(repo: Repo, commit: string): Promise<string> {
    if (!SHA.test(commit) || !(await this.exists(repo, `${commit}^{commit}`))) throw badRequest(`Not a commit in this repo: ${commit}`);
    return commit;
  }

  private async localBranch(repo: Repo, branch: string): Promise<string> {
    if (!safeRef(branch) || !(await this.exists(repo, `refs/heads/${branch}`))) throw conflict(`There's no local branch named ${branch}.`);
    return branch;
  }

  /**
   * Runs a merge / rebase / cherry-pick / revert; when it stops (a conflict), it's aborted so the repo
   * is as it was, and the error is passed on.
   */
  private async orAbort(repo: Repo, abort: string[], work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      await this.git(repo, abort).catch(() => {});
      throw error;
    }
  }

  /** Something that moved HEAD: undoable as a `reset --keep` back to `before`. */
  private async moved(repo: Repo, h: History, before: string, label: string): Promise<GitHistory> {
    const after = await this.head(repo);
    if (after !== before) {
      h.undo.push({ kind: "reset", mode: "keep", before, after, label });
      h.redo = [];
    }
    h.marker = await this.marker(repo);
    return this.view(h);
  }

  /** The graph's right-click menu on a branch or a commit. */
  refAction(repo: Repo, action: GitRefAction, identity: GitIdentity | null): Promise<GitHistory> {
    return this.exclusive(repo, async () => {
      const env = gitIdentityEnv(identity);
      const slow = { timeoutMs: 300_000 };
      switch (action.op) {
        case "pull": {
          const branch = await this.localBranch(repo, action.branch);
          if ((await this.currentRef(repo)) === branch) return this.pullHere(repo, "pull-ff", identity);
          const up = await this.upstreamOf(repo, branch);
          if (!up) throw conflict(`${branch} has no upstream to pull from. Set one first.`);
          // Fetch straight into the branch: git refuses anything but a fast-forward.
          await this.git(repo, ["fetch", up.remote, `${up.ref}:refs/heads/${branch}`], slow);
          return this.view(await this.sync(repo));
        }
        case "push": {
          const branch = await this.localBranch(repo, action.branch);
          const up = await this.upstreamOf(repo, branch);
          if (up) {
            await this.git(repo, ["push", up.remote, `refs/heads/${branch}:${up.ref}`], slow);
          } else {
            const remotes = await this.remotes(repo);
            const remote = action.remote ?? (remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined);
            if (!remote || !remotes.includes(remote)) throw conflict("This repo has no remote to push to.");
            await this.git(repo, ["push", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`], slow);
          }
          return this.view(await this.sync(repo));
        }
        case "set-upstream": {
          const branch = await this.localBranch(repo, action.branch);
          const upstream = action.upstream.trim();
          const { remote, name } = await this.splitRemoteRef(repo, upstream);
          if (!safeRef(name) || !(await this.git(repo, ["check-ref-format", "--branch", name]).then(() => true, () => false))) {
            throw badRequest(`"${name}" isn't a valid branch name.`);
          }
          if (await this.exists(repo, `refs/remotes/${upstream}`)) {
            await this.git(repo, ["branch", `--set-upstream-to=${upstream}`, branch]);
          } else {
            // Not on the remote yet: push it there, then track it.
            await this.git(repo, ["push", "-u", remote, `refs/heads/${branch}:refs/heads/${name}`], slow);
          }
          return this.view(await this.sync(repo));
        }
        case "merge": {
          await this.checkRef(repo, action.ref);
          if ((await this.currentRef(repo)) === action.ref) throw badRequest("A branch can't be merged into itself.");
          await this.notMidOperation(repo);
          const h = await this.sync(repo);
          const before = await this.head(repo);
          await this.orAbort(repo, ["merge", "--abort"], () =>
            this.git(repo, ["merge", "--no-edit", action.ref], { env: { ...env, GIT_EDITOR: "true" }, ...slow }),
          );
          return this.moved(repo, h, before, `merge ${action.ref}`);
        }
        case "rebase":
        case "interactive-rebase": {
          await this.checkRef(repo, action.ref);
          await this.notMidOperation(repo);
          const h = await this.sync(repo);
          const before = await this.head(repo);
          const rebaseEnv: Record<string, string> = { ...env, GIT_EDITOR: "true" };
          const args = ["-c", "rebase.missingCommitsCheck=error", "rebase", "--no-autosquash"];
          if (action.op === "interactive-rebase") {
            const plan = parseRebasePlan(await this.git(repo, rebasePlanArgs(action.ref)));
            Object.assign(rebaseEnv, rebaseTodoEnv(action.steps, plan.map((c) => c.hash)));
            args.push("-i");
          }
          args.push(action.ref);
          await this.orAbort(repo, ["rebase", "--abort"], () => this.git(repo, args, { env: rebaseEnv, ...slow }));
          return this.moved(repo, h, before, action.op === "rebase" ? `rebase onto ${action.ref}` : `interactive rebase onto ${action.ref}`);
        }
        case "checkout": {
          const kind = await this.checkRef(repo, action.ref);
          await this.notMidOperation(repo);
          try {
            if (kind === "local") {
              await this.git(repo, ["checkout", action.ref, "--"]);
            } else {
              // A remote branch: check out its local branch, or make one that tracks it.
              const { name } = await this.splitRemoteRef(repo, action.ref);
              if (await this.exists(repo, `refs/heads/${name}`)) await this.git(repo, ["checkout", name, "--"]);
              else await this.git(repo, ["checkout", "-b", await this.newBranchName(repo, name), "--track", action.ref, "--"]);
            }
          } catch (error) {
            throw checkoutBlocked(error, action.ref) ?? error;
          }
          return this.view(await this.sync(repo));
        }
        case "create-branch":
          return this.branchHere(repo, action.name, await this.checkCommit(repo, action.commit));
        case "cherry-pick":
        case "revert": {
          const commit = await this.checkCommit(repo, action.commit);
          await this.notMidOperation(repo);
          const parents = (await this.git(repo, ["rev-list", "--parents", "-n1", commit, "--"])).trim().split(/\s+/).length - 1;
          const h = await this.sync(repo);
          const before = await this.head(repo);
          const args = action.op === "cherry-pick" ? ["cherry-pick"] : ["revert", "--no-edit"];
          // A merge commit is taken relative to its first parent (the branch it was merged into).
          if (parents > 1) args.push("-m", "1");
          args.push(commit);
          await this.orAbort(repo, [action.op, "--abort"], () => this.git(repo, args, { env: { ...env, GIT_EDITOR: "true" }, ...slow }));
          return this.moved(repo, h, before, `${action.op} ${commit.slice(0, 7)}`);
        }
        case "reset": {
          const commit = await this.checkCommit(repo, action.commit);
          await this.notMidOperation(repo);
          const h = await this.sync(repo);
          const before = await this.head(repo);
          await this.git(repo, ["reset", `--${action.mode}`, commit, "--"]);
          return this.moved(repo, h, before, `reset to ${commit.slice(0, 7)}`);
        }
        case "rename-branch": {
          const branch = await this.localBranch(repo, action.branch);
          const name = await this.newBranchName(repo, action.name);
          await this.git(repo, ["branch", "-m", branch, name]);
          return this.view(await this.sync(repo));
        }
        case "delete-branch": {
          if (action.remote) {
            await this.checkRef(repo, action.ref);
            const { remote, name } = await this.splitRemoteRef(repo, action.ref);
            await this.git(repo, ["push", "--delete", remote, `refs/heads/${name}`], slow);
          } else {
            const branch = await this.localBranch(repo, action.ref);
            if ((await this.currentRef(repo)) === branch) throw conflict(`${branch} is checked out. Check out another branch first.`);
            await this.git(repo, ["branch", "-D", branch]);
          }
          return this.view(await this.sync(repo));
        }
        case "stash-save": {
          await this.notMidOperation(repo);
          if (!(await this.git(repo, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw badRequest("There are no changes to stash.");
          const message = action.message?.trim();
          // Stashing makes commits, so it gets the repo's committer.
          await this.git(repo, ["stash", "push", "--include-untracked", ...(message ? ["-m", message] : [])], { env, ...slow });
          return this.view(await this.sync(repo));
        }
        case "stash-apply": {
          const ref = await this.stashRef(repo, action.index, action.stash);
          await this.notMidOperation(repo);
          // On a conflict git leaves the conflicted files for you to resolve, and Pop keeps the stash.
          await this.git(repo, ["stash", action.pop ? "pop" : "apply", ref], { env, ...slow });
          return this.view(await this.sync(repo));
        }
        case "stash-drop": {
          await this.git(repo, ["stash", "drop", await this.stashRef(repo, action.index, action.stash)]);
          return this.view(await this.sync(repo));
        }
        case "stash-rename": {
          await this.stashRef(repo, action.index, action.stash);
          const message = action.message.trim();
          if (!message) throw badRequest("The stash needs a message.");
          // git can't reword a stash: store it again with the new message first, so it's never lost,
          // then drop the old entry (now one further down).
          await this.git(repo, ["stash", "store", "-m", message, action.stash]);
          await this.git(repo, ["stash", "drop", `stash@{${action.index + 1}}`]);
          return this.view(await this.sync(repo));
        }
        case "tag": {
          const commit = await this.checkCommit(repo, action.commit);
          const name = action.name.trim();
          const valid = safeRef(name) && (await this.git(repo, ["check-ref-format", `refs/tags/${name}`]).then(() => true, () => false));
          if (!valid) throw badRequest(`"${name}" isn't a valid tag name.`);
          if (await this.exists(repo, `refs/tags/${name}`)) throw conflict(`A tag named ${name} already exists.`);
          const message = action.message?.trim();
          await this.git(repo, message ? ["tag", "-a", name, "-m", message, commit] : ["tag", name, commit], { env });
          return this.view(await this.sync(repo));
        }
      }
    });
  }
}

/**
 * The env that makes `git rebase -i` use these steps instead of opening an editor: GIT_SEQUENCE_EDITOR
 * writes the todo list (hashes and fixed words only), and each reword's message rides in its own env
 * var, read by an `exec git commit --amend` line, so no message text is ever parsed by a shell.
 * The steps must be exactly the commits git would list (`expected`), each once.
 */
export function rebaseTodoEnv(steps: RebaseStep[], expected: string[]): Record<string, string> {
  const want = new Set(expected);
  const seen = new Set<string>();
  for (const s of steps) {
    if (!SHA.test(s.hash) || !want.has(s.hash) || seen.has(s.hash)) {
      throw conflict("The branch changed since the rebase was planned. Close it and try again.");
    }
    seen.add(s.hash);
  }
  if (seen.size !== want.size) throw conflict("The branch changed since the rebase was planned. Close it and try again.");
  const first = steps.find((s) => s.action !== "drop");
  if (first && (first.action === "squash" || first.action === "fixup")) {
    throw badRequest("The first commit can't be squashed: there's no commit before it to squash into.");
  }
  const env: Record<string, string> = {};
  const lines: string[] = [];
  steps.forEach((s, i) => {
    if (s.action === "reword") {
      const message = (s.message ?? "").trim();
      if (!message) throw badRequest("A reworded commit needs a message.");
      env[`SLAVES_REWORD_${i}`] = message;
      lines.push(`pick ${s.hash}`, `exec git commit --amend --allow-empty --no-verify -q -m "$SLAVES_REWORD_${i}"`);
    } else lines.push(`${s.action} ${s.hash}`);
  });
  // Git runs the editor as `<editor> "$@"` with the todo file's path.
  env.GIT_SEQUENCE_EDITOR = `f() { printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(" ")} > "$1"; }; f`;
  return env;
}

/** File paths from the WIP panel: relative, non-empty, never something git could take for an option. */
function checkPaths(paths: string[]): string[] {
  const list = [...new Set(paths)];
  if (list.length === 0) throw badRequest("No files given.");
  for (const p of list) {
    if (!p || p.includes("\0") || p.startsWith("-") || p.startsWith("/") || /^[a-z]:/i.test(p)) {
      throw badRequest(`Not a file in this repo: ${p}`);
    }
  }
  return list;
}

/** The undo step for one HEAD reflog entry (`before` = where HEAD was), or null to stop there. */
export function fromReflog(entry: ReflogEntry, before: string): Action | null {
  const { subject: s, hash: after } = entry;
  if (s.startsWith(REFLOG_TAG) || !SHA.test(before) || !SHA.test(after)) return null;
  const checkout = /^checkout: moving from (.+) to (.+)$/.exec(s);
  if (checkout) {
    const [, from, to] = checkout as unknown as [string, string, string];
    if (!safeRef(from) || !safeRef(to) || from === to) return null;
    return { kind: "checkout", from, to, label: `checkout ${to.length >= 40 ? to.slice(0, 7) : to}` };
  }
  if (after === before || /rebase/.test(s)) return null;
  const commit = /^commit(?: \(amend\))?: (.*)$/.exec(s);
  if (commit) return { kind: "reset", mode: "soft", before, after, label: `commit "${commit[1]}"` };
  const other = /^(pull|merge [^:]+|merge|reset|cherry-pick|revert|commit \(merge\)|commit \(cherry-pick\))\b/.exec(s);
  if (other) {
    const label = other[1] === "commit (merge)" ? "merge" : other[1]!;
    return { kind: "reset", mode: "keep", before, after, label };
  }
  return null;
}

/**
 * Git refusing a checkout because of the working tree, said plainly: which files are in the way.
 * Null for any other failure.
 */
export function checkoutBlocked(error: unknown, ref: string): Error | null {
  const text = error instanceof CommandError ? error.stderr : error instanceof Error ? error.message : "";
  const blocks = [...text.matchAll(/error: [^\n]*would be (?:overwritten|removed) by checkout[^\n]*\n((?:[ \t]+[^\n]*\n?)+)/g)];
  if (blocks.length === 0) {
    return /resolve your current index first/.test(text) ? conflict(`Can't check out ${ref}: there are unresolved conflicts. Resolve or abort them first.`) : null;
  }
  const files = [...new Set(blocks.flatMap((b) => (b[1] ?? "").split("\n").map((l) => l.trim()).filter(Boolean)))];
  const shown = files.slice(0, 10).join("\n");
  const more = files.length > 10 ? `\n… and ${files.length - 10} more` : "";
  return conflict(`Can't check out ${ref}: your uncommitted changes to these files would be overwritten. Commit, stash or discard them first.\n${shown}${more}`);
}
