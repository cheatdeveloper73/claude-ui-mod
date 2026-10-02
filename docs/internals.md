# Claude Desktop internals

Established by reading the shipped bundle and by measurement, against
**app 1.26832.0 / Electron 42.7.0 / Chrome 148.0.7778.280**. Do not re-derive; do re-verify the version
if something behaves unexpectedly after an update.

## App layout

### The model selector changed shape again (read 2026-09-19)

The live Code frontend no longer uses the 1.44121.4 popup contract that the
provider strip targeted. A page-world fiber walk from the model trigger found the
current selector component and its already-created popup element without opening
the menu:

- The popup is the generic CDS menu primitive. Its live forward-ref source
  defaults `data-cds` to `"Menu"`; the trigger remains a normal
  `button[aria-haspopup="menu"]`.
- Its child renderer is `Im({header,items,extraSections,...})`, which renders a
  `GroupLabel` followed by the item map. The model item payload still carries
  the exact wire id as `value`, but the current loaded frontend graph contains
  no `data-model-id` marker. The previous isolated-world row selector therefore
  sees zero rows even though catalogue injection still fills the visible list.
- The reliable isolated-world fallback is the model display name from the same
  catalogue snapshot. Native names come back from the page-world snapshot;
  injected names come back with the wire-id/provider map. Match longest labels
  first, cache the recovered id on the row, and still honor `data-model-id` if
  an older frontend emits it.

The renderer accepts both `data-cds="ModelSelector"` and the current generic
`data-cds="Menu"`. A generic menu is decorated only when its labelled trigger
is the composer model control and its radio rows resolve to known model labels,
so the nested “More models” menu and unrelated radio menus stay native.

Account-resolved entitlement fields also ride in `current_account`; they are a
server projection that a UI-only change does not recompute. Private notes carry
the detail.

### The model selector changed shape in app 1.44121.4 (read 2026-09-03)

Three facts, all established by probing the running app, all of which silently
broke the picker at once. The visible symptom was a missing tab strip; the
invisible one was that none of the routed models were in the popup at all.

- The Desktop Code surface reads catalogue section **`ccd`**, not `code`. Both
  sections are still served in `model_selector_config` and both still list the
  native models, so an injection into `code` looks correct in the cache and
  reaches nothing on screen. `page.js` extends every id in its `SURFACES` set.
- The root popup is `[role="menu"][data-cds="ModelSelector"]` and no longer
  carries a `[role="group"] > [role="presentation"]` heading reading "Models".
  The old `data-cds="Menu"` now identifies the **nested** "More models" submenu,
  which carries `data-nested` — decorating that one puts a second tab strip
  inside the submenu. Match the root by its own `data-cds` plus rows carrying
  `data-model-id`, and reject `data-nested`.
- The footer gained `renderModelSelector`, a self-contained component that
  renders from the catalogue section handed to it. `footer.modelItems` and
  `footer.modelExtraSections` are still populated and still ignored by the
  popup, so filtering them does nothing; worse, `scopeStore.setState` on the
  footer re-renders the composer and closes the open popup. Provider filtering
  therefore has to rewrite the catalogue section, which the open popup picks up
  live — rows and their `data-number-key` shortcuts renumber without closing.

Two consequences worth keeping. The server payload is the only sighting of the
untouched native list, so cache it per section on first sight and rebuild every
write from that cache rather than from the last thing you wrote. And the popup
resolves its own trigger label and effort stops out of the section it is given,
so whatever model the session is actually on must stay in the list on every tab.

### Prompt policies rewrite every agent Messages request (verified in source, 2026-08-31)

`provider-picker` stores named prompt-policy profiles and optional CLI-session
profile bindings in its normal dashboard settings. A profile may carry a
provider allowlist; selecting it resolves to `Preserve` on every provider outside
that list. `activePromptPolicyIds` holds simultaneous provider defaults, while
`activePromptPolicyId` remains the unscoped fallback. The router reads settings
at request start for requests carrying a non-empty tool surface, which is the
positive wire signature of a Claude Code agent request. A session binding
overrides the selected default on every such request for that CLI session;
changing either selection or profile generation therefore affects the next
agent count or inference request, including an existing provider conversation.
There is no conversation pin. The retired `prompt-policy-pins-v1.json` state is
ignored.

`prompt-policy-capture-v2.json` keeps the latest pre-policy and effective system
and tool surfaces for each routed provider session. The top-level `system` and
`tools` fields are the incoming editable surface after non-Anthropic provider
identity cleanup; `effectiveSystem` and `effectiveTools` show exactly what the
selected policy produced. Keeping both prevents a replacement policy from
erasing the source prompt the `prompt-policy` skill needs to revise. Tool-less
control-plane calls such as auto-mode security classification and idle-state
classification bypass both policy application and capture even when they share
the agent's CLI session ID. The prompt helper also defaults lookup to
`CLAUDE_CODE_SESSION_ID`, so a newer request from another Code session cannot
win selection. The capture never stores credentials, response content, or full
message history.

The policy layer runs before provider translation and before agent count
requests on OpenAI, adapter providers, compatible Anthropic-Messages providers, and
Anthropic itself.
The non-Anthropic routes remove the false Claude provider identity before
applying policy; Anthropic applies policy to its native body. `Preserve` keeps
Anthropic request bytes identical. A modified Anthropic body is serialized only
when a policy actually changes it.

## Auto-mode control calls inherit the active provider route (verified 2026-09-22)

Claude Code 2.1.260 sends the permission classifier through the ordinary
`POST /v1/messages` endpoint. It is a unary control-plane call: `tools` is empty,
`stream` is omitted, the system prompt identifies a security monitor, and its
body names Claude Code's independent helper model rather than the conversation's
selected model. Routing solely on that body model therefore sent a GPT session's
classifier to Anthropic, where the custom-base-url credential received 403.

The router remembers the last tool-bearing alternate model per
`(x-claude-code-session-id, x-claude-code-agent-id)` and substitutes it only for
that security-monitor shape. A subagent without its own agent key cannot replace
the root route, and a normal native-Claude turn clears the remembered alternate.
The call still bypasses prompt policy and capture.

Omitted `stream` means non-streaming in Anthropic Messages. The alternate routes
previously treated every value except explicit `false` as streaming, so even the
correctly inherited classifier received SSE. Claude Code's unary side-query path
then tried to read `response.usage.input_tokens` from the stream object and failed
with `TypeError: undefined is not an object`. Every router arm now streams only
when `body.stream === true`; an omitted value returns one JSON Message with usage.
A live `mcp__Claude_Browser__preview_start` passed through router generation 44
after both corrections.

System and tool-description transforms create a deliberate new OpenAI
prompt-cache namespace using the current profile ID/generation. User
prefix/suffix text is inserted only around the latest direct user-text turn,
after prior history. `X-Cuimod-Prompt-Policy-Id` and
`X-Cuimod-Prompt-Policy-Generation` response headers expose the applied
non-sensitive identity on every Messages route. Cache reads remain measured
only by upstream usage; the router makes no cache-hit prediction.

## ASAR integrity — the thing that bricks the app

**Electron DOES validate asar integrity on this build.** The earlier assumption
that a missing fuse sentinel meant validation was off was WRONG: `claude.exe`
contains no `dL7pKrgP.electron.fuses.1.` sentinel, yet validation is active.

Failure signature, written to stderr only (no log file, no crash dump):

```
FATAL:electron\shell\common\asar\asar_util.cc:144
Integrity check failed for asar archive (<actual> vs <expected>)
```

The expected value lives in `claude.exe` as plaintext, **exactly once**:

```
...resources\\app.asar","alg":"SHA256","value":"<64 lowercase hex>"}]PADDINGXPADDI
```

The hashed input is **the header JSON bytes only** — `sha256(JSON.stringify(header))`,
not the pickle, not the padded string, not any length prefix. Confirmed by brute
force over every plausible range.

Fix: after rewriting the archive, overwrite that 64-char field with the new
header hash. Length-preserving, so no PE relocation is involved.
`lib/asar.js repointExeIntegrity()` does it; `claude.exe.cuimod-backup` holds the
original. `patch.js revert` restores exe and asar.

## The asar rewrite technique

Naive repacking inlines the `app.asar.unpacked` entries and breaks native module
loading. Instead: append the new file bytes past the end of the data region and
re-point only the changed header entries. Every other entry keeps its original
offset, so all 6 `unpacked` flags and every other per-file integrity block stay
byte-identical.

Verified: 432 untouched entries compared byte-for-byte, 0 mismatches. Cost is a
~4.9 MB size increase (the old `index.pre.js` bytes become dead space); patching
always rebuilds from `app.asar.cuimod-backup`, so it never compounds.

Header format: `uint32 4`, `uint32 headerPickleSize`, `uint32 headerStringSize`,
`uint32 jsonLen`, JSON, zero padding to 4-byte alignment. Data region starts at
`8 + headerPickleSize`.

## Session identity — three different ids

This trips up anything that reads session state.

| id | example | where |
|---|---|---|
| desktop session id | `local_1f2e3d4c-5b6a-4789-9abc-0123456789ab` | URL `/epitaxy/local_<uuid>`, `LocalSessions` IPC |
| CLI session id | `9f8e7d6c-5b4a-4321-8765-fedcba987654` | **task dir key**, transcript filename |
| bridge session id | `session_01KzFdde...` | API-side |

Mapping lives in the desktop's own session json:

```
%APPDATA%\Claude\claude-code-sessions\<account>\<workspace>\local_<uuid>.json
  { "sessionId": "local_…", "cliSessionId": "<task dir key>", "cwd": …,
    "title": …, "model": …, "effort": …, "permissionMode": … }
```

## Task store

Authoritative, on disk, live:

```
~/.claude/tasks/<cliSessionId>/<taskId>.json
```

One file per task, exactly the `TaskCreate`/`TaskUpdate` schema:
`id, subject, description, activeForm, status, owner, blocks, blockedBy, metadata`.
Status is `pending | in_progress | completed`; `deleted` removes the file.

`fs.watch(tasksRoot, {recursive:true})` gives live updates. Files can be read
mid-write — always wrap `JSON.parse` in try/catch and skip failures.

## The eipc IPC surface

Channels are literal strings of the form:

```
$eipc_message$_<build-uuid>_$_<namespace>_$_<Interface>_$_<method>
```

The build uuid changes per build, so **never hardcode it** — `patch.js` lifts the
prefix out of the shipped `mainView.js` and bakes it in as `EIPC_PREFIX`, and hot
code composes channels with `boot.eipc(ns, iface, method)`.

Namespaces include `claude.web` (Account, Auth, ClaudeCode, LocalSessions,
LocalAgentModeSessions, SessionPopouts, FileSystem, GitState, CoworkSpaces,
CCDScheduledTasks, …), `claude.settings`, `claude.buddy`, `claude.skills`,
`claude.hybrid`, `claude.officeAddin`, `claude.simulator`.

`LocalSessions` alone exposes ~200 methods (`getAll`, `sendMessage`, `stop`,
`readCliTranscript`, `getGitDiff`, `runBashCommand`, `rewind`, …).
`LocalSessions_$_onEvent` is a plain `ipcRenderer.on` broadcast, so adding a
listener is invisible to the app.

Only a narrow set is contextBridged to the page (`claudeAppBindings`,
`claudeAppSettings`, `electronWindowControl`, `electronIntl`, `process`, …) — the
big surface is preload-only, which is why the mod injects into the preload's
isolated world and never contextBridges its own RPC.

## Why live injection into a running app is impossible here

Do not retry these; all were tested and failed.

- **`process._debugProcess(pid)`** — works on plain `node.exe` (proven by
  `live-inject.js selftest`) but fails ENOENT on the Electron main process. A
  packaged Electron never starts the Windows debug-signal handler thread, so the
  `node-debug-handler-<pid>` event does not exist to signal. Attaching requires
  the app to have been launched with `--inspect`.
- **No debug port is open** by default (checked 9220–9240 and every Claude PID).
- **DevTools** is gated behind a dev flag: `Ctrl+Alt+I`, only when an internal
  predicate is true.
- **A localhost data bridge** is blocked by claude.ai's own `connect-src` CSP.
- **Native thread injection** is declined by policy, not capability: the main
  process owns the stdio pipes of every running CLI agent, so a crash there
  destroys exactly the long-running work being protected.

`live-inject.js` and `src/runtime/live-driver.js` remain in the repo and are
correct for an instance started with `--inspect`; against a normal packaged app
they fail loudly with this explanation.

## Process model — why restarts hurt

CLI agents are spawned by the Electron main process with
`stdio: ['pipe','pipe','pipe']`, `windowsHide: true`, **not detached**. Quitting
the UI breaks their pipes and interrupts any in-flight turn. Task files and
transcripts persist; a mid-run turn does not.

Consequences:

- `app.asar` of the **running** version cannot be replaced (EPERM/EBUSY, it is
  memory-mapped). A **non-running** version dir patches fine while the app runs —
  that is how the update watcher works.
- `open(file,'r+')` **succeeds** on the mapped asar, so it is useless as a
  liveness probe. Only the delete/replace fails. Detect the app by process path
  matching `*\AnthropicClaude\app-*`, not by image name (`claude.exe` is also
  every CLI agent).

## CSS theming

claude.ai defines HSL-triple variables consumed as `hsl(var(--bg-100))`:
`--bg-000..500`, `--text-000..500`, `--border-100..400`, `--accent-*`,
`--danger-*`, `--success-*`, `--oncolor-*`. Using them makes injected UI follow
light/dark automatically.

Inject styles via a **constructable stylesheet** on a shadow root
(`shadow.adoptedStyleSheets = [sheet]`), which is not subject to the page's
`style-src` CSP, with a `<style>` element as fallback.

## Theme tokens: the border ramp is not a border colour

Measured in the running app, dark theme:

```
--border-100..400  52.5 11.7647% 86.6667%   all four identical, near-white
--bg-000 60 1.5873% 12.3529%   --bg-100 0 0% 8.2353%
--bg-200 0 0% 6.6667%          --bg-300 0 0% 5.098%
--text-100 60 14.2857% 97.2549%   --text-400 48 4.5872% 57.2549%
```

`hsl(var(--border-300))` therefore paints `rgb(225,224,217)` — a solid white
outline — in dark mode. The app never uses that ramp raw; its own chrome
(`.dframe-sidebar`) draws edges as `color(srgb 1 1 1 / 0.1)`.

Derive edges from the text colour instead. It flips with the theme by itself and
does not depend on `color-scheme` inheriting into the shadow tree:

```css
border: 1px solid color-mix(in srgb, hsl(var(--text-100)) 12%, transparent);
```

`:host { all: initial }` does not shield you from the page here — token
variables and `scrollbar-color` still inherit into the shadow tree.

## Scrollbars: ::-webkit-scrollbar is inert unless you reset scrollbar-color

claude.ai sets `scrollbar-color`, which is inherited and reaches into shadow
trees. Chromium switches to standard scrollbar rendering whenever that computes
to anything but `auto`, and silently drops every `::-webkit-scrollbar` rule.
Measured on a 200x100 scroller inside the mod's own shadow root:

```
plain                                   15 px
::-webkit-scrollbar { width: 3px }      15 px   <- rule ignored
scrollbar-width: thin                   10 px
scrollbar-width: none                    0 px
scrollbar-color: auto + the 3px rule     3 px   <- pseudo-elements live again
```

So: put `scrollbar-color: auto` on the scroller, then style the pseudo-elements.
`scrollbar-width` is the wrong lever — it is the thing that disables them.

## Hidden windows freeze more than you expect

With `document.visibilityState === 'hidden'` (minimised or fully occluded):

- **`requestAnimationFrame` never fires.** Anything that positions or reveals UI
  from a rAF callback stays in its pre-frame state indefinitely — including
  elements parked at `opacity: 0` waiting for a frame to fade them in.
- `setInterval` / `setTimeout` clamp to roughly 1 Hz. Timed sequences still run,
  but drift badly, and sub-second staging cannot be observed.
- CSS transitions do not tick.
- `getBoundingClientRect()`, `getComputedStyle()` and `Element.getAnimations()`
  keep working, so geometry and transition *keyframes* remain measurable even
  though frame-by-frame motion does not.

Rules that follow: drive periodic layout from an interval that calls the work
directly, never through an rAF coalescer; flush style with a forced reflow
(`el.getBoundingClientRect()`) instead of waiting a frame; re-place on
`visibilitychange`, since geometry computed while hidden goes stale against a
changed `innerHeight`.

## Which session is on screen

- The **URL is the only authority**: `/epitaxy/local_<uuid>`. A view with no id
  in its path — the new-session view — genuinely has no session and must resolve
  to null. Guessing from the most recently modified task dir shows an unrelated
  chat's work.
- Navigation is `pushState` and **fires no event**. Poll `location.pathname`
  (500 ms is plenty) and also listen for `popstate`.
- `LocalSessions_$_setFocusedSession` fires on every flip. `args[0]` is the
  string `"local_<uuid>"`, or `null`. Match a UUID *inside* the string — an
  anchored `^uuid$` test drops every id the app actually emits.
- `LocalSessions_$_onEvent` fires for background sessions too. It is a hint that
  something moved, never an answer to which session is displayed.
- A session's task directory is created lazily, on its first task, so a valid
  session id with no directory is normal. `shell.openPath()` on a missing path
  resolves to an error string and opens nothing — which reads as a dead button.
  `mkdirSync(dir, {recursive:true})` first, and check the resolved value.

A new-chat composer with no id cannot inherit the last focused session as a
fallback. The app announces that state immediately with
`LocalSessions.setFocusedSession(null)`; the URL poll catches the same transition
later. Code that needs to act there must bind the exact `WebContents` plus a
per-view generation token. A direct first send has to go through that view's own
TipTap composer and native send control so the renderer creates the session with
its selected cwd, model and permission state. Once the URL gains `local_<uuid>`,
the normal manager-owned path takes over. Re-ranking existing session bindings
for a sessionless target sends the prompt into an unrelated chat.

The per-view token belongs to the isolated document's effective pathname and
Desktop-session transition, not to one execution of renderer plugin code or one
TipTap DOM node. Bridge hot reload disposes and evaluates every renderer plugin
while leaving the page alive, and React may remount either of the page's two
editors without changing the target. Keep the token in isolated-world global
state across plugin evaluations, ignore query-string and duplicate-null churn,
and rotate it only when the pathname or effective Desktop session changes. The
main process must still require the exact `(WebContents, view token)` pair.

## Layout anchors in the shell

- Sidebar: `.dframe-sidebar`, left-anchored, full height (420 px wide here).
- Composer: the bottom-most visible `[contenteditable="true"]`; climb to the
  nearest ancestor with `border-radius >= 8px` to get its visual box.
- That box **grows upward** as a prompt wraps — its bottom edge is stable, its
  height is not. UI sized to match the input needs the empty-composer height
  (track the running minimum, reset on resize), not the live one.

## Pinning a height before a tween

Generic CSS, but it cost real debugging here. Reading a target height commits it
as the element's computed height. If the height transition is already in the
after-change style when you then write the *old* height, the browser starts a
transition toward the old value, and your next write retargets it back — total
travel, nothing. It looks exactly like "the animation snaps".

```js
const to = el.getBoundingClientRect().height;   // commits `to`
el.style.transition = 'none';
el.style.height = from + 'px';
el.getBoundingClientRect();                     // commit `from`, nothing animating
el.style.transition = 'height 140ms ease';
el.style.height = to + 'px';                    // one clean from -> to
```

`Element.getAnimations()` is how you verify it without watching: the running
transition reports `transitionProperty`, its duration, and
`effect.getKeyframes()` — which must show the real endpoints, not two values a
pixel apart.

## Reaching claude.ai's own React state (transcript mode, and anything like it)

The app's UI state lives in zustand stores held in module scope and passed down
through React context. None of it is on `window`, and the preload's isolated
world can see neither page-world objects nor the `__reactFiber$` expandos on DOM
nodes — Chromium keeps expandos per-world. So a renderer plugin cannot touch it.

`webContents.executeJavaScript` from the **main process** evaluates in the page's
own world, and plugin `main.js` handlers receive the ipc event, so
`event.sender.executeJavaScript(src, false)` is the whole mechanism. The renderer
half just calls the method. Nothing is contextBridged, so claude.ai's own JS
still cannot reach the mod.

Finding a store from there: take a deep DOM node
(`[data-epitaxy-transcript-region]`, `.epitaxy-root`), read its `__reactFiber$`
expando, and walk `f.return` upward checking `memoizedProps.value` for something
with `getState`/`setState`. The context provider is a few dozen hops up. If no
anchor matches, sweep the fiber tree from the `__reactContainer$` expando on a
`body > *` element instead — that also finds every store when panes are tiled.

Transcript mode specifics (verified against app-1.26832.0):

- modes are `["normal","thinking","verbose","summary"]`, default `"normal"`
- `getState().setTranscriptMode(m)`; Ctrl+O cycles it, skipping modes the session
  does not offer
- it is per session: `reset(sid)` snapshots the outgoing session's mode into
  `transcriptModeBySession` and restores `map[sid] ?? "normal"` for the incoming
  one, so seeding `localStorage['epitaxy.sidePaneStore.v1']` only takes effect at
  page load and cannot serve as a default
- `store.getState().currentSessionId` is the *desktop* id (`local_<uuid>`), not
  the `cliSessionId` the task store uses
- `performance.timeOrigin` is a free per-page-load token: key any "already did
  this" set on it and a reload resets the set exactly when the store resets

## Transcript message time (2026-09-28, pinned release index-Cuw5J4F9.js)

The transcript builder merges background `task_event`s into an assistant entry and
rewrites `entry.timestamp` to the event time; a previous message can therefore
jump to “just now.” The native `time[data-cds="RelativeTime"]` uses that entry
time. The `message-time` plugin reads the row's page-world assistant fiber
`entry.lastAssistantUuid` and resolves only `type: "assistant"` records in the
CLI session JSONL. That record's timestamp, not the merged entry timestamp or
the virtualized row index, is the message's source of truth. The renderer
reapplies the pinned release's RelativeTime formatter after React mutations.

## Thinking Markdown is inline-only (source-verified 2026-08-31)

`thinking-style` styles the shared thinking-text selector
`.text-body.text-muted.italic.whitespace-pre-wrap`, which covers both wrapped
and bare thought components. It watches that narrow surface because React
replaces its text node on each streamed update. The plugin re-applies generated
inline-only markup only when a Markdown delimiter is present. Its own mutation
is a no-op because the stored raw text matches the DOM text.

The supported syntax is inline backtick code, fenced code, strong/emphasis,
strikethrough, and explicit HTTP(S) links. Paragraphs, headings, lists, tables,
and horizontal rules deliberately remain source text. Those block rewrites broke
the app's `white-space: pre-wrap` thought layout, producing extra line breaks
and unintended rules. The setting defaults on. Ordinary Claude thinking has no
matching delimiter and remains a React-owned raw text node.

## Normal response Markdown is native (source-verified 2026-09-15)

The pinned Code frontend entry `index-Cuw5J4F9.js` loads its transcript rules from
`c19e90103-Bog01xdN.css`. Ordinary assistant text is rendered under
`.epitaxy-markdown`, whose native surface covers headings 1–6, strong/emphasis,
keyboard and inline-code chips, superscripts and footnotes, unordered/ordered/task
lists, blockquotes, horizontal rules, fenced code blocks, tables and links. Its
root reads `font-family: var(--cds-font-sans)`, `--chat-body`, and
`--chat-leading`, so `transcript-type` already gives every textual Markdown
component the configured transcript face and scale. Mono code remains deliberately
on `--cds-font-mono`.

The component passes `skipHtml: true` to its Markdown renderer. Injecting raw HTML
through an assistant text block therefore cannot add safe custom controls, and a
second Markdown parser would fight the app's streaming/component ownership. Rich
response styling belongs on the semantic DOM the app already produced.

## Where the app keeps usage numbers (verified against app-1.26832.0)

Neither number needs the app's internals. Both are on disk.

**Rate limits.** The main process samples its own utilisation into
`%APPDATA%\Claude\plan-usage-history.json` every ~4.5 minutes and keeps 30 days:

```
{ version: 2, samples: [ { t: <epoch ms>, org: <uuid>, u: { fh: 42, sd: 67 } } ] }
```

Bucket keys are abbreviated by the app itself: `fh` five_hour, `sd` seven_day,
`so` seven_day_opus, `sn` seven_day_sonnet, `oa` seven_day_oauth_apps,
`cw` seven_day_cowork, `om` seven_day_omelette, `op` omelette_promotional,
`xu` extra usage. Values are whole percents. Filter by `org` — a second account
on the same machine interleaves its samples into the same array.

Statuses elsewhere in the bundle map as `allowed → within_limit`,
`allowed_warning → approaching_limit`, `rejected → exceeded_limit`.

`resets_at` is **not** in that file, and nothing else on disk carries it. The
only source is the app's own band, so read the string off it before hiding it.

Dead ends, so they are not re-walked: the band's fibers carry presentational
props only (icon name, message, formatted reset string, no numbers); and
`app.asar` exposes no usage store over the `<name>_$store$_getState` IPC
convention (the ones it does expose are bootstrap, supportBundle,
connectedFiles, attachment, updater, navigation, managedRendererConfig,
computerUse/browser preview, sessionsBridgeStatus, interactiveAuth,
grandPrixStatus, activeServers, apiReachability).

**Live limit windows are in the React Query cache** (read 2026-08-31). A fiber
sweep for `utilization` used to find nothing; the claude.ai UI has since moved
the numbers into a query keyed
`["unified_limits_utilization", <org uuid>]`, reachable from the page world by
the same walk `provider-picker/page.js` uses — climb `.epitaxy-prompt`'s fiber
chain, take every `dependencies.firstContext` value with `getQueryCache`, then
scan `getAll()` for `state.data.limits`. The isolated world cannot see it;
`executeJavaScript` from a plugin's `main.js` is the only channel.

Its `limits[]` is what the ring popover renders, and it is strictly richer than
`plan-usage-history.json`, which on a Max 20x account records only `fh` and
`sd`. Each entry is `{ kind, group, percent, severity, resets_at, scope,
is_active }` with `kind` one of `session`, `weekly_all`, `weekly_scoped`; a
scoped window names its model only as `scope.model.display_name` (`"Fable"`),
never as an id, and there is no bucket key to join it back to the history file.
The same payload still carries the flat `five_hour` / `seven_day` /
`seven_day_opus` / `seven_day_sonnet` / `seven_day_omelette` / `cinder_cove` /
`tangelo` / `amber_ladder` / `nimbus_quill` / `juniper_tide` fields, mostly
null.

The app filters those windows by model **family** — lowercased
`scope.model.display_name` must contain the family, and an unscoped window
always applies — but it applies that filter only to the ring's peak, never to
the popover list. That is why a fresh chat on Opus shows a `Weekly · Fable` row:
the account has no `seven_day_opus` window at all, and the popover prints every
window it is given.

**The composer's selected model is not the session's model.** `LocalSessions.
getContextUsage` names the model of turns already taken, so it is `null` in a
chat that has never sent one. The selection lives in the same page-world
`scopeStore` the provider picker projects — `getState().footer.modelId` /
`.modelLabel` (`claude-opus-5` / `Opus 5`).

**Context.** Every assistant turn in `~/.claude/projects/<enc-cwd>/<cliSessionId>.jsonl`
carries `message.usage`. Context in play is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Skip
entries with `isSidechain: true` — a subagent's turns land in the same file and
describe the subagent's context, not the conversation's. Tail-read the file; do
not parse it whole.

## The claude.ai UI is not the ion-dist bundle (learned 2026-08-28)

`resources\ion-dist\` is the **shell's** bundle. The Code UI in the window is
served live from claude.ai — `document.scripts` in the page points at
`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/…`, and nothing under
`ion-dist` is loaded into it. That UI ships on its own cadence, so it moves
without the installed app version changing and without `app.asar` being
rewritten.

Consequence: grepping `ion-dist` proves what the *shell* contains, never what is
in the page. `.epitaxy-composer-width` is still in app-1.26832.0's local assets
and has been absent from the live DOM since roughly 2026-08-26. Read the DOM
with a probe plugin before trusting a selector; treat a bundle grep as a
starting hypothesis.

### The remote UI has its own update channel (measured 2026-09-11)

App 1.46388.4's live Code view was at `https://claude.ai/epitaxy/...` and still
running entry module `index-Cuw5J4F9.js`. In that same view, a fresh fetch of
its document returned HTML naming the newer `index-DYBktxx3.js`; the running
page stayed on its already-loaded entry. The HTML response was
`Cache-Control: private, no-store`. Both content-hashed entry modules remained
available with `Cache-Control: public,max-age=31536000,immutable,no-transform`.
The module tag was `crossorigin="anonymous"` with no SRI. There was no service
worker controller, registration, or Cache Storage entry.

A full document load therefore asks claude.ai for the current HTML and follows
whatever hashed frontend entry that response names. Holding the installed
executable and `app.asar` at one version does not hold this path: the Desktop
updater owns local shell bytes, while claude.ai deploys the Code frontend
independently. An already-loaded document did not hot-swap in this measurement;
the change becomes active on the next document load or reload.

### The Code view can be held to one frontend release

The mod can hold the Code view to a single approved frontend release. The
mechanism and its measurements are in the private notes.

## The file pane's "Couldn't find this file" is a granted-roots refusal

Source-verified in app 2.7032.0 on 2026-09-25. The pane reads through
`LocalSessions.readSessionFileWithStatus(sessionId, filePath, options?)`; the
live claude.ai UI omits `options` rather than passing `null`, which the EIPC
validator rejects. In the shell, `SessionFileAccess.resolveSessionFilePaths`
resolves the path against the session's primary folder and then
`containToGrantedRoots`, where the granted roots are `cwd`, `originCwd`,
`worktreePath`, `harnessCwd` and `additionalDirectories`. Any file outside those
comes back as `{status:"notFound"}`. The pane renders that as "Couldn't find this
file. It may have been deleted, or it lives outside the working directory". Show
in Explorer takes `resolveSessionFileForReveal`, a looser path, which is why it
finds the same file.

The status enum is `ok | notFound | tooLarge | readError`. Success is
`{status:"ok", file:{contents, absPath, fileSize, hash?, isTail?}}`.
`SESSION_FILE_MAX_BYTES` is 10 MiB. The shell includes `hash` only when the file
is inside its write roots, so a response without it is the shell's own read-only
form.

EIPC handlers are registered on each `WebContents.ipc._invokeHandlers`, not on
`ipcMain`. `file-pane-access` wraps this one handler there. The shell answers
first. Only a `notFound` for a regular file that exists on local disk is replaced,
with the same response shape and no `hash`.

A transcript file link carries only the text the model wrote. Live-probed
2026-09-26: any inline code that looks like a file renders as
`<span role="button"><span data-epitaxy-inline-code data-epitaxy-file-ref>`, and
its React `onClick` calls the pane opener with `(e.path, e.line, e.endLine)`,
where `e.path` is the backticked text with any `:line` split off. Clicking
`tools/trail/x.py` sent `readSessionFileWithStatus(sid, "tools/trail/x.py",
null)`. A backticked `simulation.cpp` therefore reaches the shell as a bare
name, with no directory anywhere in the link.

Relative paths resolve in this order: the literal path under each granted root;
the newest absolute mention in the session's CLI transcript
(`~/.claude/projects/*/<cliSessionId>.jsonl`) whose trailing segments match and
which still exists; each root's ancestors, nearest first, for links written
relative to a parent of the cwd (`server/src/x.cpp` from a
`client` session whose sibling checkout is `server`); and last, a `git ls-files` suffix
match inside the roots, shallowest first. The transcript is the right
disambiguator because the agent read, edited, listed or grepped the file by
absolute path before naming it in prose. Paths there appear as `C:\\...`
JSON-escaped, `C:/...`, and Git Bash `/c/...`. The scan runs only after the
shell has refused the link, newest first in 1 MiB chunks, one per await. Scanning
the largest transcript on disk (86 MB) in one piece stalled the main process
240–294 ms; one chunk costs 4–5 ms of synchronous work, and a full miss still
takes ~0.45 s of wall time. A 2 KiB overlap gives every mention its full left
context in some chunk, and a mention cut off at a chunk's left edge is left for
the next chunk back. A trailing `:line` suffix is dropped only
when the literal path is not a file. UNC and device paths keep the refusal, since opening
one can send NTLM credentials to a remote host. The plugin writes
`{attached, rescued, last}` to `.state/file-pane-access.json`, so a rescue can be
confirmed without touching the UI.

It replaced `external-file-viewer` (2026-09-11 to 2026-09-25), which drew its own
read-only box over the error card, and only for sibling worktrees.

## Composer suggestions are full-context hidden forks (source-verified 2026-09-21)

Desktop 1.46388.4 enables the SDK's `promptSuggestions` option behind frontend
flag `1942781881`. Claude Code 2.1.260 handles an eligible completed turn by
starting a fork labelled `prompt_suggestion`: `eX()` carries the retained
messages plus the full system, user, tool and runtime context, and `dv()` sends
that context followed by a meta user instruction requesting one 2–12-word
prediction. The fork uses the session's main-loop model and effort path, denies
any tool call, skips transcript persistence, and sets `skipCacheWrite: true`.
The existing prefix can still be a cache read; the request still consumes usage.
Compacted sessions carry their compact summary and retained tail rather than the
discarded raw history.

Generation has guards, but no small-context projection. It requires at least two
assistant messages and is suppressed for errors, plan/permission states, rate
limits, or when the preceding response's uncached input, cache creation and
output exceed 10,000 tokens. Cache-read input is deliberately absent from that
threshold, so a very large cached conversation can still produce the tiny ghost
text through another full-context request.

`prompt-suggestions-off` sets the CLI's earliest environment gate,
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`, before future workers spawn. It
also applies `{promptSuggestionEnabled:false}` through every already-running
Query's native settings channel. Both layers matter: the environment closes the
launch race, while the live patch covers workers whose environment was fixed
before the hot plugin loaded.

## Composer footer anchors

The footer row holds a left mode cluster and a logical-margin control group for
model, effort and fast mode. The free middle runs from the right edge of the last
left child to that control group's left edge. Float over it; never insert into
it.

The scope and margin class have both changed. On 2026-08-28 the footer was a
sibling of `.epitaxy-prompt` and its right group used `ml-auto`. Measured in the
live UI on 2026-09-10, the footer is now inside `.epitaxy-prompt` and the right
group uses Tailwind's logical `ms-auto`. `.epitaxy-composer-width` remains absent.
A renderer reload exposed the stale selector immediately: the usage host and its
complete context text existed, but its wrapper lost `show` because `findRow()`
found no `ml-auto` group.

Current shape (2026-09-10, 2399px-wide window):

```
div.epitaxy-prompt                                      768w   rounded composer
  div.flex.w-full.min-w-0.flex-col                      768w
    div.relative.z-0.grid                               784w   chin transition
      div.min-h-0                                       768w
        div.flex.min-h-control.items-center             768w   footer row
          div.flex.items-center.self-start              182w   mode / permission
          div.ms-auto.flex.min-w-0.items-center         188w   model / effort / fast
```

Scope footer searches to `.epitaxy-prompt`, then accept either `ml-auto` or
`ms-auto` during rollout. That landmark is also the composer's measure — the
number `.epitaxy-composer-width` used to supply to anything sizing itself against
the transcript column.

The dictation settings button is no longer the end of the left cluster:
`Bypass permissions` follows it in the same child. A voice overlay placed after
the settings button covers that label. Start after the complete left child, then
reserve the voice pill's measured width before placing the context meter. Measured
in the live 2026-09-10 shape, the resulting intervals were `1008–1048px` for
voice and `1062–1367px` for context, between native clusters ending at `1000px`
and starting at `1381px`. Voice visibility and placement happen inside its shadow
root, beyond the usage plugin's document observer, so voice emits a layout event
and usage places directly from it; waiting for the next interval leaves a visible
collision window.

Both overlays can initialize while their WebContents is hidden. Their old opacity
transitions froze at zero in that state even though `.pill.on` / `.wrap.show`
and correct geometry were present. Visibility state here is discrete; do not
transition it. With transitions removed, the same hidden view computed both
visible states at opacity 1.

The usage band is `.epitaxy-composer-aux-view.epitaxy-composer-band`, but so are
the other bands (the PR/diff row), so it cannot be selected structurally. Its
icon path changes with severity, so that is no good either. Tag it by matching
its text and setting a `data-*` attribute, then hide by attribute — React leaves
unknown attributes alone but owns `className`.

## The goal system is a Stop hook, and interrupting does not clear it

Read out of `claude.exe` (CLI 2.1.222) and checked against transcripts on disk.

`/goal <condition>` registers a **session-scoped Stop hook** of type `prompt`
and sets `activeGoal = { condition, iterations, setAt, origin, tokensAtStart }`.
Every attempt to end the turn is graded by an evaluator against the condition;
a verdict of not-met blocks the stop and work continues.

The complete set of clear paths, and nothing else clears a goal:

| path | trigger |
|---|---|
| `user_clear` | `/goal` with `clear`, `stop`, `off`, `reset`, `none` or `cancel` |
| `superseded` | a second `/goal` replaces the first |
| `resume_swap` | session resume re-derives the goal from the transcript |
| met / impossible | the evaluator satisfies or condemns the condition |
| unrecoverable | auth failure, billing, context limit, model unavailable |

**Interrupt is not one of them.** The classifier that decides whether an ended
turn should drop the goal returns null — keep it — for `aborted_streaming`,
`aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `max_turns`,
`background_requested` and `completed`. Only `blocking_limit`,
`prompt_too_long`, `rapid_refill_breaker` and a non-transient `api_error` of
kind `authentication_failed`, `account_on_hold`, `billing_error` or
`model_not_found` produce a clear.

Proof on disk, session `4754d158` in this repo's project dir: one `/goal`
sentinel at 20:52:47Z, ten `[Request interrupted by user]` entries between
22:08 and 03:53, and 43 evaluations that kept firing across every one of them
until `met:true` at 03:29:07Z. Re-typing `/goal` after an interrupt is the
`superseded` path — it resets the iteration counter for nothing.

What the desktop loses on an interrupt is its own *display* of the goal, which
it drives from `active_goal` stream events rather than from the transcript.

## Every goal evaluation is written to the transcript

The goal system's whole record lands in
`~/.claude/projects/<slug>/<cliSessionId>.jsonl` as attachments:

```
{ type:"goal_status", met:false, sentinel:true, condition }    goal armed
{ type:"goal_status", met:true,  sentinel:true, condition }    goal cleared
{ type:"goal_status", met, condition, reason,                  a check-in
  failed?, iterations?, durationMs?, tokens? }
```

`reason` is the evaluator's full written verdict, produced every single time the
model tried to stop — the only real progress signal the goal system emits, and
the app renders none of it. `iterations`, `durationMs` and `tokens` appear only
on the terminal check-in.

A user clear and an unrecoverable-error clear write the **identical** sentinel.
The only thing that separates them is the warning the CLI emits beside the error
one, `Goal cleared after an unrecoverable error (…)`. Matching that string is
safe only with a guard: any session that *discusses* the goal system writes the
same sentence into its own transcript as ordinary prose. Require the line to
carry no `message` and to be neither `type:"user"` nor `type:"assistant"`.

## A goal can be set mid-turn, as plain text

`/goal` has two definitions in the CLI. The interactive one is `local-jsx` with
`immediate: true`; the one a thin client gets is `type:"local"` with
`thinClientDispatch: "post-text"`, which means the desktop does not call an RPC
at all — it sends the literal string `/goal <condition>` as a message and the
CLI parses it out of its input queue.

That is what makes a mid-turn set possible: `LocalSessions.sendMessage` with
`priority: "next"` puts the text in the same queue. The CLI's own
`ProposeGoalTool` relies on exactly this, enqueuing
`{ mode:"prompt", value:"/goal " + condition }` from inside a running turn.

Use `next`, not `now`. Both count as a steer and neither is deferred behind
`isRunning`, but `now` aborts the in-flight turn so the message is read
immediately — see the steer section above. For arming a Stop hook, the next tool
boundary is soon enough.

Condition cap is 4000 characters. `/goal` is gated on a trusted workspace and on
hooks not being disabled (`disableAllHooks` / `allowManagedHooksOnly`).

## Mid-turn sends are steered, not queued (verified against app-1.26832.0)

Typing while a turn is running does **not** queue on this build. The composer
sends with `priority: "next"`, and `LocalSessionManager.sendMessage` treats any
priority as "steer now": the message is written straight into the CLI input
stream mid-turn. `deferredSends` — the array behind the app's own queued-message
bar — is only populated when the send carries no priority and the CLI is not
provably idle. That is why nothing ever accumulates in that bar here, and why a
plugin that wants a real queue has to intercept the key before the app sees it.

The steer primitive is `LocalSessions.promoteQueuedMessage(sessionId, uuid)`. It
splices the entry out of `deferredSends`, stamps `priority: "next"`, and calls
`enqueueCliInput` — nothing else. It never calls `query.interrupt()` and never
touches `activeBackgroundTasks`, so subagents keep running. `interrupt` is the
opposite path: it races `query.interrupt()` against a timeout and falls back to
`stopSession`.

The web app already has a "Send now" item wired to a store action of the same
name, but it is unreachable in practice: it lives in the row's ⋮ menu, only the
multi-entry expanded list renders that menu, and `onSteer` is passed only when
`canReorderQueued && !inputHeldForHost`.

Also note the queued-message bar is **renderer-local state** (`queuedDeferred` /
`queuedSteered` in the web store), not a view of main's `deferredSends`. A send
issued over IPC queues correctly in main and is delivered, but renders no row —
so you cannot manufacture one from outside the composer. That last clause is
wrong on app 2.7032.0; see the next section.

## An IPC steer must pre-register with the web store (source-verified app-2.7032.0, 2026-09-27)

A steer sent while the model streams text, with no tool running, is held by main
in `session.heldSteers` until the stream reaches a boundary: an assistant message
carrying a `tool_use`, any other CLI input write, or the backstop timer. The hold
decision comes after `sendMessage` has already pushed the user message into
`messageBuffer` and emitted `{type:"message"}` to the renderer, so the renderer
always sees the message at send time.

The web store decides where that echo goes. It enters `queuedSteered`, the
native "sends after this response" row, only when the session bucket's
`pendingQueuedSends > 0` and the message is a plain user prompt with no `origin`.
Otherwise it is appended to the transcript, above the assistant text that is
still streaming. The CLI reads it after that text, so the transcript order is
wrong until reload. The native composer avoids this by calling the store action
`noteQueuedSend(sessionId)` before every send. That action no-ops when
`pendingTurn` is null, and every turn end resets the count to 0.

The queue's `steer` does the same from main through `executeJavaScript`. The
store is created in module scope and is not on a context provider, so the
provider walk above finds nothing. It is reachable as the value a component
selected into hook state: a fiber hook whose `memoizedState` is a function named
`noteQueuedSend`. Method shorthand keeps that name through minification. In the
live page that was 6 hook cells, all holding one distinct function, out of about
19k fibers.

## A cross-session turn-end queue must drain in main

Verified against the live app 1.46388.4 on 2026-09-08.

The queue UI belongs in the renderer; its delivery clock does not. A renderer
knows only the desktop session in its URL, so selecting another session stops it
watching the old one. When Desktop is hidden or occluded, Chromium also throttles
its interval and timeout chain. The old queue put both the `isRunning` edge poll
and its post-turn delay there, which made “auto-send at turn end” conditional on
the queued session still being the visible page.

The main-process `claudeCodeSessionManager` owns every live session regardless of
which one a WebContentsView displays. Queue auto-send polls those records with
`isCliProvablyIdle(session)`, starts the configured grace period on the first idle
observation, and calls `manager.sendMessage(sessionId, text, undefined,
{ initiator: 'user' })`. It releases one head only. The new turn makes the same
session busy before another head becomes eligible.

Source-verified against app 1.46388.4 on 2026-09-09: a fresh Desktop session is
already a valid manager record while both `query` and `cliSessionId` are absent.
`sendMessage` explicitly detects that state and cold-starts it through
`startSession({...sessionToStartOptions(session), message})`; `query` is created
inside that path. Integrations may require the Desktop id and manager record
before sending, but requiring `query` or `cliSessionId` rejects the first turn
that the manager is designed to create.

Every send and its queue removal are one main-process operation. Successful
removal flushes `queue.json` synchronously so a restart cannot resurrect and
re-send an already delivered item. Renderer edits use per-item mutations rather
than whole-array saves, so an unfocused drain cannot be overwritten by stale view
state. A renewable edit hold prevents main from releasing a row currently loaded
into a composer; its lease expires if that view is destroyed before it can clean
up. Main broadcasts `queue-changed`, and every renderer reloads the authoritative
store instead of treating its local copy as ownership.

## A cross-session status message can resume an abandoned task

Measured against Desktop/CLI 1.46388.4/2.1.260 on 2026-09-13. A session had been interrupted during a browser-game
build and left idle. A later cross-session disk-status message arrived as a real
user turn. Desktop resumed the CLI process, and the model interpreted "Normal
work may continue" as authority to finish the abandoned build. It recreated the
project, started a localhost server, and opened the browser without the human
reissuing the original request.

This is the concrete consequence of the cold-start path above: a cross-session
send is not passive notification metadata. It can create a new turn and restart
a dormant session. Do not send broadcast-style status to disposable acceptance
sessions. Archive those sessions as soon as their evidence is captured, and stop
any server/browser they opened. Provider smoke tests that do not need the real UI
should run with `--print --no-session-persistence --no-chrome --tools ''` so they
cannot become resumable Desktop chats.

## The composer's corner button is Send or Stop, never both

`button[data-testid="code-prompt-send"]` exists only while the turn is idle.
Mid-turn the app unmounts it and mounts `button[data-testid="code-prompt-stop"]`
in the same slot. Anything that restyles or intercepts "the send button" has to
cover both ids, or it will be inert during exactly the window that matters. The
send button also carries `disabled` whenever the composer is empty.

## The stop control's glyph can change without the button changing

Measured against the live Code UI on 2026-09-11, still under app 1.46388.4.
The composer continues to mount the same 24px
`button[data-testid="code-prompt-stop"]` with `aria-label="Stop"`, but its current
mark is a 16px `span[data-cds="Icon"]`: private-use character U+E0EB from
`Anthropicons-Variable` at weight 533.3. The installed shared-frame icon map
names U+E0EA `Stop`, U+E0EB `StopCircle`, and U+E0EC `StopFilled`. This is a
claude.ai UI change, not a Desktop shell update.

`classic-stop` leaves the button, its paint layers, label, and event path under
the app's ownership. It zeroes only that icon-font child's text size and paints
the font's own U+E0EA `Stop` glyph on the child's `::before`, at the native 16px
box and weight, with the old `text-secondary` class's
`var(--cds-text-secondary)` colour. Keeping the replacement below the button
pseudo-element also leaves queue edit mode free to put its own `button::after`
label in the same corner.

## Claude's Spark has static and animated DOM shapes

Verified against the live app 1.46388.4 on 2026-09-10. The orange mark beside
request status is always rooted at `[data-cds="Spark"]`, but React uses two
representations: a direct 18px `<svg>` while static, and an 18px `<span>` holding
a clipped nine-frame SVG strip while animated. Code that replaces only the path
or assumes one tag loses the mark on the next status transition.

Preserve that semantic root and its measured box. A renderer plugin can hide its
children and paint a data-SVG background on the root, choosing animation from the
root tag (`SPAN` animated, `SVG` static). This leaves the transcript row's flex
geometry under React's ownership.

The sessionless greeting has two separate marks. Its direct `header` child is a
static 22px `svg[data-cds="Spark"]` beside “What’s up next…”; that remains the
compact helmet. The pixel crab is a different node immediately above the
composer's top-right edge. Expanded replacement artwork therefore floats from
`.epitaxy-prompt` geometry (`right - width`, `top - height`) with an opaque
page-coloured backing over that bounded corner. This covers the native crab
without guessing which live React node paints it. Apply this only on exact
pathname `/epitaxy`; every
`/epitaxy/local_<uuid>` page keeps ordinary Spark behaviour and no floating
scene. No session lookup or inferred focus state belongs in this decision.

The baked source watcher ignores `.svg` changes. Branding therefore watches its
own asset directory, accepts a new helmet/firefight pair only after both validate,
and then broadcasts a renderer reload. Without that plugin-owned path, an SVG
edit changes the checked-in file and its tests while the running renderer keeps
the old data image cached by the main plugin.

The idle composer control is unrelated. `button[data-testid="code-prompt-send"]
[data-cds="Icon"]` is private-use glyph U+E00F from `Anthropicons-Variable`, an
arrow entering a frame rather than a Claude brand mark. Replacing every icon-font
glyph as part of de-branding destroys ordinary action affordances; leave it
alone. The running control remains the separately mounted Stop glyph described
above.

## The composer is TipTap, and its editor instance is a page-world expando

`.epitaxy-prompt-input .tiptap` carries the editor on `el.editor` — so
`getText()`, `commands.setContent(doc, true)`, `commands.clearContent(true)` and
`commands.focus('end')` are all available, and every one of them goes through a
ProseMirror transaction and fires `onUpdate`, which is what the app listens to
for its own draft state. That is much safer than synthesising keystrokes.

Expandos are per-world, so the preload's isolated world cannot see `el.editor`;
reach it from main with `webContents.executeJavaScript`. Feed `setContent` an
explicit paragraph doc rather than a string — a string is parsed as HTML, so `<`
and `&` in a queued message would be mangled.

Two ProseMirror editors are mounted (main composer and side panel). They used to
be told apart by `.epitaxy-composer-width`; with that class gone they are told
apart by measure — the main composer spans the transcript column, the side
panel's is narrower. Both halves of the queue plugin have to use the same rule:
main.js reaches the editor instance and renderer.js decides where the rail hangs
and whether Enter belongs to us, so a disagreement means reading one editor and
writing the other.

## Composer images live outside TipTap (live-probed 2026-09-21)

An image in the attachment shelf is absent from both `editor.getText()` and
`editor.getJSON()`. The current live composer passes an attachment-staging facade
through the `.epitaxy-prompt` React fiber's `memoizedProps`, one fiber above the
host node. Capability matching found it without relying on a minified prop name:
`getImages`, `addImageFiles`, `waitForImagesReady`, `takeForSend`, and
`hasStagedAttachmentsNow`. The older pinned frontend exposes the same operations
from hook state, so consumers search both bounded surfaces.

`getImages()` returns loading/ready records. A ready record is
`{id,name,previewUrl,source,block}`, where `block` is
`{type:"image",source:{type:"base64",media_type,data}}`. A live one-pixel PNG
round trip through `addImageFiles()` produced that exact shape, including the
original filename. `takeForSend()` clears the native staging state and returns
the ready blocks separately from its file/snippet arrays.

The queue snapshots ready image blocks non-destructively, after the native wait,
and rejects the capture if the image IDs or TipTap document changed during that
wait. It persists the transport form `{base64,mimeType,filename?}` and passes it
as the third `LocalSessionManager.sendMessage` argument. Editing reconstructs
`File` objects and gives them back to `addImageFiles`, so the native shelf,
compression, limits, replacement, and removal controls remain authoritative.
`editorClear` clears both TipTap and native staging only after the durable queue
mutation succeeds. A file-only shelf is rejected instead of silently discarding
an attachment; this queue path currently owns text and images.

## Backgrounding the running tool call (verified against app-1.26832.0)

The CLI can move a running foreground tool call to the background, and the
desktop never wired it up. On the CLI bridge object:

```js
async backgroundTasks(toolUseId) {
  return (await this.request({subtype:'background_tasks', tool_use_id:toolUseId}))
           .response.backgrounded ?? true
}
```

`backgroundTasks(` occurs exactly once in the whole of `app.asar` — that
definition. No eipc method exposes it and nothing in the desktop calls it.

Reaching it uses the same path the exposed `LocalSessions.stopTask` takes:

```
LocalSessions.stopTask(sessionId, taskId)
  -> manager.stopBackgroundTask(sessionId, taskId)
  -> manager.sessions.get(sessionId).query.stopTask(taskId)
```

`query` is the bridge, and it owns `backgroundTasks`, `stopTask` and
`interrupt`. The manager is a genuine singleton:

```js
exports.claudeCodeSessionManager = new LocalSessionManager(...)
```

Its chunk filename is content-hashed per build, so find it by scanning
`require.cache` for a module whose exports carry `claudeCodeSessionManager`,
never by filename. Method and property names survive minification; only locals
are mangled. The session record carries `cliSessionId` and `cwd` directly, so
no project-slug lookup is needed to get from the desktop id to the CLI one.

Which tool is in the foreground is not tracked on the session — read it from
the CLI transcript instead: the last `tool_use` with no matching `tool_result`.

Two measured behaviours:

- A backgrounded call keeps running and reports its own completion later. It is
  moved, not killed.
- The CLI refuses to background a tool that has only just started. The same
  `tool_use_id` returned `backgrounded: false` twice and then `true` about
  three seconds in.

## Only Bash and a foreground Agent can be backgrounded (claude 2.1.245)

`background_tasks` is a registry lookup keyed on `toolUseId`, and it has
exactly two arms:

```js
function xVl(e, t) {                       // (toolUseId, taskRegistry)
    for (let [n, r] of Object.entries(t.all())) {
        if (r.toolUseId !== e) continue;
        if (Bg(r) && !r.isBackgrounded && r.shellCommand) return Wnr(n, t);
        if (Uo(r) && !r.isBackgrounded && !Age(r)) { VJ(n, t); return !0 }
        return !1;
    }
    return !1;
}
```

`Bg` is `type === 'local_bash'`, `Uo` is `type === 'local_agent'`. Its own
schema says as much: "Backgrounds in-flight foreground tasks (Bash commands and
subagents)." Every other tool owns no task, falls off the end, and answers
`backgrounded: false` — so asking about one buys a control round trip and no
effect. A `local_workflow` task is not covered either.

A foreground `Agent` **is** covered, and backgrounding it is the right move:
`VJ` sets `isBackgrounded` and resolves the agent's background signal, which is
what makes the blocked Agent tool return. The earlier note that `Agent` never
qualifies as the outstanding tool holds only for a background spawn, whose
`tool_result` lands the instant it launches.

TaskOutput is the case that motivated all of this, and it is the one that
cannot be moved. It is a poll, not a task:

```js
async function lis(e, t, n, r) {           // (taskId, getAppState, timeoutMs, abortController)
    let o = Date.now();
    while (Date.now() - o < n) {
        if (r?.signal.aborted) throw new Zn;
        let a = t().tasks?.[e];
        if (!a) return null;
        if (a.status !== "running" && a.status !== "pending") return a;
        await en(100);
    }
    return t().tasks?.[e] ?? null;
}
```

`timeout` defaults to 30s and the model may pass up to 600s. Backgrounding the
watched task does not end the wait: `VJ` only sets `isBackgrounded`, and
`status` stays `running`.

## Message priority "now" aborts the turn (claude 2.1.245)

The queue has three priorities, not one. `LocalSessions.sendMessage` already
validates all three:

```js
let l = s === `now` || s === `next` || s === `later` ? s : void 0;
```

and the CLI's headless input loop subscribes to its own command queue:

```js
y.subscribe(() => {
    if (Re && !tn() && y.getCommandsByMaxPriority("now").length > 0)
        Re.abort(rr("interrupt"));
});
```

`Re` is the in-flight turn's abort controller; `tn()` is "shutting down". So a
`now` message ends the turn wherever it stands, and `Ki` dequeues it ahead of
everything else.

This is **not** the `interrupt` control request. That one aborts *and* runs a
task sweep:

```js
if (n.request.subtype === "interrupt") { if (Re) Re.abort(...); let f = nr(d, a); cd({taskRegistry: f, ...}); ... }
```

`cd` kills every task where `status === 'running' && uUe(o) && iSt(o)` — and
`uUe` is true for a task whose `isBackgrounded` is not explicitly `false`, so
**backgrounded subagents die on an explicit interrupt**. A bare `now` skips
that sweep entirely, and a spawned agent runs its stream on the task's own
`abortController` (`override: { abortController: It }`), not the tool call's.
Its existence is the proof: if the abort alone killed those tasks, the sweep
would be redundant.

Two further asymmetries in the desktop's own send path:

- `next` can be **held by the desktop**, not just by the CLI: the hold applies
  when `priority === 'next' && !origin && initiator === 'user'` and no tool is
  running. `now` is never held.
- `now` and `next` both count as a steer (`c`), so neither is deferred behind
  `isRunning`.

## A collapsing sticky header is a scroll feedback loop (superseded)

A header that shrinks once you scroll is standard, and inside a scroll container
it fights you: `position: sticky` keeps the element in the flow, so collapsing it
removes that height from the content *above* the viewport and everything below
lurches up by the same amount.

With one threshold that is a loop. Cross it going down, the header sheds its
height, the content jumps, and around the boundary the two states trade off
against each other every few pixels. Animating the collapse makes it worse: the
height moves for the whole transition, so the transcript slides for 200ms on
every flip.

Three things together fix it, and all three are needed:

- **Two thresholds, not one.** Collapse high, expand low, with a band between
  them wider than the height the header gives up.
- **Snap the layout, animate the paint.** Padding, `max-height` and font-size
  change instantly; opacity, background and shadow still animate. It reads as a
  smooth collapse because the parts that fade are the parts you watch.
- **Correct `scrollTop` by the measured height difference** on each flip, so the
  content does not move at all. Measure the header before and after toggling the
  class in the same synchronous pass — exact only because the collapse is
  instant.

Skip the correction rather than clamping it when it would land outside the band:
a clamped correction lands on the far threshold and flips straight back, which
is the original bug. A visible jump beats a loop.

Measured on the subagents sheet: header 98px expanded, 59px collapsed, so a 39px
correction against a 120px band. Driving `scrollTop` across both thresholds
settles in one event at every position.

The subagents sheet no longer collapses its header at all — it is a fixed 98px
bar with the same controls at every scroll position, which removes the problem
rather than managing it. Kept here because the trap is general: any header that
changes height inside its own scroller has this failure, and the three-part fix
is what it takes if the collapse is worth having. Two things the collapse was
paying for have to be paid outright once the header is permanent — an opaque
background (content ghosts through a gradient-to-transparent one) and a
permanent hairline (nothing else separates the header from text moving under
it).

## Never schedule cleanup in requestAnimationFrame

An exit animation whose DOM removal is scheduled inside a `requestAnimationFrame`
callback never completes in a backgrounded window: rAF is throttled to nothing
there, so the node stays in the tree with its exit class on it forever. The queue
rail hit this exactly — removed rows sat in the DOM across six consecutive probe
samples, and because they were still `position: absolute` with a live handler,
the state and the display disagreed.

`animationend` is no better on its own: a hidden window may not advance the
animation at all, so the event never fires either. The timer is the contract:

    node.addEventListener('animationend', go, { once: true });
    const t = setTimeout(go, duration + slack);   // this is the one that lands

Timers are clamped in background windows, but they *do* fire. The same rule
applies to the rail's own leave and to toast dismissal.

## An animating-out row must leave the flow, pinned where it is

Two separate defects came from letting a row that is animating out stay in the
layout flow. It keeps shifting `insertBefore` indices for every row after it, so
the model's order and the rendered ordinals drift apart; and it stays clickable,
so a stale trash button deletes a live item — one confirm removing two entries.

Measure `offsetTop` first, then take it out of the flow at that exact offset, so
it animates out in place rather than jumping to the container's origin:

    const top = row.offsetTop;
    row.classList.add('going');
    row.style.position = 'absolute';
    row.style.top = top + 'px';

with `position: relative` on the rows container. Any belt-and-braces prune of
"children the model does not know about" must then exempt rows on their way out.

## A deferred teardown needs a generation token

Animating a container out and calling `teardown()` when the animation ends is a
race as soon as the container can come back: the queue refills, `build()` sees a
still-connected host and revives it, and the pending teardown fires afterwards
and removes the *new* content. Bump a counter on revive and have the deferred
callback bail unless it still owns the current generation — and cancel the exit
animation and drop its class, or the revived element stays faded.

## A floating host needs its own dedupe

Any plugin that appends a positioned host to the page must remove strays with
its own id on every tick, exactly as the task rail does. A generation that fails
to dispose leaves its host behind with its JS gone: it freezes with stale numbers
at a stale position, and `getElementById` hands *it* to anything looking the host
up — so measurements come back describing a corpse while the pixels show the
overlap. That combination reads as a CSS bug and is not one.

The half that bites is the other one: **the generation doing the removing can be
the stale one.** Two generations overlap during a hot reload, and the dashboard
applies specs asynchronously — every `apply()` is held until `dashboard.load`
resolves, and `onRegistryChange` returns early while `loaded` is false. So the
newer generation can mount its host first, the older generation's `apply` lands
afterwards, removes that host as a stranger, and then returns early because its
own `host` is still truthy.

That variable now points at a detached node, and the failure is permanent: the
DOM has no host, `host` is non-null, and every later `apply()` short-circuits on
`if (host) return`. `apply()` reports success the whole time and nothing is
logged, because `applySpec` swallows throws and there is no throw.

    if (host && !host.isConnected) { host = null; /* and every cached child */ }
    for (const n of document.querySelectorAll('#' + HOST_ID)) if (n !== host) n.remove();
    if (host) return;

A detached host is no host. The goal band vanished exactly this way — measured
with `apply()` returning cleanly and `querySelectorAll('#cuimod-goal').length`
at 0 both before and after the call. `context-pill`, `usage-bar` and `queue` all
carry the same dedupe shape and the same latent fault.

## The prompt box is not the top of the composer

Aux rows stack **above** `.epitaxy-prompt` inside the same container, so a band
anchored to the prompt's top edge lands on top of one of them. Measured at a
1040px-tall window:

```
.epitaxy-branch-row.epitaxy-composer-aux-view   top 907   bottom 947
.epitaxy-prompt                                 top 953   bottom 997
a 27px band hung off the prompt's top           top 918   bottom 945
```

Entirely inside the branch row. The queue rail has the same anchor and lands
there too.

Find them by geometry, never by class: the usage band is `display: none` with a
zero rect when it is not up, `.epitaxy-branch-row` is claude.ai's own name on
claude.ai's own cadence, and a row added tomorrow has no name here at all. What
identifies one is that it is a sibling of the prompt, has a real box, sits above
the prompt, and overlaps its column.

## The max context window, without a model table

Accuracy update (Desktop 1.26832.0 / CLI 2.1.222): the CLI context analyzer uses
the latest nonzero `apiUsage.input_tokens + cache_read_input_tokens +
cache_creation_input_tokens` as `totalTokens`. That is measured input for the
last model call, not cumulative usage and not input plus output. Without that
sample, the analyzer totals estimated categories. Both mod displays now use
this provenance to label the count. A live adapter-provider sample verified
19,916 uncached + 20,586 cached = 40,502 context tokens; its 88 output tokens
were not added. There is no separate ledger or transcript-based override.

Preflight `/count_tokens` now uses native Google tokenization through the verified
gateway. Live inference cross-checking exposed a native API trap: it accepted
`systemInstruction` and `tools` but counted only `contents` (13 versus 399 actual
input tokens). The count-only adapter includes all transformed system/tool text
in contents and labels the result a full-input estimate, since private model
framing is still not exposed. Inference formatting is unchanged. Old partial-count
gateways are rejected instead of silently under-reporting prompt size.
The same live fixture then counted 397 tokens against 399 actual input tokens.
The public OpenAI API documents `/responses/input_tokens`, but the
ChatGPT subscription endpoint returned 403 to a small metadata-only probe.
Its local fallback uses `o200k_base` over the translated provider request and
the documented image patch-sizing rules, not characters divided by four.
Tokenizer setup is lazy and never runs on the response-streaming path.

References: [OpenAI input counts](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count),
[image sizing](https://developers.openai.com/api/docs/guides/images-vision#model-sizing-behavior).

`LocalSessions.getContextUsage(<local_uuid>)` over the app's own eipc surface —
callable straight from the isolated world with `cuimod.appInvoke`. It forwards to
the CLI as `subtype: "get_context_usage"`, so the CLI answers for whatever model
the session currently has selected:

```
totalTokens 280552   rawMaxTokens 1000000   maxTokens 1000000   percentage 28
model "claude-opus-5"   autoCompactThreshold 967000 (absolute tokens)
isAutoCompactEnabled true   autocompactSource "auto"
categories[] {name, tokens, color}   messageBreakdown{}   apiUsage{}
```

`rawMaxTokens` is the maximum. This is the same call the app's own composer ring
uses — it renders `used / rawMaxTokens` and puts the result in that button's
`aria-label` ("Usage: context 68%, plan 67%"). Takes the **desktop** id
(`local_<uuid>`, straight from the URL), not the `cliSessionId`.

Nothing else is a real source. Dead ends, so they are not re-walked: `app.asar`
never contains `rawMaxTokens` (main only proxies the payload); `~/.claude/stats-cache.json`
has a `modelUsage[model].contextWindow` field that is present but always `0`; the
CLI's statusline payload does carry `context_window.remaining_percentage` and
`rate_limits.*.used_percentage`, but the desktop app never invokes the statusline
command, so that path yields nothing here.

Also: a transcript's `message.usage` cache-read totals do **not** give context in
play. They ran ~3x the CLI's own figure (849k vs 280k) on the same session.

## OpenAI account switching owns the canonical Codex auth file

Source-verified 2026-09-10 against Codex CLI 0.145.0 and the running Desktop
provider architecture. The router and Codex CLI both read `~/.codex/auth.json`,
whose refresh token rotates whenever it is used. Switching accounts therefore
cannot be a renderer preference: the selected profile has to replace that file
atomically, and a refresh and a switch have to serialize against the same
`auth.json.cuimod-lock`. The refresh path re-reads auth after acquiring the lock,
so a switch that landed while it waited wins without spending the retired
account's refresh token.

Ignored `.state/openai-accounts/` stores one complete auth snapshot per account;
`.state/openai-accounts.json` stores only the active profile hash. The renderer
RPC returns email/name, plan label and the hash used for selection. Access,
refresh and ID tokens never cross into the renderer. Adding an account launches
the installed Codex binary with an isolated temporary `CODEX_HOME`; a completed
browser login is imported, selected, and the temporary home is deleted.

The native model selector is an owned composite menu. A first account UI placed
additional focusable buttons beneath its provider strip; opening that selector
then terminated the app. Account controls now live in the provider dashboard's
existing shadow-root surface (`Insert` → `Providers & agents`), while the model
selector's proven provider-strip DOM remains byte-for-byte unchanged. Guard
`tests/provider-accounts.test.js` keeps account controls out of `decorate(menu)`.

A successful switch changes only future auth reads. A GPT request that already
read its tokens continues on the old account; the next request reads the newly
selected canonical file.

The account panel reads `https://chatgpt.com/backend-api/wham/usage` once per
stored account, sequentially, with a five-minute cache. The main-model weekly
meter is the longest window of at least six days under the top-level
`rate_limit`; `additional_rate_limits` is a separate feature-meter namespace and
is deliberately excluded. On 2026-09-10 both stored Pro accounts returned a
604,800-second top-level window, at 1% and 98% used. The only additional meter
was `GPT-5.3-Codex-Spark`, with its own five-hour and weekly windows. An expired
inactive account refreshes its own stored profile under the same auth lock
without replacing the active canonical file. Renderer RPC receives only the
usage percentage, reset timestamp, window length and observation time.

## GPT compaction is a checkpoint protocol, not a better summary prompt

Verified 2026-09-05 against Claude Code 2.1.260, openai/codex
`rust-v0.153.4`, and the live ChatGPT Codex OAuth endpoint. Codex's legacy unary
`POST /responses/compact` remains in source but returned 404 on the subscription
endpoint. The live protocol is V2 over the normal streaming `/responses` route:
append `{"type":"compaction_trigger"}` to the translated history, require exactly
one completed `{"type":"compaction","id":"cmp_...","encrypted_content":"..."}`
item, and replay that opaque item on later Responses calls.

A bounded live probe compacted under GPT-5.6-Sol and recovered the hidden marker
under both GPT-5.6-Terra and GPT-5.5. The tiny fixture's encrypted item was 1,188
bytes while OpenAI accounted it as 38 output tokens. The bytes are provider-owned
semantic state, not locally decryptable prose. Claude, Gemini and Anthropic-style
providers cannot consume it.

Claude Code still requires its compaction call to return ordinary assistant text,
and persists that result after a `system/compact_boundary` as a user record with
`isCompactSummary: true`. The router therefore returns a short random checkpoint
marker plus a portable text fallback. The full canonical state lives under
`~/.claude/gemini-bridge/compactions-v1/`, one immutable atomically-written file
per checkpoint, bound to `x-claude-code-session-id`. A later GPT request replaces
the marked summary with retained user messages plus the encrypted compaction item.
A non-OpenAI request strips only the private marker and keeps the readable fallback.
Missing, corrupt or cross-session checkpoints also degrade to that fallback.

The retained window follows Codex V2's material behavior: newest user messages are
kept under a 64,000-token budget, old assistant/tool traffic is represented by the
compaction item, and oversized boundary messages retain their beginning and end.
`/count_tokens` resolves the same checkpoint as inference, or the context meter
would count a tiny marker while the model receives a different history.

The request discriminator is the final dedicated Claude compaction instruction,
read from the 2.1.260 binary. Claude Code 2.1.245 through 2.1.260 prepend a fixed
`CRITICAL: Respond with TEXT ONLY` no-tools wrapper before that instruction, so
the discriminator accepts either the bare instruction or that exact wrapper plus
the instruction. A loose substring match would turn an ordinary quote into a
compaction. The Codex path applies only when the selected wire model is GPT and
`compaction-provider.strategy` is `codex`. Every other model and the dashboard's
`native` setting retain Claude Code's normal compaction transaction.

The plugin dashboard exposes strategy, current/fixed GPT compaction model, portable
fallback, and sanitized checkpoint metadata. Ciphertext and transcript content
never cross renderer RPC or `/compactionz`. Router accounting records the two
provider calls separately as `openai.compaction.v2` and
`openai.compaction.fallback`.

References: [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction),
[Codex V2 request](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2_attempt.rs),
[Codex V2 retention](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/compact_remote_v2.rs).

## Codex context management is a client-side loop over two server-side stores

Verified 2026-09-05 against openai/codex `51c97f3`, codex-cli 0.153.4 and the
live ChatGPT Codex OAuth endpoint on a Pro plan.

`[features.context_management] experimental_mode = true` has no behaviour of its
own. `Feature::ContextManagement` has four references in the whole tree and only
one consumer, `core/src/session/token_budget.rs:26`, which force-enables
`token_budget` and sets `use_history_notes_extension` — and only for ChatGPT auth
on Plus/Pro/Pro-Lite against `/backend-api/codex`. API-key auth, Enterprise, Free
and any custom base URL return early and the flag does nothing at all.

What the pair does is replace summarizing compaction. `run_auto_compact` and the
manual `/compact` task both divert to `compact_token_budget.rs`, which runs the
normal compaction lifecycle but calls `start_new_context_window` instead of any
summarizer: history becomes initial context plus a fresh window id, with no
summary. Continuity moves entirely into nine model-only `notes`/`history` tools,
a `<context_window>` developer message carrying the window ids, and a reminder
that fires with `reminder_threshold_tokens` left.

The tools are not local. Every call is a POST to `alpha/{notes,history}/v2/*` on
the same host and OAuth this router already uses for `/responses`, and the
endpoint serves them to any caller presenting the ordinary `codex_cli_rs`
identity — being the Codex binary is not required.

Four measured facts shaped `router/context-management.mjs`.

**Results are Fernet ciphertext.** Every tool route answers
`{"encrypted_output":"gAAAAAB..."}`, decrypted inside inference, never here. A
result is replayed verbatim as a `function_call_output` content item of type
`encrypted_content`. So the router cannot log, inspect or moderate note content,
and neither can the dashboard. `alpha/notes/v2/thread_hint` is the sole
plaintext route — it returns note paths, line counts and byte counts — which
makes it the only honest source for a status panel.

**The four write-ish parameters must declare `encrypted: true`.** Omitting it is
not a warning: the endpoint rejects the entire tool list with `Function
'history.search_contents' must declare 'encrypted: true' for the 'query'
parameter`. The model then emits ciphertext for those values, which is why
`backend.rs:68-79` sets `x-openai-encrypted-tool-arguments` purely by route.
Setting that header on genuinely plaintext arguments makes the call fail and the
failure itself comes back encrypted, so it is invisible — that was the first
implementation's bug.

**The prompts arrive at runtime, not in the source.**
`GET /backend-api/codex/models?client_version=<v>` (the `client_version` query
param is required; without it, a 400) returns `model_messages.token_budget` with
the reminder template, guidance, fallback prompt, `reminder_threshold_tokens`
6144 and `auto_compact_fallback_buffer_tokens` 16384. That response *is*
`~/.codex/models_cache.json`. Fetching it is what keeps this arm verbatim-current
when OpenAI revises the wording, so nothing pins prompt text; only the field set
is pinned, and a change to it raises drift on `/contextz`. All nine shipped
models currently carry `enabled: false`, so `apply_model_defaults` never
self-activates — the config flag is the only live activation path, and that field
flipping to `true` is upstream shipping the feature.

**Server-side history ingestion is triggered by `client_metadata` in the request
body, and only in the body.** This took a real Codex run captured through a
logging proxy to settle, and the first answer here was wrong: an early pass
concluded ingestion could not be driven from this client at all, on a negative
measurement with no positive control.

The positive control is what fixed it. A real `codex exec` session with the flag
on returned `list_windows` 228 bytes and `list_items` 9956 bytes of ciphertext,
against 164 bytes for an unknown session — so 164 really is the empty marker, and
the query method was sound.

What the proxy showed is that Codex sends the turn metadata twice. The HTTP
headers `x-codex-turn-metadata` and `x-codex-window-id` are a compatibility
projection and ingest nothing on their own. The trigger is `client_metadata` in
the JSON body, and the nested blob alone is not enough either: a `client_metadata`
carrying only `x-codex-turn-metadata` also ingests nothing. The flat siblings —
`session_id`, `thread_id`, `turn_id`, `root_turn_id`, `x-codex-installation-id`,
`x-codex-window-id` — have to be present with it.

Two details inside the blob matter. `window_id` is compound, `<session>:<n>`,
while `context_window_id` is a plain uuid; sending a bare uuid as `window_id` was
one of the reasons the first attempt read as a failure. And
`history_ingest_requested` lives only inside the blob, never as a flat key.

Ruled out along the way, each with its own run: `reasoning.context: "all_turns"`,
the internal `x-openai-internal-codex-responses-lite` mode (which additionally
demands `all_turns` and `parallel_tool_calls: false`), the `originator` value, and
latency — a four-minute poll stayed empty. Codex also prefers a WebSocket
transport for `/responses` and falls back to HTTPS; the fallback path ingests, so
the transport is not the trigger either.

Measured through the router afterwards: two turns produced `list_items` 1976
bytes, and the model recovered a codename from a later turn by searching history.
The archive is still off by default, because turning it on puts the whole
transcript on OpenAI's servers rather than only what the model chose to write.

The store is namespaced server-side by the `session_id` and `current_agent_name`
sent in the request body, both of which this router chooses. It keeps a stable
per-session `storeId`, and uses that same UUID for the Responses `session-id` and
`thread-id` headers, so notes follow the conversation across every window reset
without colliding with an identical prompt-cache key in another session.

Claude Code gives every subagent the parent's `x-claude-code-session-id`. Its
billing block says only `cc_is_subagent=true`; no stable worker identity reaches
the router. Treating that shared session as an agent identity mixed worker turns,
notes and window cuts into the root lane. Context management is therefore
root-only: detected subagent requests receive no context-window messages, tools,
ingest metadata, cuts, checkpoint restoration, or context/Codex compaction.
Every other request (workers, and roots with the context lane off) uses a
thread id derived from the Claude session id and that conversation's
`prompt_cache_key` (`07d774d`). The request-unique id used before collided with
nothing, but it also kept no cache affinity from one request to the next; see
"GPT prompt-cache affinity follows the session/thread id". Workers never send
`client_metadata`, so no backend history is shared by giving one a stable thread.
Stores created
before this isolation rule are assigned a fresh backend namespace on their next
root turn. The old namespace and every local cut derived from it are quarantined
rather than attributed to an agent that cannot be reconstructed.

`new_context` cannot reset Claude Code's own transcript, so the reset is applied
outbound instead: the Nth user message is recorded with its digest, and later
turns are sent from after it. If earlier messages shift, the unique digest can
relocate the anchor. A missing or ambiguous digest abandons the cut rather than
truncating the wrong prefix.

A Codex checkpoint carries the active window-cut identity and compacts the
already-cut input. Once Claude Code persists and replays that checkpoint, the
matching cut is retired atomically: the opaque checkpoint now owns the same
boundary and the old transcript coordinate must not be applied to its rewritten
history. This is the exact handoff the legacy summarizer lacked; after a normal
Claude compaction it left every later turn on `cut-degraded` forever.

One Anthropic message spans every round the model-only calls create.
`ResponsesToAnthropic` gained `suppressCall` and `deferFinish`: a suppressed
`function_call` opens no content block and its arguments never reach the client,
and output indices are keyed by an epoch so a second upstream response cannot
collide with the first. The terminal usage sent to Claude Code is the final
upstream response's current-context snapshot. Summing every hidden round there
made the client treat separately billed prefix reads as simultaneous context and
prematurely declare a 1M window full. Each round remains an exact separate record
in router accounting; the throughput sample settles only on the final round,
because `complete()` is guarded by `settled` and the first call would otherwise
measure the first leg.

**The tool specs are reserved and validated, so they cannot be edited.** An
earlier pass shipped them with the concealment sentences stripped and with the
`minimum` keywords the Rust `json!` schemas carry. gpt-5.6-luna accepted that
copy, which is why it survived a full live verification; gpt-6-astra rejected the
whole request:

    Invalid Value: 'tools'. Function 'history.list_windows' is reserved for use
    by this model and must match the configured schema.

Enforcement is per model, so "it worked on the model I tested" proves nothing
here. The wire form is also not the source form — `parse_tool_input_schema` drops
`minimum`, and properties arrive sorted — so the specs are now a byte-for-byte
copy of a real `codex exec` request captured through a logging proxy, checked in
at `tests/fixtures/codex-context-tools.json` with a test asserting the two never
drift. `get_context_remaining` is gone with it: `spec_plan.rs` registers it, but
the captured request does not carry it.

Concealment is therefore stripped only where this mod owns the text. The fetched
`guidance_message` and `reminder_message_template` are developer messages, not
validated, and they lose upstream's secrecy sentences and gain an explicit
permission saying the person running the session may be told about the notes.
Measured: with the reserved descriptions still carrying "never disclose ... to
the user", asking the model what it is keeping returns the note path and its
contents. The developer message wins.

**The token budget is the half that silently did nothing.** `estimateOpenAIInput`
is async; calling it without awaiting subtracted a promise, so `remaining` was
`NaN`, every comparison against it was false, and the reminder could never fire.
129 routed turns logged `remaining=NaN` before anyone looked, because a lane with
the tools attached still behaves normally without the reminder.

The provider ceiling comes from the models list, and from the right field. The
endpoint reports two: `context_window` 272000 is the default a plain Codex
session starts at and that its own `model_context_window` config routinely
overrides, while `max_context_window` 872000 is the model's actual ceiling —
measured 2026-09-05 for astra, reserve, sol, terra and luna; 5.5, 5.4-mini and
codex-spark report the same value for both. This arm runs these models at their
ceiling, scaled by `effective_context_window_percent`, a field the endpoint
never sends and the client defaults to 95 (`openai_models.rs:383`,
`usable_context_window` at :504). That is 828400 for a 1M-class model.

That ceiling is only one side of the budget. Codex's
`context_window_token_status()` takes the minimum of the full provider window
and the configured auto-compact scope. The first port omitted the scope, so a
Claude Code worker configured for 400k could compact hundreds of thousands of
tokens before the router's 828400-based reminder became eligible.

Claude Code 2.1.260 reports the exact conversion from a configured raw window to
its trigger: 400000/367000, 500000/467000 and 1000000/967000. The reserve is a
fixed 33000. The router now resolves the same global, per-model and per-session
policy as the spawn wrapper. Its forced boundary is the earlier of that trigger
and the full provider window; its base boundary is 16384 tokens earlier. The
normal reminder fires 6144 tokens before the base boundary, the fallback prompt
fires at the base boundary, and a still-unreset session is cut before its latest
user turn at the forced boundary. This reproduces Codex's
`InitialContextInjection::BeforeLastUserMessage` instead of dropping the request
that crossed the line.

Manual or automatic Claude Code compaction is the second route to the forced
boundary. With context-window reset enabled, the router rotates the window
locally and returns an opaque `cuimod:context-reset` acknowledgement without any
provider inference. Claude Code persists that as its synthetic compaction
message; count and inference strip the matching marker, and inference then
atomically retires the old cut. The count route also applies ordinary model and
forced cuts without retiring them, so Claude Code measures the same clean
window the next inference receives instead of immediately compacting the retired
prefix. A retry reuses the pending reset id, so a lost response cannot rotate
twice. Other providers drop the private marker entirely. Codex V2 opaque
checkpoint compaction remains the GPT path when context-window reset is
disabled.

The `client_version` the router advertises is load-bearing for this. The backend
answers a different catalogue per version: on 2026-09-22 the authenticated model
endpoint returned neither `gpt-6-sol` nor `gpt-6-luna` for 0.153.4, then returned
both for 0.155.0. The latter catalogue names priorities 2/3, medium defaults,
`low/medium/high/xhigh/max` reasoning for both, and an additional `ultra`
workflow tier for Sol. `ultra` stays out of the router's reasoning list because
it selects Codex multi-agent execution rather than model reasoning depth. The
shared user agent now advertises 0.155.0 so context management resolves the same
catalogue as routing.

OpenAI's launch pages publish exact raw limits and API rates for both new slugs:
1,050,000 context tokens, 128,000 maximum output tokens, and a 272,000-input
long-context threshold. Standard per-million rates are $2/$0.20/$2.50/$10 for
Sol and $0.10/$0.01/$0.125/$0.50 for Luna (input/cache read/cache write/output).
Above the threshold, input and cache rates double and output is 1.5x for the
whole request. The accounting ledger stores no per-response long-context price
bracket, so its standard-rate calculation remains a documented floor there.

Both exact routes were then live-probed through the official subscription
Responses arm on port 8789 with `store:false`, low effort, and no tools. Sol and
Luna each returned HTTP 200, the requested model alias, a visible sentinel, and
terminal `end_turn`; neither request touched a browser-relay provider.

Owner decision on 2026-09-22: GPT-5.6 Sol, Terra and Luna are retired from the
picker. Their router records remain for existing sessions, historical accounting
and explicit old aliases, but no new picker selection advertises them. Installed
Sol agent profiles move to GPT-6 Sol; Luna profiles move to GPT-6 Luna; Terra
agent definitions are removed and their scheduler fallbacks use Luna review or
Sol implementation profiles. Astra and the browser-relay providers keep their own models.

References: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[launch announcement](https://openai.com/index/introducing-gpt-6-sol-and-luna/).

GPT-6.1 Sol (`gpt-6.1-sol`) repeated the pattern on 2026-09-29: the models
endpoint omits it at client 0.158.0 and returns it at 0.159.0, and every older
entry is byte-identical across 0.155.0, 0.158.0 and 0.159.0, so the router now
advertises 0.159.0. The entry matches GPT-6 Sol's efforts, window and cache
profile, but defaults to `low` reasoning, carries priority 1 and a
`multi_agent_reasoning_effort` of `xhigh`. Its official page gives 1,050,000
context, 128,000 output and $2/$0.10/$2.50/$10 per million, half GPT-6 Sol's
cached-input rate. A low-effort, tool-free request through port 8789 returned the
sentinel with `end_turn`. It sits in the picker beside the 5.6 choices; the
2026-09-27 preference for 5.6 over GPT-6 Sol/Luna is unchanged.
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

The status card had two independent reporting bugs. It counted only notes and
history calls, so `new_context` rotations still displayed as "none yet". The
counters also lived in a worker-generation map and vanished on every blue-green
swap while the durable window count survived. Activity now lives beside the
window state and separates automatic thread-hint probes, model calls, note and
history calls, and model/forced/compaction reset causes. The latest plaintext
thread hint is retained so the card can show note paths and sizes; no arguments,
encrypted results, prompts or note contents enter that state.

References:
[feature definition](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/features/src/feature_configs.rs),
[activation gate](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/core/src/session/token_budget.rs),
[history-notes extension](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/ext/history-notes/src/tools.rs),
[window reset](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/core/src/compact_token_budget.rs).

## Every asynchronous context transition needs an owner

Source-verified 2026-09-08. Compaction, context-window reset, hidden
model-only rounds and renderer status refreshes used to behave as independent
callbacks. They are one transaction from the user's point of view, and each
boundary now carries enough ownership to refuse late work.

A remote compaction stream owns its first terminal event. Output after that
terminal is a protocol failure, and a successful checkpoint must contain exactly
one non-empty encrypted compaction item. An empty or malformed successful
response fails closed with 502; only an explicit upstream 400 or 404 may return
to Claude Code's native summary path. A disconnected client cancels the two
provider legs and cannot leave a checkpoint record behind.

A `cuimod:context-reset` marker is a retry token, not an acknowledgement.
Stripping it from a request prepares the clean window but does not retire the
durable reset. The router acknowledges it only after a terminal response has
reached the success path, remembers the last acknowledged id for an identical
client replay, and leaves it pending across quota or transport failure. The cut
also remains authoritative if context-tool injection is toggled off before a
replacement Codex checkpoint is made. User-turn cut identities hash the complete
translated content, so image-only turns and identical captions with different
images cannot authorize the same boundary.

One Anthropic message may span several hidden Responses calls. Hidden round
terminals close only their upstream call; they are removed from the client event
set while the final visible terminal owns the translated message. Accounting
still records every upstream response separately. The throughput sample stays
open for the complete turn but clears its cumulative token curve before the next
response, because each response starts its own usage total; completion settles
on the visible terminal. A failed continuation returns its real upstream status
rather than manufacturing a partial success.

The two status panels apply the same rule in the renderer. Every RPC refresh is
bound to its session id and a local generation. A session change or plugin
disposal invalidates the owner and clears the visible body before starting the
next read; a refresh requested during the active read is queued once. Each
renderer generation also releases its bridge session subscription on disposal,
so remounts do not accumulate detached RPC producers. A late reply therefore
cannot paint one session's checkpoint or window state into another session's
panel.

## backdrop-filter is the single most expensive thing you can put in an overlay

Measured on this machine, full-window overlay at 1490x986:

```
overlay closed              239 fps
overlay open, blur(7px)      18 fps
blur removed                211 fps
masks removed                20 fps   (i.e. free)
big box-shadows removed      19 fps   (free)
```

Chromium re-blurs the whole backdrop every frame anything behind it moves, and
the transcript behind is always moving. A flat `rgba(0,0,0,.62)` reads nearly the
same and costs nothing. Edge masks and 40-70px box-shadows are not worth
optimising — they measured as noise.

## Restyling transcript type needs seven tokens, not one

Measured against the live claude.ai stylesheet `c6a992d55-BxVGJf0O.css` on
2026-09-19. The app's font graph is now:

```
--font-ui              = var(--font-anthropic-sans)
--font-claude-response = var(--font-anthropic-serif)
--font-user-message    = var(--font-ui)
--font-sans-serif      = var(--font-ui)
--family-ui                                      <- independent
--cds-font-sans                                  <- independent
```

The first four declarations live on `:root`. The transcript inherits resolved
values for `--font-claude-response`, `--font-user-message`, and
`--font-sans-serif`, so overriding `--font-ui` below `:root` does not alter
components that directly consume those three tokens. The live stylesheet does
so in `.font-claude-response-heading`, `.font-claude-response-body-bold`, the
other response typography utilities, `.font-claude-response`, and
`.font-user-message`.

Set `--font-anthropic-sans`, `--font-ui`, `--font-claude-response`,
`--font-user-message`, `--font-sans-serif`, `--family-ui`, and
`--cds-font-sans` together, scoped to `.epitaxy-transcript-typography`. Leave
`--font-mono`, `--font-serif`, and `--font-ui-serif` alone so explicit code and
serif surfaces retain their semantic faces.

Token replacement is necessary but no longer sufficient: current Markdown
components may assign a family at the text leaf. Apply the selected face directly
to semantic transcript elements (`p`, headings, emphasis, lists, quotes, tables,
and `.text-body`) so an internal token change cannot reintroduce stock sans.

Do NOT force `font-family` on all descendants as a shortcut: the app renders some
glyphs from an icon font (PUA codepoints appear in text content), and a blanket
override turns them into tofu.

## Overlay UI details that are easy to get wrong

### Shared stacking contract

Measured against the live claude.ai page on 2026-08-31. The native model menu is
ported under `#portal-root`; its presentation node has `z-index: 120`. The
base shell occupies layers 1, 10, 11, 20, 21, and 25. The native side-chat root
uses layer 60 when it is open.

Passive mod surfaces therefore use layer 50. This includes the goal band, send
queue, usage meter, context pill and task rail. Its tooltip uses layer 51, only
to clear its rail. They can paint over the ordinary composer without winning
against a native menu, popover or side chat. A temporary layer-2147482980 marker
won `elementFromPoint` over the live model menu; that is the direct proof that
the old goal band layer was wrong.

A mod modal may own the interaction surface. The subagent detail sheet raises
its host to layer 2147483500 only while the sheet exists. The dashboard is layer
2147483600, so Insert remains the final modal authority. Return a host to layer
50 as soon as its modal closes; keeping its ambient HUD in a modal layer blocks
native controls opened later.

- **A native `<select>` and `<input type="color">` cannot be styled.** Their
  popups are drawn by the OS, outside the page entirely. Replace with real
  widgets if the look matters.
- **Popups must not be children of a scroll container.** They get clipped by its
  `overflow` *and* cut by any edge mask on it. Parent them to a top-level layer in
  the shadow root and position from the anchor's viewport rect.
- **`display: none` cannot be transitioned.** Animate first, flip display on
  finish. And if the hidden element occupied layout, animate its width/margin too
  or the surrounding layout snaps at the end instead of gliding.
- **Right-click still raises the app's own menu** inside injected UI. Cancel
  `contextmenu` on the overlay root, and give text fields your own copy/paste
  popup if you need one.
- **Clipboard from the isolated world**: `navigator.clipboard.readText()` has a
  permission gate that is never prompted and silently rejects. Route it through
  main and use `electron.clipboard`.
- A focused element with no explicit `outline: none` shows the UA focus ring,
  which reads as a thick bright border against dark chrome.

## Two ways an overlay "snaps into position"

Both showed up in the plugin dashboard and neither is the entrance animation:

1. **A state-transition animation firing during first paint.** `renderMain()` runs
   inside `show()`, before the overlay is visible, so anything that animates a
   layout change from a render path also animates on open — the preview frames
   expanded from zero width while the panel was still fading in, dragging the
   panel across. Give such helpers an `animate: false` path and use it while the
   overlay is being assembled; only a user gesture should move anything.

2. **A scrollbar appearing.** A flex child that gains ~15px when its scrollbar
   shows makes a centred sibling re-centre by half of that, which reads as a nudge
   mid-fade. `scrollbar-gutter: stable` reserves it and the layout stops moving.

Distinguishing them: compare `offsetWidth` (layout) with
`getBoundingClientRect().width` (visual) across the entrance. Layout changing is
cause 2; only the rect changing is a transform, which is usually the intended
animation.

## An agent's own transcript says whether it is still running

The first cut called an agent "running" if its file had been touched inside the
last N seconds, and exposed N as a setting. That is a guess wearing a slider.
The answer is in the file, structurally.

The CLI writes **one jsonl line per content block**, and puts `stop_reason` on
the **last block of an assistant turn only**. In one 134-line agent file: 67
lines carry `stop_reason: "tool_use"`, 18 assistant lines carry none (they are
non-final blocks of turns that made parallel tool calls), and exactly one
carries `end_turn`. So the last line of the file classifies the agent:

| last line | meaning |
| --- | --- |
| assistant, `stop_reason` in `end_turn` / `max_tokens` / `stop_sequence` / `refusal` | finished on its own terms |
| user turn carrying `[Request interrupted by user…]`, or `toolDenialKind` set | stopped |
| anything else — `tool_use`, a bare `tool_result`, a non-final assistant block | the CLI still owes it a write |

Measured over the 142 agents of one real session: **116 done, 21 stopped, 5
unterminated**. 96.5% settled with no clock involved.

The third case is the only ambiguous one, and it is ambiguous in exactly one
way: a file that ends mid-turn looks identical whether the agent is mid-turn
right now or was killed hard enough to skip the interrupt marker. Nothing on
disk can separate those, because the distinguishing fact is whether a process is
alive.

The app publishes that fact, but not the useful shape of it. `getSession` returns
a DTO with **`hasBackgroundActivity`** — computed from the manager's own
`hasLiveBackgroundTasks(session)`. The per-task map, `activeBackgroundTasks`
(`Map<task_id, 'local_agent' | 'local_bash' | 'local_workflow'>`, fed by the
CLI's `background_tasks_changed` system message), is **stripped from the DTO**;
checked against app-1.26832.0 by reading the real session record at runtime. So
per-agent liveness is not available from the app, but session-level liveness is,
and that is enough:

```js
active = state === 'inflight' && sessionHasBackgroundActivity
```

An unterminated file in a session with no live background task is a dead agent,
not a running one. The remaining imprecision is bounded and unavoidable: within a
session that *does* have live background activity, an agent killed without a
marker reads as running until something else settles it.

`getAgents` is not this. It returns the list of agent **definitions** the SDK
supports (`supportedAgents()` plus the names under `~/.claude/agents`), not
running instances.

## Every agent has a meta sidecar, and it beats the parent-transcript join

Beside each `agent-<id>.jsonl` sits `agent-<id>.meta.json`:

```json
{"agentType":"reader","description":"Read areatrigger dumps","name":"fx-rd-at",
 "toolUseId":"toolu_01Fs…","parentAgentId":"aac9dc6a907bf951a","spawnDepth":2,"model":"opus"}
```

That is exactly what the parent-transcript join was reconstructing by pairing an
`Agent` tool_use with the `"Async agent launched successfully … agentId: X"`
tool_result — and it carries it for **nested** agents, which the join structurally
cannot see, because their spawner is another agent rather than the session.

Same 142-agent session: the join named 53. The sidecar names 110, and types all
142. `spawnDepth` explains the gap outright — 53 at depth 1, 89 at depth 2.

Read it with a mtime+size cache like every other file in the index; it costs one
`statSync` per agent per poll and does not change the 240ms cold / 10ms warm
index cost.

## Parent–child messages are two transcript streams (CLI 2.1.260, read 2026-09-23)

A `SendMessage` appears in the **sender's** JSONL as an assistant `tool_use`
with `input.to`, `input.summary`, and the full `input.message`. The following
`tool_result` carries JSON `{success:true,pin:{id}}` for a named child, or a
success receipt without a pin for `main`. A tool call alone is not proof of
successful delivery. The receiver records an `attachment` of type
`queued_command`; `origin.kind` is `coordinator` for a root-to-agent message,
or `peer` with `senderTaskId`, `from`, `name`, and `body` for an agent-to-agent
message. The receiver's prompt carries the delivered text; these attachments
are not ordinary human user turns.

The child's final report reaches its direct parent as a
`<task-notification>` in a `queued_command` attachment. The same notification
is also recorded in queue-operation and delivered-message forms, so index one
form only or a single report renders three times. For a nested child, the
parent stream is `agent-<parentAgentId>.jsonl`, not the session root. The
sidecar supplies that parent ID. Match `pin.id` before a name: names can repeat
within a session, while agent IDs are stable.

The conversation pane reads both files incrementally by complete JSONL line.
It shows the spawn brief, direct messages, and final reports separately from
the full tool transcript. Sibling traffic is excluded even when the same name
appears in the text. A pending or unknown send remains labelled as such until
its receipt or delivery appears; a failed send is not presented as a message.

## A polled view must patch, not rebuild

An overlay that polls has two jobs that pull against each other: show current
data, and stay still. Clearing a container and rebuilding its children satisfies
the first and destroys the second, because a fresh node is a node whose CSS
animations have never run.

That is the whole mechanism behind "it flickers randomly": there is no random
element. The subagents panel polled every 2s open and every 6s closed, and each
poll called `wrap.textContent = ''` before rebuilding. Every rebuild produced a
new `.chip`, so its `fadeDown` entrance played again — a 300ms fade plus a 5px
slide, once every 6 seconds. Opening the panel was worse: `render()` ran on the
click, again when the poll it kicked off resolved, and again per `detail`
payload that arrived, so `rise` played three or four times in the first second.

Everything else a rebuild costs is silent but real:

- scroll position of any `overflow-y: auto` ancestor resets to 0
- `:hover` drops off whatever is under the cursor, so a hover transition
  re-runs and buttons revealed on hover blink out
- text selection inside the panel is lost
- infinite keyframes (a blinking cursor, a breathing dot) restart mid-cycle,
  which reads as a stutter rather than a flash

The fix is a keyed reconcile — the same discipline React applies, written by
hand because we are outside React's tree. Nodes are created once, stored in a
Map keyed by identity, and patched:

```js
function sync(parent, store, keys, make, patch) {
    const want = new Set(keys);
    for (const k of Array.from(store.keys())) {
        if (want.has(k)) continue;
        const n = store.get(k); store.delete(k); n.remove();
    }
    let prev = null;
    for (const k of keys) {
        let n = store.get(k);
        if (!n) { n = make(k); store.set(k, n); }
        patch(n, k);
        const at = prev ? prev.nextSibling : parent.firstChild;
        if (n !== at) parent.insertBefore(n, at);   // only moves when order changed
        prev = n;
    }
}
```

The key has to be the thing's real identity — `agentId`, not the index — or a
list that grows at the front renames every row and rebuilds all of them.

Three details that matter once patching is in place:

- **Guard every write.** `setText(n, s)` compares before assigning. Assigning an
  identical `textContent` still drops and recreates the text node, which is
  enough to lose a selection inside it.
- **Append-only for a growing transcript, except the last entry.** The final
  turn is still being written while an agent runs, so it is re-rendered every
  pass and everything above it is left alone. That is what keeps scroll steady
  in an expanded agent with 183 turns.
- **A failed poll keeps the last good data.** Clearing `agents` on an error tore
  the chip down and rebuilt it on the next success — a flicker caused by
  nothing the user did.

Measured against a DOM shim, driving the identical script (30 closed polls, 48
open polls, an expand, a transcript that grows, a failed poll): 10,005 nodes
created before, 575 after, and node identity now survives every pass.

## display:none restarts descendant CSS animations

Toggling a container back from `display: none` starts every CSS animation on its
descendants again from zero. A panel whose children have an entrance keyframe
therefore replays that entrance on every show — and if the container is itself
animating a size change, the child animation finishes *after* it and reads as a
hitch at the tail.

Suppressing the child animation with `animation: none` does not fix it: removing
the suppression starts the animation, so the hitch just moves to whenever the
class comes off. Collapse the container instead of removing it from the display
tree:

```css
.frames.off {
    width: 0; min-width: 0; margin: 0; padding: 0;
    visibility: hidden; opacity: 0; pointer-events: none;
    scrollbar-gutter: auto;   /* or the reserved gutter keeps ~15px of width */
}
```

Layout contribution is identical to `display: none`, and no animation ever
restarts.

## A ResizeObserver that measures getBoundingClientRect will chase transforms

`getBoundingClientRect()` includes transforms, so an element with a scale/rotate
entrance looks like it is resizing. If the observer responds by animating `width`
— a real layout change — that feeds the next observation and the box walks. Use
`offsetWidth` / `offsetHeight` (layout only) for size-change detection, and
cancel any in-flight size animations when starting a different one on the same
element.

## A Code session is its own CLI process, so provider is per session

Measured 2026-08-29 on app-1.26832.0, two sessions open:

```
pid 16992   claude-code\2.1.222\claude.exe  --model claude-opus-5  --resume=faca3248-…
pid  6784   claude-code\2.1.222\claude.exe  --model claude-opus-5  (no resume)
```

Both are children of the Electron main process, with distinct argv and distinct
inline `--settings` blobs. `spawnLocalProcess` in `.vite/build/index.chunk-Cqfh0Vpp.js`
passes `env` straight into `child_process.spawn` per call, so wrapping spawn sets
the endpoint per session, not per app.

What that does **not** buy is a mid-conversation switch: the process is already
running and its `ANTHROPIC_BASE_URL` is fixed. Making the endpoint uniform and
dispatching on `body.model` inside the router is what turns a provider switch
into a model switch — see the next two entries.

## `set_model` is a live control request, and the app already sends it

From the string table of `claude-code\2.1.222\claude.exe`: `set_model` sits
alongside `set_permission_mode`, `interrupt`, `set_max_thinking_tokens`,
`rename_session` as a control-request subtype on the CLI's stdin, with its own
validation errors (`set_model: model must be a string`) and the engine log line
`[engine] send set_model model=`.

`LocalSessions.setModel` in `.vite/build/index2.chunk-ZVJDHx_k.js` drives it:

```js
async setModel(e,t){ … let i=this.resolveModel(t,`set_model`,e);
  if(i!==void 0 && … (n.model=i, this.saveSession(n), this.emitSessionUpdated(n), n.query)){
    if(n.isRunning){ n.query.setModel(i)… } } }
```

So a model change reaches a running session without a respawn. It is reachable
from the mod's world as a plain `ipcRenderer.invoke` on
`eipc('claude.web','LocalSessions','setModel')`, taking the **desktop** session
id (`local_<uuid>`, the one in the URL).

## The model gate is a substring match against a renderer-supplied list

`validateSessionModel` in `.vite/build/index.chunk-89GFRAwU.js`:

```js
validateSessionModel(e,t){
  return Tu(e) ? {ok:!1,reason:`model_restricted`}
       : t?.length ? (lu(e,t) ? {ok:!0} : {ok:!1,reason:`not_in_allowed_models`})
       : l.Vn(this.creds?.provider ?? this.configuredProvider, e) }
```

Read the middle branch: when the list is non-empty, **membership is the only
check** and the provider check is skipped entirely. The list is
`availableCodeModelIds`, which is whatever the renderer last pushed over
`LocalSessions.setAvailableCodeModels` — main never derives it.

And the membership test is not equality:

```js
ou(e) = e.replace(/\[[^\]]+\]$/,``).replace(/-20\d{6}$/,``)
lu(e,t) = t.some(x => ou(e).includes(ou(x)) || ou(x).includes(ou(e)))
```

A two-way substring compare, with `ou` stripping only a bracket tag and a date
suffix. So the single entry `claude` validates every Claude id and `gpt-`
validates every GPT id. `provider-picker` pushes both as anchors rather than
trying to reconstruct the app's own list: measured, the app had **not** pushed a
list at all during a 30-second probe window, so an observe-and-append design
leaves the gate shut indefinitely — and a reconstructed list risks omitting a
Claude model, whose symptom is the picker silently falling back to default.

`Tu(e)` — the hard-blocked set — is tested first and is untouched by this.

Verified end to end 2026-08-29 against a dormant session, reversibly:

```
before   claude-fable-5
setModel gpt-5.6-luna:xhigh   ->  getSession.model == gpt-5.6-luna:xhigh
setModel claude-fable-5       ->  getSession.model == claude-fable-5
```

The effort tier rides in the model string as `slug:tier` because
`output_config.effort` does not survive the client — Claude Code normalises it to
low/medium/high, and three of the GPT models offer five or six tiers.

## An injected model cannot be persisted, so the UI reconciles sessions off it

Verified 2026-09-05 against app 1.46388.4 and the live claude.ai Code bundle.

The Code UI stores the selected model per account with
`PATCH /api/organizations/<org>/model_selector_state/code`. Every injected id is
refused, counted across `%APPDATA%\Claude\logs\claude.ai-web*.log`:

```
claude-gemini-3.7-flash            82   400 model_not_selectable
claude-gpt-5.6-sol                 44
claude-gpt-5.6-terra               40
claude-gemini-3.1-pro              36
claude-gpt-5.6-luna                28
claude-gpt-5.5 / 5.4               10 each
claude-Qwen3.8-Max-*                8 / 6 / 2
```

The UI strips the `[1m]` tag before sending, so the server sees the bare slug.
On failure the mutation only fires analytics — there is no local fallback write,
so the row keeps the last Claude model the server accepted. Read live from the
account's own `/edge-api/bootstrap/<org>/app_start`:

```json
{"id":"code","model":"claude-opus-5","thinking":{"type":"effort","effort":"high"},
 "selection_source":"user_setting"}
```

`thinking_by_model` on that row holds only Anthropic ids. The row is replaced
wholesale whenever `bootstrap_push_revision` increases, which is why the effect
has no user-visible trigger.

The first time a page generation mounts a session, the renderer reconciles the
session to that stored value over `LocalSessions.setModel`. Measured from
`main1.log`, delay from `setFocusedSession` to `setModel: model=claude-opus-5`:

```
2026-08-31 16:48:42  local_AAAAAAAA   50 s
2026-08-31 16:50:07  local_BBBBBBBB    4 s
2026-08-31 16:50:45  local_CCCCCCCC    5 s
2026-08-31 17:28:54  local_DDDDDDDD    7 s
2026-09-01 07:58:27  local_EEEEEEEE    0 s
```

The last landed in the same second as a focus during sub-second session
flipping, so no menu was involved. It fires once per (page, session):
`local_BBBBBBBB` and `local_CCCCCCCC` were re-focused at 17:23 and 17:25 with no
second write. One confirmed round trip: `local_BBBBBBBB` was
`claude-gpt-5.6-sol[1m]` on 2026-08-30 23:19:28 and `claude-opus-5` at
2026-08-31 16:50:11.

That log line lives in the eipc handler wrapper
(`async setModel(e,t){ log; await o.setModel(e,t) }`), so every logged
occurrence came from the renderer. Main's internal `setModel` calls do not log
and do not pass through it.

Eliminated with evidence, so they do not need re-testing: the router serves the
requested arm (`openai-response-identity` reports `gpt-6-astra` for
`gpt-6-astra`); no live session record carries `preRefusalModel`, so the CLI's
`model_refusal_fallback` never fired; `resolveCodeSessionModel` logs
`falling back to default` on every rejection and appears zero times across all
five `main*.log` files; and of 254 sessions in `provider-usage-v1.jsonl` the
three that mix Astra with Claude are `claude-haiku-4-5` background calls and one
session's concurrent Opus subagents.

`src/plugins/model-lock` is the gate. It wraps the same eipc handler and refuses
exactly one shape of write: an injected model replaced by a non-injected one
with nothing armed. Refusals land in `.state/model-lock.json`.

## `boot.host` is not reliably populated when a plugin first runs

Probed 2026-09-05 from a plugin three seconds after load. One host generation's
boot object carried only `electron, MOD_DIR, generation, log, broadcast,
loadHost` with `generation: 1`; a later generation carried `host` as well. So
`ctx.boot?.host?.dispatch(...)` is a race, and its failure mode is silent —
optional chaining resolves the whole call to `undefined` rather than throwing.
`provider-picker`'s dispose already has a fallback for this. Anything that must
be correct on the first tick should read what it needs directly instead.

## The desktop has its own provider system, and it is app-global by construction

`validateSessionModel` and `resolvedModels` read
`this.creds?.provider ?? this.configuredProvider`, with a `bedrock` branch and a
`[custom-3p]` log prefix. That is the enterprise custom-provider feature: one
provider per app instance, sourced from credentials. It is the thing that makes
provider look like an app-wide setting. `provider-picker` does not touch it — it
works entirely through the model id, which is per session.

## Provider Usage Atlas and empirical forecasts (verified 2026-08-31)

The router now owns the complete provider-usage data plane:

- `~/.claude/gemini-bridge/provider-usage-v1.jsonl` stores one fsynced,
  response-id-deduplicated terminal usage record for every provider arm.
  Claude is observed while its upstream bytes are relayed unchanged. OpenAI uses
  terminal `response.usage`. An adapter arm uses the terminal Anthropic usage translated
  from Google's `usageMetadata`. Prompt and response content never enter this file.
- `~/.claude/gemini-bridge/provider-limit-history-v1.jsonl` stores sanitized
  OpenAI and adapter quota observations. It retains five-minute heartbeats for
  OpenAI and the quota families each provider adapter marks as tracked,
  compacts to the latest 20,000 rows at startup, and skips the catalogue aliases
  an adapter does not track. Claude
  history remains authoritative in `%APPDATA%/Claude/plan-usage-history.json`,
  scoped to the current org.
- OpenAI limits come from ChatGPT `/backend-api/wham/usage`. Every other
  provider’s limits come from its adapter. Pool averages include active,
  schedulable accounts only; the raw table retains every account/model row.
- The ChatGPT plan grants occasional **rate-limit reset credits**, counted in
  the same `/wham/usage` payload as `rate_limit_reset_credits.available_count`.
  Read `codex.exe` 0.14x for the rest of the surface: the credits live at
  `/backend-api/wham/rate-limit-reset-credits` with `/consume` beneath it, and
  the same pair is mirrored under `/backend-api/api/codex/`. The consume request
  body (`redeem_request_id`, `credit_id`, `usage_limit`, `credit_type`) is only
  inferred from the binary's strings, which is why `router/reset-credits.mjs`
  redeems through `codex app-server`'s JSON-RPC
  (`account/rateLimitResetCredit/consume`, params `{ idempotencyKey, creditId? }`)
  instead. That protocol is generated — `codex app-server generate-json-schema
  --experimental --out DIR` writes it — and it reuses the auth.json refresh.
  The outcome enum is `reset` | `nothingToReset` | `noCredit` | `alreadyRedeemed`;
  only `reset` spends a credit, and `alreadyRedeemed` is what a repeated
  idempotency key returns. Credits expire: each grant carries its own expiry
  date, so read it from the payload.

Loopback endpoints are:

```text
GET /usage/          self-contained local dashboard
GET /usage/api       joined quotas, history, forecasts, calibration, and exact usage
GET /usagez          sanitized exact token ledger snapshot
GET /limitsz         sanitized provider-native limit snapshot
GET /resetz          reset-credit inventory, exhaustion state, redemption journal
POST /resetz         redeem one reset credit, refused unless a window is at its
                     limit (force=1 skips that check). The router never redeems
                     on its own; something has to ask.
```

The dashboard assets are same-origin and ship a restrictive CSP. No CORS header is
present, so another web origin cannot read the loopback usage data. Credentials,
request bodies, prompts, and responses are absent from every response.

Forecasts use only observed utilization after the most recent reset or utilization
fall, over a six-hour lookback. Reset timestamp movement under one minute is
treated as provider countdown jitter, not a new quota window. The rate is
percentage points per minute. ETA is
reported only when that measured rate reaches 100% before the provider reset;
otherwise the UI says the reset wins. Confidence exposes sample count, observation
span, and quota movement rather than hiding sparse data behind a number.

"Tokens per 1%" is empirical, not a fabricated plan allowance. Exact terminal
input-context plus output tokens are divided by a measured utilization delta in
the same interval. The UI says `Learning` until both kinds of evidence exist.
A pooled provider is calibrated on its schedulable pool average: an adapter
backed by several accounts generally cannot say which one served a response.

The Desktop `usage-bar` plugin keeps remote credentials and full analytics in the
main process. Its renderer receives only the active provider's limits plus a compact
forecast/calibration projection, cached for 30 seconds. Claude requests use a
local-only analytics scope and never poll the paid provider accounts. During initial validation,
the full dashboard response measured 270,489 bytes and was crossing renderer RPC
every eight seconds; the main webview later became unresponsive at 925 MB. The
compact projections measure 3,641 bytes for OpenAI and 19,706 bytes for a pooled adapter provider.
Do not send the full dashboard snapshot over renderer RPC. The native usage popover
shows the compact insight and opens `http://127.0.0.1:8789/usage/` in the browser.

## Permanent provider accounting (verified 2026-08-31)

`router/accounting.mjs` keeps every timestamped token event and subscription
quota observation forever. Transcripts are not its concern: the running hook
already persists those, and the store's sanitizer is an allowlist, so a prompt,
message, tool, attachment or credential field on an input object is dropped
rather than written.

Layout under `~/.claude/gemini-bridge/provider-accounting-v2/`:

```text
segments/tokens/tokens-YYYY-MM-DD.jsonl   authoritative token evidence
segments/quotas/quotas-YYYY-MM-DD.jsonl   authoritative quota evidence
dedupe/tokens/<00-ff>.ids                 global exact dedupe, 128-bit SHA-256 prefixes
rollups/{all-time,daily,quota-daily}.json  derived, rebuildable
seals/, backups/, spool/, state.json, writer.lock/
```

Facts that cost measurement:

- **Only raw segments are fsynced.** Syncing each derived index made the first
  import of 5,365 legacy records take 7.6s, of which 5.9s was 1,694 fsync calls.
  Writing indexes without fsync cut the same import to 1.6s with 50 fsyncs.
  Durability is preserved because `state.json` records each segment's byte size,
  and `repair()` replays only the tail of any segment that grew past its
  recorded size. That replay is index-only; committing it as new evidence
  duplicated the raw lines it was meant to reconcile.
- **The inference path never waits for the lock.** `mkdir` on `writer.lock/` is
  attempted once; a contended append is written to its own immutable one-event
  spool file and merged by the next lock holder. A blocking wait here would
  stall live SSE streams, because usage is recorded inside terminal response
  handling.
- **Stale locks are reclaimed by claim, not by delete.** Two contenders that see
  the same dead owner would otherwise each delete the other's fresh lock. The
  owner also verifies its own nonce before releasing.
- **Legacy import is a byte cursor, not a one-shot marker**, because a draining
  or rolled-back pre-v2 worker keeps appending `provider-usage-v1.jsonl` after
  the first import. `plan-usage-history.json` is exempt: Desktop rewrites it
  atomically and prunes it, so it is reparsed whenever mtime or size changes and
  every `org + bucket + timestamp` sample is exact-deduplicated. That import is
  what preserves Claude subscription history past Desktop's ~30-day retention.
- **Token totals are never attributed to an individual provider account.** The
  response evidence does not carry one.

`GET /usage/api` takes `range=all|today|7d|30d|90d` and `tz_offset`, defaulting
invalid input to `all`. A range sums whole UTC days from the daily rollup and
scans at most the one segment the window starts in, so an all-time query costs
the same as a seven-day one. Measured live: 5,436 responses, 839,970,216 context
tokens, query 15-23ms, store 6.2MB. Migration totals matched an independent
line-by-line sum exactly.

Ranges change historical totals, the daily timeline and the token bars. They
never change current utilization, resets, schedulability or the active-window
forecast, which stay current provider evidence rather than a historical average.

Corrections found by adversarial review and by auditing the live store against
its own raw evidence:

- **Rollups are sharded by year and loaded on demand.** A decade of quota
  observations is far too large to hold whole; `all-time.json` keeps only a
  per-year summary, and a range query loads just the years it covers.
- **`state.derivedVersion` guards the derived layout.** When the flat daily
  rollup became year-sharded, the new code started from an empty rollup and
  backfilled only the days whose segments happened to grow, silently dropping
  two records from an older day. A version mismatch now clears the watermark so
  every segment is recomputed once.
- **Repair recomputes whole days rather than re-adding rows**, which is what
  makes replay idempotent when a rollup reached disk but its watermark did not.
- **Every mutation runs inside the lock**, including repair and flush. Reads are
  pure, so a dashboard query can never mutate the store under a writer.
- **The dedupe separator is exported, not re-derived.** The rebuild tool hashed
  keys with its own separator, so a rebuilt index stopped matching runtime
  lookups and would have double counted every later duplicate.
- **A late record retires the seal of the day it lands in**, so `verify` reports
  real tampering instead of legitimate backfill.
- **Orphaned merge claims are reclaimed**; a merge that died mid-flight would
  otherwise strand its spooled records forever.
- **A legacy file with no trailing newline still yields its last record**, and
  the Claude plan buckets map to the same identifiers live normalization uses.

`node scripts/provider-accounting.mjs <status|verify|rebuild|seal|migrate|export|recover>`
is the operator surface. `rebuild` regenerates every index from raw segments and
deletes no evidence. `recover` refuses to overwrite the active day and preserves
any live copy it supersedes. Backups on the same volume cover corruption and
overwrite, not disk loss; set `MODEL_ROUTER_ACCOUNTING_BACKUP_DIR` to another
volume for that, and the API reports which case applies.

## Claude reset times, and why the plan file alone cannot forecast (verified 2026-08-31)

Read off app 1.26832.0 `resources/app.asar`, plan-usage module.

Desktop fetches `${base}/api/organizations/${orgUuid}/usage` on a 15-minute
timer (5 minutes while recently active) and appends to
`plan-usage-history.json` at most every 4.5 minutes. The path from HTTP
response to that file is two verbatim copies:

```js
let t = l[e]?.utilization;   t != null && (u[e] = t)     // response -> intermediate
let r = e.utilization[t];    r !== void 0 && (i[n] = r)  // intermediate -> file
```

The whole 4,744-byte module contains no `Math.round`, `Math.floor`, `toFixed`,
`parseInt`, `|0` or `~~`, and the zod schema is `number().nullable()`. Zod
cannot silently round: a stricter `.int()` would *reject*, and rejection returns
early before the history append, so a file that keeps growing proves validation
is passing on whatever the server sent. **Anthropic rounds server-side.** Hooking
the writer to recover fractional percentages gains nothing; measured live, all
five numeric fields of a real response were integers, and `limits[].percent`
merely mirrors `utilization`.

What the response *does* carry and the history file discards entirely:

```text
five_hour   resets_at 2026-09-01T01:40:00.493593+00:00
seven_day   resets_at 2026-09-07T13:00:00.493616+00:00
limits[]    kind session | weekly_all | weekly_scoped (scope.model, e.g. "Fable")
extra_usage is_enabled, monthly_limit, used_credits    (absent on this account)
```

`plan-usage-history.json` stores only `{t, org, u}`. With no reset time every
Claude window hit this branch:

```js
const exhaustsBeforeReset = etaMinutes !== null && (resetMinutes === null || etaMinutes < resetMinutes);
```

`resetMinutes === null` made **any** measured burn claim exhaustion, and that
claim fed the dashboard's headline. It could never say "reset wins" for Claude.

The `plan-usage-capture` plugin wraps `electron.net.fetch` in the main process,
observes the request the app already makes, and writes `.state/claude-plan-resets.json`.
It issues no request of its own. The wrapper must be a synchronous pass-through
that reads `response.clone()`: a `Response` body is single-use, so reading the
original would hand Desktop an empty stream and break its usage feature outright.

`analytics.mjs` resolves that path **per call**, defaulting to the repository's
`.state/`. An env-var-only constant read at module load left the feature inert in
the router and forced every test to re-import the module.

Measured immediately after wiring, the two windows finally disagree:

```text
Session · 5 hour      22%   resets in   146m   eta  532m   exhausts false
Weekly · all models    5%   resets in  9466m   eta 2849m   exhausts true
```

The weekly limit is the binding constraint; the session limit resets first.

Meters now carry `windowSeconds` where it is known (Claude bucket names, OpenAI
`limitWindowSeconds`). When both a reset and a window length exist,
`activeHistory` cuts samples older than `resetAt - windowSeconds` exactly,
instead of inferring a reset from a drop in the value.

## The per-model weekly limit has no bucket (verified 2026-08-31)

`limits[]` in the usage response carries three kinds, observed identically
across captures:

```text
session         group session   percent 25   resets_at present
weekly_all      group weekly    percent  5   resets_at present
weekly_scoped   group weekly    percent  0   resets_at NULL   scope.model "Fable"
```

`session` and `weekly_all` duplicate the `fh` and `sd` buckets, so only
`weekly_scoped` is turned into a meter; emitting the other two would double the
same window under two keys.

There is no plan-history bucket for a scoped model. `CLAUDE_BUCKETS` covers
opus and sonnet only, so a weekly limit on any other model was the one Claude
limit the interface could never show at all.

`weekly_scoped` carries no `resets_at` of its own. It belongs to the weekly
group, so it inherits that group's reset from the `seven_day` bucket; an
explicit `resets_at`, if one ever appears, wins over the inherited value. Its
`windowSeconds` is the weekly 604800.

Its `observedAt` is the capture timestamp, not `plan.observedAt`: this value
arrives on the usage-response cadence, and dating it from the history file
would overstate its freshness.

Live: `Weekly · Fable`, `quotaId weekly_scoped:Fable`, source
`claude.plan-usage-limits`, reset inherited from the weekly window.

## Cost is derived, never stored (2026-09-01)

`router/pricing.mjs` holds USD-per-million rates per `provider/model`, each
with the window it is in force for. `AccountingStore.query()` prices the
window by folding cost per `(day, model)` cell of the rollup it already has,
so a rate that changed mid-window is applied on the correct side of the change.

Nothing on disk encodes dollars. The rollups carry token counts only, and a
test asserts no `cost` or `costUsd` string appears in any rollup file. The
consequence is that correcting a wrong rate is retroactive for free: edit the
table and every historical day is right on the next request, with no migration
and no `DERIVED_VERSION` bump. Storing money would have made the price table a
schema.

An unrecognised `(provider, model)` is counted as `unpricedResponses` /
`unpricedTokens` rather than contributing zero, so a model with no published
rate reads as a gap in the bill instead of as free traffic. After the historical
rate backfill on 2026-09-05, the live all-time store reports zero unpriced
responses and zero unpriced tokens.

Dated snapshot ids price as their family (`claude-haiku-4-5-20251001` ->
`claude-haiku-4-5`); a name that merely resembles a priced model is left alone.

## The rate table covers the newer models (verified 2026-09-05)

Published model tables were read from Anthropic, OpenAI, Google and Alibaba;
NanoGPT remains machine-checked against its registry by
`scripts/nanogpt-sync.mjs --check`. Meta's authenticated `/v1/models` confirms
the two exact ids but carries no rates, so its direct prices are cross-checked
against the single-provider Meta listing. A rate an adapter registers stays
beside that adapter rather than making the public tree name a private backend:

    claude  fable-5.1       $10 in   $0.25 read  $12.50/$20 write  $50 out
    claude  fable-5         $10 in   $1.00 read  $12.50/$20 write  $50 out
    claude  opus-4-6        $5  in   $0.50 read  $6.25/$10  write  $25 out
    openai  astra           $10 in   $1.00 read  $12.50      write  $50 out
    openai  sol             $4  in   $0.40 read  $5.00       write  $20 out
    openai  terra           $2  in   $0.20 read  $2.50       write  $12 out
    openai  luna            $0.20 in $0.02 read  $0.25       write  $1.20 out
    meta    muse 1.3        $1.25 in $0.15 read  $0          write  $4.25 out
    meta    contributor     $0.10 in $0.002 read $0          write  $0.20 out
    qwen    3.8 max aliases $2 in    $0.25 read  $2.50       write  $6 out

Eight facts worth keeping:

**Sonnet 5's September increase will not happen.** The page now states the $2
launch price is the standard price and the scheduled 2026-09-01 step to
$3/$15 was withdrawn. This table carried that step for two days; retracted
2026-09-03, and every recorded day repriced on the next read with no
migration -- the retroactive-correction property doing exactly what it was
designed for.

**Fable 5.1's cache read is 0.025x input**, a discount no other Anthropic model
on the page gets; Fable 5 reads at the ordinary 0.1x. Same input and output
price, so they must be separate entries or one of them is wrong.

**An effort tier spent on the model id prices as its family.** Some backends
put the tier in the id (`a-model:low` -> `a-model-low`) rather than in a
request field, and the vendor then prices the family flat across tiers -- the
published output price is stated as including thinking tokens. The suffix is
the same SKU, not a neighbour. `canonicalModel(model, provider)` therefore
folds `-high/-medium/-low/-tiered`, but only for providers that declare the
behaviour when they register their rates; any other provider's `-high` id
stays unpriced until its own rate is published.

**Image output is not text output.** The two historical image-model records
carry image tokens in `outputTokens`; Google's paid table prices those at $60/M
for Gemini 3.1 Flash Image and $120/M for Gemini 3 Pro Image. Applying the
models' $3/$12 text-output rates would understate the completed generations by
20x and 10x.

**Historical rates do not restore historical routes.** The three Qwen aliases
remain absent from the catalogue and fail closed. Their rows exist only because
34 old responses remain in the permanent ledger. The same rule covers
pre-release Gemini image ids and one Haiku record written under the old `gemini`
provider label.

**The fingerprint is a live binding.** Adapter registration happens after
`pricing.mjs` evaluates. Computing the hash once at module load made the rate
payload include adapter rows under a fingerprint that named only the built-in
table. `registerRates()` now refreshes it after every registration; a test hashes
the final `RATES` object independently.

**Prompt-length brackets are not encoded.** OpenAI prices input beyond 272k
tokens at ~2x and Gemini 3.1 Pro beyond 200k the same. The rollup holds sums,
not per-response prompt lengths, so a bracket split cannot be computed
honestly from what the store keeps; the table prices the short bracket and the
rate card says so. Consequence: recorded 3.1 Pro traffic sits far below 200k
and is billed exactly, while Astra and 5.6-Sol conversations do cross 272k, so
OpenAI spend reads as a floor, not a bill.

**The dashboard renders the table.** The Atlas has a Rates section that lists
every `provider/model` period -- input, cache read, both write TTLs, output,
and the window each row is in force for -- from `usage.pricing.rates`, which
`AccountingStore.query()` ships alongside the fingerprint. Unpriced models are
named in the spend note rather than only counted, and a lane with no metered
provider colour falls back to the neutral axis colour instead of rendering
invisible bars.

## Anthropic cache writes are all 1-hour TTL (measured 2026-09-01)

A cache write bills at 1.25x input for the 5-minute TTL and 2x for the 1-hour
one, and the API reports which was used in `usage.cache_creation`:

```text
14,589 assistant usage objects on disk
   14,565 carry a cache_creation object
   54,465,823 cache_creation_input_tokens total
            0 ephemeral_5m        (0 responses)
   54,476,452 ephemeral_1h    (8,174 responses)
```

Every observed cache write is the expensive kind, so the fallback rate for
records written before the split was captured is 1h, not 5m. Defaulting to the
cheaper rate would have under-billed the Claude cache writes by about a third.

`usageCopy` is an allowlist, so the split had to be added explicitly; it is
carried alongside `cache_creation_input_tokens` rather than replacing it,
because three records in the corpus disagree between the split and the total,
and the total is what the provider bills against. The residual clamps at zero.

## Generation rate is a router measurement, attribution is a transcript join (2026-09-01)

Tokens per second cannot be measured anywhere but the transport. The CLI's
transcript records what a turn cost, never how long the model took to produce
it; the app publishes nothing about stream timing. `router/throughput.mjs` takes
three clocks off every provider response and divides the provider's own terminal
token count by the right one:

```text
ttfb    dispatch -> upstream response headers    hop and routing
ttft    dispatch -> first content delta          prefill
stream  first content delta -> terminal event    generation
```

`outputTps` is output tokens over the stream interval, which is the rate the
model generated at. `endToEndTps` divides by the whole request, which is what
the session felt. Measured on `claude-opus-5` over 130 responses of one session:
sustained 101 tok/s, p50 116, p90 233, with ttft p50 2.4s and ttfb p50 1.4s —
so roughly half the wall-clock of a short turn is prefill, and reporting one
number for "speed" would hide that.

Three things that are not obvious:

**A non-streaming response has no honest generation rate.** No first delta means
no generation window, so `outputTps` is null rather than falling back to the
total. Zero and negative intervals are also null: two events inside the same
millisecond is a clock with nothing to say, and returning `Infinity` there
poisons every percentile downstream.

**A group's rate is tokens over time, not the mean of the rates.** Averaging
per-response rates lets a twelve-token acknowledgement outvote a four-thousand
token turn. The dashboards therefore show `sustainedTps` alongside p50/p90.

**The first version measured the wrong window on the Anthropic arm.** The sample
was created after `fetchResilient` had already resolved, so every record
reported `ttfbMs: 0` and a total that began at the first byte. The clock has to
start before dispatch.

### The request body identifies the subagent lane; CLI 2.1.260 also sends the agent ID

Every Claude Code agent request carries an `x-anthropic-billing-header` block as
`system[0]`, and `cc_is_subagent=true` appears in it **only** for subagent turns
— a main-session turn omits the key rather than setting it false. So absence of
the key is the body signal, and a request with no billing block at all (a tool-less
control-plane call) is a third answer, `null`, not a silent "main".

Every subagent turn still sends the **parent** session id in
`x-claude-code-session-id`. A 2026-09-15 local native trace established the
additional request header `x-claude-code-agent-id`: it differs between parallel
agents and remains stable across one agent's tool rounds. Earlier body-only
inspection missed it. Existing aggregate records remain grouped under the parent:
`provider-usage-v1.jsonl` has one measured session with 393 adapter-provider,
108 `claude-opus-5` and 60 `claude-sonnet-5` records under one id.

**The join key is the provider response id, and it is exact on both sides.** The
CLI writes the provider's own message id into the transcript as `message.id`.
Verified 2026-09-01 for Anthropic (`msg_01…` present in both the ledger
and `<cliSessionId>.jsonl`) and for an adapter provider (opaque ids such
as `-AbCdEf…` present in both the ledger and
`subagents/agent-<id>.jsonl`). Joining that id to the transcript
line yields `agentId`, and the `agent-<id>.meta.json` sidecar yields the name and
type. End to end on a live session: 34 responses at 102.6 tok/s attributed to
a named heavy-worker subagent, 11 at 120.8 to a `reader`, 5 to the main session.

Cost of the join, measured on a busy session (36 files, 17.7 MB, 2,642 assistant
lines): 64ms to read and parse everything, 133ms for a complete cold attribution
pass including the meta sidecars. Steady state is nil, because a jsonl transcript
is append-only and each file is re-read only from the offset last scanned. Files
untouched since the oldest record being attributed are skipped outright.

One race is inherent and self-healing: the CLI writes a transcript line after the
stream ends, so a response can reach the ledger a moment before its attribution
exists. It resolves on the next poll, when the tail scan picks the line up.

### The compatible arm recorded nothing

`handleCompatible` called `pipeAnthropicBody` with no usage observer, so every
compatible-provider response produced neither an exact token record nor a rate — the arm was
invisible to accounting as well as to throughput. It speaks Anthropic Messages
natively, so its terminal usage is exact by the same definition every other arm
uses; it now records under `<provider>.message.usage`.

### Files and endpoints

`~/.claude/gemini-bridge/provider-throughput-v1.jsonl` is a separate append-only
file rather than more fields on `provider-usage-v1.jsonl`: that ledger feeds
permanent accounting and carries its own schema evolution, and a rollback to a
pre-throughput worker would keep writing usage records with no timing in them.
Two files joined on `provider+responseId` cannot disagree about a response either
one of them saw. It holds clocks and token counts only.

`GET /throughputz` serves live in-flight samples plus rollups; `GET
/throughput/api` filters history by session, provider, model and lane. Both are
loopback-only, like every other router surface, and neither carries prompts,
response content or credentials.

A live sample's cleanup is bound to the response, not to a `finally` in the
handler: a fetch that throws before the try never reaches its finally, and the
live map would then show a phantom in-flight stream until the stale sweep fifteen
minutes later — which is exactly what makes a live readout untrustworthy. Node
emits `close` on every response either way.

## The streaming strip's chips carry their own separator (2026-09-01)

While a turn runs the app draws a marker row at the tail of the transcript:

```text
div[data-testid=transcript-row][data-perf-row=marker][data-perf-row-from-tail=0]
 └ div.flex.items-center.gap-[16px].h-5
   └ div[aria-hidden=false] …text-footnote text-secondary tabular-nums…
     └ span.inline-flex.items-center.min-w-0.max-w-full
```

Recorded from a visible window, session `a3f2a094`, mid-turn:

```html
<span class="inline-flex items-center">4s</span>
<span class="inline-flex items-center"><span class="px-xs">U+E062</span>4 tokens</span>
<span class="inline-flex items-center"><span class="px-xs">U+E062</span><button
  aria-label="Thinking…, hide from transcript"
  class="epitaxy-thinking-shimmer …"><span class="inline-flex">Thinking…</span></button></span>
```

**Every chip after the first carries its own leading separator, as a real
element** — `span.px-xs` holding the private-use glyph U+E062 — with the label
following as a sibling. It is not a pseudo-element: `::before` and `::after`
both compute to `none` on these chips.

That is the trap. Writing a chip's label by walking to "the innermost element
that has text" finds the **separator**, not the label, and produces
`~112 tok/s4 tokens`. The separator has to be recognised and stepped over.

The strip has two shapes and the same code has to handle both. Streaming, it is
plain `span.inline-flex.items-center` chips as above. Settled, the chips are
`button[data-cds="Button"][data-size="xs"]` whose label sits under two empty
paint layers (`span.cds-btn-squish`, `span[data-cds-part="paint"]`) inside
`span.inline-flex.min-w-0.items-center.gap-1 > span.text-footnote`. There, the
label genuinely is several levels down.

**Clone one of the app's chips rather than building one.** A clone inherits the
separator, the classes, the font and the tabular-nums alignment, and it survives
a restyle on their side. Measured: a cloned chip matched its donor at 12px,
`rgb(195,194,183)`, the same family, `tabular-nums`, and 6px/6px padding, and
**survived eleven consecutive per-second React re-renders of the strip** without
being reconciled away. Clone a chip that *has* a separator — the first chip in
the strip does not.

Two working notes:

- A hidden window reports `document.visibilityState === "hidden"` and Chromium
  throttles its timers to roughly one tick a minute, so a poll-driven decoration
  never runs there. Verified while debugging this: every window a probe could
  reach was hidden, and the chip's absence was the guard doing its job rather
  than a fault. Drive the update from a MutationObserver — mutations are not
  throttled — with a timer only as the floor.
- A probe that injects a node must remove it on dispose. A renderer reload
  disposes the old generation and loads a new one, and without cleanup each
  generation leaves a chip behind; two stale `XX tok/s` chips is how this was
  noticed.

### A turn is mostly not streaming (2026-09-01)

The marker strip stays up for the whole turn — `7m 5s · 7.2k tokens · Almost
done thinking…` — but a provider request is in flight for only part of it. The
model answers, tools run, the model answers again. A decoration keyed on "is
something streaming right now" therefore blinks out during every tool call,
which reads as broken rather than as idle.

Measured mid-turn: zero live streams, with the previous response 41 seconds old
at an exact 93.28 tok/s. So the chip holds the last completed response's rate
between streams, for two minutes, and that number is exact — the tilde marking
an estimate disappears when it settles.

Verified in place, visible window, session `ca7a7b65`:

```text
7m 5s | 7.2k tokens | ~64.8 tok/s | Almost done thinking…
                      ^ ours, 84x15px
size 12px/12px   colour rgb(195,194,183) both   family same   tabular-nums
padding 0/0 both   html: <span class="px-xs">U+E062</span>~64.8 tok/s
```

Two smaller facts from the same debugging:

- `cuimod.sessionId` is null for a second or so after **every renderer reload**,
  not only at first load, because session resolution is async and restarts with
  the new generation. A probe that samples immediately will record null and
  invite the wrong conclusion. Anything session-scoped must tolerate it; the chip
  renders nothing rather than showing another session's number.
- The session-scoped "last response" cannot be filtered out of `/throughputz`'s
  recent ring. That ring is forty deep across every session sharing the router,
  so a busy neighbour pushes this session's last response out of it. Ask the
  archive with `?limit=1&session=`.

### Auditing the strip, not one shape of it (2026-09-01)

The first pass measured one strip shape and generalised. A full audit — every
distinct shape recorded with per-chip tag, class, padding, margin, separator
width and the real gap to its neighbour — found three defects the single capture
could not have.

**The strip has two vocabularies.** Mid-turn, every chip is a plain
`span.inline-flex.items-center` with `padding: 0`, `margin: 0`, and a 12.4px
separator element. Once the turn settles they become
`button[data-cds="Button"][data-size="xs"]` with `px-md mx-outset`: 6px of
padding cancelled by **-6px of margin**, so the hit area overhangs the text, and
no separator at all.

Cloning whichever chip was next door therefore produced, in the settled strip,
two buttons **overlapping by 12px** with nothing between them:

```text
1 running task94.5 tok/s
  BUTTON w=100 mar=-6px/-6px
  BUTTON w=74  mar=-6px/-6px  gapBefore=-12
```

So the chip is built, never cloned: a plain span inherits the strip's font,
colour and tabular-nums from the meta row exactly as the app's own text chips do,
cannot inherit an interactive affordance it should not have, and is identical in
both vocabularies.

**A hand-built separator is not the app's separator.** `span.px-xs` carrying
U+E062 — same class, same code point — measured **20px against the app's
12.4px**, because the glyph falls back to a different font outside whatever the
app renders it in. There is no constructed fallback now: the separator is always
a clone of a live one, and the last one seen is cached for the window, because
the strip's opening states (`Sending…`, `Waiting for Claude…`) are a single chip
with none to lend. A separator is found by `isSeparator` rather than by class, so
a bundle that renames the utility is still matched on the glyph.

**The strip grows, so placement is not a one-time decision.** It opens as a lone
status word; the elapsed clock and the token count appear *ahead* of it a second
later. A chip inserted once was left stranded at the end:

```text
2s | 1.1k tokens | Thinking… | 82.0 tok/s      wrong
2s | 1.1k tokens | 82.0 tok/s | Thinking…      right
```

Its position is re-checked on every paint and corrected, guarded on
`previousElementSibling` because `insertBefore` is a mutation even when it moves
nothing — and our own mutations are what schedule the next paint.

Final geometry, five shapes, chip against every neighbour: separator 12.4px,
padding 0/0, margin 0/0, gap 0. Identical.

Two notes on the harness rather than the app. A mock DOM's `insertBefore` must
**move** a node that already has a parent, or a reposition test reports the chip
twice and the bug looks real. And `firstChild` must exist, or an insert meant for
the head silently appends to the tail.


## A typed prompt is the only user-role line with `promptSource` (CLI 2.1.222)

Everything the harness injects arrives on role `user`: skill bodies,
system-reminders, tool results, `[Request interrupted by user]`. Nothing in
`message` separates them from what the human typed, so anything that flattens a
transcript by role attributes the harness's words to the user.

The discriminator is on the envelope, not the message. A line the human actually
submitted carries `promptSource` (and `origin`, and `permissionMode`); an
injected one carries none of the three. Measured over one 3315-line session:

```text
message.content  string, promptSource present     16    typed
message.content  [text],  promptSource absent      5    injected
message.content  [tool_result]                   709    machinery
```

The typed lines are also the ones that carry `image` blocks — base64 inline in
`content[].source.data`, so a pasted screenshot is ~33 KB of transcript per
24 KB of PNG.

Bookkeeping line types that are not conversation at all, and are dropped whole:
`mode`, `last-prompt`, `custom-title`, `queue-operation`, `summary`, plus
`type: "attachment"` (19 distinct `attachment.type` kinds, dominated by
`batching_reminder_sent`, `edited_text_file` and `queued_command`) and
`type: "system"` (`subtype: "stop_hook_summary"`).

## CLI 2.1.260 separates dynamic context into a trailing system message

Measured with disposable `--no-session-persistence` workers pointed at one
loopback-only Messages stub. Versions 2.1.245 and 2.1.257 prepend the date as a
`<system-reminder>` text block inside the user's message. Version 2.1.260 sends
the human's message first, then emits the date as a separate `role: "system"`
message. It also adds `thinking.display: "updates"`; the rest of the minimal
request shape is unchanged.

The OpenAI translator used to special-case only `assistant` and mapped every
other message to Responses role `user`. Under 2.1.260, every request therefore
ended with injected harness context presented as the newest user request. GPT
could answer the date, project instructions or another reminder instead of the
human turn that preceded it. Native Anthropic did not share the translation
bug.

`toResponsesInput` now maps both `system` and `developer` to Responses role
`developer`, preserving order and authority while leaving ordinary user and
tool-result conversion unchanged. `provider-reasoning.test.mjs` carries the
2.1.260 user-then-system regression shape. The test failed against the old
translator (`user, user`) and passes as (`user, developer`).

## The right gutter is free; the bottom-right corner is the app's toast lane

Measured at 2103×1139 in app-1.44121.4: the sidebar ends at x=297, the transcript
pane runs 297→2103, and the composer column is only 730px wide (812→1542). The
task rail already centres itself in the *left* gutter (297→812), so the right
gutter is the one piece of chrome-free viewport a floating control can take
without a selector into the Code UI.

It is not free all the way down. The app mounts its own toast stack fixed at

```text
right: calc(var(--launch-drawer-width, 0px) + 1rem)   width 360px
bottom: calc(max(var(--dev-dashboard-height, 0px) …))  rect y = 1123
```

growing upward (`flex-col-reverse`), and the composer's own box ends at y=1104.
A control anchored `bottom: 132px` clears both at this height and keeps clearing
them as the toast stack grows, because the stack grows away from the corner.

## The isolated world gets the microphone, but not the network (probed 2026-09-05)

Renderer plugins run in the preload's isolated world, and the two gates that
world sits behind are not the same gate. Probed against app-1.46388.4 on a live
claude.ai Code page:

```text
navigator.mediaDevices.getUserMedia({audio:true})   resolved in 59 ms, track live
MediaRecorder audio/webm;codecs=opus                6 chunks, 21,191 bytes in 1.5 s
AudioWorklet.addModule(blob: URL)                   loaded, frames delivered
navigator.permissions.query({name:'microphone'})    "granted"
enumerateDevices                                    3 inputs, all labelled
fetch('http://127.0.0.1:8789/healthz')              TypeError: Failed to fetch
```

The router was up throughout — `curl` against the same URL returned 200 with
`x-cuimod-router-generation: 5`. So the page's CSP `connect-src` **does** apply
to the isolated world, and its permission prompts **do not**: audio capture
needs no prompt because the app already holds the grant for the origin, and the
capture APIs are reachable directly.

This is the opposite of the clipboard result recorded in `dashboard/main.js`,
where `navigator.clipboard.readText()` silently rejects in this world and had to
be moved to main. Do not generalise from either one — probe the specific API.

Consequence for anything that captures audio: capture in the renderer, ship the
bytes to main over `cuimod.rpc`, and do every network call from main. Note that
`boot.rpc` calls `rawInvoke`, the binding captured *before* `ipcRenderer.invoke`
was wrapped, so payloads sent this way never enter the 300-entry tap ring — a
stream of audio chunks does not pin megabytes of buffers in the renderer.

## Dictation button anchors

```text
button[aria-label="Press and hold to record"]   the mic itself, 20x20
button[aria-label="Dictation settings"]         its sibling, 20x20, +19px right
```

Both are `cds-reset group/btn … shrink-0` in the composer footer, with no
`data-testid` and no stable id (`_r_3b_`, `base-ui-_r_3h_` are React-generated
and change per mount). The aria labels are the only durable hook, and the mic's
label is mode-dependent — it reads "Press and hold to record" in hold-to-talk,
which is the CLI's `voice.holdToTalk` default.

## Claude Desktop's own dictation is Deepgram Nova-3, and it drops the audio

Read out of the live claude.ai chunk `ccc68ce7f-DOvmfWRf.js` (the shell's copy
in `ion-dist` is an older build with different constants — trust the live one).
Dictation opens a WebSocket to Anthropic's own relay:

```text
/api/ws/speech_to_text/voice_stream
encoding linear16   sample_rate 16000   channels 1
stt_provider deepgram-nova3   use_conversation_engine true
endpointing_ms 300   utterance_end_ms 1000
```

Three client-side stops, none of which surfaces anything to the user — the stop
reason is written to a Zustand `lastStopReason` field whose only consumer is the
analytics mapper in `shared-20`:

```text
silenceAutoStopMs   15,000 ms   fires on time since the last INBOUND transcript
maxDurationMs      600,000 ms   plain setTimeout, silent stop
drain after stop     2,000 ms   CloseStream, then force close
```

The 15 s rule is keyed on `lastTranscriptAt`, not on whether you are speaking,
so a thinking pause or a stalled relay releases the mic while the user keeps
talking. Nothing is retained: PCM frames go straight to the socket and are
dropped, so a session that ends early cannot be re-transcribed. Contrast Codex
Desktop, which runs a `MediaRecorder` alongside the stream, persists chunks, and
falls back to a whole-file `POST /backend-api/transcribe` whenever the stream
fails — which is also how it survives past its own 300 s `session_ttl_ms` to a
595 s recording limit.

## The ChatGPT Responses route needs HTTP/2 and an Anthropic heartbeat

Established 2026-09-05 against Claude Code 2.1.260, Node 24.12.0 and the live
`chatgpt.com/backend-api/codex/responses` endpoint. Node's global `fetch`
negotiated `http/1.1` even though a direct TLS probe selected `h2`, and a native
HTTP/2 GET reached the Responses route with the expected 405. One Astra SSE
stream on the old fetch path died at 901.284 seconds — effectively the route's
15-minute HTTP/1.1 lifetime — while shorter connections also reset at irregular
intervals. The OpenAI inference and compaction paths now use `node:http2`; local
HTTP fixtures deliberately retain fetch so the ordinary integration suite stays
credential-free.

The translator is a second liveness boundary. OpenAI can keep its stream alive
with events that have no Anthropic equivalent, and `ResponsesToAnthropic` drops
them. Two real Astra responses therefore tripped Claude Code's roughly five-minute
stream watchdog while OpenAI continued and completed 67.249 and 79.175 seconds
later. An Anthropic `ping` every 30 seconds of downstream silence prevents that:
a local Claude Code test with a reduced watchdog failed after 10.017 seconds
without pings and completed after 12.052 seconds with 300 ms pings.

Transport loss has to respect content already released. A completed function-call
item is executable before OpenAI sends `response.completed`; replaying it can run
the tool twice. If every tool block is closed, the translator now synthesizes the
normal `tool_use` terminal sequence. Thinking-only and incomplete-block failures
break the downstream socket so Claude Code's native connection retry owns them.
Provider-declared `response.failed` events remain explicit in-band errors.
Finally, both streaming and buffered paths cancel the upstream reader as soon as
a terminal Responses event arrives. Waiting for HTTP EOF after
`response.completed` previously let a late transport reset contaminate an already
complete turn.

### Stream errors have a non-streaming diagnostic replay

Measured against Claude Code 2.1.260 with a loopback Messages provider. After a
valid streaming response emits an Anthropic `error` event, Claude Code immediately
replays the same request with `stream:false` so it can obtain a stable HTTP status
and JSON error for Desktop. The replay response, not only the in-band event type,
decides whether the failure is displayed or retried.

A provider-declared failure was previously collected into an `upstreamFailure()`
whose status was unconditionally 502. Claude Code correctly treated that
diagnostic response as transient and retried for several minutes. Ordinary
`invalid_prompt` and `invalid_request_error` failures now remain permanent HTTP
400 errors; rate-limit failures remain 429, and unknown/provider-server failures
remain retryable 502s.

Cybersecurity safeguards use a different Claude Code protocol. The native notice
is activated by a successful Anthropic message ending with `stop_reason:
"refusal"` and `stop_details: { type: "refusal", category: "cyber", explanation:
... }`. It is not activated by an HTTP 400 or by matching error prose inside the
client. The OpenAI translator maps the observed ChatGPT cybersecurity
`response.failed` message to that terminal shape in both stream and nonstream
modes. A Desktop-owned Claude Code 2.1.260 loopback probe emitted
`model_refusal_no_fallback` with category `cyber`, rendered the built-in cyber
safeguards message, and made no diagnostic replay.

## The task pane's auto-open is the Plan pane, one-shot per session (2026-09-05)

The pane that throws itself open the first time a session produces tasks is the
**Plan** pane, not the "Background tasks" pane, and the effect that opens it is
`fT` in live chunk `c5610fbe3` (claude.ai bundle `index-BhceMCtx.js`, read
2026-09-05):

```js
function fT(e){let t=(Fe("epitaxy_plan_pane_auto_open")?e:null)?.id,n=nf(),
  r=df(e=>t!==void 0&&!!e.planAutoOpenedBySession[t]), ...
  R(()=>{ if(r||!t||!n) return;
    ...
    let f=d&&i.nonEmpty&&o===i.first&&s>i.live,   // same turn, transcript growing
        p=!i.hadTodos&&l;                          // todos went none -> some
    !(!p||!f)&&(pf(e,t,"plan")||(su(e,"plan","auto"),e.setSidePane("plan")),
                e.markPlanAutoOpened(t))},[o,s,l,c,r,t,n])}
```

Three facts follow, and they are what make the behaviour hard to reproduce:

- It is **one-shot per session**, recorded in `planAutoOpenedBySession`. Adding a
  task to a session that has already had one does nothing, so a probe that
  creates a task in the session it is running in never sees it. Emptying
  `~/.claude/tasks/<cliSessionId>/` does not reset it either — the record is in
  the pane store, not on disk.
- It needs a **live turn**: `s > i.live` compares the transcript length against
  the previous render, so it only fires while messages are arriving.
- `Fe("epitaxy_plan_pane_auto_open")` gates it, so it can vanish with a flag
  flip rather than a bundle change.

Suppressing it does **not** need the call site blocked. `planAutoOpenedBySession`
is read by this effect and by nothing else — every other mention across the
bundle is persistence, session teardown, or a store equality check — so calling
`markPlanAutoOpened(currentSessionId)` ahead of the app disables exactly this
one behaviour and nothing near it. `task-rail/main.js` does that.

Two dead ends recorded so they are not walked again:

- `openTasksPaneAtTask` looks like the auto-open and is not. Its only callers are
  click handlers — the task chip, the tool row, the task link (chunks
  `c03935b01`, `cd5a31703`) — so wrapping it breaks every deliberate open and
  suppresses nothing.
- Grepping `ion-dist` for the pane is worthless twice over: the chunk ids match
  the live bundle, so a hit proves only that the shell shipped a copy of the same
  code, and the live UI is served from claude.ai anyway.

Getting the live chunk list: `document.scripts` shows one entry and
`performance.getEntriesByType('resource')` is evicted within minutes. What works
is `wc.debugger.attach('1.3')` then `Debugger.enable` from the main process —
`Debugger.scriptParsed` replays for every already-parsed script, which gave 517
URLs against the 76 reachable by following static `./chunk.js` strings from the
entry.

## Subagents cache at 5m while the main thread caches at 1h (claude 2.1.260)

Every Desktop session runs its own CLI copy, and the prompt-cache TTL that copy
picks is not the same for the main conversation and for everything it spawns.
On a subscription the main thread gets a 1-hour cache; subagents, workflows,
background and helper requests get five minutes. Nothing in this repo chose
that, and until it is overridden it is the single largest source of wasted
tokens in a fan-out session.

The resolver, `Tnr`, in precedence order:

```js
function Tnr(e,n,r=!1){
  if(a.FORCE_PROMPT_CACHING_5M) return {ttl:"5m",reason:"force_5m_env"};
  let o=wZo(e), d=o?a.CLAUDE_CODE_PROMPT_CACHE_TTL:a.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL;
  if(d!==void 0) return {ttl:d,reason:"env"};
  let p=Ge(), y=o?p.promptCacheTtl:p.subagentPromptCacheTtl;
  if(y!==void 0) return {ttl:y,reason:"setting"};
  if(n!==void 0&&!(n==="1h"&&r)) return {ttl:n,reason:"agent_frontmatter"};
  if(a.ENABLE_PROMPT_CACHING_1H||...) return {ttl:"1h",reason:"enable_1h_env"};
  return }
```

`o` is "is this the main thread", `n` is the agent's frontmatter `cacheTtl`, and
`r` is set when the account is in overage. When `Tnr` returns nothing the caller
decides, and that is where the asymmetry lives:

```js
if(!o||d) return {ttl:"5m",reason:"default"};
let y = ... P("tengu_prompt_cache_1h_config",{allowlist:[...z_t]}).allowlist ?? [];
return q_t(e,y) ? {ttl:"1h",reason:"subscriber"} : ...

z_t = ["repl_main_thread*","sdk","auto_mode","memdir_relevance"]
```

`q_t` matches the query source against that list, `*` as a prefix wildcard. A
Desktop Code session arrives as `sdk` and is allowlisted, so it caches for an
hour with `reason:"subscriber"`. No subagent query source is on the list, so
each one falls through to the `5m` default. The allowlist is served by a remote
config key, so it can widen without a release — do not treat the local default
as the whole truth, read the reason on a live request if it matters.

Facts worth keeping:

- **The env form is the only override that survives overage.** Overage disarms
  the automatic 1h and the frontmatter route (`!(n==="1h"&&r)`), but not
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` or `subagentPromptCacheTtl`. This repo
  sets the env form in `~/.claude/settings.json`.
- **`CLAUDE_CODE_SUBAGENT_CACHE_EVICT` is the wrong direction.** It forces on a
  gate that adds the `prompt-caching-evict-2026-05-12` beta to subagent queries
  carrying `evictCacheOnComplete`, releasing their cache at completion. Off by
  default via `tengu_subagent_cache_evict`. Leave it off.
- **A 5m entry cannot survive a slow tool call.** Break-even against a 1h write
  is the second use: 5m costs 1.25x per write, 1h costs 2x per write, a read
  costs 0.1x, so one rewrite (2.50) already loses to write-then-read (2.10).

Measured before the override, `claude` lane, 2026-09-03 through 09-05, 6265
requests and 35.41M cache-write tokens, from `provider-accounting-v2`:

```text
read 60k+     5776 reqs   12.78M written    healthy per-turn deltas
read 1-60k     258 reqs   17.09M written    prefix rebuilt from the shared head
read 0         256 reqs    5.60M written    nothing reused
```

4% of requests carried 48% of the write volume, and the large writes are
predominantly 5m entries (11.64M of the 19.06M written by requests over 100k).
One orchestration session accounted for 13.33M of the three-day total on its
own; none of its large writes appear among the request ids in its main
transcript, which is what identifies them as subagent traffic recorded under the
parent session id.

One thing that is *not* a problem, checked because it looks like one: the first
system block Claude Code sends is an `x-anthropic-billing-header:` line whose
`cch` and `cc_prev_req` fields change on every request, and it sits ahead of both
cache breakpoints. It costs nothing. Anthropic hit rates over the same window
were 97.0% and 97.8%, so the endpoint is not folding that block into the
breakpoint prefix. The OpenAI lane removes it outright — `CLIENT_IDENTITY` in
`router/openai.mjs` strips the line before `instructions` is built, which also
keeps `conversationKey` stable across a session.

## Desktop runs its own CLI copy, and an update deletes the old one (app-1.46388.4)

Desktop Code sessions do not run the CLI on `PATH`. Every session process is
`%APPDATA%\Claude\claude-code\<version>\claude.exe`, a copy the app downloads,
verifies and version-pins itself, separate from `~/.local/share/claude/versions`
used by the terminal CLI.

Updates install a new version directory beside the old one and then remove the
old one:

```text
2026-09-01 16:16:33  falling back to installed version 2.1.222
2026-09-01 16:16:59  installed 2.1.255
2026-09-01 16:16:59  removing old version 2.1.221
2026-09-01 16:16:59  removing old version 2.1.222
```

from `%LOCALAPPDATA%\Claude\logs\main.log`. So **any edit to that binary is
lost at the next CLI release**, silently, with no failure anywhere. A pronoun
substitution patched into the `pronouns` prompt section — string `RJo`, emitted
by `Jh("pronouns",()=>RJo)` — disappeared exactly this way. The durable place
for that kind of change is a router prompt policy.

Patching it is not *detected*, only outlived: `binaryExistsForTarget` compares
the `.verified` marker against the manifest checksum of the compressed download,
never against the local file, and `checkCachedBinaryHeader` returns true
immediately for any platform that is not `darwin-*`. An in-place edit therefore
survives every restart of the same version and nothing else.

## Auto-compact policy is not worker state (CLI 2.1.260)

The only established local-Desktop observation is
`LocalSessions.getContextUsage(local_<uuid>)`. It sends worker control subtype
`get_context_usage` and returns the worker's own `model`,
`isAutoCompactEnabled`, `rawMaxTokens`, `autoCompactThreshold`, and
`autocompactSource`. The desktop id is the URL id, not the bridge CLI id.

A per-model dashboard policy is only a launch policy until this query reports
it. CUIMOD injects `--autocompact <window|auto>` and inline session settings at
Desktop's spawn boundary. A resumed CLI session may also carry a persisted
per-session override keyed by its CLI id. The panel must show configured policy
and observed state separately, with no fallback arithmetic.

The dashboard's main-process store is the launch authority after it has loaded
or accepted a save. The spawn wrapper reads that shared object before consulting
`.state/settings.json`. This is required because the renderer paints its new
value before the save reply, and an atomic write can fail while the old file
remains valid. A captured fresh launch at 2026-09-07 22:21 local had
`--autocompact 400000` but `autoCompactEnabled:false`; the settings file did not
receive the later enabled value until 22:32. Reading only the valid but older
file reproduced the split where the dashboard said On and the worker launched
Off. Immediate flush failures now reject `dashboard.save` rather than producing
a false Saved acknowledgement; the accepted in-memory value still governs a
launch in the same Desktop process.

`DISABLE_AUTO_COMPACT` is unsuitable for default-off when a session needs a live
opt-in. It short-circuits `autoCompactEnabled` before the worker reads session
settings. CUIMOD therefore starts new workers with
`autoCompactEnabled: false` and removes both `DISABLE_AUTO_COMPACT` and
`DISABLE_COMPACT` from the child environment. The bottom-bar control reaches
only the named session's internal `query.applyFlagSettings()` method with
`autoCompactEnabled` and `autoCompactWindow`. It first mirrors the patch into
that session's `sessionSettings` and calls the manager's save/update lifecycle;
without that, a later focus reconciliation replays stale launch values. It waits
for `get_context_usage` before repainting as changed. Desktop's public
`LocalSessions.applyFlagSettings` filters `autoCompactWindow` on app 1.46388.4,
so the internal query is the required narrow seam.

### The window is not changeable through apply_flag_settings (CLI 2.1.260)

Read out of the embedded source in the Desktop-owned `claude.exe` 2.1.260, which
is bun-compiled but ships its minified JS in the clear.

`Cb(model, configured)` resolves every effective window. Its `configured`
argument is `appState.autoCompactWindow` at every live call site: the per-turn
query options are rebuilt from `n.appState.autoCompactWindow`, and the
`get_context_usage` payload is built with `configuredWindow: u.autoCompactWindow`.
`appState.settings.autoCompactWindow` is read nowhere in the binary.

An inbound `apply_flag_settings` control request ends at
`SQ(Ut)` = `settingsSource.replaceFlagSettingsInline(...)`, then
`wl.notifyChange("flagSettings")` → `dst()`, which assigns `T.settings = Ge()`
and leaves `T.autoCompactWindow` alone. So the request lands in a layer nothing
re-reads for the window after startup. `--autocompact` is read exactly once, at
`y4n(flag, Ge().autoCompactWindow)` during app-state construction, and the flag
outranks the settings value.

The only post-startup writer of `appState.autoCompactWindow` is the reducer
`m_e`, reached only from `onQueryEvent({type:"apply_flag_settings"})` — an event
the worker raises to itself, from the `/autocompact` local command. That command
is not reachable in a Desktop worker. Two commands are registered under the name,
and the resolver is a plain first-match with no enablement filter:

```js
function Pi(e,n){let r;return n.find((d)=>{if(d.name===e)return!0;...})??r}
```

The table is `[... Cor, Xbt, Uor, rHe, ...]`, and `Uor` — `type:"local-jsx"`,
`isEnabled:()=>!Re()` — sits ahead of the headless `rHe`. In a `stream-json`
worker the name resolves to the interactive-only entry, which is disabled there.

So nothing changes a running worker's `appState.autoCompactWindow`, and a worker
launched with a number is fixed for its whole life.

### The clientdata branch is real, and still out of reach

`Cb` falls through to `z7r(model)` → `Rer()` → `ee().autoCompactWindowsCache`,
read on every call and reported as `source:"clientdata"`. Measured on the real
2.1.260 binary with `scripts/auto-compact-window-probe.mjs`: a worker launched
with `--autocompact auto` and a seeded `autoCompactWindowsCache` reported
`rawMaxTokens: 210000`, `autoCompactThreshold: 177000`, `autocompactSource:
"clientdata"`. `Rer()` requires `Ie()==="firstParty"`, which holds because the
spawn sets `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`.

Two measurements close it as a live lever anyway.

**The cache is an in-memory snapshot.** Rewriting `autoCompactWindowsCache` in
the worker's own `.claude.json` — the file `ee()` is backed by — changed nothing
across a subsequent turn: same PID, still 210000. External writes to that file
do not reach a running worker.

**The bootstrap fetch does not go through the router.** The fetch's main branch
is `d(Vt().BASE_API_URL, C)`, and `Vt()` is a frozen prod table with
`BASE_API_URL: "https://api.anthropic.com"`, overridable only by
`CLAUDE_CODE_CUSTOM_OAUTH_URL` against an approved-endpoint allowlist. Only the
WIF branch consults `ANTHROPIC_BASE_URL`. So serving `auto_compact_windows` from
CUIMOD's router is inert; the client-data slots in `~/.claude.json` were fetched
straight from Anthropic. A router-side bootstrap merge was built on this and
reverted — do not rebuild it.

The only in-session caller of `refreshBootstrapData` is the ATIS pin path, gated
on `P("tengu_expressive_whistle", false)` and rate-limited to a 300 s minimum.
Everything else fetches once at startup.

### Custom agents must use the adapter's bare model id

Measured on CLI 2.1.260 with one adapter-backed model. A fresh custom agent using
its bare id plus `CLAUDE_CODE_MAX_CONTEXT_TOKENS=500000` and `--autocompact
400000` reported `effectiveWindow=380000` in the debug log. The same model and
route under its accepted `claude-` compatibility alias reported 180000. The
prefix activates the unknown-Claude-model guard and silently outranks the
configured launch window. Agent definitions therefore use the bare adapter id;
a prefixed alias may remain a routing compatibility spelling, but it is not an
agent-definition spelling.

### Native subagents inherit the window, then lose to their model cap

Source-verified against CLI 2.1.260 and measured on 2026-09-13. The Agent child
option builder copies the parent's `autoCompactWindow`; there is no separate
200k subagent policy. The effective-window resolver then returns
`min(modelAssumedContextWindow, configuredAutoCompactWindow)`. A custom child
model that Claude Code assumes is 200k therefore compacts near 167k even when it
correctly inherited a 400k policy.

`[1m]` is the model-id declaration that makes Claude Code assume a 1M context.
The router strips the tag before provider dispatch, so it changes local context
accounting rather than upstream model selection. A disposable loopback worker
using `claude-gpt-5.6-luna[1m]:high` reported `rawMaxTokens: 1000000` and an auto
threshold of 967000. With the inherited 400k policy, the same resolver yields a
367000 threshold. Use the tag only for a backend whose real context is at least
1M.

One live native orchestration made the miss visible: its root compacted near
371k, while 75 successful child compactions had a 170113-token median trigger.
The median child compaction took 254 seconds. One child auto-compaction lost its
connection and stopped the task; same-id continuation recovered its transcript
and later compacted successfully.

An active Agent child cannot be retargeted through the supported parent surface.
Its resolved model is captured when the child query is constructed. Agent's
optional `model` is launch input only; `SendMessage` queues ordinary task text,
profile edits are not retroactive, router rewriting happens after the local
window decision, and `/model` while viewing a child targets the main
conversation. Claude Code has an internal `set_model` control for the query that
owns a reachable control transport, but Desktop exposes no child-query address.
Same-id resume preserves transcript lineage and saved options, not the exact
active tool loop and not a new model override. A guaranteed tagged child thus
requires a fresh Agent invocation from a session that loaded the tagged profile;
do not claim a lossless live upgrade.

### An agent with no `model:` resolves through CLAUDE_CODE_SUBAGENT_MODEL

Read from the CLI 2.1.280 binary on 2026-09-24 (the child-model resolver that
also emits `family_step_down`/`parent_inherit`). The child model is chosen in
this order:

1. the Agent tool's `model` argument;
2. the definition's `model:`, where `inherit` means the parent's model;
3. with no `model:` at all, `CLAUDE_CODE_SUBAGENT_MODEL`, and the parent's model
   only when that variable is unset or `inherit`.

Explore, Plan and fork declare `model: "inherit"` and never reach step 3.
Explore additionally caps at the Opus tier under a stronger parent unless
`CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP` is set. The built-in `claude`
catch-all and `workflow-subagent` declare no model, so step 3 applies to them.
The same is true of a markdown agent whose frontmatter omits `model:`. Its
system prompt is its trimmed markdown body; there is no wrapper text.
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is a separate variable that overrides even
workflow agents' explicit models; it is not used here.

provider-routing sets `CLAUDE_CODE_SUBAGENT_MODEL` per launch from the launch
model, which is why `~/.claude/agents/general-purpose.md` pins nothing. The
variable is deliberately absent from `settings.json`. The CLI assigns settings
env over `process.env`, but its filter also takes a host-spawn key set. That
matches this file's observation that Desktop's launch `ANTHROPIC_BASE_URL`
beats `settings.json`. Whether a settings value would lose to the launch value
for this key has not been measured. The value is fixed at spawn, like the
routed helper model. A later provider switch in the same session keeps it.
Terminal CLI sessions are not launched through the plugin. Their unpinned
agents inherit the parent's model.

### A tool loop can live inside one assistant response

Measured on 2026-09-10 through one Anthropic-compatible adapter. One upstream
SSE response emitted 269 tool-use blocks with the same tool name and canonical
arguments, changing only the call id. Claude Code executed every block while the
response remained open; all 269 local results were byte-identical, but none could
be sent back to the model because there was no next provider request yet. The
single response ran for 526 seconds and produced 52,043 output tokens. This is
not a cross-turn loop, so inspecting request history cannot stop it.

`pipeAnthropicBody` therefore has an adapter-opted duplicate-call guard. It holds
each tool block only until its argument JSON is complete. The first signature is
released normally. A second byte-identical signature is withheld, the upstream
reader is cancelled, and the downstream message gets a valid `tool_use`
terminal so the first call's result can drive a fresh response. Distinct calls in
the same parallel batch still pass. A cancelled response has no provider terminal
usage, so it creates no falsely exact accounting row; the adapter log records the
response id and tool name without arguments or results.

### The clientdata lookup key is the raw --model string

Measured by serving each candidate spelling a different window and reading back
which one landed. For `--model claude-gpt-6-astra[1m]`, with
`claude-gpt-6-astra[1m]` → 210000, `claude-gpt-6-astra` → 220000 and
`gpt-6-astra` → 230000 all present in the record, the worker reported 210000.
For `claude-opus-5` against `opus-5`, the prefixed spelling won the same way.

The key is the exact string passed to `--model`, decoration included — neither
the bare id nor the `claude-` stripped form. Anything keyed by model here has to
use that spelling.

### A running worker's window changes through settings.env

`apply_flag_settings` with `settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` moves a
live worker, no restart and no transcript turn. Measured on a disposable 2.1.260
worker launched at `--autocompact 400000`, one PID throughout:

```
launch                 400000    threshold 367000    source settings
env "1000000"          1000000   threshold 967000    source env
env "400000"           400000    threshold 367000    source env
```

Both control requests answered `success`, and every number above is the worker's
own `get_context_usage` readback, not the acknowledgement.

The route is the resolver's own precedence. `Cb(model, configured)` tests
`process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` in its first branch and returns
from there, before it ever consults the `configured` argument that carries
`appState.autoCompactWindow`. An inbound patch's env reaches Bun's `process.env`
through the settings-change handler `dst()`, whose first statement is `hme()`.
So the appState field stays stale and irrelevant — the env branch outranks it.

This is the compaction consumer, not only the display. `tF(e,n)` computes the
threshold as `Cb(e,o).window` minus the native reserve; the gate `Qee` passes
`tF(n,p)` as its threshold, and the compaction run itself passes
`autoCompactThreshold: $Se(k,v)` = `CCe(tF(...), ...)`. Native model limits
(`Oen` → `Tf`) are untouched. Confirmed during a controlled ongoing tool loop:
with the worker mid-loop the reported pair moved from 400000/367000 at source
`settings` to 1000000/967000 at source `env` between inference 2 and inference 3,
and held across inferences 4–9 while the loop kept running.

`scripts/auto-compact-env-route-probe.mjs` is the maintained harness.

### Auto-compact fires inside the tool loop, and the turn carries on

Measured with `scripts/auto-compact-fires-probe.mjs` on a disposable worker
running `claude-gpt-6-astra[1m]` with an env window of 100000 (threshold 67000).
Four real exchanges built 60682 tokens of history, then one long working turn ran
a tool loop. The gate is evaluated on every API round -- the debug log shows a
`level=warn` line per round -- and on the round the count crossed 67000 it logged
`level=compact`, routed through reactive, and compacted. The frame timeline reads

    user:tool_result, status, status, compact_boundary, user:text,
    assistant:text, result

all inside the same working turn, with no input sent. Context went 60682 -> 2438.
So an unattended session compacts itself mid-loop and keeps going; it needs
neither a user message nor an external watcher. The `unrecognized_model` warning
a routed id produces does not disarm it.

### Reactive compaction bails on a conversation with no shape, and 3 bails are fatal

Any explicit window -- `env` or `settings`, since `Q0e` counts both as non-auto --
routes compaction through the reactive path:

    if(o!==void 0 && U!=="auto" && JO()){ ...routing through reactive... }

That path refuses a conversation it cannot summarize, logging
`Reactive compact: fewer than 2 groups, nothing to compact` or
`no assistant messages in summarize set, bailing`. Each refusal counts as a
failure, and `nut` opens a breaker at three:

    if(d?.consecutiveFailures>=O8n) return {kind:"failure_breaker_open"};

That breaker is session-lifetime -- `circuit breaker tripped after 3 consecutive
failures (reactive path) - skipping future attempts this session`. A real working
session has groups and assistant messages long before it approaches a threshold,
so it does not bail; a probe that feeds one enormous user message does, and three
earlier readings of this mechanism were wrong because of exactly that. If a live
session ever stops compacting, that breaker line in the worker's debug log under
the config dir is what to look for, and only a new worker clears it.

`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is not an alternative lever here: set to 100000
against `claude-gpt-6-astra[1m]` the worker still reported `rawMaxTokens 1000000`
at source `auto`, so the model ceiling resolver ignores it for this model.

### Enablement is live too, and a disabled worker reports no threshold

`Kd()` resolves enablement as `ken() ? false : wo("autoCompactEnabled", !0).value`,
where `ken()` is `Boolean(Pe(process.env.DISABLE_COMPACT) || a.DISABLE_AUTO_COMPACT)`.
The settings lookup sees the inline flag layer, so `apply_flag_settings` with
`autoCompactEnabled` moves a running worker. Measured on one PID launched off:
false → true → false → true. The env kill switches are a second live lever on the
same PID — `"1"` disables, `""` re-enables — but `DISABLE_COMPACT` also gates the
manual `/compact` command, so CUIMOD only ever clears them (on enable) and never
sets one. `ken()` short-circuiting is why clearing matters: a kill switch
inherited at spawn makes `autoCompactEnabled: true` inert.

`getContextUsage` omits `autoCompactThreshold` entirely while auto-compact is
off. Measured on a live Desktop session: `enabled false, rawMaxTokens 1000000,
autocompactSource "env"`, no threshold key; flipping it on produced `967000` and
flipping it back off removed it again. Any validator that requires the threshold
rejects the whole payload for a disabled worker — which is every CUIMOD session
at launch, since the launch policy is default-off. That bug hid the panel's own
controls on exactly the sessions that needed them.

The Desktop-side plumbing was verified against a live session rather than assumed:
`claudeCodeSessionManager` resolves out of `require.cache` at
`index.chunk-C3QMBIW4.js`, the session object carries `query.applyFlagSettings`,
and a behaviour-neutral patch (the same window the worker already had) moved
`autocompactSource` from `auto` to `env` with window and threshold unchanged.
Note that `sessionSettings` is absent from a live session object, so the mirror
CUIMOD writes there creates the field rather than updating one.

The retired belief was that nothing reaches a running worker's window. That was
wrong, and it came from testing the wrong environment layer — the four levers
below and the native-env injection are all genuinely closed, but none of them is
this one.

### The eliminated levers

Four independent levers, all eliminated:

- `apply_flag_settings` stops at `replaceFlagSettingsInline`, and no settings
  layer is read for the window.
- `/autocompact` resolves to the interactive `local-jsx` entry, which is
  disabled in a headless worker.
- the clientdata cache is an in-memory snapshot, and the fetch that refills it
  bypasses the router.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` outranks all of them in `Cb`, but the worker
  never reads it live — see below.

### The env var is never read natively, proven by injection

`scripts/auto-compact-env-hook-probe.py` attaches Frida to a disposable worker's
PID and hooks all thirteen native env accessors —
`GetEnvironmentVariableW/A` in `kernel32`/`kernelbase`, and `getenv`/`_wgetenv`/
`getenv_s` in `ucrtbase`/`msvcrt`/the CRT api-set. It then drives three
`get_context_usage` calls and a real turn while trying to inject a value for
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`.

All thirteen hooks install (`hookErrors: []`), and across every resolution and
the turn the worker makes **zero** native env reads of any key
(`anyNativeEnvReadsSeen: false`). Bun serves `process.env` from a startup
snapshot in its own store; the resolver never calls libc or Win32 env at
runtime. A native env hook — the cheapest native-hook lever — cannot influence
`Cb`, and this is measured on the real 2.1.260 binary, not inferred.

That closes the *native* env layer and nothing more. A JS-side write into Bun's
own `process.env` store is a different layer and is observed on the next
resolution, which is what `settings.env` reaches — see above. Do not re-run this
injection to answer the window question; it answers a question about libc.

`autocompact_state` is a CCR/remote-worker frame. Its producer is gated on
`CLAUDE_CODE_REMOTE`; normal local `stream-json` output does not expose it. Do
not add a local Desktop dashboard dependency on that frame without a measured
Desktop transport path.

A disposable loopback-only probe against the Desktop-owned 2.1.260 binary
verified the launch path without touching a Desktop session: `--autocompact
400k` reported `rawMaxTokens: 400000`, `autoCompactThreshold: 367000`, and
`autocompactSource: "settings"`; both `autoCompactEnabled: false` and
`DISABLE_AUTO_COMPACT=1` reported `isAutoCompactEnabled: false`. The maintained probe is
`scripts/auto-compact-worker-probe.mjs`; it refuses to run without
`CUIMOD_WORKER_PROBE=1` and uses a fresh no-persistence worker plus an in-process
loopback stub.

## Every transcript line that produces content carries a uuid (CLI 2.1.222)

Measured over a live session jsonl: of 54 lines, 9 had no `uuid`, and every one
of those was a bookkeeping type the transcript export already skips —
`queue-operation`, `last-prompt`, `custom-title`, `atis-latch`. All `user`,
`assistant` and `attachment` lines carried both `uuid` and `parentUuid`.

That makes `uuid` the only stable per-entry identity in the file. Line ordinals
are not: compaction rewrites the transcript, and a byte offset or line number
taken before it points somewhere else afterwards. Anything that has to name a
position in a transcript across time — the delta export's resume anchor is the
first — must key on the uuid and look the ordinal up fresh each read.

A single line can produce several exported entries (an assistant line is
routinely `thinking` plus `text` plus one `tool_use`), so a position inside a
line is `uuid` plus the index of the content block, not the ordinal of the
entry in the export. The block index survives an export option changing between
two reads; the entry ordinal does not.

## Transcripts repeat themselves enough to defeat containment matching

Relevant to anything that tries to locate a position in a transcript by its
text rather than by its uuid — the delta export does this, because the text is
all it has when the position it needs is the end of something already pasted
into another window.

Measured across eight real sessions (429 to 3,837 lines), asking "which is the
newest entry whose body appears in this earlier export" put the answer up to
eleven entries too late. Sessions re-read the same file, re-run the same
command, and carry the same injected reminder repeatedly, so an entry recorded
*after* a cut is routinely found in text that only ever contained its earlier
twin.

Matching in order fixes it: each entry must match at or after where the
previous one matched, so a twin sitting earlier than the cursor is not a match.
Two further rules were each forced by a measured failure, not anticipated —
a chain must be seeded by two consecutive hits before it earns any tolerance
for missing entries, or one coincidence inherits the real chain behind it; and
a chain must not *end* on a short prefix of a much longer body, which is where
the eleven-entry over-run came from. With all three, the same sweep loses
nothing across 440 cases.

## The composer band anchors moved (measured 2026-09-06, app-1.46388.4)

`.epitaxy-composer-aux-view` and `.epitaxy-composer-band` are gone. Zero
matches in the live DOM, and neither string appears anywhere in the claude.ai
bundle the page loads (`index-BhceMCtx.js` and its 2,088 chunks). Anything
scoped to them selects nothing and fails silently — `hide-usage-band` stopped
hiding anything this way, with `apply()` still reporting success.

What is there now, in the composer container that parents `.epitaxy-prompt`:

```
nav[aria-label="Repository and pull request controls"]   the aux-row stack
  div.…bg-alpha-1.@container/branch-row                  branch / PR / commit
div.epitaxy-prompt                                       the rounded input box
div.w-full.flex.items-center.gap-xs                      footer row
```

The limit band itself renders from one component, read out of the bundle:

    div{role:"status", aria-live:"polite",
        class:`${bg} items-start py-[…] text-body epitaxy-band-enter`}

`epitaxy-band-enter` is the only named class on it and the only occurrence in
the whole bundle, so it is the anchor. `role="status"`+`aria-live="polite"` is
not — four sr-only live regions match that pair in an idle window.

Its wordings are a message/detail table in the same chunk, and they are wider
than "weekly limit reached": session, `{model}`, spend cap, org spend cap, out
of credits, seat tier, "Now using usage credits", "You've used {pct} of your
{model} limit", "Approaching weekly usage limit". Match against that table,
not against a guess.

Scope before matching text. Session titles in the sidebar hit limit wording
often enough to be caught by an unscoped sweep — two false positives in one
probe of this repo's own session list.

Collapsing the container needs `display: none`, not zero height: the composer
stack is `flex flex-col gap-1.5`, so a present-but-empty nav still contributes
its 6px gap above the prompt.

Verified by injecting a synthetic band with the real markup into the live nav:
40px and visible before, `display: none` after, branch row untouched; and with
the band as the nav's only row, the nav itself goes to `display: none`.

## Desktop bans SendMessage outright; harbor-kite is a separate lever (2026-09-06)

Two independent mechanisms remove agent-to-agent messaging, at different
layers. They produce the same felt symptom — `SendMessage` is not there — so
they get confused for each other.

**1. Desktop's spawn options.** The local session manager ends its
options chain with an unguarded append (app-1.46388.4,
`.vite/build/index.chunk-C3QMBIW4.js` @556936, with `xu = "SendMessage"`
@262966):

    o.scheduledTaskId && (U.disallowedTools = ["AskUserQuestion"]),
    (…)?.sharedCheckout && (U.disallowedTools = [...U.disallowedTools ?? [], ...Xf]),
    U.disallowedTools = [...U.disallowedTools ?? [], xu];

No condition — not session type, not scheduled task. app-1.46388.3 has the
same statement with different minified names (`W`, `bu`), so this is not a
rollout and never was: the tool has never existed in a Desktop Code session.

The failure is silent in a specific way. `disallowedTools` becomes a deny
rule, and the CLI's `dD()` drops a denied tool inside `XA()` *before* deferred
classification, so the name never reaches ToolSearch's pool. `select:SendMessage`
answers "No matching deferred tools found" — the shape of a missing feature,
not of a policy decision.

**The ban is doubled.** A `PreToolUse` hook in the same chunk (@281943)
matches the tool name and returns deny:

    if (!Ou.includes(e.tool_name)) {
        if (e.tool_name === "SendMessage") return t.ox(…, {reason: "cli_native_send_message"}),
            {hookSpecificOutput: {…, permissionDecision: "deny",
             permissionDecisionReason: `Use ${n.Rn} … the CLI-native ${xu} tool is
             unavailable here (terminal sessions outside Claude Desktop are not
             reachable from this session).`}};

It never inspects `to`. A send to an in-process subagent or a teammate — which
involves no other session at all — is refused with a message about terminal
sessions. So lifting only the registry ban makes the tool appear and every call
fail; that is exactly what happened here on the first pass. The two layers are
independent and both must go.

`patch.js` does both. It matches statement shape and resolves the
`"SendMessage"` literal from the same chunk (every identifier is minified per
build), neutralises the deny *condition* rather than excising the branch — a
dead `if (false)` is equivalent and needs no brace or template matching — and
asserts exactly one site each, so a reshape fails the patch loudly instead of
quietly restoring half the ban. With the condition dead, SendMessage falls
through the same chain as any other tool: `n.Jn` still refuses it in a
remote-dispatched tree, and the directory pre-card still runs.

Resume goes through the same options function (`U.resume = s.cliSessionId`
@559241, same object), so the baked fix also applies when an old session is
reopened.

**The call-time half can be lifted hot.** Every running Desktop session holds an
SDK `Query` at `claudeCodeSessionManager.sessions.get(id).query`. On 2.1.260 it
carries both the authored hooks and the callback-id registry:

    query.hooks.PreToolUse[]                 { matcher, hooks: [function] }
    query.hookCallbacks                     Map("hook_2" -> function)
    query.initHooksPayload.PreToolUse[]      { matcher, hookCallbackIds: ["hook_2"] }

The blanket Desktop callback is identifiable by its own
`cli_native_send_message` telemetry marker. Replacing the function behind that
callback id with a wrapper that answers `{}` only for
`PreToolUse` + `SendMessage` changes a running CLI process immediately — no app
restart, process replacement or control request. The tool call that had returned
Desktop's deny then reached the CLI's recipient resolver instead; a cross-session
SendMessage also delivered successfully. On the measured app generation, all
8 live Query objects were patched: 16 locations total because each function is
held in `hooks` and `hookCallbacks`.

`src/plugins/sendmessage-unban/main.js` owns that hot path. It patches every
existing Query immediately, scans for a late-initialising Query every 500 ms,
and wraps `PermissionBroker.prototype.createBaseHooks` so newly spawned sessions
start clean instead of spending one tick denied. Wrappers live in a symbol-keyed
global registry: the replacement host generation claims them before the prior
one disposes, so hot reload has no deny-shaped gap; a real plugin unload restores
every function and the prototype. The baked `patch.js` edit remains necessary
for the registry half — a Query whose CLI was spawned with SendMessage already
removed cannot have that registry reconstructed by replacing a hook callback.

Nothing substitutes for it. `mcp__ccd_session_mgmt__send_message` addresses
Desktop *sessions*; SendMessage addresses *agents* — in-process subagents,
teammates, `main`. No other path reaches those.

**2. `tengu_harbor_kite`.** A server-configured gate that removes cross-session
messaging as a capability, with a Windows-only variant that can turn it off for
one platform (claude 2.1.260 @183438174):

    function Mo() {
        let e = a.CLAUDE_CODE_HARBOR_KITE;
        if (e !== void 0) return Pe(e);
        if (I() === "windows" && !P("tengu_harbor_kite_win", !0)) return !1;
        return P("tengu_harbor_kite", !0);
    }
    var xXe = "Cross-session messaging is not available in this session.";

`Mo()` gates the cross-session sections of the SendMessage and ListAgents
descriptions; when it is false the tool still exists. `DISABLE_GROWTHBOOK=1`
(added to user settings 2026-09-05) makes both `P(...)` calls fall back to
their local default of `true`. `CLAUDE_CODE_HARBOR_KITE` is read first and
short-circuits both, so setting it explicitly is independent of whether the
flag service is reachable — that is why it is now in user settings too.

Read the gate before blaming the ban, and vice versa: the ban is in every
build on disk, the gate is remote and can change under you.

## An agent's end is in the parent transcript, not in its own file (measured 2026-09-07)

`stateOf` in the subagents plugin read the last line of an agent's own
`agent-<id>.jsonl` and called a terminal `stop_reason` "finished". The recorded
measurement behind that — 116 done, 21 stopped, 5 unterminated over 142 agents —
made the leftovers small enough to hand to the session-wide
`hasBackgroundActivity` flag.

It does not hold. Two later sessions:

```
550efe84   16 agents   13 files end without a terminal stop_reason
b00b35b4   98 agents   22 files end without a terminal stop_reason
```

In 550efe84, twelve of those end on an assistant **text** block with
`stop_reason: null`, and the string `end_turn` does not appear anywhere in the
file. The agent wrote its final report and the CLI never wrote the line that
terminates the turn. Every one had been idle for hours. So an unterminated file
is not evidence of anything.

The parent transcript records every stop, three lines per stop — a
`queue-operation` `enqueue`, an `attachment` whose `attachment.prompt` holds the
same block, and a `queue-operation` `remove`:

```
<task-notification>
<task-id>a0be1617c71264601</task-id>
<tool-use-id>call_e0QdaikY1YE5Y6ASuqPFQX9N</tool-use-id>
<output-file>…\tasks\a0be1617c71264601.output</output-file>
<status>completed</status>
<summary>Agent "…" finished</summary>
<result>…</result>
</task-notification>
```

`<task-id>` is the agentId verbatim — the same string that names the transcript
file. `<status>` is `completed | failed | killed`. The block's own note says it
fires each time the agent stops, so the same id notifies again after a resume;
take the latest, and treat a transcript written *after* its last notification as
running again.

Three things that look usable and are not:

- **`<output-file>`.** The path names a `tasks/` directory under the *temp*
  session id, which for a resumed session is not the transcript's session id,
  and the files are not there anyway — every one of 97 agents checked came back
  missing. Do not probe for it.
- **Idle time.** An agent blocked on a twenty-minute build writes nothing and is
  running. `idleFor` is fine to display, useless as a verdict.
- **`hasBackgroundActivity` on its own.** It is session-wide. Applied to a large
  unresolved residue it marks every dead agent running simultaneously, with
  durations climbing in real time. Keep it as the last resort for the one case
  the parent cannot see: a nested agent, whose notification is delivered to its
  spawner's agent file rather than to the session parent.

Indexed this way the residue went 13 of 16 → 0 and 22 of 98 → 8, the surviving
eight all having written within the previous minute.

## Local voice crosses three ownership boundaries (measured 2026-09-09, app-1.46388.4)

The microphone control can be replaced without a baked-loader edit. On the live
claude.ai page the main button still has `aria-label="Press and hold to record"`;
a capture-phase `pointerdown` listener ran before React, made the dispatched event
return false with `defaultPrevented=true`, and the native relay did not open. In
generation 13 the same event moved the workstation state from `wake` to
`dictation`, set the page's owned status attribute to `recording`, then a second
event returned it to `wake`. The page URL supplied a `local_<uuid>` desktop
session; bridge resolution independently supplied the corresponding bare CLI
uuid. They remain distinct.

The renderer is only the control surface. A hidden window throttles its timers,
so capture, event polling and wake-command delivery cannot live there. The
interactive-user Python companion owns WASAPI/PortAudio, Silero VAD, WAV spooling,
retry state, the SSH forward and speaker playback. `sounddevice`'s unqualified
default selected the MME copy of a USB headset input. The companion now maps that OS
default name onto its Windows WASAPI copy; this device refuses 16 kHz with
`PaErrorCode -9997`, so capture runs shared at its native 48 kHz and streaming
soxr emits exact 512-sample 16 kHz blocks. A measured ten-second journal chunk
contained 160,000 mono samples at 16 kHz, followed by a valid 32,512-sample tail,
with no capture warning. On 2026-09-10 the WASAPI object remained non-null after
its callbacks stopped for 1,037.850 seconds, so health falsely reported ready and
the UI could not distinguish a dead microphone. The device loop now treats an
inactive stream or two seconds without a callback as failure, closes it, finalizes
any open durable spool, and reopens through the existing bounded backoff. Health
requires a recent callback rather than object existence. The plugin main process polls the companion and
delivers through `claudeCodeSessionManager`, which keeps wake commands and final
segments alive when the renderer is hidden. Event targets are
session-owned: an explicit desktop id can resolve only to a binding for that id.
After navigation it waits up to 30 seconds for the old view to return, then records
a not-delivered hold and advances; it never falls through into the new composer.

The page-world TipTap expando remains the insertion boundary. The isolated
renderer cannot see it. `webContents.executeJavaScript` resolves the widest/lower
`.epitaxy-prompt-input .tiptap`, calls `commands.focus('end')`, then
`commands.insertContent`; no React-owned child or class is changed.

Audio durability precedes inference. The companion writes 16 kHz mono PCM to a
`.pcm.part`, flushes and fsyncs while it is live, closes a valid WAV, and only then
creates the ASR job. Startup wraps an interrupted part as `.recovered.wav`.
Failed ASR leaves `.wav.job.json` beside the source and retries it. A queued-path
set prevents the five-second retry scan from stacking copies behind one slow HTTP
attempt. A completed worker can delete a job while that scan is collecting file
metadata; the scan skips vanished paths instead of terminating its retry thread.
Wake-mode jobs older than two minutes are transcribed as recovered archive
evidence and cannot become delayed commands. The first live compute outage
accumulated 32 jobs; after the tunnel came up all 32 drained and 45 transcript
sidecars existed with zero jobs pending. Sidecars retain the ASR text and audio path together.

The compute service is a user systemd unit bound to `127.0.0.1:8765`; the
workstation reaches it through an SSH local-forward on `127.0.0.1:18765`. Both
HTTP layers require bearer tokens even on loopback, and neither health payload
contains one. Process liveness is not forward health: the first SSH process
remained alive while its forwarding channel timed out. The companion therefore
recycles a tunnel after three failed compute health probes rather than trusting
`poll() is None`. Forced scheduled-task restarts had also left eleven exact
voice-forward SSH processes alive. Deployment retired only processes whose command
line owned `127.0.0.1:18765 -> 127.0.0.1:8765`, then verified one forwarder whose
parent was the active companion. New companions expose a token-protected loopback
shutdown route so subsequent maintenance reaches `Companion.close()` and its
`tunnel.stop()` instead of repeating that leak.

CPU INT8 faster-whisper on a 16-core desktop CPU decoded the same 2.075-second Kokoro
utterance exactly as “Local voice is ready.” in both arms:

```
small.en   0.602 s through the warm HTTP service   real-time factor 0.29
base.en    0.230 s direct after model load          real-time factor 0.11
```

That first installation selected `small.en`; the larger user-specific comparison
below superseded it. A 2.575-second synthetic wake utterance decoded as “Hey,
Agent! Summarize this chat.” in 1.596 s, which forced the wake matcher to allow
punctuation between phrase words and before the command.
Kokoro produced a valid 24 kHz
RIFF/WAV for “Local voice is ready.” in 10.37 s on first load. Workstation
playback then emitted `speech.started` and `speech.finished` with no failure. A
synthetic chat sent through the summary endpoint produced `summary.ready`, then
the same two successful playback events, proving the local LLM → Kokoro →
workstation path rather than TTS in isolation. With Silero loaded and waiting, the
workstation process measured 6.9% of one CPU core, 84.1 MiB resident and 1,208.9
MiB private committed memory over five seconds. With small.en and Kokoro loaded,
the compute unit reported 2,731,937,792 bytes of cgroup memory.

Gemma transcript refinement was removed on 2026-09-12. A retained sidecar proved
that `medium.en` had correctly decoded “right-click scope” before the text-only
refiner changed it to “rollback scope”, and archived rewrites had no owner ground
truth with which to distinguish correction from invention. `/v1/transcribe` now
copies the raw ASR text directly to its final `text` field and reports
`refined:false`; the compatibility fields remain in sidecars, but no Gemma call
can occur between recognition and dispatch. The `/v1/refine` endpoint, correction
configuration, and Desktop toggle are gone. The local LLM remains available only
for the separately requested conversation-summary feature.

### Long wake commands are recognition transactions, not VAD segments

A live failure split one uninterrupted request into 3.264, 25.024 and 12.832
second WAVs. The first segment emitted `command.final` before either continuation
was recognized; the latter two had no repeated wake phrase and became archive-only
speech. The exact 25.024-second middle duration also proves that the configured
25-second hard boundary participated. PortAudio reported no overflow, so the
missing text was dispatch state loss rather than established device loss.

A wake command now accumulates recognized parts while capture is active or any
recognition job remains queued. Finalization starts a 1.2-second grace timer only
when both become idle. New speech cancels that timer. Every continuation retains
the first segment's target even if the visible Desktop route changes. A failed
wake continuation blocks finalization until its durable job succeeds; the pending
aggregate is itself persisted with a command id. On restart, an already-recorded
`command.final` with that id retires the pending file instead of replaying it.
Tests drive both 22 consecutive 32 ms non-speech blocks across the 700 ms VAD
endpoint and 790 speech blocks across the exact 25.024-second hard segment.

The companion health payload now reports callback blocks, processed blocks,
backlog in 32 ms blocks, current and peak dB, Silero probability, active segment
duration, trailing silence, finalized segments, PortAudio overflow count, queued
and in-flight recognition, durable retries, and command grace. The renderer reads
that payload rather than inferring audio health from animation state. The detailed
settings view reports PortAudio input overflows and processor backlog separately.
A five-second live idle sample received and processed 157 blocks in both counters,
ended at queue zero, reported zero input overflows, and put both latest-block ages
at 9 ms.

### Capture processing must fail bounded (measured 2026-09-13)

An `ENOSPC` from `PcmSpool.finish()` escaped the only capture-processing thread.
The WASAPI callback thread remained healthy and fed the unbounded `SimpleQueue`
for another 13 hours: health reported 2,023,983 input blocks, 548,220 processed
blocks, 1,475,763 queued blocks, 15 ms input age and 47,323,465 ms processed age.
The queue retained roughly 1.4 GiB of stale PCM while the microphone UI could no
longer act on live speech.

Capture callback data is now bounded to about two seconds. A saturated callback
evicts old PCM or status records without blocking PortAudio, while stop, cancel,
device-failure and close controls retain FIFO order. Queue drops are counted
separately from PortAudio overflows. Any per-item processing exception abandons
and force-closes the open utterance and journal spools, invalidates the wake probe,
drops stale callback data, reports the failure best-effort, and resumes on later
live input. Failure reporting is deliberately non-authoritative because the same
full filesystem can reject the event write. Health requires both recent callbacks
and a live, non-faulted processor. If a finalized WAV outlives a failed retry-job
write, its route remains in a 64-entry memory queue for persistence retries. At
that bound capture stops opening new spools until job persistence recovers. A
restart scans utterance WAVs with neither a job nor transcript and recovers them as
archive-only work; the original command route is deliberately not reconstructed
from guesswork.

The first renderer probe measured a 319.7 by 28.0 CSS-pixel capsule without
judging the rendered composition; an actual window capture then exposed it
stretching left across the permission control. A second attempt moved a 207.6 by
20.0 component into the measured action-row gap, but its `Voice ready`, `drops`
and `queued` strings still collapsed visually against the native controls. The
persistent surface is now only the health dot and eight-bar level meter in that
gap. All status text remains in the Voice Agent settings view. Active and warning
states gain only a low-opacity tint; the native microphone does not scale or cast
a glow.

The local ready and accepted cues are 75 ms and 450 ms stereo 44.1 kHz WAVs,
trimmed and faded from a licensed sample library into ignored state.
Cue playback deliberately does not set the TTS echo-suppression flag: an electronic
cue may reach VAD, but simultaneous user speech is never discarded to hide it.
Both live cue paths emitted paired `cue.started` / `cue.finished` events. The
first implementation keyed the ready cue only to `wake.armed`, so normal
`Hey Agent, <command>` segments emitted `wake.detected` plus `command.pending`
and stayed silent until the accepted cue. Keying it to every final
`wake.detected` fixed coverage but not timing: final ASR cannot start until the
700 ms VAD endpoint or 25-second segment boundary closes the spool.

### The ready cue uses partial ASR while the spool remains open (measured 2026-09-10)

The capture processor now snapshots a valid WAV from the still-open PCM spool at
1.4 seconds, then at 500 ms intervals while speech continues. Snapshots use at
most the latest three seconds. They neither close nor truncate the durable source
spool. A dedicated single-flight wake lane sends them to a separate
`distil-small.en` model with beam 1 and secondary VAD. The production `medium.en`
beam-5 transcript, emotion analysis and command evidence remain unchanged.

Five real wake-phrase recordings selected the partial model and trigger point:

```
2.0-second prefix   base.en          3/5 detected   174-189 ms
2.0-second prefix   small.en         4/5 detected   484-510 ms
2.0-second prefix   distil-small.en  5/5 detected   450-460 ms
2.0-second prefix   medium.en        5/5 detected   1,221-1,292 ms
1.9-second prefix   distil-small.en  5/5 detected   429-455 ms
```

The first live run exposed a second timing constraint. Partial recognition took
813 ms after the 1.9-second snapshot, so the ready cue preceded the 2.912-second
segment endpoint by only 186 ms. It was technically live and perceptually still
late. `distil-small.en` was therefore moved to CUDA device 1 as INT8 weights with
FP16 compute. The persistent model added 383 MiB to that 12 GB GPU, leaving
1,469 MiB free under the concurrently loaded Gemma split. Warm direct inference
on the failed live recording took 93 ms at the 1.4-second prefix and recognized
`Hey, agent`; the authenticated production path last reported 171 ms. The first
1.4-second probe matched 2 of the five earlier real recordings, and the retry at
1.9 seconds matched all five.

The deployed authenticated endpoint produced zero wake matches across 23
same-day negative microphone clips. The capture-side recognizer checks the same
punctuation-tolerant phrase matcher as final ASR. A generation and audio id make
results arriving after spool finalization stale. A successful partial match marks
that final job as already acknowledged, so final recognition cannot replay the
cue. Short segments and failed partial requests retain endpoint-time
`wake.detected` as the fallback. Partial failure never changes final recognition,
durable retries or command dispatch. The licensed WAVs are neither tracked nor
published.

The same partial lane returns ordered word timestamps only for `/v1/wake`; final
`/v1/transcribe` keeps word timestamps disabled. The configured stop phrase
defaults to `green apple` and is transported as a single `stopPhrase` setting. A
manual segment may stop without a wake cue; a wake segment may stop only after
its own partial result recognizes the wake phrase or it began while the route was
armed. The probe keeps running after the ready cue, and a verified stop posts the
active audio id plus an absolute sample boundary back to capture. Capture
truncates the open `.pcm.part` before finishing, marks `stopPhraseDetected` in the
durable route, and suppresses later PCM until the normal VAD silence endpoint.
Wake jobs with that flag flush the pending command after successful ASR,
including after retries; jobs past the existing two-minute safety age remain
archive-only. An absent, stale, malformed, or incomplete span is never converted
from text into a guessed boundary.

### Low-confidence final ASR gets a measured fallback (measured 2026-09-13)

`medium.en` decoded one 16.416-second continuation as the stock hallucination
“If you like this video, please subscribe to the channel.” at 0.357 confidence.
The WAV contained sustained speech rather than silence. The already-cached
`small.en` decoded the same audio as the owner's actual game-mode description at
0.731 confidence. Across 94 historical accepted segments, only six fell below
0.50. Re-running five low-confidence samples through `small.en` changed none of
the other four whose fallback confidence failed to beat `medium.en` by 0.10.

Final ASR therefore evaluates `small.en` only below 0.50 primary confidence and
uses it only with a confidence gain of at least 0.10. Both thresholds are compute
configuration. The transcript sidecar records whether fallback was evaluated and
selected; ordinary high-confidence requests pay no second-decoder latency.

### Recognition selection follows final user text (measured 2026-09-09)

Seven faster-whisper models were run across 204 clips: 50 LibriSpeech clean, 75
LibriSpeech difficult, 60 clean/noisy technical clips, 15 silence/noise clips and
four real microphone clips. The finalist decoder fixed temperature at
zero, used beam 5 and patience 1, retained the technical initial prompt, and
enabled faster-whisper's secondary VAD. Secondary VAD moved `medium.en` negative
false positives from 5 of 15 to 0 of 15. Beam 10 without VAD instead produced 14
of 15, and beam 10 added no measured accuracy with VAD.

```
                       medium.en       large-v3-turbo
standard WER           4.642%          3.506%
typed technical WER    2.058%          3.498%
real-user pseudo-WER   0.735%          3.676%
negative false positives  0/15             0/15
real-time factor       0.290           0.417
```

An earlier Gemma-correction evaluation moved the four real-user `medium.en` clips
from one error to zero while `large-v3-turbo` retained five errors. It worsened
medium's combined technical set from 10 to 15 errors and improved turbo from 17
to 15, so corrected technical output tied while raw technical evidence still
favored medium. That aggregate score did not make individual lexical rewrites
trustworthy, and the correction stage was later removed. The production choice
is `medium.en`: it wins the user's microphone and technical
workload, runs faster, and gives up generic English accuracy that is less relevant
to this installation. After both production models were warm, the complete
ASR-plus-emotion path processed the 8.672-second enthusiastic microphone clip in
2.905 seconds and reproduced happy at 0.985 with no emotion error. Initial model
download and load took 33.939 seconds. A service restart loaded both from their
final production directories and returned the same text and emotion in 11.837
seconds, proving benchmark-cache deletion did not strand a model dependency.

### Emotion is acoustic and confidence-gated (measured 2026-09-09)

`emotion2vec/emotion2vec_plus_large` runs separately from Whisper and Gemma. Its
nine output scores come from the WAV signal; transcript words are never input.
On a deterministic 210-clip RAVDESS speech sample balanced across angry,
disgusted, fearful, happy, neutral, sad and surprised, top-1 accuracy was 191 of
210 (90.95%). Inference took 48.99 seconds total. A 0.90 confidence and 0.20
runner-up margin gate accepted 200 clips (95.24% coverage) at 92.5% precision.

The gate matters on the real microphone. “what's up bro?” produced an ambiguous
0.375 disgusted / 0.290 neutral result and is withheld. The clearly enthusiastic
8.672-second clip produced happy at 0.985 in 0.545 seconds. Two longer technical
clips produced neutral at 0.770 and 0.948; only the latter clears the production
confidence gate. Segment score vectors are duration-weighted before a multi-part
command receives one final estimate. Reliable metadata is placed in a separate
`local_voice_context` block, explicitly outside the spoken request. Raw scores
remain in the local transcript sidecar even when the estimate is withheld. With
medium.en and emotion2vec+ loaded, the voice systemd unit reported 3,592,650,752
bytes `MemoryCurrent`. The host had 5.6 GiB available and no swap at that instant;
the emotion lane stays on CPU and does not take memory from the three Gemma GPUs.

### Detailed delivery runs alongside ASR under a deadline (measured 2026-09-20)

The optional prosody lane is LAION VoiceNet revision
`cdafe5170561eaadb09f012ed5ae48e4f82b7b91`. Installation downloads only its
bundled VoiceCLAP encoder and best-per-dimension heads, then verifies a
source-anchored SHA-256 manifest before executing the pinned predictor or loading
its serialized heads. It runs in a separate CPU-only venv and authenticated
loopback systemd service on port 8766. The sidecar admits one request; a second
concurrent request gets 503 before its body is decoded. Audio over 30 seconds or
anything other than mono 16 kHz WAV is rejected.

The original CUDA deployment was discarded. A faulty third GPU made fresh
PyTorch CUDA enumeration return an unknown-device error even with
`CUDA_VISIBLE_DEVICES` restricted to either healthy card. The CPU path was
already fast enough and avoids coupling final transcription to that hardware
fault. The CPU venv occupies 1.1 GiB rather than the attempted CUDA venv's 6.7
GiB; the warm sidecar reports roughly 332 MiB resident memory.

Five hundred deterministic random retained microphone clips establish the local
speaker baseline. Every one of the 57 raw numeric dimensions remains in the
30-day transcript sidecar. Only 19 code-owned, non-demographic delivery axes are
normalized against that baseline for command aggregation. The prompt formatter
has its own fixed allowlist and phrases; model-provided names, bucket strings,
unknown dimensions, perceived age/gender, cognitive-load and vulnerability
outputs cannot become prompt text. Multi-segment profiles are duration-weighted
and carry analyzed-duration coverage. Coverage below 50% suppresses detailed
context. Retention now removes the paired transcript sidecar when its completed
WAV expires and preserves WAVs that still have durable jobs.

The compute process launches the bounded prosody request before CPU ASR, performs
existing emotion2vec inference unchanged, then waits at most 150 ms beyond those
stages. Sidecar failure, overload, malformed output and timeout produce durable
status evidence without failing or retrying ASR. On 500 calibration clips,
standalone VoiceNet latency was:

```
CPU VoiceNet       p50 290.8 ms   p95 347.7 ms   max 632.9 ms
```

A paired 20-clip production-endpoint test alternated enabled/disabled order on
each retained WAV. All 20 enabled responses carried a complete validated
profile:

```
prosody disabled   p50 1,940.6 ms   p95 4,184.3 ms
prosody enabled    p50 2,101.0 ms   p95 4,405.1 ms
added latency      mean 177.2 ms     median 205.7 ms   p95 288.1 ms
ready coverage     20/20
```

The added time is CPU contention while both models overlap, not a serialized
VoiceNet tail. Lowering the sidecar to four Torch threads made overlap longer and
worse; lowering its systemd CPU weight produced missed deadlines and large ASR
outliers. The measured default scheduler is therefore retained.

## GPT hosted search and Luna WebFetch are separate paths (verified 2026-09-10)

Claude Code 2.1.260 implements `WebSearch` as a forced side Messages request
with one Anthropic server tool named `web_search`, type
`web_search_20250305`, and `max_uses: 8`. Treating that declaration as an
ordinary OpenAI function cannot work: the client waits for
`server_tool_use` and `web_search_tool_result`, while no local function
executor owns that name.

The GPT arm now maps it to Codex's native hosted tool
`{"type":"web_search","external_web_access":true}`. Allowed domains become
Codex `filters.allowed_domains`; approximate location fields carry over.
OpenAI has no blocked-domain equivalent, so a non-empty `blocked_domains`
request fails closed instead of claiming enforcement. A live request proved
that the ChatGPT subscription endpoint rejects `tools[0].max_uses` as an
unknown parameter. The bridge therefore cancels and reports an over-limit
stream when it observes too many hosted calls; the provider cannot prevent
the extra internal call before emitting it.

The matching Codex source is tag `rust-v0.145.0`, commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`. Its ordinary Responses request
posts to `https://chatgpt.com/backend-api/codex/responses`, keeps the hosted
tool at top level, and performs no client follow-up for a
`web_search_call`. Search, open-page and find-in-page actions are all
server-executed. On the live endpoint, the completed search item carried the
query and the following completed message's `output_text.annotations`
carried `url_citation` title/URL pairs. The translator buffers that message
until item completion, emits the Anthropic server-tool/result pair with
deduplicated citations, then emits the text. Standalone annotation events
are non-authoritative.

`WebFetch` is a different Claude Code pipeline. The client retrieves the page
itself and sends the converted material through the small-fast model under
`querySource: "web_fetch_apply"`. Desktop-spawned workers now receive
`ANTHROPIC_SMALL_FAST_MODEL=claude-gpt-5.6-luna[1m]`, clear both CCR web
worker switches, and set `skipWebFetchPreflight: true` in their highest-priority
launch settings. That removes only the fixed request to
`api.anthropic.com/api/web/domain_info`; Claude Code still applies URL
parsing, credential rejection, provenance and permission checks, same-site
redirect restrictions, timeout and size limits, and egress allowlisting.
The environment is fixed at process launch, so existing workers retain their
old small-fast selection while every newly spawned Desktop worker uses Luna.

Live verification used the real Claude Code `WebSearch` tool through the
health-gated router and returned OpenAI's official page with its citation. A
fresh isolated worker with the exact Desktop launch settings fetched
`https://example.com/` and returned `Example Domain`, proving local retrieval
plus Luna transformation without Anthropic subscription inference.

## GPT prompt-cache affinity follows the session/thread id

Measured 2026-09-27 from the usage ledger, grouping requests by the stable
`resp_` id prefix OpenAI gives one conversation. The backend's cache affinity
follows the `session-id`/`thread-id` headers, not only `prompt_cache_key`.
Follow-up requests over 50K missed 3.0% of the time before `80178b5` and 12.8%
after it, when the header became the Claude session id (shared by every
subagent) or a per-request uuid (subagents). Misses were 2.3% with no
concurrency and ~34% with six agents of one session in flight; Codex on the same
account misses 0.2-2% at every context size. `07d774d` derives one thread per
conversation from session id + cache key.

To re-measure: take `openai.response.usage` rows from
`~/.claude/gemini-bridge/provider-usage-v1.jsonl`, group them by the first 26
characters of `responseId`, and count follow-up requests over 50K that read
under half their input from cache. Codex's own `token_count` records under
`~/.codex/sessions` are the baseline, compared at matched context size; Codex
contexts are mostly smaller, so an unmatched comparison flatters it.

Two smaller facts from the same audit. Until `73f0e98`, a deferred tool loaded
mid-conversation joined `tools[]`, which is rendered ahead of the conversation,
so every load invalidated the whole cached prefix (46 of 11,332 requests); the
next section has the translation that replaced it. And GPT-5.6 renders replayed
reasoning from earlier turns by default (`reasoning.context: all_turns`); GPT-6's
default is not documented, so the router names it (`424c975`).

## Claude Code's deferred-tool protocol and its Responses translation

Read from the Claude Code 2.1.280 bundle (`eZr`), not guessed. A deferred tool is
declared in `tools[]` with `defer_loading: true` and becomes visible where a
message loads it: `{type:"tool_reference",tool_name}` inside a ToolSearch
`tool_result`, or, in a mid-conversation `system` message,
`{type:"tool_addition",tool:{type:"tool_reference",name}}`,
`{type:"tool_addition",tool:{type:"tool_definition",definition}}` (inline; the
tool is then absent from `tools[]`), and `{type:"tool_removal",tool:{type:"tool_reference",name}}`.

Responses' `additional_tools` input item (role `developer`) is the equivalent:
its tools are callable from where it sits, need no `tool_search` declaration, a
same-name reload is accepted, and the backend keeps the cached prefix (`73f0e98`,
live: 94-96% cached after a load vs 0% when the tool joined `tools[]`). There is
no removal item; rewriting the earlier item would break the cache, so a removal
is announced as developer text.

## Bypass mode still raises cards; one broker method raises all of them (2026-09-29)

Claude Code 2.1.284 keeps some asks under `bypassPermissions`: the rm checks
("possibly-empty variable path") fire when a target can expand to `/`, `/*` or
a top-level path, and say they "cannot be auto-allowed by permission rules".
`"$L"/*.log` fires; `"$L"/dir/*.log` and `"$L"/name.log` did not.

The ask arrives as a `can_use_tool` control request, which the SDK Query
passes to `this.canUseTool`, which is
`permissionBroker.createCanUseTool(sessionId, …)` (app-2.9939.4). That closure
runs Desktop's own denials first (forged card names, host-tool provenance,
unattended sessions, directory/connector/setting prechecks), then calls
`this.handleToolPermission(sessionId, toolName, input, suggestions, signal, …)`,
which is where the card is emitted. The session is
`this.config.getSession(id)`; its live mode is `.permissionMode`
(enum value `"bypassPermissions"`).

`src/plugins/bypass-for-real/main.js` wraps that prototype method and answers
`{behavior:"allow", updatedInput}` when the mode is bypass and the tool is one
of the CLI built-ins Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit.
Desktop consent cards (the `$s` force-ask set) still show. Being on the
prototype, it covers live and
new sessions with no per-Query work. Verified live: `rm -f "$L"/*.cuimodprobe`
with `L=''` was answered by the wrapper and no card appeared.

## A live model switch is gated on a 5-second API probe

Read from `claude-code\2.1.284\claude.exe`, 2026-09-30. The `set_model` control
request runs `Efe` with `deadlineMs: si`, `var si=5000`, and for any model not
already trusted sends a real request (`max_tokens:1`, one "Hi" message,
`querySource:"model_validation"`). A probe still running at the deadline fails
the switch with `Couldn't confirm model "<id>" with the API`, code
`check_failed`. The router never forwards `max_tokens` to OpenAI, so a GPT probe
is a full answer. Launch picks skip it (`confirmWithServer:false`).

`jIn` returns valid without probing when the id equals a `modelPicker.options[].model`
entry verbatim, and `modelPicker` is honoured from flag settings, which
`query.applyFlagSettings` changes on a running worker. `apply_flag_settings`
merges; it replaced neither `autoCompactEnabled` nor `skipWebFetchPreflight`.
Measured through the router with a hidden SDK-mode CLI:

```
set_model claude-gpt-6.1-sol[1m]               check_failed after 5005 ms, 1 probe
modelPicker patch, then the same set_model     success after 2 ms, 0 probes
```

`src/plugins/model-probe-skip` wraps each session's `query.setModel` to send
that patch first.

## Fast mode: the switch, the CLI gate, and the two wires (verified 2026-09-30)

Read from app 2.9939.4, the pinned Code release (`index-Cuw5J4F9.js`) and
`claude-code\2.1.284\claude.exe`; measured against the live window and a hidden
CLI on a capture server.

The composer shows its fast switch (pinned `c66fe388e`, `Bf`/`Vf`) only when the
session model's catalogue entry carries
`fast_mode: {type:"toggle", options:[{id:"fast",…},{id:"off",…}]}`, looked up
as `fastModeFor(Uc(modelId))`, where `Uc` strips a trailing `[…]` tag. Every
other footer lookup uses the raw id first. So a routed `claude-gpt-…[1m]` row
needs an untagged twin to carry the switch, which provider-picker adds in the
`legacy` section. The popup renders only `main` and `overflow` rows, and the
model list filters `legacy`. The live `ccd` section marked only `claude-opus-5`,
`-4-8` and `-4-6`. The CLI's own catalogue gives `fast_mode` to Opus 4.8, 5 and
5.5, so Opus 5.5 was missing its switch.

The switch state is not per session. It shows the value picked in the current
opening, else the one global `fastMode` in the `epitaxyPrefs` bucket. That
bucket is loaded through `AppPreferences.getPreferences` and replaced on every
`preferencesChanged` broadcast. `LocalSessions.setFastMode` persists nothing
for a started session: it only pushes `applyFlagSettings({fastMode})` to the
live worker. `src/plugins/fast-mode` records each call per session, writes the
on-screen session's value into the bucket, and provider-routing puts it in that
session's launch settings.

On the wire, a fast turn is `speed:"fast"` plus the `fast-mode-2026-02-01` beta.
The CLI sends it only for a model with the `fast_mode` capability.
`CLAUDE_CODE_MODEL_CAPABILITIES="claude-gpt-6.1-sol*=fast_mode"` grants it
(a trailing `*` prefix-matches the id with `[1m]` removed). A live
`apply_flag_settings` env patch reaches the same read on a running worker.

```
opus-5-5, fastMode on                    speed fast, state on
gpt-6.1-sol, no capability               no speed, state off
gpt-6.1-sol, capability env              speed fast, state on
gpt running, flag fastMode only          no speed, state off
gpt running, flag fastMode + env patch   speed fast, state on
```

Desktop workers report `fast_mode_disabled_reason: sdk_opt_in_required` until
the fast flag setting is pushed; the switch's own push clears it.

Anthropic accepted `speed:"fast"` on Opus 5.5 for this account but answered with
the `fast-mode-overage-rejected` notification ("usage credits exhausted") and
served `speed: standard`. Desktop then turns the session's fast off itself
(`handleFastModeCreditsNotice`).

The Codex backend takes `service_tier:"priority"`, the tier the models cache
lists per slug as `{id:"priority", name:"Fast"}`. `"fast"` and `"flex"` return
400 `Unsupported service_tier`. The completed response reports
`service_tier:"default"` either way (as in openai/codex#30413), so the reported
tier cannot confirm priority. Speed can, on GPT-6.1 Sol, low effort, ~450-token
answers, alternating arms, text tokens/s after the first delta:

```
priority   median 35.0 tok/s  MAD 1.5   n=4
default    median 23.9 tok/s  MAD 1.8   n=4
```

The CLI reads fast mode once per turn. A flag flipped while a turn runs reaches
the next turn, and the rest of the current turn keeps its speed:

```
request 1, turn 1, in flight at the flip   standard
request 2, turn 1, after the flip          standard
request 3, turn 2                          fast
```

For GPT the router does not wait for the next turn. The fast-mode plugin also
writes each switch under `cli` in `.state/fast-mode.json`, keyed by Claude Code
session id and rebuilt from the manager so a `/clear` moves it.
`router/fast-mode.mjs` reads it for every main-agent request. Subagents keep
their own `body.speed`, and only slugs with a priority tier are affected. The
router's `openai …` log line records the `tier=` it sent. Live, one GPT-5.5 turn
through the router, with the switch flipped 1.9 s in:

```
request 1 (items=2)   tier=default
request 2 (items=5)   tier=priority
```

A subagent inherits its parent's fast flag in the CLI: under a fast parent,
both a GPT-5.6 Luna and an Opus 5.5 subagent sent `speed:"fast"`. The router
therefore ignores `body.speed` on a subagent request (`cc_is_subagent=true` in
the billing line) and sends priority only when the agent's launch prompt opens
with a `#fast` line. A subagent's first message is its three
`<system-reminder>` blocks, then the prompt as its own text block, so the
marker is in every request the agent makes. It is stripped before
translation. Every translated GPT response carries the tier the router sent as
`usage.speed`, and the CLI writes that field into the parent and `agent-*.jsonl`
transcript lines. Live, under a fast GPT-5.5 parent:

```
parent                 tier=priority
subagent, #fast        tier=priority   transcript speed fast
subagent, plain        tier=default    transcript speed standard
```
