'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cacheFile = path.join(__dirname, '../src/plugins/subagents/jsonl-cache.js');
const mainFile = path.join(__dirname, '../src/plugins/subagents/main.js');
const SID = '11111111-2222-3333-4444-555555555555';
function load(file, overrides = {}) {
    const mod = { exports: {} };
    const req = name => Object.hasOwn(overrides, name) ? overrides[name]
        : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: mod, exports: mod.exports,
        require: req, Buffer, process, clearInterval, Date, console }, { filename: file });
    return mod.exports;
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-cache-'));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
const line = value => JSON.stringify(value) + '\n';
function row(n, text = 'text-' + n) {
    return { type: 'assistant', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
        message: { model: 'fixture', stop_reason: 'end_turn', usage: { output_tokens: n + 1 },
            content: [{ type: 'text', text }] } };
}
function cache(overrides = {}, options = {}) {
    return load(cacheFile, overrides)(() => ({ rows: [] }), (state, text) => {
        try { state.rows.push(JSON.parse(text)); } catch (_) {}
    }, options);
}
test('unchanged files do not reread; append consumes only new bytes and fixed anchors', t => {
    const f = path.join(fixture(t), 'log');
    fs.writeFileSync(f, line(row(1, 'x'.repeat(10000))));
    const c = cache(); c.read(f);
    const first = c.stats();
    assert.equal(c.read(f).rows.length, 1);
    assert.equal(c.stats().reads, first.reads);
    const append = line(row(2)); fs.appendFileSync(f, append);
    assert.equal(c.read(f).rows.length, 2);
    assert.equal(c.stats().bytes - first.bytes, Buffer.byteLength(append) + 128);
    assert.equal(c.read(f).rows.length, 2);
});
test('partial JSON and UTF-8 writes are carried without loss or duplicated records', t => {
    const f = path.join(fixture(t), 'log'); const c = cache();
    const bytes = Buffer.from(line({ value: 'α🙂日本語' }));
    const split = bytes.indexOf(Buffer.from('🙂')) + 2;
    fs.writeFileSync(f, bytes.subarray(0, split)); assert.equal(c.read(f).rows.length, 0);
    fs.appendFileSync(f, bytes.subarray(split, bytes.length - 1)); assert.equal(c.read(f).rows.length, 0);
    fs.appendFileSync(f, '\n');
    assert.equal(c.read(f).rows[0].value, 'α🙂日本語');
    assert.equal(c.read(f).rows.length, 1);
});
test('multi-byte text crossing a read chunk boundary remains exact', t => {
    const f = path.join(fixture(t), 'log');
    const text = 'x'.repeat(256 * 1024 - 11) + '🙂tail';
    fs.writeFileSync(f, line({ value: text }));
    assert.equal(cache().read(f).rows[0].value, text);
});
test('truncation, same-size rewriting, growing rewriting and inode rotation reset aggregates', t => {
    const dir = fixture(t), f = path.join(dir, 'log'); const c = cache();
    fs.writeFileSync(f, line({ old: 'first' })); c.read(f);
    fs.writeFileSync(f, line({ new: 'fresh' }));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 10000));
    assert.deepEqual(JSON.parse(JSON.stringify(c.read(f).rows)), [{ new: 'fresh' }]);
    fs.writeFileSync(f, line({ rewritten: 'larger-new-record' }));
    assert.equal(c.read(f).rows[0].rewritten, 'larger-new-record');
    fs.writeFileSync(f, ''); assert.equal(c.read(f).rows.length, 0);
    fs.appendFileSync(f, line({ value: 'old inode' })); c.read(f);
    const replacement = path.join(dir, 'replacement'); fs.writeFileSync(replacement, line({ value: 'new inode' }));
    fs.renameSync(f, path.join(dir, 'old')); fs.renameSync(replacement, f);
    assert.equal(c.read(f).rows[0].value, 'new inode');
    assert.ok(c.stats().resets >= 4);
});
test('append during a read belongs to the next snapshot and is consumed once', t => {
    const f = path.join(fixture(t), 'log'); fs.writeFileSync(f, line({ n: 1 }));
    let injected = false;
    const wrapped = { ...fs, readSync(...args) {
        if (!injected) { injected = true; fs.appendFileSync(f, line({ n: 2 })); }
        return fs.readSync(...args);
    } };
    const c = cache({ fs: wrapped });
    assert.equal(c.read(f).rows.length, 1);
    assert.equal(c.read(f).rows.length, 2);
    assert.equal(c.read(f).rows.length, 2);
});
test('failed reads invalidate incomplete aggregates; eviction retains exact retrieval', t => {
    const dir = fixture(t), f = path.join(dir, 'log'); fs.writeFileSync(f, line({ n: 1 }));
    let fail = true;
    const c = cache({ fs: { ...fs, readSync(...args) {
        if (fail) { fail = false; throw Error('fixture failure'); } return fs.readSync(...args);
    } } }, { maxEntries: 1 });
    assert.throws(() => c.read(f), /fixture failure/);
    assert.equal(c.read(f).rows.length, 1);
    const other = path.join(dir, 'other'); fs.writeFileSync(other, line({ n: 2 })); c.read(other);
    assert.equal(c.read(f).rows[0].n, 1);
    assert.ok(c.stats().evictions >= 1);
});
function plugin(t) {
    const root = fixture(t), project = path.join(root, '.claude/projects/fake');
    const agents = path.join(project, SID, 'subagents'); fs.mkdirSync(agents, { recursive: true });
    const parent = path.join(project, SID + '.jsonl'), child = path.join(agents, 'agent-agent1.jsonl');
    fs.writeFileSync(parent, ''); fs.writeFileSync(child, '');
    const methods = new Map(), disposers = [];
    load(mainFile, { os: { homedir: () => root }, './jsonl-cache': load(cacheFile) })({
        method: (name, fn) => methods.set(name, fn), onDispose: fn => disposers.push(fn),
        electron: { shell: {} },
    });
    const detail = opts => methods.get('detail')({ cliSid: SID, agentId: 'agent1', ...opts });
    return { parent, child, methods, detail, dispose: () => disposers.forEach(fn => fn()) };
}
test('cached detail preserves completed agents, full history, option variants and append totals', async t => {
    const p = plugin(t);
    fs.writeFileSync(p.child, [row(1), row(2), row(3)].map(line).join(''));
    assert.equal(p.detail({ maxTurns: 1 }).turns.length, 1);
    assert.equal(p.detail({ maxTurns: 1 }).dropped, 2);
    const before = p.methods.get('cacheStats')().detail;
    const values = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve(p.detail({ maxTurns: 100 }))));
    for (const value of values) assert.equal(value.turns.length, 3);
    assert.equal(p.methods.get('cacheStats')().detail.reads, before.reads);
    fs.appendFileSync(p.child, line(row(6)));
    const all = p.detail({ maxTurns: 100 });
    assert.equal(all.lines, 4); assert.equal(all.tokens.out, 16); assert.equal(all.turns.length, 4);
    const gaps = p.detail({ maxTurns: 100, gapMs: 1500 });
    assert.equal(gaps.turns.filter(x => x.kind === 'gap').length, 1);
    assert.equal(p.detail({ maxTurns: 100 }).turns.length, 4);
    p.dispose(); assert.equal(p.methods.get('cacheStats')().detail.entries, 0);
});
test('parent joins persist pending spawns across appends and reset completion on rotation', t => {
    const p = plugin(t);
    fs.writeFileSync(p.child, line({ ...row(1), message: { content: [{ type: 'text', text: 'working' }] } }));
    const spawn = line({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: {
        content: [{ type: 'tool_use', name: 'Agent', id: 'launch1', input: { name: 'named' } }] } });
    fs.writeFileSync(p.parent, spawn);
    const list = () => p.methods.get('list')({ cliSid: SID });
    list(); const before = p.methods.get('cacheStats')().parent;
    fs.appendFileSync(p.parent, line({ type: 'user', message: { content: [{ type: 'tool_result',
        tool_use_id: 'launch1', content: 'Async agent launched successfully. agentId: agent1' }] } }));
    assert.equal(list().agents[0].name, 'named');
    assert.ok(p.methods.get('cacheStats')().parent.bytes - before.bytes < 1000);
    const at = new Date(Date.now() + 10000).toISOString();
    fs.appendFileSync(p.parent, line({ timestamp: at, content: '<task-notification><task-id>agent1</task-id><status>completed</status></task-notification>' }));
    assert.equal(list().agents[0].state, 'done');
    fs.writeFileSync(p.parent, '');
    assert.equal(list().agents[0].state, 'inflight');
});
