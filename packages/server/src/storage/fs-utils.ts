import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { formatFileStamp } from "@my-ai-slaves/shared";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[data] ${m}`),
  warn: (m) => console.warn(`[data] ${m}`),
};

/** Pretty JSON exactly as it is stored on disk: 2-space indent, trailing newline. */
export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write to `<file>.tmp`, fsync, then rename over `file`. A crash leaves the old file intact. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/** Remove a `<file>.tmp` left behind by a crash mid-write. */
export async function removeStaleTmp(file: string): Promise<void> {
  await rm(`${file}.tmp`, { force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Move `file` to `<file>.corrupt-<timestamp>` (suffixing -2, -3… if taken). Returns the new path. */
export async function backupCorrupt(file: string, now: Date): Promise<string> {
  const base = `${file}.corrupt-${formatFileStamp(now)}`;
  let target = base;
  for (let n = 2; await exists(target); n++) target = `${base}-${n}`;
  await rename(file, target);
  return target;
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
