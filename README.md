# My AI Slaves

A desktop app (macOS and Windows) that queues AI coding tasks and runs them through the
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI and the Cursor Agent CLI, falling back
across several logged-in subscriptions when one hits a usage limit. Tasks run directly in your repo as
it's checked out; you review what changed, then mark the task finished or discard it.

## Install

Download the latest installer from the
[Releases page](https://github.com/devlargs/my-ai-slaves/releases/latest):

| System                    | File                      |
| ------------------------- | ------------------------- |
| macOS, Apple Silicon (M1+) | `My-AI-Slaves-arm64.dmg`  |
| macOS, Intel              | `My-AI-Slaves-x64.dmg`    |
| Windows (x64)             | `My-AI-Slaves-Setup.exe`  |

On a Mac with an Apple chip (Apple menu → About This Mac shows "Chip: Apple M…"), take the **arm64** file.
The Intel one also opens there, but macOS runs it through Rosetta and the whole app becomes many times
slower. If that happens the app says so and offers to switch to the Apple Silicon build in one click.

Requires macOS 13 or later. You also need the CLIs you want to use installed on your machine
(`claude` and/or Cursor's `agent`); you log in to your accounts from inside the app.

### macOS: "My AI Slaves" Not Opened

The app isn't signed with an Apple Developer ID or notarized, so on first launch macOS says
*Apple could not verify "My AI Slaves" is free of malware*. Click **Done** (not Move to Trash), then:

1. Open the DMG and drag **My AI Slaves** into **Applications**.
2. In Terminal, remove the download quarantine flag:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/My AI Slaves.app"
   ```

3. Open the app normally.

Alternatively: **System Settings → Privacy & Security**, scroll to *"My AI Slaves" was blocked…*,
click **Open Anyway** and confirm. (On macOS 15 Sequoia and later, right-click → Open no longer
bypasses this.)

You only need to do this once per install. Updates installed from inside the app don't trigger it again.

### Windows: "Windows protected your PC"

The installer isn't code-signed, so SmartScreen may block it. Click **More info → Run anyway**.

## Updates

The app checks GitHub Releases and can update itself (each download is sha256-verified). Use
**Check for updates** in the sidebar. Releases are read without a GitHub token; only when GitHub
rate-limits the request does the app retry with your `GH_TOKEN` / `GITHUB_TOKEN` or GitHub CLI login.

## Security model

My AI Slaves runs coding agents on your machine with your permissions. Know what that means:

- **Agents work in your real checkout.** Tasks run directly in the repo as it's checked out (no copy,
  no sandbox, no worktree), with the permission mode set on the Settings page (Claude Code defaults to
  `auto`, Cursor to `auto-review`; `bypassPermissions` / `force` let them run any command without
  asking). An agent can edit or delete files, run commands, and commit or push wherever your
  credentials allow, as your repo prompts tell it to. Review what changed before marking a task finished.
- **The local API has no login.** The server listens on `127.0.0.1:3005` only and refuses requests
  from other websites (Host, Origin and Sec-Fetch-Site checks), but any program running on your
  computer can call it, and through it queue tasks or run a repo's scripts. Don't run it on a
  machine you share with people or software you don't trust.
- **Remote repos** run git and the CLIs on the server over `ssh`, using your `~/.ssh/config` and that
  server's own CLI logins.
- **Your data stays local.** Settings, queue, prompts and the CLI logins live in the data folder you
  picked (`.data/`). It can contain your API tokens: don't share or commit it.

## Development

Node 22 (see `.nvmrc`).

```bash
npm install
npm run dev            # server + web UI at http://localhost:3005
npm test
npm run desktop        # build and open the Electron app
npm run desktop:dist   # package an installer into packages/desktop/release
```

The marketing site lives in [`packages/landing`](packages/landing) (`npm run landing`). Its screenshots and
infographics are generated from demo data, never from your own: `npm run landing:shots` and `npm run landing:cards`
(they need Google Chrome).

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules the app follows.
[docs/history/DESIGN.md](docs/history/DESIGN.md) is the original design proposal, kept as history.

## License

[MIT](LICENSE)
