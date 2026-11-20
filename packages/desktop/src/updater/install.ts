import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { hashFile } from "./download";
import { MAC_UPDATE_SCRIPT, MAC_UPDATE_SCRIPT_NAME, macAppBundlePath } from "./mac-update";
import { UPDATE_DIR_PREFIX, installerFileName, staleUpdateEntries } from "./paths";
import { sameSha256 } from "./verify";

// Running a downloaded update: the NSIS installer on Windows; on macOS a script
// that swaps the new app in and relaunches it (see mac-update.ts), or, when this
// copy can't replace itself, the DMG opened in Finder. Also where the installer
// file lives, and cleaning it up on the next launch (it can't be deleted right
// away: the installer is still reading it when this app quits).

/** Makes a fresh directory for one update download and returns its path. */
export function createUpdateDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(app.getPath("temp"), UPDATE_DIR_PREFIX));
}

/** A random installer path inside `dir`, from createUpdateDir. */
export function installerPathIn(dir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(dir, installerFileName(platform, crypto.randomBytes(16).toString("hex")));
}

/**
 * Deletes what earlier updates left in the temp folder, except `currentDir`
 * (a download in progress). Something still locked is skipped; the next launch
 * tries again.
 */
export async function removeStaleUpdates(tempDir: string, currentDir: string | null): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tempDir);
  } catch {
    return;
  }
  const keep = currentDir ? path.basename(currentDir) : null;
  for (const name of staleUpdateEntries(entries, keep)) {
    await fs.promises.rm(path.join(tempDir, name), { recursive: true, force: true }).catch(() => {});
  }
}

// Quit so the installer (or the swap script) can replace this copy. Force-exit
// after a moment so nothing can keep the old instance alive and block it. The
// bundled server notices its parent is gone and stops on its own.
function quitForUpdate() {
  app.quit();
  setTimeout(() => app.exit(0), 5000);
}

// The bundle to replace on macOS, or null when this copy can't replace itself:
// macAppBundlePath rules out dev runs, the DMG and translocated copies, and the
// bundle and the folder it sits in have to be writable for the swap.
function macReplaceableBundle(): string | null {
  const bundle = macAppBundlePath(app.getPath("exe"));
  if (!bundle) return null;
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return bundle;
  } catch {
    return null;
  }
}

// Starts the macOS update script, fully detached so it outlives this process.
// Its output goes to a log in the temp folder: the only trace of an update that
// went wrong after the app had already quit.
function spawnMacUpdate(dmgPath: string, bundle: string): void {
  const scriptPath = path.join(path.dirname(dmgPath), MAC_UPDATE_SCRIPT_NAME);
  fs.writeFileSync(scriptPath, MAC_UPDATE_SCRIPT, { mode: 0o700 });
  const log = fs.openSync(path.join(app.getPath("temp"), "my-ai-slaves-update.log"), "w");
  try {
    const child = spawn("/bin/bash", [scriptPath, String(process.pid), dmgPath, bundle], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

function installOnMac(dmgPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Replace the app in place and relaunch it, like Windows.
    const bundle = macReplaceableBundle();
    if (bundle) {
      try {
        spawnMacUpdate(dmgPath, bundle);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      setTimeout(() => {
        resolve();
        quitForUpdate();
      }, 1000);
      return;
    }
    // Can't replace this copy (running from the DMG, translocated, or the
    // folder isn't writable): open the DMG in Finder so the new app can be
    // dragged over the old one, then quit so the old copy isn't in use.
    void shell.openPath(dmgPath).then((err) => {
      if (err) {
        reject(new Error(`Could not open the update: ${err}`));
        return;
      }
      resolve();
      quitForUpdate();
    });
  });
}

function installOnWindows(installerPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The NSIS installer, silent and fully detached. `--updated` marks an
    // update rather than a fresh install; `--force-run` makes a silent
    // installer relaunch the app when it finishes.
    const child = spawn(installerPath, ["--updated", "/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", reject);
    child.unref();
    setTimeout(() => {
      resolve();
      quitForUpdate();
    }, 1000);
  });
}

/**
 * Runs the verified download at `filePath` and quits. The file is hashed again
 * right before it runs, so one changed on disk since the download was checked
 * is refused.
 */
export async function installUpdate(filePath: string, expectedSha256: string): Promise<void> {
  if (!sameSha256(await hashFile(filePath), expectedSha256)) {
    await fs.promises.rm(filePath, { force: true });
    throw new Error("Update rejected: the installer changed after it was checked");
  }
  return process.platform === "darwin" ? installOnMac(filePath) : installOnWindows(filePath);
}
