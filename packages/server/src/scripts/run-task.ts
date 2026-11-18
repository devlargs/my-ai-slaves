/**
 * Run one prompt on one account from the terminal, no UI, no queue, no branch switching.
 *   npm run run-task -w @my-ai-slaves/server -- --account work_1-claude --cwd /path/to/scratch "say hi"
 * Prints normalized stream events and the final result (limit / logged-out / failed / success).
 */
import { parseArgs } from "node:util";
import { resolveDataDir } from "../paths";
import { createAdapters } from "../providers";
import { AccountService } from "../services/account-service";
import { nullBroadcaster } from "../services/common";
import { openDataStores } from "../storage/data-stores";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { account: { type: "string" }, cwd: { type: "string" }, raw: { type: "boolean", default: false } },
});
const prompt = positionals.join(" ");
if (!values.account || !values.cwd || !prompt) {
  console.error('Usage: npm run run-task -w @my-ai-slaves/server -- --account <label> --cwd <dir> [--raw] "prompt"');
  process.exit(1);
}

const { stores } = await openDataStores({ dataDir: resolveDataDir() });
const adapters = createAdapters();
const accounts = new AccountService(stores, adapters, nullBroadcaster);
const account = await accounts.get(values.account);
const settings = await stores.settings.read();

const handle = adapters[account.provider].run(
  { ...accounts.context(account), prompt, cwd: values.cwd, resume: null },
  settings,
);
handle.onStream((e) => {
  if (e.kind === "text-delta") process.stdout.write(e.text);
  else console.log(`\n[${e.kind}] ${JSON.stringify(e)}`);
});
if (values.raw) handle.onRaw((r) => console.log(`  ${r.src}> ${r.line}`));
process.on("SIGINT", () => void handle.cancel());

console.log(`\nResult: ${JSON.stringify(await handle.done, null, 2)}`);
