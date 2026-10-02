import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/plugins/transcript-type/renderer.js', import.meta.url), 'utf8');

function load() {
    const style = { textContent: '', remove() {} };
    const document = {
        head: { appendChild() {} },
        documentElement: { appendChild() {} },
        createElement(tag) {
            assert.equal(tag, 'style');
            return style;
        },
    };
    const registry = { specs: new Map(), subs: new Set([() => {}]) };
    const ctx = { onDispose() {} };
    const sandbox = { document, ctx, globalThis: { __cuimodReg: registry } };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'transcript-type/renderer.js' });
    return { spec: registry.specs.get('transcript-type'), style };
}

test('selected transcript face feeds every live non-mono text token', () => {
    const { spec, style } = load();
    assert.ok(spec);

    spec.apply({ enabled: true, face: 'Georgia, serif', size: 15, leading: 1.4 });

    for (const token of [
        '--font-anthropic-sans',
        '--font-ui',
        '--font-claude-response',
        '--font-user-message',
        '--font-sans-serif',
        '--family-ui',
        '--cds-font-sans',
    ]) {
        assert.match(style.textContent, new RegExp(token + ': Georgia, serif;'));
    }
    assert.match(style.textContent, /\.epitaxy-markdown, \.text-body/);
    assert.match(style.textContent, /p, h1, h2, h3, h4, h5, h6/);
    assert.match(style.textContent, /strong, b, em, i, del, s, a/);
    assert.doesNotMatch(style.textContent, /code, pre/);
    assert.doesNotMatch(style.textContent, /--font-mono:/);
    assert.doesNotMatch(style.textContent, /--font-serif:/);
    assert.doesNotMatch(style.textContent, /--font-ui-serif:/);
});

test('disabling transcript type removes its live override', () => {
    const { spec, style } = load();
    spec.apply({ enabled: true, face: 'Georgia, serif', size: 15, leading: 1.4 });
    spec.apply({ enabled: false });
    assert.equal(style.textContent, '');
});
