#!/usr/bin/env node
// Fake `claude` CLI for tests. Behaviour is driven by the prompt (stdin):
//   LIMIT:<label>  → that account hits a usage limit
//   FAIL           → run fails
//   SLOW           → waits 30s (for cancel tests)
//   otherwise      → writes out-<label>.txt in cwd and succeeds
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const label = basename(process.env.CLAUDE_CONFIG_DIR ?? "none");
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const marker = join(process.env.CLAUDE_CONFIG_DIR ?? ".", "fake-login");
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = existsSync(marker) || !label.startsWith("new-");
  out(loggedIn ? { loggedIn, authMethod: "claude.ai", email: `${label}@example.com`, subscriptionType: "max" } : { loggedIn, authMethod: "none" });
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  // Mimics the real output: OSC-8 hyperlink + coloured URL, then a code prompt. Code "good" works.
  const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
  process.stdout.write(`Opening browser to sign in…\r\nIf the browser didn't open, visit: \u001b]8;;${url}\u0007\u001b[94m${url}\u001b[39m\u001b]8;;\u0007\r\nPaste code here if prompted > `);
  // "auto-*" accounts: simulate the browser redirect hitting the CLI's local callback.
  if (label.startsWith("new-auto")) {
    setTimeout(() => {
      writeFileSync(marker, "1");
      process.stdout.write("\r\nLogin successful.\r\n");
      process.exit(0);
    }, 300);
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "good") {
      writeFileSync(marker, "1");
      process.stdout.write("\r\nLogin successful.\r\n");
      process.exit(0);
    }
    process.stdout.write("\r\nInvalid code.\r\nPaste code here if prompted > ");
  });
} else {

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  // Tests: record exactly what this CLI received (stdin), and where it ran.
  if (process.env.FAKE_PROMPT_LOG) {
    appendFileSync(process.env.FAKE_PROMPT_LOG, `${JSON.stringify({ cli: "claude", label, cwd: process.cwd(), args, prompt })}\n`);
  }
  const mode = args[args.indexOf("--permission-mode") + 1];
  const resumeIdx = args.indexOf("--resume");
  const session = resumeIdx >= 0 ? args[resumeIdx + 1] : `sess-${label}-${Date.now()}`;
  out({ type: "system", subtype: "init", session_id: session, model: "fake-model", permissionMode: mode });

  if (prompt.includes(`LIMIT:${label}`)) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 4102444800 }, session_id: session });
    out({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your session limit · resets 3:45pm" }] }, error: "rate_limit", parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 3:45pm", session_id: session });
    process.exit(1);
  }
  if (prompt.includes("FAIL")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], session_id: session });
    process.exit(1);
  }
  if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 30000));

  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Work" } }, parent_tool_use_id: null });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] }, parent_tool_use_id: null });
  const file = join(process.cwd(), `out-${label}.txt`);
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: file, content: prompt } }] }, parent_tool_use_id: null });
  writeFileSync(file, prompt);
  if (prompt.includes("COMMIT")) {
    // Like an agent that commits with an AI co-author trailer (identity comes from GIT_* env).
    execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "-q", "-m", "feat: agent work\n\nCo-Authored-By: Claude <noreply@anthropic.com>"], { cwd: process.cwd() });
    writeFileSync(join(process.cwd(), "leftover.txt"), "uncommitted");
  }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: "Done", total_cost_usd: 0.01, session_id: session });
  process.exit(0);
});
}
