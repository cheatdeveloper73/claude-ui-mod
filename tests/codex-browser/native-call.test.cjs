'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const test = require('node:test');
const { nativeCall, guardedNativeAction } = require(path.join(PLUGIN_DIR, 'native-call.js'));

function fixture() {
    const events = [];
    const cdp = { evaluate: async code => { events.push(['original', code]); return 'original'; } };
    const tab = { cdpTools: cdp };
    const options = { tabId: 'seed', getTab: () => tab, identity: () => 1, validate() {},
        invoke: async (_name, input) => {
            events.push('native-gate');
            const value = await cdp.evaluate('{' + input.text + '\n}');
            events.push(['native-postcheck', value]);
            return { content: [{ type: 'text', text: 'native result' }] };
        },
    };
    return { options, events, cdp };
}

test('real backend operation executes inside native gate and postcheck', async () => {
    const { options, events, cdp } = fixture(), original = cdp.evaluate;
    const value = await nativeCall(options, 'Runtime.evaluate', async () => {
        events.push('backend'); return { result: { value: 42 } };
    });
    assert.deepEqual(value, { result: { value: 42 } });
    assert.deepEqual(events, ['native-gate', 'backend', ['native-postcheck', undefined]]);
    assert.equal(cdp.evaluate, original);
});

test('native navigation guard preserves synchronous APIs', async () => {
    let calls = 0;
    const object = { goToIndex: () => { calls++; return 17; } }, original = object.goToIndex, tab = {};
    await guardedNativeAction({ object, slot: 'goToIndex', getTab: () => tab, validate() {},
        invoke: async () => { assert.equal(object.goToIndex(1), 17); return { content: [] }; } });
    assert.equal(calls, 1); assert.equal(object.goToIndex, original);
});

test('cancel during native navigation approval prevents dispatch', async () => {
    let calls = 0, release;
    const object = { loadURL: () => { calls++; return Promise.resolve(); } }, original = object.loadURL, tab = {};
    const gate = new Promise(resolve => { release = resolve; }), controller = new AbortController();
    const pending = guardedNativeAction({ object, slot: 'loadURL', getTab: () => tab, validate() {}, signal: controller.signal,
        invoke: async () => { await gate; await object.loadURL('https://example.test'); return { content: [] }; } });
    controller.abort(); release();
    await assert.rejects(pending, /cancelled/);
    assert.equal(calls, 0); assert.equal(object.loadURL, original);
});

test('native refusal dispatches no backend command', async () => {
    const { options, cdp } = fixture(), original = cdp.evaluate;
    options.invoke = async () => ({ isError: true, content: [{ type: 'text', text: 'user declined' }] });
    let calls = 0;
    await assert.rejects(nativeCall(options, 'Input.insertText', async () => { calls++; }), /user declined/);
    assert.equal(calls, 0);
    assert.equal(cdp.evaluate, original);
});

test('unrelated native calls use original evaluate during async gate', async () => {
    const { options, events, cdp } = fixture();
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const native = options.invoke;
    options.invoke = async (...args) => { await wait; return native(...args); };
    const request = nativeCall(options, 'DOM.getDocument', async () => 'backend');
    assert.equal(await cdp.evaluate('2 + 2'), 'original');
    release(); await request;
    assert.deepEqual(events[0], ['original', '2 + 2']);
});

test('identity changes during native gate stop dispatch', async () => {
    const { options } = fixture();
    let identity = 1, calls = 0;
    options.identity = () => identity;
    const native = options.invoke;
    options.invoke = async (...args) => { identity = 2; return native(...args); };
    await assert.rejects(nativeCall(options, 'Runtime.callFunctionOn', async () => { calls++; }), /changed/);
    assert.equal(calls, 0);
});

test('cancellation and unknown native implementation fail closed', async () => {
    const { options, cdp } = fixture(), original = cdp.evaluate;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(nativeCall({ ...options, signal: controller.signal }, 'Runtime.evaluate', async () => {}), /cancel/i);
    assert.equal(cdp.evaluate, original);
    options.invoke = async () => ({ content: [] });
    await assert.rejects(nativeCall(options, 'Runtime.evaluate', async () => {}), /native.*contract/i);
    assert.equal(cdp.evaluate, original);
});
