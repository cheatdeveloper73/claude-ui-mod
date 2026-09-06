'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const desktopId = 'local_11111111-2222-3333-4444-555555555555';

test('the session control reaches only the named worker query', async () => {
    const calls = [];
    const persisted = [];
    const session = { cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sessionSettings: { ultracode: true }, query: {
        async applyFlagSettings(settings) { calls.push(settings); },
    } };
    const manager = { sessions: new Map([[desktopId, session]]),
        saveSession: value => persisted.push(['save', value.sessionSettings]),
        emitSessionUpdated: value => persisted.push(['emit', value.sessionSettings]),
    };
    const key = path.join(os.tmpdir(), 'cuimod-auto-compact-manager-fixture.cjs');
    require.cache[key] = { exports: { claudeCodeSessionManager: manager } };
    delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    const factory = require('../src/plugins/auto-compact/main');
    const methods = {};
    try {
        factory({ dir: path.join(__dirname, '../src/plugins/auto-compact'), method: (name, fn) => { methods[name] = fn; } });
        const enabled = await methods.apply({ sessionId: desktopId, enabled: true, window: 400000 });
        assert.deepEqual(enabled, { applied: true, cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
        assert.deepEqual(calls, [{ autoCompactEnabled: true, autoCompactWindow: 400000 }]);
        assert.deepEqual(session.sessionSettings, { ultracode: true, autoCompactEnabled: true, autoCompactWindow: 400000 });
        assert.deepEqual(persisted.slice(0, 2).map(row => row[0]), ['save', 'emit']);

        await methods.apply({ sessionId: desktopId, enabled: false, window: null });
        assert.deepEqual(calls.at(-1), { autoCompactEnabled: false, autoCompactWindow: null });
        assert.deepEqual(session.sessionSettings, { ultracode: true, autoCompactEnabled: false, autoCompactWindow: null });
        await assert.rejects(() => methods.apply({ sessionId: 'not-a-session', enabled: true, window: 400000 }), /desktop session id/);
        await assert.rejects(() => methods.apply({ sessionId: desktopId, enabled: true, window: 99999 }), /100k/);
    } finally {
        delete require.cache[key];
        delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    }
});

test('an absent worker is never started or replaced by the session control', async () => {
    const manager = { sessions: new Map([[desktopId, { cliSessionId: 'known-cli-id' }]]) };
    const key = path.join(os.tmpdir(), 'cuimod-auto-compact-manager-unavailable.cjs');
    require.cache[key] = { exports: { claudeCodeSessionManager: manager } };
    delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    const factory = require('../src/plugins/auto-compact/main');
    const methods = {};
    try {
        factory({ dir: path.join(__dirname, '../src/plugins/auto-compact'), method: (name, fn) => { methods[name] = fn; } });
        assert.deepEqual(await methods.apply({ sessionId: desktopId, enabled: true, window: null }), {
            applied: false, reason: 'worker-unavailable', cliSessionId: 'known-cli-id',
        });
    } finally {
        delete require.cache[key];
        delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    }
});
