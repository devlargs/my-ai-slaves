#!/usr/bin/env node
// A stand-in for the `claude` and Cursor `agent` CLIs, used only by `npm run landing:shots` to fill a
// scratch copy of the app with realistic-looking work. It never calls an AI: each task message maps to a
// scripted transcript (below) that streams Claude Code's stream-json, makes real edits in the demo repo
// (so the review diff is real) and reports token usage.
//
// The account called "work-max" hits a usage limit on its first run, so the queue shows a fallback.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? process.env.CURSOR_CONFIG_DIR ?? ".";
const label = basename(configDir);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = Number(process.env.DEMO_STEP_MS) || 260;

// ── auth checks ────────────────────────────────────────────────────────────
if (args[0] === "auth" && args[1] === "status") {
  out({ loggedIn: true, authMethod: "claude.ai", email: `${label}@example.com`, subscriptionType: "max" });
  process.exit(0);
}
if (args[0] === "status") {
  out({ status: "ok", isAuthenticated: true, userInfo: { email: `${label}@example.com`, teamName: "Studio" } });
  process.exit(0);
}
if (args[0] === "--version" || args[0] === "-v") {
  console.log("2.4.0 (demo)");
  process.exit(0);
}

// ── transcripts ────────────────────────────────────────────────────────────
/** @typedef {{ say?: string, read?: string, bash?: string, grep?: string, edit?: { file: string, find?: string, replace?: string, write?: string } }} Step */

/** @type {{ match: RegExp, long?: boolean, steps: Step[], result: string }[]} */
const SCRIPTS = [
  {
    match: /dark mode/i,
    steps: [
      { say: "I'll look at how the header and the theme tokens are wired before touching anything." },
      { read: "src/components/Header.tsx" },
      { read: "src/styles/tokens.css" },
      { grep: "prefers-color-scheme" },
      { say: "There's no theme state yet. I'll add a small `useTheme` hook that follows the OS until you pick one, and store the pick in localStorage." },
      {
        edit: {
          file: "src/lib/use-theme.ts",
          write: `import { useEffect, useState } from "react";\n\nexport type Theme = "light" | "dark";\nconst KEY = "storefront.theme";\n\nexport function useTheme() {\n  const [theme, setTheme] = useState<Theme>(() => {\n    const saved = localStorage.getItem(KEY);\n    if (saved === "light" || saved === "dark") return saved;\n    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";\n  });\n\n  useEffect(() => {\n    document.documentElement.dataset.theme = theme;\n    localStorage.setItem(KEY, theme);\n  }, [theme]);\n\n  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };\n}\n`,
        },
      },
      {
        edit: {
          file: "src/components/Header.tsx",
          find: `import { CartButton } from "./CartButton";`,
          replace: `import { CartButton } from "./CartButton";\nimport { ThemeToggle } from "./ThemeToggle";`,
        },
      },
      {
        edit: {
          file: "src/components/Header.tsx",
          find: `        <CartButton />`,
          replace: `        <ThemeToggle />\n        <CartButton />`,
        },
      },
      {
        edit: {
          file: "src/components/ThemeToggle.tsx",
          write: `import { MoonIcon, SunIcon } from "lucide-react";\nimport { useTheme } from "../lib/use-theme";\n\nexport function ThemeToggle() {\n  const { theme, toggle } = useTheme();\n  return (\n    <button type="button" className="icon-button" onClick={toggle} aria-label="Switch theme">\n      {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}\n    </button>\n  );\n}\n`,
        },
      },
      {
        edit: {
          file: "src/styles/tokens.css",
          find: `}\n`,
          replace: `}\n\n:root[data-theme="dark"] {\n  --bg: #16130f;\n  --fg: #f3efe9;\n  --muted: #a39b91;\n  --line: #2b2621;\n}\n`,
        },
      },
      { bash: "npm run typecheck" },
      { bash: "npm test -- header" },
      { say: "Typecheck and the header tests pass. The toggle sits left of the cart button and remembers your pick." },
    ],
    result:
      "Added a dark mode toggle to the header.\n\n- `useTheme()` follows the OS until you pick, then remembers it\n- `ThemeToggle` next to the cart button\n- dark values for the four colour tokens\n\nTypecheck and tests pass. Nothing is committed yet: review the diff.",
  },
  {
    match: /webhook/i,
    steps: [
      { say: "Let me find where webhooks are delivered and how failures are handled today." },
      { grep: "deliverWebhook" },
      { read: "src/webhooks/deliver.ts" },
      { read: "src/webhooks/deliver.test.ts" },
      { say: "Failed deliveries are dropped after one try. I'll retry with exponential backoff and jitter, capped at 6 attempts, and keep the attempt count on the event." },
      {
        edit: {
          file: "src/webhooks/backoff.ts",
          write: `/** Delay before retry \`attempt\` (1-based): 2s, 4s, 8s … capped at 5 min, ±20% jitter. */\nexport function backoffMs(attempt: number, random = Math.random): number {\n  const base = Math.min(2_000 * 2 ** (attempt - 1), 300_000);\n  const jitter = base * 0.2 * (random() * 2 - 1);\n  return Math.round(base + jitter);\n}\n\nexport const MAX_ATTEMPTS = 6;\n`,
        },
      },
      {
        edit: {
          file: "src/webhooks/deliver.ts",
          find: `import { signPayload } from "./sign";`,
          replace: `import { signPayload } from "./sign";\nimport { MAX_ATTEMPTS, backoffMs } from "./backoff";`,
        },
      },
      {
        edit: {
          file: "src/webhooks/deliver.ts",
          find: `  if (!res.ok) {\n    log.warn("webhook failed", { id: event.id, status: res.status });\n  }`,
          replace: `  if (!res.ok) {\n    const attempt = event.attempt + 1;\n    if (attempt >= MAX_ATTEMPTS) {\n      log.error("webhook gave up", { id: event.id, status: res.status, attempt });\n      return queue.deadLetter(event);\n    }\n    log.warn("webhook failed, retrying", { id: event.id, status: res.status, attempt });\n    return queue.schedule({ ...event, attempt }, backoffMs(attempt));\n  }`,
        },
      },
      { bash: "npm test -- webhooks" },
      { say: "All 14 webhook tests pass, including two new ones for the backoff curve and the dead-letter cut-off." },
    ],
    result:
      "Webhooks now retry with exponential backoff (2s → 5 min, ±20% jitter) and go to the dead-letter queue after 6 attempts. 14/14 tests pass.",
  },
  {
    match: /empty cart|cart is empty/i,
    long: true,
    steps: [
      { say: "I'll reproduce it first: the crash report points at `CartScreen` when `items` is empty." },
      { grep: "items\\[0\\]" },
      { read: "src/screens/CartScreen.tsx" },
      { read: "src/hooks/useCart.ts" },
      { say: "Found it: `CartScreen` reads `items[0].currency` to format the total, which is undefined when the cart is empty. Android crashes, iOS renders `NaN`." },
      {
        edit: {
          file: "src/screens/CartScreen.tsx",
          find: `const currency = items[0].currency;`,
          replace: `const currency = items[0]?.currency ?? store.defaultCurrency;`,
        },
      },
      { say: "Now an empty state, so the screen doesn't render a zero total with a disabled checkout button." },
      { bash: "npx jest src/screens/CartScreen.test.tsx" },
      { say: "Adding a regression test for the empty cart, then I'll run the Android build to confirm…" },
    ],
    result: "Fixed the empty-cart crash.",
  },
  {
    match: /.*/,
    steps: [{ say: "Looking at the code…" }, { read: "README.md" }, { say: "Done." }],
    result: "Done.",
  },
];

const ASK_ANSWER = `Session refresh lives in **\`src/auth/session.ts\`**, in \`refreshSession()\`.

## How it works

1. \`apiClient\` catches a \`401\` and calls \`refreshSession()\` once (\`src/api/client.ts:42\`).
2. It posts the refresh token to \`/auth/refresh\` and swaps both tokens in memory.
3. Requests that failed while it ran wait on the same promise, then retry.

| File | Role |
|---|---|
| \`src/auth/session.ts\` | refresh + token storage |
| \`src/api/client.ts\` | the 401 interceptor |
| \`src/auth/session.test.ts\` | covers the parallel-request case |

The refresh token is kept in an \`httpOnly\` cookie, so the browser never sees it.`;

// ── run ────────────────────────────────────────────────────────────────────
let prompt = "";
process.stdin.on("data", (d) => {
  prompt += d;
});
process.stdin.on("end", async () => {
  const resumeIdx = args.indexOf("--resume");
  const session = resumeIdx >= 0 ? args[resumeIdx + 1] : `demo-${label}-${Date.now()}`;
  const modeIdx = args.indexOf("--permission-mode");
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : "auto";
  const readOnly = mode === "plan" || args.includes("ask");
  out({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5-5", permissionMode: mode });

  // The first run on "work-max" hits its usage limit, so the queue falls back to the next account.
  const limitMarker = join(configDir, "demo-limit-hit");
  if (label === "work-max" && !readOnly && !existsSync(limitMarker)) {
    writeFileSync(limitMarker, "1");
    await sleep(900);
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, session_id: session });
    out({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your session limit · resets 6pm" }] }, error: "rate_limit", parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 6pm", session_id: session });
    process.exit(1);
  }

  if (readOnly) {
    await sleep(STEP_MS * 2);
    tool("a1", "Grep", { pattern: "refreshSession", path: "src" }, "4 matches");
    await sleep(STEP_MS);
    out({ type: "assistant", message: { content: [{ type: "text", text: ASK_ANSWER }] }, parent_tool_use_id: null });
    finish(session, ASK_ANSWER, { input: 8_200, output: 1_150, read: 42_000, write: 3_100 });
    return;
  }

  // The task message is the last layer of the prompt (or the whole reply).
  const script = SCRIPTS.find((s) => s.match.test(prompt.split("\n\n").slice(-3).join("\n\n"))) ?? SCRIPTS.at(-1);
  let n = 0;
  for (const step of script.steps) {
    await sleep(script.long ? STEP_MS * 4 : STEP_MS);
    const id = `t${++n}`;
    if (step.say) {
      for (const word of step.say.split(/(?<= )/)) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word } }, parent_tool_use_id: null });
      }
      out({ type: "assistant", message: { content: [{ type: "text", text: step.say }] }, parent_tool_use_id: null });
      continue;
    }
    if (step.read) tool(id, "Read", { file_path: step.read }, readSafe(step.read).slice(0, 400));
    if (step.grep) tool(id, "Grep", { pattern: step.grep, path: "src" }, "3 matches");
    if (step.bash) tool(id, "Bash", { command: step.bash, description: `Run ${step.bash}` }, "✓ passed");
    if (step.edit) {
      const file = join(process.cwd(), step.edit.file);
      mkdirSync(dirname(file), { recursive: true });
      if (step.edit.write !== undefined) {
        writeFileSync(file, step.edit.write);
        tool(id, "Write", { file_path: step.edit.file, content: step.edit.write }, "ok");
      } else {
        const before = readSafe(step.edit.file);
        writeFileSync(file, before.replace(step.edit.find, step.edit.replace));
        tool(id, "Edit", { file_path: step.edit.file, old_string: step.edit.find, new_string: step.edit.replace }, "ok");
      }
    }
  }
  if (script.long) {
    // Keep "working" until the screenshot script stops the server.
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Running " } }, parent_tool_use_id: null });
    await sleep(60 * 60 * 1000);
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: script.result }] }, parent_tool_use_id: null });
  finish(session, script.result, { input: 21_000 + prompt.length, output: 6_400, read: 310_000, write: 18_500 });
});

function tool(id, name, input, result) {
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result }] }, parent_tool_use_id: null });
}

function readSafe(rel) {
  try {
    return readFileSync(join(process.cwd(), rel), "utf8");
  } catch {
    return "";
  }
}

function finish(session, result, u) {
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: Number(((u.input * 15 + u.output * 75 + u.read * 1.5 + u.write * 18.75) / 1e6).toFixed(4)),
    session_id: session,
    usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write },
  });
  process.exit(0);
}
