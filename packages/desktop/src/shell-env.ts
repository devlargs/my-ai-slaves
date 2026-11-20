import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// An app opened from the Dock or Finder gets launchd's bare PATH (/usr/bin:/bin:…), not the one
// your terminal has, so `claude`, `agent`, `gh`, nvm's node and Homebrew's git wouldn't be found.
// Ask the login shell for its PATH once at startup, the way VS Code does, and run the server with it.

const START = "__MY_AI_SLAVES_PATH_START__";
const END = "__MY_AI_SLAVES_PATH_END__";
const TIMEOUT_MS = 8000;

/** Pulls the PATH printed between the markers out of a shell's (possibly noisy) output. */
export function extractPath(output: string): string | null {
  const start = output.lastIndexOf(START);
  if (start === -1) return null;
  const end = output.indexOf(END, start);
  if (end === -1) return null;
  const value = output.slice(start + START.length, end).trim();
  return value || null;
}

/** Joins PATH lists, keeping the first occurrence of each entry. */
export function mergePaths(...lists: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const entry of (list ?? "").split(delimiter)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(delimiter);
}

function loginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return new Promise((resolve) => {
    // -i -l: read the same rc files a terminal does (nvm, Homebrew and ~/.local/bin live there).
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      { timeout: TIMEOUT_MS, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
      (_error, stdout) => resolve(extractPath(String(stdout ?? ""))),
    );
  });
}

/** The environment the bundled server (and through it every CLI and git) should run with. */
export async function serverBaseEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (process.platform === "win32") return env; // Windows apps get the user's full PATH already
  const fromShell = await loginShellPath();
  const home = homedir();
  env.PATH = mergePaths(
    fromShell,
    env.PATH,
    // In case the shell couldn't be read: where these CLIs usually live.
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  );
  // git and the CLIs print UTF-8; launchd gives apps no locale at all.
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  return env;
}
