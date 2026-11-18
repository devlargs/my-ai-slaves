import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsFile } from "@my-ai-slaves/shared";
import { childEnv, runProcess, runToCompletion } from "../spawn";
import type { AccountContext, AuthState, ProviderAdapter, RunHandle, RunInput, SpawnSpec } from "../types";
import { ClaudeStreamParser } from "./parse-stream";

const env = (ctx: AccountContext) => childEnv({ CLAUDE_CONFIG_DIR: ctx.configDir });

/** Find `<configDir>/projects/<any>/<sessionId>.jsonl` so another Claude account can resume it. */
async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  const projects = join(configDir, "projects");
  try {
    for (const dir of await readdir(projects)) {
      const files = await readdir(join(projects, dir)).catch(() => [] as string[]);
      if (files.includes(`${sessionId}.jsonl`)) return join(projects, dir, `${sessionId}.jsonl`);
    }
  } catch {
    // no projects dir yet
  }
  return null;
}

/**
 * Claude Code headless mode (`claude -p`), verified against the official docs (v2.1.327):
 * stream-json needs --verbose; prompt goes in on stdin; CLAUDE_CONFIG_DIR isolates the login.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = "claude-code" as const;

  buildArgs(input: Pick<RunInput, "resume">, settings: SettingsFile, resumeTarget: string | null): string[] {
    const s = settings.providers["claude-code"];
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      s.permissionMode,
      "--permission-prompts",
      "none",
      // Default is true: it would wait out a usage limit instead of letting us fall back to the next account.
      "--settings",
      JSON.stringify({ autoContinueAtUsageLimit: false }),
    ];
    if (s.model) args.push("--model", s.model);
    if (resumeTarget) args.push("--resume", resumeTarget);
    return args;
  }

  run(input: RunInput, settings: SettingsFile): RunHandle {
    const s = settings.providers["claude-code"];
    const parser = new ClaudeStreamParser(s.permissionMode);

    // Resuming a session from another Claude account needs the transcript's absolute path.
    const resumeTarget = input.resume
      ? input.resume.fromConfigDir === input.configDir
        ? Promise.resolve(input.resume.sessionId)
        : findTranscript(input.resume.fromConfigDir, input.resume.sessionId).then((p) => p ?? input.resume!.sessionId)
      : Promise.resolve(null);

    // runProcess is synchronous; wrap so the handle exists immediately.
    let inner: RunHandle | null = null;
    const pendingStream: Parameters<RunHandle["onStream"]>[0][] = [];
    const pendingRaw: Parameters<RunHandle["onRaw"]>[0][] = [];
    let cancelledEarly = false;

    const started = resumeTarget.then((target) => {
      inner = runProcess(
        {
          command: s.binary,
          args: this.buildArgs(input, settings, target),
          env: env(input),
          cwd: input.cwd,
        },
        input.prompt,
        parser,
      );
      for (const cb of pendingStream) inner.onStream(cb);
      for (const cb of pendingRaw) inner.onRaw(cb);
      if (cancelledEarly) void inner.cancel();
      return inner;
    });

    return {
      onStream(cb) {
        if (inner) return inner.onStream(cb);
        pendingStream.push(cb);
        return () => {};
      },
      onRaw(cb) {
        if (inner) return inner.onRaw(cb);
        pendingRaw.push(cb);
        return () => {};
      },
      done: started.then((h) => h.done),
      async cancel() {
        cancelledEarly = true;
        if (inner) await inner.cancel();
        else await started.then((h) => h.cancel());
      },
    };
  }

  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return {
      command: settings.providers["claude-code"].binary,
      args: ["auth", "login"],
      // The app shows the sign-in link itself; keep the CLI from opening a second tab.
      env: { ...env(ctx), BROWSER: "/usr/bin/true" },
      cwd: ctx.configDir,
    };
  }

  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return { command: settings.providers["claude-code"].binary, args: ["auth", "logout"], env: env(ctx), cwd: ctx.configDir };
  }

  async checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthState> {
    const out = await runToCompletion({
      command: settings.providers["claude-code"].binary,
      args: ["auth", "status"],
      env: env(ctx),
      cwd: ctx.configDir,
    });
    try {
      const status = JSON.parse(out.stdout) as { loggedIn?: boolean };
      if (typeof status.loggedIn === "boolean") return status.loggedIn ? "logged-in" : "logged-out";
    } catch {
      // fall through
    }
    return "unknown";
  }
}
