import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { subagentDefault } = require('../src/plugins/provider-routing/main.js');
const catalogue = JSON.parse(readFileSync(fileURLToPath(new URL('../src/plugins/provider-picker/catalogue.json', import.meta.url))));

for (const family of ['sol', 'luna']) {
    const restored = `gpt-5.6-${family}`;
    const retired = `gpt-6-${family}`;
    test(`${family} selects 5.6 and retires 6`, () => {
        assert.ok(catalogue.some(model => model.id === restored));
        assert.ok(!catalogue.some(model => model.id === retired));
    });
}

test('GPT-6.1 Sol is offered beside the 5.6 choices', () => {
    assert.ok(catalogue.some(model => model.id === 'gpt-6.1-sol'));
});

test('unpinned OpenAI agents use 5.6 Luna', () => {
    assert.equal(subagentDefault('gpt-5.6-sol', false), 'claude-gpt-5.6-luna[1m]:high');
});
