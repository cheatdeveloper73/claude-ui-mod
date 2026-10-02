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
const { providerRegistrations, registrationFor } = require('../provider-routing/registrations');

const MODEL_SUFFIX = '_$_claude.web_$_LocalSessions_$_setModel';
const EFFORT_SUFFIX = '_$_claude.web_$_LocalSessions_$_setEffort';
// The picker click closes the menu before the invoke lands, so the arming
// window has to outlive the menu itself. Ten seconds covers a slow roundtrip
// and is still far shorter than the gap between a session focus and the
// reconciliation write it triggers.
const ARM_MS = 10000;
const KEEP_DROPS = 50;
const SAVE_DEBOUNCE = 2000;

// Older provider aliases can carry effort as `slug:tier`, while current Desktop
// persists effort separately on the session. Model ownership still compares on
// the bare slug so either spelling remains protected.
function baseId(id) {
    return String(id || '').trim().toLowerCase()
        .replace(/\[1m\]/g, '')
        .replace(/:(none|minimal|low|medium|high|xhigh|max|ultra|pro)$/, '');
}

// A declared provider's ids travel without the claude- alias, so a prefixed
// spelling of one compares as its own id.
function bare(id) {
    const text = baseId(id);
    const stripped = text.replace(/^(?:claude-)+/, '');
    return stripped !== text && registrationFor(stripped) ? stripped : text;
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
    const armed = new Map();

    function armedFor(sessionId, kind, now = Date.now(), consume = false) {
        const entry = armed.get(sessionId);
        if (!entry) return false;
        for (const key of ['model', 'effort']) if (Number(entry[key] || 0) <= now) delete entry[key];
        const active = Number(entry[kind] || 0) > now;
        if (active && consume) delete entry[kind];
        if (!entry.model && !entry.effort) armed.delete(sessionId);
        return active;
    }

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

    // Availability controls admission in the adapter, not ownership of a saved
    // selection. A retired model or missing catalogue must still stay selected
    // until the user chooses another model.
    const isInjected = id => injected.has(bare(id)) || registrationFor(bare(id)) !== null;

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
    function storedSelection(sessionId) {
        if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
        for (const dir of sessionRoots()) {
            try {
                const raw = fs.readFileSync(path.join(dir, sessionId + '.json'), 'utf8');
                const value = JSON.parse(raw);
                if (value?.model) return { model: value.model,
                    ...(Object.hasOwn(value, 'effort') ? { effort: value.effort ?? null } : {}) };
            } catch (_) {}
        }
        return null;
    }

    // What the session is on right now. Our own record wins: it is written the
    // moment a write is allowed through, while the app's session file is
    // flushed on a debounce and can lag a deliberate pick by seconds.
    function currentSelection(sessionId) {
        const live = state.bySession[sessionId];
        if (live?.model && Object.hasOwn(live, 'effort')) return live;
        const stored = storedSelection(sessionId);
        if (!stored) return live || null;
        const next = { ...(live || {}) };
        let changed = false;
        if (!next.model && stored.model) { next.model = stored.model; changed = true; }
        if (!Object.hasOwn(next, 'effort') && Object.hasOwn(stored, 'effort')) {
            next.effort = stored.effort ?? null; changed = true;
        }
        if (changed) {
            next.at ||= Date.now();
            state.bySession[sessionId] = next;
            save();
        }
        return changed ? next : live || stored;
    }
    function currentModel(sessionId) {
        return currentSelection(sessionId)?.model || null;
    }
    function currentEffort(sessionId) {
        const selection = currentSelection(sessionId);
        return selection && Object.hasOwn(selection, 'effort') ? selection.effort ?? null : undefined;
    }

    function decideModel(sessionId, model) {
        if (!enabled || armedFor(sessionId, 'model', Date.now(), true)) return null;
        const from = currentModel(sessionId);
        if (!from || !isInjected(from) || isInjected(model) || bare(from) === bare(model)) return null;
        return { from, to: model };
    }
    function decideEffort(sessionId, effort) {
        if (!enabled || armedFor(sessionId, 'effort', Date.now(), true)) return null;
        const model = currentModel(sessionId);
        if (!model || !isInjected(model)) return null;
        const from = currentEffort(sessionId);
        const to = effort ?? null;
        if (from === to) return null;
        return { model, from, to, known: from !== undefined };
    }

    ctx.method('arm', (p) => {
        const sessionId = typeof p?.sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(p.sessionId) ? p.sessionId : null;
        const kind = p?.kind === 'model' || p?.kind === 'effort' ? p.kind : null;
        if (!sessionId || !kind) return { armed: false };
        const value = armed.get(sessionId) || {};
        value[kind] = Date.now() + ARM_MS;
        armed.set(sessionId, value);
        return { armed: true, sessionId, kind, armedUntil: value[kind] };
    });
    ctx.method('status', () => {
        const now = Date.now();
        for (const sessionId of [...armed.keys()]) {
            armedFor(sessionId, 'model', now); armedFor(sessionId, 'effort', now);
        }
        return { enabled, armed: armed.size > 0, armedSessions: armed.size, injected: injected.size,
            protectedNamespaces: providerRegistrations().map(r => r.pattern.source), windows: wrapped.size, tracked: Object.keys(state.bySession).length,
            drops: state.drops.length, recent: state.drops.slice(-5), stateFile };
    });
    ctx.method('settings', (p) => {
        if (p && typeof p.enabled === 'boolean') enabled = p.enabled;
        return { enabled };
    });

    const wrapped = new Map();
    function rememberDrop(drop) {
        state.drops.push({ at: new Date().toISOString(), ...drop });
        if (state.drops.length > KEEP_DROPS) state.drops.splice(0, state.drops.length - KEEP_DROPS);
        save();
    }
    function attach() {
        for (const wc of ctx.electron.webContents.getAllWebContents()) {
            const registry = wc.ipc?._invokeHandlers;
            if (!registry) continue;
            const owned = wrapped.get(wc) || {};

            const modelKey = [...registry.keys()].find(k => k.endsWith(MODEL_SUFFIX));
            if (modelKey) {
                const current = registry.get(modelKey);
                if (owned.model?.wrapper !== current) {
                    // A new host is built before the previous one is disposed. Unwrap
                    // our predecessor so hot reload cannot stack wrappers forever.
                    const original = current.__cuimodModelLockOriginal || current;
                    const wrapper = async (event, sessionId, model) => {
                        const drop = decideModel(sessionId, model);
                        if (drop) {
                            rememberDrop({ kind: 'model', sessionId, from: drop.from, to: model });
                            ctx.log('held ' + sessionId + ' on ' + drop.from + ' (refused model ' + model + ')');
                            return;
                        }
                        const before = state.bySession[sessionId];
                        const accepted = { ...(before || {}), model, at: Date.now() };
                        state.bySession[sessionId] = accepted;
                        save();
                        try { return await original(event, sessionId, model); }
                        catch (error) {
                            if (state.bySession[sessionId] === accepted) {
                                if (before) state.bySession[sessionId] = before;
                                else delete state.bySession[sessionId];
                                save();
                            }
                            throw error;
                        }
                    };
                    wrapper.__cuimodModelLockOriginal = original;
                    registry.set(modelKey, wrapper);
                    owned.model = { registry, key: modelKey, original, wrapper };
                }
            }

            const effortKey = [...registry.keys()].find(k => k.endsWith(EFFORT_SUFFIX));
            if (effortKey) {
                const current = registry.get(effortKey);
                if (owned.effort?.wrapper !== current) {
                    const original = current.__cuimodEffortLockOriginal || current;
                    const wrapper = async (event, sessionId, effort) => {
                        const drop = decideEffort(sessionId, effort);
                        if (drop) {
                            rememberDrop({ kind: 'effort', sessionId, model: drop.model, from: drop.from, to: drop.to });
                            ctx.log('held ' + sessionId + ' on effort '
                                + (drop.known ? (drop.from ?? 'default') : 'unknown')
                                + ' (refused ' + (drop.to ?? 'default') + ')');
                            return;
                        }
                        const before = state.bySession[sessionId];
                        const model = currentModel(sessionId);
                        const accepted = { ...(before || {}), ...(model ? { model } : {}), effort: effort ?? null, at: Date.now() };
                        state.bySession[sessionId] = accepted;
                        save();
                        try { return await original(event, sessionId, effort); }
                        catch (error) {
                            if (state.bySession[sessionId] === accepted) {
                                if (before) state.bySession[sessionId] = before;
                                else delete state.bySession[sessionId];
                                save();
                            }
                            throw error;
                        }
                    };
                    wrapper.__cuimodEffortLockOriginal = original;
                    registry.set(effortKey, wrapper);
                    owned.effort = { registry, key: effortKey, original, wrapper };
                }
            }

            if (owned.model || owned.effort) wrapped.set(wc, owned);
        }
        for (const [wc] of wrapped) if (wc.isDestroyed()) wrapped.delete(wc);
    }
    attach();
    ctx.every(1000, attach);
    ctx.onDispose(() => {
        for (const owned of wrapped.values()) for (const { registry, key, original, wrapper } of Object.values(owned))
            if (registry.get(key) === wrapper) registry.set(key, original);
        wrapped.clear();
    });
};
