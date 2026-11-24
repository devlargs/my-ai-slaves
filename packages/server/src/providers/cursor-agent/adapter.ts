import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsFile } from "@my-ai-slaves/shared";
import { runProcess, runToCompletion } from "../spawn";
import {
  type AccountContext,
  type AuthInfo,
  gitIdentityEnv,
  type ProviderAdapter,
  type RunHandle,
  type RunInput,
  type SpawnSpec,
} from "../types";
import { CursorStreamParser } from "./parse-stream";

/**
 * NOTE: CURSOR_CONFIG_DIR only isolates cli-config.json. The login itself lives in the macOS
 * Keychain under a fixed name, so all local Cursor "accounts" share one login (the app allows one).
 * Remote accounts use the server's own Cursor login and config.
 */
const configEnv = (ctx: AccountContext): Record<string, string> =>
  ctx.configDir ? { CURSOR_CONFIG_DIR: ctx.configDir } : {};

const binaryOf = (ctx: AccountContext, settings: SettingsFile) =>
  ctx.account.binary ?? settings.providers["cursor-agent"].binary;

const MODE_FLAGS: Record<SettingsFile["providers"]["cursor-agent"]["permissionMode"], string[]> = {
  "auto-review": ["--auto-review"],
  force: ["--force"],
  allowlist: [],
};

export class CursorAgentAdapter implements ProviderAdapter {
  readonly provider = "cursor-agent" as const;

  /**
   * The prompt is not an argument: it goes in on stdin (like Claude's), so a long prompt never hits
   * Windows' ~32K command-line cap or a remote host's per-argument cap (the whole ssh command is one
   * argument there), and it doesn't show in the process list. The docs don't mention stdin; checked
   * by hand on CLI 2026.11.13 for both a fresh `-p` run and `-p --resume <chatId>`.
   */
  buildArgs(input: Pick<RunInput, "cwd" | "resume" | "addDirs" | "readOnly">, settings: SettingsFile): string[] {
    const s = settings.providers["cursor-agent"];
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--workspace",
      input.cwd,
      // Ask mode: Cursor's documented read-only mode ("read-only exploration without making changes"), never --force.
      ...(input.readOnly ? ["--mode", "ask"] : MODE_FLAGS[s.permissionMode]),
    ];
    if (s.model) args.push("--model", s.model);
    if (input.resume) args.push("--resume", input.resume.sessionId);
    for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
    return args;
  }

  /**
   * Turn off "Made with Cursor" on commits and PRs (documented cli-config.json keys), for local
   * accounts. Remote accounts use the server's own config, which the app leaves as it is.
   */
  async prepare(ctx: AccountContext): Promise<void> {
    if (!ctx.configDir) return;
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
      {
        command: binaryOf(input, settings),
        args: this.buildArgs(input, settings),
        extraEnv: { ...configEnv(input), ...gitIdentityEnv(input.gitIdentity) },
        cwd: input.cwd,
        host: input.account.host,
      },
      input.prompt,
      new CursorStreamParser(s.limitPatterns),
    );
  }

  private spec(ctx: AccountContext, settings: SettingsFile, args: string[]): SpawnSpec {
    return { command: binaryOf(ctx, settings), args, extraEnv: configEnv(ctx), cwd: ctx.configDir, host: ctx.account.host };
  }

  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return this.spec(ctx, settings, ["login"]); // opens your browser (or prints the link); finishes by itself
  }

  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return this.spec(ctx, settings, ["logout"]);
  }

  async checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthInfo> {
    // On older Cursor CLIs (seen on servers: 2025.09) `status` starts a login instead of reporting,
    // so remote accounts are never status-checked; a logged-out run is detected from its output.
    if (ctx.account.host) return { state: "unknown", email: null, plan: null };
    const out = await runToCompletion(this.spec(ctx, settings, ["status", "--format", "json"]));
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
