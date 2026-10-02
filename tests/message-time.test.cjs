'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JsonlIndex, findSessionFile } = require('../src/plugins/message-time/jsonl-index');

const ROOT = path.join(__dirname, '..');
const A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SESSION = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
const date = '2026-09-28T11:17:55.768Z';

function record(type, uuid, timestamp, extra = {}) {
    return JSON.stringify({ type, uuid, timestamp, ...extra }) + '\n';
}

test('incremental JSONL index keeps a partial line, ignores other records, and reads appended bytes', async () => {
    const root = fs.mkdtempSync(path.join(ROOT, '.probe', 'message-time-test-'));
    try {
        const project = path.join(root, 'project-a');
        fs.mkdirSync(project);
        const file = path.join(project, SESSION + '.jsonl');
        const index = new JsonlIndex(file);
        const first = record('assistant', A, date);
        fs.writeFileSync(file, record('user', B, date) + first.slice(0, -1));
        await index.update();
        assert.equal(index.get(A), null);
        assert.equal(index.get(B), null);
        const firstOffset = index.offset;
        assert.equal(firstOffset, fs.statSync(file).size);

        const next = '2026-09-28T11:18:01.012Z';
        fs.appendFileSync(file, '\n' + record('task_notification', B, next)
            + record('assistant', B, next, { message: 'x'.repeat(160 * 1024) }));
        await index.update();
        assert.equal(index.get(A), date);
        assert.equal(index.get(B), next);
        assert.equal(index.get('dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb'), null);
        assert.equal(index.offset, fs.statSync(file).size);
        assert.ok(index.offset > firstOffset);

        fs.appendFileSync(file, record('tool_result', A, next)
            + record('assistant', 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb', 'not a time'));
        await index.update();
        assert.equal(index.get(A), date);
        assert.equal(index.get('dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb'), null);

        fs.writeFileSync(file, record('assistant', B, date));
        await index.update();
        assert.equal(index.get(A), null);
        assert.equal(index.get(B), date);
        assert.equal(await findSessionFile(root, SESSION), file);
        assert.equal(await findSessionFile(root, A), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('formatter matches fv from pinned shared-4-DKPmNySq.js at its native boundaries', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'plugins', 'message-time', 'renderer.js'), 'utf8');
    const formatter = source.slice(source.indexOf('const UNITS ='), source.indexOf('const regions ='));
    const context = vm.createContext({ Intl, Date, Map, Math, RegExp });
    vm.runInContext(formatter, context);
    const now = Date.parse('2026-01-15T12:00:00.000Z');
    const cases = [
        [-59, 'just now'], [-60, '1 minute ago'], [-89, '1 minute ago'],
        [-90, '1 minute ago'], [-91, '2 minutes ago'],
        [-3540, '59 minutes ago'], [-3599, '60 minutes ago'],
        [-3600, '1 hour ago'], [-86400, 'yesterday'],
        [-604800, 'last week'], [-31536000, 'last year'],
        [59, 'just now'], [60, 'in 1 minute'], [89, 'in 1 minute'],
        [90, 'in 2 minutes'], [91, 'in 2 minutes'],
    ];
    for (const [seconds, expected] of cases) {
        const actual = vm.runInContext(
            `formatRelativeTime(new Date(${now + seconds * 1000}), ${now}, 'en-US', undefined, 'long', 'auto')`, context);
        assert.equal(actual, expected, seconds + ' seconds');
    }
    assert.equal(vm.runInContext(
        `formatRelativeTime(new Date(${now - 59000}), ${now}, 'en-US', 'right now', 'long', 'auto')`, context),
    'right now');
});

test('page-world fiber walk retags a recycled assistant time and clears a stale user marker', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'plugins', 'message-time', 'page.js'), 'utf8');
    const attributes = new Map([['datetime', date], ['data-cuimod-msg', B]]);
    const row = {};
    const node = {
        __reactFiber$test: { memoizedProps: {}, return: { memoizedProps: {}, return: {
            memoizedProps: { entry: { author: 'assistant', lastAssistantUuid: A } }, return: null,
        } } },
        closest: () => row,
        hasAttribute: key => attributes.has(key),
        getAttribute: key => attributes.get(key) || null,
        setAttribute: (key, value) => attributes.set(key, value),
        removeAttribute: key => attributes.delete(key),
    };
    const context = { document: { querySelectorAll: () => [node] } };
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(source, context))), [{ uuid: A, nativeIso: date }]);
    assert.equal(attributes.get('data-cuimod-msg'), A);
    node.__reactFiber$test.return.return.memoizedProps.entry = { author: 'assistant', lastAssistantUuid: B };
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(source, context))), [{ uuid: B, nativeIso: date }]);
    assert.equal(attributes.get('data-cuimod-msg'), B);
    node.__reactFiber$test.return.return.memoizedProps.entry = { author: 'user' };
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(source, context))), []);
    assert.equal(attributes.has('data-cuimod-msg'), false);
});

test('renderer reapplies the JSONL date after a native bump and a later React text tick', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'plugins', 'message-time', 'renderer.js'), 'utf8');
    const page = fs.readFileSync(path.join(ROOT, 'src', 'plugins', 'message-time', 'page.js'), 'utf8');
    let now = Date.parse('2026-09-28T12:00:00.000Z');
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const nativeIso = new Date(now - 2 * 60000).toISOString();
    const originalIso = new Date(now - 5 * 60000).toISOString();
    const attrs = new Map([['datetime', nativeIso]]);
    const row = {};
    const element = {
        isConnected: true,
        textContent: '2 minutes ago',
        __reactFiber$test: { memoizedProps: {}, return: {
            memoizedProps: { entry: { author: 'assistant', lastAssistantUuid: A } }, return: null,
        } },
        closest: () => row,
        getAttribute: key => attrs.get(key) || null,
        hasAttribute: key => attrs.has(key),
        setAttribute: (key, value) => attrs.set(key, value),
        removeAttribute: key => attrs.delete(key),
    };
    const region = { isConnected: true, querySelectorAll: () => [element] };
    const document = {
        body: {}, documentElement: { lang: 'en-US' },
        querySelectorAll: selector => selector.startsWith('[data-epitaxy') ? [region] : [element],
    };
    const intervals = new Map();
    const observers = new Map();
    const reports = [];
    const location = { pathname: '/epitaxy/local_' + SESSION };
    const cuimod = {
        sessionId: SESSION,
        onSessionChange(fn) { fn(this.sessionId); return () => {}; },
        async rpc(method, params) {
            if (method === 'message-time.report') { reports.push(params); return true; }
            assert.equal(method, 'message-time.resolve');
            const rows = vm.runInNewContext(page, { document });
            return rows.map(({ uuid }) => ({ uuid, iso: uuid === A ? originalIso : date }));
        },
    };
    const ctx = {
        observe(target, _opts, fn) { observers.set(target, fn); return { disconnect() {} }; },
        every(ms, fn) { intervals.set(ms, fn); },
        onDispose() {},
    };
    vm.runInNewContext(source, { document, location, cuimod, ctx, Date: Clock,
        Intl, Map, WeakMap, Set, navigator: { language: 'en-US' } });
    const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
    now += 300;
    intervals.get(125)();
    await settle();
    assert.equal(attrs.get('datetime'), originalIso);
    assert.equal(element.textContent, '5 minutes ago');
    assert.equal(reports.at(-1).rows[0].nativeIso, nativeIso);
    assert.equal(reports.at(-1).rows[0].applied, true);

    attrs.set('datetime', new Date(now).toISOString());
    element.textContent = 'just now';
    observers.get(region)();
    now += 300;
    intervals.get(125)();
    await settle();
    assert.equal(attrs.get('datetime'), originalIso);
    assert.equal(reports.at(-1).rows[0].nativeIso, new Date(now - 300).toISOString());

    now += 61000;
    element.textContent = 'just now';
    observers.get(region)();
    now += 300;
    intervals.get(125)();
    await settle();
    assert.equal(attrs.get('datetime'), originalIso);
    assert.equal(element.textContent, '6 minutes ago');
    assert.ok(reports.at(-1).rows[0].reactTextTicks >= 1);
});
