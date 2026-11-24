#!/usr/bin/env node
// Marketing infographics as PNGs (light + dark) for social posts, the README and the og:image.
//
//   npm run landing:cards        (from the repo root; run landing:shots first, the cards use those screenshots)
//
// Builds the landing page, serves it with `vite preview`, opens each `#cards/<name>` in a headless Chrome
// at the card's size (2x) and saves public/cards/<name>-<theme>.png. og.png is the light og card.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { openBrowser } from "./chrome.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const OUT = join(root, "public", "cards");
const PORT = Number(process.env.CARDS_PORT) || 5186;
mkdirSync(OUT, { recursive: true });

// Kept in step with CARDS in src/cards.tsx.
const SCREEN_IDS = ["queue-running", "queue-review", "queue-fallback", "repos-graph", "ask", "stats", "history"];
const CARDS = {
  og: [1200, 630],
  fallback: [1080, 1080],
  prompt: [1080, 1080],
  how: [1080, 1350],
  ...Object.fromEntries(SCREEN_IDS.map((id) => [`shot-${id}`, [1600, 1000]])),
};

await build({ root, logLevel: "warn" });
const server = await preview({ root, preview: { host: "127.0.0.1", port: PORT, strictPort: true }, logLevel: "warn" });
const profileDir = mkdtempSync(join(tmpdir(), "slaves-cards-"));
const browser = await openBrowser({ profileDir, debugPort: PORT + 1 });

try {
  for (const theme of ["light", "dark"]) {
    for (const [name, [w, h]] of Object.entries(CARDS)) {
      await browser.setup(theme, w, h);
      await browser.navigate("about:blank", 50);
      await browser.navigate(`http://127.0.0.1:${PORT}/#cards/${name}`, 1200);
      const file = join(OUT, `${name}-${theme}.png`);
      await browser.screenshot(file);
      console.log(`  saved cards/${name}-${theme}.png`);
    }
  }
  copyFileSync(join(OUT, "og-light.png"), join(OUT, "og.png"));
} finally {
  browser.close();
  await server.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`\nDone: ${OUT}`);
process.exit(0);
