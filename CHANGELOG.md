# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  Anthropic-Messages endpoint and NanoGPT's GLM 5.3 Flash endpoint, with
  credentials kept exclusively in ignored local state.
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
- `src/plugins/gemini-routing` is now `src/plugins/provider-routing`;
  `MODEL_ROUTER_*` environment names are accepted alongside the legacy
  compatibility names.
- Dashboard settings retain rotating recovery copies outside the watched source
  tree.
- `SECURITY.md` now documents the router's network, credential, prompt-capture,
  and local-state boundaries.

### Fixed

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
