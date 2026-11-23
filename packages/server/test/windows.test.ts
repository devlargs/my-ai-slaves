import { describe, expect, it } from "vitest";
import { resolveSpawn } from "../src/providers/spawn";
import {
  escapeCmdArgument,
  findOnWindowsPath,
  resolveWindowsLaunch,
  shimTarget,
  type WindowsFs,
} from "../src/providers/windows-command";
import { editorDataDir } from "../src/remote/hosts";
import { localParent, THIS_PC } from "../src/services/repo-service";
import { safeName } from "../src/storage/attachment-store";

/** A fake Windows disk: path (any case) → file contents. */
function fakeFs(files: Record<string, string>): WindowsFs {
  const byKey = new Map(Object.entries(files).map(([p, t]) => [p.toLowerCase(), t]));
  return { isFile: (p) => byKey.has(p.toLowerCase()), read: (p) => byKey.get(p.toLowerCase()) ?? null };
}

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

const env = {
  Path: "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Users\\me\\.local\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
};

describe("Windows CLI launch", () => {
  it("finds a command through PATH × PATHEXT and skips npm's extension-less sh shim", () => {
    const fs = fakeFs({ "C:\\Users\\me\\AppData\\Roaming\\npm\\claude": "#!/bin/sh", "C:\\Users\\me\\.local\\bin\\claude.exe": "" });
    expect(findOnWindowsPath("claude", env, fs)).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(findOnWindowsPath("missing", env, fs)).toBeNull();
  });

  it("starts a real .exe as is", () => {
    const fs = fakeFs({ "C:\\Users\\me\\.local\\bin\\claude.exe": "" });
    expect(resolveWindowsLaunch("claude", ["-p", "a\nb"], env, fs)).toEqual({
      command: "C:\\Users\\me\\.local\\bin\\claude.exe",
      args: ["-p", "a\nb"],
    });
  });

  it("runs the script an npm .cmd shim points at with node, so any argument passes untouched", () => {
    const fs = fakeFs({
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd": NPM_SHIM,
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js": "",
      "C:\\Program Files\\nodejs\\node.exe": "",
    });
    expect(shimTarget("C:\\x\\claude.cmd", NPM_SHIM)).toBe("C:\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(resolveWindowsLaunch("claude", ["--disallowedTools", "Bash(git worktree *)", "line\nbreak"], env, fs)).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        "--disallowedTools",
        "Bash(git worktree *)",
        "line\nbreak",
      ],
    });
  });

  it("sends any other batch file through cmd.exe with every argument escaped", () => {
    const fs = fakeFs({ "C:\\Users\\me\\.local\\bin\\agent.cmd": "@echo off\r\nsomething.exe %*" });
    const launch = resolveWindowsLaunch("agent", ["--model", "a b&c"], env, fs);
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(launch.args[3]).toBe(
      `"C:\\Users\\me\\.local\\bin\\agent.cmd ${escapeCmdArgument("--model")} ${escapeCmdArgument("a b&c")}"`,
    );
    expect(escapeCmdArgument("a b&c")).toBe('^^^"a^^^ b^^^&c^^^"');
    expect(() => resolveWindowsLaunch("agent", ["two\nlines"], env, fs)).toThrow(/line breaks/);
  });

  it("leaves an unknown command alone (spawn reports it missing) and is only used on Windows", () => {
    expect(resolveWindowsLaunch("nope", ["x"], env, fakeFs({}))).toEqual({ command: "nope", args: ["x"] });
    const spec = { command: "claude", args: ["-p"], extraEnv: {} };
    expect(resolveSpawn(spec, { platform: "darwin" })).toMatchObject({ command: "claude", args: ["-p"] });
  });
});

describe("Windows paths", () => {
  it("goes up from a drive root to the drive list, and stops at / elsewhere", () => {
    expect(localParent("C:\\Users\\me", "win32")).toBe("C:\\Users");
    expect(localParent("C:\\", "win32")).toBe(THIS_PC);
    expect(localParent("/Users/me", "darwin")).toBe("/Users");
    expect(localParent("/", "darwin")).toBeNull();
  });

  it("looks for editor history under %APPDATA% on Windows", () => {
    expect(editorDataDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" })).toBe("C:\\Users\\me\\AppData\\Roaming");
    expect(editorDataDir("darwin", {})).toMatch(/Library[\\/]Application Support$/);
  });

  it("keeps attachment names Windows can save", () => {
    expect(safeName("CON")).toBe("_CON");
    expect(safeName("nul.txt")).toBe("_nul.txt");
    expect(safeName("com1.png")).toBe("_com1.png");
    expect(safeName("notes. . ")).toBe("notes");
    expect(safeName("console.log")).toBe("console.log");
    expect(safeName("...")).toBe("file");
  });
});
