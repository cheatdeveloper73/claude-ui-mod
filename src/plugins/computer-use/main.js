/* claude-ui-mod :: computer-use (main)
 *
 * Controls the native Windows Computer Use (chicago) backend.
 * Persists preferences into claude_desktop_config.json and hooks the Electron
 * main process AppPreferences handler so changes apply live without restarting.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function getConfigPath() {
    return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json'
    );
}

function readConfig(cfgPath) {
    try {
        if (!fs.existsSync(cfgPath)) return {};
        const text = fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '');
        return JSON.parse(text);
    } catch (_) {
        return {};
    }
}

function writeConfig(cfgPath, cfg) {
    const tmp = cfgPath + '.cuimod.tmp';
    try {
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
        fs.renameSync(tmp, cfgPath);
        return true;
    } catch (_) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (__) {}
        return false;
    }
}

module.exports = function (ctx) {
    const cfgPath = getConfigPath();

    async function applyToMainProcess(key, value) {
        const ipcMain = ctx.electron && ctx.electron.ipcMain;
        if (!ipcMain || !ipcMain._invokeHandlers) return false;
        let invoked = false;
        for (const [channel, handler] of ipcMain._invokeHandlers.entries()) {
            if (channel.includes('_claude.settings_$_AppPreferences_$_setPreference')) {
                try {
                    await handler({ senderFrame: { url: 'https://claude.ai', parent: null } }, key, value);
                    invoked = true;
                } catch (e) {
                    ctx.log('AppPreferences setPreference failed: ' + (e && e.message));
                }
                break;
            }
        }
        return invoked;
    }

    async function sync(params) {
        const enabled = Boolean(params && params.enabled);
        const preferredMode = (params && params.preferredMode) || 'background';
        const autoUnhide = params ? params.autoUnhide !== false : true;

        // 1. Hot update in memory via the app's internal AppPreferences handler
        await applyToMainProcess('chicagoEnabled', enabled);
        await applyToMainProcess('chicagoPreferredMode', preferredMode);
        await applyToMainProcess('chicagoAutoUnhide', autoUnhide);

        // 2. Persist to disk as durable backstop
        const cfg = readConfig(cfgPath);
        cfg.preferences = cfg.preferences || {};
        cfg.preferences.chicagoEnabled = enabled;
        cfg.preferences.chicagoPreferredMode = preferredMode;
        cfg.preferences.chicagoAutoUnhide = autoUnhide;
        writeConfig(cfgPath, cfg);

        ctx.log('computer-use state synced: enabled=' + enabled + ' mode=' + preferredMode);
        return { ok: true, enabled, preferredMode, autoUnhide };
    }

    ctx.method('computer-use.sync', sync);

    ctx.method('computer-use.status', () => {
        const cfg = readConfig(cfgPath);
        const prefs = cfg.preferences || {};
        return {
            enabled: Boolean(prefs.chicagoEnabled),
            preferredMode: prefs.chicagoPreferredMode || 'background',
            autoUnhide: prefs.chicagoAutoUnhide !== false,
        };
    });

    // Auto-apply on host load if enabled in config
    const current = readConfig(cfgPath);
    if (current.preferences && current.preferences.chicagoEnabled) {
        sync({
            enabled: true,
            preferredMode: current.preferences.chicagoPreferredMode || 'background',
            autoUnhide: current.preferences.chicagoAutoUnhide !== false,
        }).catch(() => {});
    }
};
