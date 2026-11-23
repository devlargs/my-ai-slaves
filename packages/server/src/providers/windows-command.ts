import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Windows: how to start a CLI without a shell. A real `.exe` starts as is, but an npm-installed CLI
 * is a `.cmd` shim, which Node can't spawn directly. For npm/pnpm shims we run the script they point
 * at with node (any argument, newlines included, passes through untouched); any other batch file goes
 * through `cmd.exe /d /s /c` with every argument escaped the way cross-spawn does it.
 */
export interface WindowsLaunch {
  command: string;
  args: string[];
  /** Set for the cmd.exe route: args are already a quoted command line. */
  windowsVerbatimArguments?: boolean;
}

export interface WindowsFs {
  isFile(path: string): boolean;
  read(path: string): string | null;
}

const realFs: WindowsFs = {
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** An env var by name, case-insensitively (Windows has `Path`, not `PATH`). */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** Where Windows would find `command`: PATH × PATHEXT (extension-less files, like npm's sh shim, are skipped). */
export function findOnWindowsPath(
  command: string,
  env: Record<string, string | undefined>,
  fs: WindowsFs = realFs,
): string | null {
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const hasExt = exts.includes(win32.extname(command).toLowerCase());
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return candidates(win32.resolve(command)).find((c) => fs.isFile(c)) ?? null;
  const dirs = (envValue(env, "PATH") ?? "").split(";").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const dir of dirs) {
    const found = candidates(win32.join(dir, command)).find((c) => fs.isFile(c));
    if (found) return found;
  }
  return null;
}

/** The node script an npm / pnpm `.cmd` shim runs (`"%dp0%\…\cli.js" %*`), or null if it isn't one. */
export function shimTarget(shimPath: string, text: string): string | null {
  const match = /"(%~dp0|%dp0%)\\?([^"]+\.[cm]?js)"\s+%\*/i.exec(text);
  if (!match?.[2]) return null;
  return win32.resolve(win32.dirname(shimPath), match[2]);
}

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /c` → a batch file that hands `%*` on (so metacharacters are escaped twice). */
export function escapeCmdArgument(arg: string): string {
  let out = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, "$1$1");
  out = `"${out}"`;
  return out.replace(META_CHARS, "^$1").replace(META_CHARS, "^$1");
}

export function resolveWindowsLaunch(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  fs: WindowsFs = realFs,
): WindowsLaunch {
  const file = findOnWindowsPath(command, env, fs);
  // Not found: spawn it anyway so the caller gets its usual "Command not found".
  if (!file) return { command, args };
  const ext = win32.extname(file).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: file, args };

  const text = fs.read(file);
  const script = text ? shimTarget(file, text) : null;
  if (script && fs.isFile(script)) {
    const besideShim = win32.join(win32.dirname(file), "node.exe");
    const node = fs.isFile(besideShim) ? besideShim : findOnWindowsPath("node", env, fs);
    if (node) return { command: node, args: [script, ...args] };
  }

  if (args.some((a) => /[\r\n]/.test(a))) {
    throw new Error(
      `${win32.basename(file)} is a batch file, which can't be given text with line breaks. Point the app at the CLI's .exe (Settings) instead.`,
    );
  }
  const line = [file.replace(META_CHARS, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command: envValue(env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** End a process and everything it started (Windows has no signals; `force` = /F). Never throws. */
export function killWindowsTree(pid: number, force: boolean): void {
  const args = ["/pid", String(pid), "/T"];
  if (force) args.push("/F");
  execFile("taskkill", args, { windowsHide: true }, () => {});
}
