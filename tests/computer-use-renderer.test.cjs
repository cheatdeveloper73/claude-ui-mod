'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the renderer the way the bridge does, with no dashboard registered, so
// it applies its own defaults. Record every preference it would push.
function load(stored) {
    const calls = [];
    const cuimod = {
        eipc: (...parts) => parts.join(':'),
        appInvoke: (...args) => { calls.push(['appInvoke', ...args]); return Promise.resolve(); },
        rpc: (...args) => { calls.push(['rpc', ...args]); return Promise.resolve(); },
    };
    const sandbox = { cuimod, ctx: { onDispose() {} }, globalThis: null };
    sandbox.globalThis = sandbox;
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/computer-use/renderer.js'), 'utf8');
    vm.runInNewContext(source, sandbox);
    const spec = sandbox.__cuimodReg.specs.get('computer-use');
    if (stored) { calls.length = 0; spec.apply(stored); }
    return calls;
}

test('a fresh install leaves Desktop\'s Computer Use preference untouched', () => {
    assert.deepEqual(load(), []);
});

test('an explicit dashboard choice is still pushed to Desktop', () => {
    const calls = load({ enabled: true });
    assert.ok(calls.some(call => call[0] === 'appInvoke' && call[2] === 'chicagoEnabled' && call[3] === true));
    assert.ok(calls.some(call => call[0] === 'rpc' && call[1] === 'computer-use.sync' && call[2].enabled === true));
    const off = load({ enabled: false });
    assert.ok(off.some(call => call[0] === 'appInvoke' && call[2] === 'chicagoEnabled' && call[3] === false));
});
