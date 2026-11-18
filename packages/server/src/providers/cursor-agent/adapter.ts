import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsFile } from "@my-ai-slaves/shared";
import { childEnv, runProcess, runToCompletion } from "../spawn";
import { type AccountContext, type AuthInfo, gitIdentityEnv, type ProviderAdapter, type RunHandle, type RunInput, type SpawnSpec } from "../types";
import { CursorStreamParser } from "./parse-stream";

/**
 * NOTE: CURSOR_CONFIG_DIR only isolates cli-config.json. The login itself lives in the macOS
 * Keychain under a fixed name, so all Cursor "accounts" share one login (the app allows only one).
 */
const env = (ctx: AccountContext) => childEnv({ CURSOR_CONFIG_DIR: ctx.configDir });

const MODE_FLAGS: Record<SettingsFile["providers"]["cursor-agent"]["permissionMode"], string[]> = {
  "auto-review": ["--auto-review"],
  force: ["--force"],
  allowlist: [],
};

export class CursorAgentAdapter implements ProviderAdapter {
  readonly provider = "cursor-agent" as const;

  buildArgs(input: Pick<RunInput, "cwd" | "prompt" | "resume" | "addDirs">, settings: SettingsFile): string[] {
    const s = settings.providers["cursor-agent"];
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--workspace",
      input.cwd,
      ...MODE_FLAGS[s.permissionMode],
    ];
    if (s.model) args.push("--model", s.model);
    if (input.resume) args.push("--resume", input.resume.sessionId);
    for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
    // `--` so a prompt starting with "-" is never read as a flag.
    args.push("--", input.prompt);
    return args;
  }

  /**
   * Turn off "Made with Cursor" on commits and PRs (documented cli-config.json keys). Only the
   * account's own cli-config.json is touched; Cursor's login lives in the Keychain, not here.
   */
  async prepare(ctx: AccountContext): Promise<void> {
    const file = join(ctx.configDir, "cli-config.json");
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {
      // missing or unreadable: start from the documented minimal config
      config = { version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] } };
    }
    const attribution = { ...(config.attribution ?? {}) };
    if (attribution.attributeCommitsToAgent === false && attribution.attributePRsToAgent === false) return;
    config.attribution = { ...attribution, attributeCommitsToAgent: false, attributePRsToAgent: false };
    await mkdir(ctx.configDir, { recursive: true });
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }

  run(input: RunInput, settings: SettingsFile): RunHandle {
    const s = settings.providers["cursor-agent"];
    return runProcess(
      { command: s.binary, args: this.buildArgs(input, settings), env: { ...env(input), ...gitIdentityEnv(input.gitIdentity) }, cwd: input.cwd },
      null,
      new CursorStreamParser(s.limitPatterns),
    );
  }

  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return {
      command: settings.providers["cursor-agent"].binary,
      args: ["login"],
      env: env(ctx), // opens your browser; finishes by itself once you approve
      cwd: ctx.configDir,
    };
  }

  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return { command: settings.providers["cursor-agent"].binary, args: ["logout"], env: env(ctx), cwd: ctx.configDir };
  }

  async checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthInfo> {
    const out = await runToCompletion({
      command: settings.providers["cursor-agent"].binary,
      args: ["status", "--format", "json"],
      env: env(ctx),
      cwd: ctx.configDir,
    });
    try {
      const j = JSON.parse(out.stdout) as { isAuthenticated?: boolean; userInfo?: { email?: unknown; teamName?: unknown } };
      if (typeof j.isAuthenticated === "boolean") {
        return {
          state: j.isAuthenticated ? "logged-in" : "logged-out",
          email: typeof j.userInfo?.email === "string" ? j.userInfo.email : null,
          plan: typeof j.userInfo?.teamName === "string" ? `Team: ${j.userInfo.teamName}` : null,
        };
      }
    } catch {
      // older CLIs: plain text
    }
    const text = `${out.stdout}\n${out.stderr}`;
    if (/not logged in/i.test(text)) return { state: "logged-out", email: null, plan: null };
    if (/logged in/i.test(text)) return { state: "logged-in", email: null, plan: null };
    return { state: "unknown", email: null, plan: null };
  }
}
