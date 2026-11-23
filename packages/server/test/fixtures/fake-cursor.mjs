#!/usr/bin/env node
// Fake Cursor `agent` CLI for tests. Prompt comes in on stdin (an argument after `--` fails the run).
//   LIMIT:<label> → exits 1 with a usage-limit message on stderr
//   otherwise     → writes out-<label>.txt in --workspace and succeeds
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const label = basename(process.env.CURSOR_CONFIG_DIR ?? "none");
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === "status") {
  if (args.includes("--format")) out({ status: "ok", isAuthenticated: true, userInfo: { email: "test@example.com", teamName: "Acme" } });
  else console.log("✓ Logged in as test@example.com");
  process.exit(0);
}
if (args[0] === "login") {
  console.log("Starting login process...\r\nWaiting for browser authentication...\r\nOpen a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=x&mode=login\r\n");
  setTimeout(() => process.exit(0), 300);
} else {

if (args.includes("--")) {
  process.stderr.write("fake-cursor: prompt must come on stdin, not as an argument\n");
  process.exit(2);
}
const prompt = readFileSync(0, "utf8");
const cwd = args[args.indexOf("--workspace") + 1] ?? process.cwd();
const session = "cursor-chat-1";
if (process.env.FAKE_PROMPT_LOG) {
  appendFileSync(process.env.FAKE_PROMPT_LOG, `${JSON.stringify({ cli: "cursor", label, cwd, args, prompt })}\n`);
}

out({ type: "system", subtype: "init", apiKeySource: "login", cwd, session_id: session, model: "Fake", permissionMode: "default" });
if (prompt.includes(`LIMIT:${label}`)) {
  process.stderr.write("Error: You've reached your usage limit for this period.\n");
  process.exit(1);
}
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On " }] }, session_id: session, timestamp_ms: 1 });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "it" }] }, session_id: session, timestamp_ms: 2 });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it" }] }, session_id: session, timestamp_ms: 3, model_call_id: "m1" });
const file = join(cwd, `out-${label}.txt`);
out({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { writeToolCall: { args: { path: file, fileText: prompt } } }, session_id: session });
writeFileSync(file, prompt);
out({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { writeToolCall: { args: { path: file }, result: { success: { path: file, linesCreated: 1, fileSize: 1 } } } }, session_id: session });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] }, session_id: session, timestamp_ms: 4 });
out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done" }] }, session_id: session });
out({ type: "result", subtype: "success", duration_ms: 5, duration_api_ms: 5, is_error: false, result: "On itDone", session_id: session });
}
