import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Account } from "@my-ai-slaves/shared";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { AccountService } from "../src/services/account-service";
import { nullBroadcaster } from "../src/services/common";
import { openDataStores } from "../src/storage/data-stores";
import { memoryLogger, tempDir } from "./helpers";

const FAKE_CLAUDE = resolve(fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url)));

// The desktop app can run on any data folder, so a local account's CLI config folder must follow
// the data folder rather than the project checkout.
describe("account config folders", () => {
  async function setup() {
    await chmod(FAKE_CLAUDE, 0o755);
    const dataDir = join(await tempDir(), "somewhere", "data");
    const { stores } = await openDataStores({ dataDir, logger: memoryLogger() });
    await stores.settings.update((s) => {
      s.providers["claude-code"].binary = FAKE_CLAUDE;
    });
    return { dataDir, accounts: new AccountService(stores, createAdapters(), nullBroadcaster) };
  }

  const account = (configDir: string): Account => ({
    id: "old",
    label: "old",
    provider: "claude-code",
    host: null,
    configDir,
    binary: null,
    status: "unknown",
    limitedUntil: null,
    lastLimitReason: null,
    mcpConfigPath: null,
    hidden: false,
    createdAt: "2026-11-18T18:02:00+08:00",
    updatedAt: "2026-11-18T18:02:00+08:00",
  });

  it("stores new accounts relative to the data folder", async () => {
    const { dataDir, accounts } = await setup();
    await accounts.create("work", "claude-code");
    const [created] = await accounts.listRaw();
    expect(created!.configDir).toBe(join("cli-config", "work"));
    expect(accounts.configDirOf(created!)).toBe(join(dataDir, "cli-config", "work"));
  });

  it("resolves older project-relative entries inside the current data folder", async () => {
    const { dataDir, accounts } = await setup();
    expect(accounts.configDirOf(account(".data/cli-config/old"))).toBe(join(dataDir, "cli-config", "old"));
  });

  it("keeps absolute entries and has none for remote accounts", async () => {
    const { accounts } = await setup();
    expect(accounts.configDirOf(account("/elsewhere/cli-config/old"))).toBe("/elsewhere/cli-config/old");
    expect(accounts.configDirOf({ ...account(""), host: "dev" })).toBeNull();
  });
});
