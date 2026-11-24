#!/usr/bin/env node
// Real screenshots of My AI Slaves for the landing page and marketing.
//
//   npm run landing:shots              (from the repo root; builds the web app first)
//
// 1. Makes a scratch data folder + three demo git repos in the OS temp folder (never your .data).
// 2. Starts a second copy of the server on SLAVES_PORT 3115, with demo-cli.mjs standing in for the
//    Claude / Cursor CLIs (no AI is called, nothing is sent anywhere).
// 3. Queues real tasks through the REST API, so the queue, diffs, fallbacks, live output and Ask chat
//    are produced by the app itself. History and Statistics get three weeks of made-up past runs.
// 4. Drives a headless Google Chrome over the DevTools protocol and saves PNG + WebP to public/shots/.
//
// Needs Google Chrome (or set CHROME_PATH) and the built web app (the root script builds it). macOS + Windows.
import { execFileSync, spawn } from "node:child_process";
import { killTree, openBrowser } from "./chrome.mjs";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");
const OUT = resolve(here, "..", "public", "shots");
const PORT = Number(process.env.SHOTS_PORT) || 3115;
const DEBUG_PORT = PORT + 10;
const BASE = `http://127.0.0.1:${PORT}`;
const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A short, fixed path: repo paths show in the screenshots. Emptied first, removed afterwards.
const work = join(isWin ? tmpdir() : "/tmp", "my-ai-slaves-demo");
rmSync(work, { recursive: true, force: true });
const dataDir = join(work, "data");
const reposDir = join(work, "code");
mkdirSync(dataDir, { recursive: true });
mkdirSync(reposDir, { recursive: true });
mkdirSync(OUT, { recursive: true });
console.log(`scratch: ${work}`);

const children = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) killTree(c);
  if (!process.env.KEEP_SCRATCH) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ── time helpers ───────────────────────────────────────────────────────────
const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
function iso(date) {
  const off = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}
const now = Date.now();
const ago = (ms) => new Date(now - ms);
const H = 3600_000;
const D = 24 * H;

// ── demo git repos ─────────────────────────────────────────────────────────
const PEOPLE = [
  ["Mara Quinn", "mara@studio.dev"],
  ["Theo Park", "theo@studio.dev"],
  ["Ines Ruiz", "ines@studio.dev"],
];

function git(cwd, args, env = {}) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true }).trim();
}

/** A repo with files and a history of commits, feature branches and merges (for the commit graph). */
function makeRepo(id, files, history) {
  const dir = join(reposDir, id);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", PEOPLE[0][0]]);
  git(dir, ["config", "user.email", PEOPLE[0][1]]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const write = (rel, text) => {
    const f = join(dir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  };
  let t = now - 26 * D;
  let i = 0;
  const commit = (msg) => {
    t += 3 * H + ((i * 7919) % 11) * 1800_000;
    const [name, email] = PEOPLE[i++ % PEOPLE.length];
    const when = iso(new Date(t));
    write(`changes/${String(i).padStart(3, "0")}.md`, `${msg}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", msg], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  commit("chore: initial commit");
  for (const step of history) {
    if (typeof step === "string") {
      commit(step);
      continue;
    }
    git(dir, ["checkout", "-q", "-b", step.branch]);
    for (const m of step.commits) commit(m);
    git(dir, ["checkout", "-q", "main"]);
    if (step.mainMeanwhile) for (const m of step.mainMeanwhile) commit(m);
    if (step.merge !== false) {
      t += H;
      const when = iso(new Date(t));
      const [name, email] = PEOPLE[i++ % PEOPLE.length];
      git(dir, ["merge", "-q", "--no-ff", step.branch, "-m", `Merge branch '${step.branch}'`], {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
      if (step.deleteAfter !== false) git(dir, ["branch", "-q", "-D", step.branch]);
    }
  }
  return dir;
}

const storefront = makeRepo(
  "storefront",
  {
    "package.json": `{\n  "name": "storefront",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build",\n    "test": "vitest run",\n    "typecheck": "tsc --noEmit",\n    "lint": "biome lint"\n  }\n}\n`,
    "README.md": "# Storefront\n\nThe shop's web front end.\n",
    "src/components/Header.tsx": `import { CartButton } from "./CartButton";\nimport { Logo } from "./Logo";\nimport { Search } from "./Search";\n\nexport function Header() {\n  return (\n    <header className="site-header">\n      <Logo />\n      <Search />\n      <nav className="header-actions">\n        <CartButton />\n      </nav>\n    </header>\n  );\n}\n`,
    "src/styles/tokens.css": ":root {\n  --bg: #fbf9f7;\n  --fg: #221c18;\n  --muted: #6f665d;\n  --line: #e8e2db;\n}\n",
  },
  [
    "feat: product grid with lazy images",
    { branch: "feat/search", commits: ["feat(search): instant results", "fix(search): debounce input"], mainMeanwhile: ["fix: header overflow on small screens"] },
    "chore: bump vite",
    { branch: "feat/checkout", commits: ["feat(checkout): address step", "feat(checkout): payment step", "test(checkout): happy path"] },
    "perf: preload hero font",
    { branch: "fix/cart-badge", commits: ["fix(cart): badge count after remove"], mainMeanwhile: ["docs: deploy notes"] },
    "feat: wishlist",
    { branch: "feat/reviews", commits: ["feat(reviews): stars + text", "feat(reviews): moderation queue"], merge: false },
    "fix: price rounding in summary",
  ],
);

const payments = makeRepo(
  "payments-api",
  {
    "package.json": `{\n  "name": "payments-api",\n  "private": true,\n  "scripts": {\n    "dev": "tsx watch src/server.ts",\n    "test": "vitest run",\n    "migrate": "tsx src/db/migrate.ts"\n  }\n}\n`,
    "README.md": "# Payments API\n",
    "src/webhooks/deliver.ts": `import { log } from "../log";\nimport { queue } from "../queue";\nimport { signPayload } from "./sign";\n\nexport async function deliverWebhook(event: WebhookEvent) {\n  const body = JSON.stringify(event.payload);\n  const res = await fetch(event.url, {\n    method: "POST",\n    headers: { "content-type": "application/json", "x-signature": signPayload(body) },\n    body,\n  });\n  if (!res.ok) {\n    log.warn("webhook failed", { id: event.id, status: res.status });\n  }\n  return queue.ack(event);\n}\n`,
    "src/webhooks/deliver.test.ts": "// tests\n",
  },
  [
    "feat: stripe intents",
    { branch: "feat/refunds", commits: ["feat(refunds): partial refunds", "test(refunds): currency edge cases"] },
    "fix: idempotency key collision",
    { branch: "feat/payouts", commits: ["feat(payouts): weekly schedule"], mainMeanwhile: ["chore: pin node 22"] },
    "feat: webhook signatures",
  ],
);

const mobile = makeRepo(
  "mobile-app",
  {
    "package.json": `{\n  "name": "mobile-app",\n  "private": true,\n  "scripts": {\n    "android": "expo run:android",\n    "ios": "expo run:ios",\n    "test": "jest"\n  }\n}\n`,
    "README.md": "# Mobile app\n",
    "src/screens/CartScreen.tsx": `import { useCart } from "../hooks/useCart";\nimport { formatMoney } from "../lib/money";\n\nexport function CartScreen() {\n  const { items, total } = useCart();\n  const currency = items[0].currency;\n  return <CartList items={items} total={formatMoney(total, currency)} />;\n}\n`,
    "src/hooks/useCart.ts": "export function useCart() {\n  return { items: [], total: 0 };\n}\n",
  },
  ["feat: cart screen", { branch: "feat/push", commits: ["feat: push notifications"] }, "fix: android back button"],
);

// ── data folder ────────────────────────────────────────────────────────────
const demoCli = join(here, isWin ? "demo-cli.cmd" : "demo-cli.mjs");
if (isWin) writeFileSync(demoCli, `@node "%~dp0\\demo-cli.mjs" %*\r\n`);
const writeJson = (rel, value) => {
  const f = join(dataDir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(value, null, 2)}\n`);
};
const stamp = iso(new Date(now));

writeJson("settings.json", {
  basePrompt:
    "You are working in a real repository. Keep changes small and focused, match the existing code style, and run the project's typecheck and tests before you finish.",
  maxParallelTasks: 1,
  limitCooldownMinutes: 60,
  committers: [
    { id: "studio", name: "Mara Quinn", email: "mara@studio.dev", label: "Work" },
    { id: "personal", name: "Mara Q.", email: "mara@hey.example", label: "Personal" },
  ],
  defaultCommitterId: "studio",
  commitAvatars: false,
  providers: {
    "claude-code": { binary: demoCli, model: null, permissionMode: "auto" },
    "cursor-agent": { binary: demoCli, model: null, permissionMode: "auto-review", limitPatterns: [] },
  },
  updatedAt: stamp,
});

const ACCOUNTS = [
  ["work-max", "claude-code"],
  ["personal-pro", "claude-code"],
  ["side-max", "claude-code"],
  ["cursor", "cursor-agent"],
];
for (const [id] of ACCOUNTS) mkdirSync(join(dataDir, "cli-config", id), { recursive: true });
writeJson("accounts.json", {
  accounts: ACCOUNTS.map(([id, provider]) => ({
    id,
    label: id,
    provider,
    host: null,
    configDir: join(dataDir, "cli-config", id),
    binary: null,
    status: "unknown",
    limitedUntil: null,
    lastLimitReason: null,
    mcpConfigPath: null,
    createdAt: stamp,
    updatedAt: stamp,
  })),
});

const CHAINS = {
  storefront: ["personal-pro", "work-max", "side-max"],
  "payments-api": ["work-max", "personal-pro", "side-max"],
  "mobile-app": ["side-max", "personal-pro", "work-max"],
};
writeJson("repos.json", {
  repos: [
    { id: "storefront", name: "Storefront", path: storefront, labels: ["web", "company"] },
    { id: "payments-api", name: "Payments API", path: payments, labels: ["api", "company"] },
    { id: "mobile-app", name: "Mobile app", path: mobile, labels: ["mobile", "personal"] },
  ].map((r) => ({ ...r, host: null, defaultBranch: "main", accountChain: CHAINS[r.id], committerId: "studio", committerName: null, committerEmail: null, createdAt: stamp, updatedAt: stamp })),
  labelColors: { web: "blue", api: "violet", mobile: "teal", company: "amber", personal: "green" },
});

const REPO_PROMPTS = [
  { id: "workflow", name: "Branch + merge request", default: true, body: "Work on a new branch named after the task. Commit with Conventional Commits, push, and open a merge request against main." },
  { id: "style", name: "Code style", default: true, body: "TypeScript strict. Small functions, no new dependencies without asking. Match the file's existing patterns." },
  { id: "tests", name: "Write tests", default: false, body: "Add or update tests for every behaviour you change." },
];
for (const id of ["storefront", "payments-api", "mobile-app"]) {
  writeJson(`knowledge/${id}.json`, { repo: id, prompts: REPO_PROMPTS.map((p) => ({ ...p, attachments: [], createdAt: stamp, updatedAt: stamp })), updatedAt: stamp });
}

writeJson("prompts.json", {
  prompts: [
    { id: "review-like-a-senior", name: "Review like a senior", body: "Before you finish, review your own diff like a senior engineer would: naming, edge cases, dead code." },
    { id: "explain-the-fix", name: "Explain the fix", body: "End with a short summary: the root cause, what you changed and how you verified it." },
    { id: "jira-ticket", name: "Analyze Jira ticket", body: "Read the ticket below, list open questions first, then implement the smallest change that satisfies it." },
    { id: "a11y-pass", name: "Accessibility pass", body: "Check keyboard focus, labels and contrast on every screen you touch." },
  ].map((p) => ({ ...p, attachments: [], createdAt: stamp, updatedAt: stamp })),
});

// Three weeks of past work for History + Statistics.
const PAST = [
  ["storefront", "Add skeleton loaders to the product grid"],
  ["payments-api", "Add partial refunds endpoint"],
  ["storefront", "Fix layout shift on the hero image"],
  ["mobile-app", "Support Android 15 edge-to-edge"],
  ["payments-api", "Rotate webhook signing secrets"],
  ["storefront", "Migrate forms to the new validation lib"],
  ["mobile-app", "Cache product images offline"],
  ["payments-api", "Log idempotency key collisions"],
  ["storefront", "Keyboard navigation for the mega menu"],
  ["storefront", "Write Playwright tests for search"],
  ["mobile-app", "Fix the double tap on Add to cart"],
  ["payments-api", "Paginate the payouts list"],
  ["storefront", "Lazy-load the reviews widget"],
  ["payments-api", "Upgrade to Fastify 5"],
  ["mobile-app", "Haptics on successful checkout"],
  ["storefront", "Translate checkout to Spanish"],
  ["payments-api", "Alert on failed payouts"],
  ["storefront", "Remove the legacy coupon code path"],
  ["mobile-app", "Deep links into product pages"],
  ["payments-api", "Explain the currency rounding bug"],
  ["storefront", "Add an empty state to the wishlist"],
  ["storefront", "Speed up the CI typecheck"],
  ["mobile-app", "Dark mode for the order history"],
  ["payments-api", "Seed script for local dev"],
  ["storefront", "Fix focus trap in the cart drawer"],
  ["payments-api", "Retry DB connection on boot"],
  ["mobile-app", "Pull to refresh on orders"],
  ["storefront", "Add OpenGraph images to products"],
  ["payments-api", "Document the refunds API"],
  ["storefront", "Debounce the price filter"],
  ["mobile-app", "Fix keyboard covering the address form"],
  ["payments-api", "Add a health check endpoint"],
  ["storefront", "Sort products by popularity"],
  ["mobile-app", "Crash report breadcrumbs"],
];
const lines = [];
const accountsFor = ["work-max", "personal-pro", "side-max", "work-max", "personal-pro"];
PAST.forEach(([repo, title], i) => {
  const taskId = `task_${String(i + 1).padStart(4, "0")}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
  const start = ago(29 * D - i * (28.5 * D / PAST.length) - ((i * 37) % 5) * H);
  let t = start.getTime();
  const at = (plusMin) => {
    t += plusMin * 60_000;
    return iso(new Date(t));
  };
  const account = accountsFor[i % accountsFor.length];
  const fellBack = i % 6 === 2;
  const runAccount = fellBack ? "personal-pro" : account;
  const e = (event, detail, acct, data, plus = 1) => lines.push({ at: at(plus), taskId, repo, account: acct, event, detail, ...(data ? { data } : {}) });
  e("queued", `Queued: ${title}`, null, { title, message: title }, 0);
  if (fellBack) {
    e("started", "Started on work-max (claude-code)", "work-max", { prompt: title, kind: "fresh" });
    e("limit-hit", "work-max hit a usage limit (session limit). Free again at 6pm.", "work-max");
    e("fallback", "Falling back to personal-pro.", "personal-pro");
  }
  e("started", `Started on ${runAccount} (claude-code)`, runAccount, { prompt: title, kind: "fresh" });
  e("message", "Looking at the code first.", runAccount, { text: "Looking at the code first." }, 2);
  e("tool-call", "Read: src/index.ts", runAccount, { tool: "Read" }, 1);
  e("file-edit", "src/index.ts", runAccount, null, 3);
  const scale = 0.6 + ((i * 53) % 10) / 6;
  const usage = {
    inputTokens: Math.round(18_000 * scale),
    outputTokens: Math.round(5_200 * scale),
    cacheReadTokens: Math.round(260_000 * scale),
    cacheWriteTokens: Math.round(16_000 * scale),
    costUsd: Number((1.1 * scale).toFixed(2)),
  };
  e("finished", `Finished on ${runAccount}. Ready for review.`, runAccount, { result: "Done.", costUsd: usage.costUsd, usage }, 6 + (i % 9));
  if (i % 9 === 4) e("discarded", "Discarded. The repo was left as it is.", null, null, 20);
  else e("marked-finished", "Marked finished.", runAccount, null, 15 + (i % 30));
});
mkdirSync(join(dataDir, "activity"), { recursive: true });
writeFileSync(join(dataDir, "activity", "0001_activity.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
writeJson("queue.json", { nextTaskNumber: PAST.length + 1, tasks: [] });

// ── server ─────────────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, "packages", "web", "dist", "index.html"))) {
  console.error("Build the web app first: npm run build");
  process.exit(1);
}
if (await fetch(`${BASE}/api/session`).then(() => true, () => false)) {
  console.error(`Port ${PORT} is already in use (an earlier run?). Stop it or set SHOTS_PORT.`);
  process.exit(1);
}
const env = { ...process.env, SLAVES_DATA_DIR: dataDir, SLAVES_PORT: String(PORT), NODE_ENV: "production", DEMO_STEP_MS: "240" };
for (const k of ["SLAVES_WEB_DIR", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "ELECTRON_RUN_AS_NODE"]) delete env[k];
// `--import tsx` keeps the server in this one process (the tsx CLI would fork a child that outlives a kill).
const server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "packages", "server", "src", "index.ts")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
children.push(server);
server.on("exit", (code) => {
  if (!cleaned) {
    console.error(`server exited (${code}); rerun with DEBUG_SHOTS=1 to see why`);
    process.exit(1);
  }
});
server.stderr.on("data", (d) => process.env.DEBUG_SHOTS && process.stderr.write(d));
server.stdout.on("data", (d) => process.env.DEBUG_SHOTS && process.stdout.write(d));

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function waitFor(what, check, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await check();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
await waitFor("server", () => api("/api/session"));
console.log(`server up on ${BASE}`);

const tasks = async () => {
  const r = await api("/api/tasks");
  return Array.isArray(r) ? r : r.tasks;
};
async function queueAndWait(repo, message, status, extra = {}) {
  const created = await api("/api/tasks", { repo, message, ...extra });
  const id = created.id ?? created.task?.id;
  if (status) await waitFor(`${id} → ${status}`, async () => (await tasks()).find((t) => t.id === id && t.status === status), 60_000);
  return id;
}
await queueAndWait("storefront", "Add a dark mode toggle to the header. Follow the OS setting until the user picks one, and remember the pick.", "needs-review");
await queueAndWait("payments-api", "Retry failed webhook deliveries with exponential backoff, and give up after a few attempts.", "needs-review", { repoPromptIds: ["workflow", "style", "tests"] });
await queueAndWait("mobile-app", "Fix the crash on Android when the cart is empty, and add a regression test.", "running", { promptIds: ["explain-the-fix"] });
await queueAndWait("storefront", "Write Playwright tests for the checkout flow: address, payment and the confirmation page.", null);
await queueAndWait("payments-api", "Add rate limiting to the public endpoints (100 req/min per key).", null);
await api("/api/tasks", { repo: "storefront", message: "Redesign the product page gallery: swipe on mobile, thumbnails on desktop.", draft: true });
await api("/api/ask", { message: "Where is the session refresh handled, and what happens to requests that fail while it runs?", repo: "storefront" }).catch((e) =>
  console.warn(`ask: ${e.message}`),
);
await sleep(4000); // let the long run stream a few steps and the Ask chat answer

// ── chrome ─────────────────────────────────────────────────────────────────
const browser = await openBrowser({ profileDir: join(work, "chrome"), debugPort: DEBUG_PORT });
children.push({ kill: () => browser.close(), pid: null });
const { evaluate } = browser;
const setup = (theme, w, h) => browser.setup(theme, w, h);
const go = (hash) => browser.navigate(`${BASE}/#/${hash}`, 1600);
/** Click the innermost visible element whose text contains `text`. */
async function click(text, nth = 0) {
  const ok = await evaluate(`(() => {
    const want = ${JSON.stringify(text)};
    const all = [...document.querySelectorAll("button, a, [role=tab], [role=button], li, [data-slot], div, span, td")]
      .filter((el) => el.offsetParent !== null && el.textContent && el.textContent.includes(want));
    const inner = all.filter((el) => ![...el.children].some((c) => c.textContent && c.textContent.includes(want)));
    const el = inner[${nth}];
    if (!el) return false;
    const target = el.closest("button, a, [role=tab], [role=button], [role=option], li, [data-task-id]") ?? el;
    target.click();
    return true;
  })()`);
  if (!ok) console.warn(`  (no element with text "${text}")`);
  await sleep(900);
  return ok;
}
async function shot(name) {
  // PNG for marketing use, WebP (a fraction of the size) for the landing page itself.
  await browser.screenshot(join(OUT, `${name}.png`));
  await browser.screenshot(join(OUT, `${name}.webp`));
  console.log(`  saved shots/${name}.png + .webp`);
}

const W = 1600;
const HGT = 1000;
for (const theme of ["light", "dark"]) {
  await setup(theme, W, HGT);
  await go("queue");
  await click("Fix the crash on Android");
  await sleep(1500);
  await shot(`queue-running-${theme}`);

  await click("Add a dark mode toggle");
  await shot(`queue-review-${theme}`);

  await click("Retry failed webhook");
  await shot(`queue-fallback-${theme}`);

  await go("repos");
  await evaluate(`document.querySelector('[aria-label="Open the commit graph of Storefront"]')?.click()`);
  await sleep(2500);
  await shot(`repos-graph-${theme}`);

  await go("stats");
  await sleep(800);
  await shot(`stats-${theme}`);

  await go("history");
  await click("Crash report breadcrumbs");
  await shot(`history-${theme}`);

  await go("ask");
  await click("Where is the session refresh");
  await shot(`ask-${theme}`);

  await go("prompts");
  await shot(`prompts-${theme}`);

  await go("settings");
  await shot(`settings-${theme}`);
}

cleanup();
console.log(`\nDone: ${OUT}`);
process.exit(0);
