# Runtime dev flow

Everything except two loader files is hot. Edit a file, save, the change is live.
No app restart, no page reload, no interruption to running Code sessions.

## What is baked vs hot

| file | reload |
|---|---|
| `src/main-hook.js` | BAKED — re-patch + restart (loader only; should never need to change) |
| `src/preload-hook.js` | BAKED — re-patch + restart (bridge loader + IPC tap) |
| `src/runtime/host.js` | hot, on save — main process |
| `src/runtime/bridge.js` | hot, on save — renderer |
| `src/plugins/*/main.js` | hot, on save — main process |
| `src/plugins/*/renderer.js` | hot, on save — renderer |

Routing: a saved file matching `renderer.js` / `bridge.js` / `*.css` triggers a
renderer-only reload. Anything else reloads the main host, which then also
refreshes renderers.

## Why reloading is safe while long jobs run

- **Last-good-wins.** New code is compiled before the old is torn down. A syntax
  error logs and keeps the running version. Fix the file, save again.
- **The watcher lives in the baked loader**, not the host, so even a host that
  fails to load is recoverable by saving — never by restarting.
- **No IPC re-registration.** The loader owns `ipcMain.handle` permanently and
  dispatches into whatever host is current, so reloads can't hit Electron's
  "second handler for X" throw.
- **Disposal is enforced.** Plugins take resources through `ctx` helpers
  (`every`, `watch`, `track`, `observe`, `onDispose`) that record a disposer.
  `selfcheck.js` asserts zero interval/watcher leaks across a dispose cycle.
- **The page never reloads.** The renderer reload swaps our isolated-world code
  only; claude.ai's React tree and your sessions are untouched.
- **Nothing touches the agents.** The mod never goes near the CLI child
  processes or their stdio pipes.

## Writing a plugin

    src/plugins/<name>/main.js       (optional, main process)
    src/plugins/<name>/renderer.js   (optional, renderer)

`main.js` exports a factory:

```js
module.exports = function (ctx) {
    ctx.method('ping', () => 'pong');          // -> rpc('<name>.ping')
    ctx.every(5000, () => ctx.log('tick'));
    ctx.watch(somePath, {}, () => ctx.broadcast({ type: 'x' }));
    ctx.onDispose(() => { /* cleanup */ });
};
```

`renderer.js` runs as `new Function('cuimod','ctx', source)` in the isolated
world. Use `ctx.track/observe/every/onDispose` for anything that outlives the
call, or the reload will leak it.

## Digging into desktop internals at runtime

From renderer code (`cuimod`):

```js
await cuimod.rpc('host.info')                       // methods, plugins, generation
await cuimod.rpc('dev.webContents')                 // every view + url
await cuimod.rpc('dev.eval', { code: 'return require("electron").app.getVersion()' })
await cuimod.rpc('fs.read', { path: 'C:/…/main.log' })

cuimod.appInvoke(cuimod.eipc('claude.web','LocalSessions','getAll'))   // any app API
cuimod.appOn(cuimod.eipc('claude.web','LocalSessions','onEvent'), (e,ev) => …)
cuimod.tap                                          // ring buffer of the app's own IPC
```

`cuimod.tap` and `observeInvoke` are how you discover channels: drive the UI,
read the tap, then call the method yourself.

`dev.eval` runs in the main process. It is reachable only from our isolated
world — it is never contextBridged to claude.ai's page JS.

## Commands

```bash
node selfcheck.js                 # compile + wiring + leak check, touches nothing
node patch.js status
node patch.js apply --force       # only needed for the two baked files
node patch.js revert              # restores asar AND exe
```

Kill switch: create a file named `DISABLED` in this directory and save any file
under `src/` — the host unloads. Delete it and save again to restore.

## Integrity note

Electron validates the asar header hash against a value embedded in
`claude.exe`. `patch.js` repoints that field after rewriting the archive
(`claude.exe.cuimod-backup` holds the original). Skipping that step is what
caused the earlier boot-time `FATAL: Integrity check failed`.
