import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { fileURLToPath } from 'node:url';

const rendererSource = fs.readFileSync(fileURLToPath(new URL('../src/plugins/thinking-style/renderer.js', import.meta.url)), 'utf8');

function textFromHtml(html) {
    return String(html)
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function element(tag, text = '') {
    return {
        tagName: tag.toUpperCase(),
        style: {},
        attributes: {},
        isConnected: true,
        _text: text,
        _html: '',
        get textContent() { return this._text; },
        set textContent(value) { this._text = String(value == null ? '' : value); this._html = ''; },
        get innerHTML() { return this._html; },
        set innerHTML(value) { this._html = String(value == null ? '' : value); this._text = textFromHtml(this._html); },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        getAttribute(key) { return this.attributes[key] || null; },
        removeAttribute(key) { delete this.attributes[key]; },
        hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
        remove() { this.isConnected = false; },
    };
}

function load(nodes = []) {
    const disposers = [];
    let observed = null;
    const document = {
        head: { appendChild() {} },
        documentElement: { appendChild() {} },
        createElement: (tag) => element(tag),
        querySelectorAll(selector) {
            if (selector.includes('data-cuimod-think-md')) return nodes.filter((node) => node.hasAttribute('data-cuimod-think-md'));
            return nodes;
        },
    };
    const ctx = {
        observe(_, __, callback) { observed = callback; return { disconnect() {} }; },
        onDispose(callback) { disposers.push(callback); },
    };
    const cuimod = { onSessionChange() {} };
    const globalThis = { __cuimodReg: { specs: new Map(), subs: new Set() } };
    const sandbox = { document, ctx, cuimod, globalThis, console };
    vm.createContext(sandbox);
    const factory = vm.runInContext('(function(cuimod, ctx) {\n' + rendererSource + '\nglobalThis.format = formatInlineMarkdown;\n})', sandbox);
    factory(cuimod, ctx);
    return {
        format: globalThis.format,
        spec: globalThis.__cuimodReg.specs.get('thinking-style'),
        mutate: () => observed(),
        dispose: () => disposers.slice().reverse().forEach((callback) => callback()),
    };
}

test('thinking style enables inline Markdown by default', () => {
    const { spec } = load();
    assert.equal(spec.defaults.renderMarkdown, true);
    assert.equal(spec.controls.find((control) => control.key === 'renderMarkdown').group, 'Format');
    assert.match(spec.description, /inline Markdown/);
});

test('formatter renders supported inline Markdown and preserves block whitespace', () => {
    const { format } = load();
    const html = format('Check `state_t` for **alignment** with *current* ~~old~~ [docs](https://example.com).\n\n```cpp\nuint16_t x;\n```');
    assert.match(html, /<code class="cuimod-think-code">state_t<\/code>/);
    assert.match(html, /<strong>alignment<\/strong>/);
    assert.match(html, /<em>current<\/em>/);
    assert.match(html, /<del>old<\/del>/);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /cuimod-think-code block/);
    assert.equal(html.includes('<p>'), false);
    assert.equal(html.includes('<h1>'), false);
    assert.equal(html.includes('<hr'), false);
});

test('formatter leaves snake_case intact and escapes model text before HTML insertion', () => {
    const { format } = load();
    const html = format('user_id_lookup and **<img src=x onerror=alert(1)>**');
    assert.match(html, /user_id_lookup/);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('live thinking node reformats after React replaces its streamed text', () => {
    const node = element('div', 'Check `auth.ts` with **jwt**');
    const plugin = load([node]);
    assert.equal(node.getAttribute('data-cuimod-think-md'), '1');
    assert.match(node.innerHTML, /cuimod-think-code/);

    // The mutation caused by formatting itself must remain formatted.
    plugin.mutate();
    assert.equal(node.getAttribute('data-cuimod-think-md'), '1');

    node.textContent = 'Check `auth.ts` with **jwt** and *session*';
    plugin.mutate();
    assert.match(node.innerHTML, /<em>session<\/em>/);

    plugin.spec.apply({ ...plugin.spec.defaults, renderMarkdown: false });
    assert.equal(node.hasAttribute('data-cuimod-think-md'), false);
    assert.equal(node.textContent, 'Check `auth.ts` with **jwt** and *session*');

    plugin.dispose();
    assert.equal(node.hasAttribute('data-cuimod-think-md'), false);
});

test('plain Claude thinking remains a React-owned raw text node', () => {
    const node = element('div', 'I will inspect the actual request path first.');
    load([node]);
    assert.equal(node.hasAttribute('data-cuimod-think-md'), false);
    assert.equal(node.innerHTML, '');
});
