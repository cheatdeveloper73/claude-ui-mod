// Offline WebSocket-only continuation checks against a fixture that reproduces
// the server behaviour measured on 2026-10-11: 1009 above 16 MiB, response ids
// that live on one socket until an error, generate:false uploads, and per-message
// tool-call validation. Never contacts a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const local = value => assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), 'offline fixture attempted external network');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => { local(url); return nativeFetch(url, ...args); };
const nativeRequest = https.request;
https.request = (url, ...args) => { local(url); return nativeRequest(url, ...args); };
const nativeConnect = http2.connect;
http2.connect = (url, ...args) => { local(url); return nativeConnect(url, ...args); };

const LIMIT = 16 * 1024 * 1024;
const frame = (data, opcode = 1) => {
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
    header[0] = 128 | opcode;
    if (header.length === 2) header[1] = data.length;
    else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    return Buffer.concat([header, data]);
};
const send = (socket, value) => socket.write(frame(Buffer.from(JSON.stringify(value))));

let posts = 0;
let upgrades = 0;
let upgradeFailures = 0;
let upgradeStatus = 503;
let drops = 0;
let forget = false;
let socketCount = 0;
let ids = 0;
const creates = [];
const peers = new Set();
const fixture = http.createServer((req, res) => { posts++; req.resume(); res.writeHead(500); res.end('HTTP must not be used'); });
fixture.on('upgrade', (req, socket) => {
    upgrades++;
    peers.add(socket);
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    socket.on('close', () => peers.delete(socket));
    if (upgradeFailures > 0) { upgradeFailures--; socket.end(`HTTP/1.1 ${upgradeStatus} Nope\r\nContent-Length: 0\r\n\r\n`); return; }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const index = ++socketCount;
    const known = new Set();
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 2)
        {
            const opcode = buffer[0] & 15;
            let length = buffer[1] & 127;
            let offset = 2;
            if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
            else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
            if (length > LIMIT) { socket.end(frame(Buffer.from([0x03, 0xf1]), 8)); buffer = Buffer.alloc(0); return; }
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + 4 + length);
            if (opcode !== 1) continue;
            const body = JSON.parse(payload);
            assert.equal(body.type, 'response.create');
            creates.push({ socket: index, previous: body.previous_response_id || null, generate: body.generate !== false,
                items: body.input.length, bytes: length, first: body.input[0], tools: body.tools?.length ?? 0 });
            if (drops > 0) { drops--; socket.destroy(); return; }
            const error = message => { known.clear(); send(socket, { type: 'error', error: { type: 'invalid_request_error', code: message[0], message: message[1] } }); };
            if (body.previous_response_id && (forget || !known.has(body.previous_response_id)))
            { forget = false; error(['previous_response_not_found', `Previous response with id '${body.previous_response_id}' not found.`]); continue; }
            const open = new Set();
            for (const item of body.input)
            {
                if (item.type === 'function_call') open.add(item.call_id);
                if (item.type === 'function_call_output' && !open.delete(item.call_id)) { error([null, 'No tool call found for function call output']); return; }
            }
            if (open.size) { error([null, 'No tool output found for function call']); continue; }
            const id = `resp_${++ids}`;
            known.add(id);
            if (!body.generate && body.generate !== undefined)
            {
                send(socket, { type: 'response.created', response: { id } });
                send(socket, { type: 'response.completed', response: { id, output: [], usage: { input_tokens: 1, output_tokens: 0 } } });
                continue;
            }
            const items = [
                { type: 'reasoning', id: `rs_${ids}`, summary: [], encrypted_content: `enc_${ids}` },
                { type: 'message', id: `msg_${ids}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer ${ids}`, annotations: [] }] },
            ];
            send(socket, { type: 'response.created', response: { id } });
            items.forEach((item, i) => {
                send(socket, { type: 'response.output_item.added', output_index: i, item });
                send(socket, { type: 'response.output_item.done', output_index: i, item });
            });
            send(socket, { type: 'response.completed', response: { id, output: [], usage: { input_tokens: 1, output_tokens: 1 } } });
        }
    });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${fixture.address().port}/responses`;
const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router/', import.meta.url));
const { openAIRequest } = await import(pathToFileURL(path.join(root, 'openai-transport.mjs')).href);
const { closeOpenAIWebSockets } = await import(pathToFileURL(path.join(root, 'openai-websocket.mjs')).href);

const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
// What toResponsesInput rebuilds from Claude Code's copy of a fixture answer.
const replay = n => [{ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `enc_${n}` },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${n}` }] }];
const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
const request = (thread, input, extra = {}) => openAIRequest(url, { method: 'POST',
    headers: { Authorization: 'Bearer continuation-fixture', 'thread-id': thread },
    headersTimeoutMs: 2000, body: JSON.stringify({ model: 'fixture', instructions: 'x', stream: true, store: false, tools, input, ...extra }) }, () => false);
const complete = async (thread, input, extra) => {
    const response = await request(thread, input, extra);
    const text = await response.text();
    assert.equal(response.status, 200, text.slice(0, 300));
    assert.match(text, /response\.completed/);
    return Number(/"id":"resp_(\d+)"/.exec(text)[1]);
};
const since = mark => creates.slice(mark);
let checks = 0;
const check = name => { checks++; console.log('PASS ' + name); };

try
{
    let mark = creates.length;
    const first = await complete('warm', [user('one')]);
    const history = [user('one'), ...replay(first), user('two')];
    const second = await complete('warm', history);
    let sent = since(mark);
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1].previous, sent[1].items, sent[1].socket], [`resp_${first}`, 1, sent[0].socket]);
    assert.deepEqual(sent[1].first, user('two'));
    await complete('warm', [...history, ...replay(second), user('three')]);
    assert.equal(since(mark).at(-1).previous, `resp_${second}`);
    check('a turn that extends the last one sends only its new items with previous_response_id');

    mark = creates.length;
    const a = await complete('props', [user('p1')]);
    await complete('props', [user('p1'), ...replay(a), user('p2')], { tools: [] });
    assert.equal(since(mark)[1].previous, null);
    const b = await complete('edit', [user('e1')]);
    await complete('edit', [user('e1'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'edited' }] }, user('e2')]);
    assert.equal(since(mark).at(-1).previous, null);
    await complete('prefix', [user('q1')]);
    await complete('prefix', [user('q1 changed'), ...replay(b), user('q2')]);
    assert.equal(since(mark).at(-1).previous, null);
    check('changed fields, edited history or different model output send the full input');

    mark = creates.length;
    const big = 'b'.repeat(6 * 1024 * 1024);
    const call = { type: 'function_call', call_id: 'call_big', name: 'lookup', arguments: '{}' };
    const result = { type: 'function_call_output', call_id: 'call_big', output: big };
    await complete('cold', [user(big), call, result, user(big), user('ask')]);
    sent = since(mark);
    assert.ok(sent.length >= 2, 'over 16 MiB must be split');
    assert.ok(sent.every(entry => entry.bytes <= LIMIT));
    assert.deepEqual(sent.map(entry => entry.generate), [...sent.slice(1).map(() => false), true]);
    assert.ok(sent.every((entry, i) => i === 0 ? entry.previous === null : entry.previous !== null));
    assert.equal(new Set(sent.map(entry => entry.socket)).size, 1);
    assert.equal(sent.reduce((sum, entry) => sum + entry.items, 0), 5);
    check('cold history over 16 MiB uploads as chained generate:false chunks under the limit, calls kept with outputs');

    mark = creates.length;
    const f1 = await complete('forget', [user('f1')]);
    forget = true;
    await complete('forget', [user('f1'), ...replay(f1), user('f2')]);
    sent = since(mark);
    assert.deepEqual(sent.slice(1).map(entry => [entry.previous !== null, entry.items]), [[true, 1], [false, 4]]);
    check('a lost server-side continuation is resent in full on a fresh socket, invisibly');

    mark = creates.length;
    drops = 1;
    await complete('drop', [user('d1')]);
    assert.equal(since(mark).length, 2);
    drops = 2;
    await assert.rejects(request('drop2', [user('d2')]), /closed without close frame|socket error|ended/);
    check('a loss before any event reaches Claude Code is resent once, then surfaced');

    const before = upgrades;
    upgradeFailures = 2;
    await complete('handshake', [user('h1')]);
    assert.equal(upgrades - before, 3);
    upgradeFailures = 9;
    let response = await request('handshake2', [user('h2')]);
    assert.equal(response.status, 503);
    upgradeFailures = 1;
    upgradeStatus = 401;
    response = await request('auth', [user('h3')]);
    assert.equal(response.status, 401);
    upgradeFailures = 0;
    check('handshake failures retry over WebSocket; auth rejections keep their status');

    mark = creates.length;
    response = await request('huge', [user('h'.repeat(LIMIT + 10))]);
    assert.equal(response.status, 413);
    assert.match(await response.text(), /16 MiB/);
    assert.equal(since(mark).length, 0);
    check('one message group over 16 MiB is refused unsent with 413');

    assert.equal(posts, 0, 'ChatGPT inference must never use HTTP');
    check('zero HTTP requests across every mode');
    console.log(`PASS ${checks} offline WebSocket-only continuation checks`);
}
finally
{
    closeOpenAIWebSockets();
    for (const peer of peers) peer.destroy();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
}
