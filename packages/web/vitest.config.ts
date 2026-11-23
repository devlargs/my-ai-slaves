import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only the pure parts of the web app (no DOM): graph layout, view state, store reduction, pasted text.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: { include: ["test/**/*.test.ts"] },
});
