// Offline recovery and accelerated lifetime checks; never contacts a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const local = value => assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), 'offline recovery fixture attempted external network');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => { local(url); return nativeFetch(url, ...args); };
const nativeRequest = https.request;
https.request = (url, ...args) => { local(url); return nativeRequest(url, ...args); };
const nativeConnect = http2.connect;
http2.connect = (url, ...args) => { local(url); return nativeConnect(url, ...args); };

// Advance only pool idle callbacks and the wall clock. Real network/handshake
// deadlines remain real, so this cannot fabricate successful I/O.
const realNow = Date.now;
const realTimeout = setTimeout;
const realClear = clearTimeout;
let now = realNow();
const performanceDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
const scheduled = new Map();
Date.now = () => now;
globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms !== 5 * 60 * 1000) return realTimeout(callback, ms, ...args);
    const timer = { unref() { return this; } };
    scheduled.set(timer, { at: now + ms, callback: () => callback(...args) });
    return timer;
};
globalThis.clearTimeout = timer => { if (!scheduled.delete(timer)) realClear(timer); };
const advance = ms => {
    now += ms;
    for (const [timer, event] of [...scheduled]) if (event.at <= now) { scheduled.delete(timer); event.callback(); }
};
const pause = ms => new Promise(resolve => realTimeout(resolve, ms));
const until = async predicate => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await pause(5); }
    assert.fail('recovery fixture did not settle');
};
const events = [
    { type: 'response.created', response: { id: 'resp_recovery' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'fixture' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
    { type: 'response.completed', response: { id: 'resp_recovery', usage: { input_tokens: 1, output_tokens: 1 } } },
];
const frame = value => {
    const data = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(data.length < 126 ? 2 : 4);
    header[0] = 129;
    if (header.length === 2) header[1] = data.length;
    else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    return Buffer.concat([header, data]);
};
let mode = 'normal';
let limitOnce = false;
let creates = 0;
let posts = 0;
let upgrades = 0;
const peers = new Set();
const fixture = http.createServer((req, res) => {
    posts++;
    req.resume();
    req.on('end', () => {
        assert.equal(req.method, 'POST');
        if (mode === 'http429') { res.writeHead(429, { 'retry-after': '11' }); res.end('limited'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
});
fixture.on('upgrade', (req, socket) => {
    upgrades++;
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    socket.on('close', () => peers.delete(socket));
    if (mode === 'handshake' || mode === 'http429') { socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'); return; }
    if (mode === 'auth') { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 2)
        {
            const opcode = buffer[0] & 15;
            let length = buffer[1] & 127;
            let offset = 2;
            if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
            assert.ok(length < 65536);
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + 4 + length);
            if (opcode !== 1) continue;
            const value = JSON.parse(payload);
            assert.equal(value.type, 'response.create');
            creates++;
            if (mode === 'loss') { socket.destroy(); continue; }
            if (mode === 'close1011') { socket.write(Buffer.from([0x88, 6, 0x03, 0xf3, 0x62, 0x75, 0x73, 0x79])); continue; }
            if (mode === 'limit' && limitOnce) { limitOnce = false; socket.write(frame({ type: 'error', error: { code: 'websocket_connection_limit_reached', message: 'expired connection' } })); continue; }
            if (mode === 'held') { socket.write(frame(events[2])); continue; }
            socket.write(Buffer.concat(events.map(event => frame(event))));
        }
    });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${fixture.address().port}/responses`;
process.env.CODEX_RESPONSES_URL = url;
const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router/', import.meta.url));
const { openAIRequest } = await import(pathToFileURL(path.join(root, 'openai-transport.mjs')).href);
const { closeOpenAIWebSockets, openAIWebSocketState } = await import(pathToFileURL(path.join(root, 'openai-websocket.mjs')).href);
const request = signal => openAIRequest(url, { method: 'POST', headers: { Authorization: 'Bearer recovery-fixture', 'thread-id': 'recovery' },
    signal, headersTimeoutMs: 1000, body: JSON.stringify({ model: 'fixture', stream: true, input: [{ role: 'user', content: 'fixture' }] }) }, () => !!signal?.aborted);
let checks = 0;
const check = name => { checks++; console.log('PASS ' + name); };
try
{
    // ChatGPT inference is WebSocket-only: no mode below may issue an HTTP POST.
    mode = 'handshake';
    let before = upgrades;
    let response = await request();
    assert.equal(response.status, 503, 'a persistently failing handshake surfaces its status');
    await response.text();
    assert.equal(upgrades - before, 3, 'a server-side handshake failure is retried over WebSocket');
    assert.equal(creates, 0);
    mode = 'normal';
    response = await request(); await response.text();
    assert.equal(response.status, 200);
    check('handshake failures retry over WebSocket without an HTTP leg');

    closeOpenAIWebSockets();
    mode = 'auth';
    before = upgrades;
    response = await request();
    assert.equal(response.status, 403);
    await response.text();
    assert.equal(upgrades - before, 1);
    check('authentication rejection is surfaced, not retried');

    mode = 'normal';
    response = await request(); await response.text();
    mode = 'limit';
    limitOnce = true;
    const beforeLimit = creates;
    response = await request(); await response.text();
    assert.equal(response.status, 200);
    assert.equal(creates, beforeLimit + 2);
    check('explicit connection-limit refusal resends once on a fresh socket');

    mode = 'loss';
    const beforeLoss = creates;
    await assert.rejects(request());
    assert.equal(creates, beforeLoss + 2);
    mode = 'normal';
    response = await request(); await response.text();
    check('loss before any event is resent once, then surfaced; next request reconnects');

    mode = 'close1011';
    await assert.rejects(request(), error => error.closeCode === 1011 && /closed 1011 busy \(socket age \d+s, turn \d+, before first event\)/.test(error.message));
    mode = 'normal';
    check('server close code, reason, socket age and turn reach the loss log');

    advance(31000);
    mode = 'normal';
    closeOpenAIWebSockets();
    const beforeAge = openAIWebSocketState().opened;
    for (let turn = 0; turn < 11; turn++) { response = await request(); await response.text(); advance(4 * 60 * 1000); }
    assert.equal(openAIWebSocketState().opened - beforeAge, 2, 'continuously-used sockets must rotate before half the server lifetime is spent');
    check('age rotation while continuously active between turns');

    mode = 'held';
    response = await request();
    const reader = response.body.getReader();
    await reader.read();
    const active = openAIWebSocketState().active;
    advance(60 * 60 * 1000);
    assert.equal(openAIWebSocketState().active, active, 'age/idle retirement must not evict an active response');
    mode = 'normal';
    const other = await request(); await other.text();
    assert.equal(openAIWebSocketState().active, active);
    await reader.cancel();
    assert.equal(openAIWebSocketState().active, 0);
    check('active response survives rotation; cancellation reclaims only its lease');

    const beforeHours = openAIWebSocketState().opened;
    for (let hour = 0; hour < 48; hour++)
    {
        advance(60 * 60 * 1000);
        assert.equal(openAIWebSocketState().connections, 0);
        response = await request(); await response.text();
        assert.equal(openAIWebSocketState().connections, 1);
        assert.equal(openAIWebSocketState().active, 0);
    }
    assert.equal(openAIWebSocketState().opened - beforeHours, 48);
    check('48 accelerated hourly idle/reconnect cycles leave one healthy idle socket and zero active leases');
    assert.equal(posts, 0, 'ChatGPT inference must never use HTTP');
    console.log(`PASS ${checks} offline long-session recovery checks (accelerated clock; not a 48-hour soak)`);
}
finally
{
    closeOpenAIWebSockets();
    for (const peer of peers) peer.destroy();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    globalThis.setTimeout = realTimeout;
    globalThis.clearTimeout = realClear;
    Date.now = realNow;
    if (performanceDescriptor) Object.defineProperty(performance, 'now', performanceDescriptor);
    else delete performance.now;
}
