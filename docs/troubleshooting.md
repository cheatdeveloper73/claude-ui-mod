# Troubleshooting

| symptom | cause | fix |
|---|---|---|
| App dies instantly at launch: no window, no log, no crash dump | The asar header hash no longer matches the value baked into `claude.exe`. Electron writes `FATAL asar_util.cc:144 Integrity check failed` to a stderr nobody sees. | `node patch.js apply --force`, which repoints the exe field. `node patch.js revert` if you want out. |
| `patch.js apply` says "Claude is running" and it is not | `running()` matches any `claude.exe`, and every Claude Code CLI agent is also `claude.exe`. | `--force`. The real liveness test is a process whose path matches `*\AnthropicClaude\app-*`, which is what `watch.js` uses. |
| `EPERM` / `EBUSY` replacing `app.asar` | That version is the running one; Windows keeps it memory-mapped. | Quit the desktop app fully (tray icon), then re-run. A *different*, non-running `app-<version>` patches fine while the app runs. |
| Edited a hot file, nothing changed | Compile error. The host caught it and kept the previous version — by design. | `node selfcheck.js`. Fix, save again. |
| Edited `main-hook.js` or `preload-hook.js`, nothing changed | Those two are baked into the asar. | Quit the app, `node patch.js apply --force`, restart. |
| Endless reload loop | A plugin wrote a file under `src/`, which the baked loader watches. | Write to `.state/` or `.probe/` instead. Never under `src/`. |
| Rail says "No session detected" | The URL carries the desktop id (`local_<uuid>`), not the task-store key. It must be translated via `cliSessionId`. | Confirm `%APPDATA%\Claude\claude-code-sessions\<acct>\<ws>\local_<uuid>.json` exists. A brand-new chat has no such file for its first moments, which is normal. |
| Duplicate rails or meters after a reload | A plugin mounted without first removing a stray host with its own id. The orphan keeps its pixels and loses its JS. | Remove strays by id on every mount tick, as `task-rail` does. |
| A floating element shows stale numbers at a stale position | Same cause: an undisposed generation's host. `getElementById` hands you the corpse, so measurements describe it while the pixels overlap. | Same fix. It reads like a CSS bug and is not one. |
| Everything must stop, now | — | Create a file named `DISABLED` in the repo root and save anything under `src/`. Delete it and save again to restore. |
| Rail is a thin ~39px bar | Collapsed. `localStorage['cuimod.collapsed'] === '1'`. | Click `+`. |
| Injected UI has a solid white outline in dark mode | `--border-100..400` are near-white on this build; the app never uses that ramp raw. | Derive edges from the text colour: `color-mix(in srgb, hsl(var(--text-100)) 12%, transparent)`. |
| `::-webkit-scrollbar` rules do nothing | claude.ai sets `scrollbar-color`, which inherits into shadow trees and switches Chromium to standard scrollbar rendering. | Put `scrollbar-color: auto` on the scroller first, then style the pseudo-elements. |
| UI never appears when the window is minimised | A hidden window never fires `requestAnimationFrame`, so anything parked at `opacity: 0` waiting for a frame stays there. | Drive layout from an interval directly, flush with a forced reflow, and re-place on `visibilitychange`. |
| Overlay drops the app to ~18 fps | `backdrop-filter` re-blurs the whole backdrop every frame, and the transcript behind is always moving. | Use a flat `rgba(0,0,0,.62)`. Masks and large box-shadows measured as free. |
| A model in the picker answers as Claude under its own label | Nothing claimed it, so it fell through to the Anthropic passthrough. | `GET /healthz`: the model must appear under `compatible.providers` or under `adapters.loaded`. A catalogue entry with no `backend` block is picker-only and routes nowhere. |
| A provider adapter is silently absent | It failed to load and the router carried on without it, by design. | `GET /healthz` → `adapters.errors` names it and why. The startup log line lists the loaded set. |
| A subagent dies with "model may not exist" while the same model works at top level | The Agent tool validates against `/v1/models` before spawning, and the id is not in that list. | An adapter's `models[]` supplies the id and its `:effort` spellings; `modelIds()` supplies live ones. A backend that is down contributes nothing, so the subagent fails while a direct request still works. |
| A provider's traffic shows as unpriced in the usage dashboard | No rate is registered for `provider/model`. Unpriced is deliberate — it reads as a gap in the bill rather than as free traffic. | Call `registerRates()` from `router/pricing.mjs` at adapter module scope. |

## Fresh chats wait exactly 30 seconds at "Starting Claude Code"

Check `[CCD start-timing]` in `%APPDATA%/Claude/logs/main.log`. If `init`
accounts for the delay while `preflight`, `mcp`, and `query` are short, inspect
the CLI startup log (`--debug-file <local-file>`), not just the router log.
The first model request can be waiting behind an MCP initialization timeout.

On Desktop 1.26832.0 / CLI 2.1.222, a home-directory `.mcp.json` loaded
an editor-bridge MCP server into unrelated projects. That server awaited an
editor WebSocket connection before starting MCP stdio. With no editor running,
the CLI waited 30,000 ms for the MCP handshake, then sent the first request.
The fix in that server's own repository starts MCP immediately and uses
the existing `sendCommand()` connection-on-demand path. Tools remain available;
no global timeout, routing, credential, or permission change is needed.

Two fresh-chat recovery runs reduced CLI initialization from 32.5 seconds to
4.9 and 3.7 seconds. Model generation time is separate from this startup delay.
The regression test in that repository launches the real stdio
server and verifies initialization, tool discovery, and resource discovery
without contacting an editor.

## Reading state when there is no console

The app's `console.log` goes to an uncaptured stdout, so a log statement proves
nothing. Copy [`examples/probe-plugin`](../examples/probe-plugin) to
`src/plugins/probe/` — it loads live — and read the files it writes to
`.probe/`. Delete it when done.

Per-generation heartbeat files make leaks self-evident: after a reload, exactly
one `beat-<generation>.json` should keep updating.

## Checking what is installed

```bash
node patch.js status
```

Prints the app root, the mod directory, whether a desktop process is up, and for
each `app-<version>` whether it is patched and whether a pristine backup exists.
A patched version with no backup cannot be reverted — reinstall Claude Desktop
for a clean asar.
