// Real TLS HTTP/2 + HTTP/1 fixture. No external network or provider credentials.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { cert, key } from './fixtures/transport-tls.cjs';

if (!process.env.FIREWORKS_TRANSPORT_FIXTURE)
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fireworks-tls-'));
    const ca = path.join(temp, 'ca.pem');
    fs.writeFileSync(ca, cert);
    try
    {
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            windowsHide: true, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, FIREWORKS_TRANSPORT_FIXTURE: '1' },
        });
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
    }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
else
{
    const local = value => assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname), 'offline fixture attempted external network');
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, ...args) => { local(url); return nativeFetch(url, ...args); };
    const nativeConnect = http2.connect;
    http2.connect = (url, ...args) => { local(url); return nativeConnect(url, ...args); };
    const nativeRequest = https.request;
    https.request = (url, ...args) => { local(url); return nativeRequest(url, ...args); };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
        for (let i = 0; i < 200; i++) { if (predicate()) return; await pause(5); }
        assert.fail('fixture condition did not settle');
    };
    let sessionCount = 0;
    let requests = 0;
    let canceled = 0;
    let mode = 'normal';
    const peers = new Set();
    const sockets = new Set();
    const fixture = http2.createSecureServer({ cert, key, allowHTTP1: true });
    fixture.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    fixture.on('session', session => { sessionCount++; peers.add(session); session.on('error', () => {}); session.on('close', () => peers.delete(session)); });
    const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    fixture.on('request', (req, res) => {
        req.on('error', () => {});
        res.on('error', () => {});
        const chunks = [];
        req.on('data', data => chunks.push(data));
        req.on('end', () => {
            requests++;
            const body = JSON.parse(Buffer.concat(chunks).toString());
            assert.equal(req.headers.authorization, 'Bearer fixture-only');
            res.setHeader('x-fixture-protocol', req.httpVersion);
            if (mode === 'silent') { req.stream?.once('close', () => canceled++); return; }
            if (mode === 'loss') { req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); return; }
            if (mode === '429') { res.writeHead(429, { 'retry-after': '23' }); res.end('slow'); return; }
            if (mode === 'partial') { res.writeHead(200); res.write('partial'); req.stream.once('close', () => canceled++); return; }
            if (mode === 'gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync(JSON.stringify({ label: body.label }))); return; }
            if (body.model === 'fixture-model')
            {
                if (!body.stream)
                {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
                        content: [{ type: 'text', text: 'fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
                    return;
                }
                const toolResult = body.messages.at(-1).content?.some?.(item => item.type === 'tool_result');
                res.setHeader('Content-Type', 'text/event-stream');
                const events = [
                    { type: 'message_start', message: { id: 'msg_fixture', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
                    { type: 'content_block_start', index: 0, content_block: toolResult ? { type: 'text', text: '' } : { type: 'tool_use', id: 'call_fixture', name: 'Read', input: {} } },
                    { type: 'content_block_delta', index: 0, delta: toolResult ? { type: 'text_delta', text: 'tool result received' } : { type: 'input_json_delta', partial_json: '{"file_path":"fixture"}' } },
                    { type: 'content_block_stop', index: 0 },
                    { type: 'message_delta', delta: { stop_reason: toolResult ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 2 } },
                    { type: 'message_stop' },
                ];
                res.end(events.map(frame).join(''));
                return;
            }
            const finish = () => res.end(JSON.stringify({ label: body.label }));
            if (mode === 'parallel') setTimeout(finish, 20);
            else if (mode === 'goaway') { const session = req.stream.session; finish(); session.goaway(0, req.stream.id); }
            else finish();
        });
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const url = `https://localhost:${fixture.address().port}/messages`;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fireworks-router-'));
    fs.mkdirSync(path.join(temp, 'adapters'));
    fs.writeFileSync(path.join(temp, 'secrets.json'), JSON.stringify({ fireworks: 'fixture-only' }));
    fs.writeFileSync(path.join(temp, 'catalogue.json'), JSON.stringify([{ id: 'fixture-model', provider: 'fireworks',
        backend: { protocol: 'anthropic-messages', baseUrl: url.replace(/\/messages$/, ''), apiKeyHeader: 'authorization', secret: 'fireworks' } }]));
    Object.assign(process.env, { MODEL_ROUTER_STATE_DIR: temp, MODEL_ROUTER_ADAPTER_DIR: path.join(temp, 'adapters'),
        MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'), MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'secrets.json'),
        MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'), CODEX_RESPONSES_URL: 'http://127.0.0.1:1/responses' });
    const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router/', import.meta.url));
    let transport;
    try { transport = await import(pathToFileURL(path.join(root, 'fireworks-transport.mjs')).href); }
    catch (error)
    {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        const { fetchResilient, NO_STATUS_RETRY } = await import(pathToFileURL(path.join(root, 'relay.mjs')).href);
        transport = { fireworksRequest: (u, options, gone) => fetchResilient(u, options, 'fixture', gone, NO_STATUS_RETRY) };
    }
    const request = (label, signal) => transport.fireworksRequest(url, {
        method: 'POST', headers: { Authorization: 'Bearer fixture-only', 'Content-Type': 'application/json' }, body: JSON.stringify({ label }), signal,
    }, () => !!signal?.aborted);
    let checks = 0;
    const check = name => { checks++; console.log('PASS ' + name); };
    let router;
    try
    {
        let response = await request('first');
        assert.equal(response.headers.get('x-fixture-protocol'), '2.0', 'Fireworks must negotiate HTTP/2 rather than HTTP/1.1');
        assert.deepEqual(await response.json(), { label: 'first' });
        const first = sessionCount;
        assert.deepEqual(await (await request('second')).json(), { label: 'second' });
        assert.equal(sessionCount, first, 'sequential turns must reuse the TLS session');
        check('HTTP/2 negotiation and sequential TLS reuse');

        mode = 'parallel';
        const parallel = await Promise.all(['alpha', 'beta'].map(label => request(label).then(r => r.json())));
        assert.deepEqual(parallel, [{ label: 'alpha' }, { label: 'beta' }]);
        assert.equal(sessionCount, first, 'parallel turns must multiplex one HTTP/2 session');
        check('parallel inference multiplexes without connection churn');

        mode = '429';
        const before429 = requests;
        response = await request('rate');
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '23');
        assert.equal(await response.text(), 'slow');
        assert.equal(requests, before429 + 1);
        check('429 and Retry-After pass through without retry');

        mode = 'gzip';
        assert.deepEqual(await (await request('compressed')).json(), { label: 'compressed' });
        check('compressed responses retain fetch byte semantics');

        mode = 'partial';
        response = await request('cancel');
        const reader = response.body.getReader();
        await reader.read();
        await reader.cancel();
        await until(() => canceled === 1);
        mode = 'normal';
        await (await request('after-cancel')).text();
        assert.equal(sessionCount, first);
        check('cancel reclaims only its stream and preserves the shared session');

        mode = 'silent';
        const ac = new AbortController();
        const beforeSilent = requests;
        const pending = request('silent', ac.signal);
        await until(() => requests === beforeSilent + 1);
        ac.abort();
        await assert.rejects(pending, /client disconnected/);
        await until(() => canceled === 2);
        check('disconnect cancels while waiting for headers');

        mode = 'loss';
        const beforeLoss = requests;
        await assert.rejects(request('ambiguous-reset'));
        assert.equal(requests, beforeLoss + 1);
        check('reset before response headers never replays a submitted POST');

        mode = 'goaway';
        await (await request('retire')).text();
        await until(() => transport.fireworksTransportState().sessions === 0);
        mode = 'normal';
        await (await request('new-session')).text();
        assert.equal(sessionCount, first + 1);
        check('GOAWAY drains then rotates the next turn');

        const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
        router = server;
        await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
        const { sseParser } = await import(pathToFileURL(path.join(root, 'openai.mjs')).href);
        const send = messages => fetch(`http://127.0.0.1:${router.address().port}/v1/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'fixture-model', max_tokens: 128, stream: true, messages,
                tools: [{ name: 'Read', description: 'fixture', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }] }),
        });
        let events = [];
        response = await send([{ role: 'user', content: 'fixture' }]);
        assert.equal(response.headers.get('x-fixture-protocol'), '2.0');
        sseParser(event => events.push(event))(await response.text());
        assert.equal(events[0].message.model, 'fixture-model');
        assert.equal(events.find(event => event.type === 'content_block_delta').delta.partial_json, '{"file_path":"fixture"}');
        assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
        assert.equal(events.at(-1).type, 'message_stop');
        events = [];
        response = await send([{ role: 'user', content: 'fixture' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_fixture', name: 'Read', input: { file_path: 'fixture' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'result' }] }]);
        sseParser(event => events.push(event))(await response.text());
        assert.equal(events.find(event => event.type === 'content_block_delta').delta.text, 'tool result received');
        check('real router tool call/result streaming uses the HTTP/2 provider path');
        console.log(`PASS ${checks} offline Fireworks transport checks`);
    }
    finally
    {
        if (router) { router.closeAllConnections(); await new Promise(resolve => router.close(resolve)); }
        transport.closeFireworksSessions?.();
        for (const peer of peers) peer.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => fixture.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
