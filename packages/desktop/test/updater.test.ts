import { describe, expect, it } from "vitest";
import { macAppBundlePath, MAC_UPDATE_SCRIPT } from "../src/updater/mac-update";
import { installerFileName, staleUpdateEntries, UPDATE_DIR_PREFIX } from "../src/updater/paths";
import {
  isAllowedUpdateUrl,
  parseSha256Digest,
  pickUpdateAsset,
  releasePageUrl,
  resolveUpdate,
  sendsToken,
} from "../src/updater/release";
import { singleFlight } from "../src/updater/single-flight";
import { downloadProblem, isRedirectStatus, parseContentLength } from "../src/updater/verify";
import { isNewerVersion, parseVersion } from "../src/updater/version";

const SHA = "a".repeat(64);
const API = "https://api.github.com/repos/devlargs/my-ai-slaves/releases/assets";

const exe = { name: "My-AI-Slaves-Setup.exe", url: `${API}/1`, digest: `sha256:${SHA}` };
const exeBlockmap = { name: "My-AI-Slaves-Setup.exe.blockmap", url: `${API}/2`, digest: `sha256:${SHA}` };
const armDmg = { name: "My-AI-Slaves-arm64.dmg", url: `${API}/3` };
const intelDmg = { name: "My-AI-Slaves-x64.dmg", url: `${API}/4`, digest: `sha256:${SHA}` };
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  assets: [exeBlockmap, exe, armDmg, intelDmg],
  ...overrides,
});

describe("versions", () => {
  it("parses x.y.z with or without a v", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" v0.10.0 ")).toEqual([0, 10, 0]);
    expect(parseVersion("0.1.0-rc1")).toBeNull();
    expect(parseVersion(42)).toBeNull();
  });

  it("counts only a strictly newer version, numerically", () => {
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.9", "0.1.10")).toBe(false);
    expect(isNewerVersion("0.1.9", "0.1.9")).toBe(false);
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });
});

describe("resolveUpdate", () => {
  it("offers a newer release's installer with its checksum", () => {
    expect(resolveUpdate(release(), "0.1.66", "win32", "x64")).toEqual({ version: "0.2.0", url: exe.url, sha256: SHA });
  });

  it("picks the Mac's own DMG, with no checksum when GitHub gave none", () => {
    expect(resolveUpdate(release(), "0.1.0", "darwin", "arm64")).toEqual({ version: "0.2.0", url: armDmg.url, sha256: null });
    expect(resolveUpdate(release(), "0.1.0", "darwin", "x64")?.url).toBe(intelDmg.url);
  });

  it("offers nothing that isn't strictly newer", () => {
    expect(resolveUpdate(release(), "0.2.0", "win32", "x64")).toBeNull();
    expect(resolveUpdate(release(), "0.3.0", "win32", "x64")).toBeNull();
    expect(resolveUpdate(release({ tag_name: "v0.2.0-rc1" }), "0.1.0", "win32", "x64")).toBeNull();
  });

  it("offers nothing without an asset for this machine", () => {
    expect(resolveUpdate(release({ assets: [exe] }), "0.1.0", "darwin", "arm64")).toBeNull();
    expect(resolveUpdate(release(), "0.1.0", "linux", "x64")).toBeNull();
  });

  it("refuses an asset that isn't this repo's, or not over https", () => {
    const otherRepo = { ...exe, url: "https://api.github.com/repos/someone/else/releases/assets/1" };
    const elsewhere = { ...exe, url: "https://example.com/setup.exe" };
    const plain = { ...exe, url: exe.url.replace("https", "http") };
    for (const asset of [otherRepo, elsewhere, plain]) {
      expect(resolveUpdate(release({ assets: [asset] }), "0.1.0", "win32", "x64")).toBeNull();
    }
  });

  it("copes with a malformed answer", () => {
    expect(resolveUpdate(null, "0.1.0", "win32", "x64")).toBeNull();
    expect(resolveUpdate({ tag_name: 42 }, "0.1.0", "win32", "x64")).toBeNull();
    expect(resolveUpdate({ tag_name: "v9.9.9" }, "0.1.0", "win32", "x64")).toBeNull();
    expect(pickUpdateAsset("nope", "win32", "x64")).toBeNull();
  });

  it("reads only whole sha256 digests", () => {
    expect(parseSha256Digest(`SHA256:${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(parseSha256Digest("md5:ffff")).toBeNull();
    expect(parseSha256Digest(`sha256:${SHA}0`)).toBeNull();
  });

  it("links the release page", () => {
    expect(releasePageUrl("0.2.0")).toBe("https://github.com/devlargs/my-ai-slaves/releases/tag/v0.2.0");
  });
});

describe("download rules", () => {
  it("allows only GitHub hosts over https", () => {
    expect(isAllowedUpdateUrl(`${API}/1`)).toBe(true);
    expect(isAllowedUpdateUrl("https://release-assets.githubusercontent.com/x")).toBe(true);
    expect(isAllowedUpdateUrl("http://api.github.com/x")).toBe(false);
    expect(isAllowedUpdateUrl("https://evil.example/x")).toBe(false);
    expect(isAllowedUpdateUrl("not a url")).toBe(false);
  });

  it("sends the token to the GitHub API only, never to the storage a download redirects to", () => {
    expect(sendsToken(`${API}/1`)).toBe(true);
    expect(sendsToken("https://objects.githubusercontent.com/x")).toBe(false);
    expect(sendsToken("https://release-assets.githubusercontent.com/x")).toBe(false);
    expect(sendsToken("http://api.github.com/x")).toBe(false);
  });

  it("follows redirects and reads sizes", () => {
    expect([301, 302, 303, 307, 308].every(isRedirectStatus)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
    expect(parseContentLength("1234")).toBe(1234);
    expect(parseContentLength("12abc")).toBeNull();
    expect(parseContentLength(undefined)).toBeNull();
  });

  it("refuses a short or mismatched download", () => {
    const ok = { expectedSha256: SHA, actualSha256: SHA.toUpperCase(), expectedBytes: 10, receivedBytes: 10 };
    expect(downloadProblem(ok)).toBeNull();
    expect(downloadProblem({ ...ok, receivedBytes: 9 })).toMatch(/incomplete/);
    expect(downloadProblem({ ...ok, actualSha256: "b".repeat(64) })).toMatch(/checksum/);
    expect(downloadProblem({ ...ok, expectedBytes: null, receivedBytes: 3 })).toBeNull();
  });
});

describe("update files", () => {
  it("names installers per platform", () => {
    expect(installerFileName("darwin", "ab")).toBe("my-ai-slaves-update-ab.dmg");
    expect(installerFileName("win32", "ab")).toBe("my-ai-slaves-update-ab.exe");
  });

  it("cleans up earlier update folders but not the current one", () => {
    const current = `${UPDATE_DIR_PREFIX}now`;
    expect(staleUpdateEntries([`${UPDATE_DIR_PREFIX}old`, current, "other"], current)).toEqual([`${UPDATE_DIR_PREFIX}old`]);
  });
});

describe("macOS in-place update", () => {
  it("finds the bundle of an installed app", () => {
    expect(macAppBundlePath("/Applications/My AI Slaves.app/Contents/MacOS/My AI Slaves")).toBe(
      "/Applications/My AI Slaves.app",
    );
  });

  it("won't replace the DMG, a translocated copy or a loose binary", () => {
    expect(macAppBundlePath("/Volumes/My AI Slaves/My AI Slaves.app/Contents/MacOS/My AI Slaves")).toBeNull();
    expect(macAppBundlePath("/private/var/folders/x/AppTranslocation/y/d/My AI Slaves.app/Contents/MacOS/My AI Slaves")).toBeNull();
    expect(macAppBundlePath("/usr/local/bin/my-ai-slaves")).toBeNull();
  });

  it("swaps the new bundle in and always reopens the app", () => {
    expect(MAC_UPDATE_SCRIPT).toContain('mv "$APP" "$OLD"');
    expect(MAC_UPDATE_SCRIPT).toContain('mv "$OLD" "$APP"');
    expect(MAC_UPDATE_SCRIPT.trimEnd().split("\n").slice(-2)).toEqual(['open "$APP"', 'rm -f "$0"']);
  });
});

describe("singleFlight", () => {
  it("runs one task at a time and lets a later call start fresh", async () => {
    let runs = 0;
    let release!: () => void;
    const flight = singleFlight(() => {
      runs++;
      return new Promise<number>((resolve) => (release = () => resolve(runs)));
    });
    const a = flight.run();
    const b = flight.run();
    expect(a).toBe(b);
    expect(flight.isRunning()).toBe(true);
    release();
    expect(await a).toBe(1);
    expect(flight.isRunning()).toBe(false);
    const c = flight.run();
    release();
    expect(await c).toBe(2);
  });
});
