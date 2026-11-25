import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_NO_WORKTREE, CursorAgentAdapter } from "../src/providers/cursor-agent/adapter";
import type { AccountContext } from "../src/providers/types";

const ctxFor = (configDir: string | null) => ({ account: { id: "cursor", host: null }, configDir }) as unknown as AccountContext;
const read = async (dir: string) => JSON.parse(await readFile(join(dir, "cli-config.json"), "utf8"));

describe("Cursor cli-config.json", () => {
  it("turns attribution off and denies git worktree in a fresh config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-config-"));
    await new CursorAgentAdapter().prepare(ctxFor(dir));
    const config = await read(dir);
    expect(config.attribution).toEqual({ attributeCommitsToAgent: false, attributePRsToAgent: false });
    expect(config.permissions.deny).toEqual([CURSOR_NO_WORKTREE]);
  });

  it("keeps what is already there and adds the rule once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-config-"));
    const existing = {
      version: 1,
      model: "x",
      attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
      permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm)"] },
    };
    await writeFile(join(dir, "cli-config.json"), JSON.stringify(existing));
    const adapter = new CursorAgentAdapter();
    await adapter.prepare(ctxFor(dir));
    await adapter.prepare(ctxFor(dir));
    const config = await read(dir);
    expect(config.model).toBe("x");
    expect(config.permissions).toEqual({ allow: ["Shell(ls)"], deny: ["Shell(rm)", CURSOR_NO_WORKTREE] });
  });
});
