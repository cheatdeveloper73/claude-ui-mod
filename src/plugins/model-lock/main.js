/* claude-ui-mod :: model-lock (main)
 *
 * Keeps a session on the model it was actually put on.
 *
 * The Code UI persists the selected model per account with
 * PATCH /api/organizations/<org>/model_selector_state/code, and the server
 * refuses every injected id with 400 model_not_selectable -- measured for
 * gpt-5.6-{sol,terra,luna}, gemini-3.{1-pro,7-flash} and the Qwen entries. So
 * that row is frozen on whatever Claude model was accepted last (claude-opus-5
 * here, selection_source "user_setting"), and the first time a page generation
 * mounts a session it reconciles the session to that value: measured as an
 * inbound LocalSessions.setModel 0-7 s after setFocusedSession, once per
 * (page, session), with no menu open. One confirmed round trip:
 * local_12ccef43 was claude-gpt-5.6-sol[1m] on 2026-08-30 and claude-opus-5
 * twenty hours later without anyone touching the picker.
 *
 * Racing it is not an option -- the PATCH fails every time, so the persisted
 * value stays wrong however fast provider-picker installs its ids. The gate has
 * to be here, on the eipc handler, which is also the only place the write is
 * observable: main's own internal setModel calls are not logged and do not come
 * through this path.
 *
 * The rule is narrow on purpose. A write is dropped only when it replaces an
 * injected model with one this deployment did not inject, and only when no
 * human was picking a model in the seconds before it. Everything else passes
 * untouched, including every Claude-to-Claude change.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SUFFIX = '_$_claude.web_$_LocalSessions_$_setModel';
// The picker click closes the menu before the invoke lands, so the arming
// window has to outlive the menu itself. Ten seconds covers a slow roundtrip
// and is still far shorter than the gap between a session focus and the
// reconciliation write it triggers.
const ARM_MS = 10000;
const KEEP_DROPS = 50;
const SAVE_DEBOUNCE = 2000;

// Effort rides in the model string as `slug:tier` and the million-context tag
// as a `[...]` suffix, so the same model reaches us under several spellings.
// Compare on the bare slug.
function bare(id) {
    return String(id || '')
        .replace(/\[[^\]]*\]$/, '')
        .replace(/:(low|medium|high|xhigh|max)$/, '')
        .toLowerCase();
}

module.exports = function (ctx) {
    const stateFile = path.resolve(ctx.dir, '..', '..', '..', '.state', 'model-lock.json');
    let state = { bySession: {}, drops: [] };
    try { state = { drops: [], ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch (_) {}
    if (!state.bySession) state.bySession = {};

    let saveTimer = null;
    function save() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                fs.mkdirSync(path.dirname(stateFile), { recursive: true });
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 4));
            } catch (err) { ctx.log('state write failed: ' + err.message); }
        }, SAVE_DEBOUNCE);
    }
    ctx.onDispose(() => clearTimeout(saveTimer));

    let enabled = true;
    let armedUntil = 0;

    // Asking provider-picker for its own catalogue would be the tidier source,
    // but `boot.host` is not reliably there to ask through: probed from a plugin
    // three seconds after load, an early generation's boot carried only
    // electron, MOD_DIR, generation, log, broadcast and loadHost, and a later
    // one carried host as well. A cross-plugin dispatch that loses that race
    // resolves to undefined, and this gate would then never arm at all -- the
    // one failure mode it must not have. Read the same two files instead. Only
    // the ids are taken: `bare()` already discards the [1m] tag and the effort
    // suffix, so the sole rule that has to agree with the picker is the
    // claude- prefix.
    //
    // Read once, like the picker does: both files live under src/, and any edit
    // to them reloads the host and this plugin with it. An empty set means no
    // drops, which is the only safe direction for a gate that refuses a write.
    const injected = new Set();
    for (const name of ['catalogue.json', 'catalogue.private.json']) {
        try {
            const file = path.join(ctx.dir, '..', 'provider-picker', name);
            for (const entry of JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))) {
                const id = String(entry?.id || '');
                if (id) injected.add(bare(id.toLowerCase().startsWith('claude-') ? id : 'claude-' + id));
            }
        } catch (_) { /* absent private catalogue is the normal case */ }
    }

    // Authoritative current model for a session we have not seen a write for.
    // Desktop stores one JSON per session named by its id, two levels under
    // claude-code-sessions/<account>/<org>/. Only read on a candidate drop, so
    // the directory scan is off every hot path.
    let sessionDirs = { at: 0, list: [] };
    function sessionRoots() {
        const now = Date.now();
        if (now - sessionDirs.at < 30000) return sessionDirs.list;
        const list = [];
        try {
            const root = path.join(ctx.electron.app.getPath('userData'), 'claude-code-sessions');
            for (const account of fs.readdirSync(root, { withFileTypes: true })) {
                if (!account.isDirectory()) continue;
                const accountDir = path.join(root, account.name);
                for (const org of fs.readdirSync(accountDir, { withFileTypes: true }))
                    if (org.isDirectory()) list.push(path.join(accountDir, org.name));
            }
        } catch (_) {}
        sessionDirs = { at: now, list };
        return list;
    }
    function storedModel(sessionId) {
        if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
        for (const dir of sessionRoots()) {
            try {
                const raw = fs.readFileSync(path.join(dir, sessionId + '.json'), 'utf8');
                const model = JSON.parse(raw).model;
                if (model) return model;
            } catch (_) {}
        }
        return null;
    }

    // What the session is on right now. Our own record wins: it is written the
    // moment a write is allowed through, while the app's session file is
    // flushed on a debounce and can lag a deliberate pick by seconds.
    function currentModel(sessionId) {
        return state.bySession[sessionId]?.model || storedModel(sessionId);
    }

    function decide(sessionId, model) {
        if (!enabled) return null;
        if (!injected.size) return null;
        if (Date.now() < armedUntil) return null;
        const from = currentModel(sessionId);
        if (!from) return null;
        if (!injected.has(bare(from))) return null;
        if (injected.has(bare(model))) return null;
        if (bare(from) === bare(model)) return null;
        return { from, to: model };
    }

    ctx.method('arm', () => { armedUntil = Date.now() + ARM_MS; return { armedUntil }; });
    ctx.method('status', () => ({
        enabled, armed: Date.now() < armedUntil, injected: injected.size, windows: wrapped.size,
        tracked: Object.keys(state.bySession).length, drops: state.drops.length,
        recent: state.drops.slice(-5), stateFile,
    }));
    ctx.method('settings', (p) => {
        if (p && typeof p.enabled === 'boolean') enabled = p.enabled;
        return { enabled };
    });

    const wrapped = new Map();
    function attach() {
        for (const wc of ctx.electron.webContents.getAllWebContents()) {
            const registry = wc.ipc?._invokeHandlers;
            if (!registry) continue;
            const key = [...registry.keys()].find(k => k.endsWith(SUFFIX));
            if (!key) continue;
            const current = registry.get(key);
            if (wrapped.get(wc)?.wrapper === current) continue;
            // A new host is built before the previous one is disposed. Unwrap
            // our predecessor so hot reload cannot stack wrappers forever.
            const original = current.__cuimodModelLockOriginal || current;
            const wrapper = async (event, sessionId, model) => {
                const drop = decide(sessionId, model);
                if (drop) {
                    state.drops.push({ at: new Date().toISOString(), sessionId, from: drop.from, to: model });
                    if (state.drops.length > KEEP_DROPS) state.drops.splice(0, state.drops.length - KEEP_DROPS);
                    save();
                    ctx.log('held ' + sessionId + ' on ' + drop.from + ' (refused ' + model + ')');
                    return;
                }
                state.bySession[sessionId] = { model, at: Date.now() };
                save();
                return original(event, sessionId, model);
            };
            wrapper.__cuimodModelLockOriginal = original;
            registry.set(key, wrapper);
            wrapped.set(wc, { registry, key, original, wrapper });
        }
        for (const [wc] of wrapped) if (wc.isDestroyed()) wrapped.delete(wc);
    }
    attach();
    ctx.every(1000, attach);
    ctx.onDispose(() => {
        for (const { registry, key, original, wrapper } of wrapped.values())
            if (registry.get(key) === wrapper) registry.set(key, original);
        wrapped.clear();
    });
};
