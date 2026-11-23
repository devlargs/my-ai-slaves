import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { RepoActions } from "../src/services/repo-actions";
import { RepoGit } from "../src/services/repo-git";
import { tempDir } from "./helpers";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const identity = { name: "Tester", email: "tester@example.com" };

async function commit(repo: string, file: string, message: string, content = `${message}\n`) {
  await writeFile(join(repo, file), content);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", message);
  return sh(repo, "rev-parse", "HEAD");
}

async function newRepo(path?: string): Promise<{ path: string; repo: Repo }> {
  const dir = path ?? (await tempDir());
  if (!path) {
    sh(dir, "init", "-q", "-b", "main");
    await commit2(dir, "a.txt", "init");
  }
  return { path: dir, repo: { id: "r", path: dir, host: null, defaultBranch: "main" } as unknown as Repo };
}
async function commit2(dir: string, file: string, message: string) {
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  return commit(dir, file, message);
}

/** A repo with a `feature` branch two commits ahead of main, and main one commit ahead of where it forked. */
async function forked() {
  const r = await newRepo();
  sh(r.path, "checkout", "-q", "-b", "feature");
  const f1 = await commit(r.path, "f1.txt", "feature one");
  const f2 = await commit(r.path, "f2.txt", "feature two");
  sh(r.path, "checkout", "-q", "main");
  const m1 = await commit(r.path, "m.txt", "main work");
  return { ...r, f1, f2, m1 };
}

const subjects = (path: string, range: string) => sh(path, "log", "--format=%s", range).split("\n").filter(Boolean);

describe("RepoActions.refAction (the graph's right-click menu)", () => {
  it("merges a branch into the checked-out one, and undoes the merge", async () => {
    const { path, repo, m1 } = await forked();
    const actions = new RepoActions();
    const h = await actions.refAction(repo, { op: "merge", ref: "feature" }, identity);
    expect(h.undo).toBe("merge feature");
    expect(sh(path, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(sh(path, "log", "-1", "--format=%cn")).toBe("Tester");
    await actions.undo(repo);
    expect(sh(path, "rev-parse", "HEAD")).toBe(m1);
  });

  it("aborts a merge that conflicts, leaving the repo as it was", async () => {
    const { path, repo } = await newRepo();
    sh(path, "checkout", "-q", "-b", "other");
    await commit(path, "a.txt", "theirs");
    sh(path, "checkout", "-q", "main");
    const head = await commit(path, "a.txt", "ours");
    await expect(new RepoActions().refAction(repo, { op: "merge", ref: "other" }, identity)).rejects.toThrow();
    expect(sh(path, "rev-parse", "HEAD")).toBe(head);
    expect(sh(path, "status", "--porcelain")).toBe("");
  });

  it("rebases the checked-out branch onto another", async () => {
    const { path, repo, m1 } = await forked();
    sh(path, "checkout", "-q", "feature");
    const h = await new RepoActions().refAction(repo, { op: "rebase", ref: "main" }, identity);
    expect(h.undo).toBe("rebase onto main");
    expect(sh(path, "rev-parse", "HEAD~2")).toBe(m1);
    expect(subjects(path, "main..HEAD")).toEqual(["feature two", "feature one"]);
  });

  it("interactive rebase: reorders, rewords (any text), squashes and drops", async () => {
    const { path, repo, m1 } = await forked();
    sh(path, "checkout", "-q", "feature");
    const f3 = await commit(path, "f3.txt", "feature three");
    const plan = await new RepoGit().rebasePlan(repo, "main");
    expect(plan.commits.map((c) => c.subject)).toEqual(["feature one", "feature two", "feature three"]);
    const [f1, f2] = plan.commits.map((c) => c.hash) as [string, string, string];
    const message = `it's "quoted" $HOME \`x\` 100%\n\nbody line`;
    await new RepoActions().refAction(
      repo,
      {
        op: "interactive-rebase",
        ref: "main",
        steps: [
          { hash: f3, action: "reword", message },
          { hash: f1, action: "fixup" },
          { hash: f2, action: "drop" },
        ],
      },
      identity,
    );
    expect(sh(path, "rev-parse", "HEAD~1")).toBe(m1);
    expect(sh(path, "log", "-1", "--format=%B")).toBe(message);
    expect(sh(path, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["f1.txt", "f3.txt"]);
  });

  it("interactive rebase refuses steps that don't match the branch", async () => {
    const { path, repo, f1 } = await forked();
    sh(path, "checkout", "-q", "feature");
    const head = sh(path, "rev-parse", "HEAD");
    await expect(
      new RepoActions().refAction(repo, { op: "interactive-rebase", ref: "main", steps: [{ hash: f1, action: "pick" }] }, identity),
    ).rejects.toThrow(/changed since/);
    expect(sh(path, "rev-parse", "HEAD")).toBe(head);
  });

  it("checks out, creates a branch at a commit, renames and deletes branches", async () => {
    const { path, repo, f1 } = await forked();
    const actions = new RepoActions();
    await actions.refAction(repo, { op: "checkout", ref: "feature" }, identity);
    expect(sh(path, "branch", "--show-current")).toBe("feature");
    await actions.refAction(repo, { op: "create-branch", name: "at-f1", commit: f1 }, identity);
    expect(sh(path, "branch", "--show-current")).toBe("at-f1");
    expect(sh(path, "rev-parse", "HEAD")).toBe(f1);
    await expect(actions.refAction(repo, { op: "delete-branch", ref: "at-f1" }, identity)).rejects.toThrow(/checked out/);
    await actions.refAction(repo, { op: "rename-branch", branch: "feature", name: "feat/renamed" }, identity);
    expect(sh(path, "branch", "--list", "feat/renamed")).toContain("feat/renamed");
    await actions.refAction(repo, { op: "delete-branch", ref: "feat/renamed" }, identity);
    expect(sh(path, "branch", "--list", "feat/renamed")).toBe("");
    await expect(actions.refAction(repo, { op: "checkout", ref: "--orphan" }, identity)).rejects.toThrow();
  });

  it("cherry-picks, reverts, resets and tags", async () => {
    const { path, repo, f1, m1 } = await forked();
    const actions = new RepoActions();
    await actions.refAction(repo, { op: "cherry-pick", commit: f1 }, identity);
    expect(subjects(path, "-1")).toEqual(["feature one"]);
    expect(await readFile(join(path, "f1.txt"), "utf8")).toBe("feature one\n");
    await actions.refAction(repo, { op: "revert", commit: sh(path, "rev-parse", "HEAD") }, identity);
    expect(subjects(path, "-1")[0]).toMatch(/^Revert "feature one"/);
    await actions.refAction(repo, { op: "reset", commit: m1, mode: "hard" }, identity);
    expect(sh(path, "rev-parse", "HEAD")).toBe(m1);
    await actions.refAction(repo, { op: "tag", name: "v1", commit: m1 }, identity);
    await actions.refAction(repo, { op: "tag", name: "v1-notes", commit: f1, message: "Release notes" }, identity);
    expect(sh(path, "rev-parse", "v1^{commit}")).toBe(m1);
    expect(sh(path, "cat-file", "-t", "v1-notes")).toBe("tag");
    expect(sh(path, "tag", "-l", "--format=%(contents:subject)", "v1-notes")).toBe("Release notes");
    await expect(actions.refAction(repo, { op: "tag", name: "v1", commit: m1 }, identity)).rejects.toThrow(/already exists/);
  });

  it("pushes, sets upstreams, pulls a branch that isn't checked out, and works with remote branches", async () => {
    const remote = await tempDir();
    sh(remote, "init", "-q", "--bare", "-b", "main");
    const { path, repo } = await newRepo();
    sh(path, "remote", "add", "origin", remote);
    const actions = new RepoActions();

    // No upstream yet: pushed to origin and tracked.
    await actions.refAction(repo, { op: "push", branch: "main" }, identity);
    expect(sh(path, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");

    // Set upstream to a branch that isn't on the remote yet: pushed there.
    sh(path, "branch", "topic");
    await actions.refAction(repo, { op: "set-upstream", branch: "topic", upstream: "origin/topic-remote" }, identity);
    expect(sh(remote, "rev-parse", "topic-remote")).toBe(sh(path, "rev-parse", "topic"));
    expect(sh(path, "rev-parse", "--abbrev-ref", "topic@{upstream}")).toBe("origin/topic-remote");

    // Someone else pushes to topic-remote; pull it into topic without checking it out.
    const other = await tempDir();
    execFileSync("git", ["clone", "-q", "-b", "topic-remote", remote, other]);
    const theirs = await commit2(other, "t.txt", "their topic work");
    sh(other, "push", "-q", "origin", "topic-remote");
    await actions.refAction(repo, { op: "pull", branch: "topic" }, identity);
    expect(sh(path, "rev-parse", "topic")).toBe(theirs);
    expect(sh(path, "branch", "--show-current")).toBe("main");

    // Check out a remote-only branch: a local tracking branch is made.
    sh(other, "push", "-q", "origin", "topic-remote:only-remote");
    sh(path, "fetch", "-q", "origin");
    await actions.refAction(repo, { op: "checkout", ref: "origin/only-remote" }, identity);
    expect(sh(path, "branch", "--show-current")).toBe("only-remote");
    expect(sh(path, "rev-parse", "--abbrev-ref", "only-remote@{upstream}")).toBe("origin/only-remote");

    // Delete a branch on the remote.
    await actions.refAction(repo, { op: "delete-branch", ref: "origin/only-remote", remote: true }, identity);
    expect(sh(remote, "branch", "--list", "only-remote")).toBe("");
  });

  it("compares a commit with the working directory", async () => {
    const { path, repo, m1 } = await forked();
    await writeFile(join(path, "a.txt"), "changed\n");
    const result = await new RepoGit().compare(repo, sh(path, "rev-parse", "HEAD~1"));
    expect(result.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A m.txt", "M a.txt"]);
    expect(result.patch).toContain("+changed");
    expect(m1).toBeTruthy();
  });

  it("refuses while a task is running in the repo", async () => {
    const { repo, m1 } = await forked();
    const actions = new RepoActions(() => true);
    await expect(actions.refAction(repo, { op: "reset", commit: m1, mode: "soft" }, identity)).rejects.toThrow(/task is running/);
  });
});
