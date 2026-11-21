// The bridge the desktop app (Electron) puts on `window.desktop` for the web UI. Absent when the UI
// is opened in a browser from `npm run dev` / `npm start`.

export type DesktopUpdateStatus =
  | "idle" // not checked yet
  | "checking"
  | "latest" // this is the newest release
  | "available" // a newer release, ready to download and install
  | "manual" // a newer release that can't be installed from the app (no checksum): download it by hand
  | "downloading"
  | "installing" // downloaded and verified; the app is about to quit and update
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  /** The newer release's version, when there is one. */
  newVersion: string | null;
  /** Download progress, 0–100. */
  percent: number;
  /** GitHub page of the newer release. */
  releaseUrl: string | null;
  /** Why the last check or install failed. */
  error: string | null;
  /** ISO time of the last finished check. */
  checkedAt: string | null;
  /**
   * True when this copy is the Intel build running through Rosetta on an Apple Silicon Mac, which
   * makes the whole app many times slower. The update offered is then the Apple Silicon build,
   * even when it's the same version.
   */
  rosetta: boolean;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  /** The data folder this app runs on (settings.json, queue.json, …). */
  dataDir: string;
  /** Where the bundled server's log is written. */
  logFile: string;
}

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  openDataFolder(): Promise<void>;
  /** Asks for a new folder and restarts the app on it. Resolves false when cancelled. */
  changeDataFolder(): Promise<boolean>;
  openLogFile(): Promise<void>;
  updateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  /** Downloads, verifies and installs the update found by the last check, then the app restarts. */
  installUpdate(): Promise<void>;
  openReleasePage(): Promise<void>;
  /** Called on every update state change. Returns an unsubscribe function. */
  onUpdateState(callback: (state: DesktopUpdateState) => void): () => void;
}
