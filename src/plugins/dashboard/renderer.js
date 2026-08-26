/* claude-ui-mod :: dashboard (renderer)
 *
 * Insert opens a settings overlay for every plugin that registers a panel.
 *
 * Registration is deliberately manual and dependency-free: a plugin pushes a
 * spec onto a shared global and gets its apply() called with merged values on
 * load and on every edit. Nothing here inspects a plugin, and a plugin never
 * imports this file, so load order does not matter and either half works alone.
 *
 *   const R = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
 *   R.specs.set('my-plugin', { plugin, title, defaults, controls, apply, preview });
 *   R.subs.forEach((f) => f());
 *   ctx.onDispose(() => { R.specs.delete('my-plugin'); R.subs.forEach((f) => f()); });
 *
 * Keying the registry by plugin name means a hot reload replaces a spec rather
 * than stacking a second copy, whichever order the plugins happen to load in.
 *
 * A spec may also carry a preview:
 *
 *   preview: { title, node(which), css(values, selector, which),
 *              beforeLabel, afterLabel, layout }
 *
 * beforeLabel matters: for a plugin that restyles something the app already
 * draws, "before" is the stock app. For one that adds UI the app does not have
 * at all — the task rail — there is no stock state, and the left stage is the
 * plugin at its own defaults. The plugin says which, because only it knows.
 *
 * The frames render as separate floating windows beside the panel — draggable
 * by their title bar, position remembered per plugin — each fed the plugin's own
 * sample DOM and styled with the plugin's own css(). A plugin is expected to generate the
 * "after" rules from the SAME function that generates its live rules, so the
 * preview is the real thing at real size rather than a drawing of it — which is
 * also why the stage scrolls horizontally instead of reflowing when a measure
 * is set wider than the dock.
 *
 * The UI lives in a shadow root so the page's CSS cannot reach it and ours
 * cannot leak out. Custom properties still inherit through "all: initial"
 * (`all` does not reset them), which is what lets it use the app's own theme
 * tokens and follow light/dark for free.
 */
'use strict';

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));

let stored = {};          // plugin -> saved values, straight from disk
let loaded = false;
let current = null;       // selected plugin name
const saveTimers = new Map();

const merged = (spec) => Object.assign({}, spec.defaults, stored[spec.plugin] || {});

function applySpec(spec) {
    try { spec.apply(merged(spec)); }
    catch (e) { cuimod.log('dashboard: apply failed for ' + spec.plugin + ': ' + (e && e.message)); }
}
function applyAll() { for (const spec of REG.specs.values()) applySpec(spec); }

function save(plugin) {
    clearTimeout(saveTimers.get(plugin));
    saveTimers.set(plugin, setTimeout(() => {
        cuimod.rpc('dashboard.save', { plugin, values: stored[plugin] || {} })
            .then(() => flashSaved())
            .catch((e) => cuimod.log('dashboard: save failed: ' + (e && e.message)));
    }, 200));
}
ctx.onDispose(() => { for (const t of saveTimers.values()) clearTimeout(t); });

function setValue(spec, key, value) {
    if (!stored[spec.plugin]) stored[spec.plugin] = {};
    stored[spec.plugin][key] = value;
    applySpec(spec);
    // Restyle the stages in place. Rebuilding them would drop the slider's
    // focus mid-drag and make the preview flicker on every input event.
    refreshPreview(spec);
    save(spec.plugin);
}

// ------------------------------------------------------------------ styling
const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

/* One motion vocabulary for the whole overlay: three durations, an entering
 * ease and an exiting one. Everything below spends these rather than inventing
 * its own timing, which is what keeps a tab switch and a slider grab feeling
 * like the same object. */
:host {
    --d1: 110ms;   /* touch feedback */
    --d2: 190ms;   /* the default */
    --d3: 300ms;   /* whole-surface entrances */
    --e-out: cubic-bezier(.2, .85, .3, 1);
    --e-in: cubic-bezier(.5, 0, .9, .4);
    --e-spring: cubic-bezier(.3, 1.5, .5, 1);
}
@media (prefers-reduced-motion: reduce) {
    :host { --d1: 1ms; --d2: 1ms; --d3: 1ms; }
    * { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}

@keyframes rowIn { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
@keyframes frameIn {
    from { opacity: 0; transform: translate(var(--tx, 0px), var(--ty, 0px)) scale(.965) rotate(var(--rot, -.8deg)); }
    to   { opacity: 1; transform: translate(var(--tx, 0px), var(--ty, 0px)) scale(1) rotate(0deg); }
}
@keyframes bump { 0% { transform: none; } 32% { transform: scale(1.14); } 100% { transform: none; } }
@keyframes navIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }

.wrap {
    position: fixed; inset: 0; z-index: 2147483600;
    display: flex; align-items: center; justify-content: center;
    gap: 0; flex-wrap: wrap;
    /* No backdrop-filter. Measured: a blur across the full 1490x986 overlay took
     * the renderer from 239fps to 18fps, and removing it alone restored 211 —
     * masks and shadows cost nothing by comparison. A deeper flat dim reads
     * almost the same and is free. */
    background: rgba(0,0,0,.62);
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    opacity: 0; transition: opacity var(--d2) var(--e-out);
}
.wrap.show { opacity: 1; }
.wrap.closing { opacity: 0; transition: opacity var(--d1) var(--e-in); }

.panel {
    width: min(680px, 92vw); height: min(700px, 88vh); flex: 0 0 auto;
    display: flex; overflow: hidden; outline: none;
    border-radius: 16px;
    background: hsl(var(--bg-100, 0 0% 8%));
    color: hsl(var(--text-100, 60 14% 97%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 13%, transparent);
    box-shadow: 0 24px 70px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4);
    transform: translateY(10px) scale(.985);
    opacity: .4;
    transition: transform var(--d3) var(--e-out), opacity var(--d2) var(--e-out),
                box-shadow var(--d2) var(--e-out);
}
.wrap.show .panel { transform: none; opacity: 1; }
.wrap.closing .panel {
    transform: translateY(6px) scale(.99); opacity: 0;
    transition: transform var(--d1) var(--e-in), opacity var(--d1) var(--e-in);
}

/* ---- sidebar ---- */
.side {
    width: 200px; flex: 0 0 auto; display: flex; flex-direction: column;
    background: hsl(var(--bg-200, 0 0% 6.7%));
    border-right: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 10%, transparent);
}
.side-hd { padding: 17px 16px 12px; }
.side-hd h1 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.side-hd p { margin: 3px 0 0; font-size: 11px; color: hsl(var(--text-400, 48 5% 57%)); }
.side-list { flex: 1 1 auto; overflow-y: auto; padding: 4px 8px 8px; position: relative;
             scrollbar-gutter: stable; }
/* One indicator that travels, instead of a background that blinks between rows. */
.nav-ind {
    position: absolute; left: 8px; right: 8px; border-radius: 9px; pointer-events: none;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
    opacity: 0;
    transition: top var(--d2) var(--e-out), height var(--d2) var(--e-out),
                opacity var(--d1) var(--e-out);
}
.nav-ind.on { opacity: 1; }
.nav {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 8px 10px; margin-bottom: 2px; border-radius: 9px;
    font-size: 12.5px; color: hsl(var(--text-200, 55 9% 74%));
    cursor: pointer; user-select: none; border: 1px solid transparent;
    position: relative; z-index: 1;
    animation: navIn var(--d2) var(--e-out) both;
    animation-delay: calc(var(--i, 0) * 26ms);
    transition: color var(--d1) var(--e-out), transform var(--d1) var(--e-out),
                background var(--d1) var(--e-out);
}
.nav:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
             transform: translateX(2px); }
.nav:active { transform: translateX(2px) scale(.985); }
.nav.on { color: hsl(var(--text-100, 60 14% 97%)); background: transparent; }
.nav.on:hover { background: transparent; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
       background: hsl(var(--cui-accent, 14 62% 60%)); opacity: .28;
       transition: opacity var(--d2) var(--e-out), transform var(--d2) var(--e-spring); }
.nav.on .dot { opacity: 1; transform: scale(1.35); }
.nav .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav .ct { font-size: 10.5px; color: hsl(var(--text-500, 48 5% 57%)); font-variant-numeric: tabular-nums; }
.side-ft {
    padding: 9px 14px 11px; font-size: 10px; line-height: 1.4;
    color: hsl(var(--text-500, 48 5% 57%));
    border-top: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
    word-break: break-all;
}

/* ---- main ---- */
.main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.main-hd {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 17px 20px 14px;
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
}
.main-hd .tt { flex: 1 1 auto; min-width: 0; }
.main-hd h2 { margin: 0; font-size: 14.5px; font-weight: 600; }
.main-hd p { margin: 3px 0 0; font-size: 11.5px; color: hsl(var(--text-400, 48 5% 57%)); }
.saved {
    font-size: 10.5px; color: hsl(var(--text-500, 48 5% 57%));
    opacity: 0; transition: opacity .18s ease; align-self: center; white-space: nowrap;
}
.saved.on { opacity: 1; }

.btn {
    font: inherit; font-size: 11.5px; cursor: pointer; user-select: none;
    padding: 6px 11px; border-radius: 8px; white-space: nowrap; align-self: center;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 11%, transparent);
    color: hsl(var(--text-200, 55 9% 74%));
    transition: background var(--d1) var(--e-out), color var(--d1) var(--e-out),
                border-color var(--d1) var(--e-out), transform var(--d1) var(--e-spring);
}
.btn:active { transform: scale(.955); }
.btn:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
             color: hsl(var(--text-100, 60 14% 97%)); }
.btn.on {
    background: color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 16%, transparent);
    border-color: color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 55%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
}
.btn.arm {
    background: color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 22%, transparent);
    border-color: hsl(var(--cui-accent, 14 62% 60%));
    color: hsl(var(--text-100, 60 14% 97%));
}
.close { padding: 6px 9px; }

/* Every scroll region in the panel is masked at whichever edge is actually
 * clipping, so content dissolves instead of being cut mid-row — the same trick
 * the task rail uses on its list. --ft/--fb are written from JS to the depth that
 * is genuinely hidden, so an edge with nothing past it is not fogged. */
.scroll, .frames, .side-list {
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft, 0px),
        #000 calc(100% - var(--fb, 0px)), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft, 0px),
        #000 calc(100% - var(--fb, 0px)), transparent 100%);
}
.scroll { flex: 1 1 auto; overflow-y: auto; padding: 18px 20px 30px; scrollbar-color: auto;
          scrollbar-gutter: stable; }
.scroll::-webkit-scrollbar { width: 11px; }
.scroll::-webkit-scrollbar-track { background: transparent; }
.scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 16%, transparent);
    border-radius: 7px; border: 3px solid transparent; background-clip: padding-box;
}
.scroll::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 26%, transparent);
    background-clip: padding-box;
}

.sect {
    animation: rowIn var(--d2) var(--e-out) both;
    animation-delay: calc(var(--i, 0) * 16ms);
    font-size: 10.5px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
        color: hsl(var(--text-500, 48 5% 57%)); margin: 0 0 8px 3px; }
.group {
    animation: rowIn var(--d2) var(--e-out) both;
    animation-delay: calc(var(--i, 0) * 16ms);
    border-radius: 12px; overflow: hidden; margin-bottom: 22px;
    background: hsl(var(--bg-000, 60 2% 12.4%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
}
.row {
    position: relative; display: flex; align-items: center; gap: 16px;
    min-height: 48px; padding: 9px 14px;
    transition: background var(--d1) var(--e-out);
}
.row:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 3%, transparent); }
.row + .row::before {
    content: ''; position: absolute; left: 14px; right: 0; top: 0; height: 1px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
}
.row .lab { flex: 1 1 auto; min-width: 0; }
.row .lab b { display: block; font-size: 12.5px; font-weight: 500; }
.row .lab span { display: block; margin-top: 2px; font-size: 11px; line-height: 1.35;
                 color: hsl(var(--text-500, 48 5% 57%)); }
.row .ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }

/* ---- controls ---- */
.sw { width: 40px; height: 24px; border-radius: 12px; cursor: pointer; position: relative;
      background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 15%, transparent);
      transition: background var(--d2) var(--e-out), transform var(--d1) var(--e-out);
      flex: 0 0 auto; }
.sw:active { transform: scale(.94); }
.sw i { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
        background: #fff; transition: transform var(--d2) var(--e-spring), width var(--d1) var(--e-out); }
/* The knob stretches toward where it is going, then settles. */
.sw:active i { width: 22px; }
.sw.on:active i { transform: translateX(12px); }
.sw.on { background: hsl(var(--cui-accent, 14 62% 60%)); }
.sw.on i { transform: translateX(16px); }

input[type=range] {
    -webkit-appearance: none; appearance: none; width: 148px; height: 20px;
    background: transparent; cursor: pointer;
}
input[type=range]::-webkit-slider-runnable-track {
    height: 4px; border-radius: 2px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 16%, transparent);
    transition: background var(--d1) var(--e-out);
}
input[type=range]:hover::-webkit-slider-runnable-track {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 24%, transparent);
}
input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; margin-top: -6px;
    width: 16px; height: 16px; border-radius: 50%;
    background: hsl(var(--cui-accent, 14 62% 60%));
    border: 2px solid hsl(var(--bg-000, 60 2% 12.4%));
    box-shadow: 0 1px 3px rgba(0,0,0,.5);
    transition: transform var(--d1) var(--e-spring), box-shadow var(--d1) var(--e-out);
}
input[type=range]:hover::-webkit-slider-thumb { transform: scale(1.12); }
input[type=range]:active::-webkit-slider-thumb {
    transform: scale(1.3);
    box-shadow: 0 1px 3px rgba(0,0,0,.5), 0 0 0 6px color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 18%, transparent);
}
.val { min-width: 62px; text-align: right; font-size: 11.5px; font-variant-numeric: tabular-nums;
       color: hsl(var(--text-300, 55 9% 74%)); transition: color var(--d2) var(--e-out); }
.val.bump { animation: bump var(--d2) var(--e-spring); color: hsl(var(--text-100, 60 14% 97%)); }

select, input[type=text], input[type=number], input[type=color] {
    transition: border-color var(--d1) var(--e-out), background var(--d1) var(--e-out),
                box-shadow var(--d1) var(--e-out), transform var(--d1) var(--e-spring);
}
select:focus, input[type=text]:focus, input[type=number]:focus {
    outline: none;
    border-color: color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 65%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 16%, transparent);
}
input[type=color]:hover { transform: scale(1.08); }
/* ---- popup layer ----
 * Top level in the shadow root, as a sibling of the panel. A dropdown parented
 * inside .scroll would be clipped by its overflow AND cut by its edge mask, so
 * every popup is positioned from the anchor's viewport rect instead. */
.popups { position: fixed; inset: 0; z-index: 6; pointer-events: none; }
.pop {
    position: fixed; pointer-events: auto; overflow: hidden;
    border-radius: 11px;
    background: hsl(var(--bg-000, 60 2% 12.4%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 14%, transparent);
    box-shadow: 0 16px 44px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4);
    animation: popIn var(--d1) var(--e-out);
}
@keyframes popIn { from { opacity: 0; transform: translateY(-4px) scale(.985); } to { opacity: 1; transform: none; } }
.pop, .pop:focus, .pop:focus-visible, .opt:focus, .opt:focus-visible { outline: none; }
.pop.list { padding: 5px; max-height: 270px; overflow-y: auto; scrollbar-color: auto; }
.pop.list::-webkit-scrollbar { width: 9px; }
.pop.list::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 18%, transparent);
    border-radius: 6px; border: 3px solid transparent; background-clip: padding-box;
}
.opt {
    display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px;
    font-size: 12px; color: hsl(var(--text-200, 55 9% 74%)); cursor: pointer; white-space: nowrap;
    transition: background var(--d1) var(--e-out), color var(--d1) var(--e-out);
}
.opt:hover, .opt.cursor { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
                          color: hsl(var(--text-100, 60 14% 97%)); }
.opt .tick { width: 10px; flex: 0 0 auto; opacity: 0; font-size: 10px;
             color: hsl(var(--cui-accent, 14 62% 60%)); }
.opt.on .tick { opacity: 1; }
.opt.on { color: hsl(var(--text-100, 60 14% 97%)); }

/* ---- combo trigger (replaces <select>, whose option list is OS-drawn) ---- */
.cb {
    display: flex; align-items: center; gap: 8px; max-width: 260px;
    font-size: 12px; padding: 6px 9px; border-radius: 8px; cursor: pointer;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    transition: border-color var(--d1) var(--e-out), background var(--d1) var(--e-out);
}
.cb:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent); }
.cb.open { border-color: color-mix(in srgb, hsl(var(--cui-accent, 14 62% 60%)) 65%, transparent); }
.cb .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb .arw { margin-left: auto; font-size: 8px; opacity: .6; transition: transform var(--d2) var(--e-out); }
.cb.open .arw { transform: rotate(180deg); }

/* ---- colour swatch trigger (replaces <input type=color>, an OS dialog) ---- */
.sw2 {
    width: 30px; height: 26px; border-radius: 7px; cursor: pointer; flex: 0 0 auto;
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 22%, transparent);
    transition: transform var(--d1) var(--e-spring), border-color var(--d1) var(--e-out);
}
.sw2:hover { transform: scale(1.08); }
.sw2.open { border-color: hsl(var(--cui-accent, 14 62% 60%)); }

.pick { padding: 10px; width: 236px; }
.sv { position: relative; height: 116px; border-radius: 8px; cursor: crosshair;
      border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent); }
.hue { position: relative; height: 12px; border-radius: 6px; margin-top: 10px; cursor: ew-resize;
       background: linear-gradient(90deg, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%); }
.knob { position: absolute; width: 12px; height: 12px; border-radius: 50%; pointer-events: none;
        transform: translate(-50%, -50%); border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.6); }
.pick .foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.pick .foot .prev { width: 22px; height: 22px; border-radius: 6px; flex: 0 0 auto;
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 22%, transparent); }
.pick .foot input { flex: 1 1 auto; width: auto; font-family: ui-monospace, monospace; }

select {
    font: inherit; font-size: 12px; padding: 6px 9px; border-radius: 8px; cursor: pointer;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    max-width: 270px;
}
select option { background: hsl(var(--bg-000, 60 2% 12.4%)); color: hsl(var(--text-100, 60 14% 97%)); }

input[type=text], input[type=number] {
    font: inherit; font-size: 12px; padding: 6px 9px; border-radius: 8px; width: 150px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
}
input[type=color] {
    -webkit-appearance: none; appearance: none; width: 30px; height: 26px; padding: 0;
    border-radius: 7px; cursor: pointer; background: transparent;
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 20%, transparent);
}
input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; }
input[type=color]::-webkit-color-swatch { border: none; border-radius: 5px; }

/* ---- preview frames ----
 * Separate floating windows beside the panel, not a strip inside it: the
 * settings and the thing being previewed are two different objects, and a
 * 1:1 stage cannot live in a column that is narrower than the sample. */
.frames {
    display: flex; flex-direction: column; gap: 14px;
    max-height: 88vh; overflow-y: auto; overflow-x: hidden;
    /* Reserve the scrollbar. Without this the frames gain ~15px the moment a
     * scrollbar appears, and .wrap re-centres by half of it — which read as the
     * panel nudging sideways while the overlay was still fading in. */
    scrollbar-gutter: stable;
    padding: 2px; flex: 0 1 auto;
    /* The gap lives on the frames rather than on .wrap so that collapsing them
     * animates the panel back to centre instead of snapping it. */
    margin-left: 16px;
}
.frames.row { flex-direction: row; align-items: flex-start; }
/* display:none cannot be transitioned, so "off" animates first and the display
 * flip happens after, in setPreview(). */
.frames {
    transition: opacity var(--d2) var(--e-out), transform var(--d2) var(--e-out);
}
/* Collapsed to nothing rather than display:none. Flipping display back on
 * RESTARTS every CSS animation on the descendants, which re-fired each frame's
 * 300ms entrance on top of the container's 240ms expansion and landed after it —
 * the hitch at the tail. Suppressing that animation only defers it, so the fix is
 * to never take the element out of the display tree: zero width, zero margin, no
 * gutter, hidden. Layout contribution is identical to display:none. */
.frames.off {
    opacity: 0; transform: translateX(14px) scale(.97); pointer-events: none;
    width: 0; min-width: 0; margin-left: 0; padding: 0;
    visibility: hidden; scrollbar-gutter: auto;
}
.frame {
    animation: frameIn var(--d3) var(--e-out) backwards;
    animation-delay: calc(var(--i, 0) * 55ms);
    flex: 0 0 auto; border-radius: 12px; overflow: hidden;
    background: hsl(var(--bg-100, 0 0% 8%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 13%, transparent);
    box-shadow: 0 18px 50px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.35);
}
.fr-hd {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%));
    background: hsl(var(--bg-200, 0 0% 6.7%));
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
    cursor: move; user-select: none;
}
.fr-hd .d { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto;
            background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 30%, transparent); }
.frame.after .fr-hd .d { background: hsl(var(--cui-accent, 14 62% 60%)); }
.frame.after .fr-hd { color: hsl(var(--text-300, 55 9% 74%)); }
.fr-hd { transition: background var(--d1) var(--e-out); }
.fr-hd:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent); }
.fr-hd .hint { margin-left: auto; opacity: 0; transition: opacity var(--d2) var(--e-out);
               text-transform: none; letter-spacing: 0; font-size: 9.5px; }
/* Dragging writes transform every mousemove, so it must not be transitioned;
 * the snap-back on double click puts the transition back for one beat. */
.frame.glide { transition: transform var(--d3) var(--e-spring); }
.frame.drag { cursor: grabbing; box-shadow: 0 26px 70px rgba(0,0,0,.62), 0 3px 10px rgba(0,0,0,.4); }
.frames.leaving .frame { opacity: 0; transform: scale(.97); transition: opacity var(--d1) var(--e-in), transform var(--d1) var(--e-in); }
.fr-hd:hover .hint { opacity: .55; }
/* 1:1 means 1:1 — an oversized measure scrolls rather than reflowing. */
.pv-stage { padding: 12px 14px; overflow-x: auto; max-width: min(760px, 40vw); }
.frames.row .pv-stage { max-width: none; }

.empty { padding: 40px 4px; text-align: center; font-size: 12px;
         color: hsl(var(--text-500, 48 5% 57%)); }
.kbd { font-family: ui-monospace, monospace; font-size: 10px; padding: 1px 5px; border-radius: 4px;
       background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 10%, transparent); }
`;

// ------------------------------------------------------------------ overlay
let host = null, shadow = null, wrap = null, sideList = null, mainHd = null,
    scroll = null, savedTag = null, frames = null, pvStyle = null, popups = null, open = false;

let previewOpen = localStorage.getItem('cuimod.dash.preview') !== '0';
let previewTimer = null;
let firstPaint = false;        // true only while show() is assembling the overlay
let previewAnimating = false;  // true while the frames are collapsing or expanding

// Show/hide with a real exit: on the way out the class animates and display is
// only dropped once the transition has run; on the way in display comes back
// first so there is a box to animate.
// `animate: false` puts the frames straight into their end state. That matters on
// the overlay's first paint: renderMain() runs before the wrap is shown, so an
// animated open there expanded the frames from zero width while the panel was
// still fading in, dragging the panel across from centre. Only a deliberate
// toggle should move anything.
// Returns true only when it actually animated a change of state, so the caller
// knows whether the container is already moving.
function setPreview(open, node, opts) {
    const f = node || frames;
    const animate = !(opts && opts.animate === false);
    // previewOpen is the user's PREFERENCE, not the container's state. Collapsing
    // the frames because the selected plugin has no preview must not write that
    // preference away — it did, so coming back to a plugin that does have one
    // left the preview shut until you clicked the button again.
    if (!(opts && opts.pref === false)) {
        previewOpen = open;
        localStorage.setItem('cuimod.dash.preview', open ? '1' : '0');
    }
    if (!f) return false;
    clearTimeout(previewTimer);

    if (!animate) {
        for (const a of f.getAnimations()) a.cancel();
        f.style.width = '';
        f.classList.toggle('off', !open);
        return false;
    }

    // Already where it was asked to be. Running the animation anyway is what
    // made every tab switch nudge the panel sideways: with the preview off, the
    // close branch still animated marginLeft 16px -> 0 on frames that were
    // already collapsed, so the centred wrap drifted 8px left and snapped back.
    // With it on, the open branch replayed the whole entrance on frames that
    // were already up. Only a real transition animates.
    if (open === !f.classList.contains('off')) return false;

    // Fading alone left the panel jumping back to centre the instant display
    // flipped, because the frames stopped occupying space in one frame. The width
    // and the gap are animated too, so the layout change is part of the motion.
    const D = MS(240);
    const ease = 'cubic-bezier(.2,.85,.3,1)';
    const shut = { width: '0px', marginLeft: '0px', opacity: 0, transform: 'translateX(14px) scale(.97)' };

    // No overflow juggling here. `scrollbar-gutter: stable` only reserves space
    // while overflow is auto/scroll, so forcing `hidden` for the duration dropped
    // 15px and handed it back in a single frame at the end — the late hitch.
    // .frames already clips horizontally in CSS, so nothing spills anyway.
    previewAnimating = true;
    // A per-frame resize already in flight would keep running through the toggle.
    // The guard stops new ones; this stops the ones that were already going.
    for (const child of f.children) {
        for (const a of child.getAnimations()) { if (a.animationName !== 'frameIn') a.cancel(); }
    }
    const settle = () => { previewAnimating = false; };

    if (open) {
        f.classList.remove('off');
        f.style.width = 'auto';
        const w = f.offsetWidth;                 // natural width, measured once
        f.style.width = '';
        const a = f.animate([shut, { width: w + 'px', marginLeft: '16px', opacity: 1, transform: 'none' }],
                            { duration: D, easing: ease });
        a.finished.then(settle, settle);
        return true;
    } else {
        const w = f.offsetWidth;
        f.classList.add('off');
        const a = f.animate([{ width: w + 'px', marginLeft: '16px', opacity: 1, transform: 'none' }, shut],
                            { duration: D, easing: ease });
        a.finished.then(settle, settle);
        return true;
    }
}
ctx.onDispose(() => clearTimeout(previewTimer));

// Per-frame drag offsets, so a frame you shoved out of the way stays there.
function posKey(plugin, which) { return 'cuimod.dash.pos.' + plugin + '.' + which; }
function readPos(plugin, which) {
    try { return JSON.parse(localStorage.getItem(posKey(plugin, which))) || { x: 0, y: 0 }; }
    catch (_) { return { x: 0, y: 0 }; }
}

function flashSaved() {
    if (!savedTag) return;
    savedTag.classList.add('on');
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => { if (savedTag) savedTag.classList.remove('on'); }, 900);
}
ctx.onDispose(() => clearTimeout(flashSaved.t));

const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
const MS = (n) => (reduced() ? 1 : n);

// Restart a one-shot CSS animation: the class has to leave the element and a
// layout be forced before it goes back on, or the browser sees no change.
function replay(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
}

// Fade depth per edge = how much is actually scrolled out of view, capped. A box
// whose content fits, or one scrolled to its true end, gets no fade at that edge.
const FADE = 22;
function fadeEdges(node) {
    if (!node) return;
    const above = node.scrollTop;
    const below = node.scrollHeight - node.clientHeight - node.scrollTop;
    const t = Math.round(Math.max(0, Math.min(FADE, above)));
    const b = Math.round(Math.max(0, Math.min(FADE, below)));
    if (node.style.getPropertyValue('--ft') !== t + 'px') node.style.setProperty('--ft', t + 'px');
    if (node.style.getPropertyValue('--fb') !== b + 'px') node.style.setProperty('--fb', b + 'px');
}

let fadeRaf = 0;
function refreshFades() {
    if (fadeRaf || !shadow) return;
    fadeRaf = requestAnimationFrame(() => {
        fadeRaf = 0;
        for (const n of [scroll, frames, sideList]) fadeEdges(n);
    });
}
ctx.onDispose(() => { if (fadeRaf) cancelAnimationFrame(fadeRaf); });

function watchFade(node) {
    if (!node) return;
    node.addEventListener('scroll', refreshFades, { passive: true });
    // Content height changes on tab switch, on a frame resize, and while a
    // slider is being dragged — all of which move the clipping edges.
    const ro = new ResizeObserver(refreshFades);
    ro.observe(node);
    if (node.firstElementChild) ro.observe(node.firstElementChild);
    fadeObservers.push(ro);
}
const fadeObservers = [];
ctx.onDispose(() => { for (const ro of fadeObservers) { try { ro.disconnect(); } catch (_) {} } fadeObservers.length = 0; });

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function build() {
    if (host) return;
    const stale = document.getElementById('cuimod-dash');
    if (stale) stale.remove();

    host = el('div');
    host.id = 'cuimod-dash';
    shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];

    wrap = el('div', 'wrap');
    const panel = el('div', 'panel');
    panel.tabIndex = -1;

    const side = el('div', 'side');
    const sideHd = el('div', 'side-hd');
    const sub = el('p');
    sub.append('toggle with ', el('span', 'kbd', 'Insert'));
    sideHd.append(el('h1', null, 'Plugin dashboard'), sub);
    sideList = el('div', 'side-list');
    const sideFt = el('div', 'side-ft', 'settings.json');
    cuimod.rpc('dashboard.path').then((p) => { sideFt.textContent = p; }).catch(() => {});
    side.append(sideHd, sideList, sideFt);

    const main = el('div', 'main');
    mainHd = el('div', 'main-hd');
    scroll = el('div', 'scroll');
    pvStyle = document.createElement('style');
    main.append(mainHd, scroll);

    panel.append(side, main);
    frames = el('div', 'frames' + (previewOpen ? '' : ' off'));
    popups = el('div', 'popups');
    wrap.append(panel, frames, popups);
    shadow.append(wrap, pvStyle);

    // Clicking the dim area closes; clicking the panel must not.
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) hide(); });
    // The app binds its shortcuts on the document. While the overlay owns the
    // keyboard, they must not fire underneath it.
    panel.addEventListener('keydown', (e) => { if (e.key !== 'Insert' && e.key !== 'Escape') e.stopPropagation(); });

    // The overlay is not a web page: the app's own right-click menu has nothing
    // useful for it. Suppressed everywhere, and text fields get the same styled
    // copy/paste popup the colour swatches use.
    wrap.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const t = e.target;
        const editable = t && t.tagName === 'INPUT' && /^(text|number)$/.test(t.type);
        if (!editable) return;
        const list = el('div', 'pop list');
        const item = (text, fn) => {
            const row = el('div', 'opt');
            row.append(el('span', 'tick'), el('span', null, text));
            row.addEventListener('click', () => { closePop(); fn(); });
            list.append(row);
        };
        item('Copy', () => cuimod.rpc('dashboard.clipWrite', { text: String(t.value) }).catch(() => {}));
        item('Paste', () => cuimod.rpc('dashboard.clipRead').then((v) => {
            if (typeof v !== 'string' || !v) return;
            t.value = v.trim();
            t.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {}));
        showPop(list, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    });

    popGuards();
    document.documentElement.appendChild(host);
    for (const n of [scroll, frames, sideList]) watchFade(n);
    refreshFades();
}
ctx.onDispose(() => { if (host) { try { host.remove(); } catch (_) {} } host = null; });

// ------------------------------------------------------------------ controls
function fmt(v, c) {
    const n = Number(v);
    const dp = String(c.step == null ? 1 : c.step).split('.')[1];
    return (dp ? n.toFixed(dp.length) : String(n)) + (c.unit || '');
}

// ------------------------------------------------------------------ popups
// One live popup at a time. Positioned from the anchor's viewport rect, flipped
// up when there is no room below, and clamped inside the window. Parented to the
// .popups layer rather than the row, because a child of .scroll would be cut by
// both its overflow and its edge mask.
let openPop = null;
function closePop() {
    if (!openPop) return;
    const { node, onClose } = openPop;
    openPop = null;
    try { node.remove(); } catch (_) {}
    if (onClose) { try { onClose(); } catch (_) {} }
}
ctx.onDispose(closePop);

function showPop(node, rect, opts) {
    closePop();
    const o = opts || {};
    if (!popups) return null;
    node.style.visibility = 'hidden';
    popups.append(node);
    openPop = { node, onClose: o.onClose };

    const w = node.offsetWidth, h = node.offsetHeight, pad = 8;
    let x = o.alignRight ? rect.right - w : rect.left;
    let y = rect.bottom + 6;
    if (y + h + pad > innerHeight) y = Math.max(pad, rect.top - h - 6);
    x = Math.max(pad, Math.min(x, innerWidth - w - pad));
    node.style.left = Math.round(x) + 'px';
    node.style.top = Math.round(y) + 'px';
    node.style.visibility = '';
    return closePop;
}

// Any pointer press outside the popup, Escape, or a scroll underneath dismisses.
function popGuards() {
    shadow.addEventListener('pointerdown', (e) => {
        if (!openPop) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (path.indexOf(openPop.node) === -1) closePop();
    }, true);
    shadow.addEventListener('keydown', (e) => {
        if (openPop && e.key === 'Escape') { e.stopPropagation(); closePop(); }
    }, true);
    if (scroll) scroll.addEventListener('scroll', closePop, { passive: true });
}

// ------------------------------------------------------------------ colour
const clampUnit = (n) => Math.max(0, Math.min(1, n));

function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0;
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let hh = 0;
    if (d) {
        if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) hh = ((b - r) / d + 2) / 6;
        else hh = ((r - g) / d + 4) / 6;
    }
    return { h: hh * 360, s: max ? d / max : 0, v: max };
}
function hsvToHex(h, sat, val) {
    const ch = (i) => {
        const k = (i + h / 60) % 6;
        return Math.round((val - val * sat * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    const to = (n) => n.toString(16).padStart(2, '0');
    return '#' + to(ch(5)) + to(ch(3)) + to(ch(1));
}
const isHex = (t) => /^#?[0-9a-f]{6}$/i.test(String(t).trim());
const normHex = (t) => '#' + String(t).trim().replace('#', '').toLowerCase();

// Shared by the saturation box and the hue strip: reports 0..1 per axis, and
// keeps tracking after the pointer leaves the element.
function dragArea(node, onMove) {
    const at = (e) => {
        const r = node.getBoundingClientRect();
        onMove(clampUnit((e.clientX - r.left) / r.width), clampUnit((e.clientY - r.top) / r.height));
    };
    node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { node.setPointerCapture(e.pointerId); } catch (_) {}
        at(e);
        const move = (ev) => at(ev);
        const up = () => {
            node.removeEventListener('pointermove', move);
            node.removeEventListener('pointerup', up);
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
    });
}

// ------------------------------------------------------------------ combo
function comboControl(spec, c, values) {
    const labelOf = (val) => {
        const hit = (c.options || []).find((o) => String(o.value) === String(val));
        return hit ? hit.label : String(val);
    };
    let cur = values[c.key];
    const trig = el('div', 'cb');
    const lbl = el('span', 'lbl', labelOf(cur));
    trig.append(lbl, el('span', 'arw', '▼'));

    trig.addEventListener('click', () => {
        if (openPop && openPop.owner === trig) { closePop(); return; }
        const list = el('div', 'pop list');
        list.tabIndex = -1;
        let cursor = Math.max(0, (c.options || []).findIndex((o) => String(o.value) === String(cur)));
        const rows = (c.options || []).map((o, i) => {
            const row = el('div', 'opt' + (String(o.value) === String(cur) ? ' on' : ''));
            row.append(el('span', 'tick', '✓'), el('span', null, o.label));
            row.addEventListener('click', () => {
                cur = o.value;
                lbl.textContent = o.label;
                setValue(spec, c.key, o.value);
                closePop();
            });
            row.addEventListener('pointerenter', () => setCursor(i));
            list.append(row);
            return row;
        });
        function setCursor(i) {
            cursor = i;
            rows.forEach((r, n) => r.classList.toggle('cursor', n === i));
            if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
        }
        list.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(Math.min(rows.length - 1, cursor + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(Math.max(0, cursor - 1)); }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (rows[cursor]) rows[cursor].click(); }
        });

        trig.classList.add('open');
        showPop(list, trig.getBoundingClientRect(), { onClose: () => trig.classList.remove('open') });
        if (openPop) openPop.owner = trig;
        list.style.minWidth = trig.offsetWidth + 'px';
        setCursor(cursor);
        list.focus();
    });
    return [trig];
}

// ------------------------------------------------------------------ colour pick
function colorControl(spec, c, values) {
    let hex = normHex(values[c.key] || '#000000');
    const hexLbl = el('div', 'val', hex.toUpperCase());
    const sw = el('div', 'sw2');
    sw.style.background = hex;

    const commit = (next, live) => {
        hex = normHex(next);
        sw.style.background = hex;
        hexLbl.textContent = hex.toUpperCase();
        setValue(spec, c.key, hex);
        if (!live) replay(hexLbl, 'bump');
    };

    sw.addEventListener('click', () => {
        if (openPop && openPop.owner === sw) { closePop(); return; }
        const hsv = hexToHsv(hex);
        const box = el('div', 'pop pick');
        const sv = el('div', 'sv');
        const svKnob = el('div', 'knob');
        sv.append(svKnob);
        const hue = el('div', 'hue');
        const hueKnob = el('div', 'knob');
        hue.append(hueKnob);
        const foot = el('div', 'foot');
        const prev = el('div', 'prev');
        const field = document.createElement('input');
        field.type = 'text';
        foot.append(prev, field);
        box.append(sv, hue, foot);

        const paint = (live) => {
            const val = hsvToHex(hsv.h, hsv.s, hsv.v);
            sv.style.background = 'linear-gradient(to top, #000, transparent), '
                + 'linear-gradient(to right, #fff, ' + hsvToHex(hsv.h, 1, 1) + ')';
            svKnob.style.left = (hsv.s * 100) + '%';
            svKnob.style.top = ((1 - hsv.v) * 100) + '%';
            svKnob.style.background = val;
            hueKnob.style.left = (hsv.h / 360 * 100) + '%';
            hueKnob.style.top = '50%';
            hueKnob.style.background = hsvToHex(hsv.h, 1, 1);
            prev.style.background = val;
            field.value = val.toUpperCase();
            commit(val, live);
        };
        dragArea(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; paint(true); });
        dragArea(hue, (x) => { hsv.h = x * 360; paint(true); });
        field.addEventListener('change', () => {
            if (!isHex(field.value)) { field.value = hex.toUpperCase(); return; }
            const next = hexToHsv(field.value);
            hsv.h = next.h; hsv.s = next.s; hsv.v = next.v;
            paint(false);
        });

        sw.classList.add('open');
        showPop(box, sw.getBoundingClientRect(), { alignRight: true, onClose: () => sw.classList.remove('open') });
        if (openPop) openPop.owner = sw;
        paint(true);
    });

    // Right click: copy or paste the hex. Clipboard goes through main, because
    // navigator.clipboard.readText() has a permission gate the isolated world
    // never gets prompted for and silently rejects.
    const menu = (e) => {
        e.preventDefault();
        e.stopPropagation();   // the wrap-level handler must not replace this menu
        const list = el('div', 'pop list');
        const item = (text, fn) => {
            const row = el('div', 'opt');
            row.append(el('span', 'tick'), el('span', null, text));
            row.addEventListener('click', () => { closePop(); fn(); });
            list.append(row);
        };
        item('Copy ' + hex.toUpperCase(), () => {
            cuimod.rpc('dashboard.clipWrite', { text: hex.toUpperCase() }).catch(() => {});
            replay(hexLbl, 'bump');
        });
        item('Paste hex', () => {
            cuimod.rpc('dashboard.clipRead').then((t) => {
                if (isHex(t)) commit(t, false);
                else replay(hexLbl, 'bump');
            }).catch(() => {});
        });
        const at = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
        showPop(list, at);
    };
    sw.addEventListener('contextmenu', menu);
    hexLbl.addEventListener('contextmenu', menu);

    return [hexLbl, sw];
}

function control(spec, c, values) {
    const v = values[c.key];

    if (c.type === 'toggle') {
        const sw = el('div', 'sw' + (v ? ' on' : ''));
        sw.append(el('i'));
        sw.addEventListener('click', () => {
            const next = !sw.classList.contains('on');
            sw.classList.toggle('on', next);
            setValue(spec, c.key, next);
        });
        return [sw];
    }

    if (c.type === 'slider') {
        const r = document.createElement('input');
        r.type = 'range';
        r.min = c.min; r.max = c.max; r.step = c.step == null ? 1 : c.step; r.value = v;
        const out = el('div', 'val', fmt(v, c));
        r.addEventListener('input', () => {
            const n = Number(r.value);
            out.textContent = fmt(n, c);
            setValue(spec, c.key, n);
        });
        // Bump on release, not on every input event: a bump per pixel of drag is
        // noise, a bump when the value lands is feedback.
        r.addEventListener('change', () => replay(out, 'bump'));
        return [r, out];
    }

    // Both of these were native elements whose popups the OS draws, so no amount
    // of CSS ever reached them. They are real widgets now.
    if (c.type === 'combo') return comboControl(spec, c, values);
    if (c.type === 'color') return colorControl(spec, c, values);

    const t = document.createElement('input');
    t.type = c.type === 'number' ? 'number' : 'text';
    if (c.type === 'number') { t.min = c.min; t.max = c.max; t.step = c.step == null ? 1 : c.step; }
    t.value = v;
    t.addEventListener('change', () => setValue(spec, c.key, c.type === 'number' ? Number(t.value) : t.value));
    return [t];
}

// ------------------------------------------------------------------ preview
function refreshPreview(spec) {
    if (!pvStyle || !spec || !spec.preview) return;
    const v = merged(spec);
    try {
        pvStyle.textContent =
            spec.preview.css(spec.defaults, '.pv-before', 'before') +
            spec.preview.css(v, '.pv-after', 'after');
    } catch (e) { cuimod.log('dashboard: preview css failed: ' + (e && e.message)); }
}

function dragFrame(frame, head, plugin, which) {
    const pos = readPos(plugin, which);
    // The offset is published as custom properties as well as a transform: the
    // entrance keyframes read the vars, so a frame you dragged last session
    // animates in where you left it instead of flying from the default slot.
    const place = () => {
        frame.style.setProperty('--tx', pos.x + 'px');
        frame.style.setProperty('--ty', pos.y + 'px');
        frame.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    };
    place();

    head.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        frame.classList.remove('glide');   // never transition a live drag
        frame.classList.add('drag');
        const x0 = e.clientX - pos.x, y0 = e.clientY - pos.y;
        const move = (ev) => { pos.x = ev.clientX - x0; pos.y = ev.clientY - y0; place(); };
        const up = () => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            frame.classList.remove('drag');
            try { localStorage.setItem(posKey(plugin, which), JSON.stringify(pos)); } catch (_) {}
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    });

    // Double click the title bar to glide back beside the panel.
    head.addEventListener('dblclick', () => {
        pos.x = 0; pos.y = 0;
        frame.classList.add('glide');
        place();
        setTimeout(() => frame.classList.remove('glide'), MS(320));
        try { localStorage.removeItem(posKey(plugin, which)); } catch (_) {}
    });
}

// A frame is sized by its content, so changing a measure or a font resizes it
// instantly and the jump is the most jarring thing in the overlay. Animate from
// the previous box to the new one; the guard stops the observer from reacting to
// its own animation and looping.
// Sizes come from offsetWidth/offsetHeight, not getBoundingClientRect: the rect
// includes transforms, so a frame's scale/rotate entrance looked like a resize and
// this animated real width in response — a feedback loop that shrank the layout.
function smoothResize(node) {
    let w = null, h = null, busy = false;
    const ro = new ResizeObserver(() => {
        if (busy) return;
        // While the container is collapsing or expanding, every frame is being
        // resized by that animation. Animating each of them again on top layered
        // a second 240ms motion that outlived the first and settled visibly late.
        const nw = node.offsetWidth, nh = node.offsetHeight;
        if (previewAnimating) { w = nw; h = nh; return; }
        if (w !== null && (Math.abs(nw - w) > 0.5 || Math.abs(nh - h) > 0.5) && !reduced()) {
            busy = true;
            const a = node.animate(
                [{ width: w + 'px', height: h + 'px' }, { width: nw + 'px', height: nh + 'px' }],
                { duration: MS(240), easing: 'cubic-bezier(.2,.85,.3,1)' });
            a.finished.then(() => { busy = false; }, () => { busy = false; });
        }
        w = nw; h = nh;
    });
    ro.observe(node);
    ctx.onDispose(() => ro.disconnect());
}

function renderPreview(spec) {
    if (!frames) return;
    // Measured before the old stages are thrown away: if the preview stays open
    // across the switch it is this width the new one has to animate from.
    const wasOpen = !frames.classList.contains('off');
    const prevW = wasOpen ? frames.offsetWidth : 0;

    frames.textContent = '';
    if (pvStyle) pvStyle.textContent = '';

    const p = spec && spec.preview;
    frames.classList.remove('leaving');
    frames.classList.toggle('row', !!(p && p.layout === 'row'));

    if (p) buildStages(spec, p);

    // Toggled AFTER the stages exist. setPreview measures the container's
    // natural width to animate towards, and it used to run while the container
    // was still empty — so opening the preview by moving onto a plugin that has
    // one animated width to 4px and then jumped to the real width at the end.
    // Instant while the overlay is being built; animated afterwards, so moving
    // to a plugin with no preview still collapses smoothly.
    const changed = setPreview(previewOpen && !!p, frames, { animate: !firstPaint, pref: false });

    // Same state either side of the switch, so setPreview left the container
    // alone: no fade out and back in, just the one dimension that really did
    // change. Without this the width jumps from the old plugin's stage to the
    // new one's and drags the centred panel with it.
    if (p && !changed && wasOpen && !firstPaint && !reduced()) {
        const nw = frames.offsetWidth;
        if (Math.abs(nw - prevW) > 0.5) {
            previewAnimating = true;
            const settle = () => { previewAnimating = false; };
            const a = frames.animate([{ width: prevW + 'px' }, { width: nw + 'px' }],
                                     { duration: MS(240), easing: 'cubic-bezier(.2,.85,.3,1)' });
            a.finished.then(settle, settle);
        }
    }
}

function buildStages(spec, p) {
    const labels = [
        ['before', p.beforeLabel || 'app default'],
        ['after', p.afterLabel || 'your settings'],
    ];
    let fi = 0;
    for (const [which, label] of labels) {
        const frame = el('div', 'frame ' + which);
        frame.style.setProperty('--i', String(fi));
        frame.style.setProperty('--rot', (fi === 0 ? -0.9 : 0.9) + 'deg');
        fi++;
        const head = el('div', 'fr-hd');
        head.append(el('span', 'd'), el('span', null, which + ' — ' + label),
                    el('span', 'hint', 'drag · dbl-click to reset'));
        const stage = el('div', 'pv-stage pv-' + which);
        try { stage.append(p.node(which)); }
        catch (e) { stage.append(el('div', 'pv-empty', 'preview failed: ' + (e && e.message))); }
        frame.append(head, stage);
        dragFrame(frame, head, spec.plugin, which);
        frames.append(frame);
        smoothResize(frame);
    }
    refreshPreview(spec);
}

// ------------------------------------------------------------------ render
let navInd = null;

function moveIndicator() {
    if (!sideList || !navInd) return;
    const on = sideList.querySelector('.nav.on');
    if (!on) { navInd.classList.remove('on'); return; }
    // offsetTop/Height are layout values, so the navs' own entrance transform
    // does not drag the indicator around with it.
    navInd.style.top = on.offsetTop + 'px';
    navInd.style.height = on.offsetHeight + 'px';
    navInd.classList.add('on');
}

function renderSidebar() {
    if (!sideList) return;
    sideList.textContent = '';
    navInd = el('div', 'nav-ind');
    sideList.append(navInd);

    const names = [...REG.specs.keys()].sort();
    if (!current || !REG.specs.has(current)) current = names[0] || null;
    names.forEach((name, i) => {
        const spec = REG.specs.get(name);
        const row = el('div', 'nav' + (name === current ? ' on' : ''));
        row.style.setProperty('--i', String(i));
        row.dataset.plugin = name;
        row.append(el('span', 'dot'), el('span', 'nm', spec.title || name),
                   el('span', 'ct', String((spec.controls || []).length)));
        row.addEventListener('click', () => select(name));
        sideList.append(row);
    });
    // The indicator must not travel on first paint, only between selections.
    requestAnimationFrame(() => {
        const prev = navInd.style.transition;
        navInd.style.transition = 'none';
        moveIndicator();
        void navInd.offsetWidth;
        navInd.style.transition = prev;
    });
}

// Tab switch: the outgoing content leaves, then the new content plays its own
// staggered entrance. The indicator and the frames move at the same time, so the
// three surfaces read as one gesture rather than three unrelated redraws.
function select(name) {
    if (name === current || !sideList) return;
    current = name;
    for (const n of sideList.querySelectorAll('.nav')) {
        n.classList.toggle('on', n.dataset.plugin === name);
    }
    moveIndicator();

    if (!scroll || reduced()) { renderMain(); return; }
    if (frames) frames.classList.add('leaving');
    const out = scroll.animate(
        [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }],
        { duration: MS(105), easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' });
    out.finished.then(() => { renderMain(); out.cancel(); }, () => { renderMain(); });
}

function renderMain() {
    if (!scroll || !mainHd) return;
    mainHd.textContent = '';
    scroll.textContent = '';

    const spec = current && REG.specs.get(current);
    if (!spec) {
        scroll.append(el('div', 'empty', 'No plugin has registered a settings panel.'));
        return;
    }

    const tt = el('div', 'tt');
    tt.append(el('h2', null, spec.title || spec.plugin));
    if (spec.description) tt.append(el('p', null, spec.description));
    savedTag = el('div', 'saved', 'saved');

    const pvBtn = el('div', 'btn' + (previewOpen ? ' on' : ''), 'Preview');
    if (!spec.preview) pvBtn.style.display = 'none';
    pvBtn.addEventListener('click', () => {
        setPreview(!previewOpen);
        pvBtn.classList.toggle('on', previewOpen);
    });

    const resetBtn = el('div', 'btn', 'Reset defaults');
    armReset(resetBtn, spec);
    const closeBtn = el('div', 'btn close', 'Esc');
    closeBtn.addEventListener('click', hide);
    mainHd.append(tt, savedTag, pvBtn, resetBtn, closeBtn);

    const values = merged(spec);
    const groups = new Map();
    for (const c of spec.controls || []) {
        const g = c.group || 'Settings';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(c);
    }
    let gi = 0;
    for (const [title, list] of groups) {
        const sect = el('div', 'sect', title);
        sect.style.setProperty('--i', String(gi));
        scroll.append(sect);
        const box = el('div', 'group');
        box.style.setProperty('--i', String(gi + 1));
        gi += 2;
        for (const c of list) {
            const row = el('div', 'row');
            const lab = el('div', 'lab');
            lab.append(el('b', null, c.label || c.key));
            if (c.hint) lab.append(el('span', null, c.hint));
            const ctl = el('div', 'ctl');
            for (const node of control(spec, c, values)) ctl.append(node);
            row.append(lab, ctl);
            box.append(row);
        }
        scroll.append(box);
    }

    renderPreview(spec);
    refreshFades();
}

// Two clicks, not one: the first arms the button and it disarms itself after a
// few seconds, so a stray click can never wipe a plugin's settings.
function armReset(btn, spec) {
    let armed = false, t = null;
    const disarm = () => { armed = false; btn.classList.remove('arm'); btn.textContent = 'Reset defaults'; };
    btn.addEventListener('click', () => {
        if (!armed) {
            armed = true;
            btn.classList.add('arm');
            btn.textContent = 'Click again to confirm';
            clearTimeout(t);
            t = setTimeout(disarm, 3000);
            return;
        }
        clearTimeout(t);
        disarm();
        delete stored[spec.plugin];
        cuimod.rpc('dashboard.reset', { plugin: spec.plugin }).then(flashSaved).catch(() => {});
        applySpec(spec);
        renderMain();
    });
    ctx.onDispose(() => clearTimeout(t));
}

// ------------------------------------------------------------------ toggle
function show() {
    build();
    open = true;
    firstPaint = true;
    renderSidebar();
    renderMain();
    firstPaint = false;
    requestAnimationFrame(() => {
        if (!wrap) return;
        wrap.classList.remove('closing');
        wrap.classList.add('show');
        const p = shadow.querySelector('.panel');
        if (p) p.focus();
    });
}
function hide() {
    open = false;
    if (!wrap) return;
    // Frames leave first and slightly faster, so the panel is the last thing
    // off screen rather than everything vanishing on the same frame.
    if (frames) frames.classList.add('leaving');
    wrap.classList.remove('show');
    wrap.classList.add('closing');
    setTimeout(() => {
        if (open || !host) return;
        try { host.remove(); } catch (_) {}
        host = null; shadow = null; wrap = null; sideList = null; mainHd = null;
        scroll = null; savedTag = null; frames = null; pvStyle = null; navInd = null; popups = null;
    }, MS(190));
}
function toggle() { if (open) hide(); else show(); }

ctx.track(window, 'keydown', (e) => {
    if (e.key === 'Insert' && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
        return;
    }
    if (open && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
    }
}, { capture: true });

// ------------------------------------------------------------------ boot
function onRegistryChange() {
    if (!loaded) return;
    applyAll();
    if (open) { renderSidebar(); renderMain(); }
}
REG.subs.add(onRegistryChange);
ctx.onDispose(() => REG.subs.delete(onRegistryChange));

cuimod.rpc('dashboard.load')
    .then((v) => { stored = v && typeof v === 'object' ? v : {}; })
    .catch(() => { stored = {}; })
    .then(() => { loaded = true; applyAll(); if (open) { renderSidebar(); renderMain(); } });
