import type { DesktopBridge, DesktopInfo, DesktopUpdateState } from "@my-ai-slaves/shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// The desktop app's bridge (packages/desktop/src/preload.ts). Undefined in a browser tab, where
// everything below renders nothing.

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window === "undefined" ? undefined : window.desktop;

interface DesktopState {
  info: DesktopInfo | null;
  update: DesktopUpdateState | null;
}

let state: DesktopState = { info: null, update: null };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<DesktopState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** One app-wide subscription: the main process pushes every update state change. */
function start() {
  if (started || !desktop) return;
  started = true;
  void desktop.info().then((info) => set({ info }));
  void desktop.updateState().then((update) => set({ update }));
  desktop.onUpdateState((update) => set({ update }));
}

export function useDesktop(): DesktopState {
  useEffect(start, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Electron wraps errors from the main process as "Error invoking remote method '…': Error: <message>". */
function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export async function desktopAction<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    console.error(cleanError(error));
    return undefined;
  }
}

// A check usually answers in a few hundred ms: keep the spinner up at least this long so a click
// visibly did something, even when the answer ("up to date") is the same as before.
const MIN_CHECK_MS = 700;

/**
 * "Check for updates": always asks GitHub again (never reuses an earlier answer). `checking` is
 * true while the main process checks, and for at least MIN_CHECK_MS after a click.
 */
export function useUpdateCheck(): { check: () => void; checking: boolean } {
  const { update } = useDesktop();
  const [clicked, setClicked] = useState(false);
  const check = useCallback(() => {
    if (!desktop) return;
    setClicked(true);
    const minimum = new Promise((resolve) => setTimeout(resolve, MIN_CHECK_MS));
    void Promise.all([desktopAction(() => desktop!.checkForUpdates()), minimum]).finally(() => setClicked(false));
  }, []);
  return { check, checking: clicked || update?.status === "checking" };
}

/** "checked 18:20" (or with the date, when it wasn't today), for an ISO time; "" for null. */
export function checkedLabel(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? `checked ${time}` : `checked ${at.toLocaleDateString()} ${time}`;
}
