import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdapters } from "../src/providers";
import { stripAiLines } from "../src/services/branch-service";

describe("stripAiLines", () => {
  it("removes AI attribution lines and keeps everything else", () => {
    const msg = [
      "fix: login redirect",
      "",
      "Handles the SSO callback.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
      "Co-authored-by: Jane Dev <jane@example.com>",
      "Made with Cursor",
    ].join("\n");
    expect(stripAiLines(msg)).toBe("fix: login redirect\n\nHandles the SSO callback.\n\nCo-authored-by: Jane Dev <jane@example.com>\n");
  });
});

describe("attribution off", () => {
  it("Claude runs with attribution: false", () => {
    const adapters = createAdapters() as any;
    const args: string[] = adapters["claude-code"].buildArgs({ resume: null }, { providers: { "claude-code": { permissionMode: "auto", model: null } } }, null);
    expect(JSON.parse(args[args.indexOf("--settings") + 1] as string)).toMatchObject({ attribution: false });
  });

  it("Cursor's cli-config.json gets attribution turned off, keeping other keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slaves-cursor-"));
    const adapters = createAdapters();
    await adapters["cursor-agent"].prepare?.({ configDir: dir } as any, {} as any);
    const config = JSON.parse(await readFile(join(dir, "cli-config.json"), "utf8"));
    expect(config).toMatchObject({ version: 1, attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false } });
  });
});
