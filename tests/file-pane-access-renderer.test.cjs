'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLI_ID = '355ef34f-d305-4cab-9478-ea6a53e8a573';
const IMAGE = 'data:image/png;base64,AAAA';

function harness({ filePath, label, existingImage = false, pending = false } = {}) {
    const calls = [];
    const intervals = [];
    const tracked = [];
    const disposers = [];
    const children = [];
    let resolveImage;
    const dataImage = pending ? new Promise(resolve => { resolveImage = resolve; }) : Promise.resolve(IMAGE);
    const makeNode = tag => ({
        tagName: tag.toUpperCase(),
        style: { cssText: '' },
        attributes: {},
        children: [],
        isConnected: false,
        setAttribute(key, value) { this.attributes[key] = String(value); },
        getAttribute(key) { return this.attributes[key] ?? null; },
        appendChild(node) {
            node.parentElement = this;
            node.isConnected = this.isConnected;
            this.children.push(node);
            return node;
        },
        remove() {
            this.isConnected = false;
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        },
    });
    const container = makeNode('div');
    container.isConnected = true;
    container.previousElementSibling = { innerText: 'Sent' };
    const filename = filePath.split(/[\\/]/).pop();
    const card = {
        tagName: 'BUTTON',
        title: filePath,
        parentElement: container,
        isConnected: true,
        getAttribute(name) { return name === 'title' ? this.title : null; },
        querySelector(selector) { return selector === 'bdi' ? { textContent: label || filename } : null; },
    };
    container.children.push(card);
    const row = {
        isConnected: true,
        innerText: 'Sent\n' + filename,
        querySelectorAll(selector) {
            if (selector === 'button[title]') return container.children.filter(child => child === card && child.isConnected);
            if (selector === 'img') return existingImage ? [{ isConnected: true }] : container.children.flatMap(child => child.children || []).filter(child => child.tagName === 'IMG' && child.isConnected);
            return [];
        },
        querySelector(selector) { return selector === 'span[data-cds="ShimmerText"]' ? { textContent: 'Sent' } : null; },
    };
    const region = {
        isConnected: true,
        querySelectorAll(selector) { return selector === '[data-testid="transcript-row"]' ? [row] : []; },
    };
    const document = {
        documentElement: {},
        body: {},
        querySelectorAll(selector) { return selector === '[data-epitaxy-transcript-region]' ? [region] : []; },
        createElement(tag) {
            const node = makeNode(tag);
            if (tag === 'img') Object.defineProperty(node, 'src', {
                get() { return node.attributes.src || ''; },
                set(value) {
                    node.attributes.src = String(value);
                    if (String(value).startsWith('data:image/')) {
                        node.naturalWidth = 1000;
                        node.naturalHeight = 260;
                    }
                },
            });
            return node;
        },
    };
    const context = {
        document,
        location: { pathname: '/epitaxy/' + SID },
        window: {},
        cuimod: {
            sessionId: CLI_ID,
            eipc: (...parts) => parts.join('_$_'),
            appInvoke(...args) { calls.push(args); return dataImage; },
        },
        ctx: {
            observe() { return { disconnect() {} }; },
            every(_ms, fn) { intervals.push(fn); },
            track(target, type, fn) { tracked.push({ target, type, fn }); },
            onDispose(fn) { disposers.push(fn); },
        },
        URL,
        Set,
        WeakMap,
        Promise,
        String,
        RegExp,
    };
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/file-pane-access/renderer.js'), 'utf8');
    vm.runInNewContext(source, context, { filename: 'file-pane-access/renderer.js' });
    return {
        calls,
        location: context.location,
        intervals,
        tracked,
        children,
        card,
        row,
        container,
        imageHost() { return container.children.find(node => node?.attributes?.['data-cuimod-inline-image'] !== undefined) || null; },
        resolveImage,
        dispose() { for (let i = disposers.length - 1; i >= 0; i--) disposers[i](); },
    };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('SendUserFile image cards request the current desktop session image and mount it inline', async () => {
    const filePath = 'C:\\Users\\Administrator.WINGUEST\\AppData\\Local\\Temp\\claude\\C--work\\' + CLI_ID + '\\scratchpad\\inline-remote-check.png';
    const h = harness({ filePath });
    await flush();

    assert.equal(h.calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), [
        'claude.web_$_LocalSessions_$_readSessionImageAsDataUrl',
        SID,
        filePath,
        true,
        { automatic: true },
    ]);
    const host = h.imageHost();
    assert.ok(host);
    assert.equal(host.children[0].src, IMAGE);
    assert.equal(host.children[0].style.cssText.includes('height:auto'), true);
    h.dispose();
    assert.equal(h.imageHost(), null);
});

test('non-image cards and rows with an existing inline image are left alone', async () => {
    const nonImage = harness({ filePath: 'C:\\repo\\readme.md' });
    await flush();
    assert.equal(nonImage.calls.length, 0);
    assert.equal(nonImage.imageHost(), null);

    const alreadyInline = harness({ filePath: 'C:\\repo\\already.png', existingImage: true });
    await flush();
    assert.equal(alreadyInline.calls.length, 0);
    assert.equal(alreadyInline.imageHost(), null);
});

test('a late image response is discarded after route change', async () => {
    const h = harness({ filePath: 'C:\\repo\\late.png', pending: true });
    await flush();
    assert.equal(h.calls.length, 1);
    h.location.pathname = '/settings';
    for (const item of h.tracked.filter(item => item.type === 'popstate')) item.fn();
    h.resolveImage(IMAGE);
    await flush();
    assert.equal(h.imageHost(), null);
    h.dispose();
});
