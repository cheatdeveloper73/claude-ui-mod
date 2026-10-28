'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const SOURCE = process.env.CUIMOD_MAIN_IO_SOURCE || path.resolve(__dirname, '..');
const { Store } = require(path.join(SOURCE, 'src/plugins/campaigns/core'));
const { createFeed } = require(path.join(SOURCE, 'integrations/desktop-mcp-events/feed.cjs'));
const { createStatusMonitor } = require(path.join(SOURCE, 'integrations/desktop-mcp-events/status-monitor.cjs'));
const args = { machineId: 'fixture-machine', desktopSessionId: 'local_11111111-1111-4111-8111-111111111111' };
function temp(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-process-io-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function counts(t, relevant) {
    const counts = { reads: 0, directories: 0, flushes: 0, stats: 0, exists: 0 };
    for (const [method, key] of [['readFileSync', 'reads'], ['readdirSync', 'directories'], ['fsyncSync', 'flushes'], ['statSync', 'stats'], ['existsSync', 'exists']]) {
        const original = fs[method];
        t.mock.method(fs, method, function (...args) {
            if (method === 'fsyncSync' || relevant(args[0])) counts[key]++;
            return Reflect.apply(original, this, args);
        });
    }
    return counts;
}
function campaign(root, id = '1111111111111111') {
    const store = new Store(root);
    store.write({ id, schema: 2, root: { desktopSessionId: 'campaign-owner' }, claims: [], tasks: [], revision: 0, title: 'fixture', mode: 'draft' });
    return { store, id, file: store.filename(id) };
}
function replace(file, body) {
    const original = fs.statSync(file);
    fs.writeFileSync(file + '.replacement', body);
    fs.utimesSync(file + '.replacement', original.atime, original.mtime);
    fs.renameSync(file + '.replacement', file);
}

test('unchanged campaign reads/listings do not reread or re-enumerate persisted campaigns', t => {
    const root = temp(t), f = campaign(root);
    f.store.list(); f.store.get(f.id);
    const io = counts(t, file => String(file).startsWith(root));
    for (let i = 0; i < 100; i++) { f.store.list(); f.store.get(f.id); }
    console.log('IO campaign steady x100', JSON.stringify(io));
    assert.deepEqual(io, { reads: 0, directories: 0, flushes: 0, stats: 300, exists: 0 });
});

test('campaign cache observes writes, atomic external replacements, deletion and new directories immediately', t => {
    const root = temp(t), f = campaign(root);
    f.store.list();
    const detached = f.store.get(f.id); detached.root.desktopSessionId = 'not-persisted';
    assert.equal(f.store.get(f.id).root.desktopSessionId, 'campaign-owner');
    f.store.change(f.id, row => { row.mode = 'active'; });
    assert.equal(f.store.get(f.id).mode, 'active');
    const prior = fs.readFileSync(f.file, 'utf8');
    replace(f.file, prior.replace('active', 'paused'));
    assert.equal(f.store.get(f.id).mode, 'paused', 'same-size same-mtime replacement must invalidate');
    const stamp = fs.statSync(f.file);
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('paused', 'active'));
    fs.utimesSync(f.file, stamp.atime, stamp.mtime);
    assert.equal(f.store.get(f.id).mode, 'active', 'in-place edit with restored mtime must invalidate via ctime');
    const other = campaign(root, '2222222222222222');
    assert.equal(f.store.list().length, 2);
    fs.rmSync(path.dirname(other.file), { recursive: true });
    assert.equal(f.store.list().length, 1);
    fs.writeFileSync(f.file, '{');
    assert.throws(() => f.store.get(f.id), SyntaxError, 'campaign corruption must not be hidden by last good data');
    assert.equal(f.store.list()[0].mode, 'unreadable');
});

test('campaign event consumer ignores stream/nonmutating events before any campaign I/O', t => {
    const root = temp(t);
    const f = campaign(path.join(root, '.state', 'campaigns'));
    const manager = new EventEmitter(); manager.sessions = new Map(); manager.buildStartSdkOptions = async () => ({});
    manager.stopSession = () => {}; manager.interruptSession = () => {};
    const cacheKey = path.join(root, 'fixture-session-manager.cjs');
    require.cache[cacheKey] = { exports: { claudeCodeSessionManager: manager } };
    const disposers = [], broadcasts = [];
    const key = Symbol.for('cuimod.campaigns'), previous = globalThis[key]; delete globalThis[key];
    t.after(() => { for (const dispose of disposers.reverse()) dispose(); delete require.cache[cacheKey]; if (previous) globalThis[key] = previous; else delete globalThis[key]; });
    require(path.join(SOURCE, 'src/plugins/campaigns/main'))({ boot: { MOD_DIR: root }, dir: path.join(SOURCE, 'src/plugins/campaigns'),
        method() {}, every() {}, onDispose(fn) { disposers.push(fn); }, log() {}, broadcast(event) { broadcasts.push(event); } });
    const io = counts(t, file => String(file).startsWith(root));
    for (let i = 0; i < 100; i++) {
        for (const sessionId of ['campaign-owner', 'unattached-chat']) {
            manager.emit('event', { sessionId, type: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta' } } });
            manager.emit('event', { sessionId, type: 'message', message: { type: 'result', subtype: 'success' } });
        }
    }
    console.log('IO campaign irrelevant native events x400', JSON.stringify(io), 'broadcasts', broadcasts.length);
    assert.deepEqual(io, { reads: 0, directories: 0, flushes: 0, stats: 0, exists: 0 });
    assert.equal(broadcasts.length, 0);
    manager.emit('event', { sessionId: 'campaign-owner', type: 'message', message: { type: 'system', subtype: 'init', session_id: 'cli-fixture' } });
    assert.equal(JSON.parse(fs.readFileSync(f.file)).root.cliSessionId, 'cli-fixture');
    assert.equal(broadcasts.length, 1);
    manager.emit('event', { sessionId: 'campaign-owner', type: 'message', message: { type: 'result', subtype: 'error' } });
    assert.match(JSON.parse(fs.readFileSync(f.file)).rootError, /error/);
});

test('unchanged status prune performs zero durable writes; removing a session still flushes once', t => {
    const root = temp(t), monitor = createStatusMonitor({ stateDir: root, observe() {} });
    monitor.scan(args, { monitorState: 'running' });
    const io = counts(t, () => true);
    for (let i = 0; i < 100; i++) { monitor.scan(args, { monitorState: 'running' }); monitor.prune([args]); }
    console.log('IO status unchanged scan/prune x100', JSON.stringify(io));
    assert.equal(io.flushes, 0);
    monitor.prune([]);
    assert.equal(io.flushes, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'status-cursors.json'))), {});
});

test('real status transition fsyncs pending before delivery and acknowledgment after delivery', t => {
    const root = temp(t), file = path.join(root, 'status-cursors.json');
    let io, pendingId;
    const monitor = createStatusMonitor({ stateDir: root, observe(event) {
        const row = JSON.parse(fs.readFileSync(file))[args.machineId + '/' + args.desktopSessionId];
        assert.equal(row.pending.messageId, event.messageId); pendingId = event.messageId;
        assert.equal(io.flushes, 1);
    } });
    monitor.scan(args, { monitorState: 'running' }); io = counts(t, () => true);
    monitor.scan(args, { monitorState: 'failed' });
    assert.ok(pendingId); assert.equal(io.flushes, 2);
    assert.equal(JSON.parse(fs.readFileSync(file))[args.machineId + '/' + args.desktopSessionId].pending, undefined);
});

test('unchanged feed metadata is not reread; leases, journal revisions and external replacements remain live', t => {
    const root = temp(t); let now = 1000;
    const feed = createFeed(root, () => now), watched = feed.watch('consumer-fixture', [args.desktopSessionId]);
    feed.observe({ ...args, monitorState: 'running' }); feed.targets();
    const metadata = path.join(root, 'feed.json'), io = counts(t, file => file === metadata);
    for (let i = 0; i < 100; i++) { feed.targets(); feed.observe({ ...args, monitorState: 'running' }); feed.page('consumer-fixture', watched.cursor); }
    console.log('IO feed unchanged targets/observe/page x100', JSON.stringify(io));
    assert.equal(io.reads, 0); assert.equal(io.flushes, 0);
    feed.observe({ ...args, monitorState: 'idle' });
    assert.equal(io.flushes, 2, 'journal and snapshot both remain durable');
    assert.deepEqual(feed.page('consumer-fixture', watched.cursor).events.map(row => row.data.revision), [1, 2]);
    const state = JSON.parse(fs.readFileSync(metadata)); state.watches['consumer-fixture'].ids = [];
    replace(metadata, JSON.stringify(state));
    assert.deepEqual(feed.targets(), []);
    const other = createFeed(root, () => now); other.watch('other-consumer', [args.desktopSessionId]);
    assert.deepEqual(feed.targets(), [args.desktopSessionId], 'other feed instance must invalidate cached snapshot');
    now += 3600001;
    assert.deepEqual(feed.targets(), []); assert.throws(() => feed.page('other-consumer'), /Renew/);
});
