// Stages the desktop app in packages/desktop/app/, which electron-builder packages as is:
//
//   app/package.json   name, version (from the root package.json), main
//   app/main.cjs       Electron main process (src/main.ts)
//   app/preload.cjs    window.desktop bridge (src/preload.ts)
//   app/server/server.mjs        the Fastify server (packages/server/src/index.ts), bundled
//   app/server/node-pty/         node-pty's JS and this platform's prebuilt binaries (native, not bundled)
//   app/web/dist/      the built web app (run `npm run build` first)
//
// Run from the repo root via `npm run desktop` / `npm run desktop:dist`.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(desktopDir, "..", "..");
const out = join(desktopDir, "app");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const webDist = join(root, "packages", "web", "dist");
if (!existsSync(join(webDist, "index.html"))) {
  console.error("packages/web/dist is missing: run `npm run build` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

// ── Electron main + preload (CommonJS, Electron provides `electron`) ─────────
await build({
  entryPoints: { main: join(desktopDir, "src", "main.ts"), preload: join(desktopDir, "src", "preload.ts") },
  outdir: out,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

// ── server (ESM: it uses top-level await) ───────────────────────────────────
// node-pty loads native binaries relative to its own files, so it stays a real folder next to the
// bundle. vite and @fastify/middie are only imported in dev mode, never in the packaged app.
const nodePtyBesideBundle = {
  name: "node-pty-beside-bundle",
  setup(b) {
    b.onResolve({ filter: /^node-pty$/ }, () => ({ path: "./node-pty/lib/index.js", external: true }));
  },
};
await build({
  entryPoints: [join(root, "packages", "server", "src", "index.ts")],
  outfile: join(out, "server", "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["vite", "@fastify/middie"],
  plugins: [nodePtyBesideBundle],
  // CommonJS dependencies (fastify & co.) bundled into ESM still call require() and use __dirname.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
});

// ── node-pty: JS + this platform's prebuilds only ───────────────────────────
const ptySrc = join(root, "node_modules", "node-pty");
const ptyOut = join(out, "server", "node-pty");
cpSync(join(ptySrc, "package.json"), join(ptyOut, "package.json"));
cpSync(join(ptySrc, "LICENSE"), join(ptyOut, "LICENSE"));
cpSync(join(ptySrc, "lib"), join(ptyOut, "lib"), { recursive: true, filter: (p) => !p.endsWith(".map") && !p.includes(".test.") });
const platformPrefix = `${process.platform}-`;
for (const dir of readdirSync(join(ptySrc, "prebuilds"))) {
  if (!dir.startsWith(platformPrefix)) continue;
  cpSync(join(ptySrc, "prebuilds", dir), join(ptyOut, "prebuilds", dir), { recursive: true, filter: (p) => !p.endsWith(".pdb") });
  const helper = join(ptyOut, "prebuilds", dir, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755); // npm doesn't always keep it executable
}
if (existsSync(join(ptySrc, "build", "Release"))) {
  // Built from source (no prebuild for this platform, e.g. Linux)
  cpSync(join(ptySrc, "build", "Release"), join(ptyOut, "build", "Release"), { recursive: true });
}

// ── web app ─────────────────────────────────────────────────────────────────
cpSync(webDist, join(out, "web", "dist"), { recursive: true });

// ── package.json for the packaged app ───────────────────────────────────────
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "my-ai-slaves",
      productName: "My AI Slaves",
      version: rootPkg.version,
      description: "Queue AI coding tasks and run them through Claude Code and Cursor Agent",
      author: "Ralph Largo",
      license: "UNLICENSED",
      main: "main.cjs",
    },
    null,
    2,
  )}\n`,
);

console.log(`Staged My AI Slaves ${rootPkg.version} in ${out}`);
