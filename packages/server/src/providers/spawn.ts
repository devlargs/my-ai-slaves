import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RawLine, StreamEvent } from "@my-ai-slaves/shared";
import { localInvocation, REMOTE_PID_MARKER, runOn } from "../remote/machine";
import type { RunHandle, RunResult, SpawnSpec } from "./types";

/**
 * Credentials that would silently override an account's own login
 * (e.g. ANTHROPIC_API_KEY makes `claude -p` bill the API key instead of the subscription).
 */
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY"];

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_ENV.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process couldn't start at all (e.g. binary not found). */
  spawnError: string | null;
}

/** Turns a CLI's stdout lines into StreamEvents and the final exit into a RunResult. */
export interface StreamParser {
  onLine(line: string): StreamEvent[];
  finish(exit: ExitInfo, stderrTail: string): RunResult;
}

const STDERR_TAIL_BYTES = 4096;

/**
 * What to actually start for a spec: the command itself on this Mac (with a scrubbed copy of our
 * env plus the spec's extras), or ssh carrying the quoted command for a remote host (the remote
 * side only gets the spec's extras: the server's own env and logins apply there).
 */
export function resolveSpawn(
  spec: SpawnSpec,
  opts: { announcePid?: boolean; tty?: boolean } = {},
): { command: string; args: string[]; env: Record<string, string>; cwd: string | undefined } {
  if (!spec.host) {
    return { command: spec.command, args: spec.args, env: childEnv(spec.extraEnv), cwd: spec.cwd ?? undefined };
  }
  const inv = localInvocation(
    spec.host,
    { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.extraEnv, announcePid: opts.announcePid },
    { tty: opts.tty },
  );
  return { command: inv.command, args: inv.args, env: childEnv({}), cwd: undefined };
}

/** Spawn without a shell, feed stdout through `parser`, expose it as a RunHandle. */
export function runProcess(spec: SpawnSpec, stdinText: string | null, parser: StreamParser): RunHandle {
  const streamListeners = new Set<(e: StreamEvent) => void>();
  const rawListeners = new Set<(r: RawLine) => void>();
  let stderrTail = "";
  let cancelled = false;
  const remote = Boolean(spec.host);
  /** On a remote host: the CLI's pid there, announced by the wrapper before it execs. */
  let remotePid: string | null = null;

  const launch = resolveSpawn(spec, { announcePid: remote });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    shell: false,
    stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
  });

  const emitRaw = (raw: RawLine) => {
    for (const cb of rawListeners) cb(raw);
  };

  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (remote && remotePid === null && line.startsWith(REMOTE_PID_MARKER)) {
      remotePid = line.slice(REMOTE_PID_MARKER.length).trim();
      return;
    }
    emitRaw({ src: "stdout", line });
    let events: StreamEvent[] = [];
    try {
      events = parser.onLine(line);
    } catch (error) {
      events = [{ kind: "warning", text: `Could not parse CLI output: ${(error as Error).message}` }];
    }
    for (const event of events) for (const cb of streamListeners) cb(event);
  });
  createInterface({ input: child.stderr! }).on("line", (line) => {
    emitRaw({ src: "stderr", line });
    stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_BYTES);
  });

  if (stdinText !== null && child.stdin) {
    child.stdin.on("error", () => {}); // CLI may exit before reading everything
    child.stdin.end(stdinText);
  }

  const exited = new Promise<ExitInfo>((resolve) => {
    let spawnError: string | null = null;
    child.on("error", (error) => {
      spawnError = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Command not found: ${launch.command}`
        : error.message;
      if (child.exitCode === null && child.pid === undefined) resolve({ code: null, signal: null, spawnError });
    });
    child.on("close", (code, signal) => resolve({ code, signal, spawnError }));
  });

  const done = exited.then((exit): RunResult => {
    if (cancelled) return { outcome: "cancelled" };
    if (exit.spawnError) {
      return { outcome: "failed", exitCode: null, message: exit.spawnError, stderrTail };
    }
    return parser.finish(exit, stderrTail);
  });

  return {
    onStream(cb) {
      streamListeners.add(cb);
      return () => streamListeners.delete(cb);
    },
    onRaw(cb) {
      rawListeners.add(cb);
      return () => rawListeners.delete(cb);
    },
    done,
    async cancel() {
      cancelled = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Remote: stop the process on the server itself; killing the local ssh alone can leave it running.
      const signal = (sig: "INT" | "TERM" | "KILL") => {
        if (remote && remotePid && spec.host) {
          void runOn(spec.host, "kill", [`-${sig}`, remotePid], null, { timeoutMs: 15_000 }).catch(() => {});
        } else {
          child.kill(`SIG${sig}`);
        }
      };
      signal("INT");
      const term = setTimeout(() => signal("TERM"), 5000);
      const kill = setTimeout(() => signal("KILL"), 10000);
      const local = setTimeout(() => child.kill("SIGKILL"), 15000);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(local);
    },
  };
}

/** Run a short command to completion (status checks, logout). Never throws. */
export function runToCompletion(
  spec: SpawnSpec,
  timeoutMs = 20000,
): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  const launch = resolveSpawn(spec);
  return new Promise((resolve) => {
    execFile(
      launch.command,
      launch.args,
      { cwd: launch.cwd, env: launch.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), error: error ? error.message : null });
      },
    );
  });
}

/** Short, single-line preview of a value for activity/tool summaries. */
export function preview(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
