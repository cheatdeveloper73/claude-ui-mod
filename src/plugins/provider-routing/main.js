'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// Desktop explicitly supplies api.anthropic.com in the child environment, which
// overrides settings.json. Patch the actual spawn boundary, preserving all of
// Desktop's other environment and argument values.
module.exports = function (ctx) {
    const entry = path.resolve(ctx.dir || __dirname, '..', '..', '..', 'router', 'supervisor.mjs');
    let pending = null;
    let stopped = false;
    const currentSpawn = childProcess.spawn;
    const originalSpawn = currentSpawn.__cuimodRoutingOriginal || currentSpawn;
    // In Electron, process.execPath is claude.exe, not Node.  Setting
    // ELECTRON_RUN_AS_NODE is not dependable on fused production builds and
    // can recursively launch Desktop instead of the bridge.  This project is
    // installed by Node, so resolve it through PATH unless explicitly pinned.
    const node = process.env.CLAUDE_UI_MOD_NODE || 'node.exe';

    // The policy is carried as a launch-time session setting, never by writing
    // ~/.claude.json. The CLI rewrites that file wholesale, while a per-session
    // setting can later be changed through the worker's own control channel.
    const settingsFile = path.resolve(ctx.dir || __dirname, '..', '..', '..', '.state', 'settings.json');
    const MIN_WINDOW = 100000;
    const MAX_WINDOW = 1000000;

    // Desired policy is read at the only point it can become a child-process
    // setting. It is intentionally separate from the state a running child
    // reports later: saving 400k changes the next worker, never retroactively
    // rewrites one that is already doing work.
    function autoCompactPolicy() {
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, ''))['auto-compact']; }
        catch (_) { saved = null; }
        const window = value => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return null;
            return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(n)));
        };
        const perModel = {};
        if (saved?.perModel && typeof saved.perModel === 'object' && !Array.isArray(saved.perModel)) {
            for (const [id, value] of Object.entries(saved.perModel)) {
                const valueWindow = window(value);
                if (valueWindow !== null) perModel[bare(id)] = valueWindow;
            }
        }
        const sessions = {};
        if (saved?.sessionOverrides && typeof saved.sessionOverrides === 'object' && !Array.isArray(saved.sessionOverrides)) {
            for (const [id, value] of Object.entries(saved.sessionOverrides)) {
                if (!/^[0-9a-f-]{8,64}$/i.test(id) || !value || typeof value !== 'object') continue;
                sessions[id.toLowerCase()] = {
                    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
                    ...(Object.hasOwn(value, 'window') ? { window: window(value.window) } : {}),
                };
            }
        }
        return {
            // Default-off is deliberate. A session receives an explicit true only
            // when its global or per-session policy opts in.
            enabled: saved?.enabled === true,
            defaultWindow: window(saved?.defaultWindow),
            perModel,
            sessions,
            precompute: ['default', 'on', 'off'].includes(saved?.precompute) ? saved.precompute : 'default',
        };
    }

    function bare(model) {
        return String(model || '').trim().toLowerCase()
            .replace(/\[[^\]]*\]$/, '')
            .replace(/:(low|medium|high|xhigh|max)$/, '')
            .replace(/^claude-/, '');
    }

    function optionValue(args, name) {
        for (let i = 0; i < args.length; i++) {
            const value = String(args[i]);
            if (value === name) return args[i + 1] == null ? null : String(args[i + 1]);
            if (value.startsWith(name + '=')) return value.slice(name.length + 1);
        }
        return null;
    }

    function replaceOption(args, name, value) {
        const out = [];
        for (let i = 0; i < args.length; i++) {
            const arg = String(args[i]);
            if (arg === name) { i++; continue; }
            if (arg.startsWith(name + '=')) continue;
            out.push(args[i]);
        }
        out.push(name, value);
        return out;
    }

    // Desktop supplies an inline --settings blob. Preserve its unrelated
    // session flags and place CUIMOD's enable/precompute policy in that same
    // highest-priority launch source. A non-JSON setting source is left intact:
    // window and off state still have their dedicated flag/environment controls.
    function mergeLaunchSettings(args, patch) {
        const out = args.slice();
        for (let i = 0; i < out.length; i++) {
            const arg = String(out[i]);
            const inline = arg === '--settings' ? out[i + 1]
                : arg.startsWith('--settings=') ? arg.slice('--settings='.length) : null;
            if (typeof inline !== 'string') continue;
            let parsed;
            try { parsed = JSON.parse(inline); }
            catch (_) { continue; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            const merged = JSON.stringify({ ...parsed, ...patch });
            if (arg === '--settings') out[i + 1] = merged;
            else out[i] = '--settings=' + merged;
            return out;
        }
        out.push('--settings', JSON.stringify(patch));
        return out;
    }

    function routedSpawn(file, args, options) {
        if (Array.isArray(args) && /[\\/]claude-code[\\/]/i.test(String(file))) {
            // The provider bridge is the owned transport for every spawned
            // Claude Code session. Startup begins at host load; this call
            // preserves the routing contract while the bridge becomes ready.
            if (ctx.electron.app?.isReady) ensure();

            const policy = autoCompactPolicy();
            const model = bare(optionValue(args, '--model'));
            const sessionId = (optionValue(args, '--resume') || optionValue(args, '--session-id') || '').toLowerCase();
            const session = policy.sessions[sessionId] || null;
            const requestedWindow = session && Object.hasOwn(session, 'window')
                ? session.window : policy.perModel[model] ?? policy.defaultWindow;
            const enabled = session?.enabled ?? policy.enabled;
            // This is the worker's own launch-time setting, above bootstrap
            // clientdata. `auto` is deliberate: rows without a window retain
            // Claude Code's resolver instead of receiving an invented number.
            args = replaceOption(args, '--autocompact', requestedWindow ? String(requestedWindow) : 'auto');

            // Use the session setting for default-off. DISABLE_AUTO_COMPACT would
            // make a live opt-in impossible because its environment gate wins
            // before the worker can consult autoCompactEnabled.
            const launchSettings = { autoCompactEnabled: enabled };
            if (policy.precompute === 'on') launchSettings.precomputeCompactionEnabled = true;
            if (policy.precompute === 'off') launchSettings.precomputeCompactionEnabled = false;
            args = mergeLaunchSettings(args, launchSettings);

            const env = { ...(options?.env || process.env),
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789',
                CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
                _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
            };
            // These alter the worker after its launch settings have been parsed.
            // Remove inherited overrides so the child cannot silently outrank the
            // policy it was spawned with.
            delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
            delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
            // Both environment gates bypass the worker's session setting. They
            // must be absent so a displayed session can opt in or out live.
            delete env.DISABLE_AUTO_COMPACT;
            delete env.DISABLE_COMPACT;
            options = { ...options, env };
        }
        return originalSpawn.call(this, file, args, options);
    }
    routedSpawn.__cuimodRoutingOriginal = originalSpawn;
    childProcess.spawn = routedSpawn;
    // A slow answer is not a dead router. The worker's event loop has been
    // measured blocked past a second under a subagent storm, and the old
    // 1.2 s probe read that as "down" and spawned a second supervisor 19 times
    // in one afternoon; each one booted a full worker, loaded ~28 MB of
    // ledgers, and died on EADDRINUSE at the worst possible moment. Five
    // seconds, and two misses in a row, before anything gets spawned.
    function probe() {
        return new Promise(resolve => {
            const req = http.get('http://127.0.0.1:8789/healthz', res => { res.resume(); resolve(res.statusCode === 200 || res.headers?.['x-cuimod-router-supervisor'] === '1'); });
            req.setTimeout(5000, () => req.destroy());
            req.on('error', () => resolve(false));
        });
    }
    function ensure() {
        if (pending) return pending;
        pending = (async () => {
            if (await probe()) return true;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (await probe()) return true;
            if (stopped || !fs.existsSync(entry)) return false;
            const child = originalSpawn(node, [entry], {
                windowsHide: true, detached: true, stdio: 'ignore',
                env: { ...process.env },
            });
            child.on('error', err => ctx.log('router start: ' + err.message));
            child.unref();
            for (let attempt = 0; attempt < 25 && !stopped; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                if (await probe()) return true;
            }
            if (!stopped) ctx.log('router did not become healthy; will retry startup in 10 seconds');
            return false;
        })().finally(() => { pending = null; });
        return pending;
    }
    // Don't launch a daemon from selfcheck's fake Electron host.
    if (ctx.electron.app?.isReady) ensure();
    ctx.every(10000, () => { if (ctx.electron.app?.isReady) ensure(); });
    ctx.method('status', async () => ({ bridge: 'http://127.0.0.1:8789', entry, ready: await probe() }));
    ctx.onDispose(() => {
        stopped = true;
        // The loader constructs the next host before disposing this one. Never
        // overwrite the new host's wrapper while cleaning up the old instance.
        if (childProcess.spawn === routedSpawn) childProcess.spawn = originalSpawn;
    });
};
