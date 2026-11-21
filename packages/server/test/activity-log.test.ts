import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActivityFile } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { ActivityLog, type NewActivityEntry } from "../src/storage/activity-log";
import { fixedNow, listDir, memoryLogger, tempDir } from "./helpers";

const entry = (taskId: string, detail: string, extra: Partial<NewActivityEntry> = {}): NewActivityEntry => ({
  taskId,
  repo: "supertri-web",
  account: "work_1-claude",
  event: "message",
  detail,
  ...extra,
});

async function openLog(dir: string, maxBytes?: number) {
  const logger = memoryLogger();
  const log = new ActivityLog({ dir, maxBytes, logger, now: fixedNow });
  await log.init();
  return { log, logger };
}

const readActivity = async (dir: string, name: string) =>
  ActivityFile.parse(JSON.parse(await readFile(join(dir, name), "utf8")));

describe("ActivityLog", () => {
  it("creates 0001_activity.json on first start", async () => {
    const dir = await tempDir();
    await openLog(dir);
    expect(await listDir(dir)).toEqual(["0001_activity.json"]);
    const raw = await readFile(join(dir, "0001_activity.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ file: "0001_activity.json", createdAt: "2026-11-18T18:02:00+08:00", entries: [] });
  });

  it("writes exactly what JSON.stringify(…, null, 2) would, with keys in spec order", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_0042_fix-login-redirect", "first"));
    await log.append(
      entry("task_0042_fix-login-redirect", "work_1-claude hit usage limit, retrying on work_2-cursor", {
        event: "fallback",
        data: { from: "work_1-claude", to: "work_2-cursor", note: "ünïcödé ✓" },
      }),
    );

    const raw = await readFile(join(dir, "0001_activity.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(Object.keys(parsed.entries[1])).toEqual(["at", "taskId", "repo", "account", "event", "detail", "data"]);
    expect(parsed.entries[0].at).toBe("2026-11-18T18:02:00+08:00");
  });

  it("rotates before a file would pass the limit, never splitting an entry", async () => {
    const dir = await tempDir();
    const maxBytes = 1200;
    const { log } = await openLog(dir, maxBytes);
    for (let i = 0; i < 40; i++) await log.append(entry(`task_000${i % 3}_x`, `entry ${i}`));

    const names = await listDir(dir);
    expect(names.length).toBeGreaterThan(3);
    expect(names).toEqual(names.map((_, i) => `${String(i + 1).padStart(4, "0")}_activity.json`));

    let total = 0;
    for (const name of names) {
      expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(maxBytes);
      const file = await readActivity(dir, name);
      expect(file.file).toBe(name);
      total += file.entries.length;
    }
    expect(total).toBe(40);
  });

  it("the size check is exact: a file can land right at the limit", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_0001_a", "one"));
    await log.append(entry("task_0001_a", "two"));
    const exactSize = (await stat(join(dir, "0001_activity.json"))).size;

    const dir2 = await tempDir();
    const { log: tight } = await openLog(dir2, exactSize);
    await tight.append(entry("task_0001_a", "one"));
    await tight.append(entry("task_0001_a", "two"));
    expect(await listDir(dir2)).toEqual(["0001_activity.json"]);
    await tight.append(entry("task_0001_a", "three"));
    expect(await listDir(dir2)).toEqual(["0001_activity.json", "0002_activity.json"]);
  });

  it("gives an entry bigger than the limit a file of its own", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 800);
    await log.append(entry("task_0001_a", "small"));
    await log.append(entry("task_0001_a", "big", { data: { prompt: "x".repeat(5000) } }));
    await log.append(entry("task_0001_a", "small again"));

    const names = await listDir(dir);
    expect(names).toEqual(["0001_activity.json", "0002_activity.json", "0003_activity.json"]);
    expect((await readActivity(dir, "0002_activity.json")).entries.map((e) => e.detail)).toEqual(["big"]);
  });

  it("reads a task's history across files, in order", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 1000);
    for (let i = 0; i < 30; i++) await log.append(entry(i % 2 ? "task_0002_b" : "task_0001_a", `n${i}`));

    const history = await log.forTask("task_0002_b");
    expect(history.map((e) => e.detail)).toEqual(Array.from({ length: 15 }, (_, i) => `n${i * 2 + 1}`));
    expect(await log.forTask("task_9999_none")).toEqual([]);
  });

  it("continues the latest file after a restart and still finds old history", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 1000);
    for (let i = 0; i < 12; i++) await log.append(entry("task_0001_a", `before ${i}`));
    const filesBefore = await listDir(dir);

    const { log: reopened } = await openLog(dir, 1000);
    expect(reopened.currentFile).toBe(filesBefore.at(-1));
    await reopened.append(entry("task_0001_a", "after restart"));

    const history = await reopened.forTask("task_0001_a");
    expect(history).toHaveLength(13);
    expect(history.at(-1)?.detail).toBe("after restart");
  });

  it("keeps every concurrent append, in call order", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 4000);
    await Promise.all(Array.from({ length: 200 }, (_, i) => log.append(entry("task_0001_a", `c${i}`))));

    const history = await log.forTask("task_0001_a");
    expect(history.map((e) => e.detail)).toEqual(Array.from({ length: 200 }, (_, i) => `c${i}`));

    const { log: reopened } = await openLog(dir, 4000);
    expect(await reopened.forTask("task_0001_a")).toHaveLength(200);
  });

  it("backs up an unreadable latest file and starts it fresh", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 1000);
    for (let i = 0; i < 12; i++) await log.append(entry("task_0001_a", `n${i}`));
    const names = await listDir(dir);
    const latest = names.at(-1) as string;
    await writeFile(join(dir, latest), "{ truncated");

    const { log: reopened, logger } = await openLog(dir, 1000);
    expect(logger.warnings).toHaveLength(1);
    expect(await listDir(dir)).toContain(`${latest}.corrupt-2026-11-18T18-02-00`);
    expect(reopened.currentFile).toBe(latest);
    expect((await readActivity(dir, latest)).entries).toEqual([]);
    // Entries in the older, intact files are still found.
    expect((await reopened.forTask("task_0001_a")).length).toBeGreaterThan(0);
  });

  it("rejects an entry with an unknown event", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await expect(log.append(entry("task_0001_a", "x", { event: "exploded" as never }))).rejects.toThrow();
  });

  it("batches appends made within the flush delay into one write, and close() writes right away", async () => {
    const dir = await tempDir();
    const log = new ActivityLog({ dir, logger: memoryLogger(), now: fixedNow, flushDelayMs: 60_000 });
    await log.init();
    void log.append(entry("task_a", "one"));
    void log.append(entry("task_a", "two"));
    expect((await readActivity(dir, "0001_activity.json")).entries).toHaveLength(0);
    await log.close();
    expect((await readActivity(dir, "0001_activity.json")).entries.map((e) => e.detail)).toEqual(["one", "two"]);
    await log.append(entry("task_a", "three")); // after close: no delay
    expect((await readActivity(dir, "0001_activity.json")).entries).toHaveLength(3);
  });

  it("keeps a per-task summary for History, rebuilt from the files after a restart", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 600);
    await log.append(entry("task_a", "q", { event: "queued", account: null, data: { title: "Fix it", message: "Fix it now", big: "x" } }));
    await log.append(entry("task_a", "s", { event: "started", data: { ref: "main", prompt: "long prompt" } }));
    await log.append(entry("task_a", "m".repeat(400)));
    await log.append(entry("task_a", "k", { event: "kept", account: "other-acct" }));
    await log.append(entry("task_b", "q", { event: "queued", data: { title: "B", message: "b" } }));
    const expected = {
      taskId: "task_a",
      firstAt: "2026-11-18T18:02:00+08:00",
      queued: { title: "Fix it", message: "Fix it now" },
      terminal: { event: "kept", repo: "supertri-web", at: "2026-11-18T18:02:00+08:00" },
      started: { ref: "main" },
      lastAccount: "other-acct",
    };
    expect(log.taskSummaries().find((s) => s.taskId === "task_a")).toEqual(expected);
    expect(log.taskSummaries().find((s) => s.taskId === "task_b")?.terminal).toBeNull();
    const { log: reopened } = await openLog(dir, 600);
    expect(reopened.taskSummaries().find((s) => s.taskId === "task_a")).toEqual(expected);
  });
});
