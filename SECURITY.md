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

## The router is a proxy, and you should read this part

The UI half of this project makes no network requests at all. The router in
`router/` is different, and calling it out plainly matters more than the rest of
this document.

When the routing plugin is enabled, Claude Desktop spawns each Claude Code CLI
with `ANTHROPIC_BASE_URL` pointing at `127.0.0.1:8789`. **Every request your
sessions make then passes through a process on your machine that this repository
controls.** It listens on loopback only and is never exposed off the host, but
within the host it sees your prompts, your files-as-context, and your responses.

What it does with them:

- **Anthropic traffic is forwarded byte-identical** to `api.anthropic.com`
  unless you have activated a prompt policy, in which case it rewrites the JSON
  body exactly as the dashboard shows.
- **`gpt-*` traffic is translated** to the OpenAI Responses API and sent to
  `chatgpt.com` on the OAuth token the Codex CLI already holds, read from
  `CODEX_AUTH_FILE`. No metered API key, no key of ours.
- **Token counts, model names and timings are written to disk** under
  `~/.claude/gemini-bridge/` (a legacy directory name; `MODEL_ROUTER_STATE_DIR`
  overrides it) so the usage dashboard has a history. Response text is never
  written there.
- **Your system prompt and tool descriptions are.** Every request that carries
  tools — which is every agent turn — writes its system prompt and tool
  descriptions to `prompt-policy-capture-v2.json` in that same directory, before
  and after any active policy. This is **not** opt-in and there is no flag that
  disables it. It exists so a replacement policy cannot destroy the only
  editable copy of what your client actually sent. The file keeps the most
  recent 24 entries, one per provider and session. Control-plane requests are
  the only thing excluded. If your system prompt contains anything you would not
  want sitting in a plaintext file on your disk, delete that file, or point
  `MODEL_ROUTER_STATE_DIR` somewhere you control.
- **User and assistant message bodies are not captured** by that file — only the
  system prompt and the tool schemas.
- `GEMINI_BRIDGE_DUMP=1` additionally writes complete outgoing request bodies to
  `reqdump/` in the state directory. That one **is** off by default. Turn it on
  only when debugging, and remember what is in the files afterwards.

Nothing is uploaded anywhere you did not already send it, and there is no
telemetry, analytics, or update check of any kind.

## Credentials

- The router reads the Codex OAuth token to make OpenAI requests on your behalf.
  It is read from disk per request and never copied into this repository.
- Compatible-provider keys live in `.state/provider-secrets.json`, which is
  gitignored. Nothing else is a valid place for them.
- No credential value appears in `/healthz`, `/limitsz`, `/usage/api`, the
  router log, or any renderer RPC. Those surfaces report whether a credential
  reads, not what it is, and the test suite asserts it.

## A provider adapter is code in the router process

`router/adapters/` is an extension point: a directory dropped in there is loaded
into the router and can see every request routed to the models it claims, plus
whatever credentials it reads. That is the same trust level as a plugin, for the
same reason. Read one before you install it.

## Data it touches

| path | why |
|---|---|
| `~/.claude/tasks/<cliSessionId>/*.json` | the task list the rail renders |
| `~/.claude/projects/<slug>/<cliSessionId>.jsonl` | **your full CLI conversation transcripts.** `goal` scans them for goal records; `subagents` and `throughput` read them to attribute work to a named agent. Read only, incrementally, never copied elsewhere. |
| `%APPDATA%\Claude\claude-code-sessions\` | maps the URL's desktop session id to the task-store key |
| `%APPDATA%\Claude\plan-usage-history.json` | rate-limit percentages for the usage meters |
| `~/.claude/gemini-bridge/` | router log, token ledger, usage accounting, and the prompt capture described above |
| Codex `auth.json` | the OAuth token for the OpenAI arm, read only |
| `.state/` in this repo | plugin settings, captured plan limits, and provider keys if you add any |

`plan-usage-capture` additionally wraps Electron's `net.fetch` in the main
process to read Desktop's own organization usage response as it arrives, and
persists the rate-limit numbers from it to `.state/claude-plan-resets.json`.
That is an interception of the app's own network call, on your machine, and it
is how the Claude quota meter gets its data.

All of it stays on disk, on your machine.

## What it still does not do

- No dependencies beyond a pinned pure-JS tokenizer (`js-tiktoken`).
- No contact with the Claude Code CLI child processes or their stdio pipes. UI
  reloads never replace a running agent; routing only decorates the environment
  at spawn.
- No telemetry, no update check, no outbound request to anything other than the
  provider a request was addressed to.

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
