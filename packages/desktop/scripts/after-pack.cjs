// electron-builder afterPack hook:
//
// 1. Keeps only the node-pty binaries for the CPU being packaged. The staged app has every arch of
//    this platform (darwin-arm64 + darwin-x64, win32-arm64 + win32-x64); an Apple Silicon app must
//    not carry Intel binaries, or anything that loads them runs under Rosetta.
// 2. Ad-hoc signs the macOS app bundle (from Largs Hub). The app ships without an Apple Developer
//    ID, so electron-builder skips code signing, and the signature Electron ships with no longer
//    matches once our files are added. Apple Silicon refuses to launch a bundle with a broken
//    signature ("is damaged and can't be opened"); an ad-hoc signature (`--sign -`) is enough to
//    launch. Gatekeeper still asks once, since it isn't notarized.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async function afterPack(context) {
  const isMac = context.electronPlatformName === "darwin";
  const appPath = isMac ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`) : null;
  const resources = isMac ? path.join(appPath, "Contents", "Resources") : path.join(context.appOutDir, "resources");
  const prebuilds = path.join(resources, "app", "server", "node-pty", "prebuilds");

  const arch = Arch[context.arch]; // "x64", "arm64", … ("universal" keeps every arch)
  const keep = `${context.electronPlatformName}-${arch}`;
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    if (arch !== "universal" && dir !== keep) {
      fs.rmSync(path.join(prebuilds, dir), { recursive: true, force: true });
      continue;
    }
    // node-pty starts every terminal through spawn-helper, which must stay executable.
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }

  if (isMac) execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
