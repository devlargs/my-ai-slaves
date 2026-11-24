import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AccountsFile,
  AskFile,
  type DataFileRecovery,
  KnowledgeFile,
  PromptsFile,
  QueueFile,
  RepoSlug,
  ReposFile,
  SettingsFile,
} from "@my-ai-slaves/shared";
import { type DataPaths, dataPaths } from "../paths";
import { ActivityLog } from "./activity-log";
import { consoleLogger, type Logger } from "./fs-utils";
import { JsonStore, type LoadOutcome } from "./json-store";

export interface DataStores {
  paths: DataPaths;
  settings: JsonStore<SettingsFile>;
  accounts: JsonStore<AccountsFile>;
  repos: JsonStore<ReposFile>;
  queue: JsonStore<QueueFile>;
  /** `.data/prompts.json`: the saved prompt library. */
  prompts: JsonStore<PromptsFile>;
  /** `.data/ask.json`: the Ask page's chats. */
  ask: JsonStore<AskFile>;
  activity: ActivityLog;
  /** `.data/knowledge/<slug>.json`; created blank on first load. */
  knowledge(repoSlug: string): JsonStore<KnowledgeFile>;
  /** Files backed up and repaired since the server started (oldest first), shown on the Settings page. */
  recoveries: DataFileRecovery[];
}

export interface OpenDataStoresOptions {
  dataDir: string;
  logger?: Logger;
  now?: () => Date;
  activityMaxBytes?: number;
  /** See `ActivityLogOptions.flushDelayMs`. */
  activityFlushDelayMs?: number;
}

/** The only entry point to `.data/`. Loads (or creates/recovers) every file and reports what happened. */
export async function openDataStores(
  options: OpenDataStoresOptions,
): Promise<{ stores: DataStores; report: Record<string, LoadOutcome> }> {
  const paths = dataPaths(options.dataDir);
  const logger = options.logger ?? consoleLogger;
  const recoveries: DataFileRecovery[] = [];
  const common = { logger, now: options.now, onRecovery: (r: DataFileRecovery) => void recoveries.push(r) };

  await mkdir(paths.cliConfigDir, { recursive: true });
  await mkdir(paths.knowledgeDir, { recursive: true });

  const settings = new JsonStore({ file: paths.settings, schema: SettingsFile, ...common });
  const accounts = new JsonStore({ file: paths.accounts, schema: AccountsFile, ...common });
  const repos = new JsonStore({ file: paths.repos, schema: ReposFile, ...common });
  const queue = new JsonStore({ file: paths.queue, schema: QueueFile, ...common });
  const prompts = new JsonStore({ file: paths.prompts, schema: PromptsFile, ...common });
  const ask = new JsonStore({ file: paths.ask, schema: AskFile, ...common });

  const knowledgeStores = new Map<string, JsonStore<KnowledgeFile>>();
  const knowledge = (repoSlug: string) => {
    const slug = RepoSlug.parse(repoSlug);
    let store = knowledgeStores.get(slug);
    if (!store) {
      store = new JsonStore({
        file: join(paths.knowledgeDir, `${slug}.json`),
        schema: KnowledgeFile,
        defaults: () => ({ repo: slug }),
        ...common,
      });
      knowledgeStores.set(slug, store);
    }
    return store;
  };

  const report: Record<string, LoadOutcome> = {};
  for (const store of [settings, accounts, repos, queue, prompts, ask]) report[store.file] = await store.load();

  for (const name of await readdir(paths.knowledgeDir)) {
    const slug = name.endsWith(".json") ? name.slice(0, -".json".length) : null;
    if (!slug || !RepoSlug.safeParse(slug).success) continue;
    const store = knowledge(slug);
    report[store.file] = await store.load();
  }

  const activity = new ActivityLog({
    dir: paths.activityDir,
    maxBytes: options.activityMaxBytes,
    flushDelayMs: options.activityFlushDelayMs,
    ...common,
  });
  await activity.init();

  return {
    stores: { paths, settings, accounts, repos, queue, prompts, ask, activity, knowledge, recoveries },
    report,
  };
}
