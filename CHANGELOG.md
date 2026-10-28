# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] — 2026-10-28

### Performance

- **Renderer work follows real changes** — plugin views (usage, branding,
  goal, tasks, voice placement) were rescanning the document and reading
  geometry on every transcript token. A shared layout coordinator now
  batches measurements before writes and invalidates only on shell or anchor
  changes. In the Chromium regression, unrelated transcript churn drops from
  168 discovery queries and 648 rectangle reads to zero for these consumers.
  Unchanged attributes, CSS and popover contents are no longer rewritten.
- **Scroll follow without per-frame queries** — the follow loop ran at display
  cadence and forced style recalculation even when nothing grew. It now
  observes the native sizer and viewport. The unchanged-busy regression falls
  from 120 callbacks and 360 geometry reads to zero. Follow intent stays
  latched through token bursts, and wheel movement shares one frame with the
  virtualizer (`transcript-scroll`).
- **Less disk traffic** — streaming events no longer resolve campaigns or
  refresh their UI unless campaign state changed, repeated list/feed reads
  reuse stat-validated snapshots, and tracking state is flushed only when it
  changes. Journal and acknowledgment fsyncs are unchanged.
- **Send hooks no longer stack** — two plugins each re-wrapped the other's
  `sendMessage` hook on a one-second sweep; a long-running window reached
  20,000+ layers and one send blocked the main process for 15 s. Each now
  recognises the other, and a running window recovers on hot reload.
- **Warm inference connections** — OpenAI turns ride a persistent WebSocket
  with Codex-style `previous_response_id` continuation; requests over the
  server's 16 MiB message cap are uploaded in chunks instead of failing with
  close 1009. Fireworks uses multiplexed HTTP/2. Fallback happens only when
  inference provably never started.

### Added

- **GPU reset guard** (`gpu-accel-guard`) — Desktop permanently disables
  hardware acceleration after three GPU process deaths in five minutes, and
  the window then renders on WARP. The guard keeps acceleration on through
  driver resets and clears a flag that was already persisted.
- **Assistant rewind** (`assistant-rewind`) — rewind to assistant, status and
  thinking checkpoints, not only to user turns, without duplicating Desktop's
  own rewind transition.
- **Codex browser tools** (`codex-browser`) — exposes an installed Codex
  `cua_repl` against Claude Desktop's own browser pane, profile and sign-ins.
  See `docs/codex-browser.md`.
- **Native advisor for routed models** — the router runs Claude Code's
  `advisor` server tool itself when the executor is a GPT model.
- **Goal guard** — a failed, truncated or malformed `/goal` evaluator reply no
  longer silently ends the goal. It becomes an explicit "unverified" verdict.
- **Fireworks provider** — DeepSeek V4.1 Flash and GLM 5.3 through Fireworks'
  native Messages endpoint, with exact local prompt counts from the models'
  own tokenizers, effort sliders, deferred-tool listing, and a live prepaid
  balance and runout in the usage circle.
- **Models** — GPT-6.1-Terra, GPT-5.6-Terra, GPT-6-Sol and GPT-5.6-Sol on the OpenAI tab;
  Haiku 5.5 offered under its `[1m]` id so sessions get the 1M window.
- **File pane** — `SendUserFile` images from remote SSH sessions render
  inline, including files outside the session's native roots.

### Fixed

- Parallel GPT tool calls keep their own inputs (calls are emitted whole at
  `output_item.done`).
- DeepSeek control tokens in request text stay text.
- A compatible model's non-slider effort suffix is resolved instead of leaking
  into the model id.
- Anthropic billing gates no longer lock the Codex priority (fast) controls.
- Remote sessions' subagents are read from Desktop's mirror without inventing
  agents; generation clocks come from the session's execution host.
- Queue, campaigns and voice-agent find turn-end idleness on Desktop 2.9939.4.
- Model lock recognises picks in the current model menu.
- Dashboard reset credits stay scoped to the account that was clicked.
- `patch.js apply` re-bakes when the baked loader differs from `src/`, not only
  when it is unmarked. Desktop 2.31226.1 is an audited build for the
  `SendMessage` unban.
- Frontend pin: a fresh generation decides its bootstrap from the page itself,
  recovery latches no longer leave the live release up, a live Code page is
  reloaded instead of asking for a manual reload, and per-model minimum app
  versions are cleared from pinned bootstraps.
- **Frontend compatibility** — the approved Code frontend and its static asset
  graph now ship with the public mod. The pin is enabled by default and serves
  integrity-checked local bytes under the original URLs, including worker
  assets and the supporting utility stylesheet. Installs no longer depend on
  an old browser cache or retention of those CDN files. Pin failures display an
  unsupported-frontend warning. Selfcheck and the public export verify the
  archive; the public runbook separates the pinned assets from live document,
  authentication, gated-import and API contracts.

## [1.2.0] — 2026-10-01

### Added

- **Local voice agent** (`voice-agent`, `voice-agent/`) — optional dictation and
  wake control that replaces the app's cloud dictation relay. A separate
  recorder process holds the microphone and writes every block to disk before
  anything else sees it, so a companion restart or stall no longer drops audio.
  A per-user Windows companion applies VAD, wake and stop phrases, retries
  failed transcriptions durably, and reaches faster-whisper and acoustic
  emotion analysis on a compute host over an SSH loopback forward. Finished
  audio chunks and transcribed utterances are shipped to that host as
  bit-verified FLAC and removed from the workstation only after the checksum
  and sample count match. Prompts reach the Desktop composer at most once,
  including across restarts, and spoken summaries are played back with Kokoro.
  Claude's own tool permissions remain the authority after a voice prompt is
  submitted.
- **Subagents, deeper** — each agent's sheet shows what its definition pins
  (model and effort) and lays out its conversation with its direct parent
  (assignment, `SendMessage` traffic both ways, final report) in the gutter
  beside the transcript, with agent messages broken out by sentence. Nested
  agents stay attached to their orchestrators, and an agent's end is read from
  the parent's record rather than from its own last line.
- **Per-session fast switch** (`fast-mode`) — the composer's fast switch belongs
  to the session it is shown on, is restored when that session comes on screen,
  and is applied to the session's next worker launch. On the OpenAI arm it is
  followed on the next request instead of the next turn and sends the priority
  service tier for models whose Codex catalogue lists one. A subagent does not
  inherit it; a launch prompt that opens with a `#fast` line opts that agent in.
- **Campaigns** (`campaigns`) — owner-rooted campaigns with durable checkpoints.
  Native agents claim and submit packages through an in-process tool server;
  candidates are bound to the source revision they were built from; acceptance
  needs independent review and observed check receipts.
- **File pane access** (`file-pane-access`) — the native Code file pane opens
  existing files outside a session's granted roots, resolves bare file-name
  links through the session transcript, resolves relative links against the
  working directory's ancestors, and crosses into sibling worktrees.
- **`SendMessage` unban** — `patch.js` neutralises Desktop's registry and
  call-time bans on agent-to-agent messaging where a build carries them, and
  fails loudly when a build's ban sites are not found exactly once and its
  header hash was not audited by hand. The `sendmessage-unban` plugin removes
  the call-time half from workers that are already running.
- **`model-probe-skip`** — a live switch to a routed model no longer waits on
  Claude Code's 5-second validation request, which refused slower routed models.
- **`unlock-code`** — lets a free-tier account use the Claude Code tab in
  Desktop. The page script rewrites the claude.ai page's cached account record
  client-side: it adds the `chat`, `claude_pro`, `claude_max`, `raven`,
  `claude_code` and `claude_code_desktop` capabilities, sets the
  `default_claude_max_20x` rate-limit tier and clears the upgrade lock from
  model-picker rows. Its renderer half can hide the discovery takeover and the
  upsell and limit banners. Separately, sessions on routed (non-Claude) models
  start with a local-only credential that only reaches the local router,
  instead of waiting on Anthropic's Code OAuth preflight. Nothing here changes
  what Anthropic's servers grant: Claude models stay bound by the account's real
  plan. `SECURITY.md` lists exactly what it alters and how to turn it off.
- **Command Code adapter** (`router/adapters/command-code/`) — ships publicly
  and serves open-weight models in a new Command Code tab: DeepSeek V4.1 Flash,
  DeepSeek V4 Flash, DeepSeek V4 Pro, GLM 5.3 Flash, GLM 5.3, Kimi K3, Qwen 3.8
  Max and MiniMax M3. It translates Anthropic Messages to OpenAI Chat
  Completions against `api.commandcode.ai`, with the key read per request from
  `.state/provider-secrets.json` (field `command-code`) or
  `COMMAND_CODE_API_KEY`. It sends `x-cmd-zdr: 1` on every request, counts
  tokens with an estimate, registers market rates so the Usage Atlas can price
  the spend, and reports the account's 5-hour and weekly windows, remaining
  credits, plan and billing period, and per-model organisation spend limits
  from Command Code's read-only billing surface. The usage ring shows the two
  windows.
- **`computer-use`** — dashboard switches for Desktop's native Windows Computer
  Use backend, applied live through the app's preferences IPC. It writes nothing
  until the switch is flipped.
- **Transcript and appearance plugins** — `message-time` keeps relative message
  age anchored to the transcript record, `waiting-label` shows the active model
  in the native waiting status, `classic-stop` restores the outlined stop mark,
  and `branding` swaps Claude's Spark marks and the new-session artwork for
  bundled SVGs.
- **`prompt-suggestions-off`** — stops Claude Code from sending a second
  full-context request after each turn just to draft the composer's ghost text.
- **OpenAI accounts** — the providers panel adds a ChatGPT account through
  `codex login`, switches between stored accounts, removes one, and can switch
  automatically once the active account's weekly usage passes a threshold. Each
  account's weekly reset stays visible, and credential replacement and token
  refresh share one lock.
- **Auto-compact** — near-limit presets (900k and 950k) beside the existing
  windows, and a live window control that reaches a running worker without
  restarting it.
- **Pricing for Opus 5.5 and Sonnet 5.5**, and both models in auto-compact's
  native model table.

### Changed

- **OpenAI picker follows the GPT-6 generation** — the tab offers GPT-6-Astra,
  GPT-6.1-Sol and GPT-6-Luna with the efforts the Codex catalogue advertises.
  Older GPT-5.x rows left the picker; sessions saved on those aliases still
  route.
- **GPT reasoning context is explicit** — requests with reasoning enabled send
  `reasoning.context: "all_turns"`, so replayed reasoning is rendered on every
  model family rather than depending on each model's undocumented default.
- **Unpinned subagents start on the launching provider's cheaper tier** —
  Claude sessions' unpinned agents default to Sonnet 5.5 instead of inheriting
  the root's model. A native Claude session keeps Desktop's own helper model;
  the stand-in helper applies only to routed launches.
- **Provider tabs** wrap into balanced rows of equal width, keep long labels
  intact, and recover after the app reshuffles its menu.
- **Dashboard settings** use the main-process store as the authority at the
  worker spawn boundary, so a policy accepted a moment ago is not replaced by
  older bytes on disk, and a failed write no longer flashes "Saved".
- **Router supervision** watches the router tree recursively, so editing or
  adding an adapter swaps the worker like any other router edit.
- **Documentation** — `SECURITY.md` now covers the credential files the account
  picker keeps, the file-pane handler, what `unlock-code` rewrites in the page
  and how to turn it off, the patcher's `SendMessage` edit, the voice archive
  and the Command Code route; `docs/internals.md` gained the verified app and
  CLI facts behind these plugins, with the versions they were read from. The
  README now counts 33 plugins in six categories (bug fixes, unlocks, providers
  and routing, agents and automation, usage and context, transcript and
  appearance), leads with an at-a-glance grid, and lists the Claude Code Desktop
  bug each fix plugin addresses.

### Fixed

- **GPT prompt cache kept across parallel agents** — every GPT conversation,
  subagents included, now sends its own stable Responses `session-id` and
  `thread-id`. Since 2026-09-08 workers sent a new id on every request and
  roots shared the Claude session id with all their workers, which raised
  mid-conversation cache misses from 3% to 13% and to ~34% with six agents in
  flight.
- **Loading a deferred tool no longer discards the GPT cache** — Claude Code's
  deferred-tool protocol (`tool_reference`, `tool_addition` by reference or
  inline definition, `tool_removal`) is translated to Responses
  `additional_tools` items where the tool is loaded, instead of adding the tool
  to the request's `tools` list. A mid-conversation load now keeps 94–96% of
  the prefix cached, where it previously kept none.
- **Context budget and reset lifecycle** — reminders follow Claude Code's
  configured auto-compact boundary, compaction resets the window locally with
  no summary call, tokens are counted against the same post-reset transcript
  used for inference, and a stale terminal state can no longer win over a newer
  transition.
- **Unary safety checks stay on their session's provider** — auto-mode helper
  calls name an independent Claude model and omit `stream`; model-only dispatch
  sent alternate-provider sessions' checks to Anthropic and returned SSE to a
  caller that expected JSON.
- **Provider effort survives per session.**
- **OpenAI cybersecurity blocks** surface through Claude Code's own safeguard
  notice instead of a diagnostic replay or transient retries.
- **Queue** — a steer's echo lands in the app's native steered row, and queued
  sends keep draining when their session is not the one on screen or the window
  is hidden.
- **Usage ring on newer builds** — the native plan block is found by its test id
  rather than its heading, and every window row after the header is hidden, not
  only the last. Routed Code sessions keep their local credential on builds that
  renamed `getDeploymentMode`'s export, which is now found by its guard message.
- **Message age** no longer jumps to the latest background task event on a
  merged transcript entry.
- **File pane** scans the transcript for file links in chunks so the window
  keeps painting.
- **Transcript typography** is applied to semantic Markdown leaves and to
  independently inherited font tokens, closing the stock-sans path without
  touching code, math or icon fonts.
- **Footer controls** stay in separate lanes, follow the composer's logical
  margin anchor, and keep the quiet native interrupt glyph.
- **Settings page** holds still when a plugin writes its own setting.

### Security

- **The router refuses browser and rebound requests.** Port 8789 now rejects a
  request whose Host is not a loopback name on its own port, whose Origin is
  anything but the router itself, or whose `Sec-Fetch-Site` is cross-site. Before
  this, any web page open in your browser could POST to it: spend a ChatGPT
  reset credit through `/resetz`, run inference on your login through
  `/v1/messages`, or, with DNS rebinding, read `/healthz` and your usage. The
  Claude Code CLI and the plugins send none of those headers and are unaffected.
  The Host check lives in the supervisor too, so it takes effect for an
  already-running router on its next restart.
- **`/healthz` no longer echoes parse errors** from `.state/provider-secrets.json`,
  which could quote the first characters of a malformed file.
- **Computer Use is opt-in.** The plugin used to switch Desktop's Computer Use on
  at install; it now writes nothing until its switch is flipped.
- **Campaign evidence never executes.** A click opens only inert file types and
  reveals anything else in Explorer, so a prompt-injected worker cannot get a
  script it wrote run by the user.

## [1.1.0] — 2026-09-06

### Added

- **Provider router and native provider picker** — every Desktop Code session
  uses one loopback endpoint and can switch providers through the app's own
  model selector. Anthropic passthrough remains byte-identical, GPT models use
  the OpenAI Responses API with the existing Codex subscription login, and
  Anthropic-Messages backends can be registered through the catalogue.
- **Blue-green router supervision** — router changes boot as a candidate
  worker, pass health and semantic canary gates, and take only new requests
  while the previous generation drains and remains available for rollback.
- **Provider adapters** — `router/adapters/` is an isolated extension point for
  backends that need translation, native token counting, dynamic model lists,
  quota reporting, or provider-specific accounting. Zero adapters is the
  supported public default; failures stay isolated and appear in `/healthz`.
  See [docs/provider-adapters.md](docs/provider-adapters.md).
- **Usage Atlas** — durable per-response token accounting, historical pricing,
  quota windows, burn-rate forecasts, audit records, and a loopback-only
  dashboard. Cost is derived from retained token records instead of stored as
  a fixed value.
- **Throughput** — time to upstream headers, time to first content, generation
  rate, and end-to-end rate are measured at the router and attributed to the
  main session or named subagent through provider response ids.
- **Prompt policies** — named, provider-scoped system and tool transformations
  with per-session bindings, source/effective captures, and cache-safe OpenAI
  namespaces. Control-plane requests bypass the policy layer.
- **Codex V2 compaction** — GPT compaction can retain OpenAI's encrypted
  checkpoint while preserving a readable fallback for later provider switches.
- **Codex context management** — optional model-only notes and history tools,
  token-budget reminders, and outbound context-window resets. Transcript
  ingestion remains off by default.
- **Queue, subagents, goal, context pill, transcript copy, model lock,
  hide-usage-band, plan-usage-capture, and auto-compact controls** — the plugin
  set now covers explicit deferred sends, per-agent transcripts and controls,
  `/goal` state, high-context warnings, whole-session copying, provider-model
  stability, banner control, native Claude quota capture, and launch policy for
  new workers with observed worker state shown separately.
- **Compatible public providers** — catalogue entries for Meta's
  Anthropic-Messages endpoint and one further Anthropic-compatible endpoint,
  with credentials kept exclusively in ignored local state.
- A pinned pure-JavaScript `o200k_base` tokenizer for complete GPT preflight
  estimates, including image patch sizing.
- `registerRates()` in `router/pricing.mjs`, so an adapter can price the
  provider it adds instead of leaving its traffic counted as unpriced.
- `npm run check:public`, which runs the complete public regression suite with
  no adapter loaded.

### Changed

- The picker now extends the live Desktop `ccd` catalogue, filters the current
  popup in place, preserves native model and effort controls, and follows the
  model-selector shape served by claude.ai.
- Provider quota windows occupy Claude's native usage ring and popover according
  to the selected model. Context remains sourced from the CLI's own
  `get_context_usage` reply.
- Thinking Markdown is inline-only and shares the app's streamed layout.
  Transcript typography is scoped through the app's own font tokens.
- Shared router transport, limits, pricing, analytics, and model metadata are
  provider-neutral. Backend-specific behavior travels through adapter snapshots
  and registration hooks.
- The routing plugin's old, backend-specific directory is now
  `src/plugins/provider-routing`;
  `MODEL_ROUTER_*` environment names are accepted alongside the legacy
  compatibility names.
- Dashboard settings retain rotating recovery copies outside the watched source
  tree.
- `SECURITY.md` now documents the router's network, credential, prompt-capture,
  and local-state boundaries.

### Fixed

- Context and compaction meters now order navigation, hidden model rounds,
  reset boundaries, and terminal usage as one transition stream. Stale preflight
  and remounted-renderer observations can no longer reopen a retired context
  window.
- Provider selection survives host reloads, fresh-chat navigation, model
  allowlist replacement, rejected selections, and live selector changes after
  the first public release.
- OpenAI streaming accepts LF and CRLF framing, flushes an unterminated final
  event, rejects incomplete success envelopes, and keeps long streams on a
  recoverable transport.
- Native token totals include complete provider inputs and remain distinct from
  local preflight estimates.
- Codex checkpoint fallback retains complete portable history. Context-management
  requests send the reserved schemas verbatim, trigger history ingestion from
  the required body metadata, and budget against the model ceiling.
- Usage accounting deduplicates terminal responses, survives schema evolution,
  prices retained history retroactively, and keeps incompatible quota scopes
  separate.
- Floating plugins recover from detached hosts, hidden-window timer throttling,
  composer geometry changes, and stale asynchronous teardown.
- The task rail no longer creates a horizontal scrollbar on hover, fades the
  edge that actually clips rows, and exposes a stop control through each running
  agent's runtime cell.
- Whole-session copying removes embedded NUL bytes before writing to the
  clipboard.

## [1.0.0] — 2026-08-26

First public release. Verified against Claude Desktop **1.26832.0**
(Electron 42.7.0, Chromium 148).

### Added

- **Patcher** (`patch.js`) — appends two loader scripts to `app.asar` by
  re-pointing header entries instead of repacking, so all `app.asar.unpacked`
  entries and every untouched per-file integrity record stay byte-identical.
  Repoints the asar header hash embedded in `claude.exe`, backs up both files,
  and verifies the rewrite before swapping it in. `apply` / `revert` / `status`.
- **Update watcher** (`watch.js`, `install.ps1`) — registered as a logon
  scheduled task. Patches a freshly downloaded `app-<version>` before it ever
  launches, and patches the running version the moment the app goes down.
  Distinguishes the desktop app from Claude Code CLI agents by process path,
  since both are `claude.exe`.
- **Hot-reload runtime** — two baked loaders own the IPC surface and the file
  watcher permanently; `src/runtime/host.js` and `src/runtime/bridge.js` reload
  from disk on save with last-good-wins semantics. The page never reloads and
  in-flight agent turns are never disturbed.
- **Plugin system** — `src/plugins/<name>/{main.js,renderer.js}`, picked up live
  with no re-patch. Resources are acquired through `ctx` helpers that record
  disposers, so reloads cannot leak timers, watchers or observers.
- **`dashboard`** — settings overlay on Insert, with live before/after preview
  frames; persists to `.state/settings.json` via debounced atomic writes.
- **`task-rail`** — live task list of the session the window is displaying,
  pinned left of the composer.
- **`usage-bar`** — context and rate-limit meters in the composer footer.
- **`thinking-default`**, **`thinking-style`**, **`transcript-type`** —
  transcript view and typography.
- **`selfcheck.js`** — compiles the hot tree, constructs the host against a fake
  Electron, and asserts zero interval/watcher leaks across a dispose cycle.
- Documentation of the desktop app's verified internals, including the dead ends
  (`docs/internals.md`).

### Known limitations

- Windows only.
- Live injection into an already-running app is not possible on a packaged
  Electron build; `live-inject.js` works only against an instance started with
  `--inspect`. Reasons are in the README.
- The two baked loaders require a re-patch and an app restart to change.
