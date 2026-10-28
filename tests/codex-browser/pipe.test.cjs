'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { frame, Decoder, connection } = require(path.join(PLUGIN_DIR, 'pipe.js'));

class Socket extends EventEmitter {
    constructor() { super(); this.messages = []; this.destroyed = false; }
    write(bytes) { this.messages.push(...new Decoder().push(bytes)); return true; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('actual Codex framing is little-endian length plus JSON, across chunks', () => {
    const value = { jsonrpc: '2.0', id: 1, method: 'getInfo', params: {} };
    const bytes = frame(value);
    assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
    const decoder = new Decoder();
    assert.deepEqual(decoder.push(bytes.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(bytes.subarray(2, 8)), []);
    assert.deepEqual(decoder.push(Buffer.concat([bytes.subarray(8), bytes])), [value, value]);
});

test('reject oversized and malformed frames before dispatch', () => {
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(1025);
    assert.throws(() => new Decoder(1024).push(bytes), /frame/);
    assert.throws(() => new Decoder().push(Buffer.from([1, 0, 0, 0, 123])), /JSON/);
});

test('route framed RPCs and preserve error status', async () => {
    const socket = new Socket(), calls = [];
    const peer = connection(socket, async (method, params) => {
        calls.push([method, params]);
        if (method === 'missing') throw Error('unsupported backend method');
        return { type: 'iab' };
    });
    socket.emit('data', Buffer.concat([
        frame({ jsonrpc: '2.0', id: 2, method: 'getInfo', params: {} }),
        frame({ jsonrpc: '2.0', id: 3, method: 'missing', params: {} }),
    ]));
    await tick();
    assert.deepEqual(calls, [['getInfo', {}], ['missing', {}]]);
    assert.equal(socket.messages[0].result.type, 'iab');
    assert.equal(socket.messages[1].id, 3);
    assert.match(socket.messages[1].error.message, /unsupported/);
    peer.close();
    assert.equal(socket.listenerCount('data'), 0);
});

test('disconnect aborts active work and prevents a late reply', async () => {
    const socket = new Socket(); let signal, release;
    const peer = connection(socket, async (_method, _params, context) => {
        signal = context.signal;
        return new Promise(resolve => { release = resolve; });
    });
    socket.emit('data', frame({ jsonrpc: '2.0', id: 1, method: 'executeCdp', params: {} }));
    await tick(); socket.destroy();
    assert.equal(signal.aborted, true);
    release({}); await tick();
    assert.deepEqual(socket.messages, []);
    peer.close();
});

test('malformed envelopes and excess concurrency never reach backend', async () => {
    const socket = new Socket(); let calls = 0;
    const peer = connection(socket, async () => { calls++; return new Promise(() => {}); }, { maxPending: 1 });
    socket.emit('data', frame({ jsonrpc: '2.0', id: 1, method: 'getTabs', params: {} }));
    socket.emit('data', frame({ jsonrpc: '2.0', id: 2, method: 'getTabs', params: {} }));
    socket.emit('data', frame({ jsonrpc: '2.0', id: 3, method: 'getTabs', params: [] }));
    await tick();
    assert.equal(calls, 1);
    assert.equal(socket.messages.length, 2);
    assert.ok(socket.messages.every(message => message.error));
    peer.close();
});
