'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cp = require('child_process');
const { EventEmitter } = require('node:events');

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
    const fakeHttp = { get(_url, callback) {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = () => req.emit('error', new Error('timeout'));
        probes.push(() => healthy ? callback({ statusCode: 200, resume() {} }) : req.emit('error', new Error('refused')));
        return req;
    } };
    const sandbox = {
        module: { exports: {} }, __dirname: path.join(__dirname, '../src/plugins/provider-routing'),
        require: name => ({ fs: { existsSync: () => true }, path, http: fakeHttp, child_process: childProcess })[name],
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
        cp.spawn('C:/app/claude-code/2.1.222/claude.exe', ['--model', 'claude-gpt-5.6-luna[1m]'], { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', KEEP: 'unchanged' } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0][2].env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8789');
        assert.equal(calls[0][2].env.KEEP, 'unchanged');
        assert.equal(calls[0][1][1], 'claude-gpt-5.6-luna[1m]');
        cp.spawn('unrelated.exe', [], { env: { KEEP: 'other' } });
        assert.deepEqual(calls[1][2], { env: { KEEP: 'other' } });
        disposeNew();
        assert.equal(cp.spawn, fake);
    } finally { cp.spawn = original; }
});

// The worker's own launch options are the authority for a new session. This
// exercises only a fake child_process spawn; no Desktop session is created.
test('spawn injects a per-model worker policy and clears inherited overrides', () => {
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-autocompact-'));
    const dir = path.join(root, 'src', 'plugins', 'provider-routing');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    const settings = path.join(root, '.state', 'settings.json');
    const readOption = (args, name) => {
        const at = args.indexOf(name);
        return at === -1 ? null : args[at + 1];
    };

    const original = cp.spawn;
    const calls = [];
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
            ultracode: true, autoCompactEnabled: true, precomputeCompactionEnabled: true,
        });
        assert.equal('DISABLE_AUTO_COMPACT' in first[2].env, false);
        assert.equal('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in first[2].env, false);
        assert.equal('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' in first[2].env, false);

        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 300000, precompute: 'off', perModel: {},
        } }));
        cp.spawn(exe, ['--model', 'claude-gemini-3.7-flash'], { env: {} });
        const second = calls.at(-1);
        assert.equal(readOption(second[1], '--autocompact'), '300000');
        assert.deepEqual(JSON.parse(readOption(second[1], '--settings')), {
            autoCompactEnabled: false, precomputeCompactionEnabled: false,
        });
        assert.equal('DISABLE_AUTO_COMPACT' in second[2].env, false);

        // A resumed session keeps its own opt-in even though all new sessions
        // default off. The resume id is the CLI session id stored by the button.
        fs.writeFileSync(settings, JSON.stringify({ 'auto-compact': {
            enabled: false, defaultWindow: 0, precompute: 'default', perModel: {},
            sessionOverrides: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { enabled: true, window: 1000000 } },
        } }));
        cp.spawn(exe, ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--model', 'claude-opus-5'], { env: {} });
        const third = calls.at(-1);
        assert.equal(readOption(third[1], '--autocompact'), '1000000');
        assert.deepEqual(JSON.parse(readOption(third[1], '--settings')), { autoCompactEnabled: true });

        // An unconfigured new session defaults off and passes the CLI's auto
        // resolver instead of inventing a router-side threshold.
        cp.spawn(exe, ['--model', 'claude-opus-5'], { env: {} });
        const fourth = calls.at(-1);
        assert.equal(readOption(fourth[1], '--autocompact'), 'auto');
        assert.deepEqual(JSON.parse(readOption(fourth[1], '--settings')), { autoCompactEnabled: false });
        assert.equal('DISABLE_AUTO_COMPACT' in fourth[2].env, false);
        assert.equal(fourth[2].env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8789');
    } finally {
        disposers.forEach(f => f());
        cp.spawn = original;
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
    ];
    const providers = [{id:'claude',label:'Claude'},{id:'openai',label:'OpenAI'},{id:'gemini',label:'Gemini'}];
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
            || model.provider === 'openai' || /^(gpt|o[0-9])/i.test(model.id);  // OpenAI Responses
        assert.ok(routable, `${model.id} (${model.provider}) is offered but no compiled-in arm claims it`);
    }

    dispose.forEach(fn => fn());
});
