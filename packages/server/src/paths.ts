import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (packages/server/src → ../../..). */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** `.data/` at the project root, or `SLAVES_DATA_DIR` if set (used by tests and demos). */
export function resolveDataDir(): string {
  const override = process.env.SLAVES_DATA_DIR;
  return override ? resolve(override) : join(PROJECT_ROOT, ".data");
}

export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    settings: join(dataDir, "settings.json"),
    accounts: join(dataDir, "accounts.json"),
    repos: join(dataDir, "repos.json"),
    queue: join(dataDir, "queue.json"),
    prompts: join(dataDir, "prompts.json"),
    ask: join(dataDir, "ask.json"),
    /** Where Ask-mode chats without a repo run (a scratch folder: nothing in it matters). */
    askDir: join(dataDir, "ask"),
    knowledgeDir: join(dataDir, "knowledge"),
    activityDir: join(dataDir, "activity"),
    cliConfigDir: join(dataDir, "cli-config"),
    attachmentsDir: join(dataDir, "attachments"),
  };
}
export type DataPaths = ReturnType<typeof dataPaths>;
