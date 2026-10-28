'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const UUID = 'd47da223-26ff-4b04-b9b8-c140bf9b58b8';
const SID = 'local_' + UUID;

// Just enough of an element for the selectors model-lock uses.
function el({ attrs = {}, parent = null, children = [], classes = [] } = {}) {
    const node = { attrs, parentElement: parent, children, classes };
    node.getAttribute = key => (key in attrs ? String(attrs[key]) : null);
    node.hasAttribute = key => key in attrs;
    node.matches = sel => sel.split(',').some(one => matchOne(node, one.trim()));
    node.closest = sel => { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; };
    node.querySelector = sel => { for (const c of node.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; };
    for (const c of children) c.parentElement = node;
    return node;
}
function matchOne(node, sel) {
    if (sel.startsWith('.')) return node.classes.includes(sel.slice(1));
    const parts = [...sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
    if (!parts.length || parts.map(p => p[0]).join('') !== sel) return false;
    return parts.every(([, key, value]) => key in node.attrs && (value === undefined || String(node.attrs[key]) === value));
}

function harness(menus, byId = {}) {
    const rpcs = [];
    const intervals = [];
    const tracked = [];
    const context = {
        document: {
            querySelectorAll: sel => (sel === '[role="menu"]' ? menus : []),
            getElementById: id => byId[id] || null,
        },
        location: { pathname: '/epitaxy/' + SID, search: '' },
        globalThis: {},
        cuimod: { rpc(method, payload) { rpcs.push({ method, ...payload }); return Promise.resolve({}); } },
        ctx: {
            every(_ms, fn) { intervals.push(fn); },
            track(target, type, fn) { tracked.push({ type, fn }); },
            onDispose() {},
        },
        Map, Set, Date, Number, String,
    };
    context.globalThis = context;
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/model-lock/renderer.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'model-lock/renderer.js' });
    rpcs.length = 0; // drop the settings RPC from boot
    const armed = kind => rpcs.some(r => r.method === 'model-lock.arm' && r.sessionId === SID && r.kind === kind);
    return {
        rpcs, armed,
        poll() { for (const fn of intervals) fn(); },
        pointerdown(target) { for (const t of tracked) if (t.type === 'pointerdown') t.fn({ target }); },
    };
}

// The 2026-09-19 frontend's composer model popup: generic CDS Menu, radio rows
// carrying no data-model-id, opened by a trigger inside .epitaxy-prompt.
function composerMenu() {
    const trigger = el({ classes: [] });
    el({ classes: ['epitaxy-prompt'], children: [trigger] });
    const row = el({ attrs: { role: 'menuitemradio', 'aria-checked': 'false' } });
    const menu = el({ attrs: { role: 'menu', 'data-cds': 'Menu', 'aria-labelledby': 'trig' }, children: [el({ children: [row] })] });
    return { menu, row, byId: { trig: trigger } };
}

test('a pick in the composer model menu without data-model-id authorizes the model write', () => {
    const { menu, row, byId } = composerMenu();
    const h = harness([menu], byId);
    h.pointerdown(row);
    assert.ok(h.armed('model'), JSON.stringify(h.rpcs));
});

test('an open composer model menu keeps the model write armed for keyboard picks', () => {
    const { menu, byId } = composerMenu();
    const h = harness([menu], byId);
    h.poll();
    assert.ok(h.armed('model'), JSON.stringify(h.rpcs));
});

test('a pick in a nested model submenu without data-model-id authorizes the model write', () => {
    const row = el({ attrs: { role: 'menuitemradio' } });
    const menu = el({ attrs: { role: 'menu', 'data-nested': '' }, children: [row] });
    const h = harness([menu]);
    h.pointerdown(row);
    assert.ok(h.armed('model'), JSON.stringify(h.rpcs));
});

test('legacy rows with data-model-id still arm the model write', () => {
    const row = el({ attrs: { role: 'menuitemradio', 'data-model-id': 'claude-sonnet-5-5' } });
    const menu = el({ attrs: { role: 'menu' }, children: [row] });
    const h = harness([menu]);
    h.pointerdown(row);
    assert.ok(h.armed('model'));
});

test('a radio menu outside the model selector arms nothing', () => {
    const trigger = el();
    const row = el({ attrs: { role: 'menuitemradio' } });
    const menu = el({ attrs: { role: 'menu', 'aria-labelledby': 'other' }, children: [row] });
    const h = harness([menu], { other: trigger });
    h.poll();
    h.pointerdown(row);
    assert.equal(h.rpcs.length, 0, JSON.stringify(h.rpcs));
});

test('no menu open arms nothing, so focus-time reconciliation stays refused', () => {
    const h = harness([]);
    h.poll();
    assert.equal(h.rpcs.length, 0);
});
