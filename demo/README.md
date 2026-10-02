# demo

The Remotion project that renders the videos in [`docs/media`](../docs/media).

It is a **mock** of Claude Desktop, not a screen recording: a fake window with
the same anchors the plugins attach to in the real app — the sidebar's right
edge, the composer box, the free middle of the footer row — and a scripted
session that creates and completes tasks, switches model, runs four subagents on three providers,
queues messages and moves the numbers.

Nothing about the look is re-drawn by hand. `gen-css.mjs` pulls the real
stylesheets out of `../src/plugins/*/renderer.js` and scopes them, so the task
rail, the context meter, the dashboard and its throughput readout, the subagent
rail and sheet, and the send queue render from the same CSS that ships. Plugins
whose sheet is a function of their settings (subagents, queue, usage-bar) are
evaluated with their own defaults. If a plugin's styling changes, re-running the
render picks it up.

## Render

```bash
npm install
node render.mjs
```

That writes an MP4 per composition into `out/`, then a GIF of each into
`../docs/media`. Needs ffmpeg on `PATH`. Each GIF is held to 5 MB: `render.mjs`
retries at a cheaper width, frame rate and palette until it fits, so the long
tour comes out narrower than a short crop. The MP4 is never degraded.

The renders are CPU-heavy and the machine is usually in use, so run them hidden
and at low priority. `render.mjs` spawns every child with `windowsHide`; start
Node itself with PowerShell's `Start-Process -WindowStyle Hidden` and set the
process's `PriorityClass` to `BelowNormal`. One composition at a time:

```bash
node render.mjs crop-task-rail
```

To scrub the timeline interactively:

```bash
npm run studio
```

To look at single frames without a render (the `scene` composition is the whole
window at scene time, uncut):

```bash
node stills.mjs out/stills scene@26.3 scene@41.5 crop-queue@6
```

## Compositions

| id | what it shows |
|---|---|
| `tour` | the whole window, about a minute, captioned, played through six windows of the scene (`TOUR_WINDOWS` in `Scene.tsx`) |
| `scene` | the whole window at scene time, uncut, for scrubbing and stills |
| `crop-task-rail` | the rail, through two status flips |
| `crop-usage-bar` | the context meter and auto-compact switch in the composer footer |
| `crop-dashboard` | the settings overlay, with the footer still in shot so the setting can be seen landing |
| `crop-transcript` | thinking blocks and transcript typography being restyled |
| `crop-provider-picker` | the four-tab provider strip inside the native model picker: Claude to OpenAI, GPT-6.1-Sol, the effort slider; then, a second visit, the Command Code tab with its eight models and one picked (the camera pulls back as the list grows) |
| `plugin-wall` | **a title card, not a plugin render**: the mod's 419 features as seven labelled groups of name chips, each with a right-aligned count badge, that build in one at a time while the total climbs (a chip's count ramps in over a fraction of a second, so the router's 193 reads as a sweep, not a jump). Six groups hold the 33 plugins; the seventh, "Router & tooling", holds the router, its adapter, and the scripts around it. The sub-line reads 33 plugins · 193 settings · 258 in the router and tooling. Drawn by `PluginWall.tsx` in the demo's own tokens and faces, with no extracted stylesheet behind it (six accents are colours the shipped sheets already use, listed in its header comment; the seventh is the neutral `--text-300` token). It is held to a 3 MB GIF; the chip names and their counts are typed out in `PluginWall.tsx` from a source-grounded feature inventory, so a plugin added or removed under `src/plugins/`, or a change in how many things one does, means editing that list by hand |
| `crop-subagents` | the subagent rail under the chat title (running rows, finished ghosts), and the transcript sheet a click opens. The scripted team mixes providers under the GPT-6.1-Sol main session: two `gpt-reader` agents (`gpt-6-luna · high`), a `deepseek-worker` (`deepseek-v4.1-flash`) and a `reviewer` (`sonnet-5-5 · medium`). As in the shipped HUD, rail rows show only the agent's name; the definition pin (`type (model · effort)`) appears in the sheet's subline, here for the first `gpt-reader` |
| `crop-throughput` | the tok/s chip in the streaming strip, then the dashboard readout splitting hop, ttft and generation per lane |
| `crop-queue` | the send queue: Enter mid-turn, edit, steer, delete (armed, then confirmed), auto-send at turn end |

A crop is not a separate animation. It is the same scene and the same timeline,
seen through a smaller rectangle starting at a different second (and, for
`crop-throughput`, through a rectangle that moves: `Crop` takes a `camera` list
and a list of `windows` of scene time to play) — see
`Crop.tsx`, which also explains why the window box carries an identity
transform (`position: fixed` needs a containing block, or the plugins would
anchor to the video frame instead of the mock window).

## What is faked, and what is not

Real: every extracted stylesheet and the DOM it is applied to (class names and
nesting follow `makeRow`/`patchRow`/`openSheet` in subagents, `build`/
`paintRowBody` in queue, `build`/`patch` in throughput, and the usage-bar
`buildBar`); the placement algorithms (task rail and subagent rail in the gutter,
queue rail `gap` above the composer, usage meter in the footer's free middle);
the task schema; the token values from `docs/internals.md`; the provider strip's
element structure and inline styles (copied from `decorate()` in provider-picker),
with the shipped catalogues' model names and order (the Command Code tab's eight come from `catalogue.private.json`); the dashboard's controls,
labels and sidebar counts (the number of controls each plugin's spec declares);
the throughput readout's formatting functions and field meanings (hop = dispatch
to response headers, ttft = dispatch to first content delta, gen = first delta to
the terminal event); the chip's label format and its title strings.

Scripted: the session, the task timeline, the pointer, and every number — token
rates, agent names, tools and elapsed times, queue text, context percentages.
There is no Claude Desktop, router or provider behind any of it.

Drawn by hand, because it belongs to claude.ai's own frontend and is not in this
repository: the model picker's popup shell, its rows and the effort slider (only
the provider strip inside it is real; the strip is one row of four tabs because the
plugin wraps at four, and the tab centres the pointer aims at were measured from
Chromium's layout of those inline styles, not computed); the composer's footer trigger, send/stop
button and the "update queued" pill the queue's page rule produces (its colours
are approximated); the streaming strip under a message, where a middle dot stands
in for the app's icon-font separator and the chip's native `title` tooltip is
drawn as a tooltip box; the chat title strip the subagent rail hangs from; the
sheet's transcript text. `thinking-style` and `transcript-type` are not
extracted: `AppShell.tsx` restates their rules with the author's settings, as it
always has.

Staged for the story rather than observed: the second picker visit, placed after the
scene's last turn (scene time 72 to 79) so the tour is untouched and the first visit
stays as it was; there the transcript settles upward so the taller menu opens over
empty space, and the menu is anchored at its bottom edge so it grows upward, and
loses its effort section (and the footer its effort label) once a Command Code model
is checked, because the catalogue gives those models no efforts and `page.js` only
gives a model a `thinking` block when it has some — the app's own selector is
assumed to follow, which has not been observed; the steered and auto-sent messages
appear in the transcript as user bubbles (the plugin delivers them; what the app
then draws is assumed); the subagent hierarchy (a reader and the worker it
spawned) and its finishing order; the rail's duration and tool text change
every 4s (2s with the sheet open) to match the plugin's poll, not a clock.

Faithful to a quirk: the subagent sheet covers the rail while it is open (it is
appended after it in the same host), the queue rail ends 6px above the nominal
gap because its empty toast box still takes the flex gap, a sent or deleted queue
row animates out pinned in place while the rows below close up under it (so for
a couple of frames two lines of text overlap), and the task rail sits
over the subagent rail's gutter (it takes z-index 60 against the subagent host's
50) — all as shipped.

Not shown: the usage-bar plugin no longer draws a plan-limit meter or sparkline
in the composer (that moved to the app's own usage ring), so the old limit meter,
sparkline and idle-opacity-with-limit story is gone; the dashboard story flips
the compaction mark instead. The subagent sheet's chat gutter and the queue's
toasts are not drawn.

Re-timed: the plugins' CSS transitions and keyframes are frozen and replayed from
the frame clock. Remotion captures each frame after a seek, so a wall-clock
transition would render at whatever state it happened to be in. Durations match
the plugins' own constants: task rail `FADE_MS` 100, `STAGGER_MS` 150,
`TWEEN_MS` 140; queue 120/200/280ms (rowIn, rowSent, rowOut, railIn, bump);
subagents 120/200/320ms (railIn, sheet clip 360ms, breathe 2.1s, sweep 2.6s);
the picker's menu-resize animation (170ms, `cubic-bezier(.22,.8,.28,1)`) is
replayed as an ease-out cubic over 170ms when the Command Code tab's eight rows
replace three.

The tour is the scene played through windows (`TOUR_WINDOWS`), so some stretches
of the timeline are skipped with a short dip to black at each cut.
