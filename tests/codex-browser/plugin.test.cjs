'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const assert = require('node:assert/strict');
const test = require('node:test');
const { sdkServer } = require(path.join(PLUGIN_DIR, 'sdk-server.js'));
const { nativeSurfaces } = require(path.join(PLUGIN_DIR, 'main.js'));
const { discoverRuntime } = require(path.join(PLUGIN_DIR, 'discovery.js'));

function transport() {
    const messages = [];
    return { messages, async start() {}, async close() { this.onclose?.(); }, async send(message) { messages.push(message); } };
}

test('SDK proxy exposes real runtime schemas and preserves tool results', async () => {
    const result = { content: [{ type: 'text', text: 'actual result' }], _meta: { 'codex/browserUse': true } }, calls = [];
    const definitions = ['js', 'js_reset', 'turn_ended'].map(name => ({ name, description: 'runtime-' + name, inputSchema: { type: 'object' } }));
    const server = sdkServer({ tools: async () => definitions, call: async (...args) => { calls.push(args); return result; } });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 1, method: 'tools/list' });
    assert.deepEqual(wire.messages[0].result.tools.map(row => row.name), ['js', 'js_reset']);
    assert.equal(wire.messages[0].result.tools[0].description, 'runtime-js');
    await wire.onmessage({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState()' }, _meta: { 'claudecode/toolUseId': 'native-tool-id' } } });
    assert.equal(wire.messages[1].result, result);
    assert.equal(calls[0][2].turnId, 'native-tool-id');
    await wire.onmessage({ id: 3, method: 'tools/call', params: { name: 'js_add_node_module_dir', arguments: {} } });
    assert.equal(wire.messages[2].result.isError, true); assert.equal(calls.length, 1);
    await server.instance.close();
});

test('SDK initialization identifies the native pane fast path and preserves fallback tools', async () => {
    const server = sdkServer({ tools: async () => [] }), wire = transport();
    await server.instance.connect(wire);
    await wire.onmessage({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    assert.match(wire.messages[0].result.instructions, /Claude Desktop.*built-in browser/);
    assert.match(wire.messages[0].result.instructions, /Prefer.*cua_repl/);
    assert.match(wire.messages[0].result.instructions, /Original Claude Browser tools/);
    await server.instance.close();
});

test('SDK cancellation aborts the active runtime call', async () => {
    let signal;
    const server = sdkServer({ tools: async () => [], call: (_name, _args, options) => {
        signal = options.signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
    } });
    const wire = transport(); await server.instance.connect(wire);
    const pending = wire.onmessage({ id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
    await wire.onmessage({ method: 'notifications/cancelled', params: { requestId: 1 } });
    await pending; assert.equal(signal.aborted, true);
    await server.instance.close();
});

test('failed schema discovery is a protocol error rather than a fake tools list', async () => {
    const server = sdkServer({ tools: async () => { throw Error('runtime missing'); } });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 1, method: 'tools/list' });
    assert.equal(wire.messages[0].error.code, -32603); assert.equal(wire.messages[0].result, undefined);
    await server.instance.close();
});

test('SDK forwards form elicitation over the calling transport and preserves response metadata', async () => {
    const params = { mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} }, _meta: { request: 'keep' } };
    const response = { action: 'accept', content: {}, _meta: { response: 'keep' } };
    const server = sdkServer({ tools: async () => [], call: (_name, _args, options) =>
        options.createElicitation(params, { signal: options.signal }) });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 'initialize', method: 'initialize', params: { capabilities: { elicitation: { form: {} } } } });
    assert.deepEqual(wire.messages[0].result.capabilities, { tools: { listChanged: true } });
    const pending = wire.onmessage({ id: 7, method: 'tools/call', params: { name: 'js', arguments: {} } });
    await new Promise(resolve => setImmediate(resolve));
    const request = wire.messages.find(message => message.method === 'elicitation/create');
    assert.ok(request); assert.equal(typeof request.id, 'string'); assert.strictEqual(request.params, params);
    await wire.onmessage({ jsonrpc: '2.0', id: request.id, result: response });
    await pending;
    assert.strictEqual(wire.messages.find(message => message.id === 7).result, response);
    await server.instance.close();
});

test('SDK rejects elicitation without negotiated form capability and sends nothing', async () => {
    const server = sdkServer({ tools: async () => [], call: (_name, _args, options) =>
        options.createElicitation({ mode: 'form', message: 'Allow?', requestedSchema: { type: 'object' } }) });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 'initialize', method: 'initialize', params: { capabilities: {} } });
    await wire.onmessage({ id: 8, method: 'tools/call', params: { name: 'js', arguments: {} } });
    const reply = wire.messages.find(message => message.id === 8);
    assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, /form elicitation/i);
    assert.equal(wire.messages.some(message => message.method === 'elicitation/create'), false);
    await server.instance.close();
});

test('SDK cancellation rejects elicitation once and drops a late response', async () => {
    const extra = new AbortController();
    const server = sdkServer({ tools: async () => [], call: (_name, _args, options) =>
        options.createElicitation({ mode: 'form', message: 'Allow?', requestedSchema: { type: 'object' } }, { signal: extra.signal }) });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 'initialize', method: 'initialize', params: { capabilities: { elicitation: {} } } });
    const pending = wire.onmessage({ id: 9, method: 'tools/call', params: { name: 'js', arguments: {} } });
    await new Promise(resolve => setImmediate(resolve));
    const request = wire.messages.find(message => message.method === 'elicitation/create');
    extra.abort(); await pending;
    assert.equal(wire.messages.filter(message => message.method === 'notifications/cancelled').length, 1);
    const count = wire.messages.length;
    await wire.onmessage({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', _meta: { late: true } } });
    assert.equal(wire.messages.length, count);
    await server.instance.close();
});

test('SDK close aborts active calls and rejects pending elicitation', async () => {
    let signal;
    const server = sdkServer({ tools: async () => [], call: (_name, _args, options) => {
        signal = options.signal;
        return options.createElicitation({ mode: 'form', message: 'Allow?', requestedSchema: { type: 'object' } });
    } });
    const wire = transport(); await server.instance.connect(wire);
    await wire.onmessage({ id: 'initialize', method: 'initialize', params: { capabilities: { elicitation: { form: {} } } } });
    const pending = wire.onmessage({ id: 10, method: 'tools/call', params: { name: 'js', arguments: {} } });
    await new Promise(resolve => setImmediate(resolve));
    const request = wire.messages.find(message => message.method === 'elicitation/create');
    await server.instance.close(); await pending;
    assert.equal(signal.aborted, true);
    const count = wire.messages.length;
    await wire.onmessage({ jsonrpc: '2.0', id: request.id, result: { action: 'accept' } });
    assert.equal(wire.messages.length, count);
});

test('closed SDK connections cannot admit a new tool request', async () => {
    let calls = 0;
    const server = sdkServer({ tools: async () => [], call: async () => { calls++; return {}; } });
    const wire = transport(); await server.instance.connect(wire); await server.instance.close();
    await wire.onmessage({ id: 99, method: 'tools/call', params: { name: 'js', arguments: {} } });
    assert.equal(calls, 0); assert.equal(wire.messages.length, 0);
});

test('SDK bounds active calls and rejects duplicate pending IDs without replacement', async () => {
    const signals = [];
    const server = sdkServer({ tools: async () => [], call: (_name, _args, { signal }) => {
        signals.push(signal);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('closed')), { once: true }));
    } });
    const wire = transport(); await server.instance.connect(wire);
    const active = Array.from({ length: 32 }, (_, index) => wire.onmessage({ id: index + 1, method: 'tools/call', params: { name: 'js', arguments: {} } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signals.length, 32); assert.equal(signals[0].aborted, false);
    await wire.onmessage({ id: 1, method: 'tools/call', params: { name: 'js', arguments: {} } });
    await wire.onmessage({ id: 33, method: 'tools/call', params: { name: 'js', arguments: {} } });
    assert.equal(signals.length, 32); assert.equal(signals[0].aborted, false);
    assert.equal(wire.messages.find(message => message.id === 1).result.isError, true);
    assert.equal(wire.messages.find(message => message.id === 33).result.isError, true);
    await server.instance.close(); await Promise.all(active);
});

test('native surfaces are discovered by their verified contracts', () => {
    const preview = { getPreviewTabs() {}, evaluateInPreview() {}, _test: { tabForTest() {} } };
    const launch = { loadBrowserPreview() {}, getBrowserPreviewForSession() {} };
    assert.deepEqual(nativeSurfaces({ module: { exports: { a: preview, b: launch } } }), { preview, launch });
    assert.throws(() => nativeSurfaces({}), /contracts unavailable/);
    assert.equal(discoverRuntime({ home: path.join(os.tmpdir(), 'codex-browser-no-such-home') }), null);
});

test('hot host handoff adopts its wrapper without stacking or disabling the next generation', () => {
    const source = fs.readFileSync(path.join(PLUGIN_DIR, 'main.js'), 'utf8');
    const globalObject = {}, manager = { sessions: new Map(), buildStartSdkOptions: async () => ({ sdkOptions: {}, allMcpServers: {} }) };
    const original = manager.buildStartSdkOptions;
    const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-browser-plugin-fixture-'));
    const customRequire = name => {
        if (name === '../desktop-mcp-bridge/desktop-adapter') return { discover: () => manager };
        if (name === './discovery') return { discoverRuntime: () => null };
        if (name.startsWith('./')) return require(path.join(PLUGIN_DIR, name.slice(2)));
        return require(name);
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', 'process', 'globalThis', source)(customRequire, module, module.exports, PLUGIN_DIR,
        { versions: { electron: '42.7.0' } }, globalObject);
    const factory = module.exports;
    const context = () => {
        const disposers = [];
        return { ctx: { dir: PLUGIN_DIR, boot: { MOD_DIR: bootDir }, electron: { app: { getVersion: () => '2.9939.4' } },
            method() {}, every() {}, log() {}, onDispose: fn => disposers.push(fn) }, dispose: () => disposers.forEach(fn => fn()) };
    };
    try {
        const first = context(), next = context();
        factory(first.ctx); const installed = manager.buildStartSdkOptions;
        assert.notEqual(installed, original);
        factory(next.ctx); first.dispose();
        assert.equal(manager.buildStartSdkOptions, installed);
        assert.ok(globalObject[Symbol.for('cuimod.codex-browser')].api);
        next.dispose();
        assert.equal(manager.buildStartSdkOptions, original);
        assert.equal(globalObject[Symbol.for('cuimod.codex-browser')].api, null);
    } finally { fs.rmSync(bootDir, { recursive: true, force: true }); }
});
