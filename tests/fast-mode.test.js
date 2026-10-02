'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');

const pagePath = path.join(__dirname, '../src/plugins/provider-picker/page.js');
// The pinned composer resolves the fast switch as fastModeFor(Uc(modelId)),
// and fastModeFor looks the stripped id up again after Uc (shared-2 LA()).
const Uc = id => id.replace(/\[[^\]]+\]$/, '').replace(/-20\d{6}$/, '');

function runPage(models, sectionModels) {
    const listeners = new Set();
    const query = { queryKey: ['current_account'], state: { data: { model_selector_config: [{ id: 'ccd', models: sectionModels }] } } };
    const client = {
        getQueryCache: () => ({ getAll: () => [query], subscribe: f => { listeners.add(f); return () => listeners.delete(f); } }),
        setQueryData(_key, data) { query.state.data = data; for (const notify of listeners) notify({ query }); },
    };
    const scope = { getState: () => ({ sessionRef: null }), subscribe: () => () => {} };
    const element = { __reactFiber$t: { memoizedProps: { scopeStore: scope }, dependencies: { firstContext: { memoizedValue: client } } } };
    const context = { window: {}, document: { querySelectorAll: () => [element] }, models,
        providers: [{ id: 'claude', label: 'Claude' }, { id: 'openai', label: 'OpenAI' }], version: 'fast-test', queueMicrotask };
    vm.runInNewContext('(function(models,version){' + fs.readFileSync(pagePath, 'utf8') + '\n})(models,version)', context);
    return { section: () => query.state.data.model_selector_config[0].models, native: context.window.__cuimod_provider_native };
}

test('the fast switch resolves for a routed GPT row and for Opus 5.5, and nowhere else', () => {
    const models = [
        { wireId: 'claude-gpt-6.1-sol[1m]', name: 'GPT-6.1-Sol', provider: 'openai', efforts: ['low'], defaultEffort: 'low', context: 1050000, fastMode: true },
        { wireId: 'claude-gemini-3.7-flash[1m]', name: 'Flash', provider: 'gemini', efforts: [], context: 1000000 },
    ];
    const opus5 = { id: 'claude-opus-5', name: 'Opus 5', fast_mode: { type: 'toggle', options: [{ id: 'fast', name: 'x' }] } };
    const { section, native } = runPage(models, [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }, opus5, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }]);
    const byId = new Map(section().map(m => [m.id, m]));
    const fastModeFor = id => { const f = byId.get(id) ?? byId.get(Uc(id)); return f?.fast_mode?.type === 'toggle' ? f.fast_mode : undefined; };

    assert.ok(fastModeFor(Uc('claude-gpt-6.1-sol[1m]')), 'routed GPT row has no fast switch');
    assert.ok(fastModeFor(Uc('claude-opus-5-5')), 'Opus 5.5 has no fast switch');
    assert.equal(fastModeFor(Uc('claude-gemini-3.7-flash[1m]')), undefined);
    assert.equal(fastModeFor(Uc('claude-sonnet-5-5')), undefined);
    assert.equal(byId.get('claude-opus-5').fast_mode, opus5.fast_mode, 'a server-supplied switch is left as served');

    // The popup renders only main and overflow rows; the twin exists for the
    // stripped lookup alone and must not add a visible row.
    const visible = section().filter(m => (m.section ?? 'main') === 'main' || m.section === 'overflow').map(m => m.id);
    assert.deepEqual(visible, ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-gpt-6.1-sol[1m]', 'claude-gemini-3.7-flash[1m]']);
    assert.equal(byId.get('claude-gpt-6.1-sol').section, 'legacy');

    native.dispose();
    assert.deepEqual(section().map(m => m.id), ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
    assert.equal(section()[0].fast_mode, undefined, 'dispose must restore the untouched native rows');
});

async function withHome(fn) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-home-'));
    // A test run from inside a routed Claude Code session inherits that
    // session's own CLAUDE_CODE_MODEL_CAPABILITIES, which grantFast appends to
    // the entries it computes from the fake cache. The expectation is about the
    // fake cache alone, so the ambient value must not reach it.
    const held = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME,
        CLAUDE_CODE_MODEL_CAPABILITIES: process.env.CLAUDE_CODE_MODEL_CAPABILITIES };
    process.env.USERPROFILE = home; process.env.HOME = home;
    delete process.env.CLAUDE_CODE_MODEL_CAPABILITIES;
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', service_tiers: [{ id: 'priority', name: 'Fast' }] },
        { slug: 'gpt-5.4', service_tiers: [] },
        { slug: 'codex-auto-review', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    ] }));
    try { return await fn(home); }
    finally {
        for (const [key, value] of Object.entries(held)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function fakeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-root-'));
    fs.mkdirSync(path.join(root, 'src', 'plugins', 'provider-routing'), { recursive: true });
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    return root;
}

test('every worker may run fast GPT, and a resumed session keeps its own switch', () => withHome(() => {
    const root = fakeRoot();
    const original = cp.spawn;
    const calls = [];
    cp.spawn = (...args) => { calls.push(args); return { mock: true }; };
    const managerKey = path.join(root, 'fake-manager.js');
    const sessions = new Map([['local_a', { sessionId: 'local_a', cliSessionId: 'cli-a' }], ['local_b', { sessionId: 'local_b', cliSessionId: 'cli-b' }]]);
    require.cache[managerKey] = { exports: { claudeCodeSessionManager: { sessions } } };
    delete require.cache[require.resolve('../src/plugins/provider-routing/main')];
    const factory = require('../src/plugins/provider-routing/main');
    const disposers = [];
    factory({ dir: path.join(root, 'src', 'plugins', 'provider-routing'), boot: { MOD_DIR: root },
        electron: { app: {} }, every() {}, method() {}, log() {}, onDispose: f => disposers.push(f) });
    const settingsOf = call => JSON.parse(call[1][call[1].indexOf('--settings') + 1]);
    try {
        fs.writeFileSync(path.join(root, '.state', 'fast-mode.json'), JSON.stringify({ sessions: { local_a: true, local_b: false } }));
        cp.spawn('C:/app/claude-code/2.1.284/claude.exe', ['--model', 'claude-opus-5-5', '--resume', 'cli-a', '--settings', '{"fastMode":false}'],
            { env: { CLAUDE_CODE_MODEL_CAPABILITIES: 'claude-gpt-6.1-sol*=-fast_mode' } });
        const caps = calls.at(-1)[2].env.CLAUDE_CODE_MODEL_CAPABILITIES.split(';');
        assert.deepEqual(caps, ['claude-gpt-6.1-sol*=fast_mode', 'gpt-6.1-sol*=fast_mode', 'claude-gpt-6.1-sol*=-fast_mode'],
            'only priority-tier gpt slugs, and an inherited entry still has the last word');
        assert.equal(settingsOf(calls.at(-1)).fastMode, true);
        cp.spawn('C:/app/claude-code/2.1.284/claude.exe', ['--model', 'claude-opus-5-5', '--resume', 'cli-b', '--settings', '{"fastMode":true}'], { env: {} });
        assert.equal(settingsOf(calls.at(-1)).fastMode, false);
        cp.spawn('C:/app/claude-code/2.1.284/claude.exe', ['--model', 'claude-opus-5-5', '--session-id', 'cli-new', '--settings', '{"fastMode":true}'], { env: {} });
        assert.equal(settingsOf(calls.at(-1)).fastMode, true, 'a session nobody set keeps the value Desktop launched it with');
    } finally {
        disposers.forEach(f => f());
        cp.spawn = original;
        delete require.cache[managerKey];
        fs.rmSync(root, { recursive: true, force: true });
    }
}));

test('the switch value is recorded per session from every setFastMode caller', () => withHome(async () => {
    const root = fakeRoot();
    const order = [];
    const worker = { applyFlagSettings: async patch => { order.push(['flags', patch]); } };
    const managerKey = path.join(root, 'fake-manager.js');
    const applied = [];
    const manager = {
        sessions: new Map([
            ['local_a', { sessionId: 'local_a', cliSessionId: 'CLI-A', query: {}, fastModeState: 'off' }],
            ['local_b', { sessionId: 'local_b', query: {}, fastModeState: 'on' }],
            ['local_new', { sessionId: 'local_new', pendingFirstStart: { options: { fastMode: true } } }],
            ['local_live', { sessionId: 'local_live', query: {} }],
            ['local_idle', { sessionId: 'local_idle' }],
            ['local_old', { sessionId: 'local_old', query: worker, sessionSettings: { env: { KEEP: 'x' } } }],
        ]),
        async setFastMode(sessionId, value, by) { applied.push([sessionId, value, by]); order.push(['app', sessionId, value]); return 'applied'; },
    };
    require.cache[managerKey] = { exports: { claudeCodeSessionManager: manager } };
    delete require.cache[require.resolve('../src/plugins/fast-mode/main')];
    const factory = require('../src/plugins/fast-mode/main');
    const methods = {}, disposers = [];
    factory({ dir: path.join(root, 'src', 'plugins', 'fast-mode'), boot: { MOD_DIR: root },
        every() {}, log() {}, method: (name, fn) => { methods[name] = fn; }, onDispose: f => disposers.push(f) });
    try {
        assert.equal(methods.desired({ sessionId: 'local_a' }), false);
        assert.equal(methods.desired({ sessionId: 'local_b' }), true, 'an unset session shows what its worker reports');
        assert.equal(methods.desired({ sessionId: 'local_new' }), true, 'a new session keeps the draft switch it was started with');
        assert.equal(methods.desired({ sessionId: 'local_live' }), null, 'a live worker that has not reported is unknown');
        assert.equal(methods.desired({ sessionId: 'local_idle' }), false);
        assert.equal(methods.desired({ sessionId: 'local_gone' }), null);

        await manager.setFastMode('local_a', true);
        assert.deepEqual(applied.at(-1), ['local_a', true, undefined], 'the app method still runs');
        assert.equal(methods.desired({ sessionId: 'local_a' }), true);
        assert.equal(methods.draft({}), true, 'a user flip is also the next new session\'s default');
        const onDisk = () => JSON.parse(fs.readFileSync(path.join(root, '.state', 'fast-mode.json'), 'utf8'));
        assert.deepEqual(onDisk().cli, { 'cli-a': true }, 'the router finds the switch by Claude Code session id');
        manager.sessions.get('local_a').cliSessionId = 'cli-cleared';
        await manager.setFastMode('local_a', false);
        assert.deepEqual(onDisk().cli, { 'cli-cleared': false }, 'a /clear moves the index to the new id');
        await manager.setFastMode('local_a', true);

        await manager.setFastMode('local_b', false, 'agent');
        assert.equal(methods.desired({ sessionId: 'local_b' }), false);
        assert.equal(methods.draft({}), true, 'the session tool changes one session, not the default');

        assert.equal(methods.draft({ value: false }), false);
        const { readFastIntent } = require('../src/plugins/fast-mode/main');
        assert.equal(readFastIntent(root, 'local_a'), true);
        assert.equal(readFastIntent(root, 'local_b'), false);
        assert.equal(readFastIntent(root, 'local_idle'), undefined);

        // A worker spawned before the capability env existed is granted it
        // live, once, before Desktop pushes fastMode to it.
        order.length = 0;
        await manager.setFastMode('local_old', true);
        await manager.setFastMode('local_old', false);
        await manager.setFastMode('local_old', true);
        assert.deepEqual(order, [
            ['flags', { env: { KEEP: 'x', CLAUDE_CODE_MODEL_CAPABILITIES: 'claude-gpt-6.1-sol*=fast_mode;gpt-6.1-sol*=fast_mode' } }],
            ['app', 'local_old', true], ['app', 'local_old', false], ['app', 'local_old', true],
        ]);

        disposers.forEach(f => f());
        assert.equal(manager.setFastMode.__cuimodFastOriginal, undefined, 'dispose restores the app method');
    } finally {
        delete require.cache[managerKey];
        fs.rmSync(root, { recursive: true, force: true });
    }
}));
