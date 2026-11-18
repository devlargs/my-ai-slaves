/**
 * Show exactly what would be sent to a CLI, using the base prompt and the repo's default prompts in your real `.data/`.
 *   npm run prompt:preview -- "fix the login redirect"
 *   npm run prompt:preview -- --repo supertri-web "fix the login redirect"
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveDataDir } from "../paths";
import { openDataStores } from "../storage/data-stores";
import { PromptAssembler } from "../services/prompt-assembler";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: "string" } },
});
const message = positionals.join(" ");
if (!message) {
  console.error('Usage: npm run prompt:preview -- [--repo <slug>] "your task message"');
  process.exit(1);
}

const { stores } = await openDataStores({ dataDir: resolveDataDir() });

const assembler = new PromptAssembler({
  globalBasePrompt: async () => (await stores.settings.read()).basePrompt,
});

// Like a task queued without picking: the repo's default prompts.
let repoPrompts: string[] = [];
if (values.repo) {
  const file = join(stores.paths.knowledgeDir, `${values.repo}.json`);
  try {
    await access(file);
    repoPrompts = (await stores.knowledge(values.repo).read()).prompts.filter((p) => p.default).map((p) => p.body);
  } catch {
    console.log(`\n(no ${file} yet, so the repo layer is treated as blank.)`);
  }
}

const { prompt, layers } = await assembler.forTask(message, { repoPrompts });

console.log("\nLayers:");
for (const { name, included } of layers) {
  const label = name === "repo" && !values.repo ? "skipped (no --repo given)" : included ? "included" : "skipped (blank)";
  console.log(`  ${name.padEnd(8)} ${label}`);
}
const rule = "─".repeat(60);
console.log(`\n${rule}\n${prompt}\n${rule}`);
console.log(`\nExact string: ${JSON.stringify(prompt)}`);
console.log(`Length: ${prompt.length} characters\n`);
