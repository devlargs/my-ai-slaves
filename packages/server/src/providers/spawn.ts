import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RawLine, StreamEvent } from "@my-ai-slaves/shared";
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

/** Spawn without a shell, feed stdout through `parser`, expose it as a RunHandle. */
export function runProcess(spec: SpawnSpec, stdinText: string | null, parser: StreamParser): RunHandle {
  const streamListeners = new Set<(e: StreamEvent) => void>();
  const rawListeners = new Set<(r: RawLine) => void>();
  let stderrTail = "";
  let cancelled = false;

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe"],
  });

  const emitRaw = (raw: RawLine) => {
    for (const cb of rawListeners) cb(raw);
  };

  createInterface({ input: child.stdout! }).on("line", (line) => {
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
        ? `Command not found: ${spec.command}`
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
      child.kill("SIGINT");
      const term = setTimeout(() => child.kill("SIGTERM"), 5000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(term);
      clearTimeout(kill);
    },
  };
}

/** Run a short command to completion (status checks, logout). Never throws. */
export function runToCompletion(
  spec: SpawnSpec,
  timeoutMs = 20000,
): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      { cwd: spec.cwd, env: spec.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
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
