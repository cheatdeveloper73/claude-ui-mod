/* claude-ui-mod :: task-rail (main)
 *
 * Stops the app from throwing its own task pane open the first time a session
 * produces tasks. Nothing here draws the rail — that is all renderer — but the
 * decision lives inside claude.ai's pane store, a zustand store held in module
 * scope and handed down through React context. The preload's isolated world can
 * see neither page-world objects nor the __reactFiber$ expandos, so
 * webContents.executeJavaScript from main is the only thing that reaches it.
 *
 * What the app actually does (live bundle chunk c5610fbe3, effect `fT`):
 *
 *     let t = (Fe("epitaxy_plan_pane_auto_open") ? e : null)?.id,
 *         r = df(e => !!e.planAutoOpenedBySession[t]);
 *     ...
 *     if (r || !t || !n) return;                 // already done for this session
 *     let p = !i.hadTodos && l;                  // todos appeared, first time
 *     if (p && f) { pf(e,t,"plan") || (su(e,"plan","auto"), e.setSidePane("plan")),
 *                   e.markPlanAutoOpened(t); }
 *
 * So it is one-shot per session, keyed on todos going from none to some — which
 * is why it only ever fires on the very first task of a session and could not be
 * reproduced by adding a task to a session that had already had one.
 *
 * The suppression is therefore not a block and not a revert: we set the app's
 * own one-shot record ahead of it. `planAutoOpenedBySession` is read by that
 * effect and by nothing else — every other mention in the bundle is persistence,
 * session teardown or a store equality check — so pre-marking a session is
 * inert apart from the auto-open it gates. No flash, no fighting the app, and
 * every deliberate way of opening the pane still works.
 *
 * The cost of that precision: marking is one-way. The app has no unmark, so
 * turning the option off restores the auto-open for sessions that have not been
 * marked yet, not for the ones already seen.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RESWEEP_MS = 30000;

function snippet(enabled) {
    return `(() => {
    const W = window;
    const g = W.__cuimodPlanAutoOpen || (W.__cuimodPlanAutoOpen = {
        enabled: true, token: '', sweptAt: 0, subscribed: 0, marked: [], busy: false,
    });
    g.enabled = ${enabled ? 'true' : 'false'};

    // A reload builds new store objects, so the "already subscribed" record has
    // to reset with it. timeOrigin is the free per-page-load token.
    const token = String(performance.timeOrigin);
    if (g.token !== token) { g.token = token; g.sweptAt = 0; g.subscribed = 0; g.seen = null; g.marked = []; }
    if (!g.seen) g.seen = new WeakSet();

    function mark(st) {
        if (!g.enabled || g.busy) return;
        let s;
        try { s = st.getState(); } catch (_) { return; }
        const sid = s && s.currentSessionId;
        if (!sid || typeof s.markPlanAutoOpened !== 'function') return;
        if (s.planAutoOpenedBySession && s.planAutoOpenedBySession[sid]) return;
        // Re-entrancy: this runs from inside the store's own notify loop.
        g.busy = true;
        try { s.markPlanAutoOpened(sid); } catch (_) {}
        g.busy = false;
        g.marked.push({ t: Date.now(), sid: String(sid) });
        if (g.marked.length > 20) g.marked.shift();
    }

    function attach(st) {
        // Synchronous on the session becoming current, so a session that starts
        // producing tasks immediately is already marked by the time the app's
        // effect looks.
        st.subscribe((cur, prev) => {
            if (!prev || cur.currentSessionId !== prev.currentSessionId) mark(st);
        });
        g.stores = g.stores || [];
        g.stores.push(st);
        g.subscribed++;
        mark(st);
    }

    // The fiber sweep is the expensive part, so it runs once per page load and
    // then only rarely — a newly mounted tile can introduce another provider.
    if (g.subscribed === 0 || Date.now() - g.sweptAt > ${RESWEEP_MS}) {
        g.sweptAt = Date.now();
        const ownKey = (node, prefix) => { for (const k of Object.keys(node)) if (k.startsWith(prefix)) return k; return null; };
        const roots = [];
        for (const el of document.querySelectorAll('body > *')) {
            const k = ownKey(el, '__reactContainer$');
            if (k) roots.push(el[k]);
        }
        const stack = roots.filter(Boolean);
        let swept = 0;
        while (stack.length && swept < 200000) {
            const f = stack.pop(); swept++;
            const p = f.memoizedProps || f.pendingProps;
            const v = p && p.value;
            if (v && typeof v.getState === 'function' && typeof v.subscribe === 'function' && !g.seen.has(v)) {
                let s = null;
                try { s = v.getState(); } catch (_) { s = null; }
                if (s && typeof s.markPlanAutoOpened === 'function') { g.seen.add(v); attach(v); }
            }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
        }
    }

    // A session switch is caught by the subscriber, but a tab that was already
    // current when the guard was armed is not, so re-mark on every tick too.
    for (const st of (g.stores || [])) mark(st);

    return { enabled: g.enabled, stores: g.subscribed, marked: g.marked.length, last: g.marked[g.marked.length - 1] || null };
})()`;
}

module.exports = function (ctx) {
    const { webContents } = ctx.boot.electron;
    const statePath = path.join(ctx.boot.MOD_DIR, '.state', 'task-rail-autoopen.json');
    // The setting defaults on, and main runs before the renderer gets a chance
    // to say otherwise — a session opened during that gap must still be covered.
    let suppress = true;
    let lastWritten = '';

    function report(obj) {
        const text = JSON.stringify(obj, null, 2);
        if (text === lastWritten) return;
        lastWritten = text;
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, text);
        } catch (_) {}
    }

    async function install() {
        const src = snippet(suppress);
        const seen = [];
        for (const wc of webContents.getAllWebContents()) {
            let u = '';
            try { if (wc.isDestroyed()) continue; u = wc.getURL() || ''; } catch (_) { continue; }
            if (!/^https:\/\/claude\.(ai|com)\//.test(u)) continue;
            try { seen.push(await wc.executeJavaScript(src, false)); }
            catch (e) { seen.push({ error: String((e && e.message) || e) }); }
        }
        if (seen.length) report({ at: new Date().toISOString(), suppress, views: seen });
        return seen;
    }

    // Driven from main rather than from the renderer plugin: a hidden window
    // throttles its timers to about one tick a minute, and a session can be
    // created and start working while its window is in the background.
    ctx.every(2000, install);
    install();

    ctx.method('autoOpen', async (p) => {
        const want = !(p && p.suppress === false);
        const changed = want !== suppress;
        suppress = want;
        return changed ? { ok: true, views: await install() } : { ok: true };
    });
};
