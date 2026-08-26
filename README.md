# claude-ui-mod

Custom UI injected into the **Claude Desktop** app on Windows, with a plugin
runtime you can edit while the app is running. Save a file and the change is
live: no restart, no page reload, no interruption to a Claude Code session
that is mid-turn.

> Unofficial and unaffiliated with Anthropic. It rewrites files inside your
> local Claude Desktop install. Read [SECURITY.md](SECURITY.md) before using it.

```
Insert                     open the dashboard (live controls for every plugin)
node patch.js apply        inject into the newest installed app-<version>
node patch.js revert       put the original app.asar and claude.exe back
node selfcheck.js          compile + wiring + leak check, touches nothing
```

## What ships

| plugin | what it does |
|---|---|
| `dashboard` | The settings overlay on **Insert**: sidebar of plugins, grouped controls, live 1:1 before/after preview frames. Persists to `.state/settings.json`. |
| `task-rail` | A rail pinned left of the prompt composer showing the live task list of the Code session that window is displaying. |
| `usage-bar` | Context and rate-limit meters in the empty middle of the composer footer. Hides the app's own usage band once it has read the reset time off it. |
| `thinking-default` | Sets the transcript view to Thinking the first time a session appears in a window. One shot per session, so switching back by hand sticks. |
| `thinking-style` | Typography and framing for thinking blocks. |
| `transcript-type` | Typeface and size for normal transcript text, by feeding the app's own `--chat-body` / `--chat-leading` tokens. |

Adding your own needs no re-patch — drop a directory into `src/plugins/` and it
loads live. See [docs/plugin-api.md](docs/plugin-api.md).

## Requirements

- Windows
- Claude Desktop installed under `%LOCALAPPDATA%\AnthropicClaude`
- Node.js 18 or newer on `PATH`

Verified against app **1.26832.0** (Electron 42, Chromium 148). The patcher
reads what it needs out of the shipped bundle rather than hardcoding it, so
minor updates are expected to keep working; the version-specific facts it
relies on are listed in [docs/internals.md](docs/internals.md).

## Install

Claude Desktop must be fully quit — Windows keeps `app.asar` memory-mapped
while it runs, and the running version cannot be replaced.

```bash
git clone https://github.com/cheatdeveloper73/claude-ui-mod
cd claude-ui-mod
node patch.js apply
```

Start Claude and press **Insert**.

To survive app updates, register the watcher as a logon scheduled task:

```bash
powershell -ExecutionPolicy Bypass -File install.ps1
```

Squirrel lays each update into a fresh `app-<version>` directory and switches to
it on the next launch. A freshly downloaded version is not the running one, so
the watcher patches it immediately and the mod is present the first time that
version starts. The watcher also probes for the app going down, so a
quit-and-reopen is enough to patch a same-version install with no command run.

## Remove

```bash
node patch.js revert
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

`revert` restores both `app.asar` and `claude.exe` from the backups the patcher
made on first apply. Reinstalling or updating Claude also restores a clean
install.

## How it attaches

Claude Desktop's main window is a shell page — title bar and error UI only. The
real UI is claude.ai loaded into a `WebContentsView` whose preload is
`.vite/build/mainView.js` inside `resources/app.asar`. That preload is used for
every window the app makes (main, popped-out sessions, quick window), so
appending to that one file gives per-window injection for free.

The view runs `sandbox: true, contextIsolation: true`, so the preload can only
`require('electron')`. Local state therefore arrives over IPC from a second hook
appended to the main-process entry, `.vite/build/index.pre.js`.

Nothing is `contextBridge`d. claude.ai's own page JavaScript cannot see the
mod's RPC surface.

The archive is not repacked. New bytes are appended past the end of the data
region and only the changed header entries are re-pointed, so all 6
`app.asar.unpacked` entries and every other per-file integrity record stay
byte-identical. Electron validates the asar header hash against a value baked
into `claude.exe`, so the patcher repoints that field too — skipping it is what
produces a boot-time `FATAL: Integrity check failed` with no log and no crash
dump.

## Two baked files, everything else hot

| file | reload |
|---|---|
| `src/main-hook.js` | **baked** — needs re-patch + app restart |
| `src/preload-hook.js` | **baked** — needs re-patch + app restart |
| `src/runtime/host.js` | hot, on save (main process) |
| `src/runtime/bridge.js` | hot, on save (renderer) |
| `src/plugins/*/main.js` | hot, on save (main process) |
| `src/plugins/*/renderer.js` | hot, on save (renderer) |

The two baked files are deliberately dumb loaders with no feature logic. If you
are editing them to add a feature, it belongs in `host.js` or a plugin.

Why reloading is safe while a long agent run is in flight:

- **Last-good-wins.** New code is compiled before the old is disposed. A syntax
  error logs and the running version keeps going.
- **The watcher lives in the baked loader**, not in the host, so even a host
  that fails to load is recoverable by saving the file again.
- **No IPC re-registration.** The loader owns `ipcMain.handle` permanently and
  dispatches into whichever host is current, so a reload can never hit
  Electron's "second handler for X" throw.
- **Disposal is enforced.** Plugins take resources through `ctx` helpers that
  record a disposer; `selfcheck.js` asserts zero interval and watcher leaks
  across a dispose cycle.
- **The page never reloads.** A renderer reload swaps isolated-world code only;
  claude.ai's React tree and your sessions are untouched.
- Nothing goes near the Claude Code CLI child processes or their stdio pipes.

Kill switch: create a file named `DISABLED` in the repo root and save anything
under `src/`. The host unloads. Delete it and save again to restore.

## Task data

Claude Code persists its task list to
`~/.claude/tasks/<cliSessionId>/<taskId>.json`, one file per task, in the exact
`TaskCreate`/`TaskUpdate` schema. The host reads that directory and watches its
root, so the rail updates as the agent creates and completes tasks.

Which session is on screen comes from the URL, which carries the **desktop**
session id (`local_<uuid>`) — a different id from the task-store key. The
mapping lives in the desktop's own session json under
`%APPDATA%\Claude\claude-code-sessions\`. A view with no id in its path is the
new-session view and genuinely has no session; it resolves to null rather than
to whatever was focused a moment ago.

## Docs

- [docs/development.md](docs/development.md) — the hot-reload dev flow
- [docs/plugin-api.md](docs/plugin-api.md) — plugin contracts, host RPC surface, introspection recipes
- [docs/internals.md](docs/internals.md) — verified Claude Desktop internals, and the dead ends not worth re-walking
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Live injection into a running app: why it is not supported

`live-inject.js` was built to install the UI into an already-running app over
CDP: `process._debugProcess(pid)` to arm the Node inspector, attach, evaluate
`src/live-driver.js` in the main process, detach.

It works against any plain Node process (`node live-inject.js selftest` passes
end to end) and **not** against Claude's Electron main process. On Windows,
`_debugProcess` signals a named event, `node-debug-handler-<pid>`, that the
target creates only when it starts the debug-signal handler thread. A packaged
Electron main never starts that thread, so the event does not exist and the call
fails with ENOENT. Post-hoc attach needs the app to have been launched with
`--inspect`.

Native thread injection would work and is declined on purpose: the main process
owns the stdio pipes of every running Claude Code CLI agent, so a crash there
destroys exactly the long-running work this was built to preserve. For the same
reason, quitting the app interrupts any in-flight agent turn — quit at a quiet
moment. Task files and transcripts persist; a mid-run turn does not.

Both files are kept because they are correct for an instance started with
`--inspect`. Against a normal packaged app they fail loudly with that
explanation.

## License

MIT — see [LICENSE](LICENSE).
