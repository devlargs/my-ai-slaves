import { execFile } from "node:child_process";

// The repo is public, so its releases are read without a token. Only when GitHub rate-limits the
// unauthenticated request does the updater ask for one: GH_TOKEN / GITHUB_TOKEN when set, else the
// GitHub CLI's login on this computer (`gh auth token`). The token is only ever sent to
// api.github.com (see updater/release.ts) and never stored.

export function createTokenSource(env: () => NodeJS.ProcessEnv): () => Promise<string | null> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const e = env();
    const fromEnv = e.GH_TOKEN?.trim() || e.GITHUB_TOKEN?.trim();
    if (fromEnv) return (cached = fromEnv);
    const fromGh = await new Promise<string | null>((resolve) => {
      execFile("gh", ["auth", "token", "--hostname", "github.com"], { env: e, timeout: 5000, windowsHide: true }, (error, stdout) =>
        resolve(error ? null : String(stdout).trim() || null),
      );
    });
    // Not cached when missing: logging in with `gh auth login` later works without a restart.
    if (fromGh) cached = fromGh;
    return fromGh;
  };
}
