# claude-ui-mod

Injected custom UI inside Claude Desktop (Windows, Electron), delivered by
patching `app.asar` and repointing the integrity hash baked into `claude.exe`.
Plain CommonJS, no build step. The router uses the pinned pure-JS tokenizer;
run `npm ci` after cloning. `docs/internals.md` is the
ledger of app facts that cost real debugging — read it before changing anything
structural, and add to it when you establish a new one.

If skills named `claude-desktop-plugins` or `prompt-policy` are installed, they
carry the longer workflows for plugin/runtime, router and prompt-policy work;
this file is the repository contract and stays authoritative for anything
established in source or measurement. Do not hand-edit prompt-policy JSON.

## Commit when the work is done

Every landed change gets its own commit, at the moment it lands — not at the end
of the session, and not batched with the next task. A working tree left dirty
across tasks is how three plugins ended up in one uncommitted pile.

- One commit per coherent change. Split by what the change *is*, not by file.
- Message says **why**, in the same register as the code comments: the
  constraint that forced the design, the measurement that settled it. The diff
  already says what.
- Commit only after `node selfcheck.js` passes.
- **Never push without being asked.** `origin` is a public GitLab repo and
  `github` is a public mirror; committing is local and reversible, pushing is
  neither.
- End the message with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Two baked files, everything else hot

| file | reload |
|---|---|
| `src/main-hook.js` | **BAKED** — needs `patch.js apply` + app restart |
| `src/preload-hook.js` | **BAKED** — needs `patch.js apply` + app restart |
| `src/runtime/host.js` | hot, on save (main process) |
| `src/runtime/bridge.js` | hot, on save (renderer) |
| `src/plugins/*/main.js` | hot, on save (main process) |
| `src/plugins/*/renderer.js` | hot, on save (renderer) |
| `src/plugins/branding/*.svg` | hot through the branding plugin's validated asset watch |
| `router/*.mjs`, except `supervisor.mjs` | blue-green worker swap after `/healthz` plus the semantic canary; previous generation stays warm for rollback |
| `router/supervisor.mjs` | **STABLE LISTENER** — deliberate process replacement; excluded from its own watch |
| `router/adapters/*/` | loaded at worker boot; a change is a worker swap like any other `router/*.mjs` |
| `src/plugins/provider-picker/catalogue.json` | hot in picker; read per compatible-provider request |
| `.state/provider-secrets.json` | hot per compatible-provider request; ignored, never commit |

The baked files are dumb loaders. Adding feature logic to one is the signal that
it belongs in `host.js` or in a plugin instead. A new plugin needs no re-patch —
dropping a directory into `src/plugins/` is picked up live.

`router/supervisor.mjs` owns public port 8789. A router backend save boots a
candidate `router/index.mjs` on a private port, accepts it only after `/healthz`
returns 200 and `scripts/router-canary.mjs` passes in a fresh process, then switches
new requests. The previous worker stays warm as the rollback target for two
minutes (`ROLLBACK_WINDOW_MS`), and a retired worker keeps draining its active
responses for up to an hour (`RETIRED_DRAIN_TIMEOUT_MS`). Syntax errors, failed health checks, and failed translation
canaries retain the current worker. `GET /supervisorz` reports the warm generation;
local `POST /rollbackz` restores it immediately, and a current worker that exits
rolls back automatically. Desktop and the CLI sessions stay running. This guarantee
covers router workers, not the stable supervisor itself.

**Never edit a watched `router/*.mjs` file incrementally.** Assemble the complete
candidate outside `router/`, run `node scripts/router-canary.mjs --router-dir
<staged-router-dir>`, the targeted router tests, and `node selfcheck.js` against
that tree. Replace the finalized watched files within one debounce window. A
half-applied source file is a live deployment, not a draft.

Compatible-provider catalogue and credential JSON are parsed per request with
last-good fallback on malformed edits. Unknown aliases fail closed instead of
falling through to Anthropic. Provider credentials belong only in ignored
`.state/provider-secrets.json`, and the catalogue is the only place a
*catalogue* backend is registered — adding an entry there is what enables a
route.

Treat a private-catalogue entry arriving through a merge the same as a
router change; no gate fails when a stale branch carries one in.


## The public boundary is a directory, not a branch

This repository is published from a private tree by an exclusion manifest, not
by maintaining a second branch. A `*/private/` directory, and any adapter under
`router/adapters/`, may be absent from the tree you are looking at.

Two rules follow, and they hold whichever tree you are in:

- **Public code never names a private backend.** If you find yourself adding
  such a name to a file outside `router/adapters/`, the logic belongs in the
  adapter. Usually the fix is a field on the adapter's own snapshot — the way
  `analytics.mjs` reads `poolLabel` and `trackedQuotas` from the limits payload
  instead of knowing them.
- **`npm run check:public` must pass with no adapter loaded.** Public tests set
  `MODEL_ROUTER_ADAPTER_DIR` to an empty directory for exactly this reason.
  Adapter behaviour is tested beside the adapter.

The published catalogue may also be narrower than this one: a model only the
private tree can route belongs in `catalogue.private.json`, and the publish step
fails if the shipped picker offers something no shipped arm claims.

An earlier attempt made this boundary a long-lived branch. It went stale in
three days and was abandoned 59 commits later. Do not reintroduce that shape.

`origin` is a public GitLab repo and `github` a public mirror. Never push to a
public remote without being asked.

```bash
node selfcheck.js          # compile + wiring + leak check; touches nothing
npm run check              # complete plugin/router regression suite
```

Run it after every edit to a hot file. A compile error at runtime is silent —
the host keeps the previous version and nothing in the UI changes. `selfcheck`
is where that shows up as a real failure.

## Rules that break the running app

- **Never write files under `src/` from plugin code.** The watcher is on `src/`;
  a write there reloads the host, which writes again. Use `.state/` for
  persisted settings, `.probe/` for scratch evidence.
- **Never take a timer, watcher, listener or observer without a `ctx` helper**
  (`ctx.every`, `ctx.watch`, `ctx.track`, `ctx.observe`, `ctx.onDispose`).
  Anything else leaks into a window that stays open for days.
- **Do not hardcode the eipc build uuid.** It changes per build. Compose
  channels with `cuimod.eipc(ns, iface, method)`.
- **Never put provider credentials in source, catalogue, tests, logs, health
  responses, or renderer RPC.** Store them in ignored `.state/provider-secrets.json`.
- **Do not restart or kill the router for backend edits.** Save the worker source
  and let the supervisor health-gate and drain the generation. Treat edits to
  `router/supervisor.mjs` as deliberate maintenance.

## Read the app, do not guess at it

The desktop app ships its own renderer bundle at
`%LOCALAPPDATA%\AnthropicClaude\app-<version>\resources\ion-dist\assets\v1`.
It is minified but complete, and grepping it settles questions about the app's
own behaviour — node schemas, IPC signatures, which slash commands the renderer
intercepts before they ever reach the CLI — that would otherwise be guessed.
Cite the version you read when recording a fact in `docs/internals.md`.

That bundle is the **shell**. The Code UI in the window is served live from
claude.ai and ships on its own cadence, so a DOM question — a class name, a node
shape, anything you intend to write a selector against — is only settled by a
probe against the running page. See "The claude.ai UI is not the ion-dist
bundle" in `docs/internals.md`.

## Verifying a change actually took effect

There is no console; the app's `console.log` goes to an uncaptured stdout. Use a
temporary probe plugin that writes evidence to `.probe/`, one filename per
generation (`beat-<generation>.json`) so a leaked old instance shows up as a
file that keeps updating after it should have stopped. Delete the probe when
done.

Renderer state comes back by having the probe's `renderer.js` call an RPC method
its `main.js` registered. Poll for `cuimod.sessionId` first — session resolution
is async and finishes after plugin init.

Router state is observable without a probe: `/healthz` must return 200 through
port 8789 with `x-cuimod-router-supervisor: 1` and an integer
`x-cuimod-router-generation`. The compatible-provider health payload may expose
provider/model/readiness metadata, never credential values.

## Style

Match the surrounding code: 4-space indent, single quotes, semicolons,
`'use strict'`, no framework, no transpiler, no dependencies. Comments explain
why, and are worth their length exactly where the behaviour is counter-intuitive.
