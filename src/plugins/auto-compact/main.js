/* claude-ui-mod :: auto-compact (main)
 *
 * Supplies the policy editor with the same configured-provider catalogue the
 * picker reads. It deliberately does not manufacture a session status: only
 * LocalSessions.getContextUsage can answer what a live worker resolved.
 */
'use strict';
const fs = require('fs');
const path = require('path');

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
    { id: 'claude-opus-5', name: 'Opus 5', provider: 'claude' },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', provider: 'claude' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', provider: 'claude' },
    { id: 'claude-haiku-4-5', name: 'Haiku 4.5', provider: 'claude' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', provider: 'claude' },
];

function catalogue(dir) {
    const rows = [];
    const seen = new Set();
    const labels = { ...PROVIDER_LABELS };
    const add = value => {
        const id = String(value?.id || '').trim().toLowerCase();
        if (!id || seen.has(id)) return;
        seen.add(id);
        const provider = String(value?.provider || 'other');
        if (value?.providerLabel) labels[provider] = String(value.providerLabel);
        rows.push({ id, name: String(value?.name || id), provider });
    };

    const picker = path.resolve(dir, '..', 'provider-picker');
    for (const name of ['catalogue.json', 'catalogue.private.json']) {
        try {
            const values = JSON.parse(fs.readFileSync(path.join(picker, name), 'utf8').replace(/^﻿/, ''));
            if (Array.isArray(values)) for (const value of values) add(value);
        } catch (_) { /* private catalogue is optional; malformed data stays absent */ }
    }
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

function windowValue(value) {
    if (value == null || value === 0) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < MIN_WINDOW || n > MAX_WINDOW) return undefined;
    return Math.round(n);
}

module.exports = function (ctx) {
    let manager = null;
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

    ctx.method('models', () => catalogue(ctx.dir));

    // Desktop's public applyFlagSettings handler filters autoCompactWindow from
    // renderer calls. The session Query already owns the worker control channel,
    // and accepts the full flag-settings schema. Calling it here changes only the
    // explicitly named worker; nothing is broadcast or written to Claude Code's
    // global configuration file.
    ctx.method('apply', async p => {
        const sessionId = typeof p?.sessionId === 'string' && DESKTOP_SESSION_RE.test(p.sessionId)
            ? p.sessionId : null;
        if (!sessionId) throw new Error('desktop session id required');
        if (typeof p?.enabled !== 'boolean') throw new Error('enabled required');
        const window = windowValue(p.window);
        if (window === undefined) throw new Error('window must be auto or 100k–1M');

        const owner = sessionManager();
        const session = owner?.sessions.get(sessionId);
        if (!session?.query || typeof session.query.applyFlagSettings !== 'function')
            return { applied: false, reason: 'worker-unavailable', cliSessionId: session?.cliSessionId || null };

        const patch = { autoCompactEnabled: p.enabled, autoCompactWindow: window };
        // Mirror the Desktop manager's own applyFlagSettings lifecycle. Calling
        // Query alone reaches the child, but leaves sessionSettings stale; a
        // later focus/reconcile can then replay the old launch values over the
        // new worker choice. Persist the exact patch first and roll it back if
        // the child rejects it.
        const before = session.sessionSettings;
        session.sessionSettings = { ...(before || {}), ...patch };
        try {
            owner.saveSession?.(session);
            owner.emitSessionUpdated?.(session);
            await session.query.applyFlagSettings(patch);
        } catch (error) {
            session.sessionSettings = before;
            try { owner.saveSession?.(session); owner.emitSessionUpdated?.(session); } catch (_) {}
            throw error;
        }
        return { applied: true, cliSessionId: session.cliSessionId || null };
    });
};
