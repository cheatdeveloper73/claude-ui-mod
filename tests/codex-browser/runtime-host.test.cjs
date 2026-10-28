'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { createRuntime } = require(path.join(PLUGIN_DIR, 'runtime-host.js'));
const { discoverRuntime } = require(path.join(PLUGIN_DIR, 'discovery.js'));

const SESSION = `host-session-${crypto.randomUUID()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NAMES = ['js', 'js_reset', 'turn_ended'];

// ---- fake MCP runtime (test-owned launcher; argv[2] is the entry) ---------
const FAKE = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const notes = [];
let buf = '';
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
const text = (value, extra) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError: false, ...extra });
process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));
const tool = n => ({ name: n, description: n, inputSchema: { type: 'object' } });
function handle(m) {
    if (m.method === undefined && m.id === 'srv-1') { notes.push({ serverRequestAnswer: m.error || m.result }); return; }
    if (m.method === 'notifications/initialized') { notes.push({ initialized: true }); return; }
    if (m.method === 'notifications/cancelled') { notes.push({ cancelled: m.params }); return; }
    if (m.method === 'initialize') { notes.push({ clientCapabilities: m.params.capabilities }); return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }); }
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('js'), tool('js_add_node_module_dir'), tool('js_reset'), tool('turn_ended')] } });
    if (m.method !== 'tools/call') return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
    const code = m.params.arguments && m.params.arguments.code;
    switch (code) {
    case 'echo': return send({ jsonrpc: '2.0', id: m.id, result: text({ params: m.params }, { _meta: { kept: 1, 'codex/x': { y: 2 } } }) });
    case 'toolerror': return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'bad' }], isError: true, _meta: { z: 1 } } });
    case 'rpcerror': return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'boom' } });
    case 'hang': return;
    case 'slow': return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: text('slow') }), 150);
    case 'fast': return send({ jsonrpc: '2.0', id: m.id, result: text('fast') });
    case 'die': return process.exit(3);
    case 'split': { const s = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: text('split') }) + '\n'; process.stdout.write(s.slice(0, 9)); return setTimeout(() => process.stdout.write(s.slice(9)), 40); }
    case 'crlf': return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: text('crlf') }) + '\r\n');
    case 'junk': process.stdout.write('not json at all\n'); return send({ jsonrpc: '2.0', id: m.id, result: text('after-junk') });
    case 'big': return process.stdout.write('x'.repeat(2048));
    case 'elicit': send({ jsonrpc: '2.0', id: 'srv-1', method: 'elicitation/create', params: { message: 'approve?' } }); return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: text('elicited') }), 80);
    case 'report': return send({ jsonrpc: '2.0', id: m.id, result: text({ notes, env: { backend: process.env.BROWSER_USE_BACKEND_PATHS, available: process.env.BROWSER_USE_AVAILABLE_BACKENDS, surfaces: process.env.CUA_REPL_ENABLED_SURFACES, cli: process.env.CODEX_CLI_PATH, trusted: process.env.NODE_REPL_TRUSTED_SERVICES, hasSecret: Object.keys(process.env).some(k => k.startsWith('TEST_SECRET')), argv: process.argv.slice(2) } }) });
    case 'grandchild': { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); return send({ jsonrpc: '2.0', id: m.id, result: text({ pid: c.pid }) }); }
    default: return send({ jsonrpc: '2.0', id: m.id, result: text('default') });
    }
}
`;

let fixtureDir;
function fixture() {
    if (fixtureDir) return fixtureDir;
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-host-test-'));
    fs.writeFileSync(path.join(fixtureDir, 'fake-launch.cjs'), FAKE);
    for (const f of ['entry.mjs', 'node_repl.exe', 'codex.exe']) fs.writeFileSync(path.join(fixtureDir, f), '');
    fs.mkdirSync(path.join(fixtureDir, 'node_modules'), { recursive: true });
    return fixtureDir;
}
test.after(() => { if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); });

const pipeName = () => `\\\\.\\pipe\\codex-browser-host-test-${process.pid}-${crypto.randomUUID()}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function fakeRuntime(extra = {}) {
    const dir = fixture();
    const logDir = fs.mkdtempSync(path.join(dir, 'log-'));
    const runtime = createRuntime({
        runtime: {
            node: process.execPath, entry: path.join(dir, 'entry.mjs'), nodeRepl: path.join(dir, 'node_repl.exe'),
            nodeModules: path.join(dir, 'node_modules'), codexCli: path.join(dir, 'codex.exe'), codexHome: path.join(dir, 'codex-home'),
        },
        pipePath: pipeName(), sessionId: SESSION, logDir,
        launcher: path.join(dir, 'fake-launch.cjs'), ...extra,
    });
    return { runtime, logDir };
}

async function withRuntime(fn, extra) {
    const ctx = fakeRuntime(extra);
    try { await ctx.runtime.start(); return await fn(ctx); } finally { await ctx.runtime.close(); }
}
const callJs = (runtime, code, turnId = 'turn-1', extra = {}) => runtime.call('js', { code, ...extra.args }, { turnId, ...extra });
const textOf = result => result.content[0].text;

test('missing runtime files fail start with a named error and spawn nothing', async () => {
    const dir = fixture();
    const runtime = createRuntime({
        runtime: { node: path.join(dir, 'absent', 'node.exe'), entry: path.join(dir, 'entry.mjs'), nodeRepl: path.join(dir, 'node_repl.exe'),
            nodeModules: path.join(dir, 'node_modules'), codexCli: path.join(dir, 'nope', 'codex.exe'), codexHome: path.join(dir, 'h') },
        pipePath: pipeName(), sessionId: SESSION, logDir: fs.mkdtempSync(path.join(dir, 'log-')),
    });
    await assert.rejects(runtime.start(), error => {
        assert.equal(error.code, 'RUNTIME_MISSING');
        assert.deepEqual(error.missing.sort(), ['codexCli', 'node']);
        return true;
    });
    assert.equal(runtime.status().state, 'failed');
    assert.equal(runtime.status().pid, null);
    await assert.rejects(runtime.call('js', { code: '1' }, { turnId: 't' }), /not ready/);
    await runtime.close();
});

test('invalid construction is rejected', () => {
    assert.throws(() => createRuntime({}), /runtime/);
    const base = { runtime: { node: 'a', entry: 'b', nodeRepl: 'c', nodeModules: 'd', codexCli: 'e', codexHome: 'f' }, sessionId: 's', logDir: os.tmpdir() };
    assert.throws(() => createRuntime({ ...base, pipePath: 'relative' }), /pipePath/);
    assert.throws(() => createRuntime({ ...base, pipePath: '\\\\.\\pipe\\a;b' }), /pipePath/);
    assert.throws(() => createRuntime({ ...base, pipePath: pipeName(), sessionId: '' }), /sessionId/);
});

test('start exposes exactly js/js_reset/turn_ended and never js_add_node_module_dir', async () => {
    const { runtime } = fakeRuntime();
    try {
        const tools = await runtime.start();
        assert.deepEqual(tools.map(t => t.name), NAMES);
        assert.equal(await runtime.start(), tools);
        await assert.rejects(runtime.call('js_add_node_module_dir', { dir: 'C:\\x' }, { turnId: 't' }), /unsupported tool/);
    } finally { await runtime.close(); }
});

test('metadata is built from the closed-over session and returned result is unchanged', async () => {
    await withRuntime(async ({ runtime }) => {
        const result = await callJs(runtime, 'echo', 'turn-A', { args: { timeout_ms: 5000, _meta: { 'x-codex-turn-metadata': { session_id: 'forged' } } } });
        const echoed = JSON.parse(textOf(result)).params;
        assert.deepEqual(echoed._meta, { 'x-codex-turn-metadata': { session_id: SESSION, turn_id: 'turn-A' } });
        assert.equal(echoed.name, 'js');
        assert.equal(echoed.arguments.timeout_ms, 5000);
        assert.equal(result.isError, false);
        assert.deepEqual(result._meta, { kept: 1, 'codex/x': { y: 2 } });
        const tool = await callJs(runtime, 'toolerror');
        assert.deepEqual(tool, { content: [{ type: 'text', text: 'bad' }], isError: true, _meta: { z: 1 } });
        await assert.rejects(callJs(runtime, 'rpcerror'), error => error.code === -32000 && /boom/.test(error.message));
        await assert.rejects(runtime.call('js', { code: 'x' }, {}), /turnId/);
    });
});

test('chunked, CRLF and interleaved replies resolve the right caller; junk lines are ignored', async () => {
    await withRuntime(async ({ runtime }) => {
        assert.equal(textOf(await callJs(runtime, 'split')), 'split');
        assert.equal(textOf(await callJs(runtime, 'crlf')), 'crlf');
        const [slow, fast] = await Promise.all([callJs(runtime, 'slow'), callJs(runtime, 'fast')]);
        assert.equal(textOf(slow), 'slow');
        assert.equal(textOf(fast), 'fast');
        assert.equal(textOf(await callJs(runtime, 'junk')), 'after-junk');
        assert.equal(runtime.status().protocolErrors, 1);
    });
});

test('pending requests are bounded', async () => {
    await withRuntime(async ({ runtime }) => {
        const ac = new AbortController();
        const first = callJs(runtime, 'hang', 't', { signal: ac.signal });
        await assert.rejects(callJs(runtime, 'fast'), error => error.code === 'RUNTIME_BUSY');
        ac.abort();
        await assert.rejects(first, error => error.name === 'AbortError');
        assert.equal(textOf(await callJs(runtime, 'fast')), 'fast');
        assert.equal(runtime.status().pending, 0);
    }, { limits: { maxPending: 1 } });
});

test('oversized stdout line is fatal: pending calls reject and the tree is killed', async () => {
    const { runtime } = fakeRuntime({ limits: { maxLineBytes: 1024 } });
    try {
        await runtime.start();
        const pid = runtime.status().pid;
        await assert.rejects(callJs(runtime, 'big'), error => error.code === 'RUNTIME_PROTOCOL');
        assert.equal(runtime.status().state, 'failed');
        for (let i = 0; i < 50 && alive(pid); i++) await sleep(50);
        assert.equal(alive(pid), false);
    } finally { await runtime.close(); }
});

test('caller cancellation sends notifications/cancelled once and drops the late reply', async () => {
    const cancels = [];
    await withRuntime(async ({ runtime }) => {
        const pre = new AbortController(); pre.abort();
        await assert.rejects(callJs(runtime, 'echo', 't', { signal: pre.signal }), error => error.name === 'AbortError');
        const ac = new AbortController();
        const pending = callJs(runtime, 'hang', 'turn-C', { signal: ac.signal });
        await sleep(50);
        ac.abort();
        await assert.rejects(pending, error => error.name === 'AbortError');
        ac.abort();
        const report = JSON.parse(textOf(await callJs(runtime, 'report'))).notes;
        const sent = report.filter(n => n.cancelled);
        assert.equal(sent.length, 1);
        assert.equal(typeof sent[0].cancelled.requestId, 'number');
        assert.equal(cancels.length, 1);
        assert.equal(cancels[0].turnId, 'turn-C');
        assert.equal(cancels[0].name, 'js');
        assert.equal(runtime.status().pending, 0);
    }, { onCancel: info => cancels.push(info) });
});

test('runtime exit rejects pending and later calls; no auto-replay', async () => {
    const { runtime } = fakeRuntime();
    try {
        await runtime.start();
        await assert.rejects(callJs(runtime, 'die'), error => error.code === 'RUNTIME_EXITED');
        assert.equal(runtime.status().state, 'exited');
        assert.equal(runtime.status().exit.code, 3);
        await assert.rejects(callJs(runtime, 'fast'), /not ready/);
    } finally { await runtime.close(); }
});

test('server-initiated elicitation gets a JSON-RPC error, never an approval', async () => {
    await withRuntime(async ({ runtime }) => {
        assert.equal(textOf(await callJs(runtime, 'elicit')), 'elicited');
        const notes = JSON.parse(textOf(await callJs(runtime, 'report'))).notes;
        const answer = notes.find(n => n.serverRequestAnswer).serverRequestAnswer;
        assert.equal(answer.code, -32601);
        assert.match(answer.message, /elicitation\/create/);
    });
});

test('configured elicitation advertises form capability and preserves the client response', async () => {
    const seen = [], response = { action: 'cancel' };
    const { runtime } = fakeRuntime({ onElicitation: async params => { seen.push(params); return response; } });
    try {
        await runtime.start(); await callJs(runtime, 'elicit');
        const notes = JSON.parse(textOf(await callJs(runtime, 'report'))).notes;
        assert.deepEqual(notes.find(row => row.clientCapabilities).clientCapabilities, { elicitation: { form: {} } });
        assert.deepEqual(seen, [{ message: 'approve?' }]);
        assert.deepEqual(notes.find(row => row.serverRequestAnswer).serverRequestAnswer, response);
    } finally { await runtime.close(); }
});

test('environment is explicit, allowlisted, and the entry is passed once', async () => {
    const saved = process.env.TEST_SECRET_TOKEN;
    process.env.TEST_SECRET_TOKEN = 'sk-do-not-leak';
    try {
        const { runtime } = fakeRuntime();
        try {
            await runtime.start();
            const env = JSON.parse(textOf(await callJs(runtime, 'report'))).env;
            assert.equal(env.backend, runtime.status().pipePath);
            assert.equal(env.available, 'iab');
            assert.equal(env.surfaces, 'browser');
            assert.match(env.cli, /codex\.exe$/);
            assert.deepEqual(JSON.parse(env.trusted), { browser: '@oai/browser-desktop/service' });
            assert.equal(env.hasSecret, false);
            assert.equal(env.argv.length, 1);
            assert.match(env.argv[0], /entry\.mjs$/);
        } finally { await runtime.close(); }
    } finally {
        if (saved === undefined) delete process.env.TEST_SECRET_TOKEN; else process.env.TEST_SECRET_TOKEN = saved;
    }
});

test('close kills only its own tree, including grandchildren, and is idempotent', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    const { runtime } = fakeRuntime();
    let grandchild = 0;
    try {
        await runtime.start();
        const root = runtime.status().pid;
        grandchild = JSON.parse(textOf(await callJs(runtime, 'grandchild'))).pid;
        assert.ok(alive(root) && alive(grandchild));
        const pending = callJs(runtime, 'hang');
        pending.catch(() => {});
        await runtime.close();
        await assert.rejects(pending, error => error.code === 'RUNTIME_CLOSED');
        assert.equal(alive(root), false);
        for (let i = 0; i < 40 && alive(grandchild); i++) await sleep(50);
        assert.equal(alive(grandchild), false);
        assert.equal(alive(sentinel.pid), true);
        await runtime.close();
        assert.equal(runtime.status().state, 'closed');
    } finally {
        await runtime.close();
        sentinel.kill();
        if (grandchild && alive(grandchild)) try { process.kill(grandchild); } catch {}
    }
});

test('logs record lifecycle only: no JS source, no env values', async () => {
    const saved = process.env.TEST_SECRET_TOKEN;
    process.env.TEST_SECRET_TOKEN = 'sk-LEAKMARK-env';
    try {
        const { runtime, logDir } = fakeRuntime();
        try {
            await runtime.start();
            await runtime.call('js', { code: 'echo', note: 'LEAKMARK-source' }, { turnId: 'turn-L' });
        } finally { await runtime.close(); }
        const files = fs.readdirSync(logDir);
        assert.ok(files.includes('runtime-host.log'));
        const all = files.map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
        assert.ok(!all.includes('LEAKMARK'), 'log leaked a marker');
        assert.match(all, /"event":"call"/);
    } finally {
        if (saved === undefined) delete process.env.TEST_SECRET_TOKEN; else process.env.TEST_SECRET_TOKEN = saved;
    }
});

// ---- actual official runtime, synthetic backend pipe ----------------------
function probeRuntime() {
    if (process.platform !== 'win32') return { skip: 'official runtime is Windows-only' };
    const runtime = discoverRuntime();
    return runtime ? { runtime } : { skip: 'official runtime files are not installed' };
}

function frame(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length, 0);
    return Buffer.concat([prefix, body]);
}
async function syntheticBackend(pipePath, sessionId, requests) {
    const server = net.createServer(socket => {
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
                const length = buffer.readUInt32LE(0);
                const request = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
                buffer = buffer.subarray(4 + length);
                requests.push(request);
                const results = {
                    getInfo: { id: 'claude', name: 'Claude', type: 'iab', discoveryScope: 'session', metadata: { codexSessionId: sessionId, codexAppBuildFlavor: 'prod' }, capabilities: {} },
                    getTabs: [], ping: {}, turnEnded: {},
                };
                socket.write(frame(request.method in results
                    ? { jsonrpc: '2.0', id: request.id, result: results[request.method] }
                    : { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unsupported ${request.method}` } }));
            }
        });
        socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
    return server;
}

const probe = probeRuntime();
test('actual official runtime: js cua.getState() through a synthetic scoped backend pipe', { skip: probe.skip, timeout: 90000 }, async () => {
    const dir = fixture();
    const logDir = fs.mkdtempSync(path.join(dir, 'log-'));
    const pipePath = pipeName();
    const turnId = `turn-${crypto.randomUUID()}`;
    const requests = [];
    const server = await syntheticBackend(pipePath, SESSION, requests);
    const runtime = createRuntime({ runtime: probe.runtime, pipePath, sessionId: SESSION, logDir });
    try {
        const tools = await runtime.start();
        assert.deepEqual(tools.map(t => t.name).sort(), [...NAMES].sort());
        const result = await runtime.call('js', { code: 'await cua.getState(); /* LEAKMARK-real */', timeout_ms: 20000 }, { turnId });
        assert.equal(result.isError, false, JSON.stringify(result).slice(0, 400));
        // The first call in a session prepends the runtime's usage instructions as an extra text item.
        const state = JSON.parse(result.content[result.content.length - 1].text);
        assert.equal(result._meta['codex/browserUse'], true);
        assert.equal(result._meta['codex/toolSurface'].backend, 'iab');
        assert.equal(state.browsers.length, 1);
        assert.equal(state.browsers[0].type, 'iab');
        assert.equal(state.browsers[0].name, 'Claude');
        const methods = requests.map(r => r.method);
        assert.ok(methods.includes('getInfo') && methods.includes('getTabs'), methods.join());
        for (const request of requests.filter(r => r.method === 'getTabs')) {
            assert.equal(request.params.session_id, SESSION);
            assert.equal(request.params.turn_id, turnId);
        }
        await assert.rejects(runtime.call('js_add_node_module_dir', { dir: 'C:\\x' }, { turnId }), /unsupported tool/);
        const ended = await runtime.call('turn_ended', { hook_event_name: 'Stop', session_id: SESSION, turn_id: turnId }, { turnId });
        assert.equal(typeof ended, 'object');
        const logs = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
        assert.ok(!logs.includes('LEAKMARK'));
    } finally {
        const pid = runtime.status().pid;
        await runtime.close();
        if (pid) for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
        await new Promise(resolve => server.close(resolve));
    }
});
