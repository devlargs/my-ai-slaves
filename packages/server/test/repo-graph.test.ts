import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { parseStatus, RepoGit } from "../src/services/repo-git";
import { tempDir } from "./helpers";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function commit(repo: string, file: string, message: string) {
  await writeFile(join(repo, file), `${message}\n`);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", message);
}

describe("RepoGit.graph", () => {
  it("lists every branch's commits with parents and refs, read-only", async () => {
    const path = await tempDir();
    sh(path, "init", "-q", "-b", "main");
    sh(path, "config", "user.email", "test@example.com");
    sh(path, "config", "user.name", "Test");
    await commit(path, "a.txt", "init");
    sh(path, "checkout", "-q", "-b", "feature");
    await commit(path, "b.txt", "feature work: a | b, c");
    sh(path, "checkout", "-q", "main");
    await commit(path, "c.txt", "main work");
    sh(path, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    sh(path, "tag", "v1");
    const before = sh(path, "for-each-ref").trim();

    const repo = { path, host: null, defaultBranch: "main" } as unknown as Repo;
    const graph = await new RepoGit().graph(repo, 10);

    expect(graph.head).toBe("main");
    expect(graph.more).toBe(false);
    expect(graph.commits.map((c) => c.subject)).toEqual(["merge feature", "main work", "feature work: a | b, c", "init"]);
    const [merge, , feature, init] = graph.commits;
    expect(merge!.parents).toHaveLength(2);
    expect(merge!.refs).toEqual(["HEAD -> main", "tag: v1"]);
    expect(feature!.refs).toEqual(["feature"]);
    expect(init!.parents).toEqual([]);
    expect(merge!.author).toBeTruthy();
    // Gravatar id: SHA-256 of the trimmed, lowercased email.
    expect(merge!.avatar).toBe(createHash("sha256").update(merge!.email.trim().toLowerCase()).digest("hex"));

    const limited = await new RepoGit().graph(repo, 2);
    expect(limited.commits).toHaveLength(2);
    expect(limited.more).toBe(true);
    // Nothing in the repo changed.
    expect(sh(path, "for-each-ref").trim()).toBe(before);
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("returns an empty graph for a repo without commits", async () => {
    const path = await tempDir();
    sh(path, "init", "-q", "-b", "main");
    const graph = await new RepoGit().graph({ path, host: null } as unknown as Repo, 10);
    expect(graph.commits).toEqual([]);
  });
});

describe("RepoGit branches and commit details", () => {
  it("lists local and remote branches with ahead counts, and shows one commit's files and diff", async () => {
    const origin = await tempDir();
    sh(origin, "init", "-q", "-b", "main");
    sh(origin, "config", "user.email", "test@example.com");
    sh(origin, "config", "user.name", "Test");
    await commit(origin, "a.txt", "init");
    const path = await tempDir();
    sh(path, "clone", "-q", origin, ".");
    sh(path, "config", "user.email", "test@example.com");
    sh(path, "config", "user.name", "Test");
    await commit(path, "b.txt", "local work");
    sh(path, "checkout", "-q", "-b", "fix/thing");
    await writeFile(join(path, "a.txt"), "changed\n");
    sh(path, "mv", "b.txt", "renamed.txt");
    sh(path, "commit", "-q", "-am", "fix: change a\n\nlonger body");
    sh(path, "checkout", "-q", "main");

    const repo = { path, host: null, defaultBranch: "main" } as unknown as Repo;
    const graph = await new RepoGit().graph(repo, 10);
    expect(graph.local.map((b) => b.name)).toEqual(["fix/thing", "main"]);
    const main = graph.local.find((b) => b.name === "main")!;
    expect(main).toMatchObject({ current: true, upstream: "origin/main", ahead: 1, behind: 0 });
    expect(graph.remote.map((b) => [b.remote, b.name, b.ref])).toEqual([["origin", "main", "origin/main"]]);

    const fix = await new RepoGit().commit(repo, graph.local[0]!.commit);
    expect(fix.subject).toBe("fix: change a");
    expect(fix.body).toBe("longer body");
    expect(fix.files).toEqual([
      { status: "M", path: "a.txt", oldPath: null },
      { status: "R", path: "renamed.txt", oldPath: "b.txt" },
    ]);
    expect(fix.patch).toContain("+changed");

    const root = await new RepoGit().commit(repo, graph.commits.at(-1)!.hash.slice(0, 8));
    expect(root.subject).toBe("init");
    expect(root.files).toEqual([{ status: "A", path: "a.txt", oldPath: null }]);
    expect(root.patch.startsWith("diff --git")).toBe(true);

    await expect(new RepoGit().commit(repo, "--output=x")).rejects.toThrow(/Not a commit hash/);
  });
});

describe("RepoGit working changes (the graph's WIP row)", () => {
  it("lists staged, unstaged and untracked files with their diffs, read-only", async () => {
    const path = await tempDir();
    sh(path, "init", "-q", "-b", "main");
    sh(path, "config", "user.email", "test@example.com");
    sh(path, "config", "user.name", "Test");
    await commit(path, "a.txt", "init");
    await commit(path, "b.txt", "second");
    const repo = { path, host: null, defaultBranch: "main" } as unknown as Repo;
    const git = new RepoGit();

    expect((await git.graph(repo, 10)).wip).toBeNull();

    await writeFile(join(path, "a.txt"), "changed\n");
    sh(path, "add", "a.txt");
    await writeFile(join(path, "a.txt"), "changed again\n");
    sh(path, "rm", "-q", "b.txt");
    await mkdir(join(path, "dir"));
    await writeFile(join(path, "dir", "new.txt"), "brand new\n");
    const status = sh(path, "status", "--porcelain");

    const graph = await git.graph(repo, 10);
    expect(graph.wip).toEqual({ files: 3, added: 1, modified: 1, deleted: 1 });

    const wip = await git.workingChanges(repo);
    expect(wip.head).toBe("main");
    expect(wip.staged).toEqual([
      { status: "M", path: "a.txt", oldPath: null },
      { status: "D", path: "b.txt", oldPath: null },
    ]);
    expect(wip.unstaged).toEqual([
      { status: "M", path: "a.txt", oldPath: null },
      { status: "A", path: "dir/new.txt", oldPath: null },
    ]);
    expect(wip.stagedPatch).toContain("+changed\n");
    expect(wip.stagedPatch).toContain("deleted file mode");
    expect(wip.unstagedPatch).toContain("+changed again\n");
    expect(wip.unstagedPatch).toContain("+brand new\n");
    // Nothing in the repo changed.
    expect(sh(path, "status", "--porcelain")).toBe(status);
  });

  it("parses renames and conflicts from git status", () => {
    expect(parseStatus("R  new.txt\0old.txt\0UU both.txt\0?? x\0")).toEqual({
      staged: [{ status: "R", path: "new.txt", oldPath: "old.txt" }],
      unstaged: [
        { status: "M", path: "both.txt", oldPath: null },
        { status: "A", path: "x", oldPath: null },
      ],
    });
  });
});
