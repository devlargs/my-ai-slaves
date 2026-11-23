import type { GitHistory, PullMode, Repo } from "@my-ai-slaves/shared";
import { type GitIdentity, gitIdentityEnv } from "../providers/types";
import { runOn } from "../remote/machine";
import { badRequest, conflict } from "./common";

/**
 * The graph toolbar: Undo, Redo, Pull and Branch. These are the only places the app changes a
 * repo's branches, and only when you click them (tasks never do). Undo/Redo work like GitKraken's:
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

export class RepoActions {
  private readonly histories = new Map<string, History>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly busy: (repoId: string) => boolean = () => false) {}

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
    const prev = this.locks.get(repo.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => {
      if (this.busy(repo.id)) throw conflict("A task is running in this repo. Wait for it to finish first.");
      return work();
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
    return this.exclusive(repo, async () => {
      const h = await this.sync(repo);
      if (mode === "fetch") {
        await this.git(repo, ["fetch", "--all", "--prune"], { timeoutMs: 300_000 });
        return this.view(h);
      }
      if ((await this.exists(repo, "MERGE_HEAD")) || (await this.exists(repo, "REBASE_HEAD"))) {
        throw conflict("A merge or rebase is in progress in this repo. Finish or abort it first.");
      }
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
    });
  }

  /** A new branch at HEAD, checked out (like `git checkout -b`). */
  createBranch(repo: Repo, name: string): Promise<GitHistory> {
    return this.exclusive(repo, async () => {
      const clean = name.trim();
      const valid =
        safeRef(clean) && (await this.git(repo, ["check-ref-format", "--branch", clean]).then(() => true, () => false));
      if (!valid) throw badRequest(`"${clean}" isn't a valid branch name.`);
      if (await this.exists(repo, `refs/heads/${clean}`)) throw conflict(`A branch named ${clean} already exists.`);
      const h = await this.sync(repo);
      const from = await this.currentRef(repo);
      const commit = await this.head(repo);
      await this.git(repo, ["checkout", "-b", clean, "--"]);
      h.undo.push({ kind: "branch", name: clean, commit, from, label: `create branch ${clean}` });
      h.redo = [];
      h.marker = await this.marker(repo);
      return this.view(h);
    });
  }
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
