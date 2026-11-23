import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareLogFile, previousLogPath } from "../src/server-process";

describe("server log", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "slaves-log-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("names the previous log next to it", () => {
    expect(previousLogPath(path.join(dir, "server.log"))).toBe(path.join(dir, "server.previous.log"));
    expect(previousLogPath(path.join(dir, "server"))).toBe(path.join(dir, "server.previous"));
  });

  it("keeps the log (and a crash's stack trace in it) across starts while it's small", async () => {
    const log = path.join(dir, "logs", "server.log");
    await prepareLogFile(log, 100);
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(true);
    fs.writeFileSync(log, "Error: boom\n    at crash\n");
    await prepareLogFile(log, 100);
    expect(fs.readFileSync(log, "utf8")).toBe("Error: boom\n    at crash\n");
    expect(fs.existsSync(previousLogPath(log))).toBe(false);
  });

  it("moves a log past the limit to server.previous.log, replacing the older one", async () => {
    const log = path.join(dir, "server.log");
    const previous = previousLogPath(log);
    fs.writeFileSync(previous, "oldest");
    fs.writeFileSync(log, "x".repeat(100));
    await prepareLogFile(log, 100);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(previous, "utf8")).toBe("x".repeat(100));
  });
});
