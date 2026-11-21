import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { RepoGit } from "../src/services/repo-git";
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
