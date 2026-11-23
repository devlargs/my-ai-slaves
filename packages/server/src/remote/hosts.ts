import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { RemoteHost } from "@my-ai-slaves/shared";

/**
 * What VS Code's Remote Explorer shows for SSH: the concrete Host entries in ~/.ssh/config
 * (wildcard patterns skipped, Include followed) plus the remote folders VS Code (and Cursor, which
 * uses the same Remote-SSH) remember having opened.
 */
export async function listRemoteHosts(
  options: { sshConfig?: string; editorStorageDirs?: string[] } = {},
): Promise<RemoteHost[]> {
  const sshConfig = options.sshConfig ?? process.env.SLAVES_SSH_CONFIG ?? join(homedir(), ".ssh", "config");
  const storageDirs = options.editorStorageDirs ??
    (process.env.SLAVES_EDITOR_STORAGE ? [process.env.SLAVES_EDITOR_STORAGE] : defaultStorageDirs());

  const hosts = new Map<string, RemoteHost>();
  for (const { host, hostname } of await parseSshConfig(sshConfig)) {
    if (!hosts.has(host)) hosts.set(host, { host, hostname, recentFolders: [] });
  }
  for (const { host, path } of await recentRemoteFolders(storageDirs)) {
    const entry = hosts.get(host) ?? { host, hostname: null, recentFolders: [] };
    if (!entry.recentFolders.includes(path)) entry.recentFolders.push(path);
    hosts.set(host, entry);
  }
  return [...hosts.values()];
}

/** Where VS Code / Cursor keep their user data: Application Support on macOS, %APPDATA% on Windows. */
export function editorDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || join(homedir(), "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function defaultStorageDirs(): string[] {
  const base = editorDataDir();
  return ["Code", "Code - Insiders", "Cursor"].map((app) => join(base, app, "User", "globalStorage"));
}

// ── ~/.ssh/config ────────────────────────────────────────────────────────────

const isPattern = (h: string) => /[*?!]/.test(h);

async function parseSshConfig(file: string, depth = 0): Promise<{ host: string; hostname: string | null }[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const found: { host: string; hostname: string | null }[] = [];
  let current: { host: string; hostname: string | null }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (key === "host") {
      current = value
        .split(/\s+/)
        .filter((h) => h && !isPattern(h))
        .map((host) => ({ host, hostname: null }));
      found.push(...current);
    } else if (key === "match") {
      current = [];
    } else if (key === "hostname") {
      for (const h of current) h.hostname ??= value;
    } else if (key === "include" && depth < 3) {
      for (const pattern of value.split(/\s+/)) {
        for (const included of await expandInclude(pattern)) found.push(...(await parseSshConfig(included, depth + 1)));
      }
    }
  }
  return found;
}

/** `Include` paths: relative to ~/.ssh, `~` expanded, simple `*` globs in the file name. */
async function expandInclude(pattern: string): Promise<string[]> {
  let path = pattern.replace(/^~(?=[\\/])/, homedir());
  if (!isAbsolute(path)) path = join(homedir(), ".ssh", path);
  const name = path.split(/[\\/]/).pop() ?? "";
  if (!name.includes("*")) return [path];
  const dir = dirname(path);
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  try {
    return (await readdir(dir)).filter((f) => re.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// ── editor history ──────────────────────────────────────────────────────────

const REMOTE_URI = /vscode-remote:\/\/ssh-remote(?:%2B|\+)([^/"\s]+)(\/[^"\s]*)/g;

/** `ssh-remote+<host>` (or hex-encoded JSON `{"hostName": …}` for unusual names) → host alias. */
function decodeAuthority(authority: string): string | null {
  const plain = decodeURIComponent(authority);
  if (/^[0-9a-f]+$/i.test(plain) && plain.length % 2 === 0 && plain.length > 8) {
    try {
      const json = JSON.parse(Buffer.from(plain, "hex").toString("utf8")) as { hostName?: unknown };
      return typeof json.hostName === "string" ? json.hostName : null;
    } catch {
      // not hex JSON, a plain alias
    }
  }
  return plain || null;
}

async function recentRemoteFolders(storageDirs: string[]): Promise<{ host: string; path: string }[]> {
  const texts: string[] = [];
  for (const dir of storageDirs) {
    texts.push(await readFile(join(dir, "storage.json"), "utf8").catch(() => ""));
    texts.push(await sqliteValue(join(dir, "state.vscdb"), "history.recentlyOpenedPathsList"));
  }
  const seen = new Set<string>();
  const result: { host: string; path: string }[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(REMOTE_URI)) {
      const host = decodeAuthority(m[1] ?? "");
      const path = decodeURIComponent(m[2] ?? "").replace(/\/$/, "");
      if (!host || !path || seen.has(`${host}:${path}`)) continue;
      seen.add(`${host}:${path}`);
      result.push({ host, path });
    }
  }
  return result;
}

/** Read one key from VS Code's state DB with the system sqlite3, if it's there. Never throws. */
function sqliteValue(db: string, key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "sqlite3",
      ["-readonly", db, `select value from ItemTable where key = '${key.replace(/'/g, "''")}'`],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout)),
    );
  });
}
