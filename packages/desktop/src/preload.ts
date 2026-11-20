import type { DesktopBridge, DesktopUpdateState } from "@my-ai-slaves/shared";
import { contextBridge, ipcRenderer } from "electron";

// window.desktop for the web UI (types in packages/shared/src/desktop.ts). The main process checks
// every call comes from the app's own page.

const bridge: DesktopBridge = {
  info: () => ipcRenderer.invoke("desktop:info"),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
  changeDataFolder: () => ipcRenderer.invoke("desktop:change-data-folder"),
  openLogFile: () => ipcRenderer.invoke("desktop:open-log"),
  updateState: () => ipcRenderer.invoke("desktop:update-state"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:update-check"),
  installUpdate: () => ipcRenderer.invoke("desktop:update-install"),
  openReleasePage: () => ipcRenderer.invoke("desktop:open-release"),
  onUpdateState: (callback) => {
    const listener = (_event: unknown, state: DesktopUpdateState) => callback(state);
    ipcRenderer.on("desktop:update-state", listener);
    return () => ipcRenderer.removeListener("desktop:update-state", listener);
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);
