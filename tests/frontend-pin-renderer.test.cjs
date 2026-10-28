'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function flush(rounds = 8) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function harness({ dashboard = true, statusEnabled = true, statusFailed = null, statusError = false, composer = false, pinned = true, pathname = '/epitaxy' } = {}) {
    const calls = [];
    const intervals = [];
    const listeners = new Map();
    const disposers = [];
    const appended = [];
    const bodyNodes = [];
    const document = {
        readyState: 'complete',
        body: { appendChild(node) { node.isConnected = true; bodyNodes.push(node); } },
        documentElement: {},
        head: {
            appendChild(node) {
                node.isConnected = true;
                appended.push(node);
                return node;
            },
        },
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(),
                isConnected: false,
                attributes: {},
                setAttribute(key, value) { this.attributes[key] = value; },
                attachShadow() {
                    const children = [];
                    this.shadowRoot = { children, appendChild(node) { children.push(node); } };
                    return this.shadowRoot;
                },
                remove() { this.isConnected = false; },
            };
        },
        getElementById(id) { return bodyNodes.find((node) => node.id === id && node.isConnected); },
        querySelector(selector) {
            if (selector === '.epitaxy-prompt') return composer ? {} : null;
            if (selector.startsWith('script[src=')) return pinned ? {} : null;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {},
    };
    const ctx = {
        observe() {},
        every(_ms, fn) { intervals.push(fn); return fn; },
        track(target, type, fn) {
            const key = type;
            const list = listeners.get(key) || [];
            list.push({ target, fn });
            listeners.set(key, list);
        },
        onDispose(fn) { disposers.push(fn); },
    };
    const cuimod = {
        async rpc(method, params) {
            calls.push({ method, params });
            if (method === 'frontend-pin.status') {
                if (statusError) throw new Error('host unavailable');
                return { enabled: statusEnabled, ready: true, failed: statusFailed,
                    pinnedEntry: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-Cuw5J4F9.js',
                    pinnedStylesheets: {}, bundledAssets: 1 };
            }
            if (method === 'frontend-pin.settings') return { enabled: params.enabled };
            if (method === 'frontend-pin.beginCanary') return {
                ready: true,
                passed: false,
                token: 'canary-token',
                url: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-cuimod-pin-canary.js?cuimod_pin_canary=canary-token',
            };
            if (method === 'frontend-pin.finishCanary') return { ok: params.ok, failed: !params.ok };
            if (method === 'frontend-pin.healthy') return true;
            if (method === 'frontend-pin.reloadLive') return true;
                        throw new Error('unexpected RPC ' + method);
        },
    };
    const registry = { specs: new Map(), subs: new Set(dashboard ? [() => {}] : []) };
    const context = {
        console,
        cuimod,
        ctx,
        document,
        location: { pathname },
        performance: { timeOrigin: 1234 },
        globalThis: { __cuimodReg: registry },
        URL,
        Date,
    };
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/frontend-pin/renderer.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'frontend-pin/renderer.js' });
    return {
        calls, intervals, listeners, appended, registry,
        warning() {
            const host = document.getElementById('cuimod-frontend-warning');
            return host?.shadowRoot.children.find((node) => node.attributes.role === 'alert')?.textContent || null;
        },
        dispatch(type, target) {
            for (const item of listeners.get(type) || []) item.fn({ target });
        },
        dispose() {
            for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
        },
    };
}

test('dashboard failure preserves the main process persisted disabled state', async () => {
    const h = harness({ dashboard: false, statusEnabled: false });
    await flush();
    for (const tick of h.intervals) tick();
    await flush();

    assert.equal(h.calls.filter((call) => call.method === 'frontend-pin.status').length, 1);
    assert.equal(h.calls.some((call) => call.method === 'frontend-pin.settings'), false);
    assert.equal(h.calls.some((call) => call.method === 'frontend-pin.beginCanary'), false);
    assert.equal(h.appended.length, 0);
    h.dispose();
});

test('fail-open displays an accessible warning and disabling removes it', async () => {
    const h = harness({ dashboard: false, statusFailed: 'bundled entry is missing' });
    await flush();
    assert.match(h.warning(), /Unsupported Code frontend: bundled entry is missing/);
    h.registry.specs.get('frontend-pin').apply({ enabled: false });
    assert.equal(h.warning(), null);
    h.dispose();
    assert.equal(h.warning(), null);
});

test('Code compatibility warnings do not appear on sign-in or chat pages', async () => {
    const h = harness({ dashboard: false, statusFailed: 'bundle unavailable', pathname: '/login' });
    await flush();
    assert.equal(h.warning(), null);
    h.dispose();
});

test('a loaded live page asks for the recovery reload instead of a toast', async () => {
    const h = harness({ dashboard: false, composer: true, pinned: false });
    await flush();
    assert.equal(h.warning(), null);
    assert.equal(h.calls.some((call) => call.method === 'frontend-pin.reloadLive'), true);
    h.dispose();
});

test('a pinned page never asks for a reload', async () => {
    const h = harness({ dashboard: false, composer: true, pinned: true });
    await flush();
    assert.equal(h.calls.some((call) => call.method === 'frontend-pin.reloadLive'), false);
    h.dispose();
});

test('a sustained status outage is visible instead of silently claiming compatibility', async () => {
    const h = harness({ dashboard: false, statusError: true });
    await flush();
    for (let i = 0; i < 8; i++) {
        for (const tick of h.intervals) tick();
        await flush();
    }
    assert.match(h.warning(), /compatibility is unverified/);
    h.dispose();
});

test('one document listener pair completes canaries across toggle cycles', async () => {
    const h = harness({ dashboard: true });
    const spec = h.registry.specs.get('frontend-pin');
    assert.ok(spec);
    assert.equal((h.listeners.get('load') || []).length, 1);
    assert.equal((h.listeners.get('error') || []).length, 1);

    spec.apply({ enabled: true });
    await flush();
    assert.equal(h.appended.length, 1);
    h.dispatch('load', h.appended[0]);
    await flush();
    const finish = h.calls.find((call) => call.method === 'frontend-pin.finishCanary').params;
    assert.equal(finish.token, 'canary-token');
    assert.equal(finish.ok, true);

    spec.apply({ enabled: false });
    spec.apply({ enabled: true });
    await flush();
    assert.equal((h.listeners.get('load') || []).length, 1);
    assert.equal((h.listeners.get('error') || []).length, 1);
    h.dispose();
});
