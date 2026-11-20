// Where a downloaded update lives. Each download gets a fresh directory from
// mkdtemp in the temp folder, and the installer inside it a random name, so no
// other local process can guess the path and swap the file between the
// checksum check and the launch. Pure (test/updater.test.ts); install.ts does the I/O.

/** mkdtemp prefix for each update's directory in the temp folder. */
export const UPDATE_DIR_PREFIX = "my-ai-slaves-dl-";

/** The installer's filename: the NSIS `.exe` on Windows, the `.dmg` on macOS. */
export function installerFileName(platform: NodeJS.Platform, randomHex: string): string {
  return `my-ai-slaves-update-${randomHex}${platform === "darwin" ? ".dmg" : ".exe"}`;
}

/**
 * Which entries of the temp folder are left over from earlier updates: update
 * directories other than `currentDir` (the one a download in progress is using).
 */
export function staleUpdateEntries(entries: readonly string[], currentDir: string | null): string[] {
  return entries.filter((name) => name.startsWith(UPDATE_DIR_PREFIX) && name !== currentDir);
}
