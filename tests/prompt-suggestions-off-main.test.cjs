'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const PLUGIN = path.resolve(__dirname, '..', 'src', 'plugins', 'prompt-suggestions-off', 'main.js');
const STATE = Symbol.for('cuimod.prompt-suggestions-off');
const ENV_KEY = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION';

function context(generation) {
    const timers = [];
    const disposers = [];
    const methods = new Map();
    return {
        boot: { generation },
        method(name, fn) { methods.set(name, fn); },
        every(_ms, fn) { timers.push(fn); },
        onDispose(fn) { disposers.push(fn); },
        log() {},
        async tick() { await Promise.all(timers.map(fn => fn())); },
        call(name) { return methods.get(name)(); },
        dispose() { for (let i = disposers.length - 1; i >= 0; i--) disposers[i](); },
    };
}

function query() {
    const patches = [];
    return {
        patches,
        async applyFlagSettings(patch) { patches.push(patch); },
    };
}

test('disables suggestion generation before spawn and in every live Query', async () => {
    const originalPresent = Object.hasOwn(process.env, ENV_KEY);
    const originalValue = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'true';
    delete globalThis[STATE];
    delete require.cache[PLUGIN];

    const existing = query();
    const manager = { sessions: new Map([['local_existing', { query: existing }]]) };
    const fixture = path.resolve(__dirname, '.prompt-suggestions-manager-fixture.cjs');
    require.cache[fixture] = { id: fixture, filename: fixture, loaded: true,
        exports: { claudeCodeSessionManager: manager } };

    const factory = require(PLUGIN);
    const first = context(1);
    const second = context(2);

    try {
        factory(first);
        assert.equal(process.env[ENV_KEY], 'false');
        let status = await first.call('status');
        assert.deepEqual(existing.patches, [{ promptSuggestionEnabled: false }]);
        assert.equal(status.rootDisabled, true);
        assert.equal(status.liveQueries, 1);
        assert.equal(status.disabledQueries, 1);

        const future = query();
        manager.sessions.set('local_future', { query: future });
        await first.tick();
        assert.deepEqual(future.patches, [{ promptSuggestionEnabled: false }]);
        await first.tick();
        assert.equal(future.patches.length, 1);

        // A replacement host claims the root switch before the previous one is
        // disposed, so hot reload cannot briefly re-enable worker launches.
        factory(second);
        first.dispose();
        assert.equal(process.env[ENV_KEY], 'false');
        status = await second.call('status');
        assert.equal(status.liveQueries, 2);
        assert.equal(existing.patches.length, 1);
        assert.equal(future.patches.length, 1);

        second.dispose();
        assert.equal(process.env[ENV_KEY], 'true');
        assert.equal(globalThis[STATE], undefined);
    } finally {
        try { second.dispose(); } catch (_) {}
        try { first.dispose(); } catch (_) {}
        delete require.cache[fixture];
        delete require.cache[PLUGIN];
        delete globalThis[STATE];
        if (originalPresent) process.env[ENV_KEY] = originalValue;
        else delete process.env[ENV_KEY];
    }
});
