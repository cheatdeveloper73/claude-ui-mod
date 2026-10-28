'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/provider-registration.cjs');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('node:events');

const familyEnvKeys = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
const modelEnvKeys = ['ANTHROPIC_SMALL_FAST_MODEL', ...familyEnvKeys];

test('registered-provider model environment restores family defaults without forcing concrete models', () => {
    const { applyRegisteredModelEnvironment } = require('../src/plugins/provider-routing/main');
    const original = Object.freeze({ KEEP: 'unchanged', ANTHROPIC_MODEL: 'concrete-request',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku', ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_SMALL_FAST_MODEL: 'custom-helper' });
    const first = applyRegisteredModelEnvironment(original, 'CLAUDE-RELAY-ONE:PRO[1m]');
    for (const key of familyEnvKeys) assert.equal(first[key], 'relay-one:pro', key);
    assert.equal(first.ANTHROPIC_SMALL_FAST_MODEL, 'custom-helper');
    assert.equal(first.KEEP, original.KEEP);
    assert.equal(first.ANTHROPIC_MODEL, original.ANTHROPIC_MODEL);
    assert.equal(first.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
    const second = applyRegisteredModelEnvironment(first, 'relay-two:ultra');
    for (const key of familyEnvKeys) assert.equal(second[key], 'relay-two:ultra', key);
    assert.equal(second.ANTHROPIC_SMALL_FAST_MODEL, 'custom-helper');
    assert.equal(first.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'relay-one:pro', 'never mutate the previous env');
    assert.deepEqual(applyRegisteredModelEnvironment(second, 'claude-opus-5'), original);
    assert.deepEqual(applyRegisteredModelEnvironment(original, 'claude-sonnet-5'), original);
    const empty = applyRegisteredModelEnvironment({}, 'relay-one');
    assert.deepEqual(applyRegisteredModelEnvironment(empty, 'claude-haiku-4-5'), {}, 'absent defaults stay absent');
});

function familySessionFixture(model = 'claude-opus-5') {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'relay-family-env-'));
    const modelsFile = path.join(root, 'models.json');
    fs.writeFileSync(modelsFile, JSON.stringify({ version: 1, models: [
        { id: 'relay-one', context: 400000, efforts: ['pro', 'high'] },
        { id: 'relay-two', context: 256000, efforts: ['ultra'] },
    ] }));
    const heldFile = process.env.CUIMOD_TEST_RELAY_MODELS;
    process.env.CUIMOD_TEST_RELAY_MODELS = modelsFile;
    const heldEnv = Object.fromEntries(modelEnvKeys.map(key => [key, process.env[key]]));
    for (const key of modelEnvKeys) delete process.env[key];
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'inherited-opus';
    const session = { cliSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', model,
        sessionSettings: { autoCompactWindow: 1000000, keepFlag: true,
            env: { KEEP: 'session-env', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'session-haiku',
                ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_SMALL_FAST_MODEL: 'session-helper' } } };
    const factory = require('../src/plugins/provider-routing/main');
    const workerEnv = factory.applyRegisteredModelEnvironment({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'inherited-opus',
        ...session.sessionSettings.env }, model);
    const flags = [], requests = [];
    const control = { reject: false, throwModel: false, failSettings: false };
    session.query = { async applyFlagSettings(patch) {
        flags.push(structuredClone(patch));
        Object.assign(workerEnv, patch.env);
        if (control.failSettings) { control.failSettings = false; throw new Error('settings rejected'); }
    } };
    const manager = { sessions: new Map([['session', session]]), saveSession() {}, emitSessionUpdated() {},
        async setModel(id, value) {
            requests.push(value);
            if (control.reject) return false;
            if (control.throwModel) { control.throwModel = false; throw new Error('model rejected'); }
            this.sessions.get(id).model = value;
            return true;
        } };
    const moduleKey = path.join(root, 'manager.cjs');
    require.cache[moduleKey] = { exports: { claudeCodeSessionManager: manager } };
    const disposers = [];
    const mount = () => {
        const owned = [];
        factory({ boot: { MOD_DIR: root }, electron: { app: {} }, every() {}, method() {}, log() {},
            onDispose: fn => owned.push(fn) });
        const dispose = () => owned.splice(0).forEach(fn => fn());
        disposers.push(dispose);
        return dispose;
    };
    const disposeFirst = mount();
    return { session, manager, workerEnv, flags, requests, control, mount, disposeFirst,
        close() {
            disposers.reverse().forEach(fn => fn());
            delete require.cache[moduleKey];
            for (const key of modelEnvKeys) {
                if (heldEnv[key] === undefined) delete process.env[key]; else process.env[key] = heldEnv[key];
            }
            if (heldFile === undefined) delete process.env.CUIMOD_TEST_RELAY_MODELS; else process.env.CUIMOD_TEST_RELAY_MODELS = heldFile;
            fs.rmSync(root, { recursive: true, force: true });
        } };
}

test('accepted registered-provider model changes and hot reload retain the original family defaults', async () => {
    const f = familySessionFixture();
    try {
        await f.manager.setModel('session', 'relay-one:pro');
        for (const key of familyEnvKeys) assert.equal(f.workerEnv[key], 'relay-one:pro', key);
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
        f.mount();
        f.disposeFirst();
        await f.manager.setModel('session', 'relay-two:ultra');
        for (const key of familyEnvKeys) assert.equal(f.workerEnv[key], 'relay-two:ultra', key);
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
        await f.manager.setModel('session', 'claude-sonnet-5');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'session-haiku');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, '');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'inherited-opus');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, '', 'the worker needs an explicit clear');
        assert.equal(Object.hasOwn(f.session.sessionSettings.env, 'ANTHROPIC_DEFAULT_FABLE_MODEL'), false);
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
        assert.equal(f.session.sessionSettings.keepFlag, true);
        assert.equal(f.session.sessionSettings.env.KEEP, 'session-env');
        assert.deepEqual(f.requests, ['relay-one:pro', 'relay-two:ultra', 'claude-sonnet-5']);
        assert.ok(f.flags.every(patch => !Object.hasOwn(patch.env, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE')));
    } finally { f.close(); }
});

test('rejected registered-provider changes restore family defaults on both native and settings failures', async () => {
    const f = familySessionFixture();
    try {
        const before = f.session.sessionSettings;
        f.control.reject = true;
        assert.equal(await f.manager.setModel('session', 'relay-one:pro'), false);
        f.control.reject = false;
        for (const failure of ['throwModel', 'failSettings']) {
            f.control[failure] = true;
            await assert.rejects(f.manager.setModel('session', 'relay-one:pro'), /rejected/);
        }
        assert.equal(f.session.sessionSettings, before);
        assert.equal(f.session.model, 'claude-opus-5');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'session-haiku');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'inherited-opus');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, '');
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
        await f.manager.setModel('session', 'relay-one:pro');
        const cosSettings = f.session.sessionSettings;
        f.control.reject = true;
        assert.equal(await f.manager.setModel('session', 'relay-one:high'), false, 'same-family effort rejection also rolls back');
        f.control.reject = false;
        f.control.failSettings = true;
        await assert.rejects(f.manager.setModel('session', 'claude-sonnet-5'), /settings rejected/);
        assert.equal(f.session.sessionSettings, cosSettings);
        assert.equal(f.session.model, 'relay-one:pro');
        for (const key of familyEnvKeys) assert.equal(f.workerEnv[key], 'relay-one:pro', key);
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
    } finally { f.close(); }
});

test('a registered-provider launch can reject a change and later restore its inherited family defaults', async () => {
    const f = familySessionFixture('relay-one:pro');
    try {
        const before = f.session.sessionSettings;
        f.control.reject = true;
        assert.equal(await f.manager.setModel('session', 'relay-two:ultra'), false);
        assert.equal(f.session.sessionSettings, before);
        for (const key of familyEnvKeys) assert.equal(f.workerEnv[key], 'relay-one:pro', key);
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
        f.control.reject = false;
        await f.manager.setModel('session', 'claude-sonnet-5');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'session-haiku');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'inherited-opus');
        assert.equal(f.workerEnv.ANTHROPIC_DEFAULT_FABLE_MODEL, '');
        assert.equal(f.workerEnv.ANTHROPIC_SMALL_FAST_MODEL, 'session-helper');
    } finally { f.close(); }
});

test('both context displays distinguish provider input from estimates without counting output', () => {
    const boot = { rpc: async () => null, log() {}, eipc: () => '', observeInvoke: () => () => {}, appOn: () => () => {} };
    const context = { boot, plugins: [{ name: 'capture', source: 'globalThis.countInfo = cuimod.contextCountInfo;' }],
        location: { pathname: '/epitaxy', search: '' }, window: { addEventListener() {}, removeEventListener() {} },
        setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/runtime/bridge.js'), 'utf8');
    const bridge = vm.runInNewContext('(function(boot,plugins){' + source + '\n})(boot,plugins)', context);
    const apiUsage = { input_tokens: 120, cache_read_input_tokens: 800, cache_creation_input_tokens: 80, output_tokens: 600 };
    assert.equal(context.countInfo({ totalTokens: 1000, apiUsage }).exact, true);
    assert.equal(context.countInfo({ totalTokens: 1600, apiUsage }).exact, false);
    assert.equal(context.countInfo({ totalTokens: 1000 }).exact, false);
    assert.equal(context.countInfo(null).exact, false);
    assert.equal(context.countInfo({ totalTokens: 1000, apiUsage: { input_tokens: NaN } }).exact, false);
    bridge.dispose();
});

test('dashboard keeps launch settings authoritative across a failed immediate flush', () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-settings-'));
    const blocked = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocked, 'file');
    const key = Symbol.for('cuimod.dashboard.settings');
    const held = globalThis[key];
    const methods = {};
    const logs = [];
    const disposers = [];
    delete require.cache[require.resolve('../src/plugins/dashboard/main')];
    const factory = require('../src/plugins/dashboard/main');
    try {
        factory({ boot: { MOD_DIR: blocked }, method: (name, fn) => { methods[name] = fn; },
            onDispose: fn => disposers.push(fn), log: message => logs.push(message), electron: {} });
        assert.deepEqual(methods.load(), {});
        assert.throws(() => methods.save({ plugin: 'auto-compact', immediate: true,
            values: { enabled: true, perModel: { 'gpt-6-astra': 400000 } } }), /settings write failed/);
        assert.deepEqual(globalThis[key].store['auto-compact'], {
            enabled: true, perModel: { 'gpt-6-astra': 400000 },
        });
        assert.match(logs.at(-1), /settings write failed/);
    } finally {
        disposers.forEach(fn => fn());
        if (held === undefined) delete globalThis[key];
        else globalThis[key] = held;
        delete require.cache[require.resolve('../src/plugins/dashboard/main')];
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('cold startup launches Node once and survives a host replacement during the probe', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-routing/main.js'), 'utf8');
    const calls = [], probes = [], logs = [];
    const spawn = (...args) => {
        calls.push(args);
        const child = new EventEmitter();
        child.unref = () => {};
        return child;
    };
    const childProcess = { spawn };
    let healthy = false;
    const urls = [];
    const fakeHttp = { get(url, callback) {
        urls.push(url);
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = () => req.emit('error', new Error('timeout'));
        probes.push(() => healthy ? callback({ statusCode: 200, headers: { 'x-cuimod-router-supervisor': '1' }, resume() {} }) : req.emit('error', new Error('refused')));
        return req;
    } };
    const sandbox = {
        module: { exports: {} }, __dirname: path.join(__dirname, '../src/plugins/provider-routing'),
        require: name => ({ fs: { existsSync: () => true }, path, http: fakeHttp, child_process: childProcess,
            '../unlock-code/main': { routedModel: () => false },
            './registrations': require('../src/plugins/provider-routing/registrations') })[name],
        process: { execPath: 'C:/app/claude.exe', env: {} },
        setTimeout: fn => { queueMicrotask(fn); },
    };
    vm.runInNewContext(source, sandbox);
    const make = () => {
        const dispose = [], methods = {}, timers = [];
        sandbox.module.exports({ electron: { app: { isReady: () => true } }, every: (_ms, fn) => timers.push(fn),
            method: (name, fn) => { methods[name] = fn; }, log: message => logs.push(message), onDispose: fn => dispose.push(fn) });
        return { dispose: () => dispose.forEach(fn => fn()), methods, timers };
    };
    // ensure() probes, backs off, and probes AGAIN before it will spawn, so a
    // single drain leaves the second probe unanswered and nothing ever starts.
    // Draining on every tick is what the real http client does.
    const flush = async () => {
        for (let i = 0; i < 24; i++) { probes.splice(0).forEach(fn => fn()); await Promise.resolve(); }
    };
    const old = make();
    const current = make();
    const wrapper = childProcess.spawn;
    // Two consecutive missed probes gate a spawn -- the deliberate fix for the
    // afternoon that spawned 19 supervisors -- so the replacement host only
    // takes over after two full misses, delivered here while the old
    // generation is already disposed: exactly one daemon may come of it.
    old.dispose();
    probes.splice(0).forEach(fn => fn());
    await flush();
    probes.splice(0).forEach(fn => fn());
    await flush();
    assert.equal(childProcess.spawn, wrapper);
    assert.equal(calls.length, 1, 'disposed host must not start a second daemon');
    assert.ok(urls.length > 0);
    assert.ok(urls.every(url => url === 'http://127.0.0.1:8789/supervisorz'), 'liveness must bypass the worker');
    assert.equal(calls[0][0], 'node.exe', 'never run fused Electron as Node');
    assert.equal(calls[0][2].windowsHide, true);
    assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.ok(calls[0][1][0].endsWith(path.join('router', 'supervisor.mjs')));
    healthy = true;
    probes.splice(0).forEach(fn => fn());
    await flush();
    const status = current.methods.status();
    probes.splice(0).forEach(fn => fn());
    assert.equal((await status).ready, true);
    current.timers[0]();
    probes.splice(0).forEach(fn => fn());
    await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(logs, []);
    current.dispose();
    assert.equal(childProcess.spawn, spawn);
});

test('routing survives build-next-before-dispose-old hot reload', () => {
    const original = cp.spawn;
    const calls = [];
    const fake = (...args) => { calls.push(args); return { mock: true }; };
    cp.spawn = fake;
    const factory = require('../src/plugins/provider-routing/main');
    const make = () => {
        const disposers = [];
        factory({ electron: { app: {} }, every() {}, method() {}, log() {}, onDispose: f => disposers.push(f) });
        return () => disposers.forEach(f => f());
    };
    try {
        const disposeOld = make();
        const disposeNew = make();
        const wrapper = cp.spawn;
        disposeOld();
        assert.equal(cp.spawn, wrapper);
        cp.spawn('C:/app/claude-code/2.1.222/claude.exe', ['--model', 'claude-gpt-5.6-luna[1m]'], { env: {
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY: '1',
            CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY: '1',
            KEEP: 'unchanged',
        } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0][2].env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8789');
        assert.equal(calls[0][2].env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-helper-flash[1m]');
        assert.equal(calls[0][2].env.CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY, undefined);
        assert.equal(calls[0][2].env.CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY, undefined);
        assert.equal(calls[0][2].env.KEEP, 'unchanged');
        assert.equal(JSON.parse(calls[0][1].at(-1)).skipWebFetchPreflight, true);
        assert.equal(calls[0][1][1], 'claude-gpt-5.6-luna[1m]');
        cp.spawn('unrelated.exe', [], { env: { KEEP: 'other' } });
        assert.deepEqual(calls[1][2], { env: { KEEP: 'other' } });
        disposeNew();
        assert.equal(cp.spawn, fake);
    } finally { cp.spawn = original; }
});

// The worker's own launch options are the authority for a new session. This
// exercises only a fake child_process spawn; no Desktop session is created.
test('unpinned subagents take the launching provider\'s cheap tier', () => {
    const { subagentDefault } = require('../src/plugins/provider-routing/main');
    assert.equal(subagentDefault('fable-5-1', false), 'claude-sonnet-5-5');
    assert.equal(subagentDefault('', false), 'claude-sonnet-5-5');
    assert.equal(subagentDefault('gpt-5.6-sol', true), 'claude-gpt-5.6-luna[1m]:high');
    assert.equal(subagentDefault('gpt-5.4', false), 'claude-gpt-5.6-luna[1m]:high', 'retired gpt ids still route to OpenAI');
    assert.equal(subagentDefault('muse-spark-1.3', true), 'routed-flash');
    assert.equal(subagentDefault('relay-5.6', false), 'routed-flash');
});

// A public install names no deployment helper or routed tier. A routed session
// must then keep Desktop's helper and leave subagents to inherit, rather than
// pointing either at a model nothing in that tree routes.
test('without deployment defaults a routed session keeps its own helper and tier', () => {
    const held = process.env.CUIMOD_ROUTING_DEFAULTS;
    process.env.CUIMOD_ROUTING_DEFAULTS = require('path').join(require('os').tmpdir(), 'cuimod-no-such-defaults.json');
    try {
        const { subagentDefault, applyRegisteredModelEnvironment } = require('../src/plugins/provider-routing/main');
        assert.equal(subagentDefault('muse-spark-1.3', true), null);
        assert.equal(subagentDefault('fable-5-1', false), 'claude-sonnet-5-5');
        const env = applyRegisteredModelEnvironment({ ANTHROPIC_SMALL_FAST_MODEL: 'relay-one' }, 'relay-one');
        assert.equal('ANTHROPIC_SMALL_FAST_MODEL' in env, false, 'a registered helper is dropped, not replaced by an unroutable one');
    } finally { process.env.CUIMOD_ROUTING_DEFAULTS = held; }
});

test('spawn injects a per-model worker policy and clears inherited overrides', () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-autocompact-'));
    const dir = path.join(root, 'src', 'plugins', 'provider-routing');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    fs.mkdirSync(path.join(root, '.state', 'web-relay'), { recursive: true });
    const settings = path.join(root, '.state', 'settings.json');
    fs.writeFileSync(path.join(root, '.state', 'web-relay', 'models.json'), JSON.stringify({
        version: 1,
        models: [{ id: 'relay-5.6', browserModel: '5.6', name: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'], context: 400000 }],
    }));
    const readOption = (args, name) => {
        const at = args.indexOf(name);
        return at === -1 ? null : args[at + 1];
    };

    const original = cp.spawn;
    const calls = [];
    const dashboardKey = Symbol.for('cuimod.dashboard.settings');
    const heldDashboardState = globalThis[dashboardKey];
    cp.spawn = (...args) => { calls.push(args); return { mock: true }; };
    delete require.cache[require.resolve('../src/plugins/provider-routing/main')];
    const factory = require('../src/plugins/provider-routing/main');
    const disposers = [];
    factory({ dir, electron: { app: {} }, every() {}, method() {}, log() {}, onDispose: f => disposers.push(f) });
    const exe = 'C:/app/claude-code/2.1.260/claude.exe';
    try {
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: true, defaultWindow: 300000, precompute: 'on', perModel: { 'gpt-6-astra': 400000 },
        } }));
        cp.spawn(exe, ['--model', 'claude-gpt-6-astra[1m]', '--settings', '{"ultracode":true}'], {
            env: { DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900k', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' },
        });
        const first = calls.at(-1);
        assert.equal(readOption(first[1], '--autocompact'), '400000');
        assert.deepEqual(JSON.parse(readOption(first[1], '--settings')), {
            ultracode: true, autoCompactEnabled: true, skipWebFetchPreflight: true, precomputeCompactionEnabled: true,
        });
        assert.equal('DISABLE_AUTO_COMPACT' in first[2].env, false);
        assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in first[2].env, false);
        assert.equal('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' in first[2].env, false);

        // The dashboard paints from its authoritative in-memory store. If the
        // atomic disk write fails, launching from the preceding file would make
        // a visible On/400k policy produce an Off/1M worker.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 0, precompute: 'default', perModel: {},
        } }));
        globalThis[dashboardKey] = { store: { 'auto-compact': {
            enabled: true, defaultWindow: 0, precompute: 'default', perModel: { 'gpt-6-astra': 400000 },
        } } };
        cp.spawn(exe, ['--model', 'claude-gpt-6-astra[1m]'], { env: {} });
        const live = calls.at(-1);
        assert.equal(readOption(live[1], '--autocompact'), '400000');
        assert.deepEqual(JSON.parse(readOption(live[1], '--settings')), { autoCompactEnabled: true, skipWebFetchPreflight: true });
        if (heldDashboardState === undefined) delete globalThis[dashboardKey];
        else globalThis[dashboardKey] = heldDashboardState;

        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 300000, precompute: 'off', perModel: {},
        } }));
        cp.spawn(exe, ['--model', 'claude-gemini-3.7-flash'], { env: {} });
        const second = calls.at(-1);
        assert.equal(readOption(second[1], '--autocompact'), '300000');
        assert.deepEqual(JSON.parse(readOption(second[1], '--settings')), {
            autoCompactEnabled: false, skipWebFetchPreflight: true, precomputeCompactionEnabled: false,
        });
        assert.equal('DISABLE_AUTO_COMPACT' in second[2].env, false);

        // A registered provider's rows use bare adapter ids and are capped by its
        // observed window rather than the same model's API capacity. Both the launch policy and the custom-model ceiling must say
        // 400k or Claude Code can silently fall into a wrong custom-model cap.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: true, defaultWindow: 500000, precompute: 'default', perModel: { 'relay-5.6': 450000 },
        } }));
        const concreteAgents = JSON.stringify({ explicit: { model: 'claude-sonnet-5' } });
        cp.spawn(exe, ['--model', 'relay-5.6:pro', '--agents', concreteAgents,
            '--settings', JSON.stringify({ env: { KEEP: 'inline', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inline-haiku' } })], {
            env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '123000', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'inherited-haiku' },
        });
        const cos = calls.at(-1);
        assert.equal(cos[1][1], 'relay-5.6:pro');
        assert.equal(readOption(cos[1], '--autocompact'), '400000');
        assert.equal(cos[2].env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
        assert.equal(readOption(cos[1], '--agents'), concreteAgents, 'concrete agent models must stay explicit');
        const cosSettingsEnv = JSON.parse(readOption(cos[1], '--settings')).env;
        for (const key of familyEnvKeys) {
            assert.equal(cos[2].env[key], 'relay-5.6:pro', key);
            assert.equal(cosSettingsEnv[key], 'relay-5.6:pro', 'inline settings must not override the routed alias');
        }
        assert.equal(cos[2].env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-helper-flash[1m]');
        assert.equal(cosSettingsEnv.ANTHROPIC_SMALL_FAST_MODEL, 'claude-helper-flash[1m]');
        assert.equal(cosSettingsEnv.KEEP, 'inline');
        assert.equal(factory.applyRegisteredModelEnvironment(cosSettingsEnv, 'claude-opus-5').ANTHROPIC_DEFAULT_HAIKU_MODEL, 'inline-haiku');
        assert.equal(factory.applyRegisteredModelEnvironment(cos[2].env, 'claude-opus-5').ANTHROPIC_DEFAULT_HAIKU_MODEL, 'inherited-haiku');
        assert.equal(cos[2].env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);

        // Model discovery is read from disk at each launch. Once the live registered-provider
        // catalogue advertises the verified 1M row, a fresh worker must receive
        // the same value as both its auto-compact window and custom-model cap.
        fs.writeFileSync(path.join(root, '.state', 'web-relay', 'models.json'), JSON.stringify({
            version: 1,
            models: [{ id: 'relay-5.6', browserModel: '5.6', name: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'], context: 1000000 }],
        }));
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: true, defaultWindow: 1000000, precompute: 'default', perModel: {},
        } }));
        cp.spawn(exe, ['--model', 'relay-5.6:pro'], { env: {} });
        const million = calls.at(-1);
        assert.equal(readOption(million[1], '--autocompact'), '1000000');
        assert.equal(million[2].env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
        const millionSettings = JSON.parse(readOption(million[1], '--settings'));
        assert.equal(millionSettings.autoCompactEnabled, true);
        assert.equal(millionSettings.skipWebFetchPreflight, true);

        // A resumed session keeps its own opt-in even though all new sessions
        // default off. The resume id is the CLI session id stored by the button.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 0, precompute: 'default', perModel: {},
            sessionOverrides: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { enabled: true, window: 1000000 } },
        } }));
        cp.spawn(exe, ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--model', 'claude-opus-5'], { env: {} });
        const third = calls.at(-1);
        assert.equal(readOption(third[1], '--autocompact'), '1000000');
        assert.deepEqual(JSON.parse(readOption(third[1], '--settings')), { autoCompactEnabled: true, skipWebFetchPreflight: true });

        // A `window: 0` override is the sentinel the enablement toggle used to
        // write beside every on/off, not a choice. Honouring it launched the
        // session at auto while its model row said otherwise, and painted every
        // row of the per-model table with that one value.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 0, precompute: 'default', perModel: { 'opus-5': 500000 },
            sessionOverrides: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { enabled: true, window: 0 } },
        } }));
        cp.spawn(exe, ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--model', 'claude-opus-5'], { env: {} });
        const masked = calls.at(-1);
        assert.equal(readOption(masked[1], '--autocompact'), '500000');
        assert.deepEqual(JSON.parse(readOption(masked[1], '--settings')), { autoCompactEnabled: true, skipWebFetchPreflight: true });

        // An unconfigured new session defaults off and passes the CLI's auto
        // resolver instead of inventing a router-side threshold.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 0, precompute: 'default', perModel: {},
        } }));
        cp.spawn(exe, ['--model', 'claude-opus-5'], { env: {} });
        const fourth = calls.at(-1);
        assert.equal(readOption(fourth[1], '--autocompact'), 'auto');
        assert.deepEqual(JSON.parse(readOption(fourth[1], '--settings')), {
            autoCompactEnabled: false, skipWebFetchPreflight: true,
        });
        assert.equal('DISABLE_AUTO_COMPACT' in fourth[2].env, false);
        assert.equal(fourth[2].env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8789');
        // A native Claude session keeps Desktop's helper (stock Haiku); only
        // routed sessions get the deployment's stand-in.
        assert.equal('ANTHROPIC_SMALL_FAST_MODEL' in fourth[2].env, false);
        cp.spawn(exe, ['--model', 'claude-opus-5'], { env: { ANTHROPIC_SMALL_FAST_MODEL: 'desktop-helper' } });
        assert.equal(calls.at(-1)[2].env.ANTHROPIC_SMALL_FAST_MODEL, 'desktop-helper');
        cp.spawn(exe, ['--model', 'claude-gpt-5.6-sol[1m]'], { env: {} });
        assert.equal(calls.at(-1)[2].env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-helper-flash[1m]');

        // An unpinned subagent lands on the launching provider's cheap tier,
        // never on the root's model; an explicit launch value is kept.
        assert.equal(calls.at(-1)[2].env.CLAUDE_CODE_SUBAGENT_MODEL, 'claude-gpt-5.6-luna[1m]:high');
        assert.equal(fourth[2].env.CLAUDE_CODE_SUBAGENT_MODEL, 'claude-sonnet-5-5');
        assert.equal(cos[2].env.CLAUDE_CODE_SUBAGENT_MODEL, 'routed-flash');
        cp.spawn(exe, ['--model', 'claude-opus-5'], { env: { CLAUDE_CODE_SUBAGENT_MODEL: 'owner-choice' } });
        assert.equal(calls.at(-1)[2].env.CLAUDE_CODE_SUBAGENT_MODEL, 'owner-choice');
    } finally {
        disposers.forEach(f => f());
        cp.spawn = original;
        if (heldDashboardState === undefined) delete globalThis[dashboardKey];
        else globalThis[dashboardKey] = heldDashboardState;
        delete require.cache[require.resolve('../src/plugins/provider-routing/main')];
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// Desktop 1.44121.4 hands the model selector a catalogue section and renders
// from that; footer.modelItems and its effort section are the retired data path,
// and any footer write re-renders the composer, which closes the popup the tabs
// live in. The tab now filters the catalogue and the footer is read-only apart
// from the id normalization.
test('browsing provider tabs filters the catalogue and never writes the footer', () => {
    const models = [
        {wireId:'claude-gpt-5.6-sol[1m]',name:'Sol',provider:'openai',efforts:['low','medium','high'],defaultEffort:'low'},
        {wireId:'claude-gemini-3.7-flash[1m]',name:'Flash',provider:'gemini',efforts:['low','medium','high'],defaultEffort:'medium'},
        {wireId:'claude-opus-4-6-thinking',name:'Opus 4.6',provider:'claude',efforts:[]},
        {wireId:'relay-5.6',name:'GPT-5.6 Sol',provider:'web-relay',efforts:['none','medium','high','xhigh','pro'],defaultEffort:'none',context:400000},
    ];
    const providers = [{id:'claude',label:'Claude'},{id:'openai',label:'OpenAI'},{id:'gemini',label:'Gemini'},{id:'web-relay',label:'Web Relay'}];
    const listeners = new Set();
    const query = { queryKey: ['current_account'], state: { data: { model_selector_config: [
        { id: 'ccd', models: [{ id: 'claude-opus-5', name: 'Opus 5' }] },
        { id: 'chat', models: [{ id: 'untouched' }] },
    ] } } };
    const client = {
        getQueryCache: () => ({ getAll: () => [query], subscribe: f => { listeners.add(f); return () => listeners.delete(f); } }),
        setQueryData(_key, data) { query.state.data = data; for (const notify of listeners) notify({ query }); },
    };
    let footerWrites = 0;
    const state = { sessionRef: null, footer: { modelId: models[1].wireId, modelItems: [{ value: 'claude-opus-5' }] } };
    const scope = { getState: () => state, subscribe: () => () => {}, setState: () => { footerWrites++; } };
    const element = { __reactFiber$test: { memoizedProps: { scopeStore: scope }, dependencies: { firstContext: { memoizedValue: client } } } };
    const context = { window: {}, document: { querySelectorAll: () => [element], getElementById: () => element }, models, providers, version: 'tab-test', queueMicrotask };
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/page.js'), 'utf8');
    const ccd = () => query.state.data.model_selector_config[0].models.map(m => m.id);
    vm.runInNewContext('(function(models,version){' + source + '\n})(models,version)', context);
    const native = context.window.__cuimod_provider_native;
    // Nobody is browsing yet, so every consumer of the catalogue sees the union.
    assert.deepEqual(ccd(), ['claude-opus-5', ...models.map(m => m.wireId)]);
    native.selectTab(null, 'trigger', true);
    // Opening on a Gemini session opens on the Gemini tab.
    assert.deepEqual(ccd(), [models[1].wireId]);
    // The selected model stays in the list on every tab: the selector resolves
    // its trigger label and effort stops out of the section it is handed. It is
    // named as foreign so the strip can hide the row -- a Gemini session
    // browsing OpenAI must not be shown Gemini among the GPT models.
    const openai = native.selectTab('openai', 'trigger', true);
    assert.equal(openai.tab, 'openai');
    assert.deepEqual([...openai.hidden], [models[1].wireId]);
    assert.deepEqual(ccd(), [models[0].wireId, models[1].wireId]);
    assert.deepEqual([...native.selectTab('gemini', 'trigger', true).hidden], [], 'the session model is native to its own tab');
    assert.deepEqual(ccd(), [models[1].wireId]);
    assert.deepEqual([...native.selectTab('web-relay', 'trigger', true).hidden], [models[1].wireId]);
    assert.deepEqual(ccd(), [models[3].wireId, models[1].wireId]);
    assert.deepEqual([...native.selectTab('claude', 'trigger', true).hidden], [models[1].wireId]);
    assert.deepEqual(ccd(), ['claude-opus-5', models[2].wireId, models[1].wireId]);
    assert.equal(query.state.data.model_selector_config[1].models[0].id, 'untouched');
    assert.deepEqual([...native.selectTab(null, 'trigger', false).hidden], [], 'a closed popup hides nothing');
    assert.deepEqual(ccd(), ['claude-opus-5', ...models.map(m => m.wireId)], 'closing the popup restores the union');
    assert.equal(state.footer.modelId, models[1].wireId, 'browsing tabs must not select a different model');
    assert.equal(footerWrites, 0, 'a footer write re-renders the composer and closes the popup');
    native.dispose();
    assert.deepEqual(ccd(), ['claude-opus-5']);
    assert.equal(listeners.size, 0);
});

test('dynamic Web Relay catalogue uses bare ids, native effort metadata and refreshes from disk', async () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-picker-catalogue-'));
    const modelsFile = path.join(root, 'models.json');
    const previous = process.env.CUIMOD_TEST_RELAY_MODELS;
    const writeModels = models => fs.writeFileSync(modelsFile, JSON.stringify({ version: 1, observedAt: Date.now(), families: [], models }));
    writeModels([{
        id: 'relay-5.6', browserModel: '5.6', name: 'GPT-5.6 Sol', provider: 'web-relay', providerLabel: 'Web Relay',
        efforts: ['none', 'medium', 'high', 'xhigh', 'pro'], defaultEffort: 'none', context: 400000,
        contextNote: 'browser window fixture', aliases: ['gpt-5-6'],
    }]);
    process.env.CUIMOD_TEST_RELAY_MODELS = modelsFile;
    const methods = {};
    const disposers = [];
    try {
        require('../src/plugins/provider-picker/main')({
            dir: path.join(__dirname, '../src/plugins/provider-picker'),
            boot: { MOD_DIR: root },
            electron: { webContents: { getAllWebContents: () => [] } },
            method: (name, fn) => { methods[name] = fn; }, every() {}, onDispose: fn => disposers.push(fn),
        });
        let catalogue = methods.catalogue();
        const cos = catalogue.models.find(model => model.id === 'relay-5.6');
        assert.ok(cos);
        assert.equal(cos.wireId, 'relay-5.6', 'custom adapter id must stay bare in Claude Code');
        assert.equal(cos.context, 400000);
        assert.deepEqual(cos.efforts, ['none', 'medium', 'high', 'xhigh', 'pro']);
        assert.equal(cos.browserModel, undefined, 'browser family identity stays out of page-world metadata');
        assert.equal(cos.aliases, undefined);
        assert.ok(catalogue.providers.some(provider => provider.id === 'web-relay' && provider.label === 'Web Relay'));
        assert.ok((await methods.nativeSync()).models.some(model => model.id === 'relay-5.6' && model.provider === 'web-relay'));

        writeModels([{
            id: 'relay-5.6-pro', browserModel: '5.6', name: 'GPT-5.6 Pro', provider: 'web-relay', providerLabel: 'Web Relay',
            efforts: ['pro'], defaultEffort: 'pro', context: 1000000, aliases: ['gpt-5-6-pro'],
        }]);
        catalogue = methods.catalogue();
        const pro = catalogue.models.find(model => model.id === 'relay-5.6-pro');
        assert.ok(pro);
        assert.equal(pro.name, 'GPT-5.6 Pro');
        assert.equal(pro.wireId, 'relay-5.6-pro[1m]');
        assert.deepEqual(pro.efforts, ['pro']);
        assert.ok((await methods.nativeSync()).models.some(model => model.id === 'relay-5.6-pro[1m]' && model.provider === 'web-relay'));

        writeModels([{
            id: 'relay-6', browserModel: '6', name: 'GPT-6 Pro', provider: 'web-relay', providerLabel: 'Web Relay',
            efforts: ['pro'], defaultEffort: 'pro', context: 400000, aliases: ['gpt-6-pro'],
        }]);
        catalogue = methods.catalogue();
        assert.equal(catalogue.models.some(model => model.id === 'relay-5.6'), false);
        assert.equal(catalogue.models.find(model => model.id === 'relay-6').wireId, 'relay-6');
    } finally {
        disposers.reverse().forEach(fn => fn());
        if (previous === undefined) delete process.env.CUIMOD_TEST_RELAY_MODELS; else process.env.CUIMOD_TEST_RELAY_MODELS = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('model lock protects per-session provider model and effort from account reconciliation', async () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-model-lock-'));
    const dir = path.join(root, 'src', 'plugins', 'model-lock');
    const modelsFile = path.join(root, '.state', 'web-relay', 'models.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
    fs.writeFileSync(modelsFile, JSON.stringify({ version: 1, models: [{ id: 'relay-5.6' }] }));
    const sessionDir = path.join(root, 'userdata', 'claude-code-sessions', 'account', 'org');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'cold-fixture.json'), JSON.stringify({ model: 'relay-5.6[1m]', effort: 'high' }));
    fs.writeFileSync(path.join(sessionDir, 'unknown-fixture.json'), JSON.stringify({ model: 'relay-5.6[1m]' }));
    fs.writeFileSync(path.join(sessionDir, 'other-fixture.json'), JSON.stringify({ model: 'relay-5.6[1m]', effort: 'high' }));
    const previous = process.env.CUIMOD_TEST_RELAY_MODELS;
    process.env.CUIMOD_TEST_RELAY_MODELS = modelsFile;
    const invokes = [], effortInvokes = [];
    const modelKey = 'fixture_$_claude.web_$_LocalSessions_$_setModel';
    const effortKey = 'fixture_$_claude.web_$_LocalSessions_$_setEffort';
    const originalModel = async (_event, sessionId, model) => {
        if (model === 'relay-rejected:pro') throw new Error('native context rejected');
        invokes.push({ sessionId, model }); return true;
    };
    const originalEffort = async (_event, sessionId, effort) => {
        effortInvokes.push({ sessionId, effort }); return true;
    };
    const handlers = new Map([[modelKey, originalModel], [effortKey, originalEffort]]);
    const wc = { ipc: { _invokeHandlers: handlers }, isDestroyed: () => false };
    const methods = {};
    const disposers = [];
    try {
        require('../src/plugins/model-lock/main')({
            dir,
            electron: { app: { getPath: () => path.join(root, 'userdata') }, webContents: { getAllWebContents: () => [wc] } },
            method: (name, fn) => { methods[name] = fn; }, every() {}, log() {}, onDispose: fn => disposers.push(fn),
        });
        const wrappedModel = handlers.get(modelKey);
        const wrappedEffort = handlers.get(effortKey);
        await wrappedEffort({}, 'cold-fixture', 'medium');
        assert.deepEqual(effortInvokes, [], 'cold-start reconciliation must use the authoritative saved effort before permitting a write');
        await wrappedEffort({}, 'unknown-fixture', 'medium');
        assert.deepEqual(effortInvokes, [], 'unknown provider effort ownership must fail closed until a deliberate effort pick establishes it');
        methods.arm({ sessionId: 'cold-fixture', kind: 'model' });
        await wrappedEffort({}, 'cold-fixture', 'medium');
        assert.deepEqual(effortInvokes, [], 'arming the model must not authorize an effort write');
        methods.arm({ sessionId: 'cold-fixture', kind: 'effort' });
        await wrappedEffort({}, 'other-fixture', 'medium');
        assert.deepEqual(effortInvokes, [], 'arming one session must not authorize another session');

        methods.arm({ sessionId: 'session-fixture', kind: 'model' });
        await wrappedModel({}, 'session-fixture', 'relay-5.6[1m]');
        methods.arm({ sessionId: 'session-fixture', kind: 'effort' });
        await wrappedEffort({}, 'session-fixture', 'high');
        assert.deepEqual(invokes.map(row => row.model), ['relay-5.6[1m]']);
        assert.deepEqual(effortInvokes.map(row => row.effort), ['high']);

        await wrappedEffort({}, 'session-fixture', 'medium');
        assert.deepEqual(effortInvokes.map(row => row.effort), ['high'], 'account effort reconciliation must be dropped');
        assert.deepEqual(methods.status().recent.at(-1), {
            kind: 'effort', sessionId: 'session-fixture', model: 'relay-5.6[1m]', from: 'high', to: 'medium',
            at: methods.status().recent.at(-1).at,
        });

        await wrappedModel({}, 'session-fixture', 'claude-opus-5');
        assert.deepEqual(invokes.map(row => row.model), ['relay-5.6[1m]'], 'automatic model reconciliation must be dropped');
        assert.equal(methods.status().recent.at(-1).from, 'relay-5.6[1m]');
        await assert.rejects(wrappedModel({}, 'session-fixture', 'relay-rejected:pro'), /native context rejected/);
        await wrappedModel({}, 'session-fixture', 'claude-opus-5');
        assert.equal(methods.status().recent.at(-1).from, 'relay-5.6[1m]', 'a failed model/context transaction must restore lock ownership');
        for (const content of [JSON.stringify({ version: 1, models: [] }), '{malformed']) {
            fs.writeFileSync(modelsFile, content);
            await wrappedModel({}, 'session-fixture', 'claude-opus-5');
            assert.equal(invokes.length, 1, 'catalogue retirement or corruption must not release a saved registered-provider model');
        }
        fs.unlinkSync(modelsFile);
        await wrappedModel({}, 'session-fixture', 'claude-opus-5');
        assert.equal(invokes.length, 1, 'a missing catalogue must not release the lock');
        await wrappedModel({}, 'alias-fixture', 'CLAUDE-RELAY-RETIRED:PRO[1m]');
        await wrappedModel({}, 'alias-fixture', 'claude-opus-5');
        assert.equal(invokes.length, 2, 'a retired compatibility alias with effort remains owned');

        methods.arm({ sessionId: 'session-fixture', kind: 'effort' });
        await wrappedEffort({}, 'session-fixture', 'medium');
        await wrappedModel({}, 'session-fixture', 'claude-opus-5');
        assert.deepEqual(effortInvokes.map(row => row.effort), ['high', 'medium'], 'a human-armed effort pick must pass');
        assert.equal(invokes.at(-1).model, 'CLAUDE-RELAY-RETIRED:PRO[1m]', 'effort arming must not authorize a model reconciliation');
        methods.arm({ sessionId: 'session-fixture', kind: 'model' });
        await wrappedModel({}, 'session-fixture', 'claude-opus-5');
        assert.deepEqual(invokes.map(row => row.model), ['relay-5.6[1m]', 'CLAUDE-RELAY-RETIRED:PRO[1m]', 'claude-opus-5'], 'a human-armed model pick must still pass');
    } finally {
        disposers.reverse().forEach(fn => fn());
        if (previous === undefined) delete process.env.CUIMOD_TEST_RELAY_MODELS; else process.env.CUIMOD_TEST_RELAY_MODELS = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('picker replacement removes retired rows with either a closed or open popup', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/page.js'), 'utf8');
    for (const browsing of [false, true]) {
        const listeners = new Set();
        const query = { queryKey: ['account'], state: { data: { model_selector_config: [
            { id: 'ccd', models: [{ id: 'claude-opus-5', name: 'Opus 5' }] },
            { id: 'code', models: [{ id: 'claude-opus-5', name: 'Opus 5' }] },
            { id: 'chat', models: [{ id: 'unrelated' }] },
        ] } } };
        const client = {
            getQueryCache: () => ({ getAll: () => [query], subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }),
            setQueryData(_key, data) {
                query.state.data = JSON.parse(JSON.stringify(data));
                for (const fn of listeners) fn({ query });
            },
        };
        const state = { footer: { modelId: 'relay-old' } };
        const scope = { getState: () => state, subscribe: () => () => {}, setState: patch => Object.assign(state, patch) };
        const el = { __reactFiber$test: { memoizedProps: { scopeStore: scope }, dependencies: { firstContext: { memoizedValue: client } } } };
        // The retired id is no longer listed, so only the declared pattern can
        // still attribute it to its provider.
        const context = { window: {}, document: { querySelectorAll: () => [el], getElementById: () => el }, queueMicrotask,
            providers: [{ id: 'claude', label: 'Claude' }, { id: 'web-relay', label: 'Web Relay' }],
            registered: [{ provider: 'web-relay', pattern: '^relay-[a-z0-9._-]{1,80}$' }] };
        const run = (id, version) => {
            context.models = [{ id, wireId: id, provider: 'web-relay', name: id, efforts: ['pro'], defaultEffort: 'pro', context: 400000 }];
            context.version = version;
            return vm.runInNewContext('(function(models,providers,version,registered){' + source + '\n})(models,providers,version,registered)', context);
        };
        run('relay-old', 'old');
        context.window.__cuimod_provider_native.selectTab('web-relay', 'trigger', browsing);
        const snapshot = run('relay-new', 'new');
        for (const section of query.state.data.model_selector_config.slice(0, 2))
            assert.deepEqual(section.models.map(row => row.id), ['claude-opus-5', 'relay-new']);
        assert.deepEqual(Array.from(snapshot.nativeModels, row => row.id), ['claude-opus-5']);
        assert.equal(state.footer.modelId, 'relay-old', 'retirement must not select a different model');
        assert.equal(snapshot.scopes[0].provider, 'web-relay');
        assert.equal(listeners.size, 1, 'only the current query subscription survives replacement');
        context.window.__cuimod_provider_native.selectTab('web-relay', 'trigger', true);
        assert.deepEqual(query.state.data.model_selector_config[0].models.map(row => row.id), ['relay-new']);
        context.window.__cuimod_provider_native.dispose();
        assert.equal(listeners.size, 0);
        assert.deepEqual(query.state.data.model_selector_config[0].models.map(row => row.id), ['claude-opus-5']);
        assert.deepEqual(query.state.data.model_selector_config[2].models.map(row => row.id), ['unrelated']);
    }
});

test('picker resolves effort and context-tag aliases on both web and OAuth models', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/page.js'), 'utf8');
    const models = [
        { wireId: 'relay-fixture', name: 'Web', provider: 'web-relay', efforts: ['pro', 'ultra'] },
        { wireId: 'claude-gpt-fixture[1m]', name: 'OAuth', provider: 'openai', efforts: ['high'] },
    ];
    for (const [id, expected] of [
        ['relay-fixture:pro', models[0]], ['CLAUDE-RELAY-FIXTURE:ULTRA[1m]', models[0]],
        ['claude-gpt-fixture[1m]:high', models[1]], ['claude-claude-gpt-fixture:high[1m]', models[1]],
    ]) {
        const state = { footer: { modelId: id } };
        const scope = { getState: () => state, subscribe: () => () => {}, setState: patch => Object.assign(state, patch) };
        const el = { __reactFiber$test: { memoizedProps: { scopeStore: scope } } };
        const context = { models, providers: [{ id: 'claude' }, { id: 'openai' }, { id: 'web-relay' }], version: 'aliases',
            window: {}, document: { querySelectorAll: () => [el] }, queueMicrotask: fn => fn() };
        const snapshot = vm.runInNewContext('(function(models,providers,version){' + source + '\n})(models,providers,version)', context);
        assert.equal(snapshot.scopes[0].provider, expected.provider, id);
        assert.equal(state.footer.modelId, expected.wireId, id);
        context.window.__cuimod_provider_native.dispose();
    }
});

test('native catalog converges with structural sharing and bootstrap refreshes', () => {
    let changes = 0;
    const listeners = new Set();
    const query = { queryKey: ['current_account'], state: { data: { model_selector_config: [
        { id: 'code', models: [{ id: 'claude-opus-5', name: 'Opus 5' }] },
        { id: 'ccd', models: [{ id: 'claude-opus-5', name: 'Opus 5' }] },
        { id: 'chat', models: [{ id: 'untouched' }] },
    ] } } };
    const client = {
        getQueryCache: () => ({ getAll: () => [query], subscribe: f => { listeners.add(f); return () => listeners.delete(f); } }),
        setQueryData(_key, data) {
            assert.ok(++changes < 10, 'recursive catalog update');
            // Deliberately break object identity, as React Query structural
            // sharing can do when equal values already exist in the cache.
            query.state.data = JSON.parse(JSON.stringify(data));
            for (const notify of listeners) notify({ query });
        },
    };
    const scope = { getState: () => ({ sessionRef: null }), subscribe: () => () => {} };
    const element = { __reactFiber$test: { memoizedProps: { scopeStore: scope }, dependencies: { firstContext: { memoizedValue: client } } } };
    const context = { window: {}, document: { querySelectorAll: () => [element] }, models: [{ wireId: 'claude-gpt-5.6-luna[1m]', name: 'Luna', provider: 'openai', efforts: ['low','medium','high','xhigh','max'], defaultEffort: 'medium', context: 1000000 }], providers: [{id:'claude',label:'Claude'},{id:'openai',label:'OpenAI'}], version: 'test' };
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/page.js'), 'utf8');
    const run = () => vm.runInNewContext('(function(models,version){' + source + '\n})(models,version)', context);
    assert.equal(run().installed, true);
    run(); run();
    assert.equal(changes, 1);
    assert.equal(listeners.size, 1);
    // Both surfaces carry the entry: the desktop reads "ccd" as of 1.44121.4 and
    // "code" is still served to whatever else asks the account for it.
    assert.equal(query.state.data.model_selector_config[0].models.length, 2);
    assert.equal(query.state.data.model_selector_config[1].models.length, 2);
    assert.equal(query.state.data.model_selector_config[2].models[0].id, 'untouched');
    delete query.state.data.model_selector_config[0].__cuimodProviderVersion;
    delete query.state.data.model_selector_config[1].__cuimodProviderVersion;
    query.state.data.model_selector_config[0].models = [{id:'claude-opus-5'}];
    query.state.data.model_selector_config[1].models = [{id:'claude-opus-5'}];
    for (const notify of listeners) notify({query});
    assert.equal(changes, 2);
    assert.equal(query.state.data.model_selector_config[1].models.length, 2);
    context.window.__cuimod_provider_native.dispose();
    assert.equal(listeners.size, 0);
    assert.equal(query.state.data.model_selector_config[1].models.length, 1);
});

// The shipped catalogue is the single source the router resolves compatible
// providers from, so what it carries is the whole enablement -- assert on the
// catalogue, not on the router. These guards are about what leaves this
// process: a backend block belongs in the catalogue file and nowhere else, and
// the credential belongs in neither. The private half, covering entries that
// only a deployment carrying an adapter can route, is
// tests/private/private-catalogue.test.js.
test('the picker serializes model metadata and nothing routable', () => {
    const factory = require('../src/plugins/provider-picker/main');
    const methods = {};
    const dispose = [];
    factory({
        dir: path.join(__dirname, '../src/plugins/provider-picker'),
        electron: { webContents: { getAllWebContents: () => [] } },
        method: (name, fn) => { methods[name] = fn; },
        every() {},
        onDispose: fn => dispose.push(fn),
    });
    const catalogue = methods.catalogue();
    const raw = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/catalogue.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.length, 'an empty catalogue would make every check below vacuous');
    assert.ok(parsed.some(model => model.backend), 'no entry carries a backend; the credential checks would not run');
    const openaiIds = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-luna'];
    assert.deepEqual(parsed.filter(model => model.provider === 'openai').map(model => model.id), openaiIds);
    assert.deepEqual(catalogue.models.filter(model => model.provider === 'openai').map(model => model.id), openaiIds);

    // A catalogue entry names its credential by key; the value lives only in
    // the ignored state file. Nothing key-shaped may appear in either the
    // file or the payload the renderer receives.
    for (const model of parsed)
    {
        if (!model.backend) continue;
        assert.equal(typeof model.backend.secret, 'string');
        assert.ok(model.backend.secret.length > 0);
    }
    assert.equal(/sk-[A-Za-z0-9_-]{16,}/.test(raw), false, 'catalogue must carry no credential');

    // The picker strips backend blocks before serializing models into the
    // page, so neither the upstream host nor the key reaches the renderer.
    assert.ok(catalogue.models.every(model => model.backend === undefined));
    assert.equal(/https?:\/\//.test(JSON.stringify(catalogue)), false, 'no backend host reaches the renderer');
    assert.equal(/sk-[A-Za-z0-9_-]{16,}/.test(JSON.stringify(catalogue)), false);

    // Every entry in the SHIPPED file must be claimable by an arm this tree
    // compiles in. catalogue.private.json is absent from the published tree
    // and an adapter is not guaranteed to be there either, so a private-only
    // provider added to catalogue.json would be offered in the menu, claimed
    // by nothing, and answered as Claude under its own label.
    //
    // This is the same rule scripts/publish-public.mjs enforces, asserted here
    // because that script is not part of `npm run check` -- without this the
    // boundary is guarded only at publish time. Note it reads `parsed`, the
    // shipped file, not `catalogue`, which the picker merges with the private
    // half whenever one is present.
    for (const model of parsed)
    {
        const routable = !!model.backend                                    // catalogue-driven forwarder
            || model.provider === 'claude'                                  // Anthropic passthrough
            || model.provider === 'openai' || /^(gpt|o[0-9])/i.test(model.id)   // OpenAI Responses
            // An adapter this tree ships (scripts/publish-public.mjs PUBLIC_ADAPTERS)
            // claims its own provider's rows; tests/command-code-adapter.test.mjs
            // checks it claims each one.
            || fs.existsSync(path.join(__dirname, '../router/adapters', model.provider, 'index.mjs'));
        assert.ok(routable, `${model.id} (${model.provider}) is offered but no compiled-in arm claims it`);
    }

    dispose.forEach(fn => fn());
});
