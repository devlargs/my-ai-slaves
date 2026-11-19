import { access, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import {
  type FsBrowseResponse,
  formatLocalIso,
  type Repo,
  type RepoAvailability,
  type RepoView,
  type UpdateRepoRequest,
} from "@my-ai-slaves/shared";
import { assertHost, failureReason, runOn, scriptOn, shq } from "../remote/machine";
import type { DataStores } from "../storage/data-stores";
import { badRequest, conflict, notFound, slugify } from "./common";
import { RepoPromptList } from "./prompt-library";

const exists = (p: string) => access(p).then(() => true, () => false);

const AVAILABILITY_TTL_MS = 60_000;

/** Repositories on this Mac or on an SSH host (like VS Code Remote Explorer). */
export class RepoService {
  /** Last reachability check per repo id. Kept in memory; refreshed in the background. */
  private readonly availability = new Map<string, RepoAvailability>();
  private readonly checking = new Map<string, Promise<RepoAvailability>>();
  private onAvailabilityChange: (() => void) | null = null;

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

  /**
   * The other repos of a cross-repo task: registered, not the main one, and on the same machine
   * (one CLI run reaches them all). Returned in the order given, duplicates dropped.
   */
  async extras(main: Repo, ids: string[] | undefined): Promise<Repo[]> {
    const wanted = [...new Set(ids ?? [])].filter((id) => id !== main.id);
    const extras: Repo[] = [];
    for (const id of wanted) {
      const repo = await this.get(id);
      if ((repo.host ?? null) !== (main.host ?? null)) {
        const where = (r: Repo) => (r.host ? `on ${r.host}` : "on this Mac");
        throw badRequest(`${repo.name} is ${where(repo)} but ${main.name} is ${where(main)}. A task's repos must be on the same machine.`);
      }
      extras.push(repo);
    }
    return extras;
  }

  /** Repos with their last known reachability; stale ones are re-checked in the background. */
  async listViews(): Promise<RepoView[]> {
    const repos = await this.list();
    for (const repo of repos) {
      const known = this.availability.get(repo.id);
      const stale = !known?.checkedAt || this.now().getTime() - new Date(known.checkedAt).getTime() > AVAILABILITY_TTL_MS;
      if (stale) void this.checkAvailability(repo);
    }
    return repos.map((r) => this.toView(r));
  }

  toView(repo: Repo): RepoView {
    return { ...repo, availability: this.availability.get(repo.id) ?? { state: "checking", message: null, checkedAt: null } };
  }

  availabilityOf(id: string): RepoAvailability | null {
    return this.availability.get(id) ?? null;
  }

  /** Called whenever a repo flips between reachable and unreachable (to wake the queue). */
  onChange(listener: () => void): void {
    this.onAvailabilityChange = listener;
  }

  /** Can we reach the repo right now? (SSH up, folder there, still a git repo.) */
  checkAvailability(repo: Repo): Promise<RepoAvailability> {
    const running = this.checking.get(repo.id);
    if (running) return running;
    const check = (async (): Promise<RepoAvailability> => {
      const before = this.availability.get(repo.id)?.state;
      let result: RepoAvailability;
      try {
        await runOn(repo.host, "git", ["rev-parse", "--git-dir"], repo.path, { timeoutMs: 20_000 });
        result = { state: "ok", message: null, checkedAt: formatLocalIso(this.now()) };
      } catch (error) {
        result = { state: "unreachable", message: failureReason(error), checkedAt: formatLocalIso(this.now()) };
      }
      this.availability.set(repo.id, result);
      if (before !== result.state && before !== undefined) this.onAvailabilityChange?.();
      return result;
    })().finally(() => this.checking.delete(repo.id));
    this.checking.set(repo.id, check);
    return check;
  }

  /** Something failed while using the repo (e.g. ssh dropped): show it as unreachable right away. */
  markUnreachable(repo: Repo, error: unknown): void {
    this.availability.set(repo.id, { state: "unreachable", message: failureReason(error), checkedAt: formatLocalIso(this.now()) });
  }

  async checkAll(): Promise<void> {
    await Promise.all((await this.list()).map((r) => this.checkAvailability(r)));
  }

  async register(inputPath: string, host: string | null = null): Promise<RepoView> {
    const { top, name } = host ? await this.resolveRemote(host, inputPath) : await this.resolveLocal(inputPath);

    const repos = await this.list();
    const existing = repos.find((r) => r.path === top && (r.host ?? null) === host);
    if (existing) throw conflict(`Already registered as "${existing.id}".`);

    const base = slugify(name, 60) || "repo";
    let id = base;
    for (let n = 2; repos.some((r) => r.id === id); n++) id = `${base}-${n}`;

    const stamp = formatLocalIso(this.now());
    const repo: Repo = {
      id,
      name,
      host,
      path: top,
      defaultBranch: await this.detectDefaultBranch(host, top),
      // Pre-fill with the accounts that run on the same machine as the repo.
      accountChain: (await this.stores.accounts.read()).accounts.filter((a) => (a.host ?? null) === host).map((a) => a.id),
      committerName: null,
      committerEmail: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.stores.repos.update((file) => {
      file.repos.push(repo);
    });
    await this.stores.knowledge(id).load(); // blank knowledge file
    this.availability.set(id, { state: "ok", message: null, checkedAt: stamp });
    return this.toView(repo);
  }

  private async resolveLocal(inputPath: string): Promise<{ top: string; name: string }> {
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
      top = (await runOn(null, "git", ["rev-parse", "--show-toplevel"], path)).stdout.trim();
    } catch {
      throw badRequest(`Not a git repository: ${path}`);
    }
    top = await realpath(top);
    return { top, name: basename(top) };
  }

  private async resolveRemote(host: string, inputPath: string): Promise<{ top: string; name: string }> {
    try {
      assertHost(host);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const path = inputPath.trim();
    if (!path.startsWith("/") && !path.startsWith("~")) {
      throw badRequest("Paste an absolute path on the server (e.g. /home/you/projects/my-repo or ~/projects/my-repo).");
    }
    let top: string;
    try {
      top = (await runOn(host, "git", ["rev-parse", "--show-toplevel"], path, { timeoutMs: 30_000 })).stdout.trim();
    } catch (error) {
      const reason = failureReason(error);
      if (/ssh|connect|resolve|permission denied \(publickey|timed out|host key/i.test(reason)) {
        throw badRequest(`Unable to reach ${host}: ${reason}`);
      }
      throw badRequest(`Not a git repository on ${host}: ${path} (${reason})`);
    }
    return { top, name: posix.basename(top) };
  }

  private async detectDefaultBranch(host: string | null, path: string): Promise<string> {
    const git = async (args: string[]) => (await runOn(host, "git", args, path, { timeoutMs: 30_000 })).stdout.trim();
    try {
      const ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (ref) return ref.replace(/^origin\//, "");
    } catch {
      // no origin HEAD
    }
    for (const candidate of ["main", "master"]) {
      try {
        await git(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
        return candidate;
      } catch {
        // not this one
      }
    }
    try {
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current && current !== "HEAD") return current;
    } catch {
      // empty repo
    }
    return "main";
  }

  async update(id: string, patch: UpdateRepoRequest): Promise<Repo> {
    const repo = await this.get(id);
    if (patch.accountChain) {
      const accounts = (await this.stores.accounts.read()).accounts;
      const unknown = patch.accountChain.filter((a) => !accounts.some((x) => x.id === a));
      if (unknown.length) throw badRequest(`Unknown accounts: ${unknown.join(", ")}`);
      const elsewhere = patch.accountChain.filter((a) => (accounts.find((x) => x.id === a)?.host ?? null) !== (repo.host ?? null));
      if (elsewhere.length) {
        throw badRequest(
          `${elsewhere.join(", ")} run${elsewhere.length === 1 ? "s" : ""} on a different machine than ${repo.name} (${repo.host ?? "this Mac"}).`,
        );
      }
    }
    const email = patch.committerEmail?.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest(`"${email}" isn't a valid email address.`);
    if (patch.defaultBranch !== undefined) {
      try {
        await runOn(repo.host, "git", ["rev-parse", "--verify", "--quiet", `${patch.defaultBranch}^{commit}`], repo.path);
      } catch {
        throw badRequest(`Branch "${patch.defaultBranch}" not found in ${repo.path}.`);
      }
    }
    let updated: Repo | undefined;
    await this.stores.repos.update((file) => {
      updated = file.repos.find((r) => r.id === id);
      if (!updated) throw notFound(`No repo "${id}".`);
      if (patch.name !== undefined) updated.name = patch.name.trim() || updated.name;
      if (patch.defaultBranch !== undefined) updated.defaultBranch = patch.defaultBranch;
      if (patch.accountChain !== undefined) updated.accountChain = [...new Set(patch.accountChain)];
      if (patch.committerName !== undefined) updated.committerName = patch.committerName.trim() || null;
      if (patch.committerEmail !== undefined) updated.committerEmail = patch.committerEmail.trim() || null;
      updated.updatedAt = formatLocalIso(this.now());
    });
    return updated as Repo;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    const tasks = (await this.stores.queue.read()).tasks.filter((t) => t.repo === id || t.extraRepos.some((x) => x.repo === id));
    if (tasks.length) throw conflict(`"${id}" still has ${tasks.length} task(s) in the queue. Finish or discard them first.`);
    await this.stores.repos.update((file) => {
      file.repos = file.repos.filter((r) => r.id !== id);
    });
    this.availability.delete(id);
    await rm(join(this.stores.paths.knowledgeDir, `${id}.json`), { force: true });
  }

  // ── knowledge ────────────────────────────────────────────────────────────
  /** This repo's prompts (you tick which ones each task sends). */
  async prompts(id: string): Promise<RepoPromptList> {
    await this.get(id);
    return new RepoPromptList(this.stores, id, this.now);
  }

  // ── folder browser ───────────────────────────────────────────────────────
  async browse(inputPath?: string, host: string | null = null): Promise<FsBrowseResponse> {
    return host ? this.browseRemote(host, inputPath) : this.browseLocal(inputPath);
  }

  private async browseLocal(inputPath?: string): Promise<FsBrowseResponse> {
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

  /** One ssh round trip: resolve the folder, list its sub-folders and which of them are git repos. */
  private async browseRemote(host: string, inputPath?: string): Promise<FsBrowseResponse> {
    try {
      assertHost(host);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const wanted = inputPath?.trim() ?? "";
    const target = wanted === "" ? '"$HOME"' : wanted.startsWith("~/") ? `"$HOME"/${shq(wanted.slice(2))}` : shq(wanted);
    const script = [
      `cd ${target} || exit 3`,
      "pwd",
      'if [ -e .git ]; then echo "G ."; else echo "D ."; fi',
      'for d in */; do [ -d "$d" ] || continue; n="${d%/}"; if [ -e "$n/.git" ]; then echo "G $n"; else echo "D $n"; fi; done',
    ].join("; ");
    let out: string;
    try {
      out = (await scriptOn(host, script)).stdout;
    } catch (error) {
      throw badRequest(`Can't open ${wanted || "~"} on ${host}: ${failureReason(error)}`);
    }
    const [pwd = "/", self = "D .", ...rest] = out.split("\n").filter(Boolean);
    const dirs = rest
      .map((line) => ({ isGitRepo: line.startsWith("G "), name: line.slice(2) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path: pwd,
      parent: pwd === "/" ? null : posix.dirname(pwd),
      isGitRepo: self.startsWith("G "),
      dirs: dirs.map((d) => ({ name: d.name, path: posix.join(pwd, d.name), isGitRepo: d.isGitRepo })),
    };
  }
}
