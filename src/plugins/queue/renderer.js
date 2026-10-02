/* claude-ui-mod :: queue (renderer)
 *
 * An explicit send queue for the composer.
 *
 * The desktop app steers by default: a message typed while a turn is running is
 * handed to the CLI immediately (priority "next"), which is why nothing ever
 * accumulates in the app's own queued-message bar on this build. This plugin
 * takes that decision back. While a turn is running, Enter (and the send button)
 * are swallowed before the app sees them, the composer's text and images are
 * moved into a queue of our own, and nothing reaches the model until either the
 * turn ends or you press Steer.
 *
 * Everything about the queue is ours: the rail that hangs off the top of the
 * prompt box, the ordering, the persistence, the auto-send-at-turn-end rule.
 * The only app machinery used is LocalSessions.sendMessage — with priority
 * "next" for a steer (mid-turn injection that never touches subagents) and no
 * priority for a normal send once the turn has ended.
 *
 * Two constraints shape the implementation:
 *   - The composer is React-owned, so nothing here inserts children into it or
 *     writes its className. The rail is a floating host of our own, and the send
 *     button's "update queued" label is a pseudo-element driven by a data
 *     attribute on <html>.
 *   - The editor is TipTap and its instance is a page-world expando, so reads,
 *     clears and inserts all round-trip through queue/main.js.
 */
'use strict';

const DEF = {
    enabled: true,
    interceptEnter: true,
    interceptSend: true,
    autoSend: true,
    autoSendDelay: 350,
    freeForeground: true,
    accent: '#c96442',
    size: 12.5,
    lines: 2,
    speed: 1,
    gap: 10,
};

let V = Object.assign({}, DEF);

// ------------------------------------------------------------------ state
let sid = null;                 // desktop session id (local_<uuid>) from the URL
let items = [];                 // [{ id, text, images?, at }] for the session on screen
let store = {};                 // every session's queue, as loaded from disk
let running = false;            // is the session mid-turn
let editing = null;             // id of the item currently loaded in the composer
let armedTrash = null;          // id whose trash button is one click from firing
let armedTimer = null;
let loaded = false;

const GET_SESSION = cuimod.eipc('claude.web', 'LocalSessions', 'getSession');

const uid = () => 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
const MS = (n) => (reduced() ? 1 : Math.round(n * (V.speed || 1)));

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

// ------------------------------------------------------------------ anchors
// Two ProseMirror composers exist (main + side panel). The main one used to be
// the only one inside .epitaxy-composer-width; that wrapper is gone from the
// build the app serves from claude.ai, so the two are told apart by measure
// instead — the main composer spans the transcript's own width and the side
// panel's is a narrower column. Widest wins, lowest breaks a tie.
function mainComposer() {
    let best = null, bestRect = null;
    for (const p of document.querySelectorAll('.epitaxy-prompt')) {
        if (p.closest('.epitaxy-composer-width')) return p;
        const r = p.getBoundingClientRect();
        if (r.width < 120) continue;
        if (!bestRect || r.width > bestRect.width + 8 ||
            (Math.abs(r.width - bestRect.width) <= 8 && r.bottom > bestRect.bottom)) {
            best = p; bestRect = r;
        }
    }
    return best;
}
function promptBox() {
    return mainComposer();
}

/* The prompt box is not the top of the composer. Aux rows stack above it inside
 * the same container — the branch/PR row, and the usage band when it is up — so
 * a rail hung off the prompt's top edge lands on top of one of them. Measured at
 * a 1040px window: the branch row spans 907..947 and the prompt starts at 953,
 * so everything in that 46px is somebody else's.
 *
 * Found by geometry, never by class: the usage band is display:none with a zero
 * rect when it is down, `.epitaxy-branch-row` is claude.ai's own name on its own
 * release cadence, and a row added tomorrow has no name here at all. What
 * identifies one is that it is a sibling of the prompt, has a real box, sits
 * above the prompt, and overlaps its column. */
function composerStackTop(promptEl, r) {
    let top = r.top;
    const box = promptEl.parentElement;
    if (box) {
        for (const n of box.children) {
            if (n === promptEl) continue;
            const b = n.getBoundingClientRect();
            if (b.width < 40 || b.height < 4) continue;          // hidden, or screen-reader only
            if (b.bottom > r.top + 2) continue;                  // not above the prompt
            if (b.right < r.left + 40 || b.left > r.right - 40) continue;   // another column
            if (b.top < top) top = b.top;
        }
    }
    return top;
}
function composerFocused() {
    const a = document.activeElement;
    if (!a || !a.closest) return false;
    if (!a.closest('.epitaxy-prompt-input')) return false;
    const main = mainComposer();
    return !!(main && main.contains(a));
}

// ------------------------------------------------------------------ slash commands
// Two properties of the app's own composer have to be respected here, or typing
// a command while a turn is running stops working.
//
// 1. An open suggestion menu owns Enter. TipTap's suggestion plugin marks the
//    live query with an inline decoration ([data-decoration-id]) inside the
//    editor, and the popup portals its rows to <body>. The app gates its own
//    submit on exactly this state (!mentionMenuOpen && !slashMenuOpen); this
//    plugin has to as well, or Enter queues a half-typed "/bt" instead of
//    picking the item out of the menu. Both halves are required: an active
//    suggestion with no matching items renders no popup, and then Enter really
//    does mean submit.
//
// 2. Host commands never reach the CLI. /btw, /model, /rename and the rest are
//    intercepted in the app's renderer before LocalSessions.sendMessage is
//    called at all — /btw opens the side chat, /config opens settings. Queueing
//    one turns it into literal prompt text, because the queue sends through
//    sendMessage and so skips that interceptor entirely. None of them costs a
//    turn, so there is nothing to queue: hand them straight to the app.
//
// Commands the CLI handles (/compact, /clear, /schedule, /reload-plugins, and
// anything from the session's own command list) travel as ordinary text, so
// they queue and send correctly and are deliberately absent from this set.
const HOST_COMMANDS = new Set([
    'btw',
    'ultrareview',
    'rewind',
    'fork',
    'mcp',
    'feedback', 'bug', 'share',
    'model',
    'rename',
    'workflows', 'workflow',
    'usage', 'stats', 'cost',
    'config', 'settings',
    'logs',
    'reset-limits',
    'create-pr',
    'auto-mode-setup',
]);

// The ProseMirror node itself, not its wrapper: the wrapper also holds the
// placeholder and the toolbar, and both would pollute textContent. Same node
// queue/main.js resolves the editor instance from.
function promptInput() {
    const main = mainComposer();
    if (!main) return null;
    return main.querySelector('.epitaxy-prompt-input .tiptap');
}

function suggestionOpen() {
    const p = promptInput();
    if (!p || !p.querySelector('[data-decoration-id]')) return false;
    return !!document.querySelector('[role="menuitem"], [data-testid="mention-dropdown"]');
}

// Read the composer straight from the DOM rather than through queue.editorGet:
// the decision to swallow Enter has to be made inside the event, and the RPC
// round-trip resolves a turn too late. A command picked from the menu becomes a
// skillChip that renders as <span data-skill-chip>/btw</span>, so textContent
// carries the name whether it was picked or typed out.
function composerCommand() {
    const p = promptInput();
    if (!p) return null;
    const t = (p.textContent || '').replace(/[\u200b\u00a0]/g, ' ').trim();
    const m = /^\/([a-z0-9][a-z0-9_-]*)/i.exec(t);
    return m ? m[1].toLowerCase() : null;
}

function hostCommandTyped() {
    const c = composerCommand();
    return c !== null && HOST_COMMANDS.has(c);
}

// ------------------------------------------------------------------ styles
// Page-level sheet: the send button lives in the app's DOM, so its "update
// queued" state cannot be styled from inside our shadow root. The attribute goes
// on <html> rather than on the button itself, so no React-owned node is touched.
const EDIT_ATTR = 'data-cuimod-queue-edit';
const SEND_ID = 'code-prompt-send';
const STOP_ID = 'code-prompt-stop';
const BTN_IDS = [SEND_ID, STOP_ID];

const pageStyle = document.createElement('style');
pageStyle.id = 'cuimod-queue-page';
(document.head || document.documentElement).appendChild(pageStyle);
ctx.onDispose(() => { try { pageStyle.remove(); } catch (_) {} });

// The edit flag lives on <html>, which outlives this plugin instance: a hot
// reload in the middle of an edit left the attribute behind with no plugin to
// clear it, and the app's send button read "update queued" for good. Cleared on
// the way in and on the way out.
document.documentElement.removeAttribute(EDIT_ATTR);
ctx.onDispose(() => { try { document.documentElement.removeAttribute(EDIT_ATTR); } catch (_) {} });

// Mid-turn the app swaps the composer's bottom-right button for a Stop button,
// so there is no send button to relabel exactly when the queue exists. The rule
// covers both ids; while an edit is in flight that corner reads "update queued"
// whichever one is mounted, and Escape remains the way to stop everything.
function pageRules() {
    return `
${BTN_IDS.map((id) => `html[${EDIT_ATTR}] button[data-testid="${id}"]`).join(', ')} {
    aspect-ratio: auto;
    width: auto;
    padding-inline: 9px;
    font-size: 0;
    color: ${V.accent};
    transition: padding var(--cq-d2, 200ms) cubic-bezier(.2,.85,.3,1),
                color var(--cq-d2, 200ms) linear;
}
/* The glyph is icon-font text, so font-size:0 collapses it; the hover fill is
 * the .btn-squish child and has to survive. */
${BTN_IDS.map((id) => `html[${EDIT_ATTR}] button[data-testid="${id}"] > *:not(.btn-squish)`).join(', ')} { display: none; }
${BTN_IDS.map((id) => `html[${EDIT_ATTR}] button[data-testid="${id}"]::after`).join(', ')} {
    content: 'update queued';
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: .01em;
    white-space: nowrap;
    animation: cqSwap ${MS(220)}ms cubic-bezier(.2,.85,.3,1) both;
}
@keyframes cqSwap {
    from { opacity: 0; transform: translateY(3px) scale(.94); }
    to   { opacity: 1; transform: none; }
}
`;
}

// ------------------------------------------------------------------ rail host
let host = null, shadow = null, rail = null, rowsBox = null, cntTag = null,
    autoBtn = null, toastBox = null;
// The rail's exit is animated, so teardown is deferred — and a queue that
// refills during that window revives the same host. Without a generation token
// the pending teardown fires afterwards and takes the NEW rows down with it.
let leaveGen = 0;
const rowEls = new Map();       // item id -> row element

const CSS = () => `
:host { all: initial; }
* { box-sizing: border-box; font-family: var(--font-ui, ui-sans-serif, system-ui, sans-serif); }
.wrap {
    position: relative;
    display: flex; flex-direction: column; gap: 6px;
    --acc: ${V.accent};
    --cq-d1: ${MS(120)}ms;
    --cq-d2: ${MS(200)}ms;
    --cq-d3: ${MS(280)}ms;
    --e-out: cubic-bezier(.2,.85,.3,1);
    --e-in: cubic-bezier(.5,0,.9,.4);
}
.rail {
    pointer-events: auto;
    border-radius: 12px;
    background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) 92%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    box-shadow: 0 12px 34px rgba(0,0,0,.42), 0 1px 3px rgba(0,0,0,.3);
    overflow: hidden;
    animation: railIn var(--cq-d3) var(--e-out) both;
}
@keyframes railIn {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to   { opacity: 1; transform: none; }
}
.rail.leaving { animation: railOut var(--cq-d2) var(--e-in) both; }
@keyframes railOut {
    from { opacity: 1; transform: none; }
    to   { opacity: 0; transform: translateY(6px) scale(.99); }
}

.hd {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px 6px 10px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
}
.cnt {
    font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%));
    display: flex; align-items: center; gap: 6px;
}
.cnt .n {
    display: inline-grid; place-items: center;
    min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
    background: color-mix(in srgb, var(--acc) 26%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
    font-size: 10px; letter-spacing: 0; font-variant-numeric: tabular-nums;
}
.cnt .n.bump { animation: bump var(--cq-d3) var(--e-out); }
@keyframes bump {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.28); background: color-mix(in srgb, var(--acc) 60%, transparent); }
    100% { transform: scale(1); }
}
.spacer { flex: 1 1 auto; }

.auto {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px 3px 6px; border-radius: 999px;
    font-size: 10.5px; color: hsl(var(--text-400, 50 6% 65%));
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
    border: 1px solid transparent;
    cursor: pointer; user-select: none;
    transition: color var(--cq-d1) var(--e-out), background var(--cq-d1) var(--e-out),
                border-color var(--cq-d1) var(--e-out);
}
.auto:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 11%, transparent); }
.auto .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 22%, transparent);
    transition: background var(--cq-d2) var(--e-out), box-shadow var(--cq-d2) var(--e-out);
}
.auto.on { color: hsl(var(--text-200, 55 8% 85%)); border-color: color-mix(in srgb, var(--acc) 45%, transparent); }
.auto.on .dot { background: var(--acc); box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent); }

.rows { display: flex; flex-direction: column; position: relative; }
.row {
    position: relative;
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 8px 7px 10px;
    animation: rowIn var(--cq-d3) var(--e-out) both;
}
.row + .row { border-top: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent); }
@keyframes rowIn {
    from { opacity: 0; transform: translateX(-6px); }
    to   { opacity: 1; transform: none; }
}
.row.editing { background: color-mix(in srgb, var(--acc) 12%, transparent); }
.row.editing::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--acc);
    animation: barIn var(--cq-d2) var(--e-out) both;
}
@keyframes barIn { from { transform: scaleY(0); } to { transform: none; } }

.ord {
    flex: 0 0 auto; margin-top: 1px;
    font-size: 9.5px; font-variant-numeric: tabular-nums;
    color: hsl(var(--text-500, 48 5% 57%));
    min-width: 10px; text-align: right;
}
.body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.txt {
    font-size: ${V.size}px; line-height: 1.42;
    color: hsl(var(--text-200, 55 8% 85%));
    white-space: pre-wrap; overflow: hidden;
    display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: ${Math.max(1, Math.round(V.lines))};
}
.media {
    font-size: 9.5px; line-height: 1.3; letter-spacing: .035em;
    color: color-mix(in srgb, var(--acc) 78%, hsl(var(--text-300, 50 7% 75%)));
}
.acts { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; }
.b {
    display: grid; place-items: center;
    width: 22px; height: 22px; border-radius: 6px;
    color: hsl(var(--text-500, 48 5% 57%));
    cursor: pointer; user-select: none;
    opacity: .55;
    transition: opacity var(--cq-d1) var(--e-out), color var(--cq-d1) var(--e-out),
                background var(--cq-d1) var(--e-out), transform var(--cq-d1) var(--e-out);
}
.row:hover .b { opacity: 1; }
.b:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent); }
.b:active { transform: scale(.9); }
.b svg { width: 13px; height: 13px; display: block; }
.b.steer:hover { color: var(--acc); }
.b.edit:hover { color: hsl(var(--text-100, 60 14% 97%)); }
.b.edit.on { opacity: 1; color: var(--acc); background: color-mix(in srgb, var(--acc) 18%, transparent); }
.b.trash:hover { color: #f5949a; }
.b.trash.arm {
    opacity: 1; width: auto; padding: 0 7px; gap: 4px;
    grid-auto-flow: column;
    color: #f5949a; background: color-mix(in srgb, #f5949a 18%, transparent);
    font-size: 10px;
    animation: bump var(--cq-d3) var(--e-out);
}
.b.trash.arm::after { content: 'confirm'; }

.row.going, .row.sent { pointer-events: none; }
.row.going { animation: rowOut var(--cq-d2) var(--e-in) both; }
@keyframes rowOut {
    from { opacity: 1; transform: none; }
    to   { opacity: 0; transform: translateX(14px); }
}
.row.sent { animation: rowSent var(--cq-d3) var(--e-in) both; }
@keyframes rowSent {
    0%   { opacity: 1; transform: none; background: color-mix(in srgb, var(--acc) 0%, transparent); }
    30%  { opacity: 1; background: color-mix(in srgb, var(--acc) 26%, transparent); }
    100% { opacity: 0; transform: translateY(-10px); }
}

.toast {
    align-self: center;
    max-width: 100%;
    padding: 6px 10px; border-radius: 9px;
    font-size: 11.5px;
    color: hsl(var(--text-100, 60 14% 97%));
    background: color-mix(in srgb, #f5949a 22%, hsl(var(--bg-100, 0 0% 8%)));
    border: 1px solid color-mix(in srgb, #f5949a 40%, transparent);
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    animation: toastIn var(--cq-d3) var(--e-out) both;
}
.toast.leaving { animation: toastOut var(--cq-d2) var(--e-in) both; }
@keyframes toastIn  { from { opacity: 0; transform: translateY(6px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes toastOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(4px) scale(.98); } }
`;

const ICONS = {
    steer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
};

// Animation cleanup must not depend on requestAnimationFrame or on animationend:
// a backgrounded window throttles rAF to nothing and may not advance animations
// at all, so a row scheduled for removal in a rAF callback simply never leaves.
// The timer is the contract; the event is only there to make it prompt.
function afterExit(node, ms, done) {
    let fired = false;
    const go = () => { if (fired) return; fired = true; done(); };
    node.addEventListener('animationend', go, { once: true });
    const t = setTimeout(go, Math.max(60, ms) + 260);
    ctx.onDispose(() => clearTimeout(t));
}

function build() {
    if (host && host.isConnected) {
        // Revive: cancel the exit, drop the class, and invalidate the pending
        // teardown so it cannot fire against the revived rail.
        if (rail && rail.classList.contains('leaving')) {
            leaveGen++;
            for (const a of rail.getAnimations()) a.cancel();
            rail.classList.remove('leaving');
        }
        return;
    }
    host = document.createElement('div');
    host.id = 'cuimod-queue';
    host.style.cssText = 'position:fixed;left:0;bottom:0;width:0;z-index:50;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS();
    const wrap = el('div', 'wrap');

    rail = el('div', 'rail');
    const hd = el('div', 'hd');
    cntTag = el('div', 'cnt');
    autoBtn = el('div', 'auto');
    autoBtn.append(el('span', 'dot'), el('span', null, 'auto-send at turn end'));
    autoBtn.addEventListener('click', () => {
        V.autoSend = !V.autoSend;
        pushSetting('autoSend', V.autoSend);
        syncConfig();
        paintAuto();
    });
    hd.append(cntTag, el('div', 'spacer'), autoBtn);
    rowsBox = el('div', 'rows');
    rail.append(hd, rowsBox);

    toastBox = el('div', 'toasts');
    wrap.append(rail, toastBox);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);
    rowEls.clear();
}

function restyle() {
    if (!shadow) return;
    const s = shadow.querySelector('style');
    if (s) s.textContent = CSS();
}

function teardown() {
    if (!host) return;
    try { host.remove(); } catch (_) {}
    host = null; shadow = null; rail = null; rowsBox = null;
    cntTag = null; autoBtn = null; toastBox = null;
    rowEls.clear();
}
ctx.onDispose(teardown);

// A stale host survives a session switch or a hot reload, and then every
// measurement describes a detached element while the pixels come from another
// one. Same defence the usage bar needs.
function dedupe() {
    const all = document.querySelectorAll('#cuimod-queue');
    for (const n of all) if (n !== host) { try { n.remove(); } catch (_) {} }
}

// ------------------------------------------------------------------ render
function paintAuto() {
    if (autoBtn) autoBtn.classList.toggle('on', !!V.autoSend);
}

function paintCount(bump) {
    if (!cntTag) return;
    cntTag.textContent = '';
    const n = el('span', 'n', String(items.length));
    cntTag.append(n, el('span', null, 'queued'));
    if (bump) { void n.offsetWidth; n.classList.add('bump'); }
}

function imageCount(it) {
    return Array.isArray(it && it.images) ? it.images.length : 0;
}

function paintRowBody(row, it) {
    let body = row.querySelector('.body');
    if (!body) {
        body = el('div', 'body');
        const acts = row.querySelector('.acts');
        row.insertBefore(body, acts || null);
    }
    let txt = body.querySelector('.txt');
    if (!txt) { txt = el('div', 'txt'); body.prepend(txt); }
    const count = imageCount(it);
    const copy = it.text || (count ? (count === 1 ? 'Image' : 'Images') : '');
    if (txt.textContent !== copy) txt.textContent = copy;
    let media = body.querySelector('.media');
    if (count) {
        if (!media) { media = el('div', 'media'); body.append(media); }
        media.textContent = count + (count === 1 ? ' image attached' : ' images attached');
    } else if (media) media.remove();
}

function rowNode(it, index) {
    const row = el('div', 'row');
    row.dataset.id = it.id;
    row.append(el('div', 'ord', String(index + 1)));
    const body = el('div', 'body');
    row.append(body);
    paintRowBody(row, it);

    const acts = el('div', 'acts');
    const mk = (cls, icon, title, fn) => {
        const b = el('div', 'b ' + cls);
        b.innerHTML = icon;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        acts.append(b);
        return b;
    };
    mk('steer', ICONS.steer, 'Steer — inject into the running turn now', () => steer(it.id));
    mk('edit', ICONS.edit, 'Edit in composer', () => toggleEdit(it.id));
    mk('trash', ICONS.trash, 'Remove (click twice)', () => armTrash(it.id));
    row.append(acts);
    return row;
}

// Diffed rather than rebuilt: a full rebuild would replay every row's entrance
// on any change, and the row being removed has to animate out from where it is.
function render(opts) {
    const o = opts || {};
    if (!V.enabled || (!items.length && !editing)) {
        if (rail && host && !rail.classList.contains('leaving')) {
            const r = rail;
            const gen = ++leaveGen;
            r.classList.add('leaving');
            afterExit(r, MS(200), () => { if (gen === leaveGen && rail === r) teardown(); });
        }
        return;
    }

    build();
    dedupe();

    const seen = new Set();
    items.forEach((it, i) => {
        seen.add(it.id);
        let row = rowEls.get(it.id);
        if (!row || !row.isConnected) {
            row = rowNode(it, i);
            rowEls.set(it.id, row);
            rowsBox.append(row);
        } else {
            const ord = row.querySelector('.ord');
            if (ord) ord.textContent = String(i + 1);
            paintRowBody(row, it);
        }
        row.classList.toggle('editing', editing === it.id);
        const eb = row.querySelector('.b.edit');
        if (eb) eb.classList.toggle('on', editing === it.id);
        const tb = row.querySelector('.b.trash');
        if (tb) tb.classList.toggle('arm', armedTrash === it.id);
        // Keep DOM order in step with the model.
        if (rowsBox.children[i] !== row) rowsBox.insertBefore(row, rowsBox.children[i] || null);
    });

    for (const [id, row] of [...rowEls]) {
        if (seen.has(id)) continue;
        rowEls.delete(id);
        // Out of the flow before it animates, but pinned where it already is: a
        // row left in the flow keeps shifting insertBefore indices for
        // everything after it, which is how the ordinals and the model drifted
        // apart — and it stays clickable, so a stale trash button could delete a
        // live item. Absolute at its own offsetTop animates out in place.
        const top = row.offsetTop;
        row.classList.add(o.sentId === id ? 'sent' : 'going');
        row.style.position = 'absolute';
        row.style.top = top + 'px';
        row.style.left = '0';
        row.style.right = '0';
        afterExit(row, MS(280), () => { try { row.remove(); } catch (_) {} });
    }

    // Belt: anything in the flow that the model does not know about goes now.
    // Rows on their way out are exempt — they are already out of the flow and
    // own their own removal.
    for (const n of [...rowsBox.children]) {
        if (n.classList.contains('going') || n.classList.contains('sent')) continue;
        if (!n.dataset || !rowEls.has(n.dataset.id)) { try { n.remove(); } catch (_) {} }
    }

    paintCount(!!o.bump);
    paintAuto();
    place();
}

let toastTimer = null;
function toast(msg) {
    build();
    if (!toastBox) return;
    toastBox.textContent = '';
    const t = el('div', 'toast', msg);
    toastBox.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.add('leaving');
        afterExit(t, MS(200), () => { try { t.remove(); } catch (_) {} });
    }, 2600);
    place();
}
ctx.onDispose(() => clearTimeout(toastTimer));

// The side chat floats over the transcript column in exactly the band the rail
// grows into — the app sizes it to stop just above the composer, which is the
// space the rail then takes. The rail is passive layer 50 and the native side
// chat is layer 60, so the side chat remains the top owner when they overlap.
//
// The panel keeps its full box when closed (353x536 here, unchanged), so the
// rect cannot say whether it is open. Computed visibility can: closed is
// `visibility: hidden` from Tailwind's `invisible`.
const SIDE_GAP = 10;
const RAIL_MIN = 220;

function sideChatRect() {
    for (const n of document.querySelectorAll('.epitaxy-side-chat')) {
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const b = n.getBoundingClientRect();
        if (b.width < 80 || b.height < 80) continue;
        return b;
    }
    return null;
}

// The rail is anchored to the prompt box every tick rather than parented to it:
// parenting would put our nodes inside React-owned DOM.
function place() {
    if (!host) return;
    const p = promptBox();
    if (!p) { host.style.visibility = 'hidden'; return; }
    const r = p.getBoundingClientRect();
    if (!r.width) { host.style.visibility = 'hidden'; return; }
    const stackTop = composerStackTop(p, r);

    let width = Math.round(r.width);
    const sc = sideChatRect();
    if (sc) {
        // Only when the two actually share a band. A panel that opens somewhere
        // the rail does not reach must not shrink it for nothing.
        const railTop = rail ? rail.getBoundingClientRect().top : stackTop - V.gap;
        if (sc.bottom > railTop && sc.left < r.left + width) {
            // Floor rather than hide: the rail holds messages you have not sent,
            // and a window narrow enough to hit this floor is one where covering
            // a corner of the side chat is the lesser problem.
            width = Math.max(RAIL_MIN, Math.round(sc.left - SIDE_GAP - r.left));
        }
    }

    host.style.visibility = '';
    host.style.left = Math.round(r.left) + 'px';
    host.style.width = width + 'px';
    host.style.bottom = Math.round(innerHeight - stackTop + V.gap) + 'px';
}

// ------------------------------------------------------------------ persistence
function adopt(targetSid, next, opts) {
    const value = Array.isArray(next) ? next : [];
    store[targetSid] = value;
    if (sid !== targetSid) return;
    items = value;
    render(opts);
}

let refreshGeneration = 0;
async function refreshStore(sentId) {
    const generation = ++refreshGeneration;
    const next = await cuimod.rpc('queue.load').catch(() => null);
    if (generation !== refreshGeneration || !next || typeof next !== 'object') return;
    store = next;
    items = (sid && Array.isArray(store[sid])) ? store[sid] : [];
    render({ sentId: sentId || null, bump: !!sentId });
}

function syncConfig() {
    cuimod.rpc('queue.configure', { enabled: !!V.enabled, autoSend: !!V.autoSend,
        autoSendDelay: Math.max(0, Number(V.autoSendDelay) || 0) }).catch(() => {});
}

// The dashboard owns the settings file; this only reaches into it for the one
// value the rail can toggle on its own.
function pushSetting(key, value) {
    const R = globalThis.__cuimodReg;
    // Through the dashboard when it is loaded, so its in-memory copy and the
    // overlay's own control stay in step; straight to disk if it is not.
    if (R && typeof R.set === 'function' && R.set('queue', key, value)) return;
    cuimod.rpc('dashboard.save', { plugin: 'queue', values: { [key]: value } }).catch(() => {});
}

// ------------------------------------------------------------------ actions
async function enqueueFromComposer() {
    const targetSid = sid;
    if (!targetSid) return false;
    const r = await cuimod.rpc('queue.editorGet').catch(() => null);
    if (!r || !r.ok) {
        if (r?.reason) toast(r.reason === 'composer-changed'
            ? 'The composer changed while its images were being prepared. Try again.'
            : r.reason === 'unsupported-attachment'
                ? 'This queue currently accepts text and images, not file attachments.'
                : 'Could not read the composer attachments.');
        return false;
    }
    const text = String(r.text || '');
    const images = Array.isArray(r.images) ? r.images : [];
    if (!text.trim() && !images.length) return false;
    const item = { id: uid(), text, images, at: Date.now() };
    const next = await cuimod.rpc('queue.enqueue', { sid: targetSid, item }).catch((e) => {
        toast('queue failed: ' + ((e && e.message) || e));
        return null;
    });
    if (!next) return false;
    if (sid === targetSid) await cuimod.rpc('queue.editorClear').catch(() => {});
    adopt(targetSid, next, { bump: true });
    return true;
}

async function steer(id) {
    const targetSid = sid;
    if (!items.some((x) => x.id === id) || !targetSid) return;
    if (editing === id) await cancelEdit();
    // Main owns the send and the durable removal as one operation. That keeps a
    // turn-end drain and a click from releasing the same item, and a successful
    // send is flushed before the renderer can disappear or switch sessions.
    const result = await cuimod.rpc('queue.steer', { sid: targetSid, id,
        freeForeground: !!V.freeForeground }).catch((e) => ({ ok: false, reason: (e && e.message) || e }));
    if (!result?.ok) {
        toast('steer failed: ' + (result?.reason || 'unknown error'));
        return;
    }
    if (result.foreground?.backgrounded && result.foreground.tool)
        toast('backgrounded ' + result.foreground.tool + ' to steer');
    adopt(targetSid, result.items, { sentId: id, bump: true });
}

function armTrash(id) {
    if (armedTrash === id) {
        clearTimeout(armedTimer);
        armedTrash = null;
        if (editing === id) cancelEdit();
        const targetSid = sid;
        if (targetSid) cuimod.rpc('queue.remove', { sid: targetSid, id })
            .then((next) => adopt(targetSid, next, { bump: true }))
            .catch((e) => toast('remove failed: ' + ((e && e.message) || e)));
        return;
    }
    armedTrash = id;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armedTrash = null; render(); }, 3000);
    render();
}
ctx.onDispose(() => clearTimeout(armedTimer));

async function toggleEdit(id) {
    if (editing === id) { await cancelEdit(); return; }
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const r = await cuimod.rpc('queue.editorGet').catch(() => null);
    if (!r || !r.ok) {
        toast('Could not read the composer attachments.');
        return;
    }
    if (!r.empty) {
        toast('Clear the composer before editing this message.');
        return;
    }
    editing = id;
    document.documentElement.setAttribute(EDIT_ATTR, '');
    cuimod.rpc('queue.hold', { sid, id }).catch(() => {});
    const restored = await cuimod.rpc('queue.editorSet', { text: it.text, images: it.images || [] }).catch(() => null);
    if (!restored?.ok) {
        endEditState();
        await cuimod.rpc('queue.editorClear').catch(() => {});
        toast('Could not restore the queued images into the composer.');
        return;
    }
    render();
}

function endEditState() {
    const heldSid = sid;
    editing = null;
    document.documentElement.removeAttribute(EDIT_ATTR);
    if (heldSid) cuimod.rpc('queue.hold', { sid: heldSid, id: null }).catch(() => {});
}

async function commitEdit() {
    const id = editing;
    const targetSid = sid;
    if (!id || !targetSid) return;
    const r = await cuimod.rpc('queue.editorGet').catch(() => null);
    if (!r || !r.ok) {
        toast(r?.reason === 'composer-changed'
            ? 'The composer changed while its images were being prepared. Try again.'
            : 'Could not read the composer attachments.');
        return;
    }
    endEditState();
    const text = String(r.text || '');
    const images = Array.isArray(r.images) ? r.images : [];
    let next = null;
    if (text.trim() || images.length) {
        next = await cuimod.rpc('queue.update', { sid: targetSid, id, text, images }).catch((e) => {
            toast('update failed: ' + ((e && e.message) || e));
            return null;
        });
    } else {
        // Emptying the composer and confirming is how you drop it while editing.
        next = await cuimod.rpc('queue.remove', { sid: targetSid, id }).catch((e) => {
            toast('remove failed: ' + ((e && e.message) || e));
            return null;
        });
    }
    if (sid === targetSid) await cuimod.rpc('queue.editorClear').catch(() => {});
    if (next) adopt(targetSid, next, { bump: true });
}

async function cancelEdit() {
    if (!editing) return;
    endEditState();
    await cuimod.rpc('queue.editorClear').catch(() => {});
    render();
}

// ------------------------------------------------------------------ input
// Capture at window: React attaches its own listener at the root container, so a
// capture-phase listener here runs first and stopImmediatePropagation keeps the
// app's submit from ever seeing the key.
function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

ctx.track(window, 'keydown', (e) => {
    if (!V.enabled) return;
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.isComposing || e.keyCode === 229) return;   // IME still composing
    if (!composerFocused()) return;
    if (suggestionOpen()) return;                     // the menu owns Enter
    if (editing) { swallow(e); commitEdit(); return; }
    if (!V.interceptEnter || !running) return;
    if (hostCommandTyped()) return;                   // the app runs it in place
    swallow(e);
    enqueueFromComposer();
}, { capture: true });

for (const type of ['pointerdown', 'mousedown', 'click']) {
    ctx.track(window, type, (e) => {
        if (!V.enabled) return;
        const t = e.target;
        if (!t || !t.closest) return;
        const hit = t.closest('button[data-testid="' + SEND_ID + '"], button[data-testid="' + STOP_ID + '"]');
        if (!hit) return;
        const isStop = hit.getAttribute('data-testid') === STOP_ID;
        // Editing owns that corner, whichever button is mounted there.
        if (editing) { swallow(e); if (type === 'click') commitEdit(); return; }
        // Stop is never taken over otherwise: it is the app's interrupt.
        if (isStop) return;
        if (!V.interceptSend || !running) return;
        if (hostCommandTyped()) return;           // the app runs it in place
        swallow(e);
        if (type === 'click') enqueueFromComposer();
    }, { capture: true });
}

// ------------------------------------------------------------------ turn watch
// The renderer still tracks running state because that decides whether Enter is
// intercepted. Delivery itself is main-process work; focus and visibility have
// no bearing on it.
let pollBusy = false;
async function pollSession() {
    if (pollBusy) return;
    pollBusy = true;
    try {
        const next = (location.pathname.match(/local_[0-9a-f-]{36}/) || [null])[0];
        if (next !== sid) {
            if (editing) endEditState();
            sid = next;
            armedTrash = null;
            items = (sid && store[sid]) || [];
            render();
            refreshStore();
        }
        if (!sid) { running = false; return; }
        const s = await cuimod.appInvoke(GET_SESSION, sid).catch(() => null);
        running = !!(s && s.isRunning);
        if (editing) cuimod.rpc('queue.hold', { sid, id: editing }).catch(() => {});
    } finally { pollBusy = false; }
}

ctx.every(700, () => { if (loaded) pollSession(); });
ctx.every(180, () => { if (host) { dedupe(); place(); } });
ctx.observe(document.documentElement, { childList: true, subtree: true }, () => { if (host) place(); });
ctx.track(window, 'resize', () => place());

// ------------------------------------------------------------------ settings
function apply(v) {
    V = Object.assign({}, DEF, v || {});
    syncConfig();
    pageStyle.textContent = V.enabled ? pageRules() : '';
    if (!V.enabled) { endEditState(); teardown(); return; }
    restyle();
    render();
}

// ------------------------------------------------------------------ dashboard
function mockRail(v, sel) {
    // The preview reuses the live stylesheet by name, so the numbers cannot
    // drift; only the values differ between stages.
    return `
${sel} .cq-rail {
    width: 420px; border-radius: 12px; overflow: hidden;
    background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) 92%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    --acc: ${v.accent};
}
${sel} .cq-hd {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 10px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 4%, transparent);
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
    font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%));
}
${sel} .cq-n {
    display: inline-grid; place-items: center; min-width: 16px; height: 16px;
    padding: 0 4px; border-radius: 8px; letter-spacing: 0;
    background: color-mix(in srgb, ${v.accent} 26%, transparent);
    color: hsl(var(--text-100, 60 14% 97%));
}
${sel} .cq-auto {
    margin-left: auto; display: flex; align-items: center; gap: 6px;
    padding: 3px 8px 3px 6px; border-radius: 999px; text-transform: none; letter-spacing: 0;
    font-size: 10.5px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
    border: 1px solid ${v.autoSend ? `color-mix(in srgb, ${v.accent} 45%, transparent)` : 'transparent'};
    color: hsl(var(--text-${v.autoSend ? '200, 55 8% 85%' : '400, 50 6% 65%'}));
}
${sel} .cq-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: ${v.autoSend ? v.accent : 'color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 22%, transparent)'};
    ${v.autoSend ? `box-shadow: 0 0 0 3px color-mix(in srgb, ${v.accent} 22%, transparent);` : ''}
}
${sel} .cq-row {
    display: flex; align-items: flex-start; gap: 8px; padding: 7px 8px 7px 10px;
}
${sel} .cq-row + .cq-row { border-top: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 7%, transparent); }
${sel} .cq-row.edit { background: color-mix(in srgb, ${v.accent} 12%, transparent); box-shadow: inset 2px 0 0 ${v.accent}; }
${sel} .cq-ord { font-size: 9.5px; color: hsl(var(--text-500, 48 5% 57%)); min-width: 10px; text-align: right; margin-top: 1px; }
${sel} .cq-txt {
    flex: 1 1 auto; min-width: 0;
    font-size: ${v.size}px; line-height: 1.42;
    color: hsl(var(--text-200, 55 8% 85%));
    overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: ${Math.max(1, Math.round(v.lines))};
}
${sel} .cq-acts { display: flex; gap: 2px; flex: 0 0 auto; }
${sel} .cq-b {
    display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px;
    color: hsl(var(--text-500, 48 5% 57%));
}
${sel} .cq-b svg { width: 13px; height: 13px; }
${sel} .cq-b.s { color: ${v.accent}; background: color-mix(in srgb, ${v.accent} 16%, transparent); }
${sel} .cq-send {
    margin-top: 10px; display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; color: ${v.accent};
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
}
`;
}

const LONG = 'Also check the tick math in net_player_state.cpp — the u16/u32 mismatch on the fourth field lands every packet after it one short, so the desync looks like a tick-rate problem until you read the struct.';

const spec = {
    plugin: 'queue',
    title: 'Send queue',
    description: 'Explicit queue for messages typed mid-turn, with steer, edit and auto-send.',
    defaults: DEF,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled',
          hint: 'Off restores the app’s default: typing mid-turn steers immediately.', group: 'Behaviour' },
        { key: 'interceptEnter', type: 'toggle', label: 'Enter queues mid-turn',
          hint: 'While a turn is running, Enter queues instead of sending.', group: 'Behaviour' },
        { key: 'interceptSend', type: 'toggle', label: 'Send button queues mid-turn',
          hint: 'Same rule for the composer’s send button.', group: 'Behaviour' },
        { key: 'autoSend', type: 'toggle', label: 'Auto-send at turn end',
          hint: 'Release the head of the queue once the turn fully ends.', group: 'Behaviour' },
        { key: 'autoSendDelay', type: 'slider', label: 'Auto-send delay', min: 0, max: 4000, step: 50, unit: 'ms',
          hint: 'Grace period after the turn ends, so you can still steer or edit.', group: 'Behaviour' },
        { key: 'freeForeground', type: 'toggle', label: 'Steer lands immediately',
          hint: 'Steer frees the turn from the running tool call so the message is read now instead of after it returns — backgrounding it when it is a Bash or Agent task, ending the turn where it stands when it is not. Running subagents keep going either way.',
          group: 'Behaviour' },
        { key: 'accent', type: 'color', label: 'Accent', group: 'Look' },
        { key: 'size', type: 'slider', label: 'Message size', min: 10, max: 18, step: 0.5, unit: 'px', group: 'Look' },
        { key: 'lines', type: 'slider', label: 'Preview lines', min: 1, max: 6, step: 1, unit: '', group: 'Look' },
        { key: 'gap', type: 'slider', label: 'Gap above prompt', min: 0, max: 40, step: 1, unit: 'px', group: 'Look' },
        { key: 'speed', type: 'slider', label: 'Animation scale', min: 0.4, max: 2, step: 0.05, unit: '×', group: 'Look' },
    ],
    apply,
    preview: {
        title: 'Preview — send queue',
        beforeLabel: 'plugin defaults (no stock equivalent)',
        afterLabel: 'your settings',
        node() {
            const box = el('div', 'cq-rail');
            const hd = el('div', 'cq-hd');
            hd.append(el('span', 'cq-n', '2'), el('span', null, 'queued'));
            const auto = el('div', 'cq-auto');
            auto.append(el('span', 'cq-dot'), el('span', null, 'auto-send at turn end'));
            hd.append(auto);
            box.append(hd);

            const rows = [
                { n: '1', t: 'Check the desync first, then come back to the overlay.', edit: true },
                { n: '2', t: LONG, edit: false },
            ];
            for (const r of rows) {
                const row = el('div', 'cq-row' + (r.edit ? ' edit' : ''));
                row.append(el('div', 'cq-ord', r.n), el('div', 'cq-txt', r.t));
                const acts = el('div', 'cq-acts');
                for (const [k, icon] of [['s', ICONS.steer], ['e', ICONS.edit], ['t', ICONS.trash]]) {
                    const b = el('div', 'cq-b ' + k);
                    b.innerHTML = icon;
                    acts.append(b);
                }
                row.append(acts);
                box.append(row);
            }

            const wrap = el('div', 'cq-wrap');
            wrap.append(box, el('div', 'cq-send', 'update queued'));
            return wrap;
        },
        css(v, sel, which) {
            return mockRail(which === 'before' ? DEF : v, sel);
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

// ------------------------------------------------------------------ boot
ctx.onDispose(cuimod.appOn('cuimod:event', (_event, payload) => {
    if (payload?.type !== 'queue-changed') return;
    refreshStore(payload.sessionId === sid ? payload.sentId : null);
}));
ctx.onDispose(() => {
    if (editing && sid) cuimod.rpc('queue.hold', { sid, id: null }).catch(() => {});
});

cuimod.rpc('queue.load')
    .then((d) => { store = d || {}; })
    .catch(() => { store = {}; })
    .then(() => {
        loaded = true;
        pollSession();
    });
