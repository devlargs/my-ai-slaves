// node-pty's macOS spawn-helper ships without the executable bit, and every terminal it starts goes
// through it. Node instead of `chmod` so `npm install` also works on Windows.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const prebuilds = join("node_modules", "node-pty", "prebuilds");
for (const dir of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
  const helper = join(prebuilds, dir, "spawn-helper");
  if (dir.startsWith("darwin-") && existsSync(helper)) chmodSync(helper, 0o755);
}
