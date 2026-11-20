// electron-builder config: packages the folder scripts/build.mjs staged in app/.
// Unsigned (no Apple Developer ID / Windows certificate): the macOS app is ad-hoc signed in
// scripts/after-pack.cjs, and the in-app updater verifies each download's sha256 instead.

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
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
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
