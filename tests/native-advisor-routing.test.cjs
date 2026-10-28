'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const cp = require('node:child_process');

const live = path.join(__dirname, '../src/plugins/provider-routing/main.js');
const source = process.env.PROVIDER_ROUTING_SOURCE || live;
function factory() {
    const module = { exports: {} };
    vm.runInNewContext('(function(require,module,exports,__dirname){' + fs.readFileSync(source, 'utf8') + '\n})', {
        process, globalThis, console, setTimeout, clearTimeout,
    })(createRequire(live), module, module.exports, path.dirname(live));
    return module.exports;
}
function mount() {
    const dispose = [], timers = [];
    factory()({ electron: { app: {} }, every: (_ms, fn) => timers.push(fn), method() {}, log() {}, onDispose: fn => dispose.push(fn) });
    return { timers, dispose: () => dispose.forEach(fn => fn()) };
}

test('OpenAI launches can declare a configured native advisor without selecting one', () => {
    const original = cp.spawn;
    const calls = [];
    cp.spawn = (...args) => { calls.push(args); return {}; };
    const plugin = mount();
    try {
        cp.spawn('C:/app/claude-code/2.1.284/claude.exe', ['--model', 'claude-gpt-6.1-sol[1m]'], { env: { KEEP: 'unchanged' } });
        assert.equal(calls[0][2].env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL, '1');
        assert.equal(calls[0][2].env.KEEP, 'unchanged');
        const args = calls[0][1];
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        assert.equal(settings.advisorModel, undefined, 'the owner chooses the reviewer');
        cp.spawn('unrelated.exe', [], { env: { KEEP: 'other' } });
        assert.deepEqual(calls[1][2], { env: { KEEP: 'other' } });
    } finally { plugin.dispose(); cp.spawn = original; }
});

test('advisor activation preserves explicit overrides and allows later provider switches', () => {
    const original = cp.spawn;
    const calls = [];
    cp.spawn = (...args) => { calls.push(args); return {}; };
    const plugin = mount();
    try {
        const exe = 'C:/app/claude-code/2.1.284/claude.exe';
        cp.spawn(exe, ['--model', 'claude-gpt-6-luna[1m]'], { env: { CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: '' } });
        assert.equal(calls[0][2].env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL, '');
        cp.spawn(exe, ['--model', 'claude-opus-5-5'], { env: {} });
        assert.equal(calls[1][2].env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL, '1', 'a Claude launch can switch to GPT without respawning');
        cp.spawn(exe, ['--model', 'claude-gpt-6-luna[1m]'], { env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } });
        assert.equal(calls[2][2].env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1');
        assert.equal(calls[2][2].env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL, undefined);
        cp.spawn(exe, ['--model', 'claude-gpt-6-luna[1m]', '--settings', JSON.stringify({ env: {
            CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: '', KEEP: 'inline',
        } })], { env: {} });
        const inline = calls[3][1];
        assert.equal(JSON.parse(inline[inline.indexOf('--settings') + 1]).env.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL, '');
    } finally { plugin.dispose(); cp.spawn = original; }
});
