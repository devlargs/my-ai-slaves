import { execFile } from "node:child_process";

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`${command} failed${code !== null ? ` (exit ${code})` : ""}: ${stderr.trim() || "no output"}`);
  }
}

/** Run a program with an args array (never a shell). Throws CommandError on non-zero exit. */
export function run(
  command: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env: options.env ?? process.env, timeout: options.timeoutMs ?? 120000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          reject(new CommandError(`${command} ${args[0] ?? ""}`.trim(), String(stderr) || error.message, code));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}

export const git = (args: string[], cwd: string) => run("git", args, cwd).then((r) => r.stdout);

export async function gitOk(args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}
