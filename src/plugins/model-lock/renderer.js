/* claude-ui-mod :: model-lock (renderer)
 *
 * Says when a human is choosing a model, so the main half can tell a deliberate
 * pick apart from the account-level reconciliation write. Both arrive as the
 * same LocalSessions.setModel invoke; nothing in the payload separates them.
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
const REFRESH_MS = 4000;

let enabled = true;
let lastArm = 0;

function arm(reason) {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastArm < REFRESH_MS && reason === 'menu') return;
    lastArm = now;
    cuimod.rpc('model-lock.arm').catch(() => { /* host reloading; the next one retries */ });
}

function menuOpen() {
    for (const menu of document.querySelectorAll(MENU)) if (menu.querySelector(ROW)) return true;
    return false;
}

ctx.every(500, () => { if (menuOpen()) arm('menu'); });

// pointerdown, not click: it precedes the app's own handler, so the arming RPC
// is already in flight by the time the invoke is built.
ctx.track(document, 'pointerdown', (e) => {
    if (e.target.closest?.(ROW)) { lastArm = 0; arm('row'); }
}, true);

// /model never opens the popup, and refusing that write would be its own bug.
ctx.track(document, 'keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const box = e.target.closest?.('[contenteditable="true"]');
    if (box && /^\/model\b/.test(box.textContent.trim())) { lastArm = 0; arm('command'); }
}, true);

const DEFAULTS = { enabled: true };
const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'model-lock', title: 'Session model lock',
    description: 'Holds a session on a provider model when the app tries to reconcile it back to the account default. Deliberate picks from the model menu and /model are unaffected.',
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
