/* claude-ui-mod :: gpu-accel-guard (main)
 *
 * Keeps hardware acceleration on through GPU resets.
 *
 * The RTX 3060 on this PC is reset often and on purpose, and it is the only
 * GPU. Two mechanisms turn a burst of resets into a window drawn on the CPU
 * (ANGLE on WARP), which on a 240 Hz display costs over a core and stalls the
 * UI for seconds:
 *
 *   Chromium  GpuProcessHost::RecordProcessCrash falls back to the next GPU
 *             mode after a few recent crashes, for the rest of the session.
 *             It reads --disable-gpu-process-crash-limit from the live
 *             command line at crash time, so appending it after ready works.
 *
 *   Desktop   [gpu-recovery] (2.9939.4) counts GPU child-process-gone events
 *             and, at 3 inside 5 minutes, writes isHardwareAccelerationDisabled
 *             and isHardwareAccelerationAutoDisabled into
 *             claude_desktop_config.json, shows a "Graphics problems detected"
 *             dialog, and leaves a gpu-crash-streak marker that does the same
 *             at the next launch. Every launch after that applies --disable-gpu
 *             before any plugin loads. Its handler skips an event whose reason
 *             is 'clean-exit', and only that guard is stable across builds:
 *             the handler and the counter are minified locals. A listener
 *             prepended ahead of it relabels a GPU death as a clean exit; the
 *             original reason stays on `cuimodGpuReason`. The same event
 *             object reaches Sentry's listeners, so GPU crashes stop being
 *             reported too.
 *
 * A flag an earlier auto-disable already persisted is undone through the app's
 * own saveHardwareAccelerationSetting, so the in-memory config, the Help menu
 * checkbox and the file agree. The namespace is found by shape in require.cache
 * because its export letter changes per build. A manual "Disable Hardware
 * Acceleration" (no auto flag) is left alone. Undoing a persisted flag needs
 * one restart: this launch already started without the GPU.
 *
 * Evidence: .state/gpu-accel-guard.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CRASH_LIMIT = 'disable-gpu-process-crash-limit';
const KEEP_DEATHS = 50;

function findConfigApi() {
    for (const mod of Object.values(require.cache)) {
        const ex = mod && mod.exports;
        if (!ex || typeof ex !== 'object' || !/app\.asar/.test(String(mod.id))) continue;
        for (const key of Object.keys(ex)) {
            try {
                const v = ex[key];
                if (v && typeof v === 'object'
                    && typeof v.saveHardwareAccelerationSetting === 'function'
                    && typeof v.appConfig === 'function') return v;
            } catch (_) { /* uninitialised binding */ }
        }
    }
    return null;
}

module.exports = function (ctx) {
    if (!process.versions.electron) return;
    const { app } = ctx.electron;
    const file = path.join(ctx.boot.MOD_DIR, '.state', 'gpu-accel-guard.json');

    let status = {};
    try { status = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    if (!Array.isArray(status.deaths)) status.deaths = [];
    const save = () => {
        try { fs.writeFileSync(file, JSON.stringify(status, null, 2)); } catch (e) { ctx.log('status write failed: ' + e.message); }
    };

    const appended = !app.commandLine.hasSwitch(CRASH_LIMIT);
    if (appended) app.commandLine.appendSwitch(CRASH_LIMIT);
    ctx.onDispose(() => { if (appended) app.commandLine.removeSwitch(CRASH_LIMIT); });

    const onGone = (_event, details) => {
        if (!details || details.type !== 'GPU' || details.reason === 'clean-exit') return;
        details.cuimodGpuReason = details.reason;
        details.reason = 'clean-exit';
        status.deaths.push({ at: new Date().toISOString(), reason: details.cuimodGpuReason, exitCode: details.exitCode });
        if (status.deaths.length > KEEP_DEATHS) status.deaths.splice(0, status.deaths.length - KEEP_DEATHS);
        save();
    };
    app.prependListener('child-process-gone', onGone);
    ctx.onDispose(() => app.removeListener('child-process-gone', onGone));

    status.loadedAt = new Date().toISOString();
    status.generation = ctx.boot.generation;
    status.crashLimitSwitch = app.commandLine.hasSwitch(CRASH_LIMIT);
    status.acceleratedThisLaunch = app.isHardwareAccelerationEnabled();

    const api = findConfigApi();
    if (!api) {
        status.repair = 'config-api-not-found';
        ctx.log('config namespace not found; a persisted auto-disable cannot be undone');
        save();
        return;
    }
    const cfg = api.appConfig();
    if (cfg.isHardwareAccelerationAutoDisabled !== true) {
        status.repair = cfg.isHardwareAccelerationDisabled === true ? 'manual-disable-left-alone' : 'not-needed';
        save();
        return;
    }
    Promise.resolve(api.saveHardwareAccelerationSetting(false)).then((result) => {
        status.repair = 'auto-disable-undone:' + result;
        status.repairedAt = new Date().toISOString();
        save();
    }, (e) => {
        status.repair = 'failed:' + ((e && e.message) || e);
        save();
    });
};
