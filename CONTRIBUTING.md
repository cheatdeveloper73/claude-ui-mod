# Contributing

The fastest useful contribution is a plugin. Adding one needs no re-patch and no
restart: drop a directory into `src/plugins/` and the running app picks it up.

## Setup

```bash
git clone https://gitlab.com/blockshooter/claude-ui-mod
cd claude-ui-mod
node patch.js apply      # Claude Desktop must be fully quit
node selfcheck.js        # should print SELFCHECK PASS
```

There is no build step and no dependency to install. Everything is plain
CommonJS run by the app's own Node.

## The loop

1. Edit a file under `src/`.
2. Save. The change is live — `renderer.js` / `bridge.js` / `*.css` reload the
   renderer only; anything else reloads the main host, which then refreshes
   renderers.
3. Run `node selfcheck.js`. It compiles the whole hot tree, constructs the host
   against a fake Electron, dispatches `host.info` and `host.rendererBundle`,
   and asserts zero interval and watcher leaks across a dispose cycle. A silent
   "kept previous version" at runtime shows up here as a real failure.

`docs/development.md` has the full flow, `docs/plugin-api.md` the contracts.

## Rules that are not style preferences

Both of these break the running app, and neither is caught by review-by-eye:

- **Never write files under `src/` from plugin code.** The baked loader watches
  `src/`, so a write there reloads the host, which writes again. Use `.state/`
  (persisted settings) or `.probe/` (scratch evidence).
- **Never take a timer, watcher, listener or observer without a `ctx` helper**
  (`ctx.every`, `ctx.watch`, `ctx.track`, `ctx.observe`, `ctx.onDispose`).
  Anything else leaks into a long-running window on every reload, and the app
  stays open for days.

Two more that matter for review:

- **Keep `src/main-hook.js` and `src/preload-hook.js` dumb.** They are baked
  into the asar and cost every user a re-patch and a restart to change. Feature
  logic goes in `src/runtime/host.js` or in a plugin. A PR that adds a feature
  to a baked file will be asked to move it.
- **Do not hardcode the eipc build uuid.** It changes per build. `patch.js`
  lifts it out of the shipped preload; compose channels with
  `cuimod.eipc(ns, iface, method)`.

## Style

Match the surrounding code. 4-space indent, single quotes, semicolons, `'use
strict'`, no framework, no transpiler, no dependencies. New runtime dependencies
will be turned down — this code runs inside someone else's signed application
and the review surface is the point.

Comments explain *why*, especially where behaviour is counter-intuitive. Most of
the non-obvious facts in this codebase cost real debugging to establish; if you
establish another one, write it into `docs/internals.md` with the app version
you verified it against.

## Pull requests

- One change per PR.
- Say which app version you tested against (`node patch.js status`, or Help →
  About in the app).
- Paste the `selfcheck.js` output.
- Say what you actually observed in the running app, not what should happen.
  "Reloaded 20 times, no duplicate hosts, beat file froze on dispose" is the
  standard.

## Reporting internals

Claims about the desktop app's internals belong in `docs/internals.md` with the
version they were verified against, and dead ends belong there too — the point
of that file is that nobody re-walks a path already known to end nowhere.
