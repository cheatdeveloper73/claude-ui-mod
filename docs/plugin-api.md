# Plugin contracts, RPC surface, recipes

## Layout

```
claude-ui-mod/
  patch.js  watch.js  selfcheck.js  install.ps1
  lib/asar.js                       asar read/rewrite + exe integrity repoint
  src/main-hook.js                  BAKED loader (main)
  src/preload-hook.js               BAKED loader (preload)
  src/runtime/host.js               HOT main runtime: plugin manager + builtins
  src/runtime/bridge.js             HOT renderer runtime: session resolve + plugin loader
  src/plugins/<name>/main.js        HOT, optional
  src/plugins/<name>/renderer.js    HOT, optional
```

Plugin dirs beginning with `.` or `_` are skipped.

## main.js contract

```js
module.exports = function (ctx) {
    ctx.method('ping', (params, event) => 'pong');  // exposed as rpc('<name>.ping')
    ctx.every(5000, () => ctx.log('tick'));         // auto-cleared on reload
    ctx.watch(somePath, { recursive: true }, (ev, name) => ctx.broadcast({ type: 'x' }));
    ctx.onDispose(() => { /* cleanup */ });
};
```

`ctx`: `name`, `electron`, `boot`, `log`, `method`, `rawMethod` (register an
unprefixed/override name), `onDispose`, `every`, `watch`, `broadcast`, `dir`.

A plugin that throws during load is caught and logged; other plugins and the host
still load.

## renderer.js contract

Evaluated as `new Function('cuimod','ctx', source)` in the preload's isolated
world. Full DOM access; claude.ai's page JS cannot see it.

`ctx`: `name`, `onDispose`, `every`, `track(target,type,fn,opts)`,
`observe(node,opts,fn)`.

`cuimod`:

| member | purpose |
|---|---|
| `sessionId` | resolved CLI session id, or null until async resolve finishes |
| `onSessionChange(fn)` | fires on resolve and on change |
| `onTasksChange(fn)` | fires when the task store changes for this session |
| `getTasks()` | current task array |
| `openTasksDir(id?)` | open the task folder |
| `rpc(method, params)` | call any host method |
| `appInvoke(channel, ...args)` | the app's own IPC, raw |
| `appOn(channel, fn)` | subscribe to an app channel; returns unsubscribe |
| `eipc(ns, iface, method)` | compose an app channel name |
| `tap` | ring buffer (300) of the app's own IPC calls |
| `observeInvoke(fn)` | fires on every app IPC invoke as it is made; returns unsubscribe |
| `log(...)`, `refresh()`, `reload()` | |

Return `{ dispose() }` or use `ctx.onDispose` — either is honored.

## Host RPC methods (built in)

```
host.info               generation, modDir, tasksRoot, methods[], plugins[]
host.reload             reload the main host
host.rendererReload     broadcast a renderer reload
host.rendererBundle     { bridge, plugins:[{name,source}], generation }
tasks.list              { sessionId } -> task[]
tasks.resolve           { candidates[] } -> cliSessionId | null
tasks.openDir           { sessionId }
fs.read                 { path, max? } -> { size, truncated, text }
fs.list                 { path } -> [{ name, dir }]
dev.eval                { code } -> result   (async body, runs in MAIN process)
dev.webContents         [{ id, type, url, destroyed }]
```

`dev.eval` receives `electron`, `boot`, `require`, `host`. It is reachable only
from the mod's isolated world, never from claude.ai page JS.

## Introspection recipes

Discover an unknown channel: drive the UI, then read the tap.

```js
cuimod.tap.slice(-20).map(e => e.channel)
```

Call any desktop API directly:

```js
await cuimod.appInvoke(cuimod.eipc('claude.web','LocalSessions','getAll'))       // 608 sessions
await cuimod.appInvoke(cuimod.eipc('claude.web','LocalSessions','getGitInfo'), sid)
cuimod.appOn(cuimod.eipc('claude.web','LocalSessions','onEvent'), (e, ev) => console.log(ev.type))
```

Poke the main process:

```js
await cuimod.rpc('dev.eval', { code: 'return require("electron").app.getVersion()' })
await cuimod.rpc('dev.eval', { code: 'return boot.generation' })
```

Watch the app's own focus changes:

```js
boot.observeInvoke((ch, args) => { if (ch.includes('_$_setFocusedSession')) console.log(args); })
```

## Verifying changes without a console

The app's `console.log` goes to an uncaptured stdout. Use a temporary probe
plugin that writes to disk **outside `src/`**. A ready one is in
[`examples/probe-plugin`](../examples/probe-plugin) — copy it to
`src/plugins/probe/` and it loads live:

- `main.js` appends `{t, gen, kind}` lines to `.probe/events.log` on
  load/dispose/report, and heartbeats to `.probe/beat-<generation>.json`.
- `renderer.js` polls for `cuimod.sessionId` (resolution is async and finishes
  *after* plugin init), gathers DOM evidence, then calls the probe's RPC method.

Per-generation beat files make leaks self-evident: after a reload only the newest
generation's file should keep updating.

Proven with this method: hot-loading a brand-new plugin with no restart;
last-good-wins on a syntax error (old generation kept beating, no new generation);
correct ordering on recovery (new gen loads, *then* old gen disposes); and zero
interval leak (disposed generation's beat file froze).

See [troubleshooting.md](troubleshooting.md) when something does not take effect.
