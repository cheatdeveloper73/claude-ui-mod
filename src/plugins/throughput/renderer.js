/* claude-ui-mod :: throughput (renderer)
 *
 * The readout. It lives inside the dashboard panel as a `custom` control, so it
 * inherits the app's theme tokens and the panel's motion vocabulary instead of
 * inventing a second visual language beside them.
 *
 * Two rules shape the whole file:
 *
 * 1. It patches, never rebuilds. Every list is keyed — by response id, by lane,
 *    by model — and a poll updates the text of existing nodes. Clearing a
 *    container and re-appending would restart every entrance animation and make
 *    a one-second poll look like a strobe.
 *
 * 2. It never dresses an estimate as a measurement. A completed response's
 *    tok/s is exact: the provider's own token count over this router's own
 *    clocks. An in-flight stream usually has no token count yet, so its rate is
 *    marked `est` and derived from measured chars-per-token for that same model.
 *    The two are visually distinct and the panel says which is which.
 *
 * The panel only polls while it is on screen and the window is visible: one
 * timer, checked against the configured cadence, doing nothing the rest of the
 * time.
 */
'use strict';

let settings = {
    scope: 'session',
    pollMs: 1000,
    basis: 'generation',
    historyHours: 24,
    showEstimated: true,
    rows: 8,
    showChip: true,
    chipMs: 700,
};

let root = null;          // the persistent node handed to the panel
let parts = null;         // its keyed sub-containers
let lastPoll = 0;
let busy = false;
let sessionId = cuimod.sessionId || null;

cuimod.onSessionChange((id) => { sessionId = id; lastPoll = 0; });

// ---------------------------------------------------------------- formatting
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function tps(value) {
    const v = num(value);
    if (v === null) return '—';
    if (v >= 1000) return Math.round(v).toLocaleString();
    if (v >= 100) return v.toFixed(0);
    return v.toFixed(1);
}

function tokens(value) {
    const v = num(value);
    if (v === null) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e4) return Math.round(v / 1000) + 'k';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
}

function ms(value) {
    const v = num(value);
    if (v === null) return '—';
    if (v >= 10000) return (v / 1000).toFixed(0) + 's';
    if (v >= 1000) return (v / 1000).toFixed(1) + 's';
    return Math.round(v) + 'ms';
}

// qwen outlives its removal here on purpose: the throughput ledger is append-only
// and still holds real qwen rows, which would otherwise all render at hue 0.
const PROVIDER_HUE = { claude: 24, gemini: 208, openai: 152, qwen: 282 };
const hueOf = (provider) => (PROVIDER_HUE[provider] === undefined ? 0 : PROVIDER_HUE[provider]);

// ---------------------------------------------------------------- structure
function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

const CSS = `
.tp { display: flex; flex-direction: column; gap: 12px; font-size: 12px;
      color: hsl(var(--text-200, 60 8% 88%)); }
.tp .hd { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.tp .hd b { font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
            color: hsl(var(--text-500, 48 5% 57%)); }
.tp .hd span { font-size: 10.5px; color: hsl(var(--text-500, 48 5% 57%)); }

/* The one number the panel exists to show. */
.tp .now { display: flex; align-items: flex-end; gap: 14px; padding: 14px 16px; border-radius: 10px;
           background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 5%, transparent); }
.tp .now .big { font-variant-numeric: tabular-nums; font-size: 34px; line-height: 1;
                font-weight: 300; letter-spacing: -.02em; color: hsl(var(--text-100, 60 14% 97%)); }
.tp .now .unit { font-size: 11px; padding-bottom: 3px; color: hsl(var(--text-500, 48 5% 57%)); }
.tp .now .side { margin-left: auto; text-align: right; font-size: 11px; line-height: 1.5;
                 color: hsl(var(--text-500, 48 5% 57%)); }
.tp .now .side em { font-style: normal; font-variant-numeric: tabular-nums;
                    color: hsl(var(--text-200, 60 8% 88%)); }

.tp .list { display: flex; flex-direction: column; border-radius: 9px; overflow: hidden;
            background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 3%, transparent); }
.tp .r { display: flex; align-items: center; gap: 9px; padding: 7px 11px; min-height: 32px;
         animation: tpIn 200ms cubic-bezier(.2,.85,.3,1) both; }
.tp .r + .r { box-shadow: inset 0 1px 0 color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent); }
@keyframes tpIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.tp .dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
           background: hsl(var(--h) 60% 58%); }
.tp .r.flow .dot { animation: tpPulse 1.1s ease-in-out infinite; }
@keyframes tpPulse { 0%,100% { opacity: 1; } 50% { opacity: .28; } }

.tp .nm { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tp .nm b { font-size: 11.5px; font-weight: 500; color: hsl(var(--text-200, 60 8% 88%));
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp .nm span { font-size: 10px; color: hsl(var(--text-500, 48 5% 57%));
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tp .tag { flex: 0 0 auto; font-size: 9.5px; letter-spacing: .04em; text-transform: uppercase;
           padding: 2px 6px; border-radius: 5px;
           background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 10%, transparent);
           color: hsl(var(--text-400, 50 5% 70%)); }
.tp .tag.main { background: color-mix(in srgb, hsl(24 60% 58%) 22%, transparent);
                color: hsl(var(--text-100, 60 14% 97%)); }

.tp .val { flex: 0 0 auto; text-align: right; font-variant-numeric: tabular-nums;
           display: flex; flex-direction: column; gap: 1px; min-width: 62px; }
.tp .val b { font-size: 12.5px; font-weight: 500; color: hsl(var(--text-100, 60 14% 97%)); }
.tp .val span { font-size: 9.5px; color: hsl(var(--text-500, 48 5% 57%)); }
.tp .val.est b { color: hsl(var(--text-400, 50 5% 70%)); }
.tp .val.est b::after { content: ' est'; font-size: 9px; letter-spacing: .04em; }

.tp .empty { padding: 16px 11px; text-align: center; font-size: 11px;
             color: hsl(var(--text-500, 48 5% 57%)); }
.tp .err { padding: 9px 11px; font-size: 11px; border-radius: 8px;
           color: hsl(8 70% 70%); background: color-mix(in srgb, hsl(8 70% 60%) 12%, transparent); }
.tp .foot { display: flex; align-items: center; gap: 10px; font-size: 10.5px;
            color: hsl(var(--text-500, 48 5% 57%)); }
.tp .foot .btn { margin-left: auto; cursor: pointer; padding: 4px 9px; border-radius: 6px;
                 background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
                 color: hsl(var(--text-200, 60 8% 88%)); transition: background 110ms; }
.tp .foot .btn:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 16%, transparent); }
`;

function section(title, hint) {
    const wrap = el('div', 'sec');
    const head = el('div', 'hd');
    const heading = el('b', null, title);
    const note = el('span');
    if (hint) note.textContent = hint;
    head.append(heading, note);
    const list = el('div', 'list');
    wrap.append(head, list);
    return { wrap, list, note, heading };
}

function build() {
    const node = el('div', 'tp');
    const style = document.createElement('style');
    style.textContent = CSS;

    const now = el('div', 'now');
    const big = el('div', 'big', '—');
    const unit = el('div', 'unit', 'tok/s');
    const side = el('div', 'side');
    now.append(big, unit, side);

    const live = section('In flight', '');
    const lanes = section('Lanes, this session', '');
    const models = section('Models', '');
    const recent = section('Recent responses', '');

    const err = el('div', 'err');
    err.style.display = 'none';

    const foot = el('div', 'foot');
    const footText = el('span', null, '');
    const reveal = el('div', 'btn', 'Show ledger');
    reveal.addEventListener('click', () => {
        cuimod.rpc('throughput.revealLedger').catch((e) => cuimod.log('throughput: reveal failed: ' + (e && e.message)));
    });
    foot.append(footText, reveal);

    node.append(style, err, now, live.wrap, lanes.wrap, models.wrap, recent.wrap, foot);
    parts = { big, unit, side, live, lanes, models, recent, err, footText };
    return node;
}

// A keyed patch. Rows that survive are updated in place, new ones animate in,
// and departed ones are removed — the list never blinks.
function patch(list, entries) {
    const seen = new Set();
    let previous = null;
    for (const entry of entries) {
        seen.add(entry.key);
        if (!list.__rows) list.__rows = new Map();
        let row = list.__rows.get(entry.key);
        if (!row) {
            row = el('div', 'r');
            row.__dot = el('div', 'dot');
            row.__name = el('div', 'nm');
            row.__nameMain = el('b');
            row.__nameSub = el('span');
            row.__name.append(row.__nameMain, row.__nameSub);
            row.__tag = el('div', 'tag');
            row.__val = el('div', 'val');
            row.__valMain = el('b');
            row.__valSub = el('span');
            row.__val.append(row.__valMain, row.__valSub);
            row.append(row.__dot, row.__name, row.__tag, row.__val);
            list.__rows.set(entry.key, row);
        }
        row.style.setProperty('--h', String(entry.hue));
        row.classList.toggle('flow', entry.flowing === true);
        row.__nameMain.textContent = entry.title;
        row.__nameSub.textContent = entry.subtitle || '';
        row.__tag.textContent = entry.tag || '';
        row.__tag.className = 'tag' + (entry.tagMain ? ' main' : '');
        row.__tag.style.display = entry.tag ? '' : 'none';
        row.__valMain.textContent = entry.value;
        row.__valSub.textContent = entry.unit || '';
        row.__val.className = 'val' + (entry.estimated ? ' est' : '');
        // Reorder without detaching: insertBefore on an already-placed node is a
        // move, which keeps its running animation rather than restarting it.
        const after = previous ? previous.nextSibling : list.firstChild;
        if (row !== after) list.insertBefore(row, after);
        previous = row;
    }
    if (list.__rows) {
        for (const [key, row] of list.__rows) {
            if (seen.has(key)) continue;
            row.remove();
            list.__rows.delete(key);
        }
    }
    if (!entries.length) {
        if (!list.__empty) { list.__empty = el('div', 'empty', 'nothing yet'); }
        if (!list.__empty.isConnected) list.append(list.__empty);
    } else if (list.__empty && list.__empty.isConnected) list.__empty.remove();
}

const laneLabel = (row) => (row.lane === 'main' ? 'main'
    : row.agentName || row.agentType || (row.agentId ? row.agentId.slice(0, 8) : row.lane === 'subagent' ? 'agent' : '?'));

function paint(snapshot, history) {
    if (!parts) return;
    parts.err.style.display = 'none';

    // The headline. Exact when any live stream has a provider token count;
    // otherwise the calibrated estimate, said out loud as an estimate.
    const flowing = snapshot.live.filter((row) => row.charsPerSecond !== null);
    const exact = flowing.map((row) => num(row.observedTps)).filter((v) => v !== null);
    const est = flowing.map((row) => num(row.estimatedTps)).filter((v) => v !== null);
    const last = snapshot.recent[0] || null;

    let headline = null;
    let headlineNote = '';
    let estimated = false;
    if (exact.length) {
        headline = exact.reduce((a, b) => a + b, 0);
        headlineNote = flowing.length + ' streaming';
    } else if (settings.showEstimated && est.length) {
        headline = est.reduce((a, b) => a + b, 0);
        estimated = true;
        headlineNote = flowing.length + ' streaming';
    } else if (last) {
        headline = num(settings.basis === 'generation' ? last.outputTps : last.endToEndTps);
        headlineNote = 'last response';
    }
    parts.big.textContent = tps(headline);
    parts.unit.textContent = estimated ? 'tok/s est' : 'tok/s';
    parts.side.textContent = '';
    const sideLines = [
        headlineNote,
        last ? 'last ttft ' + ms(last.ttftMs) + ' · hop ' + ms(last.ttfbMs) : '',
    ].filter(Boolean);
    for (const line of sideLines) parts.side.append(el('div', null, line));

    parts.live.note.textContent = snapshot.live.length ? '' : 'idle';
    patch(parts.live.list, snapshot.live.map((row) => {
        const exactRate = num(row.observedTps);
        const shown = exactRate !== null ? exactRate : settings.showEstimated ? num(row.estimatedTps) : null;
        return {
            key: 'live:' + row.id,
            hue: hueOf(row.provider),
            flowing: row.charsPerSecond !== null,
            title: row.servedModel || row.requestedModel || row.provider,
            subtitle: ms(row.elapsedMs) + ' elapsed · ttft ' + ms(row.ttftMs)
                + (row.observedTokens !== null ? ' · ' + tokens(row.observedTokens) + ' tok' : ''),
            tag: laneLabel(row),
            tagMain: row.lane === 'main',
            value: tps(shown),
            unit: 'tok/s',
            estimated: exactRate === null && shown !== null,
        };
    }));

    const lanes = history ? history.lanes : [];
    parts.lanes.heading.textContent = settings.scope === 'all' ? 'Lanes, all sessions' : 'Lanes, this session';
    parts.lanes.note.textContent = settings.scope !== 'all' && !snapshot.sessionId
        ? 'no session resolved yet'
        : lanes.length > 1 ? lanes.length + ' lanes' : '';
    patch(parts.lanes.list, lanes.map((lane) => ({
        key: 'lane:' + lane.key,
        hue: hueOf(lane.providers[0]),
        title: lane.label,
        subtitle: lane.responses + ' resp · ' + tokens(lane.outputTokens) + ' out · ttft p50 ' + ms(lane.p50TtftMs),
        tag: lane.models[0] || '',
        tagMain: lane.key === 'main',
        value: tps(settings.basis === 'generation' ? lane.sustainedTps : lane.p50Tps),
        unit: settings.basis === 'generation' ? 'sustained' : 'p50',
    })));

    if (history) {
        parts.models.note.textContent = history.scope === 'session'
            ? 'this session · ' + history.matched + ' responses'
            : (history.hours ? 'last ' + history.hours + 'h' : 'all time') + ' · ' + history.matched + ' responses';
        patch(parts.models.list, history.models.map((model) => ({
            key: 'model:' + model.key,
            hue: hueOf(model.providers[0]),
            title: model.label,
            subtitle: model.responses + ' resp · ' + tokens(model.outputTokens) + ' out · p90 '
                + tps(model.p90Tps) + ' · ttft p50 ' + ms(model.p50TtftMs),
            tag: model.providers[0],
            value: tps(model.sustainedTps),
            unit: 'sustained',
        })));
    }

    patch(parts.recent.list, snapshot.recent.slice(0, Math.max(1, settings.rows)).map((row) => ({
        key: 'resp:' + row.provider + ':' + row.responseId,
        hue: hueOf(row.provider),
        title: row.servedModel,
        subtitle: tokens(row.tokens.outputTokens) + ' out'
            + (row.tokens.reasoningOutputTokens ? ' (' + tokens(row.tokens.reasoningOutputTokens) + ' thinking)' : '')
            + ' · ttft ' + ms(row.ttftMs) + ' · gen ' + ms(row.streamMs),
        tag: laneLabel(row),
        tagMain: row.lane === 'main',
        value: tps(settings.basis === 'generation' ? row.outputTps : row.endToEndTps),
        unit: settings.basis === 'generation' ? 'tok/s' : 'end to end',
    })));

    parts.footText.textContent = snapshot.records + ' responses recorded · exact provider tokens over router clocks';
}

function fail(message) {
    if (!parts) return;
    parts.err.style.display = '';
    parts.err.textContent = message;
}

let historyCache = null;
let historyAt = 0;

async function poll() {
    if (busy || !root || !root.isConnected) return;
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastPoll < Math.max(250, settings.pollMs)) return;
    lastPoll = now;
    busy = true;
    try {
        const snapshot = await cuimod.rpc('throughput.snapshot', { sessionId, scope: settings.scope });
        if (now - historyAt > 15000) {
            historyAt = now;
            historyCache = await cuimod.rpc('throughput.history', {
                sessionId, scope: settings.scope, hours: settings.historyHours || null,
            }).catch(() => historyCache);
        }
        paint(snapshot, historyCache);
    } catch (err) {
        // The router restarts as a blue-green generation swap, so a refused
        // connection here is a normal few-hundred-millisecond window, not a
        // fault worth shouting about — say what it is and keep polling.
        fail('router unreachable: ' + String(err && err.message));
    } finally { busy = false; }
}

ctx.every(250, poll);
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) { lastPoll = 0; poll(); } });

// ------------------------------------------------- the chip in the app's strip
//
// While a turn runs, the app draws a marker row at the tail of the transcript
// whose meta strip reads `26s · 878 tokens · 1 running task · Running tools`.
// That strip already carries the two facts a rate sits between — elapsed and
// tokens — so the rate belongs in it rather than in a badge of our own beside it.
//
// The chip is a CLONE of one of the app's own chips, retexted. That is not
// laziness: the separator between chips is a private-use glyph whose mechanism
// (pseudo-element, nested span, icon font) is the app's business and changes
// with its bundle. Cloning inherits it, along with the classes, the font and the
// tabular-nums alignment, so the chip cannot drift out of step with a restyle.
//
// Verified against the running page 2026-09-01: an appended chip survived every
// per-second React re-render of the strip across eleven ticks. It is still
// re-checked each poll and re-inserted if a render ever does drop it, and it is
// removed on dispose — a probe generation that left one behind is how a second
// stale chip appeared during development.
const CHIP_MARK = 'data-cuimod-tps';
let chip = null;
let chipTimer = 0;

function strip() {
    for (const row of document.querySelectorAll('div[data-perf-row="marker"]')) {
        const meta = row.querySelector('div[class*="tabular-nums"]');
        const wrap = meta && meta.firstElementChild;
        if (wrap && wrap.children.length) return wrap;
    }
    return null;
}

// Recorded off the running page 2026-09-01. Every chip after the first carries
// its own leading separator as a real element holding a private-use glyph:
//
//   <span class="inline-flex items-center">4s</span>
//   <span class="inline-flex items-center"><span class="px-xs">U+E062</span>4 tokens</span>
//   <span class="inline-flex items-center"><span class="px-xs">U+E062</span><button>Thinking…</button></span>
//
// which is why the separator has to be recognised rather than walked into. The
// first version of retext() looked for the chip's innermost element with text
// and found the separator, so it would have rendered "~112 tok/s4 tokens".
// A private-use code point is the fallback test, so the separator is still
// recognised if the app renames that utility class. Spelled as a code-point
// range rather than a regex escape, so the glyph never lands in this file.
const privateUse = (text) => text.length > 0
    && [...text].every((ch) => ch.codePointAt(0) >= 0xe000 && ch.codePointAt(0) <= 0xf8ff);

const isSeparator = (node) => node.nodeType === 1
    && (node.textContent || '').trim().length > 0
    && (node.classList.contains('px-xs') || privateUse((node.textContent || '').trim()));

function retext(chip, text) {
    const separator = [...chip.childNodes].find(isSeparator) || null;
    const current = [...chip.childNodes].filter((n) => n !== separator).map((n) => n.textContent).join('');
    // Only touch the DOM when the label actually changed: our own mutation feeds
    // the observer that schedules the next paint, and a rewrite per tick would
    // keep that loop turning for no reason.
    if (current === text) return;
    for (const node of [...chip.childNodes]) if (node !== separator) node.remove();
    chip.appendChild(document.createTextNode(text));
}

// It goes after the tokens chip, because that is the count it is a rate of, and
// otherwise at the end.
function anchorOf(wrap) {
    const chips = [...wrap.children].filter((c) => !c.hasAttribute(CHIP_MARK));
    return chips.find((c) => /\btokens?\b/i.test(c.textContent)) || chips[chips.length - 1] || null;
}

// Measured 2026-09-01: the strip has two vocabularies, and cloning whichever
// chip happened to be next door got the second one badly wrong.
//
// Mid-turn every chip is a plain `span.inline-flex.items-center` with zero
// padding, each one after the first carrying its own leading separator. Cloning
// there was fine.
//
// Once the turn settles, the chip becomes `button[data-cds="Button"]` with
// `px-md mx-outset` — 6px of padding cancelled by -6px of margin, so its hit
// area overhangs its text on both sides — and it carries no separator at all.
// Cloning THAT produced two buttons overlapping by 12px with nothing between
// them, rendering `1 running task94.5 tok/s`.
//
// So the chip is built rather than cloned. A plain span inherits the strip's
// font, colour and tabular-nums from the meta row exactly as the app's own text
// chips do, it cannot inherit an interactive affordance it should not have, and
// it is identical in both vocabularies.
// The separator is always one of the app's own, never one built from a glyph
// constant. A hand-built `span.px-xs` carrying U+E062 measured 20px wide against
// the app's 12.4px — same class, same code point, and still visibly wrong,
// because the glyph falls back to a different font outside whatever the app
// renders it in. Rather than chase that, borrow.
//
// The last one seen is kept for the whole window, because the strip's opening
// states are a single chip — `Sending…`, `Waiting for Claude…` — with no
// separator to lend, and by then a previous turn has already supplied one.
let separatorCache = null;

// Found with isSeparator rather than a class selector, so a bundle that renames
// the utility class is still matched on the glyph. Ours is skipped, or our own
// cached copy would be re-cached as though the app had just produced it and any
// drift would become permanent.
function liveSeparator(wrap) {
    for (const candidate of wrap.children) {
        if (candidate.hasAttribute(CHIP_MARK)) continue;
        const found = [...candidate.children].find(isSeparator);
        if (found) return found;
    }
    return null;
}

function separatorFor(wrap) {
    const live = liveSeparator(wrap);
    if (live) separatorCache = live.cloneNode(true);
    return separatorCache ? separatorCache.cloneNode(true) : null;
}

function buildChip(wrap) {
    const separator = separatorFor(wrap);
    // No separator has ever been seen in this window, so the chip would sit flush
    // against its neighbour. Wait for one; the strip grows within a second or two.
    if (!separator) return null;
    const node = document.createElement('span');
    node.className = 'inline-flex items-center';
    node.setAttribute(CHIP_MARK, '1');
    node.appendChild(separator);
    return node;
}

// A chip built while the strip was a lone status word keeps whatever separator
// was cached then. Once the app is rendering its own again, take that one: it is
// the authority on width, glyph and class, all three of which can move with a
// bundle.
function syncSeparator(wrap, node) {
    const live = liveSeparator(wrap);
    if (!live) return;
    const ours = [...node.childNodes].find(isSeparator) || null;
    if (ours && ours.className === live.className && ours.textContent === live.textContent) return;
    separatorCache = live.cloneNode(true);
    if (ours) ours.remove();
    node.insertBefore(separatorCache.cloneNode(true), node.firstChild);
}

// The strip grows as a turn starts: it opens as a lone `Thinking…`, then the
// elapsed clock and the token count appear ahead of it. A chip placed once and
// never revisited is left stranded at the end, reading
// `2s | 1.1k tokens | Thinking… | 82.0 tok/s` when it belongs beside the count it
// is a rate of. Guarded on position because insertBefore is a mutation even when
// it moves nothing, and our own mutations are what schedule the next paint.
function placeChip(wrap, node, anchor) {
    if (node.parentElement !== wrap) { wrap.insertBefore(node, anchor.nextSibling); return 'inserted'; }
    if (node.previousElementSibling !== anchor) { wrap.insertBefore(node, anchor.nextSibling); return 'moved'; }
    return 'kept';
}

function removeChip() {
    if (chip) { try { chip.remove(); } catch (_) {} }
    chip = null;
    for (const stale of document.querySelectorAll('[' + CHIP_MARK + ']')) stale.remove();
}

// How long a finished response stays on the chip once nothing is streaming. It
// only has to outlast a tool call; past that the number is about a turn the user
// has stopped watching, and a stale rate is worse than none.
const LAST_GRACE_MS = 120000;

function paintChip(value) {
    if (!settings.showChip) { removeChip(); return; }
    const wrap = strip();
    // Without a resolved session there is nothing to attribute a number to, and
    // this window's strip belongs to one turn. Showing whatever the router
    // happens to be streaming for somebody else would be worse than showing
    // nothing.
    if (!wrap || !sessionId) { removeChip(); return; }

    const live = value.live || [];
    const exact = live.map((row) => num(row.observedTps)).filter((v) => v !== null);
    const est = live.map((row) => num(row.estimatedTps)).filter((v) => v !== null);
    // Anthropic reports its token count once, at the end, so mid-stream the
    // honest number is the calibrated one and it is marked with a tilde. When a
    // provider does report cumulative tokens mid-stream the exact one wins.
    const useExact = exact.length === live.length && exact.length > 0;
    let rate = useExact ? exact.reduce((a, b) => a + b, 0)
        : est.length ? est.reduce((a, b) => a + b, 0) : null;
    let estimated = !useExact;
    let streams = live.length;

    // Between streams — which is most of a turn, because tools run there — the
    // chip holds the last completed response's rate instead of blinking out.
    // That number is exact, so the tilde goes away and the chip settles.
    if (rate === null) {
        const last = value.last;
        const age = last ? Date.now() - Date.parse(last.completedAt) : Infinity;
        const settled = last && Number.isFinite(age) && age < LAST_GRACE_MS
            ? num(settings.basis === 'generation' ? last.outputTps : last.endToEndTps)
            : null;
        if (settled === null) { removeChip(); return; }
        rate = settled;
        estimated = false;
        streams = 0;
    }

    const label = (estimated ? '~' : '') + tps(rate) + ' tok/s' + (streams > 1 ? ' ×' + streams : '');

    const anchor = anchorOf(wrap);
    if (!anchor) { removeChip(); return; }

    if (!chip || !chip.isConnected) { removeChip(); chip = buildChip(wrap); }
    if (!chip) return;
    placeChip(wrap, chip, anchor);
    syncSeparator(wrap, chip);
    retext(chip, label);
    chip.title = estimated
        ? 'Estimated from measured chars per token for this model'
            + (live[0] && live[0].calibrationSamples ? ' (' + live[0].calibrationSamples + ' responses)' : '')
            + '. The provider reports its own count at the end of the stream.'
        : streams
            ? 'Exact: provider-reported tokens over this router’s clocks'
            : 'Last completed response: ' + tokens(value.last.outputTokens) + ' tokens, '
                + ms(value.last.ttftMs) + ' to first token. Exact.';
}

let chipBusy = false;

async function pollChip() {
    if (!settings.showChip || document.visibilityState === 'hidden') return;
    // Nothing to decorate unless the app is drawing its strip, so an idle
    // session costs one querySelector rather than a router round trip.
    if (!strip()) { removeChip(); return; }
    const now = Date.now();
    if (chipBusy || now - chipTimer < Math.max(400, settings.chipMs)) return;
    chipTimer = now;
    chipBusy = true;
    try {
        const value = await cuimod.rpc('throughput.live', { sessionId });
        paintChip(value);
    } catch (_) { /* a blue-green router swap; the next tick retries */ }
    finally { chipBusy = false; }
}

// Driven by the app's own re-render, not only by a timer. Chromium throttles
// timers in a background window to about one tick a minute, which is fine for a
// window nobody is looking at — but the strip's per-second tick is a mutation,
// and mutations are not throttled, so the chip stays in step the moment the
// window is looked at again. The timer stays as the floor for the case where the
// strip is up and nothing about it is changing.
const chipObserver = new MutationObserver(() => { pollChip(); });
chipObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
ctx.onDispose(() => chipObserver.disconnect());
ctx.every(1000, pollChip);
ctx.onDispose(removeChip);

// ------------------------------------------------------------------- panel
const spec = {
    plugin: 'throughput',
    title: 'Generation rate',
    description: 'Exact tokens per second per response, per provider, per agent — measured at the router and joined to the CLI transcript that names which agent produced it.',
    defaults: { ...settings },
    controls: [
        { key: 'readout', type: 'custom', wide: true, group: 'Live', label: 'Throughput',
          hint: 'Exact rates come from the provider’s own terminal token count over this router’s clocks. An in-flight stream with no count yet is marked est.',
          node: () => {
              if (!root) root = build();
              lastPoll = 0;
              poll();
              return root;
          } },
        { key: 'showChip', type: 'toggle', label: 'Show in the streaming strip', group: 'In the transcript',
          hint: 'Adds a tok/s chip beside the app’s own elapsed and token counts while a turn runs. It is a clone of the app’s chip, so it matches whatever the app is currently styling.' },
        { key: 'chipMs', type: 'slider', label: 'Chip refresh', min: 400, max: 3000, step: 100, unit: 'ms',
          hint: 'A tilde means the provider has not reported its token count yet and the rate is calibrated from measured chars per token.',
          group: 'In the transcript' },
        { key: 'scope', type: 'combo', label: 'Scope', group: 'Settings',
          hint: 'A session covers its own turns and every agent it spawned.',
          options: [
              { value: 'session', label: 'This session' },
              { value: 'all', label: 'All sessions' },
          ] },
        { key: 'basis', type: 'combo', label: 'Rate', group: 'Settings',
          hint: 'Generation divides tokens by the streaming window. End to end includes the hop and the prefill.',
          options: [
              { value: 'generation', label: 'Generation' },
              { value: 'endToEnd', label: 'End to end' },
          ] },
        { key: 'historyHours', type: 'combo', label: 'History window', group: 'Settings',
          options: [
              { value: 1, label: 'Last hour' },
              { value: 6, label: 'Last 6 hours' },
              { value: 24, label: 'Last 24 hours' },
              { value: 0, label: 'All recorded' },
          ] },
        { key: 'pollMs', type: 'slider', label: 'Refresh', min: 250, max: 5000, step: 250, unit: 'ms',
          hint: 'Only while this panel is open and the window is visible.', group: 'Settings' },
        { key: 'rows', type: 'slider', label: 'Recent responses', min: 3, max: 24, step: 1, group: 'Settings' },
        { key: 'showEstimated', type: 'toggle', label: 'Estimate in-flight rate', group: 'Settings',
          hint: 'Off shows a stream’s rate only once its provider has reported a token count.' },
    ],
    apply(v) {
        settings = v;
        lastPoll = 0;
        historyAt = 0;
        chipTimer = 0;
        if (!v.showChip) removeChip();
        if (root && root.isConnected) poll();
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
    if (root) { try { root.remove(); } catch (_) {} }
    root = null;
    parts = null;
});
