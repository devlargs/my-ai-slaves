import { appendFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActivityEntry } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { ACTIVITY_INDEX_FILE, ActivityLog, type NewActivityEntry } from "../src/storage/activity-log";
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

const readLines = async (dir: string, name: string) =>
  (await readFile(join(dir, name), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => ActivityEntry.parse(JSON.parse(line)));

const activityFiles = async (dir: string) => (await listDir(dir)).filter((n) => /_activity\.jsonl?$/.test(n));

describe("ActivityLog", () => {
  it("starts 0001_activity.jsonl on first start and writes it on the first entry", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    expect(log.currentFile).toBe("0001_activity.jsonl");
    expect(await activityFiles(dir)).toEqual([]);
    await log.append(entry("task_a", "first"));
    expect(await activityFiles(dir)).toEqual(["0001_activity.jsonl"]);
  });

  it("writes one JSON entry per line, keys in spec order, and only ever appends", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_0042_fix-login-redirect", "first"));
    const before = await readFile(join(dir, "0001_activity.jsonl"), "utf8");
    await log.append(
      entry("task_0042_fix-login-redirect", "work_1-claude hit usage limit, retrying on work_2-cursor", {
        event: "fallback",
        data: { from: "work_1-claude", to: "work_2-cursor", note: "ünïcödé ✓" },
      }),
    );

    const raw = await readFile(join(dir, "0001_activity.jsonl"), "utf8");
    expect(raw.startsWith(before)).toBe(true);
    const lines = raw.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    const second = JSON.parse(lines[1] as string);
    expect(Object.keys(second)).toEqual(["at", "taskId", "repo", "account", "event", "detail", "data"]);
    expect(second.data.note).toBe("ünïcödé ✓");
    expect(JSON.parse(lines[0] as string).at).toBe("2026-11-18T18:02:00+08:00");
  });

  it("rotates before a file would pass the limit, never splitting an entry", async () => {
    const dir = await tempDir();
    const maxBytes = 1200;
    const { log } = await openLog(dir, maxBytes);
    for (let i = 0; i < 40; i++) await log.append(entry(`task_000${i % 3}_x`, `entry ${i}`));

    const names = await activityFiles(dir);
    expect(names.length).toBeGreaterThan(3);
    expect(names).toEqual(names.map((_, i) => `${String(i + 1).padStart(4, "0")}_activity.jsonl`));

    let total = 0;
    for (const name of names) {
      expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(maxBytes);
      total += (await readLines(dir, name)).length;
    }
    expect(total).toBe(40);
  });

  it("the size check is exact: a file can land right at the limit", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_0001_a", "one"));
    await log.append(entry("task_0001_a", "two"));
    const exactSize = (await stat(join(dir, "0001_activity.jsonl"))).size;

    const dir2 = await tempDir();
    const { log: tight } = await openLog(dir2, exactSize);
    await tight.append(entry("task_0001_a", "one"));
    await tight.append(entry("task_0001_a", "two"));
    expect(await activityFiles(dir2)).toEqual(["0001_activity.jsonl"]);
    await tight.append(entry("task_0001_a", "three"));
    expect(await activityFiles(dir2)).toEqual(["0001_activity.jsonl", "0002_activity.jsonl"]);
  });

  it("gives an entry bigger than the limit a file of its own", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 800);
    await log.append(entry("task_0001_a", "small"));
    await log.append(entry("task_0001_a", "big", { data: { prompt: "x".repeat(5000) } }));
    await log.append(entry("task_0001_a", "small again"));

    const names = await activityFiles(dir);
    expect(names).toEqual(["0001_activity.jsonl", "0002_activity.jsonl", "0003_activity.jsonl"]);
    expect((await readLines(dir, "0002_activity.jsonl")).map((e) => e.detail)).toEqual(["big"]);
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
    await log.close();
    const filesBefore = await activityFiles(dir);

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

  it("drops a partial last line left by a crash, and skips unreadable lines", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_a", "one"));
    await log.append(entry("task_a", "two"));
    const path = join(dir, "0001_activity.jsonl");
    const goodSize = (await stat(path)).size;
    await appendFile(path, '{"at":"2026-11-18T18:02:00+08:00","taskId":"tas');

    const { log: reopened, logger } = await openLog(dir);
    expect(logger.warnings).toHaveLength(1);
    expect((await stat(path)).size).toBe(goodSize);
    await reopened.append(entry("task_a", "three"));
    expect((await readLines(dir, "0001_activity.jsonl")).map((e) => e.detail)).toEqual(["one", "two", "three"]);

    await writeFile(path, `not json\n${await readFile(path, "utf8")}`);
    const { log: again, logger: logger2 } = await openLog(dir);
    expect(logger2.warnings.some((w) => w.includes("1 unreadable line"))).toBe(true);
    expect((await again.forTask("task_a")).map((e) => e.detail)).toEqual(["one", "two", "three"]);
  });

  it("reads older NNNN_activity.json files and starts the next number as .jsonl", async () => {
    const dir = await tempDir();
    const legacy = (name: string, entries: ActivityEntry[]) =>
      writeFile(join(dir, name), `${JSON.stringify({ file: name, createdAt: "2026-11-18T18:02:00+08:00", entries }, null, 2)}\n`);
    const at = "2026-11-18T18:02:00+08:00";
    await legacy("0001_activity.json", [{ at, taskId: "task_a", repo: "r", account: null, event: "queued", detail: "q", data: { title: "A" } }]);
    await legacy("0002_activity.json", [{ at, taskId: "task_a", repo: "r", account: "acc", event: "kept", detail: "k" }]);

    const { log } = await openLog(dir);
    expect(log.currentFile).toBe("0003_activity.jsonl");
    expect(log.taskSummaries()[0]).toMatchObject({ queued: { title: "A" }, terminal: { event: "kept" }, lastAccount: "acc" });
    await log.append(entry("task_a", "later"));
    expect((await log.forTask("task_a")).map((e) => e.detail)).toEqual(["q", "k", "later"]);
    expect(await activityFiles(dir)).toEqual(["0001_activity.json", "0002_activity.json", "0003_activity.jsonl"]);
  });

  it("backs up an unreadable old-format file and leaves it out", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "0001_activity.json"), "{ truncated");
    const { log, logger } = await openLog(dir);
    expect(logger.warnings).toHaveLength(1);
    expect(await listDir(dir)).toContain("0001_activity.json.corrupt-2026-11-18T18-02-00");
    expect(log.currentFile).toBe("0002_activity.jsonl");
  });

  it("restarts from the saved index without re-reading finished files", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 600);
    for (let i = 0; i < 10; i++) await log.append(entry(`task_${i % 2}`, `n${i}`, i === 8 ? { event: "kept" } : {}));
    await log.close();
    const names = await activityFiles(dir);
    expect(names.length).toBeGreaterThan(2);
    const summaries = log.taskSummaries();

    // Break a finished file without changing its size: a restart that trusts the index never notices.
    const first = join(dir, names[0] as string);
    const size = (await stat(first)).size;
    await writeFile(first, `${"x".repeat(size - 1)}\n`);
    const { log: reopened } = await openLog(dir, 600);
    expect(reopened.taskSummaries()).toEqual(summaries);
  });

  it("reads only what the index doesn't cover after a crash, without counting anything twice", async () => {
    const dir = await tempDir();
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: null };
    const { log } = await openLog(dir, 700);
    await log.append(entry("t1", "done", { event: "finished", data: { usage } }));
    await log.close();
    // No close() after these: the index is stale, as after a crash.
    for (let i = 0; i < 6; i++) await log.append(entry("t2", `n${i}`, { event: "finished", data: { usage } }));

    const { log: reopened } = await openLog(dir, 700);
    expect(reopened.usageRecords().map((r) => r.taskId)).toEqual(["t1", ...Array(6).fill("t2")]);
    expect(await reopened.forTask("t2")).toHaveLength(6);
  });

  it("rebuilds the index when it doesn't match the files", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir, 600);
    for (let i = 0; i < 10; i++) await log.append(entry("task_a", `n${i}`));
    await log.close();
    await rm(join(dir, "0001_activity.jsonl"));

    const { log: reopened } = await openLog(dir, 600);
    const history = await reopened.forTask("task_a");
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(10);
    await writeFile(join(dir, ACTIVITY_INDEX_FILE), "nonsense");
    const { log: third } = await openLog(dir, 600);
    expect(await third.forTask("task_a")).toHaveLength(history.length);
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
    expect(await activityFiles(dir)).toEqual([]);
    await log.close();
    expect((await readLines(dir, "0001_activity.jsonl")).map((e) => e.detail)).toEqual(["one", "two"]);
    await log.append(entry("task_a", "three")); // after close: no delay
    expect(await readLines(dir, "0001_activity.jsonl")).toHaveLength(3);
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
    await rm(join(dir, ACTIVITY_INDEX_FILE));
    const { log: rebuilt } = await openLog(dir, 600);
    expect(rebuilt.taskSummaries().find((s) => s.taskId === "task_a")).toEqual(expected);
  });

  it("moves historyVersion only when the History list could change", async () => {
    const dir = await tempDir();
    const { log } = await openLog(dir);
    await log.append(entry("task_a", "q", { event: "queued" }));
    await log.append(entry("task_a", "m"));
    expect(log.historyVersion).toBe(0);
    await log.append(entry("task_a", "k", { event: "kept" }));
    expect(log.historyVersion).toBe(1);
    await log.append(entry("task_b", "m"));
    expect(log.historyVersion).toBe(1);
    await log.append(entry("task_a", "late", { account: "other" }));
    expect(log.historyVersion).toBe(2);
  });

  it("keeps every run's token usage, across a restart, for Statistics", async () => {
    const dir = await tempDir();
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: null };
    const { log } = await openLog(dir);
    await log.append(entry("t1", "done", { event: "finished", data: { usage } }));
    await log.append(entry("t2", "no usage", { event: "finished", data: { result: "x" } }));
    await log.append(entry("t3", "bad usage", { event: "failed", data: { usage: "nope" } }));
    await log.close();
    const { log: reopened } = await openLog(dir);
    expect(reopened.usageRecords()).toEqual([
      { at: "2026-11-18T18:02:00+08:00", taskId: "t1", repo: "supertri-web", account: "work_1-claude", usage },
    ]);
  });
});
