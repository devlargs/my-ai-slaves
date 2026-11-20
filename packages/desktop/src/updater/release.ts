import { isNewerVersion } from "./version";

// Reading GitHub's "latest release" answer: which asset to install, where it
// may be downloaded from, and the checksum to verify it against. Pure
// (test/updater.test.ts).

export const REPO = "devlargs/my-ai-slaves";
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Asset downloads go through the API (works for a private repo with a token, and a public one without). */
const ASSET_API_PREFIX = `https://api.github.com/repos/${REPO}/releases/assets/`;

export interface ReleaseAsset {
  name: string;
  /** API URL of the asset: `…/releases/assets/<id>`. */
  url?: string;
  digest?: string;
}

/**
 * Picks the release asset this machine should install: the NSIS `.exe` on
 * Windows, or the DMG built for this CPU on macOS (the release ships one per
 * arch, named `…-arm64.dmg` / `…-x64.dmg`). Anything else gets no update.
 */
export function pickUpdateAsset(assets: unknown, platform: NodeJS.Platform, arch: string): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  const named = assets.filter(
    (a): a is ReleaseAsset => typeof a?.name === "string" && !a.name.endsWith(".blockmap"),
  );
  if (platform === "win32") return named.find((a) => a.name.endsWith(".exe")) ?? null;
  if (platform === "darwin") return named.find((a) => a.name.endsWith(`-${arch}.dmg`)) ?? null;
  return null;
}

/** Hosts a download may touch: the API, then the storage it redirects to. */
const UPDATE_HOST_ALLOWLIST = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** Every hop of the download, redirects included, must pass this. */
export function isAllowedUpdateUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && UPDATE_HOST_ALLOWLIST.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Only the GitHub API ever gets the token, never the storage host a download redirects to. */
export function sendsToken(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && parsed.hostname === "api.github.com";
  } catch {
    return false;
  }
}

/**
 * An update the main process has checked and will download. The web UI only
 * ever sees the version; the URL and checksum stay in the main process.
 */
export interface PendingUpdate {
  version: string;
  url: string;
  /**
   * Lowercase hex sha256 the download must match, or null when GitHub gave
   * none. Such an update is offered for manual download only, never installed:
   * the builds aren't signed, so the checksum is all that vouches for them.
   */
  sha256: string | null;
}

/** The hex sha256 from a GitHub asset digest ("sha256:<64 hex>"), or null. */
export function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** The GitHub page of a release, for downloading it by hand. */
export function releasePageUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${encodeURIComponent(version)}`;
}

/**
 * The update to offer from the latest-release JSON, or null when there is none
 * for this machine: not newer than `currentVersion`, no asset for this
 * platform/arch, or an asset URL that isn't this repo's.
 */
export function resolveUpdate(
  release: unknown,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
): PendingUpdate | null {
  if (typeof release !== "object" || release === null) return null;
  const { tag_name, assets } = release as { tag_name?: unknown; assets?: unknown };
  const latest = (typeof tag_name === "string" ? tag_name : "").replace(/^v/, "");
  if (!isNewerVersion(latest, currentVersion)) return null;
  const asset = pickUpdateAsset(assets, platform, arch);
  const url = asset?.url;
  if (!url || !url.startsWith(ASSET_API_PREFIX) || !isAllowedUpdateUrl(url)) return null;
  // GitHub publishes a sha256 digest per release asset
  return { version: latest, url, sha256: parseSha256Digest(asset?.digest) };
}
