/* Offline test for the staged native-hooks helper. No SDK, app, network,
 * model or agent. Run: node tests/campaigns-native-hooks.test.cjs
 */
'use strict';
const assert = require('assert');
const { addHooks, serversOf, installQuery, eventName, toolUseIdOf, agentIdOf, DEFAULT_EVENTS } =
    require('../src/plugins/campaigns/native-hooks');

const test = require('node:test');

// Fake Query modelling the CLI contract, recording calls so the test can
// assert ordering, server preservation and restore.
function fakeQuery({ hooks = {}, initHooksPayload = undefined, applied = true, idle = true, failReinit = false } = {}) {
    const calls = [];
    const q = {
        hooks,
        initHooksPayload,
        calls,
        async setMcpServers(servers) { calls.push({ op: 'setMcpServers', servers }); return {}; },
        async reinitialize() { calls.push({ op: 'reinitialize' }); if (failReinit) throw new Error('control stream closed'); return { hooks_applied: applied }; },
    };
    return { q, calls, isIdle: () => idle };
}

const preFn = () => ({});
const startFn = () => ({});

(async () => {
    await test('addHooks shapes a function into a matcher and prepends', () => {
        const opts = addHooks({}, { PreToolUse: [{ matcher: 'Read', hooks: [preFn] }] });
        assert.strictEqual(opts.hooks.PreToolUse[0].matcher, 'Read');
        assert.strictEqual(opts.hooks.PreToolUse[0].hooks[0], preFn);
    });

    await test('addHooks accepts a bare function', () => {
        assert.strictEqual(addHooks({}, { SubagentStart: startFn }).hooks.SubagentStart[0].hooks[0], startFn);
    });

    await test('addHooks preserves existing events and does not mutate input', () => {
        const base = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [preFn] }] } };
        const opts = addHooks(base, { PreToolUse: [{ matcher: 'Read', hooks: [startFn] }] });
        assert.strictEqual(opts.hooks.PreToolUse.length, 2);
        assert.strictEqual(opts.hooks.PreToolUse[0].matcher, 'Write');
        assert.strictEqual(base.hooks.PreToolUse.length, 1);
    });

    await test('addHooks rejects a non-event key', () => {
        assert.throws(() => addHooks({}, { reinitialize: [preFn] }), /not a hook event/);
    });

    await test('serversOf copies session.activeMcpServers and never aliases it', () => {
        const session = { activeMcpServers: { other: { name: 'other' } } };
        const map = serversOf(session);
        assert.deepStrictEqual(map, { other: { name: 'other' } });
        assert.notStrictEqual(map, session.activeMcpServers);
        // Absent field degrades to empty, never undefined.
        assert.deepStrictEqual(serversOf({}), {});
    });

    await test('installQuery merges hooks, clears payload, reinitializes, preserves all servers', async () => {
        const { q, calls, isIdle } = fakeQuery({
            hooks: { PreToolUse: [{ matcher: 'Read', hooks: [() => {}] }] },
            initHooksPayload: { PreToolUse: [{ matcher: 'Read', hookCallbackIds: ['hook_0'] }] },
        });
        const result = await installQuery({
            query: q, isIdle,
            hooks: { SubagentStart: [{ matcher: '', hooks: [startFn] }] },
            servers: { campaign: { type: 'sdk', name: 'campaign', instance: {} }, other: { type: 'sdk', name: 'other', instance: {} } },
        });
        assert.strictEqual(result.ok, true, JSON.stringify(result));
        assert.strictEqual(q.hooks.PreToolUse.length, 1);
        assert.strictEqual(q.hooks.SubagentStart[0].hooks[0], startFn);
        assert.strictEqual(q.initHooksPayload, undefined);
        const setCall = calls.find((c) => c.op === 'setMcpServers');
        assert.ok(setCall.servers.other, 'unrelated MCP server must be preserved');
        assert.ok(setCall.servers.campaign, 'campaign server must be present');
        assert.deepStrictEqual(calls.map((c) => c.op), ['setMcpServers', 'reinitialize']);
    });

    await test('installQuery refuses when not idle (no mutation)', async () => {
        const { q, calls, isIdle } = fakeQuery({ idle: false });
        const result = await installQuery({ query: q, isIdle, hooks: { SubagentStart: startFn } });
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /not idle/);
        assert.strictEqual(calls.length, 0);
    });

    await test('installQuery restores prior state when hooks_applied !== true', async () => {
        const before = { PreToolUse: [{ matcher: 'Read', hooks: [preFn] }] };
        const payloadBefore = { PreToolUse: [{ matcher: 'Read', hookCallbackIds: ['hook_0'] }] };
        const { q, isIdle } = fakeQuery({ hooks: before, initHooksPayload: payloadBefore, applied: false });
        const result = await installQuery({ query: q, isIdle, hooks: { SubagentStart: startFn } });
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /hooks_applied/);
        assert.strictEqual(result.restored, true);
        assert.strictEqual(q.hooks, before, 'original hooks object identity restored');
        assert.strictEqual(q.initHooksPayload, payloadBefore);
    });

    await test('installQuery restores prior state when reinitialize throws', async () => {
        const before = { SubagentStop: [{ matcher: '', hooks: [startFn] }] };
        const { q, isIdle } = fakeQuery({ hooks: before, initHooksPayload: { x: 1 }, failReinit: true });
        const result = await installQuery({ query: q, isIdle, hooks: { PreToolUse: preFn } });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.restored, true);
        assert.strictEqual(q.hooks, before);
        assert.deepStrictEqual(q.initHooksPayload, { x: 1 });
    });

    await test('installQuery failClosed is called on failure only', async () => {
        let denied = null;
        const { q, isIdle } = fakeQuery({ applied: false });
        await installQuery({ query: q, isIdle, hooks: { PreToolUse: preFn }, failClosed: (m) => { denied = m; } });
        assert.ok(denied && /hooks_applied/.test(denied));
        let clean = false;
        const good = fakeQuery();
        await installQuery({ query: good.q, isIdle: good.isIdle, hooks: { PreToolUse: preFn }, failClosed: () => { clean = true; } });
        assert.strictEqual(clean, false);
    });

    await test('eventName accepts the CLI vocabulary and rejects a guess', () => {
        assert.strictEqual(eventName('PreCompact'), 'PreCompact');
        assert.strictEqual(eventName('SubagentStart'), 'SubagentStart');
        assert.throws(() => eventName('Compact'), /unknown hook event/);
    });

    await test('attribution reads the CLI wire fields, not worker text', () => {
        assert.strictEqual(toolUseIdOf({ params: { _meta: { 'claudecode/toolUseId': 'call_abc' } } }), 'call_abc');
        assert.strictEqual(toolUseIdOf({ params: { arguments: { agent_id: 'forged' } } }), null);
        assert.strictEqual(agentIdOf({ agent_id: 'a03d9f', tool_use_id: 'call_abc' }), 'a03d9f');
        assert.strictEqual(agentIdOf({ tool_use_id: 'call_abc' }), null, 'main thread has no agent_id');
    });

    await test('DEFAULT_EVENTS is the four the bridge owns', () => {
        assert.deepStrictEqual(DEFAULT_EVENTS, ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop']);
    });

})();
