// electron-builder config: packages the folder scripts/build.mjs staged in app/.
// Unsigned (no Apple Developer ID / Windows certificate): the macOS app is ad-hoc signed in
// scripts/after-pack.cjs, and the in-app updater verifies each download's sha256 instead.

const { execFileSync } = require("node:child_process");

// The release workflow (CI) builds one DMG per CPU. A local build makes only this Mac's own CPU:
// building both puts the Intel app in release/mac/, and opening that on Apple Silicon runs the app
// under Rosetta ("Support Ending for Intel-based Apps"). hw.optional.arm64 is 1 on Apple Silicon
// even when this Node runs under Rosetta (where process.arch would wrongly say x64).
function localMacArch() {
  if (process.platform !== "darwin") return process.arch;
  try {
    return execFileSync("sysctl", ["-in", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1" ? "arm64" : "x64";
  } catch {
    return process.arch;
  }
}
const macArchs = process.env.CI ? ["arm64", "x64"] : [localMacArch()];

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.devlargs.my-ai-slaves",
  productName: "My AI Slaves",
  electronVersion: require("electron/package.json").version,
  directories: { app: "app", output: "release", buildResources: "build" },
  // Plain files instead of an archive: the server runs as a separate Node process and node-pty's
  // native binaries and spawn-helper must be real files on disk.
  asar: false,
  npmRebuild: false,
  icon: "build/icon.png",
  afterPack: "scripts/after-pack.cjs",
  // The app has its own updater (src/updater) reading GitHub releases, and the release workflow
  // uploads the installers. Without this, electron-builder sees GH_TOKEN on CI, tries to write
  // electron-updater metadata for a repository it can't detect, and crashes.
  publish: null,
  mac: {
    target: [{ target: "dmg", arch: macArchs }],
    category: "public.app-category.developer-tools",
    identity: null,
    minimumSystemVersion: "13.0",
  },
  // One DMG per CPU; the updater picks the one ending in -<arch>.dmg.
  dmg: { artifactName: "My-AI-Slaves-${arch}.${ext}" },
  win: { target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: { artifactName: "My-AI-Slaves-Setup.${ext}" },
  linux: { target: "AppImage" },
};
