import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ActivityEntry, ActivityFile, formatLocalIso } from "@my-ai-slaves/shared";
import { backupCorrupt, consoleLogger, type Logger, removeStaleTmp, writeFileAtomic } from "./fs-utils";
import { enqueueFileJob } from "./write-queue";

export const DEFAULT_ACTIVITY_MAX_BYTES = 5 * 1024 * 1024;

const FILE_RE = /^(\d{4,})_activity\.json$/;
const TMP_RE = /^\d{4,}_activity\.json\.tmp$/;
const EMPTY_TAIL = "]\n}\n";
const ENTRIES_TAIL = "\n  ]\n}\n";

export const activityFileName = (n: number) => `${String(n).padStart(4, "0")}_activity.json`;
const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/** An entry as it appears inside the file: pretty-printed and indented under `"entries"`. */
function entryBlock(entry: ActivityEntry): string {
  return JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * One activity file kept in memory as pre-rendered entry blocks, so sizing an append and
 * writing the file never re-serialises old entries. `serialize()` output is byte-identical
 * to `JSON.stringify(file, null, 2) + "\n"` (checked in tests).
 */
class ActivityFileState {
  readonly entries: ActivityEntry[] = [];
  private readonly blocks: string[] = [];
  private blockBytes = 0;
  private readonly head: string;
  pendingWrite: Promise<void> | null = null;

  constructor(
    readonly number: number,
    readonly name: string,
    readonly path: string,
    readonly createdAt: string,
  ) {
    this.head =
      `{\n  "file": ${JSON.stringify(name)},\n` +
      `  "createdAt": ${JSON.stringify(createdAt)},\n` +
      `  "entries": [`;
  }

  get count(): number {
    return this.entries.length;
  }

  /** File size in bytes, optionally as if one more block of `extraBytes` were appended. */
  size(extraBytes?: number): number {
    const n = this.blocks.length + (extraBytes === undefined ? 0 : 1);
    if (n === 0) return byteLength(this.head) + byteLength(EMPTY_TAIL);
    const blocks = this.blockBytes + (extraBytes ?? 0);
    return byteLength(this.head) + 1 + blocks + 2 * (n - 1) + byteLength(ENTRIES_TAIL);
  }

  push(entry: ActivityEntry, block: string): void {
    this.entries.push(entry);
    this.blocks.push(block);
    this.blockBytes += byteLength(block);
  }

  serialize(): string {
    if (this.blocks.length === 0) return this.head + EMPTY_TAIL;
    return `${this.head}\n${this.blocks.join(",\n")}${ENTRIES_TAIL}`;
  }
}

export interface ActivityLogOptions {
  dir: string;
  /** Rotate before a file would exceed this. Default 5 MB. */
  maxBytes?: number;
  logger?: Logger;
  now?: () => Date;
}

export type NewActivityEntry = Omit<ActivityEntry, "at"> & { at?: string };

/**
 * Append-only task history spread over `0001_activity.json`, `0002_…`, ….
 * - Before appending, if the current file plus the entry would pass `maxBytes`, a new file is started.
 *   An entry is never split; one bigger than `maxBytes` gets a file to itself.
 * - Appends that arrive while a write is in flight are batched into the next atomic write.
 */
export class ActivityLog {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private current: ActivityFileState | null = null;
  /** taskId → names of the files holding its entries, oldest first. */
  private readonly index = new Map<string, string[]>();

  constructor(options: ActivityLogOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_ACTIVITY_MAX_BYTES;
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Scan existing files, back up unreadable ones, build the task index, open the latest file. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir);

    await Promise.all(names.filter((n) => TMP_RE.test(n)).map((n) => rm(join(this.dir, n), { force: true })));

    const numbered = names
      .map((name) => ({ name, number: Number(FILE_RE.exec(name)?.[1] ?? Number.NaN) }))
      .filter((f) => Number.isFinite(f.number))
      .sort((a, b) => a.number - b.number);
    const highest = numbered.at(-1)?.number ?? 1;

    let latest: ActivityFileState | null = null;
    for (const { name, number } of numbered) {
      const path = join(this.dir, name);
      await removeStaleTmp(path);
      let file: ActivityFile;
      try {
        file = ActivityFile.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (error) {
        const backup = await backupCorrupt(path, this.now());
        this.logger.warn(
          `${path} was unreadable (${(error as Error).message.split("\n")[0]}). ` +
            `Backed it up to ${backup}; its entries are left out of history.`,
        );
        continue;
      }
      for (const entry of file.entries) this.addToIndex(entry.taskId, name);
      if (number === highest) {
        latest = new ActivityFileState(number, name, path, file.createdAt);
        for (const entry of file.entries) latest.push(entry, entryBlock(entry));
      }
    }

    this.current = latest ?? this.newFile(highest);
    if (!latest) await this.flush(this.current);
  }

  /** Name of the file new entries currently go to. */
  get currentFile(): string {
    return this.requireCurrent().name;
  }

  async append(input: NewActivityEntry): Promise<ActivityEntry> {
    const entry = ActivityEntry.parse({ ...input, at: input.at ?? formatLocalIso(this.now()) });
    const block = entryBlock(entry);

    let target = this.requireCurrent();
    if (target.count > 0 && target.size(byteLength(block)) > this.maxBytes) {
      target = this.newFile(target.number + 1);
      this.current = target;
    }
    target.push(entry, block);
    this.addToIndex(entry.taskId, target.name);
    await this.flush(target);
    return entry;
  }

  /** Every entry for a task, across all files, in the order they were written. */
  async forTask(taskId: string): Promise<ActivityEntry[]> {
    const current = this.requireCurrent();
    const result: ActivityEntry[] = [];
    for (const name of this.index.get(taskId) ?? []) {
      if (name === current.name) {
        result.push(...current.entries.filter((e) => e.taskId === taskId));
        continue;
      }
      const path = join(this.dir, name);
      try {
        // Queued behind any pending write to that file, so we never read a stale version.
        const file = await enqueueFileJob(path, async () =>
          ActivityFile.parse(JSON.parse(await readFile(path, "utf8"))),
        );
        result.push(...file.entries.filter((e) => e.taskId === taskId));
      } catch (error) {
        this.logger.warn(`Skipped ${path} while reading history for ${taskId}: ${(error as Error).message}`);
      }
    }
    return result;
  }

  /** Every entry in every file, oldest first (for the History list). */
  async readAll(): Promise<ActivityEntry[]> {
    const current = this.requireCurrent();
    const names = (await readdir(this.dir))
      .filter((n) => FILE_RE.test(n) && n !== current.name)
      .sort((a, b) => Number(FILE_RE.exec(a)?.[1]) - Number(FILE_RE.exec(b)?.[1]));
    const result: ActivityEntry[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const file = await enqueueFileJob(path, async () =>
          ActivityFile.parse(JSON.parse(await readFile(path, "utf8"))),
        );
        result.push(...file.entries);
      } catch (error) {
        this.logger.warn(`Skipped ${path} while reading history: ${(error as Error).message}`);
      }
    }
    result.push(...current.entries);
    return result;
  }

  private newFile(number: number): ActivityFileState {
    const name = activityFileName(number);
    return new ActivityFileState(number, name, join(this.dir, name), formatLocalIso(this.now()));
  }

  /** Write `state` soon; appends made before the write starts share it. */
  private flush(state: ActivityFileState): Promise<void> {
    if (!state.pendingWrite) {
      state.pendingWrite = enqueueFileJob(state.path, async () => {
        state.pendingWrite = null;
        await writeFileAtomic(state.path, state.serialize());
      });
    }
    return state.pendingWrite;
  }

  private addToIndex(taskId: string, fileName: string): void {
    const files = this.index.get(taskId);
    if (!files) this.index.set(taskId, [fileName]);
    else if (files.at(-1) !== fileName) files.push(fileName);
  }

  private requireCurrent(): ActivityFileState {
    if (!this.current) throw new Error("ActivityLog.init() must be called first");
    return this.current;
  }
}
