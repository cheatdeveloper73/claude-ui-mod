# Security

Read this before installing. This project modifies an application you did not
write, on your own machine, and it is honest about what that costs.

## What it does to your machine

- Rewrites `resources\app.asar` inside `%LOCALAPPDATA%\AnthropicClaude\app-<version>\`,
  appending two loader scripts to the app's main-process entry and to the
  preload used by the claude.ai view.
- Overwrites the 64-character asar header hash embedded in `claude.exe`, because
  Electron validates it and the app will not boot otherwise.
- Keeps pristine copies as `app.asar.cuimod-backup` and `claude.exe.cuimod-backup`.
  `node patch.js revert` restores both. Reinstalling or updating Claude Desktop
  also produces a clean install.
- `install.ps1` registers a logon scheduled task (`ClaudeUiMod-Watcher`) that
  re-applies the patch after app updates.

Modifying the signed binary invalidates its signature for that file. If your
environment enforces application integrity, do not install this.

## What the injected code can do

The main-process host runs with the full privileges of the Claude Desktop
process. It deliberately exposes a developer surface over its private IPC
channel:

- `fs.read` / `fs.list` — read any file the user can read
- `dev.eval` — evaluate arbitrary code in the main process
- `dev.webContents` — enumerate views and their URLs
- plugin `main.js` handlers can call `event.sender.executeJavaScript` and so run
  code in claude.ai's own page world

That is a local developer tool for a local user, and it is the reason the mod
never `contextBridge`s anything: claude.ai's page JavaScript cannot reach the
RPC channel, so a compromised or hostile web page cannot call `dev.eval`. The
surface is reachable only from the mod's own isolated world — that is, from code
in this repository, plus anything you put in `src/plugins/`.

The practical consequence: **a plugin you install is code running as the desktop
app**. Treat third-party plugins exactly like any other program you run, and
read them before dropping them into `src/plugins/`.

## What it does not do

- No network access. Nothing is uploaded, phoned home, or fetched at runtime.
- No dependencies. The runtime uses only Node built-ins and Electron.
- No contact with the Claude Code CLI child processes or their stdio pipes.
- No credentials are read, stored, or transmitted. The files it reads are the
  local task store (`~/.claude/tasks/`), the desktop's own session index, and
  the app's usage-history json.

## Data it touches

| path | why |
|---|---|
| `~/.claude/tasks/<cliSessionId>/*.json` | the task list the rail renders |
| `%APPDATA%\Claude\claude-code-sessions\` | maps the URL's desktop session id to the task-store key |
| `%APPDATA%\Claude\plan-usage-history.json` | rate-limit percentages for the usage meters |
| `.state/` in this repo | your plugin settings |

All of it stays on disk, on your machine.

## Reporting a vulnerability

Open an issue for anything that is not itself exploitable.

For anything that is, tick **Confidential** on the new-issue form before you
submit it — the checkbox sits just under the description box. A confidential
issue is readable only by you and the project members, so a working exploit
against a tool that patches a signed binary does not go public before there is
a fix for it.

Report to Anthropic instead, not here, if you find a flaw in Claude Desktop
itself. This project is unofficial and unaffiliated; nothing in it should be
taken as a statement about the security of the app it patches.
