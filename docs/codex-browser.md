# Codex tools in Claude's browser

`src/plugins/codex-browser/` connects the installed official Codex `cua_repl`
to Claude Desktop's existing browser pane. The renderer, tabs, persistent browser
profile and sign-ins remain Claude's. No separate browser or extension is started.

## Requirements and activation

- Windows Claude Desktop **2.9939.4** with this mod's normal hot plugin runtime.
- Codex Desktop with its bundled `unified-computer-use` plugin installed. Runtime
  discovery reads that plugin's `.mcp.json` and validates the referenced files
  under the local Codex installation. No OpenAI package is copied into this repo.
- An existing local Code session with Claude Browser enabled. Remote, SSH and
  WSL sessions are outside this adapter's supported scope.

Dropping this plugin into `src/plugins/` activates it without repatching or
restarting Desktop. New SDK launches receive `cua_repl`; existing idle sessions
receive it when the native SDK's full server map is available and no agent,
background task or host request is running. Active sessions are left alone until
idle. An unrelated MCP server already named `cua_repl` is left alone.

The model receives the official `js` and `js_reset` definitions. MCP initialization
identifies this as the built-in pane's preferred fast path and names the native
fallback. `turn_ended` is internal. Original Claude Browser tools remain available for preview servers,
unsupported operations and native diagnostics. No router or prompt-policy edit
is required.

Runtime status is available through the plugin's `status` RPC and
`.state/codex-browser/status.json`. Per-session helper lifecycle logs live below
that directory. Logs exclude JavaScript source, page contents and results.
Missing runtime files or an unverified Desktop build leave the original browser
tooling available. A Desktop update needs a contract verification before adding
its version to the adapter.

## Using the fast path

The first `js` call selects an existing tab or creates a native tab and returns
the official runtime documentation. Use the browser/tab IDs from inventory, or
a URL that identifies exactly one tab:

```javascript
var page = await cua.getTab({ url: 'https://example.com/' }, { browser: '1' });
```

Subsequent calls reuse the handle. Actions, observations, branches and assertions
can execute in one JavaScript invocation:

```javascript
await page.playwright.getByLabel('Name', { exact: true }).fill('Example');
await page.playwright.getByRole('button', { name: 'Apply', exact: true }).click();
await page.getAXState();
```

Use only the APIs in the actual returned runtime documentation. Optional Codex
capabilities are not advertised unless the native backend implements them.
For example, the `visible` tab-creation option is unsupported; omit it. Creating
a tab uses Claude's background tab creation and does not open an OS window.

## Native policy

Origin-access requests go through
`permissionBroker.createPreviewOriginPermissionHandler(sessionId)`. This is the
same native browser policy used by Claude's tools, including the existing
bypass-mode handling. There is no second Codex origin approval dialog and no
separate allowlist to maintain. A native denial remains a denial. The adapter
does not change session permission modes or Codex safety configuration.

DOM dispatch, navigation and input retain the real native handler's policy,
origin, frame and post-action checks. The adapter substitutes only the admitted
dispatch body. Unsupported approval forms require a client that negotiated MCP
form elicitation; this Desktop SDK does not negotiate it, so those forms fail
explicitly rather than being auto-accepted.

## Lifecycle and failure behavior

Each Desktop session owns a hidden official runtime helper and a random named
pipe. The pipe exposes only that session's native tabs. Session, account, query,
transport and target identity changes invalidate stale callers. Arbitrary
browser-global targets and cookies are outside the backend contract.

The host preserves the full native MCP server map. Replacing its own idle server
first removes only that server because native `Query.setMcpServers` otherwise
retains an existing SDK transport by name. Configuration acknowledgement and
connection readiness are separate: the CLI may still report `pending` after
acknowledging the new map.

Browser calls are serialized per session; CDP commands are serialized per tab.
A stable Codex turn ID spans the native user turn. Turn-end cleanup is queued
before the next turn's calls. Reload handoff preserves active resources;
a changed plugin revision drains the old binding before replacing it.
Cancellation disconnects pending work. A native handler still awaiting dispatch
retains a scoped cancellation guard until it settles, and that tab rejects new
bridge invocations while it drains. Restoring the original dispatch immediately
would let a delayed native handler execute after cancellation. Hooks are restored
when the native handler settles. An uncertain action is never automatically replayed. Unload kills only this
plugin's helper process trees and removes its owned browser instrumentation.

The only persistent page script admitted by the backend is the installed
runtime's exact clipboard bootstrap, reconstructed from that installation's
source and matched against an already-owned binding. This supports normal
Playwright filling without accepting arbitrary persistent scripts.

## Verified behavior and limits

Verified live on 2026-10-16 against Desktop 2.9939.4, CLI 2.1.284,
`@oai/cua-repl` 0.1.0 and `@oai/browser-desktop` 0.1.1:

- Actual model-visible Codex tools discovered and controlled Claude's native pane.
- Native tab creation, navigation completion, locator fill, click, DOM snapshot,
  in-call assertion and tab closure completed successfully.
- With the whole pane closed, Codex created a fresh native pane, opened a public
  read-only page, returned its DOM snapshot and closed the tab again. Native
  placeholder documents are identified by Claude's own blank-page classifier.
- Viewport screenshot capture succeeded through Claude's native screenshot path.
- Existing native MCP servers survived attachment.
- Origin access used native policy without an additional Codex prompt.

An adaptive loopback fixture replaced its first button with a newly named control.
Both arms reached `Complete`. Setup and reset calls were excluded:

| Workflow arm | Model tool calls | Final state |
|---|---:|---|
| Original `browser_batch`, observe then choose the new ref | 2 | Complete |
| Codex `js`, observe then choose the new locator inside JS | 1 | Complete |

This measures model round trips for that workflow. It does not establish a
wall-clock speed ratio. Static known-action workflows can already fit into one
native `browser_batch` call.

Screenshot rendering still depends on Claude's compositor. A later capture
returned the native five-second rendering timeout while the pane was hidden and
the window was behind other work. DOM workflows remained available. The adapter
propagates that error; it does not front the window or return an old image as a
fresh capture. Pointer calibration can require a native screenshot after a
navigation or viewport change and shares this limitation.

Cross-origin child targets, arbitrary persistent scripts, full-page captures
beyond the native viewport, browser-global CDP, unsupported clipboard/system keys
and unsupported input shapes fail explicitly. Use the original browser tools
where they support the requested operation. Downloads, uploads, browser dialogs,
external authenticated sites and long-duration workloads have not been live
verified for this adapter.

## Checks

```bash
npm run check:browser
```

```bash
node selfcheck.js
```

The final production-source run passed 78 tests with no failures or skips.
Four focused checks were first run against their pre-fix candidates and then
rerun against the deployed source. Each fixed run reported `tests 1, pass 1,
fail 0`. The pre-fix failures were:

```text
navigation completion
  actual:   [Page.domContentEventFired]
  expected: [Page.frameNavigated, Page.domContentEventFired]
owned tab closure
  Unsupported CDP command: Target.getTargets
user-turn identity
  actual: tool-b; expected: tool-a
late dispatch after cancellation
  actual native-call records: 2; expected: 0
```

The matching narrow commands are:

```bash
node --test --test-name-pattern="native navigation retains" tests/codex-browser/native-backend.test.cjs
```

```bash
node --test --test-name-pattern="Codex tab closure" tests/codex-browser/native-backend.test.cjs
```

```bash
node --test --test-name-pattern="Codex turn identity" tests/codex-browser/main-lifecycle.test.cjs
```

```bash
node --test --test-name-pattern="cancellation before native dispatch" tests/codex-browser/native-adapter.test.cjs
```

`node selfcheck.js` also passed after removing the diagnostic plugin. The full
repository-wide `npm run check` was not run for this change.

The browser suite uses production plugin sources and temporary fixtures outside
`src/`. It includes the actual installed Codex runtime against a synthetic scoped
backend. That one test skips explicitly when the official Windows runtime is
absent; other tests remain runnable without it. The synthetic test sends no
browser traffic and creates no chats.
