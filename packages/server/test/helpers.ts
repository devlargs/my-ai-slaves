import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Logger } from "../src/storage/fs-utils";

const dirs: string[] = [];

/** Fresh temp folder, removed after each test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slaves-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Retries: background activity writes may still be landing when a test ends.
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

export function memoryLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info: () => {}, warn: (m) => warnings.push(m) };
}

export const listDir = async (dir: string) => (await readdir(dir)).sort();

/** 2026-11-18T18:02:00+08:00 */
export const fixedNow = () => new Date("2026-11-18T10:02:00Z");
