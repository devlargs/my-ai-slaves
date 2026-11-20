import fs from "node:fs";
import path from "node:path";
import { app, type BrowserWindow, dialog } from "electron";

// Which folder the app keeps its data in (settings.json, accounts.json, repos.json, queue.json,
// knowledge/, activity/, attachments/, cli-config/). Picked on first launch and remembered in
// <userData>/desktop.json, so it can be any folder: the .data of a checkout, Documents, a synced
// drive. Changing it later restarts the app on the new folder; nothing is moved or copied.

const DATA_FILES = ["settings.json", "accounts.json", "repos.json", "queue.json", "prompts.json"];
const SUBFOLDER_NAME = "My AI Slaves";

interface DesktopConfig {
  dataDir?: string;
}

function configFile(): string {
  return path.join(app.getPath("userData"), "desktop.json");
}

function readConfig(): DesktopConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as DesktopConfig) : {};
  } catch {
    return {};
  }
}

function writeConfig(config: DesktopConfig): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const tmp = `${configFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configFile());
}

/** True when `dir` already holds this app's data. */
export function looksLikeDataFolder(entries: readonly string[]): boolean {
  return entries.some((name) => DATA_FILES.includes(name));
}

/** Entries that don't count when deciding whether a folder is empty. */
export function meaningfulEntries(entries: readonly string[]): string[] {
  return entries.filter((name) => name !== ".DS_Store" && name !== "Thumbs.db" && name !== "desktop.ini");
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The saved data folder, or null when none is saved yet (or it was set by SLAVES_DATA_DIR). */
export function savedDataFolder(): string | null {
  return readConfig().dataDir ?? null;
}

/**
 * Asks for a folder and returns the data folder to use, or null when cancelled. A folder that
 * already holds this app's data, or is empty, is used as is; a folder with other things in it gets
 * a "My AI Slaves" folder inside it (unless the user says otherwise), so the JSON files don't end
 * up mixed with their documents.
 */
async function pickFolder(parent: BrowserWindow | null, current: string | null): Promise<string | null> {
  for (;;) {
    const options: Electron.OpenDialogOptions = {
      title: "Choose the data folder",
      buttonLabel: "Use This Folder",
      message: "Choose where My AI Slaves keeps its data. Pick an existing data folder to keep using it.",
      defaultPath: current ?? app.getPath("documents"),
      // A checkout's data folder is `.data`, which macOS hides by default.
      properties: ["openDirectory", "createDirectory", "promptToCreate", "showHiddenFiles"],
    };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen) return null;

    const entries = meaningfulEntries(listDir(chosen));
    if (entries.length === 0 || looksLikeDataFolder(entries)) return chosen;
    // Picked the checkout instead of its hidden .data folder: use the .data inside it.
    const dotData = path.join(chosen, ".data");
    if (entries.includes(".data") && looksLikeDataFolder(listDir(dotData))) return dotData;

    const inside = path.join(chosen, SUBFOLDER_NAME);
    const answer = await dialog.showMessageBox({
      type: "question",
      message: "That folder already has other files in it.",
      detail: `Keep the app's files together in a new folder inside it?\n\n${inside}`,
      buttons: [`Use "${SUBFOLDER_NAME}" Inside It`, "Use the Folder As Is", "Choose Another…"],
      defaultId: 0,
      cancelId: 2,
    });
    if (answer.response === 0) return inside;
    if (answer.response === 1) return chosen;
  }
}

/**
 * The data folder to start the server on: the saved one if it still exists, otherwise asks (first
 * launch, or the saved folder is gone). Null means the user quit instead.
 */
export async function ensureDataFolder(): Promise<string | null> {
  const saved = savedDataFolder();
  if (saved && fs.existsSync(saved)) return saved;

  const first = !saved;
  const answer = await dialog.showMessageBox({
    type: first ? "info" : "warning",
    message: first ? "Welcome to My AI Slaves" : "The data folder is missing",
    detail: first
      ? "Choose the folder where My AI Slaves keeps its data: settings, accounts, repos, the queue and activity, as plain JSON files you can open any time.\n\nAlready used the app with npm run dev? Pick that checkout (or its .data folder) to keep everything, including your logins."
      : `My AI Slaves keeps its data in\n${saved}\nbut that folder isn't there any more (moved, renamed, or a drive that isn't connected).`,
    buttons: first ? ["Choose Folder…", "Quit"] : ["Choose Folder…", "Create It Again", "Quit"],
    defaultId: 0,
    cancelId: first ? 1 : 2,
  });
  if (!first && answer.response === 1 && saved) {
    fs.mkdirSync(saved, { recursive: true });
    return saved;
  }
  if (answer.response !== 0) return null;

  const chosen = await pickFolder(null, saved);
  if (!chosen) return null;
  fs.mkdirSync(chosen, { recursive: true });
  writeConfig({ ...readConfig(), dataDir: chosen });
  return chosen;
}

/**
 * Lets the user switch to another data folder, then restarts the app on it. Resolves false when
 * they cancel. The old folder is left exactly as it is.
 */
export async function changeDataFolder(parent: BrowserWindow | null, current: string): Promise<boolean> {
  const chosen = await pickFolder(parent, current);
  if (!chosen || path.resolve(chosen) === path.resolve(current)) return false;
  const answer = await dialog.showMessageBox({
    type: "question",
    message: "Restart on the new data folder?",
    detail: `My AI Slaves will restart and use\n${chosen}\n\nNothing is moved or copied: the current folder stays as it is, and you can switch back any time. Running tasks are stopped. Claude logins are tied to the folder they were made in, so accounts in a new folder need logging in again.`,
    buttons: ["Restart", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return false;
  fs.mkdirSync(chosen, { recursive: true });
  writeConfig({ ...readConfig(), dataDir: chosen });
  // The relaunched app inherits this environment, and SLAVES_DATA_DIR wins over the saved folder:
  // drop it so the restart really opens the folder just chosen.
  delete process.env.SLAVES_DATA_DIR;
  app.relaunch();
  app.quit();
  return true;
}
