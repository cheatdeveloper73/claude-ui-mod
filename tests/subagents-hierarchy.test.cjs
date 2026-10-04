'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SID = '11111111-2222-3333-4444-555555555555';
const MAIN = path.join(__dirname, '..', 'src', 'plugins', 'subagents', 'main.js');
const RENDERER = path.join(__dirname, '..', 'src', 'plugins', 'subagents', 'renderer.js');
const conversationReader = require('../src/plugins/subagents/messages.js');

function transcript(id, second) {
    return JSON.stringify({
        type: 'assistant',
        agentId: id,
        timestamp: second,
        cwd: 'C:\\fake',
        message: {
            role: 'assistant',
            model: 'claude-opus-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'done' }],
        },
    }) + '\n';
}

function sidecar(name, parentAgentId, spawnDepth) {
    return JSON.stringify({
        agentType: 'reader',
        description: 'fixture',
        name,
        toolUseId: 'tool-' + name,
        parentAgentId,
        spawnDepth,
        model: 'opus',
    });
}

test('subagent list preserves multiple roots and arbitrary parent chains from sidecars', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-tree-'));
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    t.after(() => {
        if (oldHome == null) delete process.env.HOME; else process.env.HOME = oldHome;
        if (oldProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
        delete require.cache[require.resolve(MAIN)];
        fs.rmSync(root, { recursive: true, force: true });
    });
    process.env.HOME = root;
    process.env.USERPROFILE = root;

    const project = path.join(root, '.claude', 'projects', 'C--fake');
    const subagents = path.join(project, SID, 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(project, SID + '.jsonl'), '');

    const rows = [
        ['root-a', 'root-a', null, 1, '2026-09-13T10:00:00.000Z'],
        ['child-a', 'child-a', 'root-a', 2, '2026-09-13T10:00:01.000Z'],
        ['grand-a', 'grand-a', 'child-a', 3, '2026-09-13T10:00:02.000Z'],
        ['root-b', 'root-b', null, 1, '2026-09-13T10:00:03.000Z'],
    ];
    for (const [id, name, parent, depth, at] of rows) {
        const base = path.join(subagents, 'agent-' + id);
        fs.writeFileSync(base + '.jsonl', transcript(id, at));
        fs.writeFileSync(base + '.meta.json', sidecar(name, parent, depth));
    }

    const methods = new Map();
    delete require.cache[require.resolve(MAIN)];
    require(MAIN)({
        boot: { MOD_DIR: path.join(root, 'mod') },
        method: (name, fn) => methods.set(name, fn),
        onDispose: () => {},
        electron: { shell: { showItemInFolder: () => {} } },
    });
    const result = methods.get('list')({ cliSid: SID });
    assert.equal(result.ok, true);
    assert.equal(result.agents.length, 4);
    const byId = new Map(result.agents.map((row) => [row.agentId, row]));
    assert.deepEqual(
        ['root-a', 'root-b'].map((id) => [byId.get(id).parentAgentId, byId.get(id).depth]),
        [[null, 1], [null, 1]]);
    assert.deepEqual(
        [byId.get('child-a').parentAgentId, byId.get('child-a').depth],
        ['root-a', 2]);
    assert.deepEqual(
        [byId.get('grand-a').parentAgentId, byId.get('grand-a').depth],
        ['child-a', 3]);
});

test('renderer hierarchy orders every tree and recovers orphans and cycles once', () => {
    const source = fs.readFileSync(RENDERER, 'utf8');
    const from = source.indexOf('// BEGIN hierarchy projection');
    const to = source.indexOf('// END hierarchy projection');
    assert.ok(from !== -1 && to > from, 'hierarchy helper markers moved');

    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(source.slice(from, to)
        + '\nglobalThis.project = hierarchyRows; globalThis.indentFor = hierarchyIndent;', sandbox);

    const input = [
        { agentId: 'cycle-child', parentAgentId: 'cycle-a' },
        { agentId: 'a-child', parentAgentId: 'a-root' },
        { agentId: 'b-root', parentAgentId: null },
        { agentId: 'a-root', parentAgentId: null },
        { agentId: 'a-grand', parentAgentId: 'a-child' },
        { agentId: 'orphan', parentAgentId: 'missing' },
        { agentId: 'b-child', parentAgentId: 'b-root' },
        { agentId: 'cycle-a', parentAgentId: 'cycle-b' },
        { agentId: 'cycle-b', parentAgentId: 'cycle-a' },
    ];
    const projected = sandbox.project(input);
    assert.deepEqual(
        Array.from(projected, (x) => [x.agent.agentId, x.depth]),
        [
            ['b-root', 0], ['b-child', 1],
            ['a-root', 0], ['a-child', 1], ['a-grand', 2],
            ['orphan', 0],
            ['cycle-a', 0], ['cycle-child', 1], ['cycle-b', 1],
        ]);
    assert.equal(new Set(projected.map((x) => x.agent.agentId)).size, input.length);

    const deep = Array.from({ length: 40 }, (_, i) => ({
        agentId: 'deep-' + i,
        parentAgentId: i ? 'deep-' + (i - 1) : null,
    })).reverse();
    const deepTree = sandbox.project(deep);
    const maxDepth = Math.max(...deepTree.map((x) => x.depth));
    assert.equal(maxDepth, 39);
    assert.ok(Math.abs(sandbox.indentFor(maxDepth) * maxDepth - 96) < 1e-9);

    assert.match(source, /include\.add\(parent\.agentId\)/,
        'finished ancestors must remain visible beside running descendants');
    assert.match(source, /patchRow\(n, byId\(id\), depth\.get\(id\), indent\)/,
        'projected depth and bounded indent must reach the row renderer');
    assert.match(source, /\.row\.child::before/,
        'child rows need a visible relationship guide');
});

function line(type, timestamp, content) {
    return JSON.stringify({ type, timestamp, message: { role: type, content } }) + '\n';
}
function send(id, to, message, timestamp, summary) {
    return line('assistant', timestamp, [{
        type: 'tool_use', name: 'SendMessage', id,
        input: { to, message, summary },
    }]);
}
function sent(id, timestamp, pin) {
    return line('user', timestamp, [{ type: 'tool_result', tool_use_id: id,
        content: [{ type: 'text', text: JSON.stringify({ success: true, pin: pin ? { id: pin } : undefined }) }],
    }]);
}
function received(body, timestamp, origin) {
    return JSON.stringify({ type: 'attachment', timestamp, uuid: 'receipt-' + timestamp,
        attachment: { type: 'queued_command', prompt: body, origin },
    }) + '\n';
}

test('conversation renders direct sends, delivery, and final report without tool noise', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-chat-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parentFile = path.join(dir, 'parent.jsonl');
    const childFile = path.join(dir, 'child.jsonl');
    const a = '2026-09-23T01:00:00.000Z';
    const b = '2026-09-23T01:00:01.000Z';
    const c = '2026-09-23T01:00:02.000Z';
    const d = '2026-09-23T01:00:03.000Z';
    fs.writeFileSync(parentFile,
        send('p1', 'reader', 'Check the branch', a, 'Branch check') + sent('p1', b, 'agent1')
        + received('<agent-message>Found it</agent-message>', d,
            { kind: 'peer', senderTaskId: 'agent1', body: 'Found it' })
        + JSON.stringify({ type: 'attachment', timestamp: d, uuid: 'final',
            attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>agent1</task-id>\n<status>completed</status>\n<result>Final finding</result>\n</task-notification>' },
        }) + '\n');
    fs.writeFileSync(childFile,
        received('Check the branch', b, { kind: 'coordinator' })
        + send('c1', 'main', 'Found it', c, 'Interim') + sent('c1', d));
    const reader = conversationReader();
    const opts = { parentFile, childFile, childId: 'agent1', parentId: null,
        childName: 'reader', parentName: null, brief: 'Read the branch', spawnedAt: a,
        aliases: new Map([['reader', 1]]) };
    const result = reader.thread(opts);
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages.map((m) => [m.kind, m.dir, m.status, m.text]), [
        ['brief', 'parent', 'sent', 'Read the branch'],
        ['message', 'parent', 'delivered', 'Check the branch'],
        ['message', 'child', 'delivered', 'Found it'],
        ['report', 'child', 'completed', 'Final finding'],
    ]);
    assert.equal(result.earlier, 0);
    const page = reader.thread({ ...opts, beforeId: 'final', limit: 2 });
    assert.deepEqual(page.messages.map((m) => m.id), ['p1', 'c1']);
    assert.equal(page.earlier, 1);
});

test('conversation keeps nested recipients scoped and consumes appended complete lines', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-chat-nested-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parentFile = path.join(dir, 'parent.jsonl');
    const childFile = path.join(dir, 'child.jsonl');
    const a = '2026-09-23T02:00:00.000Z';
    const b = '2026-09-23T02:00:01.000Z';
    fs.writeFileSync(parentFile,
        send('p1', 'worker', 'Ambiguous alias', a) + sent('p1', b)
        + send('p2', 'agent2', 'Direct instruction', a) + sent('p2', b)
        + send('p3', 'worker', 'Other child', a) + sent('p3', b, 'agent9'));
    fs.writeFileSync(childFile,
        send('c1', 'main', 'To root only', a) + sent('c1', b)
        + send('c2', 'agent1', 'To direct parent', a) + sent('c2', b, 'agent1'));
    const reader = conversationReader();
    const opts = { parentFile, childFile, childId: 'agent2', parentId: 'agent1',
        childName: 'worker', parentName: 'orchestrator', brief: 'Initial brief', spawnedAt: a,
        aliases: new Map([['worker', 2], ['orchestrator', 1]]) };
    assert.deepEqual(reader.thread(opts).messages.map((m) => m.text),
        ['Initial brief', 'Direct instruction', 'To direct parent']);
    const partial = send('p4', 'agent2', 'After append', b).trimEnd();
    fs.appendFileSync(parentFile, partial);
    assert.equal(reader.thread(opts).total, 3, 'ignore an incomplete live JSONL line');
    fs.appendFileSync(parentFile, '\n' + sent('p4', b, 'agent2'));
    const update = reader.thread(opts);
    assert.equal(update.total, 4);
    assert.equal(update.messages.at(-1).text, 'After append');
});

test('conversation does not promote failed or duplicate sends into delivered messages', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-chat-status-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const parentFile = path.join(dir, 'parent.jsonl');
    const childFile = path.join(dir, 'child.jsonl');
    const a = '2026-09-23T03:00:00.000Z';
    const b = '2026-09-23T03:00:01.000Z';
    fs.writeFileSync(parentFile,
        send('p1', 'agent1', 'Same text', a) + sent('p1', b, 'agent1')
        + send('p2', 'agent1', 'Same text', a) + sent('p2', b, 'agent1')
        + send('p3', 'agent1', 'Failed send', a)
        + line('user', b, [{ type: 'tool_result', tool_use_id: 'p3', is_error: true,
            content: [{ type: 'text', text: '{"success":false}' }] }]));
    fs.writeFileSync(childFile, received('Same text', b, { kind: 'coordinator' }));
    const r = conversationReader().thread({ parentFile, childFile, childId: 'agent1',
        parentId: null, childName: 'worker', brief: '', aliases: new Map() });
    assert.equal(r.total, 2);
    assert.deepEqual(r.messages.map((m) => m.status), ['delivered', 'sent']);
});

test('chat lays dense agent prose out by sentence and never as markup', () => {
    const source = fs.readFileSync(RENDERER, 'utf8');
    const from = source.indexOf('// BEGIN chat formatting');
    const to = source.indexOf('// END chat formatting');
    assert.ok(from >= 0 && to > from);

    const text = (value) => ({ type: 'text', value });
    const el = (tag, cls, value) => ({ tag, className: cls, title: '', children: value == null ? [] : [text(value)],
        append(...nodes) { this.children.push(...nodes); } });
    const flat = (n) => (n.type === 'text' ? n.value : n.children.map(flat).join(''));
    const sandbox = { el, document: { createTextNode: text } };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(from, to) + '\nglobalThis.format = chatInto;', sandbox);

    const root = el('div');
    sandbox.format(root, 'gui status: fedfcc8 lands the loader (native hinter, measured against three variants). '
        + 'Proof in C:\\Users\\you\\Documents\\demo\\shots\\cmp.png, e.g. the menu. I need one of: (1) approval; or (2) the local copy.'
        + '\n\n## Result\n\n```cpp\nconst float dt = 0.5f;\n```\n\n<img src=x onerror=alert(1)>', ['gui']);
    const [para, hd, pre, tail] = root.children;
    assert.deepEqual(root.children.map((n) => n.tag + '.' + n.className), ['div.para', 'div.para hd', 'pre.null', 'div.para']);
    const lines = para.children;
    assert.deepEqual(lines.map((n) => n.className), ['s lead', 's', 's']);
    assert.ok(flat(lines[0]).startsWith('fedfcc8 lands'), 'sender prefix is dropped');
    const sha = lines[0].children[0];
    assert.equal(sha.className, 'tok sha');
    assert.equal(lines[0].children.find((n) => n.className === 'aside').tag, 'span');
    const path = lines[1].children.find((n) => n.className === 'tok');
    assert.equal(flat(path), '…/shots/cmp.png');
    assert.equal(path.title, 'C:\\Users\\you\\Documents\\demo\\shots\\cmp.png');
    assert.ok(flat(lines[1]).endsWith('e.g. the menu.'), 'abbreviations do not end a sentence');
    assert.deepEqual(lines[2].children.filter((n) => n.className === 'enum').map(flat), ['1approval; or', '2the local copy.']);
    assert.equal(flat(hd), 'Result');
    assert.equal(flat(pre), 'const float dt = 0.5f;');
    assert.equal(flat(tail), '<img src=x onerror=alert(1)>');
});

test('sheet names the model and effort a definition pins', () => {
    const source = fs.readFileSync(RENDERER, 'utf8');
    const from = source.indexOf('// BEGIN definition pin');
    const to = source.indexOf('// END definition pin');
    assert.ok(from >= 0 && to > from);
    const sandbox = { defs: {
        worker: { model: 'claude-opus-5-5', effort: 'high' },
        'quick-worker': { model: 'claude-gpt-6-luna[1m]:high', effort: 'high' },
        'vendor-worker': { model: 'vendor-9.1[1m]', effort: null },
        'general-purpose': { model: null, effort: null },
    } };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(from, to) + '\nglobalThis.pin = defPin;', sandbox);
    assert.equal(sandbox.pin('worker'), 'opus-5-5 · high');
    assert.equal(sandbox.pin('quick-worker'), 'gpt-6-luna · high');
    assert.equal(sandbox.pin('vendor-worker'), 'vendor-9.1');
    assert.equal(sandbox.pin('general-purpose'), '');
    assert.equal(sandbox.pin('Explore'), '');
});
