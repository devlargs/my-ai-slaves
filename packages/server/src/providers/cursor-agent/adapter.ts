import type { SettingsFile } from "@my-ai-slaves/shared";
import { childEnv, runProcess, runToCompletion } from "../spawn";
import type { AccountContext, AuthState, ProviderAdapter, RunHandle, RunInput, SpawnSpec } from "../types";
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

  buildArgs(input: Pick<RunInput, "cwd" | "prompt" | "resume">, settings: SettingsFile): string[] {
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
    // `--` so a prompt starting with "-" is never read as a flag.
    args.push("--", input.prompt);
    return args;
  }

  run(input: RunInput, settings: SettingsFile): RunHandle {
    const s = settings.providers["cursor-agent"];
    return runProcess(
      { command: s.binary, args: this.buildArgs(input, settings), env: env(input), cwd: input.cwd },
      null,
      new CursorStreamParser(s.limitPatterns),
    );
  }

  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return {
      command: settings.providers["cursor-agent"].binary,
      args: ["login"],
      env: { ...env(ctx), NO_OPEN_BROWSER: "1" }, // documented: print the link instead of opening a browser
      cwd: ctx.configDir,
    };
  }

  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return { command: settings.providers["cursor-agent"].binary, args: ["logout"], env: env(ctx), cwd: ctx.configDir };
  }

  async checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthState> {
    const out = await runToCompletion({
      command: settings.providers["cursor-agent"].binary,
      args: ["status"],
      env: env(ctx),
      cwd: ctx.configDir,
    });
    const text = `${out.stdout}\n${out.stderr}`;
    if (/not logged in/i.test(text)) return "logged-out";
    if (/logged in/i.test(text)) return "logged-in";
    return "unknown";
  }
}
