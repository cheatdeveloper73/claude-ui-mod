# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html).

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
