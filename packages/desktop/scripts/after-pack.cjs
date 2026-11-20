// electron-builder afterPack hook: ad-hoc signs the macOS app bundle (from Largs Hub).
//
// The app ships without an Apple Developer ID, so electron-builder skips code signing, and the
// signature Electron ships with no longer matches once our files are added. Apple Silicon refuses
// to launch a bundle with a broken signature ("is damaged and can't be opened"); an ad-hoc
// signature (`--sign -`) is enough to launch. Gatekeeper still asks once, since it isn't notarized.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // node-pty starts every terminal through spawn-helper, which must stay executable.
  const prebuilds = path.join(appPath, "Contents", "Resources", "app", "server", "node-pty", "prebuilds");
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
