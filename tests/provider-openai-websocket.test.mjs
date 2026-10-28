// Loopback RFC6455 fixture through the real Response-like consumer. No provider traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router/', import.meta.url));
// Refuse non-loopback traffic even if a future import captures configuration early.
const local = value => {
    const url = value instanceof URL ? value : new URL(typeof value === 'string' ? value : value.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'offline fixture attempted external network');
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => { local(url); return nativeFetch(url, ...args); };
const nativeConnect = http2.connect;
http2.connect = (url, ...args) => { local(url); return nativeConnect(url, ...args); };
const nativeHttpsRequest = https.request;
https.request = (url, ...args) => { local(url); return nativeHttpsRequest(url, ...args); };

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); }
    assert.fail('fixture condition did not settle');
};
function frame(value, opcode = 1, fin = true)
{
    const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length < 65536 ? 4 : 10);
    header[0] = (fin ? 128 : 0) | opcode;
    if (header.length === 2) header[1] = data.length;
    else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    return Buffer.concat([header, data]);
}
const completed = type => ({ type: type || 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 3, output_tokens: 1 } } });
const events = text => [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
    completed(),
];
let mode = 'normal';
let upgrades = 0;
let creates = 0;
let lastHeaders;
let lastPayload;
let pongs = 0;
const sockets = new Set();
const fixture = http.createServer((req, res) => { res.writeHead(426); res.end(); });
fixture.on('upgrade', (req, socket) => {
    upgrades++;
    lastHeaders = req.headers;
    sockets.add(socket);
    socket.on('error', () => {});
    // Upgraded HTTP sockets are half-open; acknowledge the client's FIN so
    // close is a valid observation of cancellation rather than fixture leakage.
    socket.on('end', () => socket.end());
    socket.on('close', () => sockets.delete(socket));
    if (mode === 'upgrade-error') {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 4\r\nRetry-After: 17\r\n\r\nslow');
        return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nX-Request-Id: fixture\r\n\r\n');
    let buf = Buffer.alloc(0);
    socket.on('data', data => {
        buf = Buffer.concat([buf, data]);
        while (buf.length >= 2) {
            const opcode = buf[0] & 15;
            let n = buf[1] & 127;
            let offset = 2;
            if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); offset = 4; }
            if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); offset = 10; }
            assert.ok(buf[1] & 128, 'client MUST mask');
            if (buf.length < offset + 4 + n) return;
            const mask = buf.subarray(offset, offset + 4);
            const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + n));
            for (let i = 0; i < n; i++) payload[i] ^= mask[i % 4];
            buf = buf.subarray(offset + 4 + n);
            if (opcode === 10) { pongs++; continue; }
            if (opcode === 8) { socket.end(frame(Buffer.alloc(0), 8)); continue; }
            assert.equal(opcode, 1);
            creates++;
            const request = JSON.parse(payload);
            lastPayload = request;
            assert.equal(request.type, 'response.create');
            assert.equal(request.previous_response_id, undefined);
            assert.equal(request.input.length, 2);
            const chosen = mode;
            if (chosen === 'silent') continue;
            if (chosen === 'partial') { socket.write(frame(events('partial')[2])); continue; }
            if (chosen === 'loss') { socket.write(frame(events('loss')[2])); setTimeout(() => socket.destroy(), 10); continue; }
            if (chosen === 'early-error' || chosen === 'early-failed') {
                socket.write(frame({ type: 'codex.rate_limits' }));
                socket.write(frame({ type: 'codex.response.metadata' }));
                socket.write(frame(events('ignored')[0]));
                socket.write(frame(chosen === 'early-error'
                    ? { type: 'error', status_code: 429, error: { code: 'rate_limit_exceeded', message: 'slow', headers: { 'retry-after': '19' } } }
                    : { type: 'response.failed', response: { error: { code: 'invalid_prompt', message: 'bad prompt' } } }));
                continue;
            }
            if (chosen === 'mid-error') {
                socket.write(frame(events('partial')[2]));
                socket.write(frame({ type: 'error', error: { code: 'server_error', message: 'midstream' } }));
                continue;
            }
            if (chosen === 'tools') {
                socket.write(Buffer.concat([
                    events('')[0],
                    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture' } },
                    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'fixture thought' },
                    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-cipher' } },
                    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_read', name: 'Read' } },
                    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file_path":"fixture"}' },
                    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_read', name: 'Read', arguments: '{"file_path":"fixture"}' } },
                    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_glob', name: 'Glob' } },
                    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'call_glob', name: 'Glob', arguments: '{"pattern":"fixture"}' } },
                    completed(),
                ].map(event => frame(event))));
                continue;
            }
            if (chosen === 'after-tool') {
                assert.equal(request.input[1].type, 'function_call_output');
                assert.equal(request.input[1].call_id, 'call_read');
                socket.write(Buffer.concat(events('tool result received').map(event => frame(event))));
                continue;
            }
            if (chosen === 'oversized') {
                const bad = Buffer.alloc(10);
                bad[0] = 129; bad[1] = 127; bad.writeBigUInt64BE(32n * 1024n * 1024n + 1n, 2);
                socket.write(bad);
                continue;
            }
            if (chosen === 'binary') { socket.write(frame(Buffer.from('bad'), 2)); continue; }
            if (chosen === 'masked-server') { const bad = frame({ type: 'response.created' }); bad[1] |= 128; socket.write(bad); continue; }
            const content = request.input[1].content;
            const output = events(typeof content === 'string' ? content : content.map(item => item.text || '').join(''));
            if (chosen === 'incomplete') output[4] = completed('response.incomplete');
            if (chosen === 'fragmented') {
                const text = Buffer.from(JSON.stringify(output[2]));
                const all = Buffer.concat([frame(output[0]), frame(output[1]), frame(text.subarray(0, 8), 1, false), frame(Buffer.from('ping'), 9), frame(text.subarray(8), 0), frame(output[3]), frame(output[4])]);
                for (let i = 0; i < all.length; i += 3) socket.write(all.subarray(i, i + 3));
            } else if (chosen === 'concurrent') setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.concat(output.map(e => frame(e)))); }, 40);
            else socket.write(Buffer.concat(output.map(e => frame(e))));
        }
    });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${fixture.address().port}/responses`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-ws-router-'));
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.fixture';
fs.writeFileSync(path.join(temp, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt, account_id: 'fixture', refresh_token: 'fixture' } }));
fs.mkdirSync(path.join(temp, 'adapters'));
fs.writeFileSync(path.join(temp, 'catalogue.json'), '[]');
fs.writeFileSync(path.join(temp, 'secrets.json'), '{}');
Object.assign(process.env, {
    CODEX_RESPONSES_URL: url, CODEX_AUTH_FILE: path.join(temp, 'auth.json'),
    MODEL_ROUTER_STATE_DIR: temp, MODEL_ROUTER_ADAPTER_DIR: path.join(temp, 'adapters'),
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'), MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'secrets.json'),
    MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
});
const { openAIRequest } = await import(pathToFileURL(path.join(root, 'openai-transport.mjs')).href);
const { sseParser, collectAnthropicMessage, ResponsesToAnthropic } = await import(pathToFileURL(path.join(root, 'openai.mjs')).href);
const headers = { Authorization: 'Bearer fixture-only', 'chatgpt-account-id': 'fixture-account', 'session-id': 'fixture-session', 'thread-id': 'fixture-thread', originator: 'codex_cli_rs' };
const request = (text = 'fixture', extra = {}, signal, payload = {}) => openAIRequest(url, {
    method: 'POST', headers: { ...headers, ...extra }, signal,
    body: JSON.stringify({ model: 'fixture', stream: true, input: [{ role: 'user', content: 'full history' }, { role: 'user', content: text }], ...payload }),
}, () => signal?.aborted || false);
async function consume(response, cancelAtTerminal = true)
{
    const result = [];
    const feed = sseParser(e => result.push(e));
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(Buffer.from(value).toString());
        if (cancelAtTerminal && ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(result.at(-1)?.type)) { await reader.cancel(); break; }
    }
    return result;
}
let passes = 0;
function check(name) { passes++; console.log('PASS ' + name); }
try {
    let response = await request();
    assert.equal(response.status, 200);
    let result = await consume(response);
    assert.equal(collectAnthropicMessage('fixture', result).content[0].text, 'fixture');
    assert.equal(lastHeaders.authorization, headers.Authorization);
    assert.equal(lastHeaders['session-id'], headers['session-id']);
    assert.equal(lastPayload.stream, true);
    const first = upgrades;
    await consume(await request('second'));
    assert.equal(upgrades, first, 'terminal reader.cancel must release the healthy connection');
    check('full-input response.create, headers, SSE consumer and sequential reuse');

    await consume(await request('eof'), false);
    await consume(await request('after-eof'));
    assert.equal(upgrades, first);
    check('EOF consumption releases a healthy connection');

    for (const extra of [{ Authorization: 'Bearer other-fixture' }, { 'thread-id': 'other' }, { 'x-codex-turn-state': 'affinity' }, { originator: 'other-client' }]) {
        const before = upgrades;
        await consume(await request('isolated', extra));
        assert.equal(upgrades, before + 1);
    }
    check('credential, thread and every affinity header isolate reuse');

    mode = 'concurrent';
    const beforeConcurrent = upgrades;
    const concurrent = await Promise.all([request('alpha'), request('beta')]);
    const contents = await Promise.all(concurrent.map(r => consume(r)));
    assert.equal(contents[0].find(e => e.type === 'response.output_text.delta').delta, 'alpha');
    assert.equal(contents[1].find(e => e.type === 'response.output_text.delta').delta, 'beta');
    assert.equal(upgrades, beforeConcurrent + 1);
    check('same-key concurrent requests use exclusive sockets');

    mode = 'fragmented';
    result = await consume(await request('héllo'.repeat(100)));
    assert.equal(result.find(e => e.type === 'response.output_text.delta').delta, 'héllo'.repeat(100));
    await until(() => pongs === 1);
    check('partial frames, UTF8, continuation, extended length and interleaved ping');
    mode = 'normal';
    result = await consume(await request('x'.repeat(70000)));
    assert.equal(result.find(event => event.type === 'response.output_text.delta').delta.length, 70000);
    check('64-bit request and response frame lengths');

    mode = 'incomplete';
    result = await consume(await request());
    assert.equal(result.at(-1).type, 'response.incomplete');
    check('incomplete terminates and releases');

    mode = 'tools';
    result = await consume(await request());
    const message = collectAnthropicMessage('fixture', result);
    assert.equal(message.stop_reason, 'tool_use');
    assert.match(message.content.find(block => block.type === 'thinking').signature, /^oai1:/);
    const toolFrames = [];
    const toolTranslator = new ResponsesToAnthropic('fixture', frame => toolFrames.push(frame));
    for (const event of result) toolTranslator.handle(event);
    const args = new Map();
    const parseTools = sseParser(event => {
        if (event.content_block?.type === 'tool_use') args.set(event.index, '');
        if (event.delta?.type === 'input_json_delta') args.set(event.index, (args.get(event.index) || '') + event.delta.partial_json);
    });
    for (const frame of toolFrames) parseTools(frame);
    assert.deepEqual([...args.values()].map(value => JSON.parse(value)), [{ file_path: 'fixture' }, { pattern: 'fixture' }]);
    const beforeToolResult = upgrades;
    mode = 'after-tool';
    result = await consume(await request('result', {}, undefined, { input: [{ role: 'user', content: 'full history' }, { type: 'function_call_output', call_id: 'call_read', output: 'fixture result' }] }));
    assert.equal(collectAnthropicMessage('fixture', result).content[0].text, 'tool result received');
    assert.equal(upgrades, beforeToolResult);
    check('parallel tools, argument deltas, reasoning signature and tool-result turn reuse');

    mode = 'early-error';
    response = await request();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '19');
    assert.match(await response.text(), /slow/);
    mode = 'early-failed';
    response = await request();
    assert.equal(response.status, 200);
    result = await consume(response);
    assert.throws(() => collectAnthropicMessage('fixture', result), error => error.statusCode === 400 && /bad prompt/.test(error.message));
    check('early errors preserve HTTP status; failed responses retain translator semantics');

    mode = 'upgrade-error';
    response = await request('upgrade', { 'thread-id': 'upgrade-error' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(await response.text(), 'slow');
    check('authenticated non-101 upgrade preserves HTTP error');

    mode = 'mid-error';
    response = await request();
    assert.equal(response.status, 200);
    result = await consume(response);
    assert.equal(result.at(-1).type, 'error');
    check('provider error after content remains in-band');

    mode = 'partial';
    response = await request();
    const reader = response.body.getReader();
    await reader.read();
    const beforeCancel = creates;
    await reader.cancel();
    mode = 'normal';
    result = await consume(await request('fresh'));
    assert.equal(creates, beforeCancel + 1);
    assert.equal(result.find(e => e.type === 'response.output_text.delta').delta, 'fresh');
    check('premature cancellation destroys lease without replay');

    mode = 'silent';
    const ac = new AbortController();
    const pending = request('blocked', {}, ac.signal);
    await until(() => creates === beforeCancel + 2);
    ac.abort();
    await assert.rejects(pending);
    check('disconnect abort wakes a blocked pre-content request');

    mode = 'loss';
    const beforeLoss = creates;
    response = await request();
    await assert.rejects(() => consume(response));
    assert.equal(creates, beforeLoss + 1);
    check('midstream loss is never replayed');

    for (const bad of ['binary', 'masked-server', 'oversized']) {
        mode = bad;
        await assert.rejects(() => request());
    }
    check('invalid RFC6455 frames fail closed');

    // Real router binds downstream close to the transport while no frame arrives.
    const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const send = () => fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-gpt-6-astra[1m]', stream: true, messages: [{ role: 'user', content: 'fixture' }, { role: 'user', content: 'router' }] }),
    });
    try {
        mode = 'early-error';
        response = await send();
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '19');
        await response.text();
        mode = 'normal';
        response = await send();
        assert.match(await response.text(), /message_stop/);
        mode = 'silent';
        const before = creates;
        const client = http.request({ host: '127.0.0.1', port: server.address().port, path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json' } });
        client.on('error', () => {});
        client.end(JSON.stringify({ model: 'claude-gpt-6-astra[1m]', stream: true, messages: [{ role: 'user', content: 'full' }, { role: 'user', content: 'blocked' }] }));
        await until(() => creates === before + 1);
        const socketCount = sockets.size;
        client.destroy();
        await until(() => sockets.size < socketCount);
        check('real router 429 passthrough, stream completion and blocked downstream disconnect');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
    console.log(`PASS ${passes} offline WebSocket transport checks`);
} finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => fixture.close(resolve));
}
