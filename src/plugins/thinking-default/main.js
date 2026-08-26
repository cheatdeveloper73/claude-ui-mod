/* claude-ui-mod :: thinking-default (main)
 *
 * Forces the Code transcript view to "Thinking" the first time a session shows
 * up in a window, so thinking text is on by default instead of Ctrl+O every time.
 *
 * Why this runs in the main process at all: transcript mode lives in a zustand
 * store the app keeps in module scope and hands down through React context
 * (persisted as epitaxy.sidePaneStore.v1). Nothing about it is on `window`, and
 * the preload's isolated world cannot see page-world objects or React fiber
 * expandos. webContents.executeJavaScript, however, evaluates in the page's own
 * world — so main is the only place that can reach the setter. The renderer
 * plugin just pokes this method.
 *
 * Applied ONCE per (page load, session id): the point is the default, not a
 * lock. Switching to Normal by hand afterwards has to stick.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MODES = ['normal', 'thinking', 'verbose', 'summary'];
const DEFAULT_TARGET = 'thinking';
// Page loads are identified by performance.timeOrigin: a reload resets the
// store to "normal", and keying on the origin makes the done-set reset with it.
const done = new Map();   // wcId -> { token, sids:Set }

function pageDoneFor(wcId) {
    const e = done.get(wcId);
    return e ? { [e.token]: [...e.sids] } : {};
}

function snippet(pageDone, target) {
    return `(() => {
    const DONE = ${JSON.stringify(pageDone)};
    const TARGET = ${JSON.stringify(target)};
    const token = String(performance.timeOrigin);
    const done = new Set(DONE[token] || []);

    function ownKey(node, prefix) {
        for (const k of Object.keys(node)) if (k.startsWith(prefix)) return k;
        return null;
    }
    function isStore(v) {
        if (!v || typeof v.getState !== 'function' || typeof v.setState !== 'function') return false;
        let s = null;
        try { s = v.getState(); } catch (_) { return false; }
        return !!s && typeof s.setTranscriptMode === 'function' && 'transcriptMode' in s;
    }
    function propValue(f) {
        const a = f.memoizedProps, b = f.pendingProps;
        return (a && a.value) || (b && b.value) || null;
    }

    const stores = new Set();

    // Cheap path: the store's context provider sits above every transcript, so
    // walking up from one lands on it in a few dozen hops.
    for (const n of document.querySelectorAll('[data-epitaxy-transcript-region], .epitaxy-root')) {
        const k = ownKey(n, '__reactFiber$') || ownKey(n, '__reactInternalInstance$');
        let f = k ? n[k] : null;
        for (let hops = 0; f && hops < 500; hops++, f = f.return) {
            const v = propValue(f);
            if (isStore(v)) { stores.add(v); break; }
        }
    }

    // Fallback: no anchor matched (markup changed, or a layout we have not seen).
    // Sweep the whole fiber tree from the React container instead.
    let swept = 0;
    if (stores.size === 0) {
        const roots = [];
        for (const el of document.querySelectorAll('body > *')) {
            const k = ownKey(el, '__reactContainer$');
            if (k) roots.push(el[k]);
        }
        const stack = roots.filter(Boolean);
        while (stack.length && swept < 40000) {
            const f = stack.pop();
            swept++;
            const v = propValue(f);
            if (isStore(v)) stores.add(v);
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
        }
    }

    const seen = [];
    for (const store of stores) {
        const s = store.getState();
        const sid = s.currentSessionId;
        // No session on screen means reset() has not run yet; anything set now
        // is overwritten by transcriptModeBySession the moment one opens.
        if (typeof sid !== 'string' || !sid) continue;
        const mode = s.transcriptMode;
        let applied = false, error = null;
        if (!done.has(sid) && mode !== TARGET) {
            try { s.setTranscriptMode(TARGET); applied = true; }
            catch (e) { error = String((e && e.message) || e); }
        }
        seen.push({ sid, mode, applied, error });
    }
    return { token, stores: stores.size, swept, seen };
})()`;
}

module.exports = function (ctx) {
    const stateDir = path.join(ctx.boot.MOD_DIR, '.state');
    const statePath = path.join(stateDir, 'thinking-default.json');
    let lastWritten = '';

    // No console reaches the user, so the last outcome goes to disk — rewritten
    // only when it changes, never appended, so it cannot grow.
    function report(obj) {
        const text = JSON.stringify(obj, null, 2);
        if (text === lastWritten) return;
        lastWritten = text;
        try {
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(statePath, text);
        } catch (_) {}
    }

    ctx.method('apply', async (params, event) => {
        const wc = event && event.sender;
        if (!wc || wc.isDestroyed()) return { ok: false, error: 'no sender' };
        const target = MODES.indexOf(params && params.target) !== -1 ? params.target : DEFAULT_TARGET;
        // Changing the target in the dashboard has to take effect on the session
        // already on screen, not just the next one, so the one-shot record is
        // scoped to the target it was recorded for.
        const prev = done.get(wc.id);
        if (prev && prev.target !== target) done.delete(wc.id);
        let r;
        try {
            r = await wc.executeJavaScript(snippet(pageDoneFor(wc.id), target), false);
        } catch (err) {
            const out = { ok: false, at: Date.now(), wc: wc.id, error: String((err && err.message) || err) };
            report(out);
            return out;
        }
        if (!r || typeof r !== 'object') return { ok: false, error: 'bad result' };

        let entry = done.get(wc.id);
        if (!entry || entry.token !== r.token) { entry = { token: r.token, target, sids: new Set() }; done.set(wc.id, entry); }
        // Every session observed is marked, applied or not: one shot per session,
        // so a later manual switch back to Normal is left alone.
        for (const s of r.seen || []) if (s.sid) entry.sids.add(s.sid);
        if (entry.sids.size > 200) entry.sids = new Set([...entry.sids].slice(-200));

        const applied = (r.seen || []).filter((s) => s.applied).map((s) => s.sid);
        if (applied.length || r.stores === 0 || (r.seen || []).some((s) => s.error)) {
            report({ ok: true, at: Date.now(), wc: wc.id, target, stores: r.stores, swept: r.swept, applied, seen: r.seen });
        }
        return { ok: true, stores: r.stores, applied };
    });

    ctx.onDispose(() => done.clear());
};
