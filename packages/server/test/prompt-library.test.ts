import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptLibrary, RepoPromptList } from "../src/services/prompt-library";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

async function library() {
  const { stores } = await openDataStores({ dataDir: join(await tempDir(), "data"), logger: memoryLogger() });
  return { lib: new PromptLibrary(stores), stores };
}

describe("PromptLibrary", () => {
  it("creates readable ids from names and keeps them when renamed", async () => {
    const { lib, stores } = await library();
    const p = await lib.create("Analyze Jira ticket!", "steps");
    expect(p.id).toBe("analyze-jira-ticket");
    const renamed = await lib.update(p.id, { name: "Jira: analyze ticket", body: "new steps" });
    expect(renamed).toMatchObject({ id: "analyze-jira-ticket", name: "Jira: analyze ticket", body: "new steps" });
    const file = await stores.prompts.read();
    expect(Object.keys(file.prompts[0]!)).toEqual(["id", "name", "body", "attachments", "createdAt", "updatedAt"]);
  });

  it("refuses duplicate or empty names", async () => {
    const { lib } = await library();
    await lib.create("Plan first", "x");
    await expect(lib.create("plan FIRST", "y")).rejects.toThrow("already exists");
    await expect(lib.create("   ", "y")).rejects.toThrow("name");
  });

  it("reorders, validates into library order, and reports missing ids", async () => {
    const { lib } = await library();
    const a = await lib.create("A", "a");
    const b = await lib.create("B", "b");
    await lib.reorder([b.id, a.id]);
    expect((await lib.list()).map((p) => p.id)).toEqual(["b", "a"]);
    expect(await lib.validate(["a", "b"])).toEqual(["b", "a"]);
    await expect(lib.validate(["zzz"])).rejects.toThrow("Unknown saved prompt");
    await lib.remove("a");
    expect(await lib.resolve(["a", "b"])).toMatchObject({ missing: ["a"], prompts: [{ id: "b" }] });
  });
});

describe("RepoPromptList", () => {
  it("turns an old single base prompt into a default-ticked 'Base prompt' entry", async () => {
    const dir = join(await tempDir(), "data");
    await mkdir(join(dir, "knowledge"), { recursive: true });
    await writeFile(join(dir, "knowledge", "web.json"), JSON.stringify({ repo: "web", basePrompt: "USE PNPM" }));
    await writeFile(join(dir, "knowledge", "blank.json"), JSON.stringify({ repo: "blank", basePrompt: "" }));
    const { stores } = await openDataStores({ dataDir: dir, logger: memoryLogger() });

    const web = new RepoPromptList(stores, "web");
    expect(await web.list()).toMatchObject([{ id: "base-prompt", name: "Base prompt", body: "USE PNPM", default: true }]);
    expect(await web.defaultIds()).toEqual(["base-prompt"]);
    expect(await new RepoPromptList(stores, "blank").list()).toEqual([]);

    // Saved in the new shape on the next change.
    await web.create("Backend", "API NOTES");
    const raw = JSON.parse(await readFile(join(dir, "knowledge", "web.json"), "utf8"));
    expect(raw.basePrompt).toBeUndefined();
    expect(raw.prompts.map((p: { id: string; default: boolean }) => [p.id, p.default])).toEqual([
      ["base-prompt", true],
      ["backend", false],
    ]);
  });

  it("toggles default and keeps the list order as the send order", async () => {
    const { stores } = await openDataStores({ dataDir: join(await tempDir(), "data"), logger: memoryLogger() });
    const list = new RepoPromptList(stores, "web");
    const a = await list.create("A", "a", { default: true });
    const b = await list.create("B", "b");
    expect(await list.defaultIds()).toEqual([a.id]);
    await list.update(b.id, { default: true });
    await list.update(a.id, { default: false });
    await list.reorder([b.id, a.id]);
    expect(await list.defaultIds()).toEqual([b.id]);
    expect(await list.validate([a.id, b.id])).toEqual([b.id, a.id]);
  });
});
