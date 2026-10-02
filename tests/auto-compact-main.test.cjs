'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
require('./helpers/provider-registration.cjs');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const desktopId = 'local_11111111-2222-3333-4444-555555555555';

function contextFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-context-policy-'));
    const modelsFile = path.join(root, '.state', 'web-relay', 'models.json');
    fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
    fs.writeFileSync(path.join(root, '.state', 'settings.json'), JSON.stringify({
        'auto-compact': { enabled: false, defaultWindow: 1000000 },
    }));
    const writeModels = (context = 400000) => fs.writeFileSync(modelsFile, JSON.stringify({ version: 1, models: [{
        id: 'relay-fixture', name: 'Web fixture', browserModel: 'fixture', efforts: ['none', 'minimal', 'ultra', 'pro'],
        defaultEffort: 'none', context,
    }] }));
    writeModels();
    const previousFile = process.env.CUIMOD_TEST_RELAY_MODELS;
    process.env.CUIMOD_TEST_RELAY_MODELS = modelsFile;
    const dashboardKey = Symbol.for('cuimod.dashboard.settings');
    const previousDashboard = globalThis[dashboardKey];
    delete globalThis[dashboardKey];
    const calls = [];
    const control = { rejectModel: false, failSettings: false, gate: null };
    const session = { cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', model: 'claude-gpt-fixture[1m]', isRunning: true,
        sessionSettings: { autoCompactEnabled: false, autoCompactWindow: 1000000, ultracode: true,
            env: { KEEP_ME: 'yes', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } },
        query: { async applyFlagSettings(patch) {
            calls.push({ kind: 'flags', model: session.model, patch: structuredClone(patch) });
            if (control.failSettings) { control.failSettings = false; throw new Error('fixture settings failure'); }
            if (control.gate) { const gate = control.gate; control.gate = null; await gate; }
        } },
    };
    const manager = { sessions: new Map([[desktopId, session]]), saveSession() {}, emitSessionUpdated() {},
        async setModel(id, model) {
            calls.push({ kind: 'model', model });
            if (control.rejectModel) return false;
            this.sessions.get(id).model = model;
            return true;
        },
    };
    const nativeSetModel = manager.setModel;
    const key = path.join(root, 'manager-fixture.cjs');
    require.cache[key] = { exports: { claudeCodeSessionManager: manager } };
    const disposers = [];
    const methods = {};
    const mountRouting = () => {
        const owned = [];
        require('../src/plugins/provider-routing/main')({ dir: path.join(root, 'src/plugins/provider-routing'),
            boot: { MOD_DIR: root }, electron: { app: {} }, every() {}, method() {}, log() {}, onDispose: fn => owned.push(fn) });
        const dispose = () => owned.splice(0).forEach(fn => fn());
        disposers.push(dispose);
        return dispose;
    };
    const disposeRouting = mountRouting();
    require('../src/plugins/auto-compact/main')({ dir: path.join(root, 'src/plugins/auto-compact'), boot: { MOD_DIR: root },
        method: (name, fn) => { methods[name] = fn; } });
    return { root, modelsFile, writeModels, manager, session, control, calls, methods, nativeSetModel, mountRouting, disposeRouting,
        close() {
            disposers.reverse().forEach(fn => fn());
            delete require.cache[key];
            if (previousFile === undefined) delete process.env.CUIMOD_TEST_RELAY_MODELS;
            else process.env.CUIMOD_TEST_RELAY_MODELS = previousFile;
            if (previousDashboard === undefined) delete globalThis[dashboardKey];
            else globalThis[dashboardKey] = previousDashboard;
            fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

test('native model changes and live compaction use the latest registered-provider context policy', async () => {
    const f = contextFixture();
    try {
        assert.equal(await f.manager.setModel(desktopId, 'relay-fixture:pro'), true);
        assert.deepEqual(f.calls.slice(0, 2).map(call => call.kind), ['flags', 'model'], 'lower the cap before the model control');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
        assert.equal(f.session.sessionSettings.autoCompactEnabled, false, 'model selection must not enable compaction');
        assert.equal(f.session.sessionSettings.ultracode, true);
        const applied = await f.methods.apply({ sessionId: desktopId, enabled: true, window: 1000000 });
        assert.equal(applied.window, 400000, 'return the accepted budget for renderer readback');
        f.writeModels(256000);
        const changed = await f.methods.apply({ sessionId: desktopId, enabled: true, window: null });
        assert.equal(changed.window, 256000, 'enablement also reclamps a stale live window');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '256000');
        assert.equal(f.methods.models().find(model => model.id === 'relay-fixture').context, 256000);
        await f.methods.apply({ sessionId: desktopId, enabled: false, window: 100000 });
        const on = await f.methods.apply({ sessionId: desktopId, enabled: true, window: null });
        assert.equal(on.window, 100000, 'a smaller explicit live choice survives enablement');
        await f.manager.setModel(desktopId, 'claude-relay-fixture[1m]:ultra');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '100000', 'effort selection keeps a smaller live window');
        await f.manager.setModel(desktopId, 'claude-gpt-fixture[1m]:high');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
        assert.equal(f.session.sessionSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
        assert.equal(f.session.sessionSettings.env.KEEP_ME, 'yes');
        assert.equal(f.session.sessionSettings.autoCompactEnabled, true);
    } finally { f.close(); }
});

test('native model rejection and failed settings restore the original context', async () => {
    const f = contextFixture();
    try {
        const before = f.session.sessionSettings;
        f.control.rejectModel = true;
        assert.equal(await f.manager.setModel(desktopId, 'relay-fixture:pro'), false);
        assert.equal(f.session.model, 'claude-gpt-fixture[1m]');
        assert.equal(f.session.sessionSettings, before);
        assert.equal(f.calls.at(-1).patch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
        f.control.rejectModel = false;
        f.control.failSettings = true;
        await assert.rejects(f.manager.setModel(desktopId, 'relay-fixture:pro'), /fixture settings failure/);
        assert.equal(f.session.model, 'claude-gpt-fixture[1m]');
        assert.equal(f.session.sessionSettings, before);
        assert.equal(f.calls.at(-1).patch.env.KEEP_ME, 'yes');
        fs.unlinkSync(f.modelsFile);
        const count = f.calls.length;
        await assert.rejects(f.manager.setModel(desktopId, 'relay-fixture:pro'), /context metadata is unavailable/);
        assert.equal(f.calls.length, count, 'missing context must fail before a model or settings mutation');
        f.session.model = 'relay-fixture:pro';
        await f.methods.apply({ sessionId: desktopId, enabled: false, window: null });
        assert.equal(f.session.sessionSettings.autoCompactEnabled, false, 'retirement must not prevent turning compaction off');
    } finally { f.close(); }
});

test('model changes and compaction settings serialize against the same session', async () => {
    const f = contextFixture();
    let release;
    try {
        f.control.gate = new Promise(resolve => { release = resolve; });
        const selection = f.manager.setModel(desktopId, 'relay-fixture:minimal');
        const settings = f.methods.apply({ sessionId: desktopId, enabled: true, window: 1000000 });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.calls.length, 1, 'the live editor must wait for the model transition');
        release();
        await selection;
        assert.equal((await settings).window, 400000);
        assert.equal(f.session.model, 'relay-fixture:minimal');
        assert.ok(f.calls.filter(call => call.kind === 'flags').every(call => call.patch.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '400000'));
        assert.equal(f.session.sessionSettings.env.KEEP_ME, 'yes');
    } finally { release?.(); f.close(); }
});

test('a replaced native session cannot inherit an older pending model operation', async () => {
    const f = contextFixture();
    let release;
    try {
        f.control.gate = new Promise(resolve => { release = resolve; });
        const selection = f.manager.setModel(desktopId, 'relay-fixture:pro');
        const settings = f.methods.apply({ sessionId: desktopId, enabled: true, window: 1000000 });
        await new Promise(resolve => setImmediate(resolve));
        const newer = { model: 'claude-opus-5', sessionSettings: {}, query: { applyFlagSettings() { throw new Error('foreign worker touched'); } } };
        f.manager.sessions.set(desktopId, newer);
        release();
        await assert.rejects(selection, /session changed/);
        assert.equal((await settings).applied, false);
        assert.equal(newer.model, 'claude-opus-5');
        assert.deepEqual(newer.sessionSettings, {});
        assert.equal(f.calls.filter(call => call.kind === 'model').length, 0);
    } finally { release?.(); f.close(); }
});

test('context policy normalizes all web efforts and respects session precedence', () => {
    const f = contextFixture();
    try {
        const { createContextPolicy, bareModel } = require('../src/plugins/provider-routing/main');
        const policy = createContextPolicy(f.root);
        globalThis[Symbol.for('cuimod.dashboard.settings')] = { store: { 'auto-compact': {
            defaultWindow: 1000000, perModel: { 'CLAUDE-RELAY-FIXTURE:PRO[1m]': 300000 },
            sessionOverrides: { [f.session.cliSessionId]: { window: 200000, enabled: true } },
        } } };
        for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro']) {
            for (const model of [`relay-fixture:${effort}`, `claude-relay-fixture[1m]:${effort}`, `CLAUDE-RELAY-FIXTURE:${effort.toUpperCase()}[1m]`]) {
                assert.equal(bareModel(model), 'relay-fixture');
                assert.equal(policy.resolve(model, f.session.cliSessionId).window, 200000);
                assert.equal(policy.resolve(model).window, 300000);
            }
        }
        assert.equal(policy.resolve('relay-fixture', f.session.cliSessionId).enabled, true);
        f.writeModels(256000);
        assert.equal(policy.resolve('relay-fixture').window, 256000);
        fs.writeFileSync(f.modelsFile, '{malformed');
        assert.deepEqual(policy.models(), []);
        assert.throws(() => policy.resolve('relay-fixture'), /context metadata/);
    } finally { f.close(); }
});

test('native context wrapper survives overlapping plugin generations without stacking', async () => {
    const f = contextFixture();
    try {
        const dispose = f.mountRouting();
        const current = f.manager.setModel;
        f.disposeRouting();
        assert.equal(f.manager.setModel, current, 'disposing the predecessor must preserve the new wrapper');
        assert.equal(f.manager.setModel.__cuimodRoutingModelOriginal, f.nativeSetModel);
        await f.manager.setModel(desktopId, 'relay-fixture:ultra');
        assert.equal(f.calls.filter(call => call.kind === 'model').length, 1);
        assert.equal(f.calls.filter(call => call.kind === 'flags').length, 1);
        dispose();
        assert.equal(f.manager.setModel, f.nativeSetModel);
    } finally { f.close(); }
});

test('compaction renderer presents dynamic caps and waits for the accepted window', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/auto-compact/renderer.js'), 'utf8');
    const saves = [];
    let catalogue = [{ id: 'relay-fixture', name: 'Web', provider: 'web-relay', registered: true, context: 256000 }];
    const registry = { specs: new Map(), subs: new Set(), get: () => ({}), set: (...args) => saves.push(args) };
    const button = () => ({ classList: { toggle() {} }, disabled: false });
    const controls = { value: Object.fromEntries(['model', 'enabled', 'window', 'trigger', 'source', 'next'].map(key => [key, { textContent: '' }])),
        enabled: [button(), button()], live: Array.from({ length: 6 }, button), note: {} };
    const sandbox = { __cuimodReg: registry, location: { pathname: '/' + desktopId.slice(6), search: '' },
        cuimod: { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', eipc: () => '', onSessionChange() {},
            rpc: async method => method === 'auto-compact.models' ? catalogue
                : method === 'provider-picker.nativeSync' ? { nativeModels: [] }
                    : { applied: true, windowSent: true, window: 256000, cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
        ctx: { every() {}, onDispose() {} }, setTimeout, clearTimeout, queueMicrotask };
    const api = vm.runInNewContext('(function(){' + source + '\nreturn { bare, loadModels, send, updateObserved, '
        + 'configure(data) { models = data.models; observed = data.observed; obs = data.controls; V = {...DEF, enabled: true}; }, '
        + 'state() { return { models, liveWant, liveNote }; } };})()', sandbox);
    api.configure({ models: catalogue, controls, observed: { model: 'relay-fixture:pro', isAutoCompactEnabled: true,
        rawMaxTokens: 400000, autoCompactThreshold: 367000, autocompactSource: 'env' } });
    api.updateObserved();
    assert.deepEqual(controls.live.map(value => value.disabled), [false, false, true, true, true, true]);
    assert.equal(controls.enabled.some(value => value.disabled), false);
    assert.match(controls.value.next.textContent, /256k/);
    for (const effort of ['none', 'minimal', 'ultra', 'pro']) assert.equal(api.bare(`claude-relay-fixture[1m]:${effort}`), 'relay-fixture');
    await api.send(true, 1000000, 'Applying');
    assert.equal(api.state().liveWant, 256000, 'wait for the accepted window, not the over-cap request');
    assert.match(api.state().liveNote, /Waiting for the worker/);
    assert.equal(saves.at(-1)[2]['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'].window, 256000);
    catalogue = [{ id: 'relay-replacement', name: 'Replacement', provider: 'web-relay', registered: true, context: 400000 }];
    await api.loadModels();
    assert.deepEqual(Array.from(api.state().models, row => row.id), ['relay-replacement']);
});

test('the session control reaches only the named worker query', async () => {
    const calls = [];
    const persisted = [];
    const session = { cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionSettings: { ultracode: true, env: { KEEP_ME: 'yes' } }, query: {
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
        // The window that reaches a running worker rides in settings.env, which
        // the control handler shallow-merges: sending only our key would drop
        // every other env entry the session holds.
        // The window that reaches a running worker rides in settings.env, which
        // the control handler shallow-merges: sending only our key would drop
        // every other env entry the session holds. Turning it on also clears the
        // two kill switches, because ken() short-circuits ahead of the flag
        // layer and either one left set would make the enablement inert.
        const on = { KEEP_ME: 'yes', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
            DISABLE_COMPACT: '', DISABLE_AUTO_COMPACT: '' };
        const enabled = await methods.apply({ sessionId: desktopId, enabled: true, window: 400000 });
        assert.deepEqual(enabled, { applied: true, windowSent: true, window: 400000,
            cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
        assert.deepEqual(calls, [{ autoCompactEnabled: true, autoCompactWindow: 400000, env: on }]);
        assert.deepEqual(session.sessionSettings,
            { ultracode: true, autoCompactEnabled: true, autoCompactWindow: 400000, env: on });
        assert.deepEqual(persisted.slice(0, 2).map(row => row[0]), ['save', 'emit']);

        // Off with auto carries no env at all. The flag layer alone turns it off,
        // and setting DISABLE_COMPACT would take manual /compact away with it.
        await methods.apply({ sessionId: desktopId, enabled: false, window: null });
        assert.deepEqual(calls.at(-1), { autoCompactEnabled: false, autoCompactWindow: null });
        assert.deepEqual(session.sessionSettings,
            { ultracode: true, autoCompactEnabled: false, autoCompactWindow: null, env: on });

        // Restoring a different override rewrites only our key.
        await methods.apply({ sessionId: desktopId, enabled: true, window: 1000000 });
        assert.deepEqual(calls.at(-1).env, { ...on, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' });

        // Turning it back on with no window still clears the kill switches.
        await methods.apply({ sessionId: desktopId, enabled: true, window: null });
        assert.deepEqual(calls.at(-1), { autoCompactEnabled: true, autoCompactWindow: null,
            env: { ...on, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } });
        await assert.rejects(() => methods.apply({ sessionId: 'not-a-session', enabled: true, window: 400000 }), /desktop session id/);
        await assert.rejects(() => methods.apply({ sessionId: desktopId, enabled: true, window: 99999 }), /100k/);
    } finally {
        delete require.cache[key];
        delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    }
});

// Two overlapping patches would each read sessionSettings before the other
// wrote it, and the loser's env map would reach the worker without the winner's
// key. The updates are serialized per session so the second reads the first.
test('concurrent window updates are serialized against one session', async () => {
    const calls = [];
    let release = null;
    const gate = new Promise(resolve => { release = resolve; });
    const session = { cliSessionId: 'cli-serialized', sessionSettings: { env: { KEEP_ME: 'yes' } }, query: {
        async applyFlagSettings(settings) { calls.push(settings); if (calls.length === 1) await gate; },
    } };
    const manager = { sessions: new Map([[desktopId, session]]), saveSession() {}, emitSessionUpdated() {} };
    const key = path.join(os.tmpdir(), 'cuimod-auto-compact-manager-serialized.cjs');
    require.cache[key] = { exports: { claudeCodeSessionManager: manager } };
    delete require.cache[require.resolve('../src/plugins/auto-compact/main')];
    const factory = require('../src/plugins/auto-compact/main');
    const methods = {};
    try {
        factory({ dir: path.join(__dirname, '../src/plugins/auto-compact'), method: (name, fn) => { methods[name] = fn; } });
        const first = methods.apply({ sessionId: desktopId, enabled: true, window: 400000 });
        const second = methods.apply({ sessionId: desktopId, enabled: true, window: 1000000 });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, 1, 'the second patch started before the first answered');
        release();
        await Promise.all([first, second]);
        assert.deepEqual(calls.map(call => call.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW), ['400000', '1000000']);
        assert.ok(calls.every(call => call.env.KEEP_ME === 'yes'), 'an unrelated env key was dropped');
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
