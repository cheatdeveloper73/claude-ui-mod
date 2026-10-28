'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TARGET = { sessionId: SID, cliSessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    uuid: '22222222-2222-4222-8222-222222222222', preview: 'Keep this exact reply.' };

class Element {
    constructor(tag = 'div') {
        this.tag = tag;
        this.children = [];
        this.attrs = {};
        this.hidden = false;
        this.disabled = false;
        this.className = '';
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    hasAttribute(key) { return key in this.attrs; }
    removeAttribute(key) { delete this.attrs[key]; }
    get parentElement() { return this.parent; }
    matches(selector) {
        if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
        if (!selector.startsWith('[')) return this.tag === selector;
        return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]
            .every(([, key, value]) => key in this.attrs && (value === undefined || this.attrs[key] === value));
    }
    querySelectorAll(selector) {
        return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
    get isConnected() { return this.connected === true || !!this.parent?.isConnected; }
    focus() { this.focused = true; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    attachShadow() {
        const root = new Element('shadow');
        const backdrop = new Element();
        backdrop.className = 'backdrop';
        backdrop.hidden = true;
        const heading = new Element('h2');
        const preview = new Element();
        preview.className = 'preview';
        const error = new Element();
        error.className = 'error';
        const cancel = new Element('button');
        cancel.className = 'cancel';
        const confirm = new Element('button');
        confirm.className = 'confirm';
        backdrop.append(heading, preview, error, cancel, confirm);
        root.append(backdrop);
        this.shadowRoot = root;
        return root;
    }
}

function harness() {
    const document = new Element('document');
    document.connected = true;
    document.documentElement = new Element('html');
    document.append(document.documentElement);
    document.createElement = tag => new Element(tag);
    const rows = ['human', 'assistant_text', 'assistant_tool', 'assistant_text'].map((kind, index) => {
        const row = new Element();
        row.setAttribute('data-testid', 'transcript-row');
        row.setAttribute('data-perf-row', kind);
        row.setAttribute('data-index', index);
        const anchor = new Element();
        anchor.setAttribute('data-epitaxy-entry', 'msg_' + index);
        anchor.setAttribute('data-epitaxy-item-index', 0);
        row.append(anchor);
        document.documentElement.append(row);
        return row;
    });
    const listeners = [];
    const intervals = [];
    const disposers = [];
    const calls = [];
    let prepare = async () => ({ ...TARGET });
    let rewind = async () => ({ ok: true });
    const cuimod = { desktopSessionId: SID, rpc: async (method, params) => {
        calls.push({ method, params });
        return method.endsWith('.prepare') ? prepare(params) : rewind(params);
    } };
    const ctx = {
        every(ms, fn) { intervals.push(fn); },
        onDispose(fn) { disposers.push(fn); },
        track(target, type, fn) { listeners.push({ target, type, fn }); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/plugins/assistant-rewind/renderer.js'), 'utf8'),
        { document, cuimod, ctx }, { filename: 'assistant-rewind/renderer.js' });
    const host = document.documentElement.children.find(node => node.id === 'cuimod-assistant-rewind');
    const root = host.shadowRoot;
    async function click(target, owner = document) {
        for (const listener of listeners) if (listener.target === owner && listener.type === 'click') {
            await listener.fn({ target, preventDefault() {}, stopPropagation() {} });
        }
        await new Promise(setImmediate);
    }
    return { document, rows, calls, cuimod, root, click,
        button: () => rows[1].querySelector('.cuimod-assistant-rewind'),
        poll: () => intervals.forEach(fn => fn()),
        dispose: () => disposers.forEach(fn => fn()),
        setPrepare: fn => { prepare = fn; }, setRewind: fn => { rewind = fn; },
    };
}

test('text rows get one control each; recycling and disposal remove stale controls', () => {
    const h = harness();
    assert.equal(h.document.querySelectorAll('.cuimod-assistant-rewind').length, 2);
    h.poll();
    assert.equal(h.document.querySelectorAll('.cuimod-assistant-rewind').length, 2);
    h.rows[1].setAttribute('data-perf-row', 'human');
    h.poll();
    assert.equal(h.rows[1].querySelector('.cuimod-assistant-rewind'), null);
    h.dispose();
    assert.equal(h.document.querySelectorAll('.cuimod-assistant-rewind').length, 0);
});

test('each status update inside a grouped assistant row has its own rewind target', async () => {
    const h = harness();
    h.rows[1].setAttribute('data-perf-row', 'assistant');
    const anchor = h.rows[1].querySelector('[data-epitaxy-entry]');
    for (const id of ['msg_status_one-t0', 'msg_status_two-t0']) {
        const prose = new Element();
        prose.setAttribute('data-cuimod-rewind-text', id);
        anchor.append(prose);
    }
    h.setPrepare(async params => ({ ...TARGET, uuid: params.textItemId === 'msg_status_one-t0'
        ? TARGET.uuid : '33333333-3333-4333-8333-333333333333' }));
    h.poll();
    await new Promise(setImmediate);
    const controls = h.rows[1].querySelectorAll('.cuimod-assistant-rewind');
    assert.equal(controls.length, 2);
    await h.click(controls[0]);
    await h.click(h.root.querySelector('.confirm'), h.root);
    await h.click(controls[1]);
    await h.click(h.root.querySelector('.confirm'), h.root);
    const rewinds = h.calls.filter(call => call.method.endsWith('.rewind'));
    assert.deepEqual(rewinds.map(call => call.params.uuid), [TARGET.uuid, '33333333-3333-4333-8333-333333333333']);
    assert.deepEqual(h.calls.filter(call => call.method.endsWith('.prepare')).map(call => call.params.textItemId),
        ['msg_status_one-t0', 'msg_status_two-t0']);
    h.rows[1].setAttribute('data-perf-row', 'human');
    h.poll();
    assert.equal(h.rows[1].querySelectorAll('.cuimod-assistant-rewind').length, 0);
});

test('a thinking row gets a rewind control bound to its -th item ID', async () => {
    const h = harness();
    h.rows[1].setAttribute('data-perf-row', 'assistant_thinking');
    const anchor = new Element();
    anchor.setAttribute('data-cuimod-rewind-text', 'msg_thinking-th0');
    h.rows[1].append(anchor);
    h.poll();
    const control = anchor.querySelector('.cuimod-assistant-rewind');
    assert.ok(control);
    await h.click(control);
    assert.equal(h.calls.find(call => call.method.endsWith('.prepare')).params.textItemId, 'msg_thinking-th0');
});

test('cancel makes no rewind call; confirmation uses the exact prepared checkpoint once', async () => {
    const h = harness();
    await h.click(h.button());
    assert.equal(h.root.querySelector('.backdrop').hidden, false);
    await h.click(h.root.querySelector('.cancel'), h.root);
    assert.equal(h.calls.filter(call => call.method.endsWith('.rewind')).length, 0);
    await h.click(h.button());
    await h.click(h.root.querySelector('.confirm'), h.root);
    const rewinds = h.calls.filter(call => call.method.endsWith('.rewind'));
    assert.equal(rewinds.length, 1);
    assert.equal(rewinds[0].params.uuid, TARGET.uuid);
    assert.equal(rewinds[0].params.sessionId, SID);
    assert.equal(h.root.querySelector('.backdrop').hidden, true);
    assert.equal(h.calls[0].params.entryKey, 'msg_1');
});

test('changing sessions closes confirmation and an old prepare response cannot rearm it', async () => {
    const h = harness();
    await h.click(h.button());
    h.cuimod.desktopSessionId = 'local_other';
    h.poll();
    assert.equal(h.root.querySelector('.backdrop').hidden, true);
    await h.click(h.root.querySelector('.confirm'), h.root);
    assert.equal(h.calls.filter(call => call.method.endsWith('.rewind')).length, 0);
    h.cuimod.desktopSessionId = SID;
    let resolve;
    h.setPrepare(() => new Promise(done => { resolve = done; }));
    await h.click(h.button());
    await h.click(h.root.querySelector('.cancel'), h.root);
    resolve({ ...TARGET });
    await new Promise(setImmediate);
    assert.equal(h.root.querySelector('.backdrop').hidden, true);
    assert.equal(h.root.querySelector('.confirm').disabled, true);
});

test('a session switch during preparation closes the loading dialog', async () => {
    const h = harness();
    let resolve;
    h.setPrepare(() => new Promise(done => { resolve = done; }));
    await h.click(h.button());
    h.cuimod.desktopSessionId = 'local_other';
    h.poll();
    assert.equal(h.root.querySelector('.backdrop').hidden, true);
    resolve({ ...TARGET });
    await new Promise(setImmediate);
    assert.equal(h.root.querySelector('.confirm').disabled, true);
    assert.equal(h.calls.filter(call => call.method.endsWith('.rewind')).length, 0);
});

test('a view-update failure reports history already applied and prevents a second rewind', async () => {
    const h = harness();
    h.setRewind(async () => ({ ok: false, applied: true, error: 'History was rewound; view failed.' }));
    await h.click(h.button());
    await h.click(h.root.querySelector('.confirm'), h.root);
    assert.equal(h.root.querySelector('h2').textContent, 'History rewound');
    assert.equal(h.root.querySelector('.error').hidden, false);
    await h.click(h.root.querySelector('.confirm'), h.root);
    assert.equal(h.calls.filter(call => call.method.endsWith('.rewind')).length, 1);
});
