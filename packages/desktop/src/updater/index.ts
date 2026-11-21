import fs from "node:fs";
import { app } from "electron";
import type { DesktopUpdateState } from "@my-ai-slaves/shared";
import { fetchGitHubJson, downloadVerified } from "./download";
import { createUpdateDir, installUpdate, installerPathIn, removeStaleUpdates } from "./install";
import {
  isIntelBuildOnAppleSilicon,
  LATEST_RELEASE_PAGE_URL,
  LATEST_RELEASE_URL,
  machineArch,
  type PendingUpdate,
  releasePageUrl,
  resolveUpdate,
} from "./release";
import { singleFlight } from "./single-flight";

// In-app updater, ported from Largs Hub: checks the latest GitHub release of
// devlargs/my-ai-slaves, downloads the installer for this machine, verifies it
// against the sha256 GitHub publishes for the asset, and runs it (NSIS on
// Windows, a swap-and-relaunch script on macOS). The main process owns the
// whole state; the web UI gets a read-only copy on every change and can only
// ask to check or install, never say what to download.
//
//   version.ts       version parsing and comparison (pure)
//   release.ts       picking the asset and checksum from a release (pure)
//   verify.ts        redirect, size and checksum rules (pure)
//   paths.ts         where a download goes, what cleanup removes (pure)
//   mac-update.ts    the macOS swap script (pure)
//   download.ts      the allowlisted, checksum-verified download
//   install.ts       running the installer / swap script, cleanup

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
// Long enough that the installer which relaunched us has exited.
const STALE_CLEANUP_DELAY_MS = 15_000;

export interface UpdaterDeps {
  /** A GitHub token, or null. The repo is private, so checks need one (`gh auth token`). */
  getToken(): Promise<string | null>;
  /** Called on every state change. */
  onChange(state: DesktopUpdateState): void;
}

export interface Updater {
  state(): DesktopUpdateState;
  check(): Promise<DesktopUpdateState>;
  install(): Promise<void>;
  releaseUrl(): string | null;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  // The Intel build on an Apple Silicon Mac (Rosetta): process.arch says "x64" there, so the
  // download is picked for the real chip instead, and the Apple Silicon build of the latest
  // release counts as an update even when this copy already has that version.
  const translated = app.runningUnderARM64Translation;
  const rosetta = isIntelBuildOnAppleSilicon(process.platform, process.arch, translated);
  const arch = machineArch(process.platform, process.arch, translated);

  let state: DesktopUpdateState = {
    status: "idle",
    currentVersion: app.getVersion(),
    newVersion: null,
    percent: 0,
    releaseUrl: null,
    error: null,
    checkedAt: null,
    rosetta,
  };
  let pending: PendingUpdate | null = null;
  // The directory of the download in progress, which cleanup must leave alone
  let currentUpdateDir: string | null = null;

  const set = (patch: Partial<DesktopUpdateState>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };

  const checkFlight = singleFlight(async (): Promise<DesktopUpdateState> => {
    set({ status: "checking", error: null });
    try {
      const token = await deps.getToken();
      const { status, body } = await fetchGitHubJson(LATEST_RELEASE_URL, token);
      const checkedAt = new Date().toISOString();
      if (status === 404) {
        // No release yet, or a private repo this machine has no token for.
        pending = null;
        set(
          token
            ? { status: "latest", newVersion: null, releaseUrl: null, checkedAt }
            : {
                status: "error",
                error: "Couldn't read the releases. The repo is private: log in the GitHub CLI (gh auth login) on this computer.",
                checkedAt,
              },
        );
        return state;
      }
      if (status !== 200) throw new Error(`GitHub answered HTTP ${status}`);
      const update = resolveUpdate(body, app.getVersion(), process.platform, arch, { sameVersion: rosetta });
      pending = update;
      if (!update) {
        set({ status: "latest", newVersion: null, releaseUrl: null, checkedAt });
      } else {
        set({
          // No checksum means nothing to verify the download against: download it by hand.
          status: update.sha256 ? "available" : "manual",
          newVersion: update.version,
          releaseUrl: releasePageUrl(update.version),
          checkedAt,
        });
      }
    } catch (err) {
      set({ status: "error", error: `Couldn't check for updates: ${message(err)}` });
    }
    return state;
  });

  const installFlight = singleFlight(async () => {
    // What to download comes from the main-process check, never from the UI.
    const update = pending;
    // An unpackaged run (`npm run desktop`) is plain Electron.app: nothing of ours to replace.
    if (!app.isPackaged) throw new Error("Updates install only in the packaged app.");
    if (!update) throw new Error("No update available. Check for updates first.");
    if (!update.sha256) throw new Error("This update has no checksum to verify; download it from the release page.");
    set({ status: "downloading", percent: 0, error: null });
    const dir = await createUpdateDir();
    currentUpdateDir = dir;
    try {
      const filePath = installerPathIn(dir);
      const token = await deps.getToken();
      let last = -1;
      await downloadVerified(update.url, update.sha256, filePath, token, (percent) => {
        if (percent !== last) {
          last = percent;
          set({ percent });
        }
      });
      set({ status: "installing", percent: 100 });
      await installUpdate(filePath, update.sha256);
    } catch (err) {
      currentUpdateDir = null;
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      set({ status: "error", error: `Update failed: ${message(err)}` });
      throw err;
    }
  });

  // Earlier updates' installers, once the installer that relaunched us is done.
  setTimeout(() => void removeStaleUpdates(app.getPath("temp"), currentUpdateDir), STALE_CLEANUP_DELAY_MS).unref?.();
  // Check soon after launch, then every few hours (not mid-download).
  const autoCheck = () => {
    if (!installFlight.isRunning()) void checkFlight.run();
  };
  setTimeout(autoCheck, FIRST_CHECK_DELAY_MS).unref?.();
  setInterval(autoCheck, CHECK_EVERY_MS).unref?.();

  return {
    state: () => state,
    check: () => (installFlight.isRunning() ? Promise.resolve(state) : checkFlight.run()),
    install: () => installFlight.run(),
    // Under Rosetta there is always something to get by hand, even when the check couldn't run.
    releaseUrl: () => state.releaseUrl ?? (rosetta ? LATEST_RELEASE_PAGE_URL : null),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
