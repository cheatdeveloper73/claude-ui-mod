// Real router over a cleartext HTTP/2 fixture. No provider requests.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-openai-stream-test-'));
const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.test';
const auth = path.join(temp, 'auth.json');
fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: token, account_id: 'test-only', refresh_token: 'test' } }));
const adapterDir = path.join(temp, 'no-adapters');
fs.mkdirSync(adapterDir, { recursive: true });
fs.writeFileSync(path.join(temp, 'catalogue.json'), '[]');
fs.writeFileSync(path.join(temp, 'provider-secrets.json'), '{}');

const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const created = () => ({ type: 'response.created', response: { id: 'resp_fixture', model: 'gpt-6-astra', usage: { input_tokens: 1, output_tokens: 0 } } });
const completed = () => ({ type: 'response.completed', response: { id: 'resp_fixture', model: 'gpt-6-astra', usage: { input_tokens: 1, output_tokens: 2 } } });
const textEvents = () => [
    created(),
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'HTTP2_OK' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
    completed(),
];

let mode = 'complete';
let requests = 0;
let cancelledAfterTerminal = false;
const upstream = http2.createServer();
upstream.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('error', () => {});
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
        requests++;
        assert.equal(headers[':method'], 'POST');
        assert.equal(headers.authorization, `Bearer ${token}`);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(body.model, 'gpt-6-astra');
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });

        if (mode === 'heartbeat')
        {
            for (const event of textEvents().slice(0, -1)) stream.write(frame(event));
            setTimeout(() => { if (!stream.destroyed) stream.end(frame(completed())); }, 120);
            return;
        }
        if (mode === 'tool-loss')
        {
            const events = [
                created(),
                { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_fixture', name: 'Read' } },
                { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"file_path":"fixture"}' },
                { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_fixture', name: 'Read' } },
            ];
            for (const event of events) stream.write(frame(event));
            setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 20);
            return;
        }
        if (mode === 'thinking-loss')
        {
            stream.write(frame(created()));
            stream.write(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } }));
            stream.write(frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'partial' }));
            setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 20);
            return;
        }
        if (mode === 'provider-failed')
        {
            stream.end(frame(created()) + frame({ type: 'response.failed', response: { error: { message: 'provider fixture failed' } } }));
            return;
        }
        if (mode === 'terminal-hang')
        {
            for (const event of textEvents()) stream.write(frame(event));
            stream.once('aborted', () => { cancelledAfterTerminal = true; });
            stream.once('close', () => { cancelledAfterTerminal = true; });
            setTimeout(() => { if (!stream.destroyed) stream.end(); }, 500);
            return;
        }
        stream.end(textEvents().map(frame).join(''));
    });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamURL = `h2c://127.0.0.1:${upstream.address().port}/responses`;
Object.assign(process.env, {
    CODEX_AUTH_FILE: auth,
    CODEX_RESPONSES_URL: upstreamURL,
    CODEX_STREAM_HEARTBEAT_MS: '30',
    MODEL_ROUTER_UPSTREAM: 'http://127.0.0.1:1',
    MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'),
    MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'provider-secrets.json'),
});
const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const send = () => fetch(endpoint + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'stream-fixture' },
    body: JSON.stringify({ model: 'claude-gpt-6-astra[1m]', max_tokens: 2000, stream: true, messages: [{ role: 'user', content: 'test' }] }),
});

try
{
    let response = await send();
    let text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /HTTP2_OK/);
    assert.match(text, /event: message_stop/);

    mode = 'heartbeat';
    response = await send();
    text = await response.text();
    assert.match(text, /event: ping/);
    assert.match(text, /event: message_stop/);

    mode = 'tool-loss';
    response = await send();
    text = await response.text();
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /event: message_stop/);
    assert.doesNotMatch(text, /event: error/);

    mode = 'provider-failed';
    response = await send();
    text = await response.text();
    assert.match(text, /event: error/);
    assert.match(text, /provider fixture failed/);

    mode = 'terminal-hang';
    const started = Date.now();
    response = await send();
    text = await response.text();
    const elapsed = Date.now() - started;
    assert.match(text, /event: message_stop/);
    assert.ok(elapsed < 300, `router waited ${elapsed}ms for HTTP/2 EOF after response.completed`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(cancelledAfterTerminal, true);

    mode = 'thinking-loss';
    await assert.rejects(() => send().then(value => value.text()));

    assert.equal(requests, 6);
    console.log('PASS OpenAI HTTP/2 stream lifecycle: transport, heartbeat, tool recovery, terminal short-circuit');
}
finally
{
    server.closeAllConnections();
    await Promise.all([
        new Promise(resolve => server.close(resolve)),
        new Promise(resolve => upstream.close(resolve)),
    ]);
    fs.rmSync(temp, { recursive: true, force: true });
}
