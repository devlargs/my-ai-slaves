import { appendFile, mkdir, readdir, readFile, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { ActivityEntry, ActivityFile, formatLocalIso, TokenUsage, type UsageRecord } from "@my-ai-slaves/shared";
import { z } from "zod";
import { backupCorrupt, consoleLogger, isNotFound, type Logger, removeStaleTmp, writeFileAtomic } from "./fs-utils";
import { enqueueFileJob } from "./write-queue";

export const DEFAULT_ACTIVITY_MAX_BYTES = 5 * 1024 * 1024;

/** `NNNN_activity.jsonl` (one entry per line, appended to) or the older `NNNN_activity.json` (read only). */
const FILE_RE = /^(\d{4,})_activity\.(jsonl|json)$/;
const TMP_RE = /^(\d{4,}_activity\.json|activity-index\.json)\.tmp$/;
/** Summaries, usage and the task → files map, so a restart doesn't parse every activity file. */
export const ACTIVITY_INDEX_FILE = "activity-index.json";
const INDEX_VERSION = 1;

export const activityFileName = (n: number) => `${String(n).padStart(4, "0")}_activity.jsonl`;
const byteLength = (s: string) => Buffer.byteLength(s, "utf8");
const entryLine = (entry: ActivityEntry) => `${JSON.stringify(entry)}\n`;

/** The file new entries go to: its entries stay in memory, new lines wait in `pending` until written. */
class CurrentFile {
  readonly entries: ActivityEntry[] = [];
  /** Bytes in the file once every pending line is written. */
  bytes = 0;
  pending: string[] = [];
  pendingWrite: Promise<void> | null = null;

  constructor(
    readonly number: number,
    readonly name: string,
    readonly path: string,
  ) {}

  get count(): number {
    return this.entries.length;
  }
}

export interface ActivityLogOptions {
  dir: string;
  /** Rotate before a file would exceed this. Default 5 MB. */
  maxBytes?: number;
  /**
   * Wait this long before writing, so a burst of appends (a run streaming tool calls) becomes one
   * append to the file instead of one per entry. Default 0 (write as soon as possible).
   */
  flushDelayMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export type NewActivityEntry = Omit<ActivityEntry, "at"> & { at?: string };

/**
 * What the History list needs from one task's entries, kept up to date as entries are appended so the
 * list never has to read and parse every activity file.
 */
export interface TaskSummary {
  taskId: string;
  /** `at` of the task's first entry. */
  firstAt: string;
  /** The first "queued" entry's data (title, message). */
  queued: Record<string, unknown> | null;
  /** The last entry whose event is a terminal one (see `TERMINAL_EVENTS`). */
  terminal: { event: string; repo: string; at: string } | null;
  /** The last "started" entry's data (ref / branch). */
  started: Record<string, unknown> | null;
  /** The account of the last entry that had one. */
  lastAccount: string | null;
}

export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "kept",
  "pushed",
  "marked-finished",
  "discarded",
  "failed",
  "cancelled",
]);

const ActivityIndex = z.object({
  version: z.literal(INDEX_VERSION),
  /** Every activity file the index covers, with its size in bytes at that point. */
  files: z.record(z.string(), z.number().int().nonnegative()),
  tasks: z.record(z.string(), z.array(z.string())),
  summaries: z.array(
    z.object({
      taskId: z.string(),
      firstAt: z.string(),
      queued: z.record(z.string(), z.unknown()).nullable(),
      terminal: z.object({ event: z.string(), repo: z.string(), at: z.string() }).nullable(),
      started: z.record(z.string(), z.unknown()).nullable(),
      lastAccount: z.string().nullable(),
    }),
  ),
  usage: z.array(
    z.object({ at: z.string(), taskId: z.string(), repo: z.string(), account: z.string(), usage: TokenUsage }),
  ),
});
type ActivityIndex = z.infer<typeof ActivityIndex>;

interface DiskFile {
  name: string;
  number: number;
  legacy: boolean;
  path: string;
  size: number;
}

/**
 * Append-only task history spread over `0001_activity.jsonl`, `0002_…`, …, one JSON entry per line.
 * - Writing only appends the new lines (never rewrites a file). Before appending, if the current file
 *   plus the entry would pass `maxBytes`, a new file is started. An entry is never split; one bigger
 *   than `maxBytes` gets a file to itself.
 * - Appends that arrive while a write is waiting are batched into one append.
 * - Older `NNNN_activity.json` files (one JSON document each) are still read, never written.
 * - `activity-index.json` keeps the summaries and usage so a restart only reads what the index doesn't
 *   cover yet (the current file, plus whatever was written after the index was last saved).
 */
export class ActivityLog {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private current: CurrentFile | null = null;
  /** taskId → names of the files holding its entries, oldest first. */
  private index = new Map<string, string[]>();
  private summaries = new Map<string, TaskSummary>();
  /** Every run's token usage (from entries carrying `data.usage`), oldest first, for Statistics. */
  private usage: UsageRecord[] = [];
  /** Finished files (not the current one) and their sizes, as recorded in the index. */
  private finished: Record<string, number> = {};
  private flushDelayMs: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private startDelayed: (() => void) | null = null;
  private historyVersionValue = 0;

  constructor(options: ActivityLogOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_ACTIVITY_MAX_BYTES;
    this.flushDelayMs = options.flushDelayMs ?? 0;
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => new Date());
  }

  private get indexPath(): string {
    return join(this.dir, ACTIVITY_INDEX_FILE);
  }

  /** Load the index, read what it doesn't cover, back up unreadable files, open the latest file. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir);
    await Promise.all(names.filter((n) => TMP_RE.test(n)).map((n) => rm(join(this.dir, n), { force: true })));

    const files: DiskFile[] = [];
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      const path = join(this.dir, name);
      await removeStaleTmp(path);
      const size = (await stat(path)).size;
      files.push({ name, number: Number(match[1]), legacy: match[2] === "json", path, size });
    }
    files.sort((a, b) => a.number - b.number || Number(b.legacy) - Number(a.legacy));

    const saved = await this.loadIndex();
    const covered = saved && this.indexMatches(saved, files) ? saved : null;
    if (covered) {
      this.index = new Map(Object.entries(covered.tasks).map(([k, v]) => [k, [...v]]));
      this.summaries = new Map(covered.summaries.map((s) => [s.taskId, s]));
      this.usage = covered.usage;
    } else if (saved) {
      this.logger.info(`${this.indexPath} doesn't match the activity files; rebuilding it.`);
    }

    let changed = !covered;
    const last = files.at(-1);
    for (const file of files) {
      const isLast = file === last;
      const indexedSize = covered?.files[file.name];
      if (indexedSize === file.size && !(isLast && !file.legacy)) continue;
      const from = indexedSize ?? 0;

      if (file.legacy) {
        const entries = await this.readLegacy(file.path, true);
        if (entries) for (const entry of entries) this.track(entry, file.name);
        changed = true;
        if (entries) this.finished[file.name] = file.size;
        continue;
      }

      const { entries, offsets, goodBytes } = await this.readLines(file.path, file.size);
      if (goodBytes < file.size) {
        // A crash mid-append left a partial last line: drop it so the next line starts clean.
        await truncate(file.path, goodBytes);
        this.logger.warn(`${file.path} ended in a partial entry (a crash mid-write); it was dropped.`);
      }
      entries.forEach((entry, i) => {
        if ((offsets[i] as number) >= from) this.track(entry, file.name);
      });
      if (goodBytes !== indexedSize) changed = true;

      if (isLast) {
        const current = new CurrentFile(file.number, file.name, file.path);
        current.entries.push(...entries);
        current.bytes = goodBytes;
        this.current = current;
      } else {
        this.finished[file.name] = goodBytes;
      }
    }
    if (covered) for (const [name, size] of Object.entries(covered.files)) this.finished[name] ??= size;
    if (this.current) delete this.finished[this.current.name];

    // The newest file is an old-format one (or there are none): new entries start a fresh .jsonl file.
    this.current ??= this.newFile(last ? last.number + 1 : 1);
    if (changed) await this.saveIndex();
  }

  /** Name of the file new entries currently go to. */
  get currentFile(): string {
    return this.requireCurrent().name;
  }

  /** Goes up whenever the History list could have changed (a task ended, or an ended task got an entry). */
  get historyVersion(): number {
    return this.historyVersionValue;
  }

  async append(input: NewActivityEntry): Promise<ActivityEntry> {
    const entry = ActivityEntry.parse({ ...input, at: input.at ?? formatLocalIso(this.now()) });
    const line = entryLine(entry);
    const lineBytes = byteLength(line);

    let target = this.requireCurrent();
    if (target.count > 0 && target.bytes + lineBytes > this.maxBytes) {
      const done = target;
      this.startDelayed?.(); // the old file is done: write it now, not after the delay
      const lastWrite = done.pendingWrite;
      this.finished[done.name] = done.bytes;
      target = this.newFile(done.number + 1);
      this.current = target;
      // Saved once the old file's lines are on disk, so the index never claims bytes that aren't there.
      void (lastWrite ?? Promise.resolve())
        .then(() => this.saveIndex())
        .catch((error: unknown) => this.logger.warn(`Couldn't save ${this.indexPath}: ${(error as Error).message}`));
    }
    target.entries.push(entry);
    target.pending.push(line);
    target.bytes += lineBytes;
    this.track(entry, target.name);
    await this.flush(target);
    return entry;
  }

  /** Write anything still waiting out the flush delay and save the index (call before the process exits). */
  async close(): Promise<void> {
    this.flushDelayMs = 0; // anything logged while shutting down is written straight away
    const current = this.current;
    this.startDelayed?.();
    if (current?.pendingWrite) await current.pendingWrite.catch(() => {});
    await this.saveIndex().catch((error: unknown) =>
      this.logger.warn(`Couldn't save ${this.indexPath}: ${(error as Error).message}`),
    );
  }

  /** Every recorded run's token usage, oldest first. */
  usageRecords(): UsageRecord[] {
    return [...this.usage];
  }

  /** One summary per task that has entries (any order). */
  taskSummaries(): TaskSummary[] {
    return [...this.summaries.values()];
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
      result.push(...(await this.readFile(name)).filter((e) => e.taskId === taskId));
    }
    return result;
  }

  /** Every entry in every file, oldest first. */
  async readAll(): Promise<ActivityEntry[]> {
    const current = this.requireCurrent();
    const names = (await readdir(this.dir))
      .filter((n) => FILE_RE.test(n) && n !== current.name)
      .sort((a, b) => Number(FILE_RE.exec(a)?.[1]) - Number(FILE_RE.exec(b)?.[1]));
    const result: ActivityEntry[] = [];
    for (const name of names) result.push(...(await this.readFile(name)));
    result.push(...current.entries);
    return result;
  }

  /** A finished file's entries (either format); unreadable parts are skipped with a warning. */
  private async readFile(name: string): Promise<ActivityEntry[]> {
    const path = join(this.dir, name);
    try {
      // Queued behind any pending write to that file, so we never read a stale version.
      return await enqueueFileJob(path, async () => {
        if (name.endsWith(".json")) return (await this.readLegacy(path, false)) ?? [];
        return (await this.readLines(path)).entries;
      });
    } catch (error) {
      this.logger.warn(`Skipped ${path} while reading history: ${(error as Error).message}`);
      return [];
    }
  }

  /** An old-format file's entries; `null` if it is unreadable (backed up first when `backup`). */
  private async readLegacy(path: string, backup: boolean): Promise<ActivityEntry[] | null> {
    try {
      return ActivityFile.parse(JSON.parse(await readFile(path, "utf8"))).entries;
    } catch (error) {
      if (!backup) throw error;
      const moved = await backupCorrupt(path, this.now());
      this.logger.warn(
        `${path} was unreadable (${(error as Error).message.split("\n")[0]}). ` +
          `Backed it up to ${moved}; its entries are left out of history.`,
      );
      return null;
    }
  }

  /**
   * A .jsonl file's entries, each with the byte offset its line starts at. Lines that don't parse are
   * skipped (with one warning per file). `goodBytes` ends after the last complete line.
   */
  private async readLines(
    path: string,
    size?: number,
  ): Promise<{ entries: ActivityEntry[]; offsets: number[]; goodBytes: number }> {
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      if (isNotFound(error)) return { entries: [], offsets: [], goodBytes: 0 };
      throw error;
    }
    if (size !== undefined && buffer.length > size) buffer = buffer.subarray(0, size);
    const entries: ActivityEntry[] = [];
    const offsets: number[] = [];
    let bad = 0;
    let start = 0;
    for (;;) {
      const end = buffer.indexOf(10, start);
      if (end === -1) break;
      const text = buffer.toString("utf8", start, end).trim();
      if (text) {
        const parsed = ActivityEntry.safeParse(safeJson(text));
        if (parsed.success) {
          entries.push(parsed.data);
          offsets.push(start);
        } else {
          bad++;
        }
      }
      start = end + 1;
    }
    if (bad > 0) this.logger.warn(`Skipped ${bad} unreadable line(s) in ${path}.`);
    return { entries, offsets, goodBytes: start };
  }

  /** Whether a saved index still describes these files (so only newer data has to be read). */
  private indexMatches(saved: ActivityIndex, files: DiskFile[]): boolean {
    const byName = new Map(files.map((f) => [f.name, f]));
    let highestIndexed = 0;
    for (const [name, size] of Object.entries(saved.files)) {
      const file = byName.get(name);
      if (!file) return false;
      // Only an appended-to file may have grown since; nothing may have shrunk.
      if (file.size < size || (file.legacy && file.size !== size)) return false;
      highestIndexed = Math.max(highestIndexed, file.number);
    }
    // A file the index doesn't know that sits among the ones it does (e.g. one restored by hand).
    return files.every((f) => f.name in saved.files || f.number > highestIndexed);
  }

  private async loadIndex(): Promise<ActivityIndex | null> {
    try {
      return ActivityIndex.parse(JSON.parse(await readFile(this.indexPath, "utf8")));
    } catch (error) {
      if (!isNotFound(error)) this.logger.info(`${this.indexPath} was unreadable; rebuilding it.`);
      return null;
    }
  }

  /** Snapshot of the in-memory state, taken now; it covers every line appended so far. */
  private saveIndex(): Promise<void> {
    const files: Record<string, number> = { ...this.finished };
    if (this.current && this.current.bytes > 0) files[this.current.name] = this.current.bytes;
    const index: ActivityIndex = {
      version: INDEX_VERSION,
      files,
      tasks: Object.fromEntries(this.index),
      summaries: [...this.summaries.values()],
      usage: this.usage,
    };
    const content = `${JSON.stringify(index)}\n`;
    return enqueueFileJob(this.indexPath, () => writeFileAtomic(this.indexPath, content));
  }

  private newFile(number: number): CurrentFile {
    const name = activityFileName(number);
    return new CurrentFile(number, name, join(this.dir, name));
  }

  /** Append `state`'s pending lines soon; appends made before the write starts share it. */
  private flush(state: CurrentFile): Promise<void> {
    if (!state.pendingWrite) {
      const write = () =>
        enqueueFileJob(state.path, async () => {
          state.pendingWrite = null;
          const lines = state.pending;
          state.pending = [];
          try {
            await appendFile(state.path, lines.join(""), "utf8");
          } catch (error) {
            state.pending = [...lines, ...state.pending]; // tried again with the next write
            throw error;
          }
        });
      if (this.flushDelayMs <= 0) {
        state.pendingWrite = write();
      } else {
        state.pendingWrite = new Promise<void>((resolve, reject) => {
          const start = () => {
            if (this.flushTimer) clearTimeout(this.flushTimer);
            this.flushTimer = null;
            this.startDelayed = null;
            write().then(resolve, reject);
          };
          this.flushTimer = setTimeout(start, this.flushDelayMs);
          this.startDelayed = start;
        });
      }
    }
    return state.pendingWrite;
  }

  /** Add an entry to the task → files map, its task's summary and the usage list. */
  private track(entry: ActivityEntry, fileName: string): void {
    const files = this.index.get(entry.taskId);
    if (!files) this.index.set(entry.taskId, [fileName]);
    else if (files.at(-1) !== fileName) files.push(fileName);

    let s = this.summaries.get(entry.taskId);
    if (!s) {
      s = { taskId: entry.taskId, firstAt: entry.at, queued: null, terminal: null, started: null, lastAccount: null };
      this.summaries.set(entry.taskId, s);
    }
    const ended = s.terminal !== null;
    if (entry.event === "queued" && !s.queued) s.queued = pick(entry.data, ["title", "message"]);
    if (entry.event === "started") s.started = pick(entry.data, ["ref", "branch"]);
    if (TERMINAL_EVENTS.has(entry.event)) s.terminal = { event: entry.event, repo: entry.repo, at: entry.at };
    if (entry.account) s.lastAccount = entry.account;
    if (ended || s.terminal) this.historyVersionValue++;
    if (entry.account && entry.data?.usage) {
      const usage = TokenUsage.safeParse(entry.data.usage);
      if (usage.success) {
        this.usage.push({ at: entry.at, taskId: entry.taskId, repo: entry.repo, account: entry.account, usage: usage.data });
      }
    }
  }

  private requireCurrent(): CurrentFile {
    if (!this.current) throw new Error("ActivityLog.init() must be called first");
    return this.current;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Only the fields a summary needs, so it doesn't keep a run's whole prompt alive. */
function pick(data: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (data && key in data) out[key] = data[key];
  return out;
}
