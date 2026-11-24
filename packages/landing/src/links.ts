export const REPO_URL = "https://github.com/devlargs/my-ai-slaves";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
const DL = `${REPO_URL}/releases/latest/download`;

export const DOWNLOADS = {
  macArm: { label: "macOS · Apple Silicon", short: "Download for Mac", file: "My-AI-Slaves-arm64.dmg", href: `${DL}/My-AI-Slaves-arm64.dmg` },
  macIntel: { label: "macOS · Intel", short: "Download for Mac (Intel)", file: "My-AI-Slaves-x64.dmg", href: `${DL}/My-AI-Slaves-x64.dmg` },
  windows: { label: "Windows · x64", short: "Download for Windows", file: "My-AI-Slaves-Setup.exe", href: `${DL}/My-AI-Slaves-Setup.exe` },
} as const;

export type DownloadKey = keyof typeof DOWNLOADS;

/**
 * Best guess at the visitor's installer. Browsers on Apple Silicon still report "Intel" in the user agent,
 * so every Mac gets the Apple Silicon build first (the Intel one is one click away, and the app itself
 * offers to switch if it ever runs under Rosetta).
 */
export function detectPlatform(): DownloadKey | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (/iphone|ipad|android/.test(p)) return null;
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macArm";
  return null;
}
