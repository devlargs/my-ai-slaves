import { access, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type FsBrowseResponse,
  formatLocalIso,
  type Knowledge,
  type Repo,
  type UpdateRepoRequest,
} from "@my-ai-slaves/shared";
import type { DataStores } from "../storage/data-stores";
import { badRequest, conflict, notFound, slugify } from "./common";
import { git, gitOk } from "./git";

const exists = (p: string) => access(p).then(() => true, () => false);

export class RepoService {
  constructor(
    private readonly stores: DataStores,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<Repo[]> {
    return (await this.stores.repos.read()).repos;
  }

  async get(id: string): Promise<Repo> {
    const repo = (await this.list()).find((r) => r.id === id);
    if (!repo) throw notFound(`No repo "${id}".`);
    return repo;
  }

  async register(inputPath: string): Promise<Repo> {
    const trimmed = inputPath.trim().replace(/^~(?=$|\/)/, homedir());
    if (!isAbsolute(trimmed)) throw badRequest("Paste an absolute path (e.g. /Users/you/code/my-repo).");
    let path: string;
    try {
      path = await realpath(trimmed);
      if (!(await stat(path)).isDirectory()) throw new Error();
    } catch {
      throw badRequest(`Folder not found: ${trimmed}`);
    }

    let top: string;
    try {
      top = (await git(["rev-parse", "--show-toplevel"], path)).trim();
    } catch {
      throw badRequest(`Not a git repository: ${path}`);
    }
    top = await realpath(top);

    const repos = await this.list();
    const existing = repos.find((r) => r.path === top);
    if (existing) throw conflict(`Already registered as "${existing.id}".`);

    const base = slugify(basename(top), 60) || "repo";
    let id = base;
    for (let n = 2; repos.some((r) => r.id === id); n++) id = `${base}-${n}`;

    const stamp = formatLocalIso(this.now());
    const repo: Repo = {
      id,
      name: basename(top),
      path: top,
      defaultBranch: await this.detectDefaultBranch(top),
      accountChain: (await this.stores.accounts.read()).accounts.map((a) => a.id),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.stores.repos.update((file) => {
      file.repos.push(repo);
    });
    await this.stores.knowledge(id).load(); // blank knowledge file
    return repo;
  }

  private async detectDefaultBranch(path: string): Promise<string> {
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)).trim();
      if (ref) return ref.replace(/^origin\//, "");
    } catch {
      // no origin HEAD
    }
    for (const candidate of ["main", "master"]) {
      if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], path)) return candidate;
    }
    try {
      const current = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path)).trim();
      if (current && current !== "HEAD") return current;
    } catch {
      // empty repo
    }
    return "main";
  }

  async update(id: string, patch: UpdateRepoRequest): Promise<Repo> {
    const repo = await this.get(id);
    if (patch.accountChain) {
      const known = new Set((await this.stores.accounts.read()).accounts.map((a) => a.id));
      const unknown = patch.accountChain.filter((a) => !known.has(a));
      if (unknown.length) throw badRequest(`Unknown accounts: ${unknown.join(", ")}`);
    }
    if (patch.defaultBranch !== undefined) {
      const ok = await gitOk(["rev-parse", "--verify", "--quiet", `${patch.defaultBranch}^{commit}`], repo.path);
      if (!ok) throw badRequest(`Branch "${patch.defaultBranch}" not found in ${repo.path}.`);
    }
    let updated: Repo | undefined;
    await this.stores.repos.update((file) => {
      updated = file.repos.find((r) => r.id === id);
      if (!updated) throw notFound(`No repo "${id}".`);
      if (patch.name !== undefined) updated.name = patch.name.trim() || updated.name;
      if (patch.defaultBranch !== undefined) updated.defaultBranch = patch.defaultBranch;
      if (patch.accountChain !== undefined) updated.accountChain = [...new Set(patch.accountChain)];
      updated.updatedAt = formatLocalIso(this.now());
    });
    return updated as Repo;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    const tasks = (await this.stores.queue.read()).tasks.filter((t) => t.repo === id);
    if (tasks.length) throw conflict(`"${id}" still has ${tasks.length} task(s) in the queue. Finish or discard them first.`);
    await this.stores.repos.update((file) => {
      file.repos = file.repos.filter((r) => r.id !== id);
    });
    await rm(join(this.stores.paths.knowledgeDir, `${id}.json`), { force: true });
  }

  // ── knowledge ────────────────────────────────────────────────────────────
  async getKnowledge(id: string): Promise<Knowledge> {
    await this.get(id);
    return this.stores.knowledge(id).read();
  }

  async setKnowledge(id: string, basePrompt: string): Promise<Knowledge> {
    await this.get(id);
    return this.stores.knowledge(id).update((k) => {
      k.basePrompt = basePrompt;
      k.updatedAt = formatLocalIso(this.now());
    });
  }

  /** Repo base prompt for the PromptAssembler ("" for unknown repos). */
  async basePromptOf(id: string): Promise<string> {
    if (!(await this.list()).some((r) => r.id === id)) return "";
    return (await this.stores.knowledge(id).read()).basePrompt;
  }

  // ── folder browser ───────────────────────────────────────────────────────
  async browse(inputPath?: string): Promise<FsBrowseResponse> {
    const path = resolve(inputPath?.trim() || homedir());
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      throw badRequest(`Can't open ${path}`);
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return {
      path,
      parent: path === "/" ? null : dirname(path),
      isGitRepo: await exists(join(path, ".git")),
      dirs: await Promise.all(
        dirs.map(async (name) => ({ name, path: join(path, name), isGitRepo: await exists(join(path, name, ".git")) })),
      ),
    };
  }
}
