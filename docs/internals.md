# Claude Desktop internals

Established by reading the shipped bundle and by measurement, against
**app 1.26832.0 / Electron 42.7.0 / Chrome 148.0.7778.280**. Do not re-derive; do re-verify the version
if something behaves unexpectedly after an update.

## App layout

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

## Composer footer anchors

The footer row is the parent of the `ml-auto` flex group that holds the
model/effort buttons. The free middle runs from the right edge of the last child
before that group to the group's left edge — about 490px at a 1490px-wide
window. Float over it; never insert into it.

That shape — an `ml-auto` group inside a 12–52px tall, >220px wide flex row — is
**not unique**: the terminal pane's `.df-footer-row` matches it too. The search
must be scoped to the composer first or the overlay lands in the wrong pane.
`.epitaxy-composer-width` used to be that scope. It is gone; `.epitaxy-prompt` is
the surviving landmark, and the footer row is its sibling under the composer's
`mx-auto max-w-[…]` container, so walking up from the prompt finds it in one
step.

Current shape (2026-08-28, 1490px-wide window):

```
div.w-full.mx-auto.max-w-[…]                     840w   composer container
  div.epitaxy-composer-aux-view…                        band rows (PR, usage)
  div.epitaxy-prompt                             768w   the rounded input box
  div.w-full.flex.items-center.gap-g5.py-[4px]   768w   footer row
    div.flex.items-center.gap-g5.min-w-0         110w   mode cluster
    div.ml-auto.flex.min-w-0.items-center.gap-g4 140w   model / effort / fast
```

`.epitaxy-prompt` is also the composer's measure — the number `.epitaxy-composer-width`
used to supply to anything sizing itself against the transcript column.

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
so you cannot manufacture one from outside the composer.

## The composer's corner button is Send or Stop, never both

`button[data-testid="code-prompt-send"]` exists only while the turn is idle.
Mid-turn the app unmounts it and mounts `button[data-testid="code-prompt-stop"]`
in the same slot. Anything that restyles or intercepts "the send button" has to
cover both ids, or it will be inert during exactly the window that matters. The
send button also carries `disabled` whenever the composer is empty.

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
read from the 2.1.260 binary. Quoting that sentence inside an ordinary message is
not enough: it must begin the final user message. The Codex path applies only when
the selected wire model is GPT and `compaction-provider.strategy` is `codex`.
Every other model and the dashboard's `native` setting retain Claude Code's normal
compaction transaction.

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
per-session `storeId`, so notes follow the conversation across every window
reset. `new_context` cannot reset Claude Code's own transcript, so the reset is
applied outbound instead: the Nth user message is recorded with its digest, and
later turns are sent from after it. A digest mismatch — which is what Claude
Code's own compaction rewriting history looks like — abandons the cut rather than
truncating the wrong prefix, the same degrade-to-safe rule the checkpoint store
uses.

One Anthropic message spans every round the model-only calls create.
`ResponsesToAnthropic` gained `suppressCall` and `deferFinish`: a suppressed
`function_call` opens no content block and its arguments never reach the client,
output indices are keyed by an epoch so a second upstream response cannot collide
with the first, and terminal usage accumulates so the turn reports what it really
cost rather than its last leg. Each round is a separately billed response and is
recorded as one; the throughput sample settles only on the final round, because
`complete()` is guarded by `settled` and the first call would otherwise measure
the first leg.

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

The window it is measured against comes from the models list, and from the right
field. The endpoint reports two: `context_window` 272000 is the default a plain
Codex session starts at and that its own `model_context_window` config routinely
overrides, while `max_context_window` 872000 is the model's actual ceiling —
measured 2026-09-05 for astra, reserve, sol, terra and luna; 5.5, 5.4-mini and
codex-spark report the same value for both. This arm runs these models at their
ceiling, so it budgets against `max_context_window`, scaled by
`effective_context_window_percent`, a field the endpoint never sends and the
client defaults to 95 (`openai_models.rs:383`, `usable_context_window` at :504).
That is 828400 for a 1M-class model.

The `client_version` the router advertises is load-bearing for this. The backend
answers a different catalogue per version: at 0.151.0 the list came back with
eight models and no `gpt-6-astra`, so this arm found no entry for astra and fell
back to the local table rather than the model's own ceiling. 0.153.4 returns
nine, which is why the shared user agent now tracks the Codex build installed on
this machine.

A first pass at this read `context_window` and budgeted against 258400, which
would have fired the wrap-up reminder while the model still held most of its
room. `resolved_context_window()` is `context_window.or(max_context_window)`, so
plain Codex does start at the smaller number — but plain Codex is also the client
whose config sets `model_context_window` to raise it, and this router already
presents these models at 1M.

The status card had the matching reporting bug: it counted only calls the model
made, under the label "Backend calls", while the router issues a `thread_hint`
call on every turn. A working lane read as "0 / never". Counters are now per
session and split into turns routed, notes lookups and model tool calls, and they
reset with the worker generation, which is honest rather than surprising.

References:
[feature definition](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/features/src/feature_configs.rs),
[activation gate](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/core/src/session/token_budget.rs),
[history-notes extension](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/ext/history-notes/src/tools.rs),
[window reset](https://github.com/openai/codex/blob/51c97f3a67621aab788fb83d6ef90cf795f12177/codex-rs/core/src/compact_token_budget.rs).

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

## Restyling transcript type needs four tokens, not one

The app's font graph:

```
--font-ui              = var(--font-anthropic-sans)
--font-claude-response = var(--font-ui)     (9 consumers)
--font-user-message    = var(--font-ui)
--font-sans-serif      = var(--font-ui)
--family-ui                                 (11 consumers)  <- independent
--cds-font-sans                             (5 consumers)   <- independent
```

Overriding `--font-ui` alone leaves `--family-ui` and `--cds-font-sans`
consumers on anthropic-sans, which is why a restyle looks "inconsistently
applied" — it depends on which components are on screen. Set
`--font-anthropic-sans` (the root of the `--font-ui` chain), `--font-ui`,
`--family-ui` and `--cds-font-sans` together, scoped to
`.epitaxy-transcript-typography`. Leave the mono and serif tokens alone or code
blocks lose their face.

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
2026-08-31 16:48:42  local_067855a2   50 s
2026-08-31 16:50:07  local_12ccef43    4 s
2026-08-31 16:50:45  local_d6625de7    5 s
2026-08-31 17:28:54  local_a9fe54c9    7 s
2026-09-01 07:58:27  local_a914c878    0 s
```

The last landed in the same second as a focus during sub-second session
flipping, so no menu was involved. It fires once per (page, session):
`local_12ccef43` and `local_d6625de7` were re-focused at 17:23 and 17:25 with no
second write. One confirmed round trip: `local_12ccef43` was
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
  idempotency key returns. Credits expire: the 2026-09-05 grant on this account
  expires 2026-10-05.

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

### The subagent lane is in the request; which subagent is not

Every Claude Code agent request carries an `x-anthropic-billing-header` block as
`system[0]`, and `cc_is_subagent=true` appears in it **only** for subagent turns
— a main-session turn omits the key rather than setting it false. So absence of
the key is the signal, and a request with no billing block at all (a tool-less
control-plane call) is a third answer, `null`, not a silent "main".

That is the whole of what the wire says. Every subagent turn sends the **parent**
session id in `x-claude-code-session-id`, so at the transport layer a session's
own turns and its fifty agents are one indistinguishable stream. Confirmed in
`provider-usage-v1.jsonl`: one measured session holds 393 adapter-provider,
108 `claude-opus-5` and 60 `claude-sonnet-5` records under one id.

**The join key is the provider response id, and it is exact on both sides.** The
CLI writes the provider's own message id into the transcript as `message.id`.
Verified 2026-09-01 for Anthropic (`msg_011Cebmuu…` present in both the ledger
and `<cliSessionId>.jsonl`) and for an adapter provider (opaque ids such
as `-BiWaqK-HP_UjMcP48PyqAQ` present in both the ledger and
`subagents/agent-a058514e04121a59f.jsonl`). Joining that id to the transcript
line yields `agentId`, and the `agent-<id>.meta.json` sidecar yields the name and
type. End to end on a live session: 34 responses at 102.6 tok/s attributed to
`harness-opus` (heavy-worker), 11 at 120.8 to a `reader`, 5 to the main session.

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
