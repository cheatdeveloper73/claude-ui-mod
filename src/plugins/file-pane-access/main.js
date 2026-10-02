/* claude-ui-mod :: file-pane-access (main)
 *
 * The Code file pane reads through LocalSessions.readSessionFileWithStatus.
 * SessionFileAccess answers {status:"notFound"} for any path outside the
 * session's granted roots, even when the file exists, and the pane renders that
 * as "Couldn't find this file" while Show in Explorer opens it fine.
 *
 * This wraps that handler on each WebContents.ipc registry (EIPC is registered
 * there, not on ipcMain). The shell answers first; only a notFound for a file
 * that exists on local disk is replaced, with the same response shape the shell
 * produces, so the native pane renders the file itself.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { rescue } = require('./rescue');

const SUFFIX = '_$_claude.web_$_LocalSessions_$_readSessionFileWithStatus';

function wrapHandler(original, onRescue, deps) {
    const wrapper = async (event, sessionId, filePath, options) => {
        const result = await original(event, sessionId, filePath, options);
        if (!result || result.status !== 'notFound') return result;
        let replacement = null;
        try { replacement = await rescue(sessionId, filePath, options, deps); } catch (_) {}
        if (!replacement) return result;
        if (onRescue) { try { onRescue(filePath, replacement.status); } catch (_) {} }
        return replacement;
    };
    wrapper.__cuimodFilePaneOriginal = original;
    return wrapper;
}

module.exports = function (ctx) {
    const statusFile = path.join(ctx.boot.MOD_DIR, '.state', 'file-pane-access.json');
    const status = { attached: 0, rescued: 0, last: null };
    function save() {
        try {
            fs.mkdirSync(path.dirname(statusFile), { recursive: true });
            fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
        } catch (_) {}
    }
    function onRescue(filePath, result) {
        status.rescued++;
        status.last = { at: new Date().toISOString(), path: String(filePath), result };
        save();
    }

    const wrapped = new Map();
    function attach() {
        const all = ctx.electron.webContents.getAllWebContents();
        for (const wc of all) {
            const registry = wc.ipc && wc.ipc._invokeHandlers;
            if (!registry) continue;
            const key = [...registry.keys()].find((k) => k.endsWith(SUFFIX));
            if (!key) continue;
            const current = registry.get(key);
            if (wrapped.get(wc)?.wrapper === current) continue;
            // A new host is built before the previous one is disposed. Unwrap
            // our predecessor so hot reload cannot stack wrappers.
            const original = current.__cuimodFilePaneOriginal || current;
            const wrapper = wrapHandler(original, onRescue);
            registry.set(key, wrapper);
            wrapped.set(wc, { registry, key, original, wrapper });
        }
        for (const [wc] of wrapped) if (wc.isDestroyed()) wrapped.delete(wc);
        if (status.attached !== wrapped.size) {
            status.attached = wrapped.size;
            save();
        }
    }
    attach();
    ctx.every(1000, attach);
    ctx.onDispose(() => {
        for (const { registry, key, original, wrapper } of wrapped.values())
            if (registry.get(key) === wrapper) registry.set(key, original);
        wrapped.clear();
    });
};

module.exports.wrapHandler = wrapHandler;
