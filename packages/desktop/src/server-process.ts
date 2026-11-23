import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The same Fastify server `npm start` runs, bundled into server/server.mjs and started as a child
// process on Electron's own Node (ELECTRON_RUN_AS_NODE), so a crash there can't take the window
// down and the server keeps its own event loop for the CLIs' output.

export interface ServerOptions {
  entry: string;
  webDir: string;
  dataDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
  logFile: string;
  /** server.log is moved to server.previous.log on start once it's this big (default 5 MB). */
  maxLogBytes?: number;
}

export type ServerStart =
  | { ok: true; port: number }
  | { ok: false; reason: "port-in-use"; port: number }
  | {
      ok: false;
      reason: "crashed";
      code: number | null;
      signal: NodeJS.Signals | null;
      /** Why, when the server said so before exiting (e.g. a data file written by a newer version). */
      message?: string;
    };

export interface ServerHandle {
  started: Promise<ServerStart>;
  /**
   * Asks the server to stop cleanly (it marks running tasks interrupted, or, with `resumeRunning`,
   * to run again on the next start), then kills it if it hangs.
   */
  stop(opts?: { timeoutMs?: number; resumeRunning?: boolean }): Promise<void>;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/** `server.log` → `server.previous.log` (any extension, or none: `.previous` is put before it). */
export function previousLogPath(logFile: string): string {
  const ext = path.extname(logFile);
  return `${logFile.slice(0, logFile.length - ext.length)}.previous${ext}`;
}

/**
 * Gets the log ready for another start without losing what's in it: a crash's stack trace has to
 * survive the restart (and quitting and reopening the app). The log is only appended to; once it
 * has grown past `maxBytes` it's moved to server.previous.log (replacing the older one) first.
 */
export async function prepareLogFile(logFile: string, maxBytes = DEFAULT_MAX_LOG_BYTES): Promise<void> {
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const size = await fs.promises.stat(logFile).then(
    (s) => s.size,
    () => 0,
  );
  if (size < maxBytes) return;
  const previous = previousLogPath(logFile);
  try {
    await fs.promises.rm(previous, { force: true });
    await fs.promises.rename(logFile, previous);
  } catch {
    // Windows can refuse while something still has the file open; keep appending to it then.
  }
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  await prepareLogFile(opts.logFile, opts.maxLogBytes);
  await fs.promises.appendFile(opts.logFile, `--- ${new Date().toISOString()} starting on port ${opts.port}, data: ${opts.dataDir}\n`);
  const log = await fs.promises.open(opts.logFile, "a");
  let child: ChildProcess;
  try {
    child = fork(opts.entry, [], {
      env: {
        ...opts.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        SLAVES_DATA_DIR: opts.dataDir,
        SLAVES_PORT: String(opts.port),
        SLAVES_WEB_DIR: opts.webDir,
      },
      stdio: ["ignore", log.fd, log.fd, "ipc"],
      windowsHide: true,
    });
  } finally {
    // The child has its own copy of the descriptor by now.
    await log.close();
  }

  let exited = false;
  const exitCallbacks: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      for (const cb of exitCallbacks) cb(code, signal);
      resolve();
    });
  });

  const started = new Promise<ServerStart>((resolve) => {
    let portInUse = false;
    let errorMessage: string | undefined;
    child.on("message", (message: unknown) => {
      const m = message as { type?: string; port?: number; message?: string } | null;
      if (m?.type === "ready") resolve({ ok: true, port: m.port ?? opts.port });
      if (m?.type === "port-in-use") portInUse = true;
      if (m?.type === "startup-error" && typeof m.message === "string") errorMessage = m.message;
    });
    child.once("exit", (code, signal) =>
      resolve(
        portInUse
          ? { ok: false, reason: "port-in-use", port: opts.port }
          : { ok: false, reason: "crashed", code, signal, message: errorMessage },
      ),
    );
  });

  return {
    started,
    onExit: (cb) => exitCallbacks.push(cb),
    async stop({ timeoutMs = 8000, resumeRunning = false } = {}) {
      if (exited) return;
      if (child.connected) child.send({ type: "shutdown", resumeRunning });
      else child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      await exitPromise;
      clearTimeout(timer);
    },
  };
}
