import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";

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
}

export type ServerStart =
  | { ok: true; port: number }
  | { ok: false; reason: "port-in-use"; port: number }
  | { ok: false; reason: "crashed"; code: number | null; signal: NodeJS.Signals | null };

export interface ServerHandle {
  started: Promise<ServerStart>;
  /** Asks the server to stop cleanly (it marks running tasks interrupted), then kills it if it hangs. */
  stop(timeoutMs?: number): Promise<void>;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  await fs.promises.writeFile(opts.logFile, `--- ${new Date().toISOString()} starting on port ${opts.port}, data: ${opts.dataDir}\n`);
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
    child.on("message", (message: unknown) => {
      const m = message as { type?: string; port?: number } | null;
      if (m?.type === "ready") resolve({ ok: true, port: m.port ?? opts.port });
      if (m?.type === "port-in-use") portInUse = true;
    });
    child.once("exit", (code, signal) =>
      resolve(portInUse ? { ok: false, reason: "port-in-use", port: opts.port } : { ok: false, reason: "crashed", code, signal }),
    );
  });

  return {
    started,
    onExit: (cb) => exitCallbacks.push(cb),
    async stop(timeoutMs = 8000) {
      if (exited) return;
      if (child.connected) child.send({ type: "shutdown" });
      else child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      await exitPromise;
      clearTimeout(timer);
    },
  };
}
