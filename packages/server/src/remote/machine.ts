import { execFile, spawn } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../services/git";

/**
 * Runs commands on this Mac (host = null) or on an SSH host from ~/.ssh/config, the same way
 * VS Code Remote-SSH does: `ssh <host> <command>`. Everything sent to the remote shell is quoted
 * with `shq`, so arguments are never interpreted by it.
 */

/** Overridable for tests (a fake ssh that runs the remote command locally). */
export const sshBin = () => process.env.SLAVES_SSH_BIN || "ssh";

/** Non-interactive, fail fast when the host is down, notice dead connections. */
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/** Unix socket paths are limited to ~104 bytes; `%C` expands to 40 hex characters. */
const SOCKET_PATH_MAX = 100;

/**
 * Reuse one ssh connection per host for a minute (ControlMaster), so the many short git commands
 * of a graph or diff view don't each pay a full handshake. Not on Windows: its OpenSSH can't
 * multiplex. Empty when the socket folder can't be used (then every command connects on its own).
 */
export function multiplexOptions(platform: NodeJS.Platform, controlDir: string | null): string[] {
  if (platform === "win32" || !controlDir) return [];
  if (controlDir.length + 1 + 40 > SOCKET_PATH_MAX) return [];
  return ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlDir}/%C`, "-o", "ControlPersist=60"];
}

let controlDir: string | null | undefined;

/** `~/.ssh/my-ai-slaves` (0700, this user's), created on first use; null if that isn't possible. */
function sshControlDir(): string | null {
  if (controlDir !== undefined) return controlDir;
  controlDir = null;
  try {
    const dir = join(homedir(), ".ssh", "my-ai-slaves");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    const uid = process.getuid?.();
    if (st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0) controlDir = dir;
  } catch {
    // No multiplexing; every command opens its own connection.
  }
  return controlDir;
}

/** Every ssh option: the fixed ones plus connection reuse (not with the tests' fake ssh). */
function sshOptions(): string[] {
  if (process.platform === "win32" || process.env.SLAVES_SSH_BIN) return SSH_OPTIONS;
  return [...SSH_OPTIONS, ...multiplexOptions(process.platform, sshControlDir())];
}

/** Marker the remote wrapper prints first so a run can be stopped on the server. */
export const REMOTE_PID_MARKER = "__SLAVES_PID__";

const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/;

/** A host alias must never look like an ssh option or contain shell syntax. */
export function assertHost(host: string): string {
  if (!HOST_RE.test(host)) throw new Error(`"${host}" isn't a valid SSH host name.`);
  return host;
}

/** POSIX single-quote: the remote shell sees the value as one literal word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `~/x` stays relative to the remote home; anything else is quoted literally. */
function remotePath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shq(path.slice(2))}`;
  return shq(path);
}

// Non-interactive ssh shells don't read ~/.profile, where ~/.local/bin (claude, cursor-agent) is added.
const PATH_PREFIX = 'export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"';

export interface RemoteCommand {
  command: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  /** Print `__SLAVES_PID__ <pid>` first (for long runs that may need stopping). */
  announcePid?: boolean;
}

export function remoteCommand({ command, args, cwd, env, announcePid }: RemoteCommand): string {
  const steps = [PATH_PREFIX];
  if (cwd) steps.push(`cd ${remotePath(cwd)}`);
  if (announcePid) steps.push(`echo "${REMOTE_PID_MARKER} $$"`);
  const assignments = Object.entries(env ?? {})
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shq(v)}`);
  steps.push(["exec", ...assignments.length ? ["env", ...assignments] : [], shq(command), ...args.map(shq)].join(" "));
  return steps.join(" && ");
}

/** The local process to start: the command itself, or ssh carrying the quoted remote command. */
export function localInvocation(
  host: string | null,
  cmd: RemoteCommand,
  opts: { tty?: boolean } = {},
): { command: string; args: string[] } {
  if (!host) return { command: cmd.command, args: cmd.args };
  return {
    command: sshBin(),
    args: [...sshOptions(), opts.tty ? "-tt" : "-T", assertHost(host), remoteCommand(cmd)],
  };
}

/** Child env: full local env for local commands; for ssh, the local env (ssh needs it) — remote vars ride in the command. */
function localEnv(host: string | null, extraEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return host ? process.env : { ...process.env, ...extraEnv };
}

/** Run to completion on a machine. Throws CommandError on non-zero exit (ssh failures: exit 255). */
export function runOn(
  host: string | null,
  command: string,
  args: string[],
  cwd: string | null,
  options: { timeoutMs?: number; extraEnv?: Record<string, string>; okExitCodes?: number[] } = {},
): Promise<{ stdout: string; stderr: string }> {
  const inv = localInvocation(host, { command, args, cwd, env: options.extraEnv });
  return new Promise((resolve, reject) => {
    execFile(
      inv.command,
      inv.args,
      {
        cwd: host ? undefined : (cwd ?? undefined),
        env: localEnv(host, options.extraEnv),
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : null;
        // Some commands use a non-zero exit for a normal answer (e.g. `git diff --no-index` = "differs").
        if (error && code !== null && options.okExitCodes?.includes(code)) {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        } else if (error) {
          const label = host ? `${command} on ${host}` : command;
          reject(new CommandError(`${label} ${args[0] ?? ""}`.trim(), String(stderr) || error.message, code));
        } else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Run a fixed shell script on a host (values must already be shq-quoted by the caller). */
export function scriptOn(host: string | null, script: string, timeoutMs = 30_000) {
  return runOn(host, "sh", ["-c", script], null, { timeoutMs });
}

/** Stream a local file to `<remoteDir>/<name>` on the host over ssh (no scp needed). */
export function sendFile(
  host: string,
  localPath: string,
  remoteDir: string,
  name: string,
  timeoutMs = 300_000,
): Promise<void> {
  const inv = localInvocation(host, {
    command: "sh",
    args: ["-c", 'mkdir -p "$1" && chmod 700 "$1" && cat > "$1/$2" && chmod 600 "$1/$2"', "sh", remoteDir, name],
  });
  return new Promise((resolve, reject) => {
    const child = spawn(inv.command, inv.args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // Never leave an `ssh … cat` waiting for input that won't come.
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(new CommandError(`copy to ${host}`, `Timed out after ${Math.round(timeoutMs / 1000)}s`, null)),
      timeoutMs,
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish(e));
    child.stdin.on("error", () => {}); // a closed pipe shows up as the exit code below
    child.on("close", (code) =>
      code === 0 ? finish() : finish(new CommandError(`copy to ${host}`, stderr || `exit ${code}`, code)),
    );
    createReadStream(localPath)
      .on("error", (e) => finish(e))
      .pipe(child.stdin);
  });
}

/** A one-line, human reason for an ssh/git failure ("ssh: connect to host dev port 22: Operation timed out"). */
export function failureReason(error: unknown): string {
  const text = error instanceof CommandError ? error.stderr : error instanceof Error ? error.message : String(error);
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^warning: permanently added/i.test(l));
  return (line ?? "Unknown error").slice(0, 240);
}
