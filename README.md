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

## See it

![the whole window: task rail, usage meters, the dashboard, and the transcript restyled](docs/media/tour.gif)

[Full-resolution MP4](docs/media/tour.mp4). Rendered from [`demo/`](demo) — a
Remotion mock of the app that pulls the plugins' real stylesheets straight out
of `src/plugins`, so what you are looking at is the shipped CSS, not a redrawn
approximation. What is scripted and what is real is spelled out in
[demo/README.md](demo/README.md).

**task-rail** — rows fade in as the agent creates tasks, and a status flip
re-fades the row and re-tweens the box. Bottom edge stays flush with the
composer.

![the task rail through two status flips](docs/media/crop-task-rail.gif)

**usage-bar** — context from the CLI's own reply, the plan percentage off disk,
the compaction mark drawn where the CLI says it fires.

![context and rate-limit meters in the composer footer](docs/media/crop-usage-bar.gif)

**dashboard** — Insert. The composer footer stays in shot: the setting lands in
the running app as the switch is flipped, and the frames beside the panel are a
1:1 before/after of the same control.

![the settings overlay, with before and after preview frames](docs/media/crop-dashboard.gif)

**thinking-style / transcript-type** — the app's own muted italic first, then the
same block restyled, both driven through claude.ai's own font tokens rather than
by forcing a font on the subtree.

![thinking blocks and transcript typography being restyled](docs/media/crop-transcript.gif)

## What ships

| plugin | what it does |
|---|---|
| `dashboard` | The settings overlay on **Insert**: sidebar of plugins, grouped controls, live 1:1 before/after preview frames. Persists to `.state/settings.json`. |
| `provider-picker` | Provider tabs inside the native model picker. Extends the local model catalog so native draft selection and the native effort slider work per conversation. OpenAI runs on the Codex OAuth you already hold — no metered API key. Other providers come from the catalogue or from a [provider adapter](docs/provider-adapters.md). |
| `compaction-provider` | Replaces Claude Code’s text-only GPT compaction turn with Codex V2’s native encrypted checkpoint. The router restores the opaque item on later GPT turns and keeps a portable text fallback for switching to Claude or Gemini. |
| `context-management` | Codex's experimental context management, run from the router on the ChatGPT plan you already hold. GPT sessions get the model-only `notes` scratchpad, the budget guidance and reminders, and an optional `new_context` window reset. Upstream's instructions telling the model to conceal the tools are stripped. |
| `task-rail` | A rail pinned left of the prompt composer showing the live task list of the Code session that window is displaying. |
| `usage-bar` | Context and rate-limit meters in the empty middle of the composer footer. Hides the app's own usage band once it has read the reset time off it. |
| `context-pill` | A pill that appears only once the session is carrying 300k tokens or more, warming and pulsing past a second threshold. Same CLI reply `usage-bar` reads, so the two cannot disagree. Dismiss snoozes it until context grows another 50k. |
| `queue` | An explicit send queue. Mid-turn, Enter is intercepted before the app sees it and the message lands in a rail above the prompt with steer / edit / delete per row, plus auto-send when the turn fully ends. |
| `subagents` | A HUD of this session's agents in the gutter under the chat title: who is running, what tool they are on, how long. Finished ones sit below as ghosts. Click one for its full transcript and controls, read from the CLI's own per-agent files so it survives a stop-and-resume. Ships a demo-data mode. |
| `throughput` | Real tokens per second, measured at the router: exact provider token counts over this machine's own clocks, split into the upstream hop, the prefill, and the generation window. Live in-flight streams plus per-agent history, joined to the CLI transcript so each rate is attributed to the main session or to the named subagent that produced it. Persists to `provider-throughput-v1.jsonl`. |
| `goal` | An always-on band for the CLI's `/goal` stop-hook: the armed condition, how many times it has checked in, and the evaluator's verdicts. Read from the session transcript rather than the app's stream state, which loses them. Set, edit or clear a goal mid-turn from the band. |
| `provider-routing` | Starts the router when a Claude Code session is spawned and points that session at it. No UI. This is the plugin that makes provider switching work at all; disable it and every session goes straight to Anthropic. |
| `plan-usage-capture` | Reads Claude's own plan-usage response as the app fetches it, and persists the rate-limit numbers to `.state/claude-plan-resets.json`. That file is where the Claude quota meter and its reset countdown come from. |
| `hide-usage-band` | Hides or dims Claude's own usage-limit banners in the composer, by keyword. Ships **off**; enable and configure it in the dashboard. Overlaps `usage-bar`'s own `hideBanner` toggle — use one or the other. |
| `thinking-default` | Sets the transcript view to Thinking the first time a session appears in a window. One shot per session, so switching back by hand sticks. |
| `thinking-style` | Typography and framing for thinking blocks. |
| `transcript-type` | Typeface and size for normal transcript text, by feeding the app's own `--chat-body` / `--chat-leading` tokens. |

**Insert → Providers & agents** controls GPT reasoning summaries, optional
provider-supplied reasoning text, tab animation, and upstream identity logging.
The visible GPT thinking is an OpenAI summary by default. The dashboard cannot
unlock hidden raw reasoning. Request settings apply to the next model call and
also cover GPT subagents; they do not change reasoning effort.

**Insert → Context compaction** selects native Codex V2 or Claude Code's normal
text-summary path for GPT sessions. Codex checkpoints are durable under the
router state directory and bound to the CLI session id. Claude, Gemini and other
providers continue using their normal Claude Code compaction path. The portable
fallback is enabled by default so switching away from GPT after a checkpoint is
safe.

**Insert → Context management** turns on Codex's experimental context lane for
GPT sessions. Notes are additive: the model gets a server-side scratchpad that
survives a window reset, and nothing else about the turn changes. Window reset
lets it call `new_context`, after which this router sends later turns from the
cut point instead of the whole transcript, so continuity lives in its notes.
The transcript archive is off by default: turning it on asks OpenAI to ingest and
index the whole thread, not just what the model chose to write. Tool results are encrypted by
the backend and readable only inside inference, so note contents never reach this
machine. The tool descriptions are reserved and validated upstream, so they ship
verbatim; the guidance this router injects is not, and it tells the model you may
be told about its notes — so asking works. `GET /contextz` reports window state and a drift verdict that
fires when Codex changes the feature upstream.

Plugin settings live in `.state/settings.json` and that one file is **tracked**,
so the configuration is recoverable and `git log -p .state/settings.json` is its
history. Everything else under `.state/` stays ignored, credentials included, and
the publish step excludes the settings file from the public mirrors. After
restoring an older copy, run `dashboard.reload` and reload the renderer — the
store is authoritative in memory once read.

Adding your own needs no re-patch — drop a directory into `src/plugins/` and it
loads live. See [docs/plugin-api.md](docs/plugin-api.md).

## Usage Atlas

The router keeps a permanent, deduplicated record of every response it relays —
exact provider token counts, the model that served it, and what it would have
cost at that day's list price. It serves that back as a dashboard:

```
http://127.0.0.1:8789/usage/
```

Same page from inside the app: click the usage ring in the composer, then
**Open Usage Atlas ↗**.

What is on it, and where each number comes from:

| panel | source |
|---|---|
| Quota meters, with a burn-rate forecast and time-to-exhaustion | Claude plan percentages captured by `plan-usage-capture`; ChatGPT windows from your Codex login; any adapter's own account quotas |
| Tokens by model, and a daily timeline | the router's own accounting store |
| Spend | those token counts priced from `router/pricing.mjs`, recomputed on every read |
| Audit trail | the last 100 responses, with no message content |

Two things worth knowing before you read the numbers. **Cost is never stored** —
it is derived from tokens on every request, so correcting a price in
`pricing.mjs` retroactively fixes every historical day with no migration. And a
model with no rate is reported as *unpriced* rather than as zero, so a gap in
the price table reads as a gap rather than as free traffic.

Meters only appear for providers you actually have. A fresh install with no
Codex login and no adapter shows the Claude meter alone; the token, timeline and
spend panels populate from the first response either way.

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
git clone https://gitlab.com/blockshooter/claude-ui-mod
cd claude-ui-mod
npm ci
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

The provider router is in `router/`. It listens on `127.0.0.1:8789`; the routing
plugin starts it when needed and supplies that endpoint when Desktop spawns a
Code CLI. `router/supervisor.mjs` owns the public port and swaps workers
blue-green: a saved change boots a candidate on a private port, accepts it only
after `/healthz` and a semantic canary pass, then switches new requests while
the previous generation drains. Sessions stay up across a router edit.

Every request is routed on `body.model`. Anything unclaimed goes to
api.anthropic.com byte-identical. `gpt-*` is translated to the OpenAI Responses
API and sent on the Codex subscription OAuth. Anything else is a **catalogue
entry** if the backend already speaks Anthropic Messages, or a **provider
adapter** under `router/adapters/` if it needs real code — see
[docs/provider-adapters.md](docs/provider-adapters.md). No adapter ships by
default and none is required.

GPT preflight counts use a pinned local `o200k_base` tokenizer over the
translated request, including image-size estimates instead of base64 text. A
provider adapter may supply a native counter instead. After a response, both
context displays use the CLI's provider-reported input total, including cached
input; the tooltip distinguishes this latest measured prompt from a preflight
estimate. Category breakdowns remain estimates.

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
- UI reloads never replace Claude Code CLI processes or their stdio pipes.
  Provider routing only decorates the environment when a CLI is spawned.

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
- [docs/provider-adapters.md](docs/provider-adapters.md) — adding a provider, by catalogue entry or by adapter
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
