import { readFile, stat } from "node:fs/promises";
import { type DataFileRecovery, formatLocalIso } from "@my-ai-slaves/shared";
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

/**
 * What `load()` found: an existing file, nothing (created fresh), a file with some invalid list items
 * (backed up, those items dropped, the rest kept), or a file that couldn't be saved at all (backed up, fresh).
 */
export type LoadOutcome = "loaded" | "created" | "salvaged" | "recovered";

/**
 * Written as `schemaVersion` at the top of every data file. Bump it when a release changes a file in a
 * way older builds can't read; an older build then refuses the file instead of replacing it.
 */
export const DATA_SCHEMA_VERSION = 1;

/** A file written by a newer build of the app. Nothing is touched; the server should refuse to start. */
export class NewerDataFileError extends Error {
  constructor(
    readonly file: string,
    readonly fileVersion: number,
  ) {
    super(
      `${file} was written by a newer version of My AI Slaves (data version ${fileVersion}; this build reads up to ` +
        `${DATA_SCHEMA_VERSION}). Update the app, or point it at another data folder. The file was left as it is.`,
    );
    this.name = "NewerDataFileError";
  }
}


export interface JsonStoreOptions<T> {
  file: string;
  /** Validates, fills missing fields with defaults, and fixes key order. */
  schema: z.ZodType<T>;
  /** Raw input for a fresh file; run through `schema`. Defaults to `{}`. */
  defaults?: () => unknown;
  logger?: Logger;
  now?: () => Date;
  /** Told about every file that had to be backed up and repaired. */
  onRecovery?: (recovery: DataFileRecovery) => void;
}

type ParseResult<T> =
  | { ok: true; value: T; dropped: string[] }
  | { ok: false; reason: string; newerVersion?: number };

/** At most this many repair passes; each drops every list item the schema rejected. */
const MAX_SALVAGE_PASSES = 50;

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
  private readonly onRecovery: (recovery: DataFileRecovery) => void;
  private value: T | null = null;
  /** mtime+size of the file as of our last read/write; a mismatch means someone edited it. */
  private diskStamp: string | null = null;

  constructor(options: JsonStoreOptions<T>) {
    this.file = options.file;
    this.schema = options.schema;
    this.defaults = options.defaults ?? (() => ({}));
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => new Date());
    this.onRecovery = options.onRecovery ?? (() => {});
  }

  /**
   * Startup load. Missing → created. Some invalid list items → backed up as `<file>.corrupt-<time>`,
   * those items dropped, the rest kept. Otherwise unreadable → backed up and created fresh.
   * Written by a newer build → throws `NewerDataFileError` and leaves the file alone.
   */
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
  // biome-ignore lint/suspicious/noConfusingVoidType: a mutator may return a new value or just edit the draft
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

    const parsed = this.parse(raw, { salvage: true });
    if (!parsed.ok) {
      if (parsed.newerVersion !== undefined) throw new NewerDataFileError(this.file, parsed.newerVersion);
      const backup = await backupCorrupt(this.file, this.now());
      this.logger.warn(
        `${this.file} was unreadable (${parsed.reason}). Backed it up to ${backup} and started fresh.`,
      );
      await this.writeNow(this.schema.parse(this.defaults()));
      this.report({ outcome: "recovered", backup, reason: parsed.reason, dropped: [] });
      return "recovered";
    }
    if (parsed.dropped.length > 0) {
      const reason = this.describeFailure(raw);
      const backup = await backupCorrupt(this.file, this.now());
      this.logger.warn(
        `${this.file} had invalid entries (${reason}). Backed it up to ${backup} and dropped ` +
          `${parsed.dropped.join(", ")}; everything else was kept.`,
      );
      await this.writeNow(parsed.value);
      this.report({ outcome: "salvaged", backup, reason, dropped: parsed.dropped });
      return "salvaged";
    }

    // Rewrite if normalising changed anything (missing defaults filled, key order, formatting).
    if (this.serialize(parsed.value) !== raw) {
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

    const parsed = this.parse(await readFile(this.file, "utf8"), { salvage: false });
    if (!parsed.ok && parsed.newerVersion !== undefined) throw new NewerDataFileError(this.file, parsed.newerVersion);
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

  private parse(raw: string, { salvage }: { salvage: boolean }): ParseResult<T> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
    }
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const { schemaVersion, ...rest } = json as Record<string, unknown>;
      if (typeof schemaVersion === "number" && schemaVersion > DATA_SCHEMA_VERSION) {
        return { ok: false, reason: `newer data version ${schemaVersion}`, newerVersion: schemaVersion };
      }
      json = rest;
    }

    const dropped: string[] = [];
    for (let pass = 0; ; pass++) {
      const result = this.schema.safeParse(json);
      if (result.success) return { ok: true, value: result.data, dropped };
      const removed = salvage && pass < MAX_SALVAGE_PASSES ? dropInvalidItems(json, result.error.issues) : [];
      if (removed.length === 0) return { ok: false, reason: `unexpected shape: ${describeIssues(result.error.issues)}` };
      dropped.push(...removed);
    }
  }

  /** The first problems in `raw`, as `parse` would describe them without salvaging. */
  private describeFailure(raw: string): string {
    const parsed = this.parse(raw, { salvage: false });
    return parsed.ok ? "" : parsed.reason;
  }

  private report(recovery: Omit<DataFileRecovery, "file" | "at">): void {
    this.onRecovery({ file: this.file, at: formatLocalIso(this.now()), ...recovery });
  }

  private serialize(value: T): string {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return toPrettyJson({ schemaVersion: DATA_SCHEMA_VERSION, ...(value as Record<string, unknown>) });
    }
    return toPrettyJson(value);
  }

  private async writeNow(value: T): Promise<void> {
    await writeFileAtomic(this.file, this.serialize(value));
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

type Issue = { path: readonly PropertyKey[]; message: string };

function describeIssues(issues: readonly Issue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Removes, in place, the innermost list item each issue points into (an issue on a list itself, like
 * "too short", removes the item that list sits in). Returns the removed items' paths; empty when an
 * issue isn't inside any list, so nothing can be dropped without losing the whole file.
 */
function dropInvalidItems(json: unknown, issues: readonly Issue[]): string[] {
  const targets = new Map<unknown[], Set<number>>();
  const paths = new Set<string>();
  for (const issue of issues) {
    let node: unknown = json;
    let found: { list: unknown[]; index: number; path: string } | null = null;
    for (let i = 0; i < issue.path.length; i++) {
      const key = issue.path[i];
      if (Array.isArray(node) && typeof key === "number" && key >= 0 && key < node.length) {
        found = { list: node, index: key, path: issue.path.slice(0, i + 1).map(String).join(".") };
      }
      if (node === null || typeof node !== "object") break;
      node = (node as Record<PropertyKey, unknown>)[key as PropertyKey];
    }
    if (!found) return [];
    const indexes = targets.get(found.list) ?? new Set<number>();
    targets.set(found.list, indexes);
    indexes.add(found.index);
    paths.add(found.path);
  }
  for (const [list, indexes] of targets) {
    for (const index of [...indexes].sort((a, b) => b - a)) list.splice(index, 1);
  }
  return [...paths];
}
