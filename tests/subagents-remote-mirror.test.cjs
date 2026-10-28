'use strict';
// Desktop mirrors a remote session's transcripts into one flat directory,
// ~/.claude/projects/ssh-<cliSid>/, copying only <cliSid>.jsonl and
// agent-*.jsonl. The rewrite bumps every file's mtime, and the
// agent-*.meta.json sidecars that carry names and nesting stay on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const cacheFile = path.join(__dirname, '../src/plugins/subagents/jsonl-cache.js');
const mainFile = path.join(__dirname, '../src/plugins/subagents/main.js');
const SID = '11111111-2222-3333-4444-555555555555';
const DSID = 'local_66666666-7777-8888-9999-000000000000';
const T = Date.UTC(2026, 9, 5, 14, 0, 0);
const at = s => new Date(T + s * 1000).toISOString();
const line = value => JSON.stringify(value) + '\n';

function load(file, overrides = {}, globals = {}) {
    const mod = { exports: {} };
    const req = name => Object.hasOwn(overrides, name) ? overrides[name]
        : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: mod, exports: mod.exports,
        require: req, Buffer, process, clearInterval, Date, console, setTimeout, ...globals }, { filename: file });
    return mod.exports;
}

function mirror(t, remote) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-mirror-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, '.claude', 'projects', 'ssh-' + SID);
    fs.mkdirSync(dir, { recursive: true });
    const calls = [];
    const source = {
        directory: (cliSid, desktopSessionId) => (cliSid === SID && desktopSessionId === DSID ? dir : null),
        readSubagentMeta: async (cliSid, desktopSessionId, known) => {
            calls.push([...known]);
            return { metas: Object.fromEntries(Object.entries(remote).filter(([id]) => !known.has(id))),
                present: Object.keys(remote) };
        },
    };
    const methods = new Map();
    load(mainFile, { os: { homedir: () => root }, './jsonl-cache': load(cacheFile) },
        { [Symbol.for('cuimod.remote.transcript-source')]: source })({
        method: (name, fn) => methods.set(name, fn), onDispose() {}, boot: { MOD_DIR: root },
    });
    const list = () => methods.get('list')({ cliSid: SID, desktopSessionId: DSID });
    return { dir, list, calls, write: (name, rows) => fs.writeFileSync(path.join(dir, name), rows.map(line).join('')) };
}

const brief = (id, s) => ({ type: 'user', isSidechain: true, agentId: id, sessionId: SID, timestamp: at(s),
    message: { role: 'user', content: 'brief ' + id } });
// An agent's final report with no terminating line, which is how CLI
// transcripts commonly end; only the parent's notification says it is over.
const report = s => ({ type: 'assistant', timestamp: at(s),
    message: { model: 'm', stop_reason: null, content: [{ type: 'text', text: 'report' }] } });
const spawn = (id, toolId, name, s) => [
    { type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', name: 'Agent', id: toolId, input: { name } }] } },
    { type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: toolId,
        content: 'Async agent launched successfully. agentId: ' + id }] } },
];
const notify = (id, s) => ({ type: 'queue-operation', timestamp: at(s),
    content: '<task-notification><task-id>' + id + '</task-id><status>completed</status></task-notification>' });

test('a remote mirror lists agents only, trusts transcript time over mirror mtime, and nests through host sidecars', async t => {
    const m = mirror(t, { kid: { name: 'kid', agentType: 'worker', parentAgentId: 'top', spawnDepth: 2 } });
    m.write(SID + '.jsonl', [...spawn('top', 't1', 'lead', 0), ...spawn('again', 't2', 'resumed', 0),
        notify('top', 10), notify('again', 10), notify('kid', 20)]);
    m.write('agent-top.jsonl', [brief('top', 1), report(5)]);
    m.write('agent-again.jsonl', [brief('again', 1), report(5), report(60)]);
    m.write('agent-kid.jsonl', [brief('kid', 2), report(15)]);
    // The mirror rewrites every file long after the agents finished.
    const rewrite = new Date(T + 6 * 3600 * 1000);
    for (const n of fs.readdirSync(m.dir)) fs.utimesSync(path.join(m.dir, n), rewrite, rewrite);

    const first = m.list();
    assert.ok(first.ok);
    assert.deepEqual(Array.from(first.agents, a => a.agentId).sort(), ['again', 'kid', 'top']);
    const byId = new Map(first.agents.map(a => [a.agentId, a]));
    assert.equal(byId.get('top').state, 'done');
    assert.equal(byId.get('kid').state, 'done');
    // Written after its notification: a resume, which mtime alone cannot tell.
    assert.equal(byId.get('again').state, 'inflight');

    await new Promise(resolve => setTimeout(resolve, 0));
    const kid = m.list().agents.find(a => a.agentId === 'kid');
    assert.equal(kid.name, 'kid');
    assert.equal(kid.type, 'worker');
    assert.equal(kid.parentAgentId, 'top');
    assert.equal(kid.depth, 2);
    // Every listed agent is now resolved or known absent; polling stops asking.
    m.list(); m.list();
    assert.equal(m.calls.length, 1);
});
