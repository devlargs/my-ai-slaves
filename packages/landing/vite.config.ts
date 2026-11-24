import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Static site: relative asset paths, so dist/ can be hosted anywhere (GitHub Pages, a subfolder, a CDN).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5175 },
  preview: { port: 5176 },
  build: { outDir: "dist" },
});
