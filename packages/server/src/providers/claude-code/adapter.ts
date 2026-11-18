import { readdir } from "node:fs/promises";
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
import { ClaudeStreamParser } from "./parse-stream";

/** Local accounts get their isolated config dir; remote accounts use the server's own login. */
const configEnv = (ctx: AccountContext): Record<string, string> =>
  ctx.configDir ? { CLAUDE_CONFIG_DIR: ctx.configDir } : {};

const binaryOf = (ctx: AccountContext, settings: SettingsFile) =>
  ctx.account.binary ?? settings.providers["claude-code"].binary;

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
 * Remote accounts run the same command on the SSH host with that server's own login.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = "claude-code" as const;

  buildArgs(input: Pick<RunInput, "resume" | "addDirs">, settings: SettingsFile, resumeTarget: string | null): string[] {
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
      // autoContinueAtUsageLimit: default true would wait out a limit instead of falling back to the next account.
      // attribution: false drops the "Co-Authored-By: Claude" trailer and the PR footer (v2.1.281+).
      "--settings",
      JSON.stringify({ autoContinueAtUsageLimit: false, attribution: false }),
    ];
    // Tasks work on a branch in the repo itself: take away Claude's own worktree tools and `git worktree`.
    args.push("--disallowedTools", "EnterWorktree", "ExitWorktree", "Bash(git worktree *)");
    if (s.model) args.push("--model", s.model);
    if (resumeTarget) args.push("--resume", resumeTarget);
    for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);
    return args;
  }

  run(input: RunInput, settings: SettingsFile): RunHandle {
    const s = settings.providers["claude-code"];
    const parser = new ClaudeStreamParser(s.permissionMode);

    // Resuming a session from another local Claude account needs the transcript's absolute path.
    const from = input.resume?.fromConfigDir ?? null;
    const resumeTarget = !input.resume
      ? Promise.resolve(null)
      : !input.configDir || !from || from === input.configDir
        ? Promise.resolve(input.resume.sessionId)
        : findTranscript(from, input.resume.sessionId).then((p) => p ?? input.resume!.sessionId);

    // runProcess is synchronous; wrap so the handle exists immediately.
    let inner: RunHandle | null = null;
    const pendingStream: Parameters<RunHandle["onStream"]>[0][] = [];
    const pendingRaw: Parameters<RunHandle["onRaw"]>[0][] = [];
    let cancelledEarly = false;

    const started = resumeTarget.then((target) => {
      inner = runProcess(
        {
          command: binaryOf(input, settings),
          args: this.buildArgs(input, settings, target),
          extraEnv: { ...configEnv(input), ...gitIdentityEnv(input.gitIdentity) },
          cwd: input.cwd,
          host: input.account.host,
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

  private spec(ctx: AccountContext, settings: SettingsFile, args: string[]): SpawnSpec {
    return { command: binaryOf(ctx, settings), args, extraEnv: configEnv(ctx), cwd: ctx.configDir, host: ctx.account.host };
  }

  /** The CLI opens your browser (or, on a server, prints the link) and finishes once you sign in. */
  loginCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return this.spec(ctx, settings, ["auth", "login"]);
  }

  logoutCommand(ctx: AccountContext, settings: SettingsFile): SpawnSpec {
    return this.spec(ctx, settings, ["auth", "logout"]);
  }

  async checkAuth(ctx: AccountContext, settings: SettingsFile): Promise<AuthInfo> {
    const out = await runToCompletion(this.spec(ctx, settings, ["auth", "status", "--json"]));
    try {
      const j = JSON.parse(out.stdout) as { loggedIn?: boolean; email?: unknown; subscriptionType?: unknown };
      if (typeof j.loggedIn === "boolean") {
        return {
          state: j.loggedIn ? "logged-in" : "logged-out",
          email: j.loggedIn && typeof j.email === "string" ? j.email : null,
          plan: j.loggedIn && typeof j.subscriptionType === "string" ? j.subscriptionType : null,
        };
      }
    } catch {
      // fall through
    }
    return { state: "unknown", email: null, plan: null };
  }
}
