# Security

Read this before installing. This project modifies an application you did not
write, on your own machine, and it is honest about what that costs.

## What it does to your machine

- Rewrites `resources\app.asar` inside `%LOCALAPPDATA%\AnthropicClaude\app-<version>\`,
  appending two loader scripts to the app's main-process entry and to the
  preload used by the claude.ai view.
- Where a build still carries Desktop's blanket `SendMessage` bans, rewrites
  those two sites in the app's own main-process chunks so agents can message
  each other. Each edit asserts it matched exactly once, and a build with no
  match is accepted only if its asar header hash was audited by hand.
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

### Plugins that reach past the page

Most plugins only draw UI. These do more:

- **`file-pane-access`** wraps the app's file-read handler. When the shell
  answers "not found" for a path the page asks for, it returns the file itself
  if it exists on your disk: any file you can read, up to 10 MB, read-only, with
  UNC and device paths refused. It also scans the session transcript to resolve
  bare file-name links.
- **`unlock-code`** lets a free-tier account use the Claude Code tab, and it
  does so on the client. It has three parts:
  - *Account record.* The main process injects `page.js` into every claude.ai
    page and re-injects it every three seconds. The script finds the page's
    React Query client and rewrites the cached `current_account` record in
    memory: for every organization membership it adds the `chat`, `claude_pro`,
    `claude_max`, `raven`, `claude_code` and `claude_code_desktop` capabilities
    and sets `rate_limit_tier` to `default_claude_max_20x`, and in the model
    selector config it clears the disabled flag, the `upgrade_required` reason
    and the upgrade call to action from model rows. It sends nothing to
    Anthropic and changes nothing on the server. Requests to Anthropic still
    carry your real credential, and the server decides what the account may use,
    so Claude models stay bound by the real plan and limits. What changes is
    what the page believes about the account: the Code tab, model rows and any
    limit copy derived from the account record reflect the rewritten values
    until the page next refetches or reloads it.
  - *Page cosmetics.* The renderer half can hide the discovery takeover and the
    upsell and limit banners with a stylesheet. Both switches are in the
    dashboard.
  - *Routed credential.* On sessions that run on routed (non-Claude) models it
    substitutes the fixed string `cuimod-local-router` for Anthropic's OAuth
    token, and only for the Code OAuth scope. Those requests go to the local
    router, never to Anthropic. Sessions on Claude models keep the app's own
    credential.

  The dashboard's Enabled switch (`"unlock-code": { "enabled": false }` in
  `.state/settings.json`) stops all three: the routed credential, the
  stylesheet, and the page script, which is retired and no longer injected.
  Reload the window afterwards so the page refetches its account record. An
  empty `src/plugins/unlock-code/DISABLED.json` removes the plugin entirely.
- **`sendmessage-unban`**, **`model-probe-skip`** and **`fast-mode`** wrap
  methods on running Claude Code session objects in the main process
  (`SendMessage` deny hooks, `setModel`, `setFastMode`). Their state files hold
  per-session switches and model ids, not conversation content.
- **`campaigns`** registers an in-process tool server and `PreToolUse` hooks on
  the sessions you bind to a campaign. Those hooks can deny a tool call. Its
  state lives in `.state/campaigns/`, including the briefs, evidence paths and
  check output you give it.
- **`computer-use`** writes your Desktop `claude_desktop_config.json` and the
  app's preference store to toggle the native Windows Computer Use backend. It
  writes nothing until you flip its dashboard switch, so a fresh install leaves
  Desktop's own setting exactly as it was.
- **`campaigns`** evidence links open only inert file types (text, logs, JSON,
  images, PDF, media). Anything else a worker wrote is revealed in Explorer
  instead of being opened, so a prompt-injected worker cannot get a script run
  by your click.
- **`queue`** persists queued messages, including pasted images, in plaintext in
  `.state/queue.json` while they are queued.

## The router is a proxy, and you should read this part

Most UI plugins make no network requests. The voice plugin talks only to its
token-protected workstation companion on loopback. The router in `router/` is
different, and calling it out plainly matters more than the rest of this document.

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
  `CODEX_AUTH_FILE`. No metered API key, no key of ours. The router also reads
  your plan's usage endpoint on `chatgpt.com` for the quota meters, and
  refreshes the token at `auth.openai.com` when it is about to expire.
- **Meta traffic** (Muse Spark) goes to Meta's Anthropic-Messages endpoint with
  the key you put in `.state/provider-secrets.json`. The catalogue's
  "Contributor" row is Meta's contributor tier; its catalogue note says Meta may
  train on prompts and completions. The plain row carries no such note.
- **Command Code traffic** (DeepSeek, GLM, Kimi, Qwen and MiniMax model ids) is
  translated to OpenAI Chat Completions and sent to `api.commandcode.ai` with
  the key from `.state/provider-secrets.json` (field `command-code`) or the
  `COMMAND_CODE_API_KEY` environment variable. Every request carries
  `x-cmd-zdr: 1`, which asks for zero data retention; whether Command Code
  honours it is theirs to say, and their terms govern the prompts. The quota
  meter calls that service's read-only billing endpoints
  (`/alpha/whoami`, `/alpha/billing/credits`, `/alpha/billing/subscriptions`)
  with the same key and keeps only sanitized quota fields.
- **Loopback endpoints are unauthenticated.** `/healthz`, `/usage/api`,
  `/limitsz`, `/throughputz`, `/contextz` and the Usage Atlas answer any local
  process. They carry no credential values and no message content. `POST
  /resetz` is the exception worth knowing: it asks the Codex CLI to redeem a
  plan reset credit, so any local process could spend one. The router never
  does it on its own, and without `force=1` it refuses unless a usage window is
  actually exhausted.
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

## The optional voice agent is a local recorder

Installing `voice-agent/` adds a second trusted program with access to the
interactive user's microphone, speakers, Claude transcript files and SSH client.
The workstation API and compute API bind to loopback and require independent
bearer tokens. The compute listener is reached through an SSH local-forward; it
is not exposed as a new LAN service.

**While the recorder runs, it records everything the microphone hears.** It is a
separate process that writes every captured block, silence included, to
`.state/voice-agent/raw/` before any other component sees it. The companion
starts it on demand and it exits after 15 minutes without a consumer, so
capture is not tied to a wake phrase or to the microphone button. Finished
chunks are then moved to the compute host and stored there as bit-verified FLAC
under `~/.local/share/cuimod-voice/archive/`. The workstation copy is deleted
only after the archive confirms the same checksum and sample count. **Nothing in
this repository prunes that archive**, and the retention setting does not apply
to it; delete it yourself. Transcribed utterances, with their transcript
sidecars (raw ASR text and acoustic emotion scores), and rotated companion event
history move to the same archive.

On the workstation, retention deletes completed utterance WAV files older than
the configured number of days; zero disables automatic deletion. The optional
continuous-journal mode additionally writes rolling WAV files of the whole
stream under `.state/voice-agent/audio/`. Treat the raw spool, the archive and
the transcript sidecars as sensitive audio and transcript data.

The correction and summary endpoint configured in `compute.json` receives
transcript text. The shipped configuration points to a loopback model service.
Changing it to a remote URL changes the privacy boundary. Ordinary voice prompts
submitted into Claude still go to the provider selected for that Claude chat.
Wake phrases and voice characteristics reduce accidental activation; they are not
authentication. Claude's existing tool permissions remain the authority after a
voice prompt is submitted.

## Credentials

- The router reads the Codex OAuth token to make OpenAI requests on your behalf.
  It is read from disk per request and never copied into this repository. It is
  not read-only: when the access token is near expiry the router refreshes it
  and writes the rotated tokens back to `auth.json` atomically, because the old
  refresh token is spent and the Codex CLI would otherwise be signed out.
- **Added ChatGPT accounts are stored in plaintext.** The account picker keeps a
  full copy of each account's `auth.json` under `.state/openai-accounts/`
  (ignored by git), and switching, removing or auto-switching accounts replaces
  the canonical `~/.codex/auth.json` with one of those copies. Treat that
  directory exactly like `auth.json` itself. The sign-in runs `codex login`
  against a temporary home and copies the result only if it succeeds.
- Compatible-provider keys, and the Command Code key, live in
  `.state/provider-secrets.json`, which is gitignored. Nothing else is a valid
  place for them. The Command Code adapter also accepts the key from the
  `COMMAND_CODE_API_KEY` environment variable.
- No credential value appears in `/healthz`, `/limitsz`, `/usage/api`, the
  router log, or any renderer RPC. Those surfaces report whether a credential
  reads, not what it is, and the test suite asserts it.

## A provider adapter is code in the router process

`router/adapters/` is an extension point: a directory dropped in there is loaded
into the router and can see every request routed to the models it claims, plus
whatever credentials it reads. That is the same trust level as a plugin, for the
same reason. Read one before you install it. The one that ships,
`router/adapters/command-code/`, reads the Command Code key and relays prompts
to that service as described above.

## Data it touches

| path | why |
|---|---|
| `~/.claude/tasks/<cliSessionId>/*.json` | the task list the rail renders |
| `~/.claude/projects/<slug>/<cliSessionId>.jsonl` | **your full CLI conversation transcripts.** `goal` scans them for goal records; `subagents` and `throughput` read them to attribute work to a named agent. Read only, incrementally, never copied elsewhere. |
| `%APPDATA%\Claude\claude-code-sessions\` | maps the URL's desktop session id to the task-store key |
| `%APPDATA%\Claude\plan-usage-history.json` | rate-limit percentages for the usage meters |
| `~/.claude/gemini-bridge/` | router log, token ledger, usage accounting, and the prompt capture described above |
| Codex `auth.json` | the OAuth token for the OpenAI arm. Read per request; rewritten on token refresh and on account switch |
| `.state/openai-accounts/` | one stored copy of each added ChatGPT account's `auth.json` |
| `%APPDATA%\Claude\claude_desktop_config.json` | rewritten by `computer-use` to set the native Computer Use preferences |
| `.state/queue.json`, `.state/campaigns/`, `.state/fast-mode.json` | queued messages and images, campaign records, per-session fast switches |
| `~/.codex/models_cache.json` | the Codex client's model list, read to know which models offer the priority tier |
| `.state/` in this repo | plugin settings, captured plan limits, provider keys if you add any, and optional voice tokens/audio/transcript evidence |

`plan-usage-capture` additionally wraps Electron's `net.fetch` in the main
process to read Desktop's own organization usage response as it arrives, and
persists the rate-limit numbers from it to `.state/claude-plan-resets.json`.
That is an interception of the app's own network call, on your machine, and it
is how the Claude quota meter gets its data.

All of it stays on disk, on your machine.

## What it still does not do

- The core mod has no dependencies beyond a pinned pure-JS tokenizer
  (`js-tiktoken`). The optional voice services have separately pinned Python
  requirements listed under `voice-agent/`.
- No contact with the Claude Code CLI child processes or their stdio pipes. UI
  reloads never replace a running agent; routing only decorates the environment
  at spawn.
- No telemetry or update check. Outbound connections are provider requests
  (Anthropic, OpenAI's inference, usage and token endpoints, Command Code's
  inference and billing endpoints when you add its key, and any catalogue
  backend you added a key for) plus, when voice is installed, the configured SSH
  connection to its compute host.

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
