# demo

The Remotion project that renders the videos in [`docs/media`](../docs/media).

It is a **mock** of Claude Desktop, not a screen recording: a fake window with
the same anchors the plugins attach to in the real app — the sidebar's right
edge, the composer box, the free middle of the footer row — and a scripted
session that creates and completes tasks while the numbers move.

Nothing about the look is re-drawn by hand. `gen-css.mjs` pulls the real
stylesheets out of `../src/plugins/*/renderer.js` and scopes them, so the rail,
the meters and the dashboard render from the same CSS that ships. If a plugin's
styling changes, re-running the render picks it up.

## Render

```bash
npm install
node render.mjs
```

That writes an MP4 per composition into `out/`, then a GIF of each into
`../docs/media`. Needs ffmpeg on `PATH`. One composition at a time:

```bash
node render.mjs crop-task-rail
```

To scrub the timeline interactively:

```bash
npm run studio
```

## Compositions

| id | what it shows |
|---|---|
| `tour` | the whole window, 25s, captioned |
| `crop-task-rail` | the rail, through two status flips |
| `crop-usage-bar` | the meters in the composer footer |
| `crop-dashboard` | the settings overlay, with the footer still in shot so the setting can be seen landing |
| `crop-transcript` | thinking blocks and transcript typography being restyled |

A crop is not a separate animation. It is the same scene and the same timeline,
seen through a smaller rectangle starting at a different second — see
`Crop.tsx`, which also explains why the window box carries an identity
transform (`position: fixed` needs a containing block, or the plugins would
anchor to the video frame instead of the mock window).

## What is faked, and what is not

Real: every stylesheet, the rail's placement algorithm (gutter between sidebar
and composer, bottom flush with the composer box), the task schema, the token
values from `docs/internals.md`, the settings shown on the dashboard page, the
compaction mark's position, the thinking-block rules in both their stock and
styled form.

Scripted: the session, the task timeline, the pointer, and the numbers. There is
no Claude Desktop running here.

Re-timed: the plugins' CSS transitions are frozen and replayed from the frame
clock. Remotion captures each frame after a seek, so a wall-clock transition
would render at whatever state it happened to be in. Durations match the
plugins' own constants (`FADE_MS` 100, `STAGGER_MS` 150, `TWEEN_MS` 140).
