'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), test = require('node:test'), assert = require('node:assert/strict');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
function fixture() {
    const boot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-browser-lifecycle-fixture-')), globalObject = {}, ticks = [], disposers = [];
    const hosts = [], serverOptions = [], closedServers = [], handlers = [], backendInvokes = [];
    let failStart = false, connectBackend, heldCall, releaseCall;
    const manager = () => ({ sessions: new Map(), currentAccountId: 'account', currentOrgId: 'org',
        buildStartSdkOptions: async () => ({ sdkOptions: {}, allMcpServers: {} }), hasAgentRunInProgress: () => false,
        startedThroughHostCliLauncher: () => false,
        buildInternalServerOptions: () => ({}), mcpCoordinator: {
            buildInternalServerContext: () => ({}), sealForSdk: (_sid, _isolated, servers) => servers, toolCheck: () => () => undefined,
            internalManager: { resolvedServers: [{ serverName: 'Claude Browser', isEnabled: () => true, handleToolCall: async () => ({}) }] },
        } });
    let current = manager();
    const source = fs.readFileSync(path.join(PLUGIN_DIR, 'main.js'), 'utf8');
    const fakeRequire = name => {
        if (name === '../desktop-mcp-bridge/desktop-adapter') return { discover: () => current };
        if (name === './discovery') return { discoverRuntime: () => ({ fingerprint: 'runtime' }) };
        if (name === './runtime-host') return { createRuntime: () => {
            const host = { closed: false, async start() { if (failStart) { failStart = false; throw Error('transient start'); } return []; },
                async close() { this.closed = true; }, status: () => ({ state: 'ready' }),
                callArgs: [], async call(...args) { this.callArgs.push(args); if (this.closed) throw Error('closed host reused'); if (heldCall) await heldCall; return { content: [{ type: 'text', text: 'new host' }] }; } };
            hosts.push(host); return host;
        } };
        if (name === './sdk-server') return { sdkServer: options => {
            const server = { type: 'sdk', name: 'cua_repl', options, instance: { close: async () => { closedServers.push(server); } } };
            serverOptions.push(server); return server;
        } };
        if (name === './native-surfaces') return { nativeSurfaces: () => ({}) };
        if (name === './native-adapter') return { createNativeAdapter: () => ({ preview: {}, invoke: async () => ({}), createBlank: async () => 'seed' }) };
        if (name === './native-backend') return { createBackend: () => ({ close() {}, setNotify() {},
            async invoke(...args) { backendInvokes.push(args); return {}; } }) };
        if (name === './pipe') return { connection: (_socket, handler) => { handlers.push(handler); return { close() {}, notify() {} }; } };
        if (name === 'node:net') return { createServer: callback => { connectBackend = callback; return { once() {}, listen(_path, fn) { fn(); }, close(fn) { fn(); } }; } };
        if (name.startsWith('./')) return require(path.join(PLUGIN_DIR, name.slice(2)));
        return require(name);
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', 'process', 'globalThis', source)(fakeRequire, module, module.exports, PLUGIN_DIR,
        { versions: { electron: '42.7.0' } }, globalObject);
    module.exports({ dir: PLUGIN_DIR, boot: { MOD_DIR: boot }, electron: { app: { getVersion: () => '2.9939.4' } },
        method() {}, log() {}, every(_ms, fn) { ticks.push(fn); }, onDispose(fn) { disposers.push(fn); } });
    const state = globalObject[Symbol.for('cuimod.codex-browser')];
    const session = { cwd: boot, query: {}, backend: { cliRunsAsThisUser: () => true }, activeMcpServers: {}, cliLastTurnMessageWasResult: false };
    current.sessions.set('s', session);
    return { state, hosts, closedServers, session, serverOptions, handlers, backendInvokes,
        hold() { heldCall = new Promise(resolve => { releaseCall = resolve; }); }, release() { releaseCall?.(); heldCall = null; },
        connectBackend() { connectBackend({ once() {} }); },
        get manager() { return current; }, replaceManager() { current = manager(); return current; },
        failFirstStart() { failStart = true; }, tick() { ticks.forEach(fn => fn()); },
        async close() { disposers.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); fs.rmSync(boot, { recursive: true, force: true }); } };
}
test('a transient schema startup error can recover on a later request', async () => {
    const f = fixture();
    try {
        f.failFirstStart(); await assert.rejects(f.state.api.tools(), /transient/);
        await f.state.api.tools(); assert.equal(f.hosts.length, 2); assert.ok(f.hosts.every(host => host.closed));
    } finally { await f.close(); }
});
test('manager replacement restores the old owned wrapper and wraps the new manager', async () => {
    const f = fixture(), first = f.manager, installed = first.buildStartSdkOptions;
    try {
        const next = f.replaceManager(), original = next.buildStartSdkOptions;
        f.tick(); assert.notEqual(next.buildStartSdkOptions, original); assert.notEqual(first.buildStartSdkOptions, installed);
    } finally { await f.close(); }
});
test('closed bindings are discarded before a fresh call', async () => {
    const f = fixture();
    try {
        const old = { sid: 's', revision: f.state.api.status().revision, query: f.session.query, closed: true, closing: Promise.resolve(),
            busy: 0, calls: new Map(), ready: Promise.resolve(), host: { async call() { throw Error('closed host reused'); } } };
        f.state.bindings.set('s', old);
        const result = await (f.state.api.invoke || f.state.api.call)('s', 'js', {}, { turnId: 't' });
        assert.equal(result.content[0].text, 'new host'); assert.notEqual(f.state.bindings.get('s'), old);
    } finally { await f.close(); }
});
test('Codex turn identity spans tool calls and turn-end is serialized before the next turn', async () => {
    const f = fixture();
    try {
        f.session.isRunning = true;
        await f.state.api.invoke('s', 'js', {}, { turnId: 'tool-a' });
        await f.state.api.invoke('s', 'js', {}, { turnId: 'tool-b' });
        const host = f.hosts[0], firstTurn = host.callArgs[0][2].turnId;
        assert.equal(host.callArgs[1][2].turnId, firstTurn);
        f.session.isRunning = false; f.tick();
        await f.state.api.invoke('s', 'js', {}, { turnId: 'tool-c' });
        assert.deepEqual(host.callArgs.map(row => row[0]), ['js', 'js', 'turn_ended', 'js']);
        assert.equal(host.callArgs[2][2].turnId, firstTurn);
        assert.notEqual(host.callArgs[3][2].turnId, firstTurn);
    } finally { await f.close(); }
});

test('pipe disconnect aborts backend work even while the parent tool call remains active', async () => {
    const f = fixture(); f.hold();
    const pending = (f.state.api.invoke || f.state.api.call)('s', 'js', {}, { turnId: 't' });
    try {
        await new Promise(resolve => setImmediate(resolve)); f.connectBackend();
        const disconnected = new AbortController();
        await f.handlers[0]('getInfo', { turn_id: f.state.bindings.get('s').clientRequest.turnId }, { signal: disconnected.signal });
        const signal = f.backendInvokes[0][2].signal;
        assert.equal(signal.aborted, false); disconnected.abort(); assert.equal(signal.aborted, true);
    } finally { f.release(); await pending; await f.close(); }
});

test('removed sessions release their SDK server instances', async () => {
    const f = fixture();
    try {
        const result = f.state.api.configure('s', { sdkOptions: {}, allMcpServers: {} }), server = result.allMcpServers.cua_repl;
        f.manager.sessions.delete('s'); f.tick(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.state.servers.has('s'), false); assert.ok(f.closedServers.includes(server));
    } finally { await f.close(); }
});
test('acknowledged SDK configuration is adopted while native connection status is pending', async () => {
    const f = fixture(), native = { type: 'sdk', name: 'native' }, writes = [];
    try {
        f.session.activeMcpServers = { native }; f.session.cliLastTurnMessageWasResult = true;
        f.session.query.sdkMcpServers = new Map([['native', {}]]);
        f.session.query.setMcpServers = async servers => { writes.push(servers); f.session.query.sdkMcpServers.set('cua_repl', {}); };
        f.session.query.mcpServerStatus = async () => [{ name: 'cua_repl', status: 'pending' }];
        f.tick(); await new Promise(resolve => setImmediate(resolve));
        assert.ok(f.session.activeMcpServers.cua_repl); assert.equal(f.session.activeMcpServers.native, native);
        assert.equal(writes.length, 1); assert.equal(writes[0].native, native);
    } finally { await f.close(); }
});

test('an older SDK connection cannot issue actions after a new launch replaces its server', async () => {
    const f = fixture();
    try {
        const first = f.state.api.configure('s', { sdkOptions: {}, allMcpServers: {} }).allMcpServers.cua_repl;
        const next = f.state.api.configure('s', { sdkOptions: {}, allMcpServers: {} }).allMcpServers.cua_repl;
        assert.notEqual(next, first);
        f.session.activeMcpServers = { cua_repl: next };
        await assert.rejects(first.options.call('js', {}, { turnId: 'stale' }), /stale|inactive/);
        assert.equal(f.hosts.length, 0);
    } finally { await f.close(); }
});
