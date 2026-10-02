/* claude-ui-mod :: model-lock (renderer)
 *
 * Says when a human is choosing a model or effort, so the main half can tell a
 * deliberate pick apart from account-level reconciliation. Current Desktop has
 * separate LocalSessions.setModel and setEffort invokes; neither payload says
 * whether the write came from the user or selector reconciliation.
 *
 * Arming is deliberately generous at the front and short at the back: the menu
 * announces itself well before the click, and the click closes it before the
 * invoke lands, so a window that only covered "menu currently open" would miss
 * the very write it exists to allow.
 */
'use strict';

// Both the root ModelSelector popup and its nested "More models" submenu carry
// model rows, and a pick from either is a pick.
const MENU = '[role="menu"]';
const ROW = '[role="menuitemradio"][data-model-id]';
const RADIO = '[role="menuitemradio"]';
const REFRESH_MS = 4000;

let enabled = true;
const lastArm = new Map();

function desktopSessionId() {
    const match = (location.pathname + location.search)
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? 'local_' + match[0].toLowerCase() : null;
}

function arm(kind, reason) {
    if (!enabled || !['model', 'effort'].includes(kind)) return;
    const sessionId = desktopSessionId();
    if (!sessionId) return;
    const key = sessionId + ':' + kind;
    const now = Date.now();
    if (now - Number(lastArm.get(key) || 0) < REFRESH_MS && reason === 'menu') return;
    lastArm.set(key, now);
    cuimod.rpc('model-lock.arm', { sessionId, kind }).catch(() => { /* host reloading; the next one retries */ });
}

function menuKinds() {
    const kinds = new Set();
    for (const menu of document.querySelectorAll(MENU)) {
        if (menu.querySelector(ROW)) kinds.add('model');
        else if (menu.hasAttribute('data-nested') && menu.querySelector(RADIO)) kinds.add('effort');
    }
    return kinds;
}

ctx.every(500, () => { for (const kind of menuKinds()) arm(kind, 'menu'); });

// pointerdown, not click: it precedes the app's own handler, so the arming RPC
// is already in flight by the time the invoke is built. Model and effort picks
// authorize only their own write on the session currently visible in this view.
ctx.track(document, 'pointerdown', (e) => {
    const row = e.target.closest?.(RADIO);
    if (!row) return;
    const menu = row.closest?.(MENU);
    const kind = row.matches(ROW) ? 'model' : menu?.hasAttribute('data-nested') ? 'effort' : null;
    if (!kind) return;
    const sessionId = desktopSessionId();
    if (sessionId) lastArm.delete(sessionId + ':' + kind);
    arm(kind, 'row');
}, true);

// /model never opens the popup. The command deliberately owns the complete
// selection, so authorize both writes, but only for the currently visible session.
ctx.track(document, 'keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const box = e.target.closest?.('[contenteditable="true"]');
    if (!box || !/^\/model\b/.test(box.textContent.trim())) return;
    const sessionId = desktopSessionId();
    if (sessionId) { lastArm.delete(sessionId + ':model'); lastArm.delete(sessionId + ':effort'); }
    arm('model', 'command'); arm('effort', 'command');
}, true);

const DEFAULTS = { enabled: true };
const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'model-lock', title: 'Session model lock',
    description: 'Holds each provider session on its own model and reasoning effort when the app tries to reconcile account-level selector state. Deliberate picker changes and /model are unaffected.',
    defaults: DEFAULTS, immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Hold provider models', group: 'Model',
          hint: 'The account can only persist Anthropic models, so the app rewrites a provider session to the stored default the first time it mounts. This refuses that one write.' },
        { key: 'scope', type: 'info', label: 'What is refused', group: 'Model',
          text: 'Only a write that replaces a provider model with a non-provider one, with no model menu open and no /model in the last ten seconds.',
          hint: 'Every other model change passes through untouched, including Claude to Claude. Refusals are recorded in .state/model-lock.json.' },
    ],
    apply(values) {
        enabled = { ...DEFAULTS, ...values }.enabled !== false;
        cuimod.rpc('model-lock.settings', { enabled }).catch(() => {});
    },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => { REG.specs.delete(spec.plugin); REG.subs.forEach(fn => { try { fn(); } catch (_) {} }); });
if (!REG.subs.size) spec.apply(DEFAULTS);
