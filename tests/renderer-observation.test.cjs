'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const desktop = id => 'local_' + id;
const route = id => '/epitaxy/' + desktop(id);

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush(rounds = 8) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function scheduler() {
    let next = 1;
    const timeouts = new Map();
    const intervals = [];
    return {
        intervals,
        setTimeout(fn, ms) { const id = next++; timeouts.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval(fn, ms) { const id = next++; intervals.push({ id, fn, ms }); return id; },
        clearInterval() {},
        runTimeouts(ms) {
            const ready = [...timeouts].filter(([, value]) => value.ms === ms);
            for (const [id, value] of ready) { timeouts.delete(id); value.fn(); }
        },
        pendingTimeouts: () => [...timeouts.values()].map(value => value.ms),
        tick(ms) {
            for (const entry of intervals.filter(value => value.ms === ms)) entry.fn();
        },
    };
}

class FakeNode {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.className = '';
        this.hidden = false;
        this.isConnected = true;
        this.parentElement = null;
        this._textContent = '';
        Object.defineProperty(this, 'textContent', {
            get: () => this._textContent + this.children.map(child => typeof child === 'object' ? child.textContent : String(child)).join(''),
            set: value => { this._textContent = String(value ?? ''); this.children = []; },
        });
        this.style = {
            cssText: '',
            setProperty: (key, value) => { this.style[key] = value; },
            getPropertyValue: key => this.style[key] || '',
            removeProperty: key => { delete this.style[key]; },
        };
        const held = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => held.add(name)),
            remove: (...names) => names.forEach(name => held.delete(name)),
            toggle: (name, force) => {
                if (force === undefined ? !held.has(name) : force) held.add(name);
                else held.delete(name);
            },
            contains: name => held.has(name),
        };
    }
    append(...nodes) { for (const node of nodes) { if (node == null) continue; this.children.push(node); if (typeof node === 'object') node.parentElement = this; } }
    appendChild(node) { this.append(node); return node; }
    after() {}
    addEventListener() {}
    removeEventListener() {}
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const cls = selector.startsWith('.') ? selector.slice(1) : null;
        const out = [];
        const visit = node => {
            for (const child of node.children || []) {
                if (typeof child !== 'object') continue;
                if (cls && String(child.className || '').split(/\s+/).includes(cls)) out.push(child);
                visit(child);
            }
        };
        visit(this);
        return out;
    }
    replaceWith() {}
    remove() { this.isConnected = false; }
    attachShadow() { return new FakeNode('shadow'); }
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, width: 0, height: 0 }; }
    get firstElementChild() { return this.children.find(node => typeof node === 'object') || null; }
    get lastElementChild() { return [...this.children].reverse().find(node => typeof node === 'object') || null; }
}

function fakeDocument() {
    const documentElement = new FakeNode('html');
    const head = new FakeNode('head');
    return {
        documentElement,
        head,
        createElement: tag => new FakeNode(tag),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
    };
}

function bridgeHarness() {
    const clock = scheduler();
    const location = { pathname: route(A), search: '' };
    const resolveCalls = [];
    const listCalls = [];
    const boot = {
        rpc(method, params) {
            const call = { method, params, ...deferred() };
            if (method === 'tasks.resolve') resolveCalls.push(call);
            else if (method === 'tasks.list') listCalls.push(call);
            else throw new Error('unexpected rpc ' + method);
            return call.promise;
        },
        log() {}, eipc: () => '', observeInvoke: () => () => {}, appOn: () => () => {},
    };
    const source = fs.readFileSync(path.join(__dirname, '../src/runtime/bridge.js'), 'utf8');
    const capture = `
        globalThis.bridgeView = {
            events: [], taskEvents: 0,
            read: () => ({ sessionId: cuimod.sessionId, tasks: cuimod.getTasks() })
        };
        globalThis.bridgeView.stopSession = cuimod.onSessionChange(id => globalThis.bridgeView.events.push(id));
        cuimod.onTasksChange(() => globalThis.bridgeView.taskEvents++);
    `;
    const context = {
        boot, plugins: [{ name: 'capture', source: capture }], location,
        window: { addEventListener() {}, removeEventListener() {} },
        ...clock,
    };
    const bridge = vm.runInNewContext('(function(boot,plugins){' + source + '\n})(boot,plugins)', context);
    return { clock, location, resolveCalls, listCalls, boot, bridge, view: context.bridgeView };
}

function navigate(harness, id) {
    harness.location.pathname = route(id);
    harness.clock.tick(500);
    harness.clock.runTimeouts(0);
    harness.clock.runTimeouts(200);
}

test('bridge resolution is owned by the full A to B to A navigation generation', async () => {
    const h = bridgeHarness();
    assert.equal(h.resolveCalls.length, 1);
    navigate(h, B);
    navigate(h, A);
    await flush();
    assert.equal(h.resolveCalls.length, 3, 'each new URL generation must resolve without waiting for an obsolete request');

    h.resolveCalls[0].resolve('cli-old-a');
    h.resolveCalls[1].resolve('cli-b');
    await flush();
    assert.deepEqual(Array.from(h.view.events), [], 'obsolete answers cannot publish a session');

    h.resolveCalls[2].resolve('cli-current-a');
    await flush();
    assert.equal(h.listCalls.length, 1);
    h.listCalls[0].resolve([{ id: 'current-task' }]);
    await flush();
    assert.equal(h.view.events.at(-1), 'cli-current-a');
    assert.deepEqual(await h.view.read().tasks, [{ id: 'current-task' }]);
    h.bridge.dispose();
});

test('session subscriptions can be released by a renderer generation', async () => {
    const h = bridgeHarness();
    h.resolveCalls[0].resolve('cli-a');
    await flush();
    assert.deepEqual(Array.from(h.view.events), ['cli-a']);

    h.view.stopSession();
    navigate(h, B);
    await flush();
    h.resolveCalls[1].resolve('cli-b');
    await flush();
    assert.deepEqual(Array.from(h.view.events), ['cli-a']);
    h.bridge.dispose();
});

test('late task results cannot cross an accepted session epoch', async () => {
    const h = bridgeHarness();
    h.resolveCalls[0].resolve('cli-a');
    await flush();
    assert.equal(h.listCalls.length, 1);

    navigate(h, B);
    await flush();
    assert.equal(h.resolveCalls.length, 2);
    h.resolveCalls[1].resolve('cli-b');
    await flush();
    assert.equal(h.listCalls.length, 2);
    h.listCalls[1].resolve([{ id: 'b-task' }]);
    await flush();
    h.listCalls[0].resolve([{ id: 'late-a-task' }]);
    await flush();

    assert.equal(h.view.events.at(-1), 'cli-b');
    assert.deepEqual(await h.view.read().tasks, [{ id: 'b-task' }]);
    assert.equal(h.view.taskEvents, 1);
    h.bridge.dispose();
});

function rendererContext() {
    const clock = scheduler();
    const document = fakeDocument();
    const location = { pathname: route(A), search: '' };
    const disposers = [];
    const tracks = [];
    const sessionCallbacks = [];
    const registry = { specs: new Map(), subs: new Set([() => {}]), set() {}, get() { return {}; } };
    const context = {
        document, location, window: { addEventListener() {}, removeEventListener() {} },
        CSSStyleSheet: class { replaceSync() {} },
        MutationObserver: class { observe() {} disconnect() {} },
        requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {}, queueMicrotask,
        globalThis: null, __cuimodReg: registry, ...clock,
    };
    context.globalThis = context;
    const ctx = {
        onDispose: fn => disposers.push(fn), every: clock.setInterval,
        track(target, type, fn, options) { tracks.push({ target, type, fn, options }); }, observe() {},
    };
    return { clock, context, document, location, disposers, tracks, sessionCallbacks, registry, ctx };
}

function usageHarness() {
    const h = rendererContext();
    const contextCalls = [];
    const limitCalls = [];
    let selectedModel = 'claude-gpt-a[1m]';
    let holdLimits = false;
    const cuimod = {
        eipc: () => 'context-channel', contextCountInfo: () => ({ exact: true, description: 'exact' }),
        onSessionChange: fn => h.sessionCallbacks.push(fn),
        appInvoke(_channel, id) { const call = { id, ...deferred() }; contextCalls.push(call); return call.promise; },
        async rpc(method, params) {
            if (method === 'usage-bar.native') return { model: selectedModel, label: selectedModel, limits: [] };
            if (method === 'usage-bar.allLimits') {
                const value = { provider: /gpt/.test(params.model) ? 'openai' : 'claude' };
                if (!holdLimits) return value;
                const call = { params, ...deferred() };
                limitCalls.push(call);
                return call.promise;
            }
            throw new Error('unexpected rpc ' + method);
        },
    };
    let source = fs.readFileSync(path.join(__dirname, '../src/plugins/usage-bar/renderer.js'), 'utf8');
    source += '\nglobalThis.__usageTest = { refresh, snapshot, findRow, place, setData: value => { data = value; }, setPlacement: (nextHost, nextShadow, nextCfg) => { host = nextHost; shadow = nextShadow; cfg = nextCfg; }, getData: () => data, getRefresh: () => ({ refreshGeneration, refreshQueued, active: !!refreshFlight }) };';
    vm.runInNewContext('(function(cuimod,ctx){' + source + '\n})(cuimod,ctx)', { ...h.context, cuimod, ctx: h.ctx });
    return { ...h, cuimod, contextCalls, limitCalls,
        setModel: value => { selectedModel = value; },
        holdLimits: value => { holdLimits = value; },
        testApi: h.context.__usageTest };
}

function changeRendererSession(h, id) {
    h.location.pathname = route(id);
    for (const callback of h.sessionCallbacks) callback('cli-' + id);
}

function contextValue(model, totalTokens, rawMaxTokens = 1000000) {
    return { model, totalTokens, rawMaxTokens, isAutoCompactEnabled: true,
        autoCompactThreshold: Math.max(1, rawMaxTokens - 33000), autocompactSource: 'settings' };
}

test('usage observation accepts only the current A to B to A generation', async () => {
    const h = usageHarness();
    const first = h.testApi.refresh();
    changeRendererSession(h, B);
    changeRendererSession(h, A);
    await flush();
    assert.equal(h.contextCalls.length, 3);

    h.contextCalls[0].resolve(contextValue('old-a', 530000));
    h.contextCalls[1].reject(new Error('stale B rejection'));
    await flush();
    assert.equal(h.testApi.getData().ctx, null);

    h.contextCalls[2].resolve(contextValue('current-a', 180000));
    await Promise.allSettled([first]);
    await flush();
    assert.equal(h.testApi.getData().ctx.model, 'current-a');
    assert.equal(h.testApi.getData().ctx.totalTokens, 180000);
});

test('a hung obsolete usage request cannot block the active session', async () => {
    const h = usageHarness();
    h.testApi.refresh();
    changeRendererSession(h, B);
    await flush();
    assert.equal(h.contextCalls.length, 2);
    h.contextCalls[1].resolve(contextValue('current-b', 210000));
    await flush();
    assert.equal(h.testApi.getData().ctx.model, 'current-b');
});

test('a timed-out current observation releases one coalesced retry', async () => {
    const h = usageHarness();
    h.testApi.refresh();
    await flush();
    h.testApi.refresh();
    h.testApi.refresh();
    h.clock.runTimeouts(5000);
    await flush(100);
    assert.equal(h.contextCalls.length, 2, 'one retry should replace a timed-out flight: '
        + JSON.stringify({ state: h.testApi.getRefresh(), timers: h.clock.pendingTimeouts() }));
    h.contextCalls[1].resolve(contextValue('retry-a', 200000));
    await flush();
    assert.equal(h.testApi.getData().ctx.model, 'retry-a');
});

test('a model switch cannot associate an older limits response with the new selection', async () => {
    const h = usageHarness();
    h.holdLimits(true);
    h.testApi.refresh(true);
    await flush();
    h.contextCalls[0].resolve(contextValue('worker-a', 200000));
    await flush(20);
    assert.equal(h.limitCalls.length, 1);
    h.setModel('claude-gpt-b[1m]');
    h.limitCalls[0].resolve({ provider: 'openai', openai: { marker: 'old-model' } });
    await flush(20);
    assert.equal(h.testApi.getData().native.model, 'claude-gpt-b[1m]');
    assert.equal(h.testApi.getData().openai, null);
    assert.equal(h.contextCalls.length, 2, 'the confirmed model change queues a current refresh');
});

test('single-subscription windows show percentage-only usage with precise reset countdowns', () => {
    const h = usageHarness();
    h.testApi.setData({
        native: { model: 'claude-oss-model[1m]' },
        provider: 'metered-backend',
        pool: {
            credits: { totalRemaining: 14.8 },
            windowLimits: {
                limited: true,
                fiveHour: { used: 7, cap: 14, resetAt: 4 * 3600 + 17 * 60 },
                weekly: { used: 21, cap: 35, resetAt: 3 * 86400 + 2 * 3600 + 9 * 60 },
            },
        },
    });

    const value = h.testApi.snapshot();
    assert.equal(value.provider, 'metered-backend');
    assert.equal(value.error, '');
    assert.equal(value.rows.length, 2);
    assert.equal(value.rows[0].label, '5-hour limit');
    assert.equal(value.rows[0].pct, 50);
    assert.equal(value.rows[0].reset, 'Resets in 4h 17m');
    assert.equal(value.rows[0].insight.text, '');
    assert.equal(value.rows[1].label, 'Weekly · all models');
    assert.equal(value.rows[1].pct, 60);
    assert.equal(value.rows[1].reset, 'Resets in 3d 2h 9m');
    assert.equal(value.rows[1].insight.text, '');
    assert.equal(value.ringRow.key, 'weekly', 'the ring must show the more consumed subscription window');
});

test('pooled weekly limits retain account identity and choose a schedulable ring row', () => {
    const h = usageHarness();
    h.testApi.setData({
        native: { model: 'claude-acme-model[1m]' },
        provider: 'acme',
        pool: { quotaLabel: 'weekly', accounts: [
            { id: 13, name: 'Account 13', status: 'active', schedulable: true,
                quotas: { 'acme-model': { utilization: 33, remainingFraction: 0.67,
                    resetTime: '2030-01-08T00:00:00Z', windowSeconds: 604800 } } },
            { id: 14, name: 'Account 14', status: 'active', schedulable: false,
                quotas: { 'acme-model': { utilization: 0, remainingFraction: 1, windowSeconds: 604800 } } },
            { id: 15, name: 'Account 15', status: 'inactive', schedulable: false,
                quotas: { 'acme-model': { utilization: 10, remainingFraction: 0.9, windowSeconds: 604800 } } },
            { id: 16, name: 'Account 16', status: 'active', schedulable: true, quotas: {} },
        ] },
    });

    const value = h.testApi.snapshot();
    assert.equal(value.provider, 'acme');
    assert.equal(value.rows.length, 2);
    assert.equal(value.rows[0].label, 'Account 13 · Weekly');
    assert.equal(value.rows[0].pct, 33);
    assert.equal(value.ringRow.key, '13');
    assert.equal(value.notice, '1 schedulable account has no weekly reading');
});

test('a pool policy shows one weekly meter across all schedulable accounts', () => {
    const h = usageHarness();
    const accounts = Array.from({ length: 9 }, (_, index) => ({
        id: index + 1, status: 'active', schedulable: true,
        quotas: index < 2 ? { 'acme-model': { utilization: index === 0 ? 23 : 8 } } : {},
    }));
    accounts.push({ id: 10, status: 'inactive', schedulable: false,
        quotas: { 'acme-model': { utilization: 100 } } });
    h.testApi.setData({ native: { model: 'claude-acme-model[1m]' }, provider: 'acme',
        pool: { poolMeter: { label: 'Weekly pool', missingUsedPercent: 0 }, accounts } });

    const value = h.testApi.snapshot();
    assert.equal(value.rows.length, 1);
    assert.equal(value.rows[0].key, 'pool');
    assert.equal(value.rows[0].label, 'Weekly pool · 9 accounts');
    assert.equal(value.rows[0].pct, 31 / 9);
    assert.equal(value.rows[0].percentLabel, '3.4%');
    assert.equal(value.rows[0].insight.text, '');
    assert.equal(value.ringRow, value.rows[0]);
    assert.equal(value.notice, '');

    for (const account of accounts) account.quotas = {};
    assert.equal(h.testApi.snapshot().rows[0].pct, 0);
});

test('same-session decreases and denominator changes remain visible', async () => {
    const h = usageHarness();
    const first = h.testApi.refresh();
    await flush();
    h.contextCalls[0].resolve(contextValue('worker-a', 530000, 1000000));
    await first;
    const second = h.testApi.refresh();
    await flush();
    h.contextCalls[1].resolve(contextValue('worker-a', 180000, 400000));
    await second;
    assert.equal(h.testApi.getData().ctx.totalTokens, 180000);
    assert.equal(h.testApi.getData().ctx.rawMaxTokens, 400000);
});

test('disposed usage observations cannot commit late responses', async () => {
    const h = usageHarness();
    h.testApi.refresh();
    await flush();
    for (const dispose of h.disposers) dispose();
    h.contextCalls[0].resolve(contextValue('late-a', 530000));
    await flush();
    assert.equal(h.testApi.getData().ctx, null);
});

test('usage placement follows the composer logical-margin control group', () => {
    const h = usageHarness();
    const prompt = new FakeNode('div');
    const row = new FakeNode('div');
    const left = new FakeNode('div');
    const right = new FakeNode('div');
    right.className = 'ms-auto flex min-w-0 items-center';
    row.append(left, right);
    row.getBoundingClientRect = () => ({ left: 100, right: 868, top: 600, bottom: 620, width: 768, height: 20 });
    left.getBoundingClientRect = () => ({ left: 108, right: 300, top: 600, bottom: 620, width: 192, height: 20 });
    right.getBoundingClientRect = () => ({ left: 680, right: 868, top: 600, bottom: 620, width: 188, height: 20 });
    prompt.querySelectorAll = selector => selector.includes('[class*="ms-auto"]') ? [right] : [];
    h.document.querySelector = selector => selector === '.epitaxy-prompt' ? prompt : null;

    const found = h.testApi.findRow();
    assert.equal(found.row, row);
    assert.equal(found.right, right);

    let voiceRect = { left: 308, right: 348, top: 600, bottom: 620, width: 40, height: 20 };
    const voicePill = new FakeNode('div');
    voicePill.getBoundingClientRect = () => voiceRect;
    const voiceHost = new FakeNode('div');
    voiceHost.shadowRoot = { querySelector: selector => selector === '.pill.on' ? voicePill : null };
    h.document.getElementById = id => id === 'cuimod-voice-agent' ? voiceHost : null;
    const wrap = new FakeNode('div');
    const placementHost = new FakeNode('div');
    const placementShadow = { querySelector: selector => selector === '.wrap' ? wrap : null };
    h.testApi.setPlacement(placementHost, placementShadow, { enabled: true, composerContext: true });
    h.testApi.place();
    assert.equal(wrap.style.left, '362px');
    assert.equal(wrap.style.width, '304px');

    voiceRect = { left: -9999, right: -9959, top: -9999, bottom: -9979, width: 40, height: 20 };
    h.testApi.place();
    assert.equal(wrap.style.left, '314px');
    assert.equal(wrap.style.width, '352px');

    voiceRect = { left: 308, right: 348, top: 600, bottom: 620, width: 40, height: 20 };
    const voiceLayout = h.tracks.find(entry => entry.type === 'cuimod:voice-layout');
    assert.ok(voiceLayout);
    voiceLayout.fn();
    assert.equal(wrap.style.left, '362px');
    assert.equal(wrap.style.width, '304px');
    for (const dispose of h.disposers) dispose();
});

function autoHarness() {
    const h = rendererContext();
    const applyCalls = [];
    const writes = [];
    let cliSessionId = 'cli-a';
    let stored = {};
    h.registry.set = (_plugin, key, value) => { if (key === 'sessionOverrides') { stored = value; writes.push(value); } };
    h.registry.get = () => ({ sessionOverrides: stored });
    const cuimod = {
        eipc: () => 'context-channel', onSessionChange: fn => h.sessionCallbacks.push(fn),
        get sessionId() { return cliSessionId; },
        appInvoke(_channel, id) { const call = { id, ...deferred() }; applyCalls.push({ type: 'observe', ...call }); return call.promise; },
        rpc(method, params) {
            if (method === 'auto-compact.apply') { const call = { method, params, ...deferred() }; applyCalls.push(call); return call.promise; }
            if (method === 'auto-compact.models') return Promise.resolve([]);
            if (method === 'provider-picker.nativeSync') return Promise.resolve({ nativeModels: [] });
            throw new Error('unexpected rpc ' + method);
        },
    };
    let source = fs.readFileSync(path.join(__dirname, '../src/plugins/auto-compact/renderer.js'), 'utf8');
    source += `\nglobalThis.__autoTest = {
        spec, send, refreshObserved, observedSection, buildObserved, updateObserved,
        setObserved: value => { observed = value; },
        getState: () => ({ observed, liveBusy, liveWant, enabledWant, liveNote, chaseUntil }),
        getNext: () => obs?.value?.next?.textContent || ''
    };`;
    vm.runInNewContext('(function(cuimod,ctx){' + source + '\n})(cuimod,ctx)', { ...h.context, cuimod, ctx: h.ctx });
    return { ...h, cuimod, applyCalls, writes, setCli: value => { cliSessionId = value; }, testApi: h.context.__autoTest };
}

test('auto-compact observation accepts only the current worker generation', async () => {
    const h = autoHarness();
    h.testApi.observedSection();
    await flush();
    changeRendererSession(h, B);
    changeRendererSession(h, A);
    await flush();
    const reads = h.applyCalls.filter(call => call.type === 'observe');
    assert.equal(reads.length, 3);
    reads[0].resolve(contextValue('old-a', 300000));
    reads[1].reject(new Error('stale B rejection'));
    await flush();
    assert.equal(h.testApi.getState().observed, null);
    reads[2].resolve(contextValue('current-a', 180000, 400000));
    await flush(20);
    assert.equal(h.testApi.getState().observed.model, 'current-a');
});

test('stale live-control acknowledgements cannot mutate the new session', async () => {
    const h = autoHarness();
    h.testApi.setObserved(contextValue('claude-gpt-a[1m]', 100000));
    const sent = h.testApi.send(false, null, 'Turning auto-compact off');
    const apply = h.applyCalls.find(call => call.type !== 'observe');
    changeRendererSession(h, B);
    h.setCli('cli-b');
    apply.resolve({ applied: true });
    await sent;
    assert.deepEqual(h.writes, [], 'an unowned acknowledgement cannot fall back to the new CLI session');
    assert.equal(h.testApi.getState().liveNote, null);
    assert.equal(h.testApi.getState().chaseUntil, 0);
});

test('a stale acknowledgement may persist only its returned target identity', async () => {
    const h = autoHarness();
    h.testApi.setObserved(contextValue('claude-gpt-a[1m]', 100000));
    const sent = h.testApi.send(false, null, 'Turning auto-compact off');
    const apply = h.applyCalls.find(call => call.type !== 'observe');
    changeRendererSession(h, B);
    h.setCli('cli-b');
    apply.resolve({ applied: true, cliSessionId: 'cli-a' });
    await sent;
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]['cli-a'].enabled, false);
    assert.equal(h.writes[0]['cli-b'], undefined);
    assert.equal(h.testApi.getState().liveNote, null);
});

test('next-launch labels distinguish model, fallback, native auto, and session policy', () => {
    const h = autoHarness();
    h.testApi.buildObserved();
    h.testApi.setObserved(contextValue('claude-opus-5', 100000));

    h.testApi.spec.apply({ enabled: true, defaultWindow: 300000, perModel: {}, sessionOverrides: {} });
    h.testApi.updateObserved();
    assert.equal(h.testApi.getNext(), '300k (fallback policy)');

    h.testApi.spec.apply({ enabled: true, defaultWindow: 0, perModel: { 'opus-5': 500000 }, sessionOverrides: {} });
    h.testApi.updateObserved();
    assert.equal(h.testApi.getNext(), '500k (model policy)');

    h.testApi.spec.apply({ enabled: true, defaultWindow: 0, perModel: {}, sessionOverrides: {} });
    h.testApi.updateObserved();
    assert.equal(h.testApi.getNext(), 'Auto (Claude Code default)');

    h.testApi.spec.apply({ enabled: true, defaultWindow: 0, perModel: {},
        sessionOverrides: { 'cli-a': { enabled: true, window: 400000 } } });
    h.testApi.updateObserved();
    assert.equal(h.testApi.getNext(), '400k (session policy)');
});

function statusHarness(file, method) {
    const h = rendererContext();
    const calls = [];
    let cliSessionId = 'cli-a';
    h.context.performance = { timeOrigin: 1 };
    h.context.Math = Math;
    const cuimod = {
        get sessionId() { return cliSessionId; },
        onSessionChange(fn) {
            h.sessionCallbacks.push(fn);
            return () => {
                const at = h.sessionCallbacks.indexOf(fn);
                if (at !== -1) h.sessionCallbacks.splice(at, 1);
            };
        },
        rpc(name, params) {
            if (name.endsWith('nativeStatusPatch')) return Promise.resolve({ installed: false });
            if (name !== method) throw new Error('unexpected rpc ' + name);
            const call = { params, ...deferred() };
            calls.push(call);
            return call.promise;
        },
    };
    let source = fs.readFileSync(path.join(__dirname, '../src/plugins/' + file + '/renderer.js'), 'utf8');
    source += '\nglobalThis.__statusTest = { statusCard, refreshStatus, getText: () => statusBody?.textContent || "" };';
    vm.runInNewContext('(function(cuimod,ctx){' + source + '\n})(cuimod,ctx)', { ...h.context, cuimod, ctx: h.ctx });
    return { ...h, calls, setSession(id) {
        cliSessionId = id;
        for (const callback of h.sessionCallbacks) callback(id);
    }, testApi: h.context.__statusTest };
}

test('context status observations and event reasons stay session-owned', async () => {
    const h = statusHarness('context-management', 'context-management.status');
    h.testApi.statusCard();
    h.testApi.refreshStatus();
    await flush();
    h.setSession('cli-b');
    await flush();
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ settings: { enabled: false }, window: null });
    await flush(20);
    h.calls[0].resolve({ settings: { enabled: true }, window: {
        windowId: 'old-window', previousWindowId: null, windows: 2,
    }, activity: { resets: 1, modelResets: 1, lastResetCause: 'model', lastResetAt: '2026-09-08T04:48:18.613Z' } });
    await flush(20);
    assert.ok(h.testApi.getText().includes('Context management is off'));

    h.setSession('cli-c');
    await flush();
    h.calls[2].resolve({ settings: { enabled: true }, window: {
        windowId: 'new-window', previousWindowId: 'old-window', windows: 2,
    }, activity: { resets: 1, modelResets: 1, lastResetCause: 'model', lastResetAt: '2026-09-08T04:48:18.613Z' } });
    await flush(20);
    assert.ok(h.testApi.getText().includes('Last transitionmodel-requested reset'));
});

test('checkpoint status cannot paint an older session after navigation', async () => {
    const h = statusHarness('compaction-provider', 'compaction-provider.status');
    h.testApi.statusCard();
    h.testApi.refreshStatus();
    await flush();
    h.setSession('cli-b');
    await flush();
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ checkpoints: { count: 0, latest: null } });
    await flush(20);
    h.calls[0].resolve({ checkpoints: { count: 1, latest: {
        createdAt: '2026-09-08T04:48:18.613Z', sourceModel: 'gpt-old', retainedItems: 4,
        encryptedBytes: 20, fallbackCharacters: 30,
    } } });
    await flush(20);
    assert.ok(h.testApi.getText().includes('No Codex checkpoint exists for this session yet.'));
    assert.equal(h.testApi.getText().includes('gpt-old'), false);
});

test('disposed status renderers release their session subscription', async () => {
    for (const [file, method] of [
        ['context-management', 'context-management.status'],
        ['compaction-provider', 'compaction-provider.status'],
    ]) {
        const h = statusHarness(file, method);
        h.testApi.statusCard();
        h.testApi.refreshStatus();
        await flush();
        assert.equal(h.calls.length, 1);

        for (const dispose of h.disposers) dispose();
        h.setSession('cli-b');
        await flush();
        assert.equal(h.calls.length, 1, `${file} retained a disposed session callback`);
        h.calls[0].resolve({});
        await flush();
    }
});

test('branding asset changes reload the validated scene in the renderer', () => {
    const dir = path.join(__dirname, '../src/plugins/branding');
    const events = [];
    let assetWatch = null;
    let helmet = null;
    require('../src/plugins/branding/main.js')({
        dir,
        watch(target, options, callback) { assetWatch = { target, options, callback }; },
        method(name, callback) { if (name === 'helmet') helmet = callback; },
        broadcast(event) { events.push(event); },
        log() {},
    });

    assert.equal(assetWatch.target, dir);
    assert.equal(typeof helmet, 'function');
    assert.match(helmet().sceneSource, /opacity: \.25/);
    assetWatch.callback('change', 'renderer.js');
    assert.equal(events.length, 0);
    assetWatch.callback('change', 'firefight.svg');
    assert.deepEqual(events, [{ type: 'renderer-reload', reason: 'branding/firefight.svg' }]);
});

function brandingHarness() {
    const h = rendererContext();
    h.document.body = new FakeNode('body');
    const send = new FakeNode('span');
    const moving = new FakeNode('span');
    const still = new FakeNode('svg');
    const greeting = new FakeNode('header');
    greeting.append(still);
    const composer = new FakeNode('div');
    composer.getBoundingClientRect = () => ({ x: 100, y: 600, left: 100, right: 868,
        top: 600, bottom: 644, width: 768, height: 44 });
    const sideComposer = new FakeNode('div');
    sideComposer.getBoundingClientRect = () => ({ x: 900, y: 500, left: 900, right: 1200,
        top: 500, bottom: 544, width: 300, height: 44 });
    const crab = new FakeNode('svg');
    crab.computed = { display: 'block', visibility: 'visible', opacity: '1',
        color: 'rgb(217, 119, 87)', fill: 'rgb(217, 119, 87)' };
    crab.getBoundingClientRect = () => ({ x: 840, y: 574, left: 840, right: 866,
        top: 574, bottom: 598, width: 26, height: 24 });
    h.document.body.append(crab);
    const favicon = new FakeNode('link');
    favicon.href = 'https://example.test/native.svg';
    h.document.querySelectorAll = selector => {
        if (selector === 'button[data-testid="code-prompt-send"] [data-cds="Icon"]') return [send];
        if (selector === '[data-cds="Spark"]') return [moving, still];
        if (selector === '.epitaxy-prompt') return [sideComposer, composer];
        if (selector === 'link[rel~="icon"]') return [favicon];
        if (selector === 'body *') return h.document.body.children.filter(node => node.isConnected);
        if (selector === '#cuimod-new-session-firefight') {
            return h.document.body.children.filter(node => node.isConnected && node.id === 'cuimod-new-session-firefight');
        }
        return [];
    };
    h.context.getComputedStyle = node => node.computed || {
        display: 'block', visibility: 'visible', opacity: '1', color: '', fill: '',
    };
    const helmet = fs.readFileSync(path.join(__dirname, '../src/plugins/branding/helmet.svg'), 'utf8');
    const scene = fs.readFileSync(path.join(__dirname, '../src/plugins/branding/firefight.svg'), 'utf8');
    const cuimod = {
        rpc(method) {
            if (method !== 'branding.helmet') throw new Error('unexpected rpc ' + method);
            return Promise.resolve({ source: helmet, sceneSource: scene, keyColor: '#00FF66' });
        },
    };
    let source = fs.readFileSync(path.join(__dirname, '../src/plugins/branding/renderer.js'), 'utf8');
    source += '\nglobalThis.__brandingTest = { spec, svgUri, sceneUri, reconcile, getSceneHost: () => sceneHost };';
    vm.runInNewContext('(function(cuimod,ctx){' + source + '\n})(cuimod,ctx)', { ...h.context, cuimod, ctx: h.ctx });
    return { ...h, send, moving, still, greeting, composer, sideComposer, crab, favicon,
        testApi: h.context.__brandingTest };
}

test('branding recolours every Spark while preserving the composer action', async () => {
    const h = brandingHarness();
    await flush();
    const style = h.document.head.children.find(node => node.id === 'cuimod-branding-style');
    assert.ok(style);
    assert.equal(h.send.getAttribute('data-cuimod-branding'), null, 'send must retain its native icon');
    assert.equal(h.moving.getAttribute('data-cuimod-branding'), 'spark-animated');
    assert.equal(h.still.getAttribute('data-cuimod-branding'), 'spark-static');
    assert.match(style.textContent, /opacity: \.8 !important/);
    assert.match(decodeURIComponent(style.textContent), /#D97757/);
    assert.match(h.favicon.href, /^data:image\/svg\+xml,/);

    h.location.pathname = '/epitaxy/';
    h.testApi.reconcile();
    assert.equal(h.still.getAttribute('data-cuimod-branding'), 'spark-static');
    assert.equal(h.testApi.getSceneHost(), null);

    h.location.pathname = '/epitaxy';
    h.testApi.reconcile();
    assert.equal(h.still.getAttribute('data-cuimod-branding'), 'spark-static');
    assert.equal(h.moving.getAttribute('data-cuimod-branding'), 'spark-animated');
    assert.equal(h.crab.getAttribute('data-cuimod-branding'), null,
        'replacement must not depend on guessing the native crab node');
    const host = h.testApi.getSceneHost();
    assert.ok(host?.isConnected);
    assert.equal(host.style.left, '744px');
    assert.equal(host.style.top, '566px');
    assert.match(style.textContent, /width: 124px !important/);
    assert.match(style.textContent,
        /background: var\(--cds-page-bg, hsl\(var\(--bg-100\)\)\) !important/);
    assert.match(style.textContent,
        /#cuimod-new-session-firefight::after \{[\s\S]*?opacity: \.8;[\s\S]*?background: center \/ contain no-repeat url\("data:image\/svg\+xml,/);
    const scene = decodeURIComponent(h.testApi.sceneUri());
    const helmetPaths = [...fs.readFileSync(path.join(__dirname, '../src/plugins/branding/helmet.svg'), 'utf8')
        .matchAll(/<path(?: data-accent="")? fill="[^"]+" d="([^"]+)"\/>/g)].map(match => match[1]);
    for (const helmetPath of helmetPaths) assert.ok(scene.includes(`d="${helmetPath}"`));
    assert.match(scene, /transform="translate\(18 0\) scale\(-1 1\)"/);
    assert.match(scene, /<g transform="translate\(73 2\)">\s*<g class="octo-a">/);
    assert.match(scene, /M9 6h4v1h1v4h-1v1H9v-1H8V7h1z/);
    assert.match(scene, /\.octo-a \{ animation: octo-a 2\.8s linear infinite; \}/);
    assert.match(scene,
        /@keyframes octo-a \{[\s\S]*?4% \{ transform: translateY\(-2px\); opacity: \.2; \}[\s\S]*?16%, 18% \{ transform: translateY\(0\); opacity: 1; \}/);
    assert.match(scene,
        /@keyframes octo-b \{[\s\S]*?4% \{ transform: translateY\(-1px\); opacity: \.2; \}[\s\S]*?16%, 59% \{ transform: translateY\(1px\); opacity: 1; \}/);
    assert.match(scene, /51% \{ transform: translateY\(-1px\); opacity: \.55; \}/);
    assert.match(scene, /58% \{ transform: translateY\(-2px\); opacity: \.25; \}/);
    assert.match(scene, /90% \{ transform: translateY\(-1px\); opacity: \.55; \}/);
    assert.match(scene, /96% \{ transform: translateY\(-2px\); opacity: \.25; \}/);
    assert.match(scene, /53% \{ opacity: \.35; \}/);
    assert.match(scene, /91% \{ opacity: \.35; \}/);

    h.location.pathname = route(A);
    h.testApi.reconcile();
    assert.equal(h.still.getAttribute('data-cuimod-branding'), 'spark-static');
    assert.equal(h.crab.getAttribute('data-cuimod-branding'), null);
    assert.equal(h.testApi.getSceneHost(), null);

    h.testApi.spec.apply({ enabled: true, accent: '#123ABC' });
    assert.match(decodeURIComponent(style.textContent), /#123ABC/);
    assert.doesNotMatch(decodeURIComponent(style.textContent), /#00FF66/);
    assert.match(decodeURIComponent(h.testApi.sceneUri()), /#123ABC/);
    assert.doesNotMatch(decodeURIComponent(h.testApi.sceneUri()), /#00FF66/);

    const animated = decodeURIComponent(h.testApi.svgUri(true));
    assert.match(animated, /clip-path="url\(#visor-clip\)"/);
    assert.match(animated, /50%, 59% \{ transform: translateX\(5px\); \}/);
    assert.match(animated, /60%, 69% \{ transform: translateX\(4px\); \}/);

    for (const dispose of [...h.disposers].reverse()) dispose();
    assert.equal(h.moving.getAttribute('data-cuimod-branding'), null);
    assert.equal(h.still.getAttribute('data-cuimod-branding'), null);
    assert.equal(h.favicon.href, 'https://example.test/native.svg');
});
