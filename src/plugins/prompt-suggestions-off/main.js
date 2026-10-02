/* claude-ui-mod :: prompt suggestion kill switch (main)
 *
 * Claude Code generates the composer ghost text with a separate full-context
 * model request. Disable it at the worker's environment boundary, then patch
 * already-running Query instances through their native settings control.
 */
'use strict';

const ENV_KEY = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION';
const STATE_KEY = Symbol.for('cuimod.prompt-suggestions-off');

module.exports = function (ctx) {
    const ownerToken = {};
    const state = globalThis[STATE_KEY] || {
        owner: null,
        manager: null,
        queries: new WeakSet(),
        pending: new WeakMap(),
        disabledQueries: 0,
        lastError: null,
        originalEnvPresent: Object.hasOwn(process.env, ENV_KEY),
        originalEnvValue: process.env[ENV_KEY],
    };
    globalThis[STATE_KEY] = state;
    state.owner = ownerToken;

    // This is the CLI's earliest kill switch. Every future Desktop worker
    // inherits it before Query initialization, so no suggestion request can win
    // a race with the live-session patch below.
    process.env[ENV_KEY] = 'false';

    function sessionManager() {
        if (state.manager?.sessions && typeof state.manager.sessions.values === 'function') return state.manager;
        state.manager = null;
        for (const key of Object.keys(require.cache)) {
            let exports;
            try { exports = require.cache[key]?.exports; } catch (_) { continue; }
            const candidate = exports?.claudeCodeSessionManager;
            if (candidate?.sessions && typeof candidate.sessions.values === 'function') {
                state.manager = candidate;
                break;
            }
        }
        return state.manager;
    }

    function disableQuery(query) {
        if (!query || typeof query.applyFlagSettings !== 'function' || state.queries.has(query)) return null;
        if (state.pending.has(query)) return state.pending.get(query);
        const pending = Promise.resolve()
            .then(() => query.applyFlagSettings({ promptSuggestionEnabled: false }))
            .then(() => {
                state.queries.add(query);
                state.disabledQueries++;
                state.lastError = null;
            }, error => {
                state.lastError = String(error?.message || error);
                ctx.log('live worker patch failed: ' + state.lastError);
            })
            .finally(() => state.pending.delete(query));
        state.pending.set(query, pending);
        return pending;
    }

    function snapshot(manager) {
        let liveQueries = 0;
        if (manager) for (const session of manager.sessions.values()) if (session?.query) liveQueries++;
        return {
            generation: ctx.boot.generation,
            rootDisabled: process.env[ENV_KEY] === 'false',
            manager: !!manager,
            liveQueries,
            disabledQueries: state.disabledQueries,
            lastError: state.lastError,
        };
    }

    async function enforce() {
        const manager = sessionManager();
        const pending = [];
        if (manager) for (const session of manager.sessions.values()) {
            const task = disableQuery(session?.query);
            if (task) pending.push(task);
        }
        if (pending.length) await Promise.all(pending);
        return snapshot(manager);
    }

    ctx.method('status', enforce);
    enforce();
    ctx.every(500, enforce);

    ctx.onDispose(() => {
        // The replacement host claims the shared state before this generation is
        // disposed. Keep the root switch continuous across that handoff.
        if (state.owner !== ownerToken) return;
        if (state.originalEnvPresent) process.env[ENV_KEY] = state.originalEnvValue;
        else delete process.env[ENV_KEY];
        state.manager = null;
        state.queries = new WeakSet();
        state.pending = new WeakMap();
        delete globalThis[STATE_KEY];
    });
};
