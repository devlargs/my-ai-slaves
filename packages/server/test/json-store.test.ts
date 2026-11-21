import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { QueueFile, SettingsFile } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { JsonStore } from "../src/storage/json-store";
import { fixedNow, listDir, memoryLogger, tempDir } from "./helpers";

async function settingsStore(dir: string, logger = memoryLogger()) {
  const store = new JsonStore({ file: join(dir, "settings.json"), schema: SettingsFile, logger, now: fixedNow });
  return { store, logger };
}

describe("JsonStore", () => {
  it("creates a missing file with blank defaults, pretty-printed", async () => {
    const dir = await tempDir();
    const { store } = await settingsStore(dir);

    expect(await store.load()).toBe("created");
    const raw = await readFile(store.file, "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.basePrompt).toBe("");
    expect(parsed.maxParallelTasks).toBe(2);
    expect(parsed.providers["claude-code"].permissionMode).toBe("auto");
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(Object.keys(parsed)).toEqual([
      "basePrompt",
      "maxParallelTasks",
      "limitCooldownMinutes",
      "committers",
      "defaultCommitterId",
      "providers",
      "updatedAt",
    ]);
    expect(parsed.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  it("loads an existing file and fills in fields missing from a hand edit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json"), '{ "basePrompt": "be terse" }');
    const { store, logger } = await settingsStore(dir);

    expect(await store.load()).toBe("loaded");
    const value = await store.read();
    expect(value.basePrompt).toBe("be terse");
    expect(value.maxParallelTasks).toBe(2);
    expect(logger.warnings).toEqual([]);
  });

  it("writes keys in canonical order no matter how the caller built the object", async () => {
    const dir = await tempDir();
    const store = new JsonStore({ file: join(dir, "queue.json"), schema: QueueFile, logger: memoryLogger() });
    await store.load();
    await store.update(() => ({
      tasks: [
        {
          updatedAt: "2026-11-18T18:05:00+08:00",
          status: "pending",
          message: "fix it",
          repo: "web",
          title: "fix it",
          id: "task_0001_fix-it",
          createdAt: "2026-11-18T18:05:00+08:00",
        } as never,
      ],
      nextTaskNumber: 2,
    }));

    const parsed = JSON.parse(await readFile(store.file, "utf8"));
    expect(Object.keys(parsed)).toEqual(["nextTaskNumber", "tasks"]);
    expect(Object.keys(parsed.tasks[0])).toEqual([
      "id",
      "title",
      "repo",
      "extraRepos",
      "status",
      "message",
      "attachments",
      "promptIds",
      "repoPromptIds",
      "accountOverride",
      "currentAccount",
      "checkout",
      "branch",
      "session",
      "replies",
      "pendingReply",
      "createdAt",
      "updatedAt",
    ]);
  });

  it("backs up invalid JSON on startup and starts fresh", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json"), "{ not json");
    const { store, logger } = await settingsStore(dir);

    expect(await store.load()).toBe("recovered");
    expect(await listDir(dir)).toEqual(["settings.json", "settings.json.corrupt-2026-11-18T18-02-00"]);
    expect(await readFile(join(dir, "settings.json.corrupt-2026-11-18T18-02-00"), "utf8")).toBe("{ not json");
    expect((await store.read()).basePrompt).toBe("");
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("invalid JSON");
  });

  it("backs up a file with the wrong shape", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json"), '{ "maxParallelTasks": "lots" }');
    const { store, logger } = await settingsStore(dir);

    expect(await store.load()).toBe("recovered");
    expect(logger.warnings[0]).toContain("maxParallelTasks");
  });

  it("does not overwrite an earlier backup", async () => {
    const dir = await tempDir();
    const { store } = await settingsStore(dir);
    await writeFile(store.file, "broken 1");
    await store.load();
    await writeFile(store.file, "broken 2");
    const again = new JsonStore({ file: store.file, schema: SettingsFile, logger: memoryLogger(), now: fixedNow });
    await again.load();

    expect(await listDir(dir)).toEqual([
      "settings.json",
      "settings.json.corrupt-2026-11-18T18-02-00",
      "settings.json.corrupt-2026-11-18T18-02-00-2",
    ]);
  });

  it("serialises concurrent updates so none are lost", async () => {
    const dir = await tempDir();
    const store = new JsonStore({ file: join(dir, "queue.json"), schema: QueueFile, logger: memoryLogger() });
    await store.load();

    await Promise.all(
      Array.from({ length: 100 }, () =>
        store.update((q) => {
          q.nextTaskNumber += 1;
        }),
      ),
    );
    const onDisk = JSON.parse(await readFile(store.file, "utf8"));
    expect(onDisk.nextTaskNumber).toBe(101);
    expect(await listDir(dir)).toEqual(["queue.json"]); // no .tmp left behind
  });

  it("rejects an invalid update and leaves the file untouched", async () => {
    const dir = await tempDir();
    const { store } = await settingsStore(dir);
    await store.load();
    const before = await readFile(store.file, "utf8");

    await expect(
      store.update((s) => {
        s.maxParallelTasks = 0;
      }),
    ).rejects.toThrow();
    expect(await readFile(store.file, "utf8")).toBe(before);
  });

  it("picks up a valid hand edit made while running", async () => {
    const dir = await tempDir();
    const { store } = await settingsStore(dir);
    await store.load();

    const edited = JSON.parse(await readFile(store.file, "utf8"));
    edited.basePrompt = "edited by hand";
    await writeFile(store.file, JSON.stringify(edited, null, 2));

    expect((await store.read()).basePrompt).toBe("edited by hand");
  });

  it("restores the last good version if a hand edit breaks the file while running", async () => {
    const dir = await tempDir();
    const { store, logger } = await settingsStore(dir);
    await store.load();
    await store.update((s) => {
      s.basePrompt = "good";
    });

    await writeFile(store.file, "{ oops");
    expect((await store.read()).basePrompt).toBe("good");
    expect(JSON.parse(await readFile(store.file, "utf8")).basePrompt).toBe("good");
    expect(await listDir(dir)).toContain("settings.json.corrupt-2026-11-18T18-02-00");
    expect(logger.warnings).toHaveLength(1);
  });

  it("removes a stale .tmp left by a crash", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "settings.json.tmp"), "half writ");
    const { store } = await settingsStore(dir);
    await store.load();
    expect(await listDir(dir)).toEqual(["settings.json"]);
  });
});
