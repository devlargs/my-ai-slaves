/**
 * Create or check every file in `.data/` (or $SLAVES_DATA_DIR) and report what happened.
 *   npm run data:init
 */
import { relative } from "node:path";
import { PROJECT_ROOT, resolveDataDir } from "../paths";
import { openDataStores } from "../storage/data-stores";

const labels = {
  loaded: "ok (existing)",
  created: "created",
  salvaged: "SALVAGED (bad entries dropped, old copy backed up)",
  recovered: "RECOVERED (old copy backed up)",
};
const show = (path: string) => (path.startsWith(PROJECT_ROOT) ? relative(PROJECT_ROOT, path) : path);

const dataDir = resolveDataDir();
const { stores, report } = await openDataStores({ dataDir });

console.log(`\nData folder: ${dataDir}\n`);
for (const [file, outcome] of Object.entries(report)) {
  console.log(`  ${labels[outcome].padEnd(52)} ${show(file)}`);
}
console.log(`  ${"ok".padEnd(52)} ${show(stores.activity.dir)}/${stores.activity.currentFile} (current)\n`);
