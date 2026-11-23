# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**My AI Slaves**: a local web app, also packaged as an Electron desktop app for
**macOS and Windows**, that queues AI coding tasks and runs them through the
Claude Code CLI and the Cursor Agent CLI, falling back across several logged-in subscriptions when one
hits a usage limit. Each task runs **directly in the repo, exactly as it's checked out**: the app never
creates, switches, resets, commits or deletes branches, and never makes worktrees. The repo prompts tell
the agent how to handle changes (branching, commits, MRs). You review what changed, then mark the task
finished or discard it.

## Commands

```bash
npm install            # also fixes node-pty's spawn-helper permission (postinstall)
npm run dev            # server + Vite (middleware mode) at http://localhost:3005
npm run build          # build the web app (packages/web/dist)
npm start              # production mode, serves the built web app
npm test               # Vitest (server + desktop packages): fake CLIs + real temp git repos
npm run typecheck      # tsc in every package (TypeScript 7)
npx vitest run test/<file>.test.ts   # one test file (run inside packages/server or packages/desktop)
npm run desktop        # build web, stage packages/desktop/app, open it in Electron
npm run desktop:dist   # same, then electron-builder → packages/desktop/release (this Mac's CPU only)
npm run data:init | data:demo-activity | prompt:preview   # server scripts (src/scripts/)
```

There is no watch mode for the server: restart `npm run dev` after server changes. Web changes hot-reload.
Node 22 (`.nvmrc`). The dev server's Vite HMR uses port `SLAVES_PORT + 1`.

## Layout

```
packages/shared   zod schemas for every .data file + REST/WS contract types (api.ts, ws.ts, stream.ts)
packages/server   Fastify 5 + @fastify/websocket + node-pty (Node 22, run with tsx)
  src/storage     JsonStore (atomic writes, per-file queue, corrupt-file backup), ActivityLog (5 MB rotation),
                  AttachmentStore. The only code that touches .data/.
  src/providers   ProviderAdapter per CLI: claude-code/, cursor-agent/ (args, stream parser, limit detection)
  src/services    PromptAssembler, AccountRouter (pure) + AccountService, RepoService, BranchService,
                  QueueService (scheduler, runs, fallback, replies, review actions), RepoActions (graph
                  toolbar: undo/redo/pull/branch), ScriptService
                  (runs a repo's package.json scripts from the Repos page, locally or over ssh; stopped on quit)
  src/login       LoginService: drives `claude auth login` / `agent login` in a hidden pty
  src/remote        machine.ts (run git/CLIs locally or over ssh), hosts.ts (~/.ssh/config aliases)
  src/http, src/ws, src/security (Host / Origin / Sec-Fetch-Site guard; no token)
  src/scripts       data-init, demo-activity, prompt-preview, run-task
packages/web      React 19 + Vite 8 + Tailwind 4, hand-written shadcn-style components (radix-ui)
                  pages: queue, history, repos, prompts, settings, stats (token usage per account + overall)
packages/desktop  Electron 45 shell (main.ts, preload.ts): picks the data folder (remembered in
                  <userData>/desktop.json), forks the bundled server on Electron's Node
                  (ELECTRON_RUN_AS_NODE, SLAVES_DATA_DIR/SLAVES_PORT/SLAVES_WEB_DIR), loads the same UI,
                  pulls the login shell's PATH on macOS (shell-env.ts), and src/updater/ (in-app updates
                  from GitHub Releases, sha256-verified; token from GH_TOKEN/GITHUB_TOKEN or `gh auth token`;
                  downloads are picked for the Mac's real chip, and an Intel build running under Rosetta
                  offers to replace itself with the Apple Silicon one).
                  scripts/build.mjs stages app/ (esbuild + node-pty prebuilds); electron-builder.config.cjs
                  packages it unsigned (macOS ad-hoc signed in scripts/after-pack.cjs, asar off).
.github/workflows release.yml: every push to main (except *.md / .github/** only) runs checks.yml
                  (audit, typecheck, test), builds arm64 + x64 DMGs and a Windows NSIS .exe, commits
                  `chore: bump version to vX.Y.Z` and publishes a GitHub Release.
docs/DESIGN.md    architecture proposal (schemas, API, adapter interface)
design.md         locked visual design system (Hallmark, Coral theme): read before UI changes
```

## Data (`.data/`, gitignored, never commit it)

Plain pretty-printed JSON: `settings.json`, `accounts.json`, `repos.json`, `queue.json`,
`prompts.json` (saved prompt library), `knowledge/<repo>.json` (the repo's prompts; repos also carry
a display name and `labels` for filtering, renaming never touches the folder), `activity/NNNN_activity.json`, `attachments/<id>/`,
`cli-config/<account>/` (CLI logins: never read, log or serve). It can contain the user's API tokens.
Use `SLAVES_DATA_DIR=<dir>` to point the server or scripts at a scratch folder when testing, and
`SLAVES_PORT=<port>` (default 3005) to run that test copy next to the user's running app. Never stop
a process on 3005 without checking it isn't the user's own app (no `SLAVES_DATA_DIR` = theirs; the
desktop app also uses 3005 and refuses to start if it's taken).

## Rules that must hold

- **Prompts:** the only text sent to a CLI is global base prompt → the repo prompts ticked for that task
  (main repo first, then each other repo of a cross-repo task; each repo has a list in `knowledge/<repo>.json`, in list order; `default` ones come pre-ticked, and a
  task queued without `repoPromptIds` gets the defaults) → saved prompts bound to that message (from the
  Prompts library, `.data/prompts.json`, in library order) → task message, joined by a blank line, empty
  layers skipped. The only app-written text is two visible path lists: "Other repositories:" (a
  cross-repo task's other repos, after the message) and "Attached files:" (when files are attached: the ticked/bound prompts' saved screenshots
  first, in prompt order, then the message's). Never add hidden system/role/wrapper text anywhere. Replies resume
  the session and send only the reply (+ its attachments).
- **Every started run is logged** in activity with its full assembled prompt.
- **No AI attribution** in commits or PRs: Claude runs with `attribution: false`, Cursor's cli-config sets
  `attributeCommitsToAgent/attributePRsToAgent: false`. The agent's commits use the repo's committer
  (picked from the committers saved on the Settings page, else the default committer, else git config;
  passed as GIT_* env).
- **No branches, no worktrees, ever.** The app does **not** create `ai/…` (or any) branches, check out,
  reset, commit, stash, push or delete anything in a repo: not in the main repo, not in a cross-repo
  task's other repos. Runs happen in the checkout as it is (no clean-tree requirement); the repo prompts
  decide how changes are handled. The only git the app runs on a task is read-only (where the checkout
  is, and the diff since the task started), plus the one-time legacy worktree migration. Claude runs with
  `--disallowedTools EnterWorktree ExitWorktree "Bash(git worktree *)"`, and Cursor never gets `-w`.
  The one exception is the Repos commit graph (`src/services/repo-actions.ts`): the toolbar's Undo, Redo,
  Pull and Branch, and the WIP panel's Stage / Unstage file (or all) and Commit (summary + description,
  amend, skip hooks; uses the repo's committer), and the right-click menu on a branch or commit
  (GitKraken's: pull/push/set upstream, merge, rebase, interactive rebase, checkout, create branch,
  cherry-pick, reset soft/mixed/hard, revert, rename/delete branch, tags; a conflicting merge/rebase/
  cherry-pick/revert is aborted), and the sidebar's Stashes group (right-click: apply, pop, delete,
  edit message; stashes are listed there, not drawn in the graph) change the repo **only when you click them**, and are refused while a
  task runs there. Its Hide / Solo / Pin to Left only change the view (localStorage); its "Create
  worktree" and "Explain Branch Changes" items are left out on purpose.
  Undo/Redo read HEAD's reflog (their own commands are tagged `my-ai-slaves` via GIT_REFLOG_ACTION).
- **Cross-repo tasks:** a task can tick several repos (`extraRepos`, same machine as the main `repo`).
  The CLI runs in the main repo and gets the others via `--add-dir` + the "Other repositories:" list.
  Their ticked repo prompts (sent after the main repo's) say how to handle changes in them. A repo is in
  at most one running task at a time.
- **Base prompts reach the CLI:** tests assert the exact text the (fake) CLIs receive; each task view shows
  "… received: ✓ global base prompt ✓ repo: <ticked prompts>" from the run's recorded prompt.
- **Security:** bind 127.0.0.1 only; spawn with argument arrays, never a shell string; scrub
  `ANTHROPIC_API_KEY` / `CURSOR_API_KEY` etc. from child envs.
- Cursor supports **one** account on this Mac (its login lives in the macOS Keychain under a fixed name).
- **Remote repos (SSH, like VS Code Remote Explorer):** a repo or account can have a `host` (an alias from
  `~/.ssh/config`). For those, git and the CLI run **on that server** via `ssh` (`src/remote/machine.ts`):
  every argument is `shq`-quoted, host names are validated, `~/.local/bin` is added to PATH, remote runs
  announce their PID so Cancel kills them on the server, and attachments are streamed to
  `~/.my-ai-slaves/attachments/` there. Remote accounts use the server's own login (one per CLI per host;
  deleting one never logs the server out) and only serve repos on the same host. Never run
  `cursor-agent status` on a server: old versions start a login instead. Repos are checked for
  reachability every minute; unreachable ones show disabled with an alert, and their tasks wait.
  Tests use `test/fixtures/fake-ssh.mjs` (`SLAVES_SSH_BIN`), which runs the remote command locally.
- **macOS and Windows:** everything must work on both. Use `node:path` (`join`, `delimiter`), not
  hard-coded `/` or `:`; no POSIX-only shell tricks in npm scripts or spawns (use Node, as
  `scripts/postinstall.mjs` does); pass `windowsHide: true` to child processes; remember Windows has no
  SIGTERM to catch (the desktop app sends a `shutdown` IPC message instead). Remote/SSH and node-pty
  logins are the macOS-tested paths; check Windows behaviour when touching them.
- **Performance:** the app must cost nothing while idle and next to nothing in the background. No
  looping animation unless a task is running, and those stop while the window isn't the active one
  (`lib/window-active.ts`, `.window-inactive` in `index.css`); live output is applied 10×/s in the active
  window and 1×/s otherwise; raw CLI lines are only sent to an open "Raw output" view (`task-raw` topic);
  long lists draw lazily (diff files, activity log, live rows). When the desktop app feels slow, check the
  build before the code: `file "/Applications/My AI Slaves.app/Contents/MacOS/My AI Slaves"` must say
  `arm64` on an Apple Silicon Mac (an `x86_64` build runs through Rosetta, 20 to 100 times slower). Then
  measure in the real Electron app (a copy on scratch data with `SLAVES_DATA_DIR`, `SLAVES_PORT`,
  `--user-data-dir` and `--remote-debugging-port`) instead of guessing.
- Verify CLI flags against the official docs before using them; don't guess.

## Commits

- Work on `main` directly. Never create worktrees or feature branches. `git pull` main before starting.
- **Commit every finished request right away and push it to `main`**, one commit per request.
  Pushing code to main triggers a desktop release (see `.github/workflows/release.yml`), and CI then
  pushes its own `chore: bump version` commit, so pull before the next commit.
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
