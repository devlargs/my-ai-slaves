import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptLibrary } from "../src/services/prompt-library";
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
    expect(Object.keys(file.prompts[0]!)).toEqual(["id", "name", "body", "createdAt", "updatedAt"]);
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
