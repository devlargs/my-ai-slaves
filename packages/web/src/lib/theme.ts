import { useSyncExternalStore } from "react";
import { storageGet, storageSet } from "@/lib/utils";

/** "system" follows the OS appearance; the other two pin it. Kept per browser / desktop window. */
export type ThemePref = "system" | "light" | "dark";

// Same key and logic as public/theme-init.js (loaded by index.html), which applies it before the first paint.
const KEY = "slaves.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): ThemePref {
  const v = storageGet(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

let pref = read();

function apply() {
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#141210" : "#fbf9f7");
}

// Only fires when the OS appearance actually changes: costs nothing while idle.
media.addEventListener("change", () => {
  if (pref === "system") apply();
});
// Another tab / window changed it.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  pref = read();
  apply();
  for (const l of listeners) l();
});
apply();

export function setTheme(next: ThemePref) {
  pref = next;
  storageSet(KEY, next);
  apply();
  for (const l of listeners) l();
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
}
