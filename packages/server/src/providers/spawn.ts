import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RawLine, StreamEvent, TokenUsage } from "@my-ai-slaves/shared";
import { localInvocation, REMOTE_PID_MARKER, runOn } from "../remote/machine";
import type { RunHandle, RunResult, SpawnSpec } from "./types";
import { killWindowsTree, resolveWindowsLaunch } from "./windows-command";

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
  /** The CLI session seen so far (from its init line), so a stopped run can still be continued. */
  readonly sessionId: string | null;
  /** Tokens used so far, if the CLI reports them; added to the run's result whatever the outcome. */
  readonly usage?: TokenUsage | null;
  onLine(line: string): StreamEvent[];
  finish(exit: ExitInfo, stderrTail: string): RunResult;
}

const STDERR_TAIL_BYTES = 4096;

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | undefined;
  /** Windows cmd.exe route: `args` are already one quoted command line. */
  windowsVerbatimArguments?: boolean;
}

/**
 * What to actually start for a spec: the command itself on this machine (with a scrubbed copy of our
 * env plus the spec's extras; on Windows an npm `.cmd` shim is resolved to what it runs), or ssh
 * carrying the quoted command for a remote host (the remote side only gets the spec's extras: the
 * server's own env and logins apply there). Throws if a Windows batch file can't carry the args.
 */
export function resolveSpawn(
  spec: SpawnSpec,
  opts: { announcePid?: boolean; tty?: boolean; platform?: NodeJS.Platform } = {},
): Launch {
  if (!spec.host) {
    const env = childEnv(spec.extraEnv);
    const cwd = spec.cwd ?? undefined;
    if ((opts.platform ?? process.platform) === "win32") {
      return { ...resolveWindowsLaunch(spec.command, spec.args, env), env, cwd };
    }
    return { command: spec.command, args: spec.args, env, cwd };
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

  let launch: Launch;
  try {
    launch = resolveSpawn(spec, { announcePid: remote });
  } catch (error) {
    return failedHandle((error as Error).message);
  }
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
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
    if (cancelled) return { outcome: "cancelled", sessionId: parser.sessionId, usage: parser.usage ?? null };
    if (exit.spawnError) {
      return { outcome: "failed", exitCode: null, message: exit.spawnError, stderrTail };
    }
    const result = parser.finish(exit, stderrTail);
    return { ...result, usage: result.usage ?? parser.usage ?? null };
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
        } else if (process.platform === "win32" && child.pid) {
          // No signals there (child.kill ends only the top process, at once): ask the whole tree to
          // close first, then force it.
          killWindowsTree(child.pid, sig !== "INT");
        } else {
          child.kill(`SIG${sig}`);
        }
      };
      signal("INT");
      const term = setTimeout(() => signal("TERM"), 5000);
      const kill = setTimeout(() => signal("KILL"), 10000);
      const local = setTimeout(() => {
        if (process.platform === "win32" && child.pid && !remote) killWindowsTree(child.pid, true);
        else child.kill("SIGKILL");
      }, 15000);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(local);
    },
  };
}

/** A run that never started (nothing to stream, cancel is a no-op). */
function failedHandle(message: string): RunHandle {
  return {
    onStream: () => () => {},
    onRaw: () => () => {},
    done: Promise.resolve({ outcome: "failed", exitCode: null, message, stderrTail: "" }),
    async cancel() {},
  };
}

/** Run a short command to completion (status checks, logout). Never throws. */
export function runToCompletion(
  spec: SpawnSpec,
  timeoutMs = 20000,
): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  let launch: Launch;
  try {
    launch = resolveSpawn(spec);
  } catch (error) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", error: (error as Error).message });
  }
  return new Promise((resolve) => {
    execFile(
      launch.command,
      launch.args,
      {
        cwd: launch.cwd,
        env: launch.env,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
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
