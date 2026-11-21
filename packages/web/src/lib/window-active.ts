// Whether the app's window is the one in use: visible and focused. While it isn't, nothing has to
// move at 60 frames a second or refresh ten times a second: the looping decorations stop (see
// `.window-inactive` in index.css) and live output is applied once a second (see store.ts). The app
// spends most of its time like this, in the background while tasks run.

const compute = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());

let active = compute();
const listeners = new Set<(active: boolean) => void>();

function apply() {
  document.documentElement.classList.toggle("window-inactive", !active);
}

function update() {
  const next = compute();
  if (next === active) return;
  active = next;
  apply();
  for (const listener of listeners) listener(active);
}

if (typeof window !== "undefined") {
  apply();
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
}

export const isWindowActive = () => active;

/** Called whenever the window becomes the active one, or stops being it. Returns an unsubscribe function. */
export function onWindowActive(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
