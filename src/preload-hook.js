/* claude-ui-mod :: BAKED preload bridge loader
 *
 * Appended into app.asar; the only renderer-side code that needs a re-patch.
 * Runs in the sandboxed, context-isolated preload world of every claude.ai
 * view — once per window. It deliberately does NOT contextBridge anything into
 * the page, so claude.ai's own JS cannot reach this RPC surface.
 *
 * Responsibilities, all permanent:
 *   - stable rpc()/event plumbing to the main loader
 *   - an IPC tap + observer hook, installed early enough to see the app's own
 *     traffic (ipcRenderer is a singleton, so wrapping .invoke here is visible
 *     to closures the app already created)
 *   - load src/runtime/bridge.js source over RPC and evaluate it, with
 *     last-good-wins semantics on failure
 */
;(function () {
    'use strict';
    try {
        const { ipcRenderer } = require('electron');
        if (globalThis.__cuimod_boot) return;

        const EIPC_PREFIX = '__EIPC_PREFIX__';
        const RPC = 'cuimod:rpc';
        const EVT = 'cuimod:event';
        const TAP_MAX = 300;

        function eligible() {
            try {
                if (window.top !== window.self) return false;
                const h = location.host;
                return h === 'claude.ai' || h === 'claude.com' || h === 'preview.claude.ai';
            } catch (_) { return false; }
        }
        if (!eligible()) return;

        const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer);
        const rawSend = ipcRenderer.send.bind(ipcRenderer);
        const rawOn = ipcRenderer.on.bind(ipcRenderer);
        const rawOff = ipcRenderer.removeListener.bind(ipcRenderer);

        // Ring buffer of the app's own IPC calls — the introspection primitive
        // hot code uses to discover internal state without guessing.
        const tap = [];
        const observers = new Set();
        function record(kind, channel, args) {
            try {
                tap.push({ t: Date.now(), kind, channel: String(channel), args });
                if (tap.length > TAP_MAX) tap.splice(0, tap.length - TAP_MAX);
                for (const o of observers) { try { o(channel, args, kind); } catch (_) {} }
            } catch (_) {}
        }

        ipcRenderer.invoke = function (channel, ...args) {
            record('invoke', channel, args);
            return rawInvoke(channel, ...args);
        };
        ipcRenderer.send = function (channel, ...args) {
            record('send', channel, args);
            return rawSend(channel, ...args);
        };

        async function rpc(method, params) {
            const r = await rawInvoke(RPC, method, params);
            if (!r || !r.ok) throw new Error((r && r.error) || 'cuimod rpc failed: ' + method);
            return r.value;
        }

        const boot = {
            EIPC_PREFIX,
            rpc,
            tap,
            // Raw access to the app's own IPC, for hot code that wants to drive
            // or observe desktop internals directly.
            appInvoke: rawInvoke,
            appSend: rawSend,
            appOn(channel, fn) { rawOn(channel, fn); return () => rawOff(channel, fn); },
            observeInvoke(fn) { observers.add(fn); return () => observers.delete(fn); },
            // Build any eipc channel name: eipc('claude.web','LocalSessions','getAll')
            eipc(ns, iface, method) { return EIPC_PREFIX + ns + '_$_' + iface + '_$_' + method; },
            log(...a) { try { console.log('[cuimod]', ...a); } catch (_) {} },
        };
        globalThis.__cuimod_boot = boot;

        let current = null;
        let loading = false;
        let queued = false;

        async function load(reason) {
            if (loading) { queued = true; return; }
            loading = true;
            try {
                let bundle;
                try {
                    bundle = await rpc('host.rendererBundle');
                } catch (err) {
                    boot.log('bundle fetch failed (' + reason + '):', err && err.message);
                    return;
                }
                let factory;
                try {
                    // Compile first: syntax errors must not cost us the live UI.
                    factory = new Function('boot', 'plugins', bundle.bridge);
                } catch (err) {
                    boot.log('bridge compile failed, keeping previous:', err && err.message);
                    return;
                }
                if (current && typeof current.dispose === 'function') {
                    try { current.dispose(); } catch (e) { boot.log('previous bridge dispose error:', e && e.message); }
                }
                current = null;
                try {
                    current = factory(boot, bundle.plugins || []) || {};
                } catch (err) {
                    boot.log('bridge init failed:', err && err.message);
                }
            } finally {
                loading = false;
                if (queued) { queued = false; setTimeout(() => load('queued'), 0); }
            }
        }
        boot.reload = load;

        rawOn(EVT, (_e, payload) => {
            const t = payload && payload.type;
            if (t === 'renderer-reload' || t === 'host-reloaded') load(t);
            else if (t === 'host-error') boot.log('host error:', payload.error);
            else if (current && typeof current.onEvent === 'function') {
                try { current.onEvent(payload); } catch (_) {}
            }
        });

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => load('boot'), { once: true });
        } else {
            load('boot');
        }
    } catch (err) {
        try { console.error('[cuimod] preload loader failed', err); } catch (_) {}
    }
})();
