import fs from "node:fs";
import path from "node:path";
import type { DesktopInfo, DesktopUpdateState } from "@my-ai-slaves/shared";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, Menu, shell } from "electron";
import { changeDataFolder, ensureDataFolder } from "./data-folder";
import { createTokenSource } from "./github-token";
import { type ServerHandle, startServer } from "./server-process";
import { serverBaseEnv } from "./shell-env";
import { createUpdater, type Updater } from "./updater";

// My AI Slaves as a desktop app: starts the bundled server on the chosen data folder and shows the
// same web UI `npm run dev` serves, in its own window. Everything the app does still happens in the
// server; this file only owns the window, the menu, the data folder choice and updates.

// The same port as `npm run dev`, so the two never run at once on the same data by accident.
// SLAVES_PORT / SLAVES_DATA_DIR override them (for trying a build next to your own app).
const PORT = Number(process.env.SLAVES_PORT) || 3005;
const ORIGIN = `http://localhost:${PORT}`;
const APP_DIR = app.getAppPath();
const SERVER_ENTRY = path.join(APP_DIR, "server", "server.mjs");
const WEB_DIR = path.join(APP_DIR, "web");

let mainWindow: BrowserWindow | null = null;
let server: ServerHandle | null = null;
let serverEnv: NodeJS.ProcessEnv = process.env;
let dataDir = "";
let updater: Updater | null = null;
let quitting = false;

const logFile = () => path.join(app.getPath("logs"), "server.log");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => focusWindow());
  void main();
}

async function main() {
  // Reading the login shell's PATH can take a second or more (nvm & co. in .zshrc): start it now, so
  // it runs while Electron gets ready and the data folder is resolved instead of after them.
  const envReady = serverBaseEnv();
  await app.whenReady();
  setMenu();

  const chosen = process.env.SLAVES_DATA_DIR ? path.resolve(process.env.SLAVES_DATA_DIR) : await ensureDataFolder();
  if (!chosen) {
    app.quit();
    return;
  }
  dataDir = chosen;
  serverEnv = await envReady;
  await fs.promises.mkdir(app.getPath("logs"), { recursive: true });

  const getToken = createTokenSource(() => serverEnv);
  updater = createUpdater({ getToken, onChange: broadcastUpdateState });
  registerIpc();

  if (await bootServer()) createWindow();
}

/** Starts the server and waits for it. False when it couldn't start (the app is quitting then). */
async function bootServer(): Promise<boolean> {
  server = await startServer({ entry: SERVER_ENTRY, webDir: WEB_DIR, dataDir, port: PORT, env: serverEnv, logFile: logFile() });
  const result = await server.started;
  if (result.ok) {
    server.onExit((code, signal) => void onServerDied(code, signal));
    return true;
  }
  if (result.reason === "port-in-use") {
    await dialog.showMessageBox({
      type: "error",
      message: `Port ${result.port} is already in use`,
      detail: `My AI Slaves is probably already running from a terminal (npm run dev or npm start). Stop that one and open the app again.`,
      buttons: ["Quit"],
    });
  } else {
    await showServerFailure(`The server stopped while starting (exit code ${result.code ?? result.signal}).`);
  }
  quitting = true;
  app.quit();
  return false;
}

async function onServerDied(code: number | null, signal: NodeJS.Signals | null) {
  if (quitting) return;
  const answer = await dialog.showMessageBox({
    type: "error",
    message: "The My AI Slaves server stopped unexpectedly",
    detail: `Exit code ${code ?? signal}. Running tasks will show as interrupted. The log is at\n${logFile()}`,
    buttons: ["Restart", "Open Log", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });
  if (answer.response === 1) void shell.openPath(logFile());
  if (answer.response === 2) {
    quitting = true;
    app.quit();
    return;
  }
  if (await bootServer()) mainWindow?.reload();
}

async function showServerFailure(detail: string) {
  const answer = await dialog.showMessageBox({
    type: "error",
    message: "My AI Slaves couldn't start",
    detail: `${detail}\n\nThe log is at\n${logFile()}`,
    buttons: ["Open Log", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response === 0) await shell.openPath(logFile());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "My AI Slaves",
    backgroundColor: "#fbf9f7",
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Not throttled while another app is in front: otherwise coming back to the window first has to
      // catch up on everything a running task streamed meanwhile, and typing lags until it has.
      backgroundThrottling: false,
    },
  });
  const win = mainWindow;
  win.once("ready-to-show", () => win.show());
  // backgroundThrottling stays off while the window is merely behind another app (see above), but
  // that also keeps the page "visible" when minimized or hidden: animations kept painting and the
  // UI's document.hidden checks never fired. Throttle while nobody can see the window at all.
  const throttle = (on: boolean) => {
    if (!win.isDestroyed()) win.webContents.setBackgroundThrottling(on);
  };
  win.on("minimize", () => throttle(true));
  win.on("hide", () => throttle(true));
  win.on("restore", () => throttle(false));
  win.on("show", () => throttle(win.isMinimized()));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Links to anything else (GitHub, login pages, docs) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  void win.loadURL(ORIGIN);
}

function focusWindow() {
  if (!mainWindow) {
    if (server) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.host === `localhost:${PORT}` || u.host === `127.0.0.1:${PORT}`);
  } catch {
    return false;
  }
}

function openExternal(url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") void shell.openExternal(url);
  } catch {
    // not a URL
  }
}

// ── IPC (window.desktop, see preload.ts) ────────────────────────────────────

/** Only our own page, in our own window, may call these. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && isAppUrl(event.senderFrame?.url ?? "");
}

function handle<T>(channel: string, fn: () => T | Promise<T>) {
  ipcMain.handle(channel, (event) => {
    if (!fromApp(event)) throw new Error("Not allowed");
    return fn();
  });
}

function info(): DesktopInfo {
  return { version: app.getVersion(), platform: process.platform, dataDir, logFile: logFile() };
}

function registerIpc() {
  handle("desktop:info", info);
  handle("desktop:open-data-folder", async () => void (await shell.openPath(dataDir)));
  handle("desktop:change-data-folder", () => changeDataFolder(mainWindow, dataDir));
  handle("desktop:open-log", async () => void (await shell.openPath(logFile())));
  handle("desktop:update-state", () => updater!.state());
  handle("desktop:update-check", () => updater!.check());
  handle("desktop:update-install", () => updater!.install());
  handle("desktop:open-release", () => {
    const url = updater!.releaseUrl();
    if (url) openExternal(url);
  });
}

function broadcastUpdateState(state: DesktopUpdateState) {
  mainWindow?.webContents.send("desktop:update-state", state);
}

/** The menu's "Check for Updates…": the same check, answered in a dialog. */
async function checkForUpdatesFromMenu() {
  if (!updater) return;
  const state = await updater.check();
  const parent = mainWindow ?? undefined;
  const show = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  if (state.status === "available") {
    const answer = await show({
      type: "info",
      message: `My AI Slaves ${state.newVersion} is available`,
      detail: `You have ${state.currentVersion}. Updating stops running tasks, installs the new version and reopens the app.`,
      buttons: ["Update Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0) await updater.install().catch((err: Error) => show({ type: "error", message: err.message }));
  } else if (state.status === "manual") {
    const answer = await show({
      type: "info",
      message: `My AI Slaves ${state.newVersion} is available`,
      detail: "This release can't be installed from the app (it has no checksum to verify). Download it from the release page.",
      buttons: ["Open Release Page", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0 && state.releaseUrl) openExternal(state.releaseUrl);
  } else if (state.status === "latest") {
    await show({ type: "info", message: "You're up to date", detail: `My AI Slaves ${state.currentVersion} is the latest version.` });
  } else if (state.status === "error") {
    await show({ type: "error", message: "Couldn't check for updates", detail: state.error ?? "" });
  }
}

// ── menu ────────────────────────────────────────────────────────────────────

function setMenu() {
  const isMac = process.platform === "darwin";
  const dataItems: Electron.MenuItemConstructorOptions[] = [
    { label: "Open Data Folder", accelerator: "CmdOrCtrl+Shift+D", click: () => dataDir && void shell.openPath(dataDir) },
    { label: "Change Data Folder…", click: () => dataDir && void changeDataFolder(mainWindow, dataDir) },
    { label: "Open Server Log", click: () => void shell.openPath(logFile()) },
  ];
  const updateItem: Electron.MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void checkForUpdatesFromMenu(),
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              updateItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ] as Electron.MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [...dataItems, ...(isMac ? [] : [{ type: "separator" as const }, updateItem, { type: "separator" as const }, { role: "quit" as const }])],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── lifecycle ───────────────────────────────────────────────────────────────

// macOS: closing the window keeps the app (and its queue) running in the Dock, like other Mac apps.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => focusWindow());

// Stop the server cleanly first so it records running tasks as interrupted.
app.on("before-quit", (event) => {
  quitting = true;
  if (!server) return;
  const stopping = server;
  server = null;
  event.preventDefault();
  void stopping.stop().finally(() => app.quit());
});
