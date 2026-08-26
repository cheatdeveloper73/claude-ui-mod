# Claude Desktop internals

Established by reading the shipped bundle and by measurement, against
**app 1.26832.0 / Electron 42.7.0 / Chrome 148.0.7778.280**. Do not re-derive; do re-verify the version
if something behaves unexpectedly after an update.

## App layout

```
%LOCALAPPDATA%\AnthropicClaude\
  app-<version>\
    claude.exe                       Electron binary (~232 MB)
    resources\
      app.asar                       the app (~39.6 MB)
      app.asar.unpacked\             6 native entries (.node/.dll/.exe)
```

The main window is a **shell page** — `.vite/renderer/main_window/index.html`
says so in a comment: title bar + error UI only, "everything else gets loaded
from claude.ai". The real UI is claude.ai in a `WebContentsView`.

Key entries inside `app.asar`:

- `.vite/build/index.pre.js` — main-process entry (`package.json` `main`), ~4.6 MB
- `.vite/build/mainView.js` — **preload for the claude.ai WebContentsView**, ~239 KB

`mainView.js` is referenced 5 times (main window, popouts, quick window, 3p setup,
device-code window), so appending to it gives per-window injection for free.

That view is created with `sandbox: true, contextIsolation: true,
nodeIntegration: false`. The preload can therefore only `require('electron')` —
no `fs`, no `child_process`. All local state must come over IPC from main.

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
props only (icon name, message, formatted reset string, no numbers); a sweep of
all ~16k fibers for a store or hook state holding `utilization` / `five_hour` /
`resets_at` finds nothing; and `app.asar` exposes no usage store over the
`<name>_$store$_getState` IPC convention (the ones it does expose are
bootstrap, supportBundle, connectedFiles, attachment, updater, navigation,
managedRendererConfig, computerUse/browser preview, sessionsBridgeStatus,
interactiveAuth, grandPrixStatus, activeServers, apiReachability).

**Context.** Every assistant turn in `~/.claude/projects/<enc-cwd>/<cliSessionId>.jsonl`
carries `message.usage`. Context in play is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Skip
entries with `isSidechain: true` — a subagent's turns land in the same file and
describe the subagent's context, not the conversation's. Tail-read the file; do
not parse it whole.

## Composer footer anchors

The footer row is the parent of the `ml-auto` flex group that holds the
model/effort buttons, inside `.epitaxy-composer-width`. The free middle runs from
the right edge of the last child before that group to the group's left edge —
about 490px at a 1490px-wide window. Float over it; never insert into it.

The usage band is `.epitaxy-composer-aux-view.epitaxy-composer-band`, but so are
the other bands (the PR/diff row), so it cannot be selected structurally. Its
icon path changes with severity, so that is no good either. Tag it by matching
its text and setting a `data-*` attribute, then hide by attribute — React leaves
unknown attributes alone but owns `className`.

## A floating host needs its own dedupe

Any plugin that appends a positioned host to the page must remove strays with
its own id on every tick, exactly as the task rail does. A generation that fails
to dispose leaves its host behind with its JS gone: it freezes with stale numbers
at a stale position, and `getElementById` hands *it* to anything looking the host
up — so measurements come back describing a corpse while the pixels show the
overlap. That combination reads as a CSS bug and is not one.

## The max context window, without a model table

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
