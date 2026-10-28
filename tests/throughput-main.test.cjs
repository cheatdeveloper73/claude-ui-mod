'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const source = fs.readFileSync(process.env.CUIMOD_THROUGHPUT_MAIN || path.join(__dirname, '../src/plugins/throughput/main.js'), 'utf8');
const SID = '11111111-2222-3333-4444-555555555555';
const DESKTOP = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const completedAt = new Date().toISOString();
const record = {
    sessionId: SID, responseId: 'msg_fixture', provider: 'fixture', servedModel: 'fixture-model',
    subagent: true, completedAt, outputTps: 80, endToEndTps: 40, streamMs: 1000,
    tokens: { outputTokens: 80 },
};

function load({ files = {}, remote } = {}) {
    const methods = new Map();
    const requests = [];
    const disposers = [];
    const root = path.join('fixture-home', '.claude', 'projects');
    const fileMap = new Map(Object.entries(files).map(([name, value]) => [path.join(root, name), value]));
    const dirs = new Set([root]);
    for (const file of fileMap.keys()) {
        for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) dirs.add(dir);
    }
    const missing = () => { throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' }); };
    const fakeFS = {
        readdirSync(dir) {
            if (!dirs.has(dir)) return missing();
            return [...new Set([...fileMap.keys(), ...dirs].filter(file => path.dirname(file) === dir).map(file => path.basename(file)))];
        },
        existsSync(file) { return fileMap.has(file) || dirs.has(file); },
        statSync(file) {
            if (!fileMap.has(file)) return missing();
            return { size: Buffer.byteLength(fileMap.get(file)), mtimeMs: Date.now() };
        },
        openSync(file) { if (!fileMap.has(file)) return missing(); return file; },
        readSync(file, buffer, offset, length, position) { return Buffer.from(fileMap.get(file)).copy(buffer, offset, position, position + length); },
        closeSync() {},
        readFileSync(file) { return fileMap.get(file) || missing(); },
    };
    const snapshot = { observedAt: completedAt, records: 1, live: [], recent: [record], providers: [] };
    const sandbox = {
        module: { exports: {} }, Buffer, URLSearchParams, process: { env: {} },
        require(name) {
            if (name === 'fs') return fakeFS;
            if (name === 'path') return path;
            if (name === 'os') return { homedir: () => 'fixture-home' };
            if (name === 'http') return {
                get(url, options, callback) {
                    requests.push(url);
                    const req = new EventEmitter();
                    req.destroy = error => req.emit('error', error);
                    queueMicrotask(() => {
                        const res = new EventEmitter();
                        res.statusCode = 200;
                        callback(res);
                        res.emit('data', Buffer.from(JSON.stringify(url.endsWith('/throughputz') ? snapshot : { records: [record], matched: 1, returned: 1 })));
                        res.emit('end');
                    });
                    return req;
                },
            };
            throw Error('unexpected require: ' + name);
        },
    };
    if (remote) sandbox[Symbol.for('cuimod.remote.router-source')] = remote;
    vm.runInNewContext(source, sandbox, { filename: 'throughput/main.js' });
    sandbox.module.exports({ method: (name, fn) => methods.set(name, fn), onDispose: fn => disposers.push(fn) });
    return { methods, requests, dispose: () => disposers.forEach(fn => fn()) };
}

test('remote live, snapshot and history read the bound host instead of the local router', async () => {
    const routes = [];
    const remoteRecord = { ...record, outputTps: 160, subagent: false };
    const remote = {
        forSession(id, desktopId) {
            assert.equal(id, SID);
            assert.equal(desktopId, DESKTOP);
            return { key: 'remote/fixture/' + DESKTOP, async readJSON(route) {
                routes.push(route);
                return route === '/throughputz'
                    ? { observedAt: completedAt, records: 7, live: [{ sessionId: SID, subagent: false, observedTps: 160 }], recent: [], providers: [] }
                    : { records: [remoteRecord], matched: 1, returned: 1 };
            } };
        },
    };
    const plugin = load({ remote });
    const params = { sessionId: SID, desktopSessionId: DESKTOP };
    try {
        const live = await plugin.methods.get('live')(params);
        assert.equal(live.last.outputTps, 160);
        assert.equal(live.live[0].observedTps, 160);
        const snapshot = await plugin.methods.get('snapshot')(params);
        assert.equal(snapshot.records, 7);
        assert.equal(snapshot.recent[0].outputTps, 160);
        const history = await plugin.methods.get('history')(params);
        assert.equal(history.models[0].p50Tps, 160);
        assert.equal(plugin.requests.length, 0, 'remote traffic never reads the PC router');
        assert.ok(routes.some(route => route.startsWith('/throughput/api?')));
    } finally { plugin.dispose(); }
});

test('a disconnected remote source fails without falling back to local telemetry', async () => {
    const plugin = load({ remote: { forSession() { throw Error('remote router disconnected'); } } });
    try {
        await assert.rejects(plugin.methods.get('live')({ sessionId: SID, desktopSessionId: DESKTOP }), /disconnected/);
        assert.equal(plugin.requests.length, 0);
    } finally { plugin.dispose(); }
});

test('local and remote telemetry caches stay separate for the same CLI id', async () => {
    const remoteRecord = { ...record, outputTps: 160 };
    const plugin = load({ remote: { forSession(_id, desktopId) {
        return desktopId === DESKTOP ? { key: 'remote/fixture', async readJSON(route) {
            return route === '/throughputz' ? { live: [], observedAt: completedAt }
                : { records: [remoteRecord] };
        } } : null;
    } } });
    try {
        const local = await plugin.methods.get('live')({ sessionId: SID });
        const remote = await plugin.methods.get('live')({ sessionId: SID, desktopSessionId: DESKTOP });
        assert.equal(local.last.outputTps, 80);
        assert.equal(remote.last.outputTps, 160);
        assert.equal(plugin.requests.length, 2);
    } finally { plugin.dispose(); }
});

test('renderer sends Desktop identity and drops a chip reply after navigation', async () => {
    const renderer = fs.readFileSync(process.env.CUIMOD_THROUGHPUT_RENDERER || path.join(__dirname, '../src/plugins/throughput/renderer.js'), 'utf8');
    const timers = [];
    let changed, finish;
    const calls = [];
    const cuimod = { sessionId: SID, desktopSessionId: DESKTOP,
        onSessionChange(fn) { changed = fn; fn(SID); },
        rpc(name, params) { calls.push({ name, params }); return new Promise(resolve => { finish = resolve; }); },
    };
    const wrap = { children: [{}] };
    let markerQueries = 0;
    const document = { body: {}, visibilityState: 'visible',
        querySelectorAll(selector) {
            if (!selector.includes('data-perf-row')) return [];
            markerQueries++;
            return [{ querySelector() { return { firstElementChild: wrap }; } }];
        },
        createElement() { throw Error('a stale response must never build a chip'); },
    };
    vm.runInNewContext(renderer, { cuimod, document,
        ctx: { every(ms, fn) { timers.push({ ms, fn }); }, track() {}, onDispose() {} },
        MutationObserver: class { observe() {} disconnect() {} },
    });
    const pending = timers.find(timer => timer.ms === 1000).fn();
    assert.equal(calls[0].name, 'throughput.live');
    assert.equal(calls[0].params.desktopSessionId, DESKTOP);
    cuimod.desktopSessionId = 'local_00000000-0000-0000-0000-000000000000';
    changed('00000000-0000-0000-0000-000000000000');
    cuimod.desktopSessionId = DESKTOP;
    changed(SID);
    finish({ live: [{ observedTps: 160 }] });
    await pending;
    assert.equal(markerQueries, 1, 'A → B → A does not paint the first visit’s pending reply');
});

const assistant = JSON.stringify({ message: { id: record.responseId, role: 'assistant', model: record.servedModel } }) + '\n';

test('nested local transcripts attribute the response to its agent', async () => {
    const plugin = load({ files: { [path.join('project', SID, 'subagents', 'agent-worker.jsonl')]: assistant } });
    try {
        const value = await plugin.methods.get('snapshot')({ sessionId: SID });
        assert.equal(value.recent[0].agentId, 'worker');
        assert.equal(value.recent[0].lane, 'subagent');
    } finally { plugin.dispose(); }
});

test('flat SSH transcript mirrors attribute the response to its agent', async () => {
    const plugin = load({ files: {
        [path.join('ssh-' + SID, SID + '.jsonl')]: '',
        [path.join('ssh-' + SID, 'agent-worker.jsonl')]: assistant,
    } });
    try {
        const value = await plugin.methods.get('snapshot')({ sessionId: SID, desktopSessionId: DESKTOP });
        assert.equal(value.recent[0].agentId, 'worker');
        assert.equal(value.recent[0].lane, 'subagent');
    } finally { plugin.dispose(); }
});
