# My AI Slaves — Design proposal (step 2)

Status: **proposal, awaiting OK**. Nothing here is built yet.

Decisions already made (from step 1):
- Accounts are logged in once on the **global Settings page**. Each repo has its own ordered
  `accountChain`; the run uses the first available account in that order and falls through on limits.
- Default permission mode is **auto** (Claude `--permission-mode auto --permission-prompts none`,
  Cursor `--auto-review`). Planning is something you ask for in the prompt itself.
- Limit detection is best-effort: structured for Claude, stderr pattern matching for Cursor.
- **Only one Cursor account can exist** (Cursor stores its login in the macOS Keychain under a fixed
  name, so it can't be isolated). The Settings page refuses a second Cursor account and says why.
  Logging in/out of that account is the same as logging in/out of `agent` on your Mac.

---

## 1. Folder structure

```
my-ai-slaves/
  package.json              # npm workspaces; scripts: dev, build, test, typecheck
  tsconfig.base.json
  .gitignore                # .data/, node_modules/, dist/
  docs/DESIGN.md
  packages/
    shared/                 # types only + tiny pure helpers (slugify, id format)
      src/
        types/settings.ts account.ts repo.ts knowledge.ts task.ts activity.ts stream.ts
        api.ts              # REST request/response types
        ws.ts               # WebSocket message unions
        ids.ts
    server/
      src/
        index.ts            # boot: 127.0.0.1:3005, Vite middleware (dev) / static (prod)
        paths.ts            # resolves .data/ paths in one place
        security/           # request-guard.ts (Host + Origin + Sec-Fetch-Site)
        storage/            # json-store.ts, activity-log.ts, write-queue.ts, time.ts
        providers/
          types.ts          # ProviderAdapter interface
          spawn.ts          # shared spawn + env scrubbing + NDJSON line reader
          claude-code/      # adapter.ts, parse-stream.ts, detect-limit.ts
          cursor-agent/     # adapter.ts, parse-stream.ts, detect-limit.ts
        services/
          prompt-assembler.ts
          account-service.ts  account-router.ts
          repo-service.ts     knowledge-service.ts
          worktree-service.ts git.ts
          queue-service.ts    task-runner.ts
        context/            # phase-2 extension point (see §6), empty in MVP
        login/login-service.ts  # in-app guided login (hidden pty)
        http/routes/        # settings, accounts, repos, knowledge, tasks, fs
        ws/hub.ts
        scripts/run-task.ts # step-3 harness: run a prompt on an account from the terminal
      test/
        fixtures/fake-claude.mjs fake-cursor.mjs  streams/*.ndjson
        *.test.ts
    web/
      src/
        main.tsx app.tsx
        lib/api.ts ws.ts notifications.ts
        pages/queue/ settings/ repos/ history/
        components/ui/      # shadcn
```

**One port in dev.** Fastify runs Vite in middleware mode, so `npm run dev` is a single process at
`http://localhost:3005` (UI + API + WS on one origin). This keeps the Host/Origin checks simple.
`node-pty` is a native module, so it needs the Xcode Command Line Tools installed.

Libraries: Fastify 5, `@fastify/websocket`, `@fastify/cookie`, `node-pty`, `tsx`, Vitest;
React 19, Vite, Tailwind 4, shadcn/ui, `@dnd-kit` (drag reorder), `@xterm/xterm`,
`react-diff-view` (multi-file unified diff, lighter than Monaco).

---

## 2. Security

- Listen on `127.0.0.1:3005` only.
- No token (changed after first run): open http://localhost:3005 directly.
- Every request: `Host` must be `localhost:3005` or `127.0.0.1:3005`; `Origin` (when present, always on WS)
  must be that origin; `Sec-Fetch-Site: cross-site|same-site` is refused.
- All child processes use `spawn(binary, argsArray, { shell: false })`.
- Static files are served only from `packages/web/dist`. Nothing under `.data/` is ever served.
  `cli-config/` contents are never read, logged, or listed by the app (only created/deleted as a folder).
- Child env scrubbing: remove `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`
  (otherwise Claude silently bills the API key instead of the subscription).

---

## 3. `.data/` file schemas

Conventions: 2-space indent, key order `id → label/name → rest → timestamps`, timestamps in local
ISO with offset (`2026-11-18T18:02:00+08:00`), atomic writes via `<file>.tmp` + rename, one write
queue per file, unparseable file → `<file>.corrupt-<timestamp>` + fresh default + console warning.

### `settings.json`
```json
{
  "basePrompt": "",
  "maxParallelTasks": 2,
  "limitCooldownMinutes": 60,
  "providers": {
    "claude-code": {
      "binary": "claude",
      "model": null,
      "permissionMode": "auto"
    },
    "cursor-agent": {
      "binary": "agent",
      "model": null,
      "permissionMode": "auto-review",
      "limitPatterns": []
    }
  },
  "updatedAt": "2026-11-18T18:02:00+08:00"
}
```
- `binary` is overridable so tests can point at fake CLIs.
- `cursor-agent.limitPatterns`: case-insensitive regexes matched against stderr on a non-zero exit.
  Ships **empty** with a built-in starter list in code (`usage limit`, `rate limit`, `quota`,
  `limit reached`) that you can override here. These are guesses until we see a real Cursor limit
  message; failed runs keep the stderr tail in activity so we can tighten them.
- There is no global fallback chain any more. Account order on the Settings page (order in
  `accounts.json`) is only used to pre-fill a newly registered repo's chain.

### `accounts.json`
```json
{
  "accounts": [
    {
      "id": "work_1-claude",
      "label": "work_1-claude",
      "provider": "claude-code",
      "configDir": ".data/cli-config/work_1-claude",
      "status": "available",
      "limitedUntil": null,
      "lastLimitReason": null,
      "createdAt": "2026-11-18T18:02:00+08:00",
      "updatedAt": "2026-11-18T18:02:00+08:00"
    }
  ]
}
```
- `id` = `label`, restricted to `[a-z0-9_-]`, unique.
- `status`: `available | limited | logged-out | unknown`. `limited` auto-expires when
  `limitedUntil` passes (checked on read and by a timer).
- `configDir` is relative to the project root.
- Login status comes from `claude auth status` (JSON `loggedIn`) / `agent status` (text), refreshed
  on the Settings page and after a run fails with an auth error.

### `repos.json`
```json
{
  "repos": [
    {
      "id": "supertri-web",
      "name": "supertri-web",
      "path": "/Users/you/code/supertri-web",
      "defaultBranch": "main",
      "accountChain": ["work_1-claude", "work_2-cursor", "personal-claude"],
      "createdAt": "2026-11-18T18:03:00+08:00",
      "updatedAt": "2026-11-18T18:03:00+08:00"
    }
  ]
}
```
- `id` = slug of the folder name (`-2`, `-3` on collision). Path must exist and be a git repo.
- `accountChain` is required to queue a task (empty chain → the chat panel tells you to set one).

### `knowledge/<repo-slug>.json`
```json
{
  "repo": "supertri-web",
  "basePrompt": "",
  "updatedAt": "2026-11-18T18:03:00+08:00"
}
```

### `queue.json`
```json
{
  "nextTaskNumber": 43,
  "tasks": [
    {
      "id": "task_0042_fix-login-redirect",
      "title": "fix login redirect",
      "repo": "supertri-web",
      "status": "needs-review",
      "message": "fix login redirect after SSO callback",
      "accountOverride": null,
      "currentAccount": "work_1-claude",
      "worktree": {
        "path": ".data/worktrees/supertri-web/task_0042_fix-login-redirect",
        "branch": "ai/task_0042_fix-login-redirect",
        "baseBranch": "main",
        "baseCommit": "3f2a9c1"
      },
      "session": { "provider": "claude-code", "account": "work_1-claude", "sessionId": "c6b6…" },
      "replies": [],
      "createdAt": "2026-11-18T18:04:00+08:00",
      "updatedAt": "2026-11-18T18:09:30+08:00"
    }
  ]
}
```
- Array order **is** queue order (drag-to-reorder rewrites it).
- `status` in this file: `pending | running | needs-review | interrupted`. `done` / `failed`
  tasks are removed from here; their history lives in activity.
- `title`/slug: first ~6 words of the message, slug max 40 chars.
- Branch is `ai/<task-id>`. The task id already contains the slug, so writing the slug again would repeat it.
- Worktrees live in `.data/worktrees/<repo>/<task-id>/` (new folder, not in your spec's layout),
  so nothing is created inside your repo's working tree. Git still records the worktree in the repo's
  `.git/worktrees/`, which is unavoidable and is cleaned up on discard.
- `replies`: follow-up messages you send to a task in needs-review (see §5).

### `activity/0001_activity.json`
Exactly your shape, plus an optional `data` object:
```json
{
  "file": "0001_activity.json",
  "createdAt": "2026-11-18T18:02:00+08:00",
  "entries": [
    {
      "at": "2026-11-18T18:05:12+08:00",
      "taskId": "task_0042_fix-login-redirect",
      "repo": "supertri-web",
      "account": "work_1-claude",
      "event": "started",
      "detail": "Started on work_1-claude (claude-code)",
      "data": { "prompt": "<full assembled prompt>", "branch": "ai/task_0042_fix-login-redirect" }
    }
  ]
}
```
Events: `queued, started, fallback, limit-hit, message, tool-call, file-edit, warning,
waiting, reply, finished, failed, cancelled, interrupted, kept, pushed, discarded`.
- Complete assistant messages and tool calls are logged, but not every partial text chunk
  (those go to the browser live only).
- Raw CLI output is **live-only**: kept in memory for the running task and shown by the raw
  toggle. It is not written to disk. The exception is stderr on failures and limit hits, whose last
  ~4 KB is stored in `data.stderrTail`.
- Rotation exactly as specified (size check before append, never split an entry). On startup the
  server builds an in-memory `taskId → files` index so history lookups don't rescan everything.

### `cli-config/<account-label>/`
Created empty when you add an account; the CLI fills it during login. Deleted when you delete the account.

---

## 4. ProviderAdapter interface

```ts
type ProviderId = "claude-code" | "cursor-agent";

interface ProviderAdapter {
  readonly provider: ProviderId;

  /** Start a headless run. Never uses a shell. */
  run(input: RunInput): RunHandle;

  /** Pure: classify a finished run's failure. Exposed for unit tests. */
  detectLimit(failure: RunFailure): LimitInfo | null;

  /** Login command, run in a hidden pty by LoginService (in-app guided login). */
  loginCommand(account: Account): SpawnSpec;

  /** Runs `claude auth status` / `agent status`. */
  checkAuth(account: Account): Promise<"logged-in" | "logged-out" | "unknown">;
}

interface RunInput {
  prompt: string;                 // fully assembled, sent verbatim
  account: Account;
  cwd: string;                    // the task worktree
  resume?: { sessionId: string; transcriptPath?: string };
}

interface RunHandle {
  onStream(cb: (e: StreamEvent) => void): () => void;   // normalized events
  onRaw(cb: (line: string, src: "stdout" | "stderr") => void): () => void;
  done: Promise<RunResult>;
  cancel(): Promise<void>;        // SIGINT → SIGTERM after 5s → SIGKILL after 10s
}

type StreamEvent =
  | { kind: "init"; sessionId: string; model: string; permissionMode: string }
  | { kind: "text-delta"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool-start"; callId: string; tool: string; summary: string; input: unknown }
  | { kind: "tool-end"; callId: string; ok: boolean; summary: string }
  | { kind: "file-edit"; path: string }
  | { kind: "warning"; text: string };

type RunResult =
  | { outcome: "success"; sessionId: string; resultText: string; costUsd: number | null }
  | { outcome: "limit"; limit: LimitInfo; sessionId: string | null }
  | { outcome: "logged-out"; message: string }
  | { outcome: "failed"; exitCode: number | null; message: string; stderrTail: string }
  | { outcome: "cancelled" };

interface LimitInfo { resetsAt: string | null; reason: string }   // null → +limitCooldownMinutes
```

**ClaudeCodeAdapter**: `claude -p --output-format stream-json --verbose --include-partial-messages
--permission-mode auto --permission-prompts none --settings {"autoContinueAtUsageLimit":false}
[--model] [--resume]`. The prompt goes in on stdin and the env var is `CLAUDE_CONFIG_DIR`. A limit is any of:
`rate_limit_event.status=rejected` (uses `resetsAt`), assistant `error: "rate_limit"`, or
`result.api_error_status=429` / text `You've hit your … limit · resets …`. If `init.permissionMode`
isn't `auto`, it emits a `warning` (auto mode isn't available for that model, so the run fell back to Manual).

**CursorAgentAdapter**: `agent -p --output-format stream-json --stream-partial-output --auto-review
--trust --workspace <cwd> [--model] [--resume] <prompt>`, with env var `CURSOR_CONFIG_DIR`. A limit is a
non-zero exit with stderr matching `limitPatterns`, and the reset time is always the cooldown.
`--trust` and `--auto-review` come from `--help` only, so I'll confirm them in step 3 before relying on them.

Your spec's `run / onStream / detectLimit / cancel` are all here. The only change is that `onStream`
and `cancel` live on the per-run handle, because two runs can be active at once.

---

## 5. Run rules (QueueService / AccountRouter)

- **Scheduling:** walk the queue in order; start a pending task if its repo has nothing running and
  total running < `maxParallelTasks`.
- **Account choice:** `accountOverride` (if set) first, then the repo's `accountChain`, skipping
  accounts that are limited or logged out. If none is available, the task stays pending with a
  `waiting` note ("next account free at 15:45") and the scheduler wakes at the earliest `limitedUntil`.
- **Limit mid-run → next account:** mark the account limited, **reset the worktree to `baseCommit`**
  (discarding the partial edits), and re-run the **same assembled prompt** on the next account. This keeps
  the "only my text is sent" rule, because resuming would need the app to send some "continue" text.
- **Follow-up replies** ("convey with the app"): typing into a needs-review task re-queues it
  and resumes the same CLI session in the same worktree, with your reply as the new prompt (no
  base prompts re-added). Resume only works within the same provider:
  - Claude → any other Claude account can resume by transcript path
    (`--resume /abs/.data/cli-config/<acct>/projects/…/<session>.jsonl`, documented).
  - Cursor ↔ Claude can't share sessions. If only other-provider accounts are free, the reply waits.
- **Restart:** tasks with `running` in `queue.json` come back as `interrupted` with Retry. Retry
  resets the worktree and re-runs from the start.
- **Review actions:**
  - **Keep:** the branch stays, the worktree is removed, and the task moves to done.
  - **Push:** `git push -u origin`, then `gh pr create` / `glab mr create` if installed. Otherwise the
    app gives you the compare URL to open.
  - **Discard:** after you confirm, the worktree and branch are removed.
  - **Never** commits to main/master. The agent's own commits land on `ai/<task-id>`; anything left
    uncommitted is shown in the diff as working-tree changes.

---

## 6. Phase 2 extension point: task context links

Paste a Jira/GitHub/Figma link and let the **agent** fetch it via MCP. The app doesn't fetch it or
inject text, which keeps "only my text is sent". The extension point is one reserved field per account:
`"mcpConfigPath": null` in `accounts.json`. Claude gets `--mcp-config <path>`. For Cursor, I still need to check
whether `mcp.json` follows `CURSOR_CONFIG_DIR`. Nothing else is built for this in the MVP.

---

## 7. HTTP API (all JSON, under `/api`)

| Method & path | Body → Response |
|---|---|
| `GET /settings` · `PUT /settings` | `Settings` |
| `GET /accounts` | `AccountView[]` (adds `secondsUntilAvailable`) |
| `POST /accounts` | `{ label, provider }` → `Account` (creates config dir) |
| `PUT /accounts/order` | `{ ids }` |
| `DELETE /accounts/:id` | removes config dir (Cursor: also runs `agent logout`, after confirm) |
| `POST /accounts/:id/login` | → `LoginState` (guided login; progress via WS `login.updated`) |
| `GET /logins/:id` · `POST /logins/:id/code` `{ code }` · `POST /logins/:id/cancel` | → `LoginState` |
| `POST /accounts/:id/check` | → `AccountView` (re-run auth status) |
| `POST /accounts/:id/clear-limit` | → `AccountView` |
| `GET /repos` · `POST /repos` | `{ path }` → `Repo` (validates git repo, creates knowledge file) |
| `PATCH /repos/:id` | `{ name?, accountChain? }` |
| `DELETE /repos/:id` | refused while it has queued tasks |
| `GET /fs/browse?path=` | `{ path, parent, dirs: [{ name, isGitRepo }] }` (dirs only) |
| `GET /repos/:id/knowledge` · `PUT` | `{ basePrompt }` |
| `POST /prompt/preview` | `{ repo, message }` → `{ prompt, layers: [{ name, included }] }` |
| `GET /tasks` | queue |
| `POST /tasks` | `{ repo, message, accountOverride? }` → `Task` |
| `PUT /tasks/order` | `{ ids }` |
| `POST /tasks/:id/cancel` · `/retry` · `/reply` `{ message }` | |
| `GET /tasks/:id/history` | `ActivityEntry[]` from all activity files |
| `GET /tasks/:id/diff` | `{ patch }` (unified diff vs `baseCommit`, incl. uncommitted) |
| `POST /tasks/:id/keep` · `/push` → `{ url }` · `/discard` `{ confirm: true }` | |
| `GET /history?before=&limit=` | finished/failed tasks (from activity) |

## 8. WebSocket (`/ws`, one connection)

Client → server
```ts
| { type: "subscribe"; topic: "queue" | "accounts" }
| { type: "subscribe"; topic: "task"; taskId: string }      // live stream + raw
| { type: "unsubscribe"; topic: string; taskId?: string }
```
Server → client
```ts
| { type: "queue.updated"; tasks: Task[] }
| { type: "accounts.updated"; accounts: AccountView[] }
| { type: "task.event"; taskId: string; event: StreamEvent }
| { type: "task.raw"; taskId: string; src: "stdout" | "stderr"; line: string }
| { type: "task.status"; taskId: string; status: TaskStatus; detail?: string }
| { type: "login.updated"; login: LoginState }
| { type: "notify"; title: string; body: string; taskId: string }   // → browser Notification
```
On subscribe to a running task, the server first replays its in-memory buffer so a reopened
tab catches up.

---

## 9. PromptAssembler rule

`[settings.basePrompt, knowledge.basePrompt, message]` → drop any layer whose `trim()` is empty →
join the rest with `"\n\n"`. Non-empty layers are passed through **unchanged** (no trimming, no
headings). Follow-up replies are sent alone (the session already has the base prompts).
