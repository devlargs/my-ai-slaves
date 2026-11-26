import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DataFileRecovery, QueueFile, ReposFile, SettingsFile } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { DATA_SCHEMA_VERSION, JsonStore, NewerDataFileError } from "../src/storage/json-store";
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
      "schemaVersion",
      "basePrompt",
      "maxParallelTasks",
      "limitCooldownMinutes",
      "committers",
      "defaultCommitterId",
      "commitAvatars",
      "providers",
      "updatedAt",
    ]);
    expect(parsed.commitAvatars).toBe(false); // no Gravatar unless turned on
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

  it("gives older committers no label and turns a blank label into none", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        committers: [
          { id: "a", name: "A", email: "a@example.com" },
          { id: "b", name: "B", email: "b@example.com", label: "   " },
          { id: "c", name: "C", email: "c@example.com", label: " Work " },
        ],
      }),
    );
    const { store } = await settingsStore(dir);
    await store.load();
    expect((await store.read()).committers.map((c) => c.label)).toEqual([null, null, "Work"]);
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
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "nextTaskNumber", "tasks"]);
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
      "model",
      "effort",
      "currentAccount",
      "checkout",
      "branch",
      "session",
      "replies",
      "pendingReply",
      "fallbacks",
      "resumeOnStart",
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

  it("drops only the invalid list items and keeps the rest", async () => {
    const dir = await tempDir();
    const file = join(dir, "settings.json");
    const good = (id: string) => ({ id, name: id.toUpperCase(), email: `${id}@example.com` });
    const original = JSON.stringify({
      basePrompt: "keep me",
      committers: [good("a"), { id: "b", name: "B" }, good("c"), { id: "d", email: 42 }],
    });
    await writeFile(file, original);
    const recoveries: DataFileRecovery[] = [];
    const logger = memoryLogger();
    const store = new JsonStore({ file, schema: SettingsFile, logger, now: fixedNow, onRecovery: (r) => recoveries.push(r) });

    expect(await store.load()).toBe("salvaged");
    const value = await store.read();
    expect(value.basePrompt).toBe("keep me");
    expect(value.committers.map((c) => c.id)).toEqual(["a", "c"]);
    expect(await readFile(join(dir, "settings.json.corrupt-2026-11-18T18-02-00"), "utf8")).toBe(original);
    expect(logger.warnings).toHaveLength(1);
    expect(recoveries).toEqual([
      expect.objectContaining({
        file,
        outcome: "salvaged",
        backup: join(dir, "settings.json.corrupt-2026-11-18T18-02-00"),
        dropped: ["committers.1", "committers.3"],
      }),
    ]);
    expect(recoveries[0]?.reason).toContain("committers.1");
  });

  it("drops an entry missing a required field, or just the bad item of a list inside one", async () => {
    const dir = await tempDir();
    const file = join(dir, "repos.json");
    const repo = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      path: `/code/${id}`,
      defaultBranch: "main",
      ...extra,
    });
    await writeFile(
      file,
      JSON.stringify({ repos: [repo("one"), repo("two", { path: "" }), repo("three", { labels: ["ok", 42] })] }),
    );
    const store = new JsonStore({ file, schema: ReposFile, logger: memoryLogger(), now: fixedNow });

    expect(await store.load()).toBe("salvaged");
    const { repos } = await store.read();
    expect(repos.map((r) => r.id)).toEqual(["one", "three"]);
    expect(repos[1]?.labels).toEqual(["ok"]);
  });

  it("refuses a file written by a newer version and leaves it alone", async () => {
    const dir = await tempDir();
    const file = join(dir, "settings.json");
    const newer = JSON.stringify({ schemaVersion: DATA_SCHEMA_VERSION + 1, basePrompt: 5 });
    await writeFile(file, newer);
    const { store } = await settingsStore(dir);

    await expect(store.load()).rejects.toBeInstanceOf(NewerDataFileError);
    await expect(store.load()).rejects.toThrow(/newer version/);
    expect(await readFile(file, "utf8")).toBe(newer);
    expect(await listDir(dir)).toEqual(["settings.json"]);
  });

  it("reports a reset file through onRecovery", async () => {
    const dir = await tempDir();
    const file = join(dir, "settings.json");
    await writeFile(file, "{ not json");
    const recoveries: DataFileRecovery[] = [];
    const store = new JsonStore({ file, schema: SettingsFile, logger: memoryLogger(), now: fixedNow, onRecovery: (r) => recoveries.push(r) });
    await store.load();
    expect(recoveries).toEqual([expect.objectContaining({ outcome: "recovered", dropped: [] })]);
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
