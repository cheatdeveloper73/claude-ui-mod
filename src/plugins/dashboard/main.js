/* claude-ui-mod :: dashboard (main)
 *
 * Settings store for every plugin. One JSON file, one object per plugin:
 *   { "<plugin>": { "<key>": <value> } }
 *
 * It lives in .state/, NOT under src/ — the baked loader watches src/ and a
 * write there would reload the host, which would rewrite it, forever.
 *
 * Writes are debounced and atomic (tmp + rename), so dragging a slider does not
 * hammer the disk and a crash mid-write cannot leave a truncated settings file.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SETTINGS_STATE = Symbol.for('cuimod.dashboard.settings');

module.exports = function (ctx) {
    const dir = path.join(ctx.boot.MOD_DIR, '.state');
    const file = path.join(dir, 'settings.json');
    const tmp = file + '.tmp';
    const shared = globalThis[SETTINGS_STATE] || (globalThis[SETTINGS_STATE] = { store: null });

    // A hot successor is constructed before this instance is disposed. Keep the
    // authoritative copy across that overlap so launch-time consumers cannot
    // fall back to older disk bytes between the dashboard edit and its flush.
    let store = shared.store;
    let timer = null;

    function read() {
        if (store) return store;
        try { store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
        catch (_) { store = {}; }
        if (!store || typeof store !== 'object' || Array.isArray(store)) store = {};
        shared.store = store;
        return store;
    }

    function flush() {
        timer = null;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
            fs.renameSync(tmp, file);
            return true;
        } catch (err) {
            ctx.log('settings write failed: ' + (err && err.message));
            return false;
        }
    }
    function schedule() {
        if (timer) return;
        timer = setTimeout(flush, 250);
    }
    ctx.onDispose(() => { if (timer) { clearTimeout(timer); flush(); } });

    ctx.method('load', () => read());

    ctx.method('save', (p) => {
        const plugin = p && p.plugin;
        const values = p && p.values;
        if (typeof plugin !== 'string' || !plugin) throw new Error('plugin required');
        if (!values || typeof values !== 'object') throw new Error('values required');
        const s = read();
        s[plugin] = { ...(s[plugin] || {}), ...values };
        if (p.immediate === true) {
            if (timer) clearTimeout(timer);
            if (!flush()) throw new Error('settings write failed');
        } else schedule();
        return true;
    });

    ctx.method('reset', (p) => {
        const plugin = p && p.plugin;
        const s = read();
        if (typeof plugin === 'string' && plugin) delete s[plugin];
        else for (const k of Object.keys(s)) delete s[k];
        if (p && p.immediate === true) {
            if (timer) clearTimeout(timer);
            if (!flush()) throw new Error('settings write failed');
        } else schedule();
        return true;
    });

    ctx.method('path', () => file);

    // The store is authoritative in memory once read, so anything that replaces
    // settings.json underneath it -- `git checkout .state/settings.json`, or an
    // edit by hand -- is overwritten by the next save unless the store is
    // dropped first. Call this, then host.rendererReload.
    ctx.method('reload', () => { store = null; shared.store = null; return true; });

    // Clipboard goes through main: navigator.clipboard.readText() needs a
    // permission the isolated world does not get prompted for, and silently
    // rejects. electron.clipboard has no such gate.
    ctx.method('clipRead', () => {
        try { return ctx.electron.clipboard.readText() || ''; } catch (_) { return ''; }
    });
    ctx.method('clipWrite', (p) => {
        const text = p && p.text;
        if (typeof text !== 'string') throw new Error('text required');
        ctx.electron.clipboard.writeText(text);
        return true;
    });
};
