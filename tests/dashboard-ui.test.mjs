import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../router/dashboard/app.js', import.meta.url), 'utf8');

// Small DOM contract for the production script. No router, account, browser
// dependency, or network is involved in these interaction regressions.
function harness()
{
    let document;
    class Node
    {
        constructor(tag, text = '')
        {
            this.nodeType = tag === '#text' ? 3 : 1;
            this.tagName = this.nodeType === 1 ? tag.toUpperCase() : undefined;
            this.nodeName = this.tagName || '#text';
            this.nodeValue = this.nodeType === 3 ? text : null;
            this.childNodes = [];
            this.attrs = new Map();
            this.handlers = new Map();
            const styles = new Map();
            const syncStyle = () => this.attrs.set('style', [...styles].map(([name, value]) => name + ': ' + value).join('; '));
            const declaration = {
                setProperty: (name, value) => { styles.set(name, String(value)); syncStyle(); },
                getPropertyValue: name => styles.get(name) || '',
                getPropertyPriority: () => '',
                removeProperty: name => { styles.delete(name); syncStyle(); },
                [Symbol.iterator]: () => styles.keys(),
            };
            this.style = new Proxy(declaration, {
                get: (target, name) => name in target ? target[name] : styles.get(name) || '',
                set: (_, name, value) => { styles.set(name, String(value)); syncStyle(); return true; },
            });
            this.dataset = new Proxy({}, {
                get: (_, name) => this.getAttribute('data-' + name) || undefined,
                set: (_, name, value) => { this.setAttribute('data-' + name, value); return true; },
            });
            this.classList = {
                add: name => this.classList.toggle(name, true),
                remove: name => this.classList.toggle(name, false),
                contains: name => this.className.split(' ').includes(name),
                toggle: (name, force) => {
                    const names = new Set(this.className.split(' ').filter(Boolean));
                    const enable = force ?? !names.has(name);
                    if (enable) names.add(name); else names.delete(name);
                    this.className = [...names].join(' ');
                    return enable;
                },
            };
        }
        get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
        get children() { return this.childNodes.filter(node => node.nodeType === 1); }
        get firstChild() { return this.childNodes[0]; }
        get lastChild() { return this.childNodes.at(-1); }
        get parentElement() { return this.parentNode; }
        get className() { return this.getAttribute('class') || ''; }
        set className(value) { this.setAttribute('class', value); }
        get id() { return this.getAttribute('id') || ''; }
        set id(value) { this.setAttribute('id', value); }
        get open() { return this.hasAttribute('open'); }
        set open(value) { if (value) this.setAttribute('open', ''); else this.removeAttribute('open'); }
        get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(node => node.textContent).join(''); }
        set textContent(value)
        {
            this.childNodes.forEach(node => { node.parentNode = null; });
            this.childNodes = [];
            if (String(value)) this.append(new Node('#text', String(value)));
        }
        setAttribute(name, value)
        {
            if (name === 'style') throw new Error('CSP blocks style attributes; use CSSOM');
            this.attrs.set(name, String(value));
        }
        getAttribute(name) { return this.attrs.get(name) ?? null; }
        hasAttribute(name) { return this.attrs.has(name); }
        removeAttribute(name) { this.attrs.delete(name); }
        append(...nodes) { nodes.forEach(node => this.insertBefore(typeof node === 'string' ? new Node('#text', node) : node, null)); }
        insertBefore(node, at)
        {
            node.remove();
            const index = at ? this.childNodes.indexOf(at) : this.childNodes.length;
            if (index < 0) throw new Error('Detached insertion anchor');
            this.childNodes.splice(index, 0, node);
            node.parentNode = this;
        }
        remove()
        {
            if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
            this.parentNode = null;
        }
        addEventListener(type, handler) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(handler); }
        removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
        dispatch(type, values = {}) { for (const fn of this.handlers.get(type) || []) fn({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...values }); }
        focus() { document.activeElement = this; }
        select() { this.focus(); }
        scrollIntoView() {}
        getBoundingClientRect() { return { left: 0, top: 0, bottom: 40, width: 200, height: 40 }; }
        get offsetWidth() { return 200; }
        get offsetHeight() { return 40; }
        getAnimations() { return []; }
        contains(other) { return other === this || this.childNodes.some(node => node.contains(other)); }
        querySelector(selector)
        {
            const matches = node => selector[0] === '.' ? node.classList.contains(selector.slice(1)) : node.tagName === selector.toUpperCase();
            for (const node of this.children) { if (matches(node)) return node; const child = node.querySelector(selector); if (child) return child; }
            return null;
        }
    }
    const elements = new Map();
    const get = selector => {
        if (!elements.has(selector))
        {
            const tag = selector.endsWith('tbody') ? 'tbody' : selector.includes('combo') || selector.includes('copy-') ? 'button' : 'div';
            const node = new Node(tag);
            node.id = selector.replace(/^#/, '');
            if (selector === '#status') node.append(new Node('i'), new Node('#text', 'Connecting'));
            elements.set(selector, node);
        }
        return elements.get(selector);
    };
    document = {
        querySelector: get, querySelectorAll: () => [], createElement: tag => new Node(tag),
        createElementNS: (_, tag) => new Node(tag), createTextNode: text => new Node('#text', text),
        addEventListener() {}, documentElement: new Node('html'), body: new Node('body'), hidden: true,
    };
    const requests = [], clipboard = [], timers = new Map();
    let timer = 0;
    const context = vm.createContext({
        document, window: { addEventListener() {} }, URLSearchParams, AbortController, Date,
        matchMedia: () => ({ matches: true }),
        localStorage: { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); } },
        navigator: { clipboard: { writeText: async text => { clipboard.push(text); } } },
        fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
        setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id), setInterval() {},
        innerWidth: 800, innerHeight: 600,
    });
    vm.runInContext(script, context);
    return {
        get, requests, clipboard, timers, document,
        run: code => vm.runInContext(code, context),
        data: data => { context.fixture = data; vm.runInContext('state.data = fixture; render();', context); },
    };
}

function snapshot()
{
    const meter = (provider, aggregate = true) => ({
        key: provider + ':quota', provider, accountId: provider, accountName: provider + ' account', label: 'Main window',
        aggregate, schedulable: true, usedPercent: 25, observedAt: '2026-09-05T10:00:00Z',
        history: [{ observedAt: '2026-09-05T09:00:00Z', usedPercent: 10 }, { observedAt: '2026-09-05T10:00:00Z', usedPercent: 25 }],
    });
    return {
        generatedAt: '2026-09-05T10:00:00Z', range: { key: 'all', start: '2026-09-01T00:00:00Z', end: '2026-09-05T10:00:00Z' },
        sources: { alpha: { source: 'fixture', observedAt: '2026-09-05T10:00:00Z' }, zeta: { error: 'Offline' } },
        meters: [meter('alpha'), meter('zeta', false)],
        usage: {
            exactRecords: 12, cost: { total: 7, cacheRead: 1, unpricedResponses: 0 },
            models: [
                { provider: 'alpha', model: 'alpha-model', responses: 3, contextInputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, cost: { total: 2 } },
                { provider: 'zeta', model: 'zeta-model', responses: 9, contextInputTokens: 1000, outputTokens: 500, cost: { total: 5 } },
            ],
            dailyTimeline: [{ date: '2026-09-05', contextInputTokens: 1100, outputTokens: 550, responses: 12 }],
            recent: [
                { provider: 'alpha', servedModel: 'alpha-model', observedAt: '2026-09-05T10:00:00Z', responseId: 'a', sessionId: 'full-session-id', tokens: { contextInputTokens: 100, outputTokens: 50 } },
                { provider: 'zeta', servedModel: 'zeta-model', observedAt: '2026-09-05T10:00:00Z', responseId: 'z' },
            ],
            pricing: { fingerprint: 'fixture', rates: { 'alpha/alpha-model': [{ input: 1, output: 2 }], 'zeta/zeta-model': [{ input: 2, output: 4 }] } },
        },
    };
}

test('website boots when browser storage is blocked', () => {
    const ui = harness();
    assert.equal(ui.requests.length, 1);
    assert.doesNotThrow(() => ui.run('toggleTheme()'));
    assert.equal(ui.document.documentElement.dataset.theme, 'light');
});

test('providers, sources and horizons follow payload metadata', () => {
    const ui = harness(), data = snapshot();
    data.meters[0].forecast = { projected: [{ minutes: 7, usedPercent: 30 }, { minutes: 42, usedPercent: 40 }], sampleCount: 1 };
    ui.data(data);
    assert.deepEqual(Array.from(ui.run('providersPresent()')), ['alpha', 'zeta']);
    assert.equal(ui.get('#sources').children.length, 2);
    assert.match(ui.get('#sources').textContent, /Offline/);
    assert.equal(ui.get('#forecast-grid').children.length, 2, 'account-only providers remain visible');
    assert.deepEqual(Array.from(ui.run('horizons.map(row => row.value)')), [7, 42]);
    assert.equal(ui.run('state.horizon'), 7);
});

test('provider selection scopes summary, rates, sources and audit exports', async () => {
    const ui = harness(); ui.data(snapshot());
    ui.run("state.provider = 'alpha'; render()");
    assert.match(ui.get('#kpis').textContent, /3 responses/);
    assert.doesNotMatch(ui.get('#kpis').textContent, /12 responses/);
    assert.equal(ui.get('#rate-table tbody').children.length, 1);
    assert.equal(ui.get('#sources').children.length, 1);
    assert.equal(ui.get('#events-table tbody').children.length, 1);
    ui.get('#copy-events-json').dispatch('click');
    await Promise.resolve();
    assert.deepEqual(JSON.parse(ui.clipboard.at(-1)).map(row => row.provider), ['alpha']);
    assert.match(ui.get('#events-table tbody').textContent, /full-session-id/);
    assert.equal(ui.get('#daily-table tbody').children.length, 1, 'combined daily data has an explicit global scope');
});

test('missing forecasts never claim reset wins or measured zero burn', () => {
    const ui = harness(); ui.data(snapshot());
    assert.doesNotMatch(ui.get('#forecast-grid').textContent, /Reset wins|No movement/);
    assert.match(ui.get('#forecast-grid').textContent, /Learning · reset unknown/);
    assert.equal(ui.run('etaText({ usedPercent: 100 })'), 'Quota exhausted');
    assert.equal(ui.run('duration(59.9)'), '1h 0m');
    assert.equal(ui.run('duration(1439.9)'), '1d 0h');
});

test('projection beyond a reset is disclosed instead of showing pre-reset burn', () => {
    const ui = harness(), data = snapshot();
    data.meters[0].forecast = { confidence: 'high', projected: [{ minutes: 60, usedPercent: 90 }], resetMinutes: 20, sampleCount: 8 };
    ui.data(data);
    assert.match(ui.get('#forecast-grid').textContent, /Reset occurs first/);
    assert.doesNotMatch(ui.get('#forecast-grid').textContent, /90%/);
});

test('tracked families are featured without hiding a provider that marks none', () => {
    const ui = harness(), data = snapshot();
    data.meters[0].track = false;
    ui.data(data);
    assert.equal(ui.run('selectedMeters().length'), 2);
    data.meters.push({ ...data.meters[0], key: 'alpha:tracked', label: 'Tracked', track: true });
    ui.data(data);
    assert.deepEqual(Array.from(ui.run('selectedMeters().map(row => row.key)')), ['zeta:quota', 'alpha:tracked']);
});

test('polls retain record identity, focus and open history while updating values', () => {
    const ui = harness(), data = snapshot(); ui.data(data);
    const card = ui.get('#forecast-grid').children[0];
    const details = card.querySelector('details');
    details.open = true;
    const summary = details.querySelector('summary'); summary.focus();
    data.meters[0].usedPercent = 42;
    ui.data(data);
    assert.equal(ui.get('#forecast-grid').children[0], card);
    assert.equal(details.open, true);
    assert.equal(ui.document.activeElement, summary);
    assert.match(card.textContent, /42%/);
    const model = ui.get('#model-bars').children[0];
    data.usage.models[0].contextInputTokens = 5000;
    ui.data(data);
    assert.equal(ui.get('#model-bars').children[1], model, 'sorting moves the existing model node');
});

test('polls patch bar dimensions through CSSOM under the page CSP', () => {
    const ui = harness(), data = snapshot(); ui.data(data);
    const fill = ui.get('#forecast-grid').children[0].querySelector('.track').firstChild;
    assert.equal(fill.style.width, '25%');
    data.meters[0].usedPercent = 42;
    ui.data(data);
    assert.equal(ui.get('#forecast-grid').children[0].querySelector('.track').firstChild, fill);
    assert.equal(fill.style.width, '42%');
});

test('reconciled row copy handlers use the latest record and fire once', async () => {
    const ui = harness(), data = snapshot(); ui.data(data);
    const row = ui.get('#meters-table tbody').children[0], button = row.querySelector('button');
    data.meters[0].usedPercent = 42;
    ui.data(data); ui.data(data);
    assert.equal(row.querySelector('button'), button);
    button.dispatch('click'); await Promise.resolve();
    assert.equal(ui.clipboard.length, 1);
    assert.match(ui.clipboard[0], /\t42\t/);
});

test('latest range request wins even if the cancelled fetch resolves last', async () => {
    const ui = harness();
    const first = ui.requests[0];
    const secondLoad = ui.run("state.range = 'today'; load()");
    assert.equal(first.options.signal.aborted, true);
    const current = snapshot(); current.range.key = 'today';
    ui.requests[1].resolve({ ok: true, json: async () => current });
    await secondLoad;
    first.resolve({ ok: true, json: async () => snapshot() });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.run('state.data.range.key'), 'today');
    assert.equal(ui.run('state.loading'), false);
    assert.match(ui.get('#range-note').textContent, /Totals cover today/);
});

test('failed refresh preserves data and restores its range label', async () => {
    const ui = harness(); ui.data(snapshot());
    const card = ui.get('#forecast-grid').children[0];
    const pending = ui.run("state.range = 'today'; load()");
    ui.requests.at(-1).reject(new Error('Fixture unavailable'));
    await pending;
    assert.equal(ui.get('#forecast-grid').children[0], card);
    assert.equal(ui.run('state.range'), 'all');
    assert.equal(ui.get('#load-error').hidden, false);
    assert.match(ui.get('#load-error').textContent, /last successful snapshot/);
    assert.equal(ui.get('#refresh').disabled, false);
});

test('unpriced responses are distinguished from zero-cost traffic', () => {
    const ui = harness(), data = snapshot();
    data.usage.models[0].cost = { total: 0, unpricedResponses: 3 };
    ui.data(data);
    assert.match(ui.get('#spend-table tbody').textContent, /Unpriced/);
    assert.match(ui.get('#model-bars').textContent, /Unpriced/);
    assert.equal(ui.run('displayCost({responses: 1, cost: {total: 0, unpricedResponses: 0}})'), '$0.00');
});

test('TSV retains sub-cent prices and sanitizes model delimiters', () => {
    const ui = harness();
    const line = ui.run("spendRowText({provider:'alpha',model:'model\\tline\\nnext',responses:1,cost:{input:0.0000123,total:0.0000123,unpricedResponses:0}})");
    const cells = line.split('\t');
    assert.equal(cells.length, 9);
    assert.equal(cells[1], 'model line next');
    assert.equal(Number(cells[3]), 0.0000123);
    assert.equal(Number(cells[7]), 0.0000123);
});

test('fractional published rates remain distinguishable from free tokens', () => {
    const ui = harness();
    assert.equal(ui.run('rate(0.00001)'), '$0.00001');
});

test('repeated refresh actions do not restart an in-flight request', async () => {
    const ui = harness();
    await ui.run('load(true)');
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].options.signal.aborted, false);
});

test('unknown quota values stay unknown and never produce invalid widths', () => {
    const ui = harness(), data = snapshot();
    data.meters[0].usedPercent = null;
    ui.data(data);
    assert.doesNotMatch(ui.get('#forecast-grid').textContent, /—%|NaN/);
    assert.equal(ui.run('meterWidth(null)'), 0);
    assert.equal(ui.run('meterWidth(150)'), 100);
    assert.equal(ui.run('meterWidth(-5)'), 0);
});

test('empty snapshots render explicit table and source states', () => {
    const ui = harness();
    ui.data({ meters: [], usage: { models: [] }, sources: {} });
    for (const selector of ['#spend-table tbody', '#meters-table tbody', '#events-table tbody', '#rate-table tbody'])
        assert.equal(ui.get(selector).children.length, 1, selector);
    assert.match(ui.get('#sources').textContent, /No data sources/);
    assert.equal(ui.get('#horizon-combo').disabled, true);
});

test('timeline retains every returned day and zero stays zero', () => {
    const ui = harness(), data = snapshot();
    data.usage.dailyTimeline = Array.from({ length: 125 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), contextInputTokens: index, outputTokens: 0, responses: 1 }));
    ui.data(data);
    assert.equal(ui.get('#daily-timeline').children.length, 125);
    assert.equal(ui.get('#daily-timeline').children[0].querySelector('button').style.height, '0%');
    assert.equal(ui.get('#daily-table tbody').children.length, 125);
});

test('account search and its exports share the same rows', async () => {
    const ui = harness(); ui.data(snapshot());
    const search = ui.get('#account-search');
    search.value = 'ZETA'; search.dispatch('input');
    assert.match(ui.get('#account-count').textContent, /1 of 2 windows/);
    assert.equal(ui.get('#meters-table tbody').children.length, 1);
    ui.run("copyMeters('json')"); await Promise.resolve();
    assert.deepEqual(JSON.parse(ui.clipboard.at(-1)).map(row => row.provider), ['zeta']);
    search.value = 'no-match'; search.dispatch('input');
    assert.match(ui.get('#account-count').textContent, /0 of 2 windows/);
});

test('range combobox supports arrows, selection and focus restoration', () => {
    const ui = harness(); ui.data(snapshot());
    const owner = ui.get('#range-combo');
    owner.dispatch('keydown', { key: 'ArrowDown' });
    const list = ui.get('#popups').children[0];
    assert.equal(owner.getAttribute('aria-expanded'), 'true');
    assert.equal(ui.document.activeElement, list);
    list.dispatch('keydown', { key: 'Home' });
    list.children[0].dispatch('click');
    assert.equal(owner.getAttribute('aria-expanded'), 'false');
    assert.equal(ui.document.activeElement, owner);
    assert.equal(ui.run('state.range'), 'today');
    assert.match(ui.requests.at(-1).url, /range=today/);
});

test('tab closes the popup without trapping keyboard focus', () => {
    const ui = harness(); ui.data(snapshot());
    const owner = ui.get('#range-combo'); owner.dispatch('click');
    const list = ui.get('#popups').children[0];
    list.dispatch('keydown', { key: 'Tab' });
    assert.equal(ui.get('#popups').children.length, 0);
    assert.equal(owner.getAttribute('aria-expanded'), 'false');
    assert.equal(ui.document.activeElement, owner);
});

test('malformed snapshots retain the last usable data', async () => {
    const ui = harness(); ui.data(snapshot());
    const pending = ui.run('load()');
    ui.requests.at(-1).resolve({ ok: true, json: async () => ({ meters: null }) });
    await pending;
    assert.equal(ui.run('state.data.usage.models.length'), 2);
    assert.match(ui.get('#load-error').textContent, /Invalid usage snapshot/);
});

test('newly built descendants use normal insertion into a connected root', () => {
    const ui = harness();
    assert.doesNotThrow(() => ui.run(`
        const root = el('div'); root.isConnected = true;
        root.moveBefore = () => { throw new Error('Atomic move requires a connected node'); };
        const draft = el('div'); draft.append(el('span', null, 'New data'));
        swapChildren(root, [...draft.childNodes]);
        if (root.textContent !== 'New data') throw new Error('Missing inserted child');
    `));
});

test('refresh timeout aborts the request and enables retry', async () => {
    const ui = harness(); ui.data(snapshot());
    const pending = ui.run('load()');
    const request = ui.requests.at(-1);
    [...ui.timers.values()].at(-1)();
    assert.equal(request.options.signal.aborted, true);
    request.reject(new Error('Aborted'));
    await pending;
    assert.match(ui.get('#load-error').textContent, /timed out/);
    assert.equal(ui.get('#refresh').disabled, false);
});
