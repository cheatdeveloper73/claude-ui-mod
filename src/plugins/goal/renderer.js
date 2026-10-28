/* claude-ui-mod :: goal (renderer)
 *
 * A band above the composer that shows the session's active goal while it is
 * working, and lets you set, edit, re-arm or clear one without stopping the
 * turn.
 *
 * The three things the built-in goal UX gets wrong, and what happens here:
 *
 *   You cannot see the goal, or any progress on it, while a turn runs.
 *     The band is always on when a goal is armed. Its check-in counter is the
 *     number of times the evaluator has graded the goal, and the sheet carries
 *     every one of those verdicts in full. That text is the only real progress
 *     signal the goal system produces and the app renders none of it.
 *
 *   You cannot set a goal while a turn runs.
 *     You can. /goal is dispatched to a thin client as plain text — the CLI's
 *     own ProposeGoalTool sets goals mid-turn by enqueuing the literal string
 *     "/goal <condition>" — so a steered sendMessage does it. That is what the
 *     band's editor and the intercepted /goal both do.
 *
 *   Interrupting a turn appears to clear the goal.
 *     It does not. The CLI keeps it; only the app's own indicator forgets. The
 *     band reads the transcript rather than the app's stream state, so it keeps
 *     showing the truth straight through an interrupt. See goal/main.js for the
 *     enumerated clear paths and the on-disk proof.
 *
 * Two constraints shape the implementation:
 *
 *   - The composer is React-owned, so the band is a floating host anchored to
 *     `.epitaxy-prompt` every tick, never a child of it. When the queue plugin's
 *     rail is up in the same strip, the band stacks on top of it rather than
 *     over it — measured off the rail's own box, not assumed from a constant.
 *
 *   - Intercepting /goal means winning the keydown race against the queue
 *     plugin, which also swallows Enter mid-turn. Both listen at `window` in the
 *     capture phase, so the winner is whoever registered first, and the bridge
 *     loads plugins in sorted name order — "goal" before "queue". That is the
 *     whole reason stopImmediatePropagation here is sufficient.
 *
 * Priority: a goal set mid-turn goes out as "next", never "now". "now" aborts
 * the in-flight turn to be read immediately, which is exactly the stop-and-retype
 * dance this plugin exists to delete. "next" is read at the next tool boundary,
 * which for arming a Stop hook is soon enough to be indistinguishable.
 */
'use strict';

const DEF = {
    enabled: true,
    intercept: true,
    onClear: 'display',        // display | rearm-button | auto
    showCheckins: true,
    metLinger: 12000,
    poll: 900,
    gap: 8,
    size: 12.5,
    solidity: 92,
    accent: '#c96442',
    metColor: '#7fc99a',
    failColor: '#f5949a',
    speed: 1,
};

let V = Object.assign({}, DEF);

// ------------------------------------------------------------------ state
let cliSid = null;
let sid = null;                 // desktop session id (local_<uuid>) from the URL
let st = null;                  // last goal.state reply
let hist = null;                // last goal.history reply, only while open
let open = false;
let editing = false;            // the condition editor is up in the band
let composing = false;          // band forced open to type a first goal into
let dismissed = '';             // endedAt of an outcome the user waved away
let metTimer = null;
let rearmed = '';               // endedAt of the clear auto-rearm already fired on
let busy = false;

const SEND = cuimod.eipc('claude.web', 'LocalSessions', 'sendMessage');
const GET_SESSION = cuimod.eipc('claude.web', 'LocalSessions', 'getSession');
const HOST_ID = 'cuimod-goal';
const MAX_CONDITION = 4000;     // the CLI's own cap on a goal condition

let host = null, shadow = null, sheet = null;
let band = null, glyph = null, condEl = null, cntEl = null, verdictEl = null, chev = null;
let body = null, fullEl = null, listEl = null, actionsEl = null, editor = null;
let running = false;

const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
const MS = (n) => (reduced() ? 1 : Math.round(n * (V.speed || 1)));

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function ago(iso) {
    if (!iso) return '';
    const ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
    return Math.floor(h / 24) + 'd ago';
}

function dur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// The verdict is a paragraph of reasoning. The band gets its first sentence,
// which is where the evaluator puts the finding; the sheet gets all of it.
function firstSentence(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = /^(.{20,150}?[.!?])(\s|$)/.exec(t);
    return m ? m[1] : (t.length > 150 ? t.slice(0, 149) + '…' : t);
}

// ------------------------------------------------------------------ anchors
// Same measure rule queue/renderer.js uses, and it has to stay the same rule:
// two ProseMirror composers are mounted (main and side panel) and the main one
// is the wider of the two.
function mainComposer() {
    let best = null, bestRect = null;
    for (const p of document.querySelectorAll('.epitaxy-prompt')) {
        const r = p.getBoundingClientRect();
        if (r.width < 120 || r.height <= 0) continue;
        if (p.closest('.epitaxy-composer-width')) return p;
        if (!bestRect || r.width > bestRect.width + 8 ||
            (Math.abs(r.width - bestRect.width) <= 8 && r.bottom > bestRect.bottom)) {
            best = p; bestRect = r;
        }
    }
    return best;
}
function promptInput() {
    const main = mainComposer();
    return main ? main.querySelector('.epitaxy-prompt-input .tiptap') : null;
}
function composerFocused() {
    const a = document.activeElement;
    if (!a || !a.closest || !a.closest('.epitaxy-prompt-input')) return false;
    const main = mainComposer();
    return !!(main && main.contains(a));
}
function suggestionOpen() {
    const p = promptInput();
    if (!p || !p.querySelector('[data-decoration-id]')) return false;
    return !!document.querySelector('[role="menuitem"], [data-testid="mention-dropdown"]');
}
function composerCommand() {
    const p = promptInput();
    if (!p) return null;
    const t = (p.textContent || '').replace(/[\u200b\u00a0]/g, ' ').trim();
    const m = /^\/([a-z0-9][a-z0-9_-]*)/i.exec(t);
    return m ? m[1].toLowerCase() : null;
}

const schedulePlace = ctx.layout((layout) => {
    if (!host) return null;
    const p = layout.mainComposer();
    if (!p) return { hidden: true };
    const r = layout.rect(p);
    if (!r.width) return { hidden: true };
    // Branch/usage rows above the prompt and the independently animated queue
    // occupy this same strip. Measure their boxes rather than reserving a gap.
    let top = r.top;
    for (const n of p.parentElement?.children || []) {
        if (n === p) continue;
        const b = layout.rect(n);
        if (b.width < 40 || b.height < 4 || b.bottom > r.top + 2) continue;
        if (b.right < r.left + 40 || b.left > r.right - 40) continue;
        top = Math.min(top, b.top);
    }
    const q = layout.query('#cuimod-queue');
    const rail = q?.shadowRoot?.querySelector('.rail');
    const qr = rail ? layout.rect(rail) : null;
    if (qr && qr.height > 4 && qr.bottom <= r.top + 6 && qr.left < r.right && qr.right > r.left) top = Math.min(top, qr.top);
    return { left: Math.round(r.left) + 'px', width: Math.round(r.width) + 'px', bottom: Math.round(innerHeight - top + V.gap) + 'px' };
}, (value) => {
    if (!host || !value) return;
    const set = (key, val) => { if (host.style[key] !== val) host.style[key] = val; };
    set('visibility', value.hidden ? 'hidden' : '');
    if (!value.hidden) { set('left', value.left); set('width', value.width); set('bottom', value.bottom); }
});
function place() { schedulePlace(); }

// ------------------------------------------------------------------ styles
/* The surface is neutral and the accent is a mark, never a fill. That is the
 * queue rail's rule and it is not decoration: this band sits directly above the
 * composer, and a tinted 768px slab there reads as a modal the app has thrown
 * up rather than as a strip of status. The accent gets the ring, the counter
 * and the primary button's edge, and nothing else.
 *
 * Shared by the live band and the dashboard preview, so a slider moves both. */
function bandCss(p, v) {
    return `
${p}.band {
    --c: ${v.accent};
    border-radius: 12px;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: ${v.size}px; line-height: 1.45;
    color: hsl(var(--text-200, 51 8% 84%));
    background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) ${v.solidity}%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    box-shadow: 0 12px 34px rgba(0,0,0,.42), 0 1px 3px rgba(0,0,0,.3);
    overflow: hidden;
}
/* Surface, border, shadow, radius and the header's lift are the queue rail's,
 * value for value. The rail is translucent and reads as solid anyway; the two
 * sit in the same strip over the same backdrop, and anything that drifts here
 * shows up as one of them looking thinner than the other. Change both or
 * neither. */
${p}.band .hd {
    display: flex; align-items: center; gap: 9px;
    padding: 6px 8px 6px 10px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 4%, transparent);
    cursor: pointer; user-select: none;
}
${p}.band.open .hd {
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
}
${p}.band .hd:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent); }

${p}.band .gl {
    flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--c) 70%, transparent);
    position: relative;
}
${p}.band .gl::after {
    content: ""; position: absolute; inset: 2px; border-radius: 50%;
    background: var(--c);
}
/* Only a live turn animates. A ring that breathes from the moment a goal is
 * armed says nothing about whether anything is happening. */
${p}.band.run .gl::after { animation: g-beat 1.9s ease-in-out infinite; }
@keyframes g-beat { 0%,100% { opacity: 1; transform: scale(1); }
                    50% { opacity: .25; transform: scale(.5); } }

${p}.band .cond {
    flex: 1 1 auto; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: hsl(var(--text-200, 51 8% 84%));
}
${p}.band .cnt {
    flex: 0 0 auto;
    display: inline-grid; place-items: center;
    min-width: 16px; height: 16px; padding: 0 6px; border-radius: 8px;
    background: color-mix(in srgb, var(--c) 26%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
    font-size: 10px; font-variant-numeric: tabular-nums;
}
${p}.band .cnt:empty { display: none; }
${p}.band .vd {
    flex: 0 1 auto; min-width: 0; max-width: 40%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: ${(v.size - 1).toFixed(1)}px;
    color: hsl(var(--text-500, 48 5% 57%));
}
${p}.band .vd:empty { display: none; }
${p}.band .chev {
    flex: 0 0 auto; width: 14px; text-align: center; line-height: 1;
    color: hsl(var(--text-500, 48 5% 57%));
    transition: transform 200ms cubic-bezier(.2,.85,.3,1);
}
${p}.band.open .chev { transform: rotate(180deg); }

${p}.band .body { max-height: 0; overflow: hidden;
                  transition: max-height 260ms cubic-bezier(.2,.85,.3,1); }
${p}.band.open .body { max-height: 46vh; overflow-y: auto; }
${p}.band .pad { padding: 10px 12px 12px; }

${p}.band .full {
    color: hsl(var(--text-200, 51 8% 84%));
    white-space: pre-wrap; word-break: break-word;
    margin-bottom: 10px;
}
${p}.band .lbl {
    font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%));
    margin-bottom: 4px;
}
${p}.band .ck {
    border-left: 2px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 14%, transparent);
    padding: 5px 0 7px 9px; margin-bottom: 2px;
    color: hsl(var(--text-300, 50 6% 70%));
    white-space: pre-wrap; word-break: break-word;
    cursor: pointer;
}
${p}.band .ck.met { border-left-color: ${v.metColor}; }
${p}.band .ck.fail { border-left-color: ${v.failColor}; }
${p}.band .ck .when {
    font-size: 10.5px; color: hsl(var(--text-500, 48 5% 57%));
    font-variant-numeric: tabular-nums; margin-bottom: 2px;
}
/* Collapsed by default: forty verdicts of eight hundred characters is a wall,
 * and the one you want is nearly always the newest. */
${p}.band .ck .txt {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
}
${p}.band .ck.wide .txt { display: block; }

${p}.band .acts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
${p}.band button.b {
    font-family: inherit; font-size: ${(v.size - 1).toFixed(1)}px;
    padding: 4px 11px; border-radius: 8px; cursor: pointer;
    color: hsl(var(--text-400, 50 6% 65%));
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
    border: 1px solid transparent;
    transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
${p}.band button.b:hover {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 11%, transparent);
    color: hsl(var(--text-200, 51 8% 84%));
}
${p}.band button.b.pri {
    color: hsl(var(--text-200, 51 8% 84%));
    border-color: color-mix(in srgb, var(--c) 45%, transparent);
}
${p}.band button.b.pri:hover { background: color-mix(in srgb, var(--c) 18%, transparent); }
${p}.band button.b.danger:hover { color: ${v.failColor}; }
${p}.band button.b[disabled] { opacity: .45; cursor: default; }

${p}.band textarea.ed {
    width: 100%; min-height: 66px; max-height: 30vh; resize: vertical;
    font-family: inherit; font-size: ${v.size}px; line-height: 1.5;
    padding: 8px 10px; border-radius: 9px;
    color: hsl(var(--text-100, 60 14% 97%));
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 5%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 14%, transparent);
    outline: none;
    transition: border-color 140ms ease;
}
${p}.band textarea.ed:focus { border-color: color-mix(in srgb, var(--c) 50%, transparent); }
${p}.band .note {
    margin-top: 8px; font-size: ${(v.size - 1.5).toFixed(1)}px;
    color: hsl(var(--text-500, 48 5% 57%));
}
${p}.band .acts .note { margin-top: 0; flex: 1 0 100%; }
`;
}

/* The host is the positioned element — place() writes its left, width and
 * bottom every tick. The wrapper must therefore stay in normal flow. A
 * `position: fixed` wrapper resolves against the viewport instead, and the band
 * spans the whole window and lies across the composer.
 *
 * Pointer-events belong to the shown state, not to the band. A band left at
 * opacity 0 with pointer-events auto is an invisible sheet of glass over the
 * prompt box: every click on the composer lands on it, and typing simply stops
 * working with nothing on screen to explain why. `visibility` is a second lock
 * on the same door, so a stale host from a failed dispose cannot do it either.
 * Both of those shipped broken once; neither is theoretical. */
const HOST_CSS = (v) => `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: relative; display: block; }
.band {
    pointer-events: none; visibility: hidden;
    opacity: 0; transform: translateY(6px);
    transition: opacity ${MS(220)}ms cubic-bezier(.2,.85,.3,1),
                transform ${MS(220)}ms cubic-bezier(.2,.85,.3,1);
}
.band.show { pointer-events: auto; visibility: visible; opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
    .band, .band .body, .band .chev { transition-duration: 1ms !important; }
    .band .gl::after { animation: none !important; }
}
${bandCss('', v)}
`;


// ------------------------------------------------------------------ build
function ensure() {
    /* Dedupe has two halves and only one of them is obvious.
     *
     * The obvious half: a generation that failed to dispose leaves a dead host
     * in the page. Its JS is gone, so it freezes on a stale goal that never
     * updates and never leaves, which reads as the band being stuck rather than
     * as a leak. So every other #cuimod-goal is removed.
     *
     * The half that bites: the generation doing the removing can be the one that
     * is stale. Two generations overlap during a hot reload, and the dashboard
     * applies specs asynchronously — it holds every apply() until dashboard.load
     * resolves. So the newer generation can mount its host, and then the older
     * generation's apply finally lands, removes it as a stranger, and returns
     * early because its own `host` is still truthy. That variable now points at
     * a detached node, so the band never mounts again and never will: the DOM is
     * empty, `host` is non-null, and every later apply short-circuits on it.
     *
     * The band vanished exactly this way, with apply() reporting success and
     * zero #cuimod-goal nodes in the document. A detached host is therefore no
     * host at all. */
    if (host && !host.isConnected) {
        host = null; shadow = null; sheet = null; band = null;
        glyph = null; condEl = null; cntEl = null; verdictEl = null; chev = null;
        body = null; fullEl = null; listEl = null; actionsEl = null; editor = null;
        bodyKey = ''; whenNodes.length = 0;
    }
    for (const n of document.querySelectorAll('#' + HOST_ID)) if (n !== host) n.remove();
    if (host) return;

    host = el('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:0;z-index:50;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    sheet = new CSSStyleSheet();
    shadow.adoptedStyleSheets = [sheet];

    const wrap = el('div', 'wrap');
    band = el('div', 'band');

    const hd = el('div', 'hd');
    glyph = el('div', 'gl');
    condEl = el('div', 'cond');
    cntEl = el('div', 'cnt');
    verdictEl = el('div', 'vd');
    chev = el('div', 'chev', '⌃');
    hd.append(glyph, condEl, cntEl, verdictEl, chev);
    hd.addEventListener('click', () => {
        open = !open;
        if (!open) { editing = false; composing = false; }
        render();
        if (open) pullHistory();
    });

    body = el('div', 'body');
    const pad = el('div', 'pad');
    fullEl = el('div', 'full');
    listEl = el('div', 'list');
    actionsEl = el('div', 'acts');
    pad.append(fullEl, listEl, actionsEl);
    body.append(pad);

    band.append(hd, body);
    wrap.append(band);
    shadow.append(wrap);
    sheet.replaceSync(HOST_CSS(V));
    document.documentElement.appendChild(host);
    place();
}

function teardown() {
    clearTimeout(metTimer); metTimer = null;
    if (!host) return;
    try { host.remove(); } catch (_) {}
    host = null; shadow = null; sheet = null; band = null;
    glyph = null; condEl = null; cntEl = null; verdictEl = null; chev = null;
    body = null; fullEl = null; listEl = null; actionsEl = null; editor = null;
}
ctx.onDispose(teardown);

// ------------------------------------------------------------------ render
// What the band is showing right now: a live goal, or the outcome of the one
// that just ended, or nothing.
function view() {
    if (!V.enabled || !st || !st.ok) return null;
    if (st.armed) {
        return {
            mode: 'armed', condition: st.condition, checkins: st.checkins,
            latest: st.latest, restored: st.restored,
        };
    }
    // With no goal armed there is nothing to draw, so the band is absent — its
    // presence is the signal. "compose" is the one exception: a bare /goal with
    // nothing armed has to put something on screen to type into, or the command
    // would be swallowed and answer with nothing at all.
    if (composing) return { mode: 'compose', condition: '', checkins: 0, latest: null };
    const L = st.last;
    if (!L || !L.endedAt || L.endedAt === dismissed) return null;
    // An outcome is news for as long as it would have lingered, and no longer.
    // Without this, every hot reload and every session switch re-announces a
    // goal you cleared an hour ago, because `dismissed` starts empty again.
    if (V.metLinger > 0 && Date.now() - Date.parse(L.endedAt) > V.metLinger) return null;
    // A superseded goal is not an outcome — a newer one replaced it, and that
    // newer one is what `armed` would have carried if it were still live.
    if (L.how === 'superseded') return null;
    return { mode: L.how, condition: L.condition, checkins: L.checkins, latest: L.final };
}

function render() {
    const v = view();
    if (!v) {
        if (band) band.classList.remove('show');
        clearTimeout(metTimer); metTimer = null;
        return;
    }
    ensure();

    const colour = v.mode === 'met' ? V.metColor
        : (v.mode === 'impossible' || v.mode === 'error') ? V.failColor
        : V.accent;
    band.style.setProperty('--c', colour);
    band.className = 'band show'
        + (open ? ' open' : '')
        + (v.mode === 'armed' && running ? ' run' : '');

    condEl.textContent = v.condition || '';
    cntEl.textContent = V.showCheckins && v.checkins
        ? v.checkins + (v.checkins === 1 ? ' check-in' : ' check-ins') : '';

    verdictEl.textContent = v.mode === 'met' ? 'goal met'
        : v.mode === 'impossible' ? 'judged impossible'
        : v.mode === 'error' ? 'cleared by an error'
        : v.mode === 'cleared' ? 'cleared'
        : v.mode === 'compose' ? 'no goal set'
        : (v.latest ? firstSentence(v.latest.reason) : (v.restored ? 'restored on resume' : 'armed'));

    // A met goal is news for a moment and then it is clutter. A failed one is
    // not: it stays until it is acknowledged.
    clearTimeout(metTimer); metTimer = null;
    if ((v.mode === 'met' || v.mode === 'cleared') && !open && V.metLinger > 0) {
        const at = st.last && st.last.endedAt;
        // A clear is a receipt for something you just did, so it goes quickly.
        // Only a met goal is news worth holding on screen.
        const hold = v.mode === 'cleared' ? Math.min(V.metLinger, 2500) : V.metLinger;
        metTimer = setTimeout(() => { dismissed = at || ''; render(); }, hold);
    }

    if (open) { renderBody(v); refreshTimes(); }
    place();
}

/* The band is repainted on every poll, and the header can be: assigning
 * textContent replaces a string, it does not destroy a subtree. The body cannot.
 * Rebuilding it on a 900ms tick would drop the check-in you just clicked open,
 * reset the scroller mid-read, and blow away the editor's caret while you are
 * typing a condition into it — all four times a second, all while a turn runs.
 *
 * So the body is keyed on exactly what it draws from. A new check-in changes
 * the count and the body rebuilds; nothing else touches it. */
let bodyKey = '';

// The one thing in the body that goes stale without new data is "4m ago". It is
// patched in place rather than allowed to force a rebuild it does not deserve.
const whenNodes = [];

function whenText(c) {
    const bits = [ago(c.t)];
    if (c.iterations != null) bits.push(c.iterations + ' iterations');
    if (c.durationMs != null) bits.push(dur(c.durationMs));
    if (c.tokens != null) bits.push(Math.round(c.tokens / 1000) + 'k tokens');
    return bits.filter(Boolean).join('  ·  ');
}
function refreshTimes() {
    for (const w of whenNodes) w.node.textContent = whenText(w.c);
}

function renderBody(v) {
    if (v.mode === 'compose') { editing = true; open = true; }
    const rows = (hist && hist.condition === v.condition) ? hist.checkins : null;
    const key = [v.mode, v.condition, v.checkins, rows ? rows.length : -1,
                 editing ? 'e' : '', busy ? 'b' : '', V.onClear].join(' ');
    if (key === bodyKey) return;
    bodyKey = key;

    fullEl.textContent = '';
    listEl.textContent = '';
    actionsEl.textContent = '';

    if (editing) {
        fullEl.textContent = '';
        editor = el('textarea', 'ed');
        editor.value = v.condition || '';
        editor.maxLength = MAX_CONDITION;
        editor.placeholder = 'Keep working until…';
        editor.addEventListener('keydown', (e) => {
            e.stopPropagation();     // the composer's Enter rules are not ours
            if (e.key === 'Escape') { editing = false; composing = false; open = false; render(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit();
        });
        const lbl = el('div', 'lbl', 'condition');
        fullEl.append(lbl, editor);
        const save = el('button', 'b pri', 'Set goal');
        save.type = 'button';
        save.addEventListener('click', commitEdit);
        const cancel = el('button', 'b', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => { editing = false; composing = false; open = false; render(); });
        actionsEl.append(save, cancel);
        actionsEl.append(el('div', 'note', running
            ? 'Sends as a steer — the running turn is not interrupted.'
            : 'Ctrl+Enter to set.'));
        setTimeout(() => { try { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); } catch (_) {} }, 0);
        return;
    }

    fullEl.append(el('div', 'lbl', v.mode === 'armed' ? 'condition' : 'last goal'));
    fullEl.append(document.createTextNode(v.condition || ''));

    whenNodes.length = 0;
    if (rows && rows.length) {
        listEl.append(el('div', 'lbl', 'check-ins — newest first'));
        for (let i = rows.length - 1; i >= 0; i--) {
            const c = rows[i];
            const node = el('div', 'ck' + (c.met ? ' met' : c.failed ? ' fail' : ''));
            const when = el('div', 'when', whenText(c));
            whenNodes.push({ node: when, c });
            node.append(when, el('div', 'txt', c.reason || '(no reason recorded)'));
            node.addEventListener('click', () => node.classList.toggle('wide'));
            listEl.append(node);
        }
    } else if (v.mode === 'armed') {
        listEl.append(el('div', 'lbl', 'check-ins'));
        listEl.append(el('div', 'note', v.checkins
            ? 'loading…'
            : 'None yet — the evaluator grades the goal the first time the turn tries to stop.'));
    }

    const add = (label, cls, fn, disabled) => {
        const b = el('button', 'b' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        if (disabled) b.disabled = true; else b.addEventListener('click', fn);
        actionsEl.append(b);
        return b;
    };

    if (v.mode === 'armed') {
        add('Edit goal', 'pri', () => { editing = true; render(); }, busy);
        add('Clear goal', 'danger', () => send('/goal clear'), busy);
    } else {
        if (V.onClear !== 'display' || v.mode === 'error') {
            add('Re-arm this goal', 'pri', () => send('/goal ' + v.condition), busy || !v.condition);
        }
        add('Edit and set', '', () => { editing = true; render(); }, busy);
        add('Dismiss', '', () => { dismissed = (st.last && st.last.endedAt) || ''; open = false; render(); });
        if (v.mode === 'met' || v.mode === 'impossible') {
            actionsEl.append(el('div', 'note',
                'Re-arming restarts the counter — the CLI treats a new /goal as a fresh goal.'));
        }
    }
}

function commitEdit() {
    if (!editor) return;
    const text = editor.value.trim();
    if (!text) return;
    editing = false;
    composing = false;
    send('/goal ' + text.slice(0, MAX_CONDITION));
}

// ------------------------------------------------------------------ sending
/* Priority "next", never "now". Both count as a steer and neither is deferred
 * behind isRunning, but "now" aborts the in-flight turn so the CLI reads it
 * immediately — which is the stop-and-retype dance this plugin deletes. "next"
 * is read at the next tool boundary; for arming a Stop hook that is soon enough
 * that the difference is invisible, and the turn is never disturbed.
 *
 * The desktop can hold a "next" of its own when no tool is running, so the send
 * is not assumed to have landed: the poll below is what confirms it, by seeing
 * the sentinel appear in the transcript. */
async function send(text) {
    if (!sid || busy) return;
    busy = true;
    render();
    try {
        if (running) await cuimod.appInvoke(SEND, sid, text, undefined, undefined, undefined, 'next');
        else await cuimod.appInvoke(SEND, sid, text);
    } catch (e) {
        cuimod.log('goal: send failed: ' + ((e && e.message) || e));
    } finally {
        busy = false;
        // Nothing optimistic is painted. The band follows the transcript, so
        // the state it shows is always one the CLI actually reached.
        setTimeout(pull, 250);
        render();
    }
}

// ------------------------------------------------------------------ data
let pulling = false;
async function pull() {
    if (pulling) return;
    pulling = true;
    try {
        const next = (location.pathname.match(/local_[0-9a-f-]{36}/) || [null])[0];
        if (next !== sid) {
            sid = next; dismissed = ''; rearmed = ''; open = false;
            editing = false; composing = false; bodyKey = '';
        }
        cliSid = cuimod.sessionId || null;
        st = cliSid ? await cuimod.rpc('goal.state', { cliSid }).catch(() => null) : null;

        if (sid) {
            const s = await cuimod.appInvoke(GET_SESSION, sid).catch(() => null);
            running = !!(s && s.isRunning);
        } else running = false;

        maybeAutoRearm();
        if (open) await pullHistory();
    } finally {
        try { render(); } finally { pulling = false; }
    }
}

async function pullHistory() {
    if (!cliSid) return;
    const h = await cuimod.rpc('goal.history', { cliSid }).catch(() => null);
    if (!h || !h.ok) return;
    hist = h;
    if (open) render();
}

/* Only an error clear. A user clear and an error clear write the identical
 * sentinel, and re-arming through a /goal clear you just typed would make the
 * command impossible to use. The CLI's warning text is the one thing that
 * separates them, and goal/main.js reports it as how === 'error'. */
function maybeAutoRearm() {
    if (V.onClear !== 'auto' || !st || !st.ok || st.armed) return;
    const L = st.last;
    if (!L || L.how !== 'error' || !L.condition || !L.endedAt) return;
    if (L.endedAt === rearmed) return;
    rearmed = L.endedAt;
    cuimod.log('goal: auto re-arming after an unrecoverable-error clear');
    send('/goal ' + L.condition);
}

// ------------------------------------------------------------------ /goal
/* Enter is contested. The queue plugin swallows it mid-turn to queue the
 * composer's text, and a queued "/goal …" would be sent as literal prompt text
 * at some later turn instead of arming a goal now. Both listeners are
 * capture-phase on `window`, so order is registration order, and the bridge
 * evaluates plugins in sorted name order — "goal" runs first, and
 * stopImmediatePropagation keeps the rest of the chain from seeing the key.
 *
 * The two rules the composer imposes are the same ones queue respects: an open
 * suggestion menu owns Enter, and the app's own host commands are intercepted
 * before sendMessage is ever called. /goal is not a host command — it travels
 * as text — so it is ours to take. */
function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

ctx.track(window, 'keydown', (e) => {
    if (!V.enabled || !V.intercept) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (!composerFocused() || suggestionOpen()) return;
    if (composerCommand() !== 'goal') return;
    swallow(e);
    takeComposer();
}, { capture: true });

async function takeComposer() {
    const r = await cuimod.rpc('goal.editorGet').catch(() => null);
    if (!r || !r.ok) return;
    const raw = String(r.text || '').trim();
    const m = /^\/goal\b\s*([\s\S]*)$/i.exec(raw);
    if (!m) return;
    const arg = m[1].trim();
    await cuimod.rpc('goal.editorClear').catch(() => {});
    if (!arg) {
        // Bare /goal is a request to see the goal, not to set one. With one
        // armed the band already has the answer, so open it; with none, put an
        // empty editor on screen rather than swallow the command silently.
        open = true;
        if (!st || !st.armed) composing = true;
        render();
        pullHistory();
        return;
    }
    send('/goal ' + arg.slice(0, MAX_CONDITION));
}

// ------------------------------------------------------------------ ticks
let timer = null;
function retime() {
    clearInterval(timer);
    timer = setInterval(pull, Math.max(300, V.poll));
}
ctx.onDispose(() => { clearInterval(timer); clearTimeout(metTimer); });

ctx.track(document, 'visibilitychange', () => { if (!document.hidden) pull(); });
cuimod.onSessionChange(() => {
    st = null; hist = null; dismissed = ''; rearmed = ''; open = false;
    editing = false; composing = false; bodyKey = ''; whenNodes.length = 0;
    render(); pull();
});

// ------------------------------------------------------------------ panel
function apply(v) {
    V = Object.assign({}, DEF, v);
    if (!V.enabled) { teardown(); clearInterval(timer); return; }
    ensure();
    sheet.replaceSync(HOST_CSS(V));
    retime();
    render();
    pull();
}

const spec = {
    plugin: 'goal',
    title: 'Goal',
    description: 'The active goal, its check-ins and the evaluator’s verdicts, above the composer — settable and clearable mid-turn.',
    defaults: DEF,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled', group: 'Behaviour' },
        { key: 'intercept', type: 'toggle', label: 'Take over /goal',
          hint: 'Typing /goal in the composer routes through the band, so it works mid-turn. Off leaves the app’s own handling alone.',
          group: 'Behaviour' },
        { key: 'onClear', type: 'combo', label: 'When a goal ends on its own', group: 'Behaviour',
          hint: 'Interrupting does NOT end a goal — the CLI keeps it. This covers a real clear: met, judged impossible, or dropped by an unrecoverable error.',
          options: [
              { value: 'display', label: 'Just show what happened' },
              { value: 'rearm-button', label: 'Offer a one-click re-arm' },
              { value: 'auto', label: 'Re-arm automatically after an error clear' },
          ] },
        { key: 'metLinger', type: 'slider', label: 'Keep a met goal on screen', min: 0, max: 60000,
          step: 1000, unit: 'ms', hint: '0 leaves it until dismissed. A failed goal always waits.',
          group: 'Behaviour' },
        { key: 'poll', type: 'slider', label: 'Check the transcript every', min: 300, max: 5000,
          step: 100, unit: 'ms', group: 'Behaviour' },

        { key: 'showCheckins', type: 'toggle', label: 'Show the check-in count', group: 'Look' },
        { key: 'gap', type: 'slider', label: 'Gap above the composer', min: 0, max: 40, step: 1,
          unit: 'px', group: 'Look' },
        { key: 'solidity', type: 'slider', label: 'Surface opacity', min: 55, max: 100, step: 1,
          unit: '%', hint: 'The queue rail sits at 92, and the two share a strip — move this and they stop matching.',
          group: 'Look' },
        { key: 'size', type: 'slider', label: 'Text size', min: 9, max: 18, step: 0.5, unit: 'px',
          group: 'Look' },
        { key: 'accent', type: 'color', label: 'Armed color', group: 'Look' },
        { key: 'metColor', type: 'color', label: 'Met color', group: 'Look' },
        { key: 'failColor', type: 'color', label: 'Failed color', group: 'Look' },
        { key: 'speed', type: 'slider', label: 'Animation speed', min: 0.2, max: 2.5, step: 0.05,
          group: 'Look' },
    ],
    apply,
    preview: {
        title: 'Preview — armed and met',
        beforeLabel: 'armed, mid-turn',
        afterLabel: 'goal met',
        layout: 'column',
        // Both stages are the live builder with the live css(), so a slider
        // moves the preview exactly as it moves the real band. "before" is the
        // armed state rather than the stock app: the app draws nothing here.
        node(which) {
            const hold = el('div', 'pv-hold');
            const b = el('div', 'band show' + (which === 'after' ? '' : ' run'));
            const hd = el('div', 'hd');
            hd.append(el('div', 'gl'), el('div', 'cond', 'ship the parser rewrite with every test green'),
                el('div', 'cnt', which === 'after' ? '14 check-ins' : '9 check-ins'),
                el('div', 'vd', which === 'after' ? 'goal met'
                    : 'Two tests still fail on the nested-array case.'),
                el('div', 'chev', '⌃'));
            b.append(hd);
            hold.append(b);
            return hold;
        },
        css(v, sel, which) {
            const c = which === 'after' ? v.metColor : v.accent;
            return bandCss(sel + ' ', v) + `
${sel} .pv-hold { padding: 14px 12px; }
${sel} .band { --c: ${c}; }
${sel} .band .cnt { ${v.showCheckins ? '' : 'display: none;'} }
${sel} .band { background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) ${v.solidity}%, transparent); }
`;
        },
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});

if (REG.subs.size === 0) apply(DEF);
