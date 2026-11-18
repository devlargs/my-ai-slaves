#!/usr/bin/env node
// Fake `ssh` for tests: `ssh [-o opt]... [-T|-tt] <host> <command>` runs <command> with `sh -c`
// right here, as if on the host. Hosts named down* behave like an unreachable server.
// FAKE_REMOTE_HOME is used as the "server's" $HOME (so attachment copies land in a temp folder).
import { spawn } from "node:child_process";
import { dirname } from "node:path";

const args = process.argv.slice(2);
let i = 0;
while (i < args.length) {
  if (args[i] === "-o") i += 2;
  else if (args[i].startsWith("-")) i += 1;
  else break;
}
const host = args[i];
const command = args[i + 1];
if (!host || command === undefined) {
  process.stderr.write("usage: fake-ssh [options] host command\n");
  process.exit(255);
}
if (host.startsWith("down")) {
  process.stderr.write(`ssh: connect to host ${host} port 22: Operation timed out\n`);
  process.exit(255);
}
// A "server" doesn't have this Mac's tools on its PATH: only system dirs + node (for the fake CLIs).
const env = {
  ...process.env,
  HOME: process.env.FAKE_REMOTE_HOME || process.env.HOME,
  PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
};
const child = spawn("sh", ["-c", command], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
