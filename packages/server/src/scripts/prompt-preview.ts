/**
 * Show exactly what would be sent to a CLI, using the base prompts in your real `.data/`.
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
  repoBasePrompt: async (repo) => {
    if (!values.repo) return "";
    const file = join(stores.paths.knowledgeDir, `${repo}.json`);
    try {
      await access(file);
    } catch {
      console.log(`\n(no ${file} yet, so the repo layer is treated as blank.`);
      console.log(` To try it, create it with: { "repo": "${repo}", "basePrompt": "..." })`);
      return "";
    }
    return (await stores.knowledge(repo).read()).basePrompt;
  },
});

const { prompt, layers } = await assembler.forTask(values.repo ?? "__none__", message);

console.log("\nLayers:");
for (const { name, included } of layers) {
  const label = name === "repo" && !values.repo ? "skipped (no --repo given)" : included ? "included" : "skipped (blank)";
  console.log(`  ${name.padEnd(8)} ${label}`);
}
const rule = "─".repeat(60);
console.log(`\n${rule}\n${prompt}\n${rule}`);
console.log(`\nExact string: ${JSON.stringify(prompt)}`);
console.log(`Length: ${prompt.length} characters\n`);
