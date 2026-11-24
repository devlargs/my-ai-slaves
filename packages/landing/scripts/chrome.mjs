// A headless Google Chrome driven over the DevTools protocol (Node 22's built-in WebSocket, no extra
// dependencies). Used by shots.mjs and cards.mjs. Works on macOS, Windows and Linux.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = isWin
    ? [
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("Google Chrome not found: set CHROME_PATH");
  return found;
}

export function killTree(child) {
  try {
    if (isWin && child.pid) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGKILL");
  } catch {}
}

/** Start Chrome with a throwaway profile in `profileDir`, open one tab, return helpers for it. */
export async function openBrowser({ profileDir, debugPort }) {
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-extensions",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let version;
  for (let i = 0; i < 120 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(
      (r) => r.json(),
      () => null,
    );
    if (!version) await sleep(250);
  }
  if (!version) {
    killTree(chrome);
    throw new Error("Chrome did not start");
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => cdp(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");

  return {
    page,
    async evaluate(expression) {
      const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** Viewport (CSS px, rendered at 2x), colour scheme and reduced motion (stills, not mid-animation frames). */
    async setup(theme, width, height) {
      await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await page("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
    },
    async navigate(url, waitMs = 1500) {
      await page("Page.navigate", { url });
      await sleep(waitMs);
    },
    /** PNG, or WebP (quality 86) when the file name ends in .webp. */
    async screenshot(file) {
      const webp = file.endsWith(".webp");
      const { data } = await page("Page.captureScreenshot", { format: webp ? "webp" : "png", ...(webp ? { quality: 86 } : {}), captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close() {
      try {
        ws.close();
      } catch {}
      killTree(chrome);
    },
  };
}
