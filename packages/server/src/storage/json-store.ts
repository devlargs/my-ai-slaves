import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";
import {
  backupCorrupt,
  consoleLogger,
  isNotFound,
  type Logger,
  removeStaleTmp,
  toPrettyJson,
  writeFileAtomic,
} from "./fs-utils";
import { enqueueFileJob } from "./write-queue";

/** What `load()` found: an existing file, nothing (created fresh), or a broken file (backed up, fresh). */
export type LoadOutcome = "loaded" | "created" | "recovered";

export interface JsonStoreOptions<T> {
  file: string;
  /** Validates, fills missing fields with defaults, and fixes key order. */
  schema: z.ZodType<T>;
  /** Raw input for a fresh file; run through `schema`. Defaults to `{}`. */
  defaults?: () => unknown;
  logger?: Logger;
  now?: () => Date;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * One JSON file, held in memory and written atomically.
 *
 * - Every operation goes through the file's write queue, so concurrent callers never clobber each other.
 * - Edits you make to the file by hand while the server runs are picked up on the next read/update.
 *   If such an edit leaves the file unreadable, it's backed up and the last good version is restored.
 */
export class JsonStore<T> {
  readonly file: string;
  private readonly schema: z.ZodType<T>;
  private readonly defaults: () => unknown;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private value: T | null = null;
  /** mtime+size of the file as of our last read/write; a mismatch means someone edited it. */
  private diskStamp: string | null = null;

  constructor(options: JsonStoreOptions<T>) {
    this.file = options.file;
    this.schema = options.schema;
    this.defaults = options.defaults ?? (() => ({}));
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** Startup load. Missing → created; unreadable → backed up as `<file>.corrupt-<time>` and created. */
  load(): Promise<LoadOutcome> {
    return enqueueFileJob(this.file, () => this.loadFromDisk());
  }

  /** Current contents (a copy; mutating it changes nothing). */
  read(): Promise<T> {
    return enqueueFileJob(this.file, async () => {
      await this.syncFromDisk();
      return structuredClone(this.value as T);
    });
  }

  /**
   * Change the file. `mutator` gets a copy it may edit in place or replace by returning a new value.
   * The result is validated before writing; if invalid, this throws and the file is untouched.
   */
  update(mutator: (draft: T) => T | void): Promise<T> {
    return enqueueFileJob(this.file, async () => {
      await this.syncFromDisk();
      const draft = structuredClone(this.value as T);
      const result = mutator(draft);
      const next = this.schema.parse(result === undefined ? draft : result);
      await this.writeNow(next);
      return structuredClone(next);
    });
  }

  private async loadFromDisk(): Promise<LoadOutcome> {
    await removeStaleTmp(this.file);
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.writeNow(this.schema.parse(this.defaults()));
      return "created";
    }

    const parsed = this.parse(raw);
    if (!parsed.ok) {
      const backup = await backupCorrupt(this.file, this.now());
      this.logger.warn(
        `${this.file} was unreadable (${parsed.reason}). Backed it up to ${backup} and started fresh.`,
      );
      await this.writeNow(this.schema.parse(this.defaults()));
      return "recovered";
    }

    // Rewrite if normalising changed anything (missing defaults filled, key order, formatting).
    if (toPrettyJson(parsed.value) !== raw) {
      await this.writeNow(parsed.value);
    } else {
      this.value = parsed.value;
      this.diskStamp = await this.stampOnDisk();
    }
    return "loaded";
  }

  /** Must run inside the file's queue. */
  private async syncFromDisk(): Promise<void> {
    if (this.value === null) {
      await this.loadFromDisk();
      return;
    }
    const stamp = await this.stampOnDisk();
    if (stamp === this.diskStamp) return;

    if (stamp === null) {
      this.logger.warn(`${this.file} was deleted while the server was running. Restored the last known version.`);
      await this.writeNow(this.value);
      return;
    }

    const parsed = this.parse(await readFile(this.file, "utf8"));
    if (parsed.ok) {
      this.value = parsed.value;
      this.diskStamp = stamp;
      return;
    }
    const backup = await backupCorrupt(this.file, this.now());
    this.logger.warn(
      `${this.file} was edited into an unreadable state (${parsed.reason}). ` +
        `Backed up your edit to ${backup} and restored the last good version.`,
    );
    await this.writeNow(this.value);
  }

  private parse(raw: string): ParseResult<T> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
    }
    const result = this.schema.safeParse(json);
    if (result.success) return { ok: true, value: result.data };
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `unexpected shape: ${issues}` };
  }

  private async writeNow(value: T): Promise<void> {
    await writeFileAtomic(this.file, toPrettyJson(value));
    this.value = value;
    this.diskStamp = await this.stampOnDisk();
  }

  private async stampOnDisk(): Promise<string | null> {
    try {
      const s = await stat(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
