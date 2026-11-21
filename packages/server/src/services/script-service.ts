import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatLocalIso,
  type PackageManager,
  type Repo,
  type RepoScripts,
  type ScriptRun,
  type ScriptRunInfo,
} from "@my-ai-slaves/shared";
import { childEnv } from "../providers/spawn";
import { localInvocation, REMOTE_PID_MARKER, runOn, scriptOn } from "../remote/machine";
import { badRequest, conflict, notFound } from "./common";

/** The last this many characters of a run's output are kept. */
const OUTPUT_CAP = 256 * 1024;
/** New output is sent at most this often. */
const FLUSH_MS = 100;

export interface ScriptListener {
  scriptUpdated(repoId: string, run: ScriptRunInfo): void;
  scriptOutput(repoId: string, runId: string, chunk: string): void;
}

interface RunState {
  info: ScriptRunInfo;
  output: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  child: ChildProcess;
  host: string | null;
  remotePid: string | null;
  stopping: boolean;
  exited: Promise<void>;
}

// Names `cmd.exe` passes through untouched (Windows runs the package manager's .cmd shim through it).
const WINDOWS_SAFE_NAME = /^[\w.:@/+-]+$/;

/** Which package manager a repo uses: `packageManager` in package.json, else its lockfile, else npm. */
export function detectPackageManager(pkg: { packageManager?: unknown }, files: string[]): PackageManager {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  const has = (f: string) => files.includes(f);
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  return "npm";
}

/** The `scripts` of a package.json, in file order, strings only. */
export function parseScripts(pkg: { scripts?: unknown }): { name: string; command: string }[] {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  return Object.entries(scripts as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].length > 0)
    .map(([name, command]) => ({ name, command }));
}

/**
 * Runs a repo's package.json scripts (`npm run dev`, …) in the repo's folder, on this computer or on
 * its SSH host, and keeps the latest run of each script (with its output) in memory.
 */
export class ScriptService {
  /** repoId → script name → its latest run. */
  private readonly runs = new Map<string, Map<string, RunState>>();

  constructor(private readonly listener: ScriptListener) {}

  async list(repo: Repo): Promise<RepoScripts> {
    let text: string;
    let files: string[];
    if (repo.host) {
      const pkg = await runOn(repo.host, "cat", ["package.json"], repo.path, { timeoutMs: 30_000 }).catch(() => null);
      if (!pkg) return { found: false, packageManager: "npm", scripts: [] };
      text = pkg.stdout;
      files = (await runOn(repo.host, "ls", ["-a"], repo.path, { timeoutMs: 30_000 })).stdout.split("\n").map((f) => f.trim());
    } else {
      const pkg = await readFile(join(repo.path, "package.json"), "utf8").catch(() => null);
      if (pkg === null) return { found: false, packageManager: "npm", scripts: [] };
      text = pkg;
      files = await readdir(repo.path).catch(() => []);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw badRequest("The repo's package.json isn't valid JSON.");
    }
    return { found: true, packageManager: detectPackageManager(parsed, files), scripts: parseScripts(parsed) };
  }

  /** The latest run of each script of a repo, output included. */
  replay(repoId: string): ScriptRun[] {
    return [...(this.runs.get(repoId)?.values() ?? [])].map((r) => ({ ...r.info, output: r.output + r.pending }));
  }

  async run(repo: Repo, script: string): Promise<ScriptRunInfo> {
    const { scripts, packageManager, found } = await this.list(repo);
    if (!found) throw badRequest(`${repo.name} has no package.json.`);
    if (!scripts.some((s) => s.name === script)) throw notFound(`No script "${script}" in ${repo.name}'s package.json.`);
    const byScript = this.runs.get(repo.id) ?? new Map<string, RunState>();
    this.runs.set(repo.id, byScript);
    if (byScript.get(script)?.info.status === "running") throw conflict(`"${script}" is already running.`);

    const args = ["run", script];
    const host = repo.host ?? null;
    let command: string;
    let spawnArgs: string[];
    if (host) {
      ({ command, args: spawnArgs } = localInvocation(host, { command: packageManager, args, cwd: repo.path, announcePid: true }));
    } else if (process.platform === "win32") {
      // The package managers are .cmd shims there, which only start through cmd.exe.
      if (!WINDOWS_SAFE_NAME.test(script)) throw badRequest(`"${script}" can't be run from the app on Windows.`);
      command = process.env.ComSpec || "cmd.exe";
      spawnArgs = ["/d", "/s", "/c", packageManager, ...args];
    } else {
      command = packageManager;
      spawnArgs = args;
    }

    const child = spawn(command, spawnArgs, {
      cwd: host ? undefined : repo.path,
      env: childEnv({}),
      shell: false,
      windowsHide: true,
      // Its own process group on macOS/Linux, so Stop reaches the dev server the script started too.
      detached: !host && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const state: RunState = {
      info: {
        id: randomUUID(),
        repoId: repo.id,
        script,
        commandLine: `${packageManager} run ${script}`,
        status: "running",
        exitCode: null,
        startedAt: formatLocalIso(),
        endedAt: null,
      },
      output: "",
      pending: "",
      flushTimer: null,
      child,
      host,
      remotePid: null,
      stopping: false,
      exited: Promise.resolve(),
    };
    byScript.set(script, state);

    const flush = () => {
      state.flushTimer = null;
      if (!state.pending) return;
      const chunk = state.pending;
      state.pending = "";
      state.output = (state.output + chunk).slice(-OUTPUT_CAP);
      this.listener.scriptOutput(repo.id, state.info.id, chunk);
    };
    const append = (text: string) => {
      state.pending += text;
      if (state.pending.length > OUTPUT_CAP) state.pending = state.pending.slice(-OUTPUT_CAP);
      state.flushTimer ??= setTimeout(flush, FLUSH_MS);
    };

    // Remote: the first stdout line is the wrapper's pid marker (held back until it's complete).
    let head: string | null = host ? "" : null;
    child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      if (head !== null) {
        head += data;
        const newline = head.indexOf("\n");
        if (newline === -1 && head.length < 200) return;
        const first = newline === -1 ? head : head.slice(0, newline);
        const marker = first.trim().match(new RegExp(`^${REMOTE_PID_MARKER} (\\d+)$`));
        if (marker) state.remotePid = marker[1] ?? null;
        data = marker ? head.slice(newline + 1) : head;
        head = null;
      }
      if (data) append(data);
    });
    child.stderr?.setEncoding("utf8").on("data", (data: string) => append(data));

    state.exited = new Promise<void>((resolve) => {
      const finish = (exitCode: number | null, error?: string) => {
        if (state.info.status !== "running") return resolve();
        if (head) append(head);
        if (error) append(`${error}\n`);
        if (state.flushTimer) clearTimeout(state.flushTimer);
        flush();
        state.info = {
          ...state.info,
          status: state.stopping ? "stopped" : exitCode === 0 ? "done" : "failed",
          exitCode,
          endedAt: formatLocalIso(),
        };
        this.listener.scriptUpdated(repo.id, state.info);
        resolve();
      };
      child.on("error", (error) =>
        finish(null, (error as NodeJS.ErrnoException).code === "ENOENT" ? `Command not found: ${command}` : error.message),
      );
      child.on("close", (code) => finish(code));
    });

    this.listener.scriptUpdated(repo.id, state.info);
    return state.info;
  }

  async stop(repoId: string, script: string): Promise<void> {
    const state = this.runs.get(repoId)?.get(script);
    if (!state || state.info.status !== "running") return;
    state.stopping = true;
    const { child, host } = state;
    const pid = child.pid;
    const signal = (sig: "INT" | "TERM" | "KILL") => {
      if (host) {
        if (state.remotePid && /^\d+$/.test(state.remotePid)) {
          // The script's children first (the dev server), then the package manager itself.
          void scriptOn(host, `pkill -${sig} -P ${state.remotePid}; kill -${sig} ${state.remotePid}`, 15_000).catch(() => {});
        }
        if (sig === "KILL") child.kill("SIGKILL");
      } else if (process.platform === "win32") {
        // No signals there: end the whole tree.
        if (pid) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else if (pid) {
        try {
          process.kill(-pid, `SIG${sig}`); // the whole process group
        } catch {
          child.kill(`SIG${sig}`);
        }
      }
    };
    signal(process.platform === "win32" && !host ? "KILL" : "INT");
    const term = setTimeout(() => signal("TERM"), 3000);
    const kill = setTimeout(() => signal("KILL"), 8000);
    await state.exited;
    clearTimeout(term);
    clearTimeout(kill);
  }

  /** Stop everything (server shutdown, repo removed). */
  async stopAll(repoId?: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [id, byScript] of this.runs) {
      if (repoId && id !== repoId) continue;
      for (const script of byScript.keys()) jobs.push(this.stop(id, script));
    }
    await Promise.all(jobs);
    if (repoId) this.runs.delete(repoId);
  }
}
