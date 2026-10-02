/* claude-ui-mod :: auto-compact (main)
 *
 * Supplies the policy editor with the same configured-provider catalogue the
 * picker reads. It deliberately does not manufacture a session status: only
 * LocalSessions.getContextUsage can answer what a live worker resolved.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createContextPolicy, isRegisteredModel, serializeContext, applySessionSettings } = require('../provider-routing/main');

const PROVIDER_LABELS = {
    openai: 'OpenAI',
    meta: 'Meta',
    nanogpt: 'NanoGPT',
    claude: 'Claude',
};

// These are Desktop's native rows rather than a provider route. The picker
// receives its live native catalogue from the page; the policy table keeps the
// same stable ids beside the routed catalogue until that page-level list is
// exposed as a supported plugin RPC.
const NATIVE_MODELS = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', provider: 'claude' },
    { id: 'claude-opus-5', name: 'Opus 5', provider: 'claude' },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', provider: 'claude' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', provider: 'claude' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', provider: 'claude' },
    { id: 'claude-haiku-4-5', name: 'Haiku 4.5', provider: 'claude' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', provider: 'claude' },
];

function catalogue(dir, dynamicModels) {
    const rows = [];
    const seen = new Set();
    const labels = { ...PROVIDER_LABELS };
    const add = value => {
        const id = String(value?.id || '').trim().toLowerCase();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const provider = String(value?.provider || 'other');
        if (value?.providerLabel) labels[provider] = String(value.providerLabel);
        rows.push({ id, name: String(value?.name || id), provider,
            ...(Number.isFinite(value?.context) ? { context: value.context } : {}),
            ...(value?.registered === true ? { registered: true } : {}) });
    };

    const picker = path.resolve(dir, '..', 'provider-picker');
    for (const name of ['catalogue.json', 'catalogue.private.json']) {
        try {
            const values = JSON.parse(fs.readFileSync(path.join(picker, name), 'utf8').replace(/^﻿/, ''));
            if (Array.isArray(values)) for (const value of values) add(value);
        } catch (_) { /* private catalogue is optional; malformed data stays absent */ }
    }
    for (const model of dynamicModels) add(model);
    for (const model of NATIVE_MODELS) add(model);
    for (const row of rows) row.providerLabel = labels[row.provider] || row.provider;

    const order = [];
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.provider)) { grouped.set(row.provider, []); order.push(row.provider); }
        grouped.get(row.provider).push(row);
    }
    return order.flatMap(provider => grouped.get(provider));
}

const DESKTOP_SESSION_RE = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_WINDOW = 100000;
const MAX_WINDOW = 1000000;
const ENV_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
// `ken()` reads both of these and short-circuits ahead of the flag layer, so
// either one left set at spawn makes `autoCompactEnabled: true` inert.
const ENV_KILL_SWITCHES = ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'];

function windowValue(value) {
    if (value == null || value === 0) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < MIN_WINDOW || n > MAX_WINDOW) return undefined;
    return Math.round(n);
}

module.exports = function (ctx) {
    let manager = null;
    const contextPolicy = createContextPolicy(ctx.boot?.MOD_DIR || path.resolve(ctx.dir, '../../..'));

    function sessionManager() {
        if (manager?.sessions && typeof manager.sessions.get === 'function') return manager;
        manager = null;
        for (const key of Object.keys(require.cache)) {
            let exports;
            try { exports = require.cache[key]?.exports; } catch (_) { continue; }
            const candidate = exports?.claudeCodeSessionManager;
            if (candidate?.sessions && typeof candidate.sessions.get === 'function') {
                manager = candidate;
                break;
            }
        }
        return manager;
    }

    ctx.method('models', () => catalogue(ctx.dir, contextPolicy.models()));

    // Desktop's public applyFlagSettings handler filters autoCompactWindow from
    // renderer calls. The session Query already owns the worker control channel.
    // Calling it here changes only the explicitly named worker; nothing is
    // broadcast or written to Claude Code's global configuration file.
    //
    // `autoCompactWindow` in this patch is launch state only. 2.1.260 lands it
    // in the inline flag layer and never reads a window back out of any
    // settings layer, so it shapes the next launch and nothing else.
    //
    // `autoCompactEnabled` does reach the running worker. `Kd()` resolves
    // enablement as `ken() ? false : wo('autoCompactEnabled', true).value`, and
    // that settings lookup sees the inline flag layer this patch writes.
    // Measured on one PID launched off: false → true → false → true.
    //
    // `env` is what carries the window to a running worker. `Cb()` — the single
    // resolver behind both the reported window and the compaction gate's own
    // threshold arithmetic (`tF` = `Cb().window` minus the native reserve) — tests
    // `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` first and returns before it
    // consults appState. The settings-change handler `dst()` applies a patch's
    // env into Bun's own `process.env` on the way through, so the next
    // resolution reads the new number. Measured on a disposable 2.1.260 worker:
    // one PID reported 400000 (source "settings"), then 1000000, then 400000,
    // both overrides at source "env". docs/internals.md carries the eliminated
    // levers that led here.
    ctx.method('apply', async p => {
        const sessionId = typeof p?.sessionId === 'string' && DESKTOP_SESSION_RE.test(p.sessionId)
            ? p.sessionId : null;
        if (!sessionId) throw new Error('desktop session id required');
        if (typeof p?.enabled !== 'boolean') throw new Error('enabled required');
        const requestedWindow = windowValue(p.window);
        if (requestedWindow === undefined) throw new Error('window must be auto or 100k–1M');

        const owner = sessionManager();
        const session = owner?.sessions.get(sessionId);
        if (!session?.query || typeof session.query.applyFlagSettings !== 'function')
            return { applied: false, reason: 'worker-unavailable', cliSessionId: session?.cliSessionId || null };
        return serializeContext(session, async () => {
            if (owner.sessions.get(sessionId) !== session || typeof session.query?.applyFlagSettings !== 'function')
                return { applied: false, reason: 'worker-unavailable', cliSessionId: session?.cliSessionId || null };

            const before = session.sessionSettings;
            const registered = isRegisteredModel(session.model);
            const held = windowValue(Number(before?.env?.[ENV_WINDOW_KEY])) || windowValue(before?.autoCompactWindow);
            // Turning off compaction needs no catalogue observation and must
            // remain available when a selected model has just been retired.
            const resolved = registered && (p.enabled || requestedWindow !== null)
                ? contextPolicy.resolve(session.model, session.cliSessionId, requestedWindow ?? held ?? undefined) : null;
            const window = resolved ? resolved.window : requestedWindow;
            const patch = { autoCompactEnabled: p.enabled, autoCompactWindow: window };
            if (window !== null || p.enabled) {
                // The control handler shallow-merges top-level keys, so an env
                // map carrying only our key would drop every other env entry
                // the session holds. Merge over what it already has.
                const held = before?.env;
                patch.env = { ...(held && typeof held === 'object' && !Array.isArray(held) ? held : {}) };
                if (window !== null) patch.env[ENV_WINDOW_KEY] = String(window);
                if (resolved) {
                    patch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(resolved.providerWindow);
                    patch.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '';
                }
                // Turning it on clears the kill switches; turning it off never
                // sets one. `DISABLE_COMPACT` also gates the manual /compact
                // command, and switching auto-compact off is not a request to
                // take manual compaction away. The flag layer is what carries
                // the off state, and it is enough on its own — measured.
                if (p.enabled) for (const key of ENV_KILL_SWITCHES) patch.env[key] = '';
            }

            // Mirror the Desktop manager's own applyFlagSettings lifecycle. Calling
            // Query alone reaches the child, but leaves sessionSettings stale; a
            // later focus/reconcile can then replay the old launch values over the
            // new worker choice. Persist the exact patch first and roll it back if
            // the child rejects it.
            await applySessionSettings(owner, session, patch);
            return { applied: true, windowSent: window !== null, window, cliSessionId: session.cliSessionId || null };
        });
    });
};
