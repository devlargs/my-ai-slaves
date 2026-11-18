# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**My AI Slaves**: a local web app (macOS first) that queues AI coding tasks and runs them through the
Claude Code CLI and the Cursor Agent CLI, falling back across several logged-in subscriptions when one
hits a usage limit. Each task runs in its own git worktree on an `ai/<task-id>` branch; you review the
diff, then keep / push + open a PR / discard.

## Commands

```bash
npm install            # also fixes node-pty's spawn-helper permission (postinstall)
npm run dev            # server + Vite (middleware mode) at http://localhost:3005
npm run build          # build the web app (packages/web/dist)
npm start              # production mode, serves the built web app
npm test               # Vitest (server package): fake CLIs + real temp git repos
npm run typecheck      # tsc in every package (TypeScript 7)
npx vitest run test/<file>.test.ts   # one test file (run inside packages/server)
```

There is no watch mode for the server: restart `npm run dev` after server changes. Web changes hot-reload.

## Layout

```
packages/shared   zod schemas for every .data file + REST/WS contract types (api.ts, ws.ts, stream.ts)
packages/server   Fastify 5 + @fastify/websocket + node-pty (Node 22, run with tsx)
  src/storage     JsonStore (atomic writes, per-file queue, corrupt-file backup), ActivityLog (5 MB rotation),
                  AttachmentStore. The only code that touches .data/.
  src/providers   ProviderAdapter per CLI: claude-code/, cursor-agent/ (args, stream parser, limit detection)
  src/services    PromptAssembler, AccountRouter (pure) + AccountService, RepoService, WorktreeService,
                  QueueService (scheduler, runs, fallback, replies, review actions)
  src/login       LoginService: drives `claude auth login` / `agent login` in a hidden pty
  src/http, src/ws, src/security (Host / Origin / Sec-Fetch-Site guard; no token)
packages/web      React 19 + Vite 8 + Tailwind 4, hand-written shadcn-style components (radix-ui)
docs/DESIGN.md    architecture proposal (schemas, API, adapter interface)
design.md         locked visual design system (Hallmark, Coral theme): read before UI changes
```

## Data (`.data/`, gitignored, never commit it)

Plain pretty-printed JSON: `settings.json`, `accounts.json`, `repos.json`, `queue.json`,
`knowledge/<repo>.json`, `activity/NNNN_activity.json`, `attachments/<id>/`, `worktrees/`,
`cli-config/<account>/` (CLI logins: never read, log or serve). It can contain the user's API tokens.
Use `SLAVES_DATA_DIR=<dir>` to point the server or scripts at a scratch folder when testing, and
`SLAVES_PORT=<port>` (default 3005) to run that test copy next to the user's running app. Never stop
a process on 3005 without checking it isn't the user's own app (no `SLAVES_DATA_DIR` = theirs).

## Rules that must hold

- **Prompts:** the only text sent to a CLI is global base prompt → repo base prompt → task message,
  joined by a blank line, empty layers skipped. The single exception is the visible "Attached files:"
  path list when files are attached. Never add hidden system/role/wrapper text anywhere. Replies resume
  the session and send only the reply (+ its attachments).
- **Every started run is logged** in activity with its full assembled prompt.
- **No AI attribution** in commits or PRs: Claude runs with `attribution: false`, Cursor's cli-config sets
  `attributeCommitsToAgent/attributePRsToAgent: false`, and Keep/Push strip leftover co-author lines.
  Task commits use the repo's committer name/email when set.
- **Never touch the user's main working tree** or commit to main/master: only `ai/` branches in worktrees.
- **Security:** bind 127.0.0.1 only; spawn with argument arrays, never a shell string; scrub
  `ANTHROPIC_API_KEY` / `CURSOR_API_KEY` etc. from child envs.
- Cursor supports **one** account only (its login lives in the macOS Keychain under a fixed name).
- Verify CLI flags against the official docs before using them; don't guess.

## Commits

- **Commit every finished request locally right away**, one commit per request. Don't push unless asked.
- **Author / committer is always `Ralph Largo <devlargs@gmail.com>`** (set in this repo's local git
  config; check with `git config user.email` before committing, never commit as anyone else).
- **No signature**: no `Co-Authored-By`, no "Generated with Claude Code", no emoji footer.
- **Always [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):**

  ```
  <type>[optional scope][!]: <description>

  [optional body]

  [optional footer(s)]
  ```

  - `type`: `feat` (new feature → MINOR), `fix` (bug fix → PATCH), or `docs`, `style`, `refactor`,
    `perf`, `test`, `build`, `ci`, `chore`, `revert`.
  - `scope` (optional) is a noun in parentheses for the area touched, e.g. `feat(queue):`,
    `fix(login):`, `refactor(server):`, `docs(claude-md):`.
  - `description`: imperative, lowercase start, no trailing period, right after `: `.
  - Body (optional): one blank line after the description; explain what and why.
  - Breaking changes: `!` before the colon (`feat(api)!: ...`) and/or a `BREAKING CHANGE: <what>`
    footer. Footers otherwise follow git-trailer format (`Refs: #123`), but never signature trailers.

## Working with the user
- The user prefers getting things done in one go and refining after.
- UI changes follow `design.md` (modern-minimal, Coral theme, Geist). Reuse `PageHeader`, the
  `Button` variants (`signal` = the one coral main action per view) and the tokens in `tokens.css`.
- `../ai-worker` is the user's earlier app; when unsure how a flow should feel, check how it does it.
