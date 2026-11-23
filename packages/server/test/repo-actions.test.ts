import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { RepoActions } from "../src/services/repo-actions";
import { tempDir } from "./helpers";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function commit(repo: string, file: string, message: string) {
  await writeFile(join(repo, file), `${message}\n`);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", message);
}

async function newRepo(): Promise<{ path: string; repo: Repo }> {
  const path = await tempDir();
  sh(path, "init", "-q", "-b", "main");
  sh(path, "config", "user.email", "test@example.com");
  sh(path, "config", "user.name", "Test");
  await commit(path, "a.txt", "init");
  return { path, repo: { id: "r", path, host: null, defaultBranch: "main" } as unknown as Repo };
}

describe("RepoActions", () => {
  it("undoes and redoes the last commit (soft: its changes stay staged)", async () => {
    const { path, repo } = await newRepo();
    const first = sh(path, "rev-parse", "HEAD");
    await commit(path, "b.txt", "add b");
    const second = sh(path, "rev-parse", "HEAD");
    const actions = new RepoActions();

    expect(await actions.history(repo)).toEqual({ undo: 'commit "add b"', redo: null });
    expect(await actions.undo(repo)).toEqual({ undo: null, redo: 'commit "add b"' });
    expect(sh(path, "rev-parse", "HEAD")).toBe(first);
    expect(sh(path, "diff", "--cached", "--name-only")).toBe("b.txt");

    expect(await actions.redo(repo)).toEqual({ undo: 'commit "add b"', redo: null });
    expect(sh(path, "rev-parse", "HEAD")).toBe(second);
    expect(sh(path, "status", "--porcelain")).toBe("");
  });

  it("undoes checkouts step by step and drops redo when the repo moves on its own", async () => {
    const { path, repo } = await newRepo();
    sh(path, "branch", "feature");
    sh(path, "checkout", "-q", "feature");
    await commit(path, "f.txt", "feature work");
    const actions = new RepoActions();

    expect((await actions.history(repo)).undo).toBe('commit "feature work"');
    await actions.undo(repo);
    const h = await actions.undo(repo);
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(h.redo).toBe("checkout feature");

    // Something outside the app: redo is gone, the new action is undoable.
    sh(path, "checkout", "-q", "feature");
    expect(await actions.history(repo)).toEqual({ undo: "checkout feature", redo: null });
  });

  it("creates a branch at HEAD and undoes it (back to main, branch deleted)", async () => {
    const { path, repo } = await newRepo();
    const actions = new RepoActions();
    await expect(actions.createBranch(repo, "bad name..")).rejects.toThrow(/valid branch name/);
    await expect(actions.createBranch(repo, "-x")).rejects.toThrow(/valid branch name/);

    expect((await actions.createBranch(repo, "feat/new")).undo).toBe("create branch feat/new");
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/new");
    await expect(actions.createBranch(repo, "feat/new")).rejects.toThrow(/already exists/);

    await actions.undo(repo);
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(sh(path, "branch", "--list", "feat/new")).toBe("");

    expect((await actions.redo(repo)).undo).toBe("create branch feat/new");
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/new");
  });

  it("pulls (fast-forward only), undoes the pull and fetches", async () => {
    const { path: upstream } = await newRepo();
    const clonePath = await tempDir();
    execFileSync("git", ["clone", "-q", upstream, clonePath]);
    sh(clonePath, "config", "user.email", "test@example.com");
    sh(clonePath, "config", "user.name", "Test");
    const repo = { id: "c", path: clonePath, host: null, defaultBranch: "main" } as unknown as Repo;
    const before = sh(clonePath, "rev-parse", "HEAD");
    await commit(upstream, "u.txt", "upstream work");
    const actions = new RepoActions();

    await actions.pull(repo, "fetch", null);
    expect(sh(clonePath, "rev-parse", "HEAD")).toBe(before);
    expect(sh(clonePath, "rev-parse", "origin/main")).toBe(sh(upstream, "rev-parse", "HEAD"));

    expect((await actions.pull(repo, "pull-ff-only", null)).undo).toBe("pull");
    expect(await readFile(join(clonePath, "u.txt"), "utf8")).toBe("upstream work\n");
    await actions.undo(repo);
    expect(sh(clonePath, "rev-parse", "HEAD")).toBe(before);
    expect(sh(clonePath, "status", "--porcelain")).toBe("");
  });

  it("aborts a pull that conflicts, leaving the repo as it was", async () => {
    const { path: upstream } = await newRepo();
    const clonePath = await tempDir();
    execFileSync("git", ["clone", "-q", upstream, clonePath]);
    await commit(upstream, "a.txt", "theirs");
    const repo = { id: "c", path: clonePath, host: null, defaultBranch: "main" } as unknown as Repo;
    sh(clonePath, "config", "user.email", "test@example.com");
    sh(clonePath, "config", "user.name", "Test");
    await commit(clonePath, "a.txt", "ours");
    const head = sh(clonePath, "rev-parse", "HEAD");

    await expect(new RepoActions().pull(repo, "pull-ff", null)).rejects.toThrow();
    expect(sh(clonePath, "rev-parse", "HEAD")).toBe(head);
    expect(sh(clonePath, "status", "--porcelain")).toBe("");
  });

  it("refuses while a task is running in the repo", async () => {
    const { repo } = await newRepo();
    const actions = new RepoActions(() => true);
    await expect(actions.undo(repo)).rejects.toThrow(/task is running/);
  });

  it("stages and unstages single files, everything, deletions and odd names", async () => {
    const { path, repo } = await newRepo();
    await writeFile(join(path, "a.txt"), "changed\n");
    await writeFile(join(path, "new *.txt"), "new\n");
    await writeFile(join(path, "other.txt"), "other\n");
    const actions = new RepoActions();
    const staged = () => sh(path, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

    await actions.stage(repo, ["new *.txt"]);
    expect(staged()).toEqual(["new *.txt"]);
    await actions.stage(repo, null);
    expect(staged()).toEqual(["a.txt", "new *.txt", "other.txt"]);
    await actions.unstage(repo, ["a.txt"]);
    expect(staged()).toEqual(["new *.txt", "other.txt"]);
    expect(sh(path, "diff", "--name-only")).toBe("a.txt");
    await actions.unstage(repo, null);
    expect(staged()).toEqual([]);

    sh(path, "rm", "-q", "--cached", "a.txt");
    await actions.unstage(repo, ["a.txt"]);
    await rm(join(path, "a.txt"));
    await actions.stage(repo, ["a.txt"]);
    expect(sh(path, "diff", "--cached", "--name-status")).toBe("D\ta.txt");

    await expect(actions.stage(repo, ["--all"])).rejects.toThrow(/Not a file/);
    await expect(actions.stage(repo, [])).rejects.toThrow(/No files/);
  });

  it("unstages in a repo with no commits yet", async () => {
    const path = await tempDir();
    sh(path, "init", "-q", "-b", "main");
    const repo = { id: "r", path, host: null, defaultBranch: "main" } as unknown as Repo;
    await writeFile(join(path, "x.txt"), "x\n");
    await writeFile(join(path, "y.txt"), "y\n");
    const actions = new RepoActions();
    await actions.stage(repo, null);
    await actions.unstage(repo, ["x.txt"]);
    expect(sh(path, "diff", "--cached", "--name-only")).toBe("y.txt");
    await actions.unstage(repo, null);
    expect(sh(path, "status", "--porcelain")).toBe("?? x.txt\n?? y.txt");
  });

  it("commits only what's staged, as the repo's committer, amends, and undo takes it back", async () => {
    const { path, repo } = await newRepo();
    await writeFile(join(path, "b.txt"), "b\n");
    await writeFile(join(path, "c.txt"), "c\n");
    const actions = new RepoActions();
    const who = { name: "Committer", email: "committer@example.com" };

    await expect(actions.commit(repo, { summary: "nothing" }, who)).rejects.toThrow(/Nothing is staged/);
    await actions.stage(repo, ["b.txt"]);
    await expect(actions.commit(repo, { summary: "  " }, who)).rejects.toThrow(/summary/);

    const h = await actions.commit(repo, { summary: "add b", description: "Why b.\n\n#1 too" }, who);
    expect(h).toEqual({ undo: 'commit "add b"', redo: null });
    expect(sh(path, "log", "-1", "--format=%s|%b|%an <%ae>|%cn")).toBe("add b|Why b.\n\n#1 too\n|Committer <committer@example.com>|Committer");
    expect(sh(path, "show", "--name-only", "--format=", "HEAD")).toBe("b.txt");
    expect(sh(path, "status", "--porcelain")).toBe("?? c.txt");

    await actions.stage(repo, ["c.txt"]);
    await actions.commit(repo, { summary: "add b and c", amend: true }, who);
    expect(sh(path, "rev-list", "--count", "HEAD")).toBe("2");
    expect(sh(path, "log", "-1", "--format=%s")).toBe("add b and c");
    expect(sh(path, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["b.txt", "c.txt"]);

    await actions.undo(repo);
    expect(sh(path, "log", "-1", "--format=%s")).toBe("add b");
  });

  it("runs commit hooks unless skipped, and reports a failing hook", async () => {
    const { path, repo } = await newRepo();
    await writeFile(join(path, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", { mode: 0o755 });
    await writeFile(join(path, "b.txt"), "b\n");
    const actions = new RepoActions();
    await actions.stage(repo, null);
    if (process.platform !== "win32") {
      await expect(actions.commit(repo, { summary: "add b" }, null)).rejects.toThrow(/lint failed/);
    }
    await actions.commit(repo, { summary: "add b", noVerify: true }, null);
    expect(sh(path, "log", "-1", "--format=%s")).toBe("add b");
  });

  it("refuses to stage or commit while a task runs in the repo", async () => {
    const { path, repo } = await newRepo();
    await writeFile(join(path, "b.txt"), "b\n");
    const actions = new RepoActions(() => true);
    await expect(actions.stage(repo, null)).rejects.toThrow(/task is running/);
    await expect(actions.commit(repo, { summary: "x" }, null)).rejects.toThrow(/task is running/);
  });
});
