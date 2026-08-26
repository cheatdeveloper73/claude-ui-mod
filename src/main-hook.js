/* claude-ui-mod :: BAKED main-process loader
 *
 * This file is appended into app.asar and is the ONLY main-side code that needs
 * a re-patch to change. Keep it dumb and permanent: it owns the stable IPC
 * surface and does nothing but (re)load src/runtime/host.js from disk.
 *
 * Stability contract, in order of importance:
 *   - A broken host NEVER takes down the app. Compile/construct errors are
 *     caught and the previous good host stays live.
 *   - The loader owns ipcMain.handle() forever, so hot reloads never touch
 *     handler registration (re-registering would throw "second handler").
 *   - The file watcher lives HERE, not in the host, so a host that fails to
 *     load can still be fixed by saving the file again — no restart, ever.
 */
;(function () {
    'use strict';
    try {
        const electron = require('electron');
        const { ipcMain, webContents } = electron;
        const fs = require('fs');
        const path = require('path');

        const MOD_DIR = '__MOD_DIR__';
        const EIPC_PREFIX = '__EIPC_PREFIX__';
        const RPC = 'cuimod:rpc';
        const EVT = 'cuimod:event';

        if (globalThis.__cuimod_boot) return;

        const log = (...a) => { try { console.log('[cuimod]', ...a); } catch (_) {} };

        const boot = {
            MOD_DIR,
            EIPC_PREFIX,
            RPC,
            EVT,
            electron,
            require,
            log,
            host: null,
            hostError: null,
            generation: 0,
            broadcast(payload) {
                for (const wc of webContents.getAllWebContents()) {
                    try { if (!wc.isDestroyed()) wc.send(EVT, payload); } catch (_) {}
                }
            },
        };
        globalThis.__cuimod_boot = boot;

        const hostPath = path.join(MOD_DIR, 'src', 'runtime', 'host.js');
        const srcRoot = path.join(MOD_DIR, 'src');
        const disabledFlag = path.join(MOD_DIR, 'DISABLED');

        // Drop every cached module under the mod directory so a reload picks up
        // the whole tree, not just the entry file.
        function clearCache() {
            const prefix = path.resolve(MOD_DIR) + path.sep;
            for (const k of Object.keys(require.cache)) {
                if (k.startsWith(prefix)) { try { delete require.cache[k]; } catch (_) {} }
            }
        }

        function loadHost(reason) {
            if (fs.existsSync(disabledFlag)) {
                if (boot.host) { try { boot.host.dispose(); } catch (_) {} boot.host = null; }
                log('DISABLED flag present; host not loaded');
                return false;
            }
            const prev = boot.host;
            let next;
            try {
                clearCache();
                const factory = require(hostPath);
                if (typeof factory !== 'function') throw new Error('host.js must export a factory function');
                next = factory(boot);
                if (!next || typeof next.dispatch !== 'function') throw new Error('host factory must return { dispatch, dispose }');
            } catch (err) {
                boot.hostError = String((err && err.stack) || err);
                log('host load FAILED (' + reason + '); keeping previous. ' + (err && err.message));
                boot.broadcast({ type: 'host-error', error: boot.hostError });
                return false;
            }
            // Only tear the old one down once the new one exists.
            if (prev) { try { prev.dispose(); } catch (e) { log('previous host dispose error: ' + (e && e.message)); } }
            boot.host = next;
            boot.hostError = null;
            boot.generation++;
            log('host loaded (' + reason + ') gen=' + boot.generation);
            boot.broadcast({ type: 'host-reloaded', generation: boot.generation });
            return true;
        }
        boot.loadHost = loadHost;

        // Stable RPC. Always resolves with an envelope so a plugin error can
        // never surface as an unhandled rejection inside the app's own code.
        ipcMain.handle(RPC, async (event, method, params) => {
            if (!boot.host) return { ok: false, error: 'cuimod host not loaded: ' + (boot.hostError || 'unknown') };
            try {
                return { ok: true, value: await boot.host.dispatch(String(method), params, event) };
            } catch (err) {
                return { ok: false, error: String((err && err.message) || err) };
            }
        });

        // Watcher lives in the loader so a broken host is always recoverable.
        let timer = null;
        let pendingRenderOnly = true;
        function onChange(name) {
            const n = String(name || '').replace(/\\/g, '/');
            if (!/\.(js|css|json)$/.test(n)) return;
            const rendererOnly = /(renderer\.js|bridge\.js|\.css)$/.test(n);
            if (!rendererOnly) pendingRenderOnly = false;
            clearTimeout(timer);
            timer = setTimeout(() => {
                const renderOnly = pendingRenderOnly;
                pendingRenderOnly = true;
                if (renderOnly) {
                    log('renderer reload (' + n + ')');
                    boot.broadcast({ type: 'renderer-reload', reason: n });
                } else {
                    loadHost('watch:' + n);
                }
            }, 160);
        }

        function startWatch() {
            try {
                fs.mkdirSync(srcRoot, { recursive: true });
                const w = fs.watch(srcRoot, { recursive: true }, (_ev, name) => onChange(name));
                w.on('error', () => { try { w.close(); } catch (_) {} setTimeout(startWatch, 3000); });
            } catch (err) {
                log('watch failed (' + (err && err.message) + '); retrying in 3s');
                setTimeout(startWatch, 3000);
            }
        }

        // Re-inject into windows created after boot.
        try {
            electron.app.on('web-contents-created', (_e, wc) => {
                try {
                    wc.on('did-finish-load', () => {
                        try { if (!wc.isDestroyed()) wc.send(EVT, { type: 'renderer-reload', reason: 'did-finish-load' }); } catch (_) {}
                    });
                } catch (_) {}
            });
        } catch (_) {}

        startWatch();
        loadHost('boot');
        log('loader installed');
    } catch (err) {
        try { console.error('[cuimod] loader failed', err); } catch (_) {}
    }
})();
