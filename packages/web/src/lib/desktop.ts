import type { DesktopBridge, DesktopInfo, DesktopUpdateState } from "@my-ai-slaves/shared";
import { useEffect, useSyncExternalStore } from "react";

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
