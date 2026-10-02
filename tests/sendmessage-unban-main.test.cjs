'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PLUGIN = path.resolve(__dirname, '..', 'src', 'plugins', 'sendmessage-unban', 'main.js');
const STATE = Symbol.for('cuimod.sendmessage-unban');

function denial() {
    return async input => input?.tool_name === 'SendMessage'
        ? { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'cli_native_send_message' } }
        : { passed: true };
}

function query(callback) {
    return {
        hooks: { PreToolUse: [{ matcher: '^SendMessage$', hooks: [callback] }] },
        hookCallbacks: new Map([['hook_0', callback]]),
    };
}

function context(dir, generation) {
    const timers = [];
    const disposers = [];
    return {
        boot: { MOD_DIR: dir, generation },
        method() {},
        every(_ms, fn) { timers.push(fn); },
        onDispose(fn) { disposers.push(fn); },
        log() {},
        tick() { for (const fn of timers) fn(); },
        dispose() { for (let i = disposers.length - 1; i >= 0; i--) disposers[i](); },
    };
}

test('hot-unbans existing and future Query hooks without a reload gap', async () => {
    delete globalThis[STATE];
    delete require.cache[PLUGIN];

    const firstDeny = denial();
    const existing = query(firstDeny);
    class PermissionBroker {
        createBaseHooks() {
            const callback = denial();
            return { PreToolUse: [{ matcher: '^SendMessage$', hooks: [callback] }] };
        }
    }
    const broker = new PermissionBroker();
    const manager = {
        sessions: new Map([['local_existing', { query: existing }]]),
        permissionBroker: broker,
    };
    const fixture = path.resolve(__dirname, '.sendmessage-manager-fixture.cjs');
    require.cache[fixture] = { id: fixture, filename: fixture, loaded: true,
        exports: { claudeCodeSessionManager: manager } };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-sendmessage-'));
    const factory = require(PLUGIN);
    const first = context(dir, 1);
    const second = context(dir, 2);

    try {
        factory(first);
        const existingHook = existing.hookCallbacks.get('hook_0');
        assert.notEqual(existingHook, firstDeny);
        assert.deepEqual(await existingHook({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage' }), {});
        assert.deepEqual(await existingHook({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), { passed: true });

        const futureHooks = broker.createBaseHooks();
        const futureHook = futureHooks.PreToolUse[0].hooks[0];
        assert.deepEqual(await futureHook({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage' }), {});
        const future = query(futureHook);
        manager.sessions.set('local_future', { query: future });
        first.tick();

        // New host generation claims the stable wrappers before the old one
        // disposes, so the handoff has no interval where the deny returns.
        factory(second);
        first.dispose();
        assert.deepEqual(await existing.hookCallbacks.get('hook_0')({
            hook_event_name: 'PreToolUse', tool_name: 'SendMessage',
        }), {});
        assert.deepEqual(await future.hookCallbacks.get('hook_0')({
            hook_event_name: 'PreToolUse', tool_name: 'SendMessage',
        }), {});

        second.dispose();
        assert.equal(existing.hookCallbacks.get('hook_0'), firstDeny);
        assert.equal(future.hookCallbacks.get('hook_0'), futureHook[Symbol.for('cuimod.sendmessage-unban.original')]);
        assert.equal(PermissionBroker.prototype.createBaseHooks.name, 'createBaseHooks');
        assert.equal(globalThis[STATE], undefined);
    } finally {
        try { second.dispose(); } catch (_) {}
        try { first.dispose(); } catch (_) {}
        delete require.cache[fixture];
        delete require.cache[PLUGIN];
        delete globalThis[STATE];
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
