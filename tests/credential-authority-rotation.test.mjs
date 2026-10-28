// Real router over HTTP, a loopback Anthropic fixture and synthetic tokens
// only. The authority file is a temp path, so no live credential is read.
// The rotation wait runs on a synthetic clock: time moves only inside the
// router's own sleeps, so bounds are exact and nothing depends on wall time.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Hang guard only; no assertion depends on wall time.
setTimeout(() => { console.log('FAIL watchdog: suite did not finish in 120 s'); process.exit(1); }, 120000).unref();

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-rotation-test-'));
// Split so the fixture never reads as a real key to the publish scan.
const tok = label => 'sk-' + `ant-oat01-fixture-${label}-${crypto.randomBytes(6).toString('hex')}`;
const T = { A: tok('A'), B: tok('B'), C: tok('C'), D: tok('D'), cli: tok('cli'), local: tok('local') };

const authorityFile = path.join(temp, 'credential-authority.json');
const localView = path.join(temp, 'credential-claude-view.json');
const readerView = path.join(temp, 'credential-access-view.json');
const LOCAL = os.hostname();
const AUTHORITY_ELSEWHERE = 'AUTHORITY-FIXTURE-HOST';

function writeAuthority(host) { fs.writeFileSync(authorityFile, JSON.stringify({ version: 1, authorityHost: host, viewFile: readerView, claudeViewFile: localView })); }
function claudeView(host, accessToken, extra = {}) {
    return { version: 1, authorityHost: host, claude: { accessToken, expiresAt: Date.now() + 8 * 3600e3,
        scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: 'fixture', ...extra } };
}
const setLocal = (token, extra) => fs.writeFileSync(localView, JSON.stringify(claudeView(LOCAL, token, extra)));
const setReader = (token, extra) => fs.writeFileSync(readerView, JSON.stringify(claudeView(AUTHORITY_ELSEWHERE, token, extra)));

// ---------------------------------------------------- Anthropic fixture ----
let valid = new Set();
let onRequest = null;
let rejections = 0;
let rejectionBody = null;
let statusFor = null;
let stall = null;
let rejectionType = 'authentication_error';
const calls = [];
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        calls.push({ path: req.url, raw, bearer, headers: req.headers });
        onRequest?.(bearer);
        const forced = statusFor?.(bearer);
        if (forced) { res.writeHead(forced, { 'content-type': 'application/json', 'retry-after': '17' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"fixture"}}'); return; }
        if (!valid.has(bearer)) {
            rejections++;
            const body = rejectionBody || JSON.stringify({ type: 'error', error: { type: rejectionType, message: `OAuth token has been revoked (fixture ${rejections})` }, request_id: `req_fixture_${rejections}` });
            res.writeHead(401, { 'content-type': 'application/json', 'x-fixture-rejection': String(rejections), 'request-id': `req_fixture_${rejections}` });
            if (stall) { const half = Math.floor(body.length / 2); res.write(body.slice(0, half)); stall.written(); stall.release.then(() => res.end(body.slice(half))); return; }
            res.end(body);
            return;
        }
        if (req.url.startsWith('/anthropic/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ type: 'model', id: 'fixture-upstream-model' }], has_more: false }));
            return;
        }
        let body = {}; try { body = JSON.parse(raw); } catch {}
        const msg = { id: `msg_fixture_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'FIXTURE_OK' }], stop_reason: 'end_turn' })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = [{ type: 'message_start', message: msg }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'FIXTURE_OK' } }, { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
        res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${upstream.address().port}`;

const adapterDir = path.join(temp, 'no-adapters'); fs.mkdirSync(adapterDir);
Object.assign(process.env, {
    MODEL_ROUTER_AUTHORITY_FILE: authorityFile, MODEL_ROUTER_UPSTREAM: `${base}/anthropic`, MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp, MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'), MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'secrets.json'),
    CODEX_AUTH_FILE: path.join(temp, 'no-codex-auth.json'), CODEX_RESPONSES_URL: `${base}/responses`,
});
fs.writeFileSync(process.env.MODEL_ROUTER_CATALOGUE_FILE, '[]');
fs.writeFileSync(process.env.MODEL_ROUTER_SECRETS_FILE, '{}');
const { server, throughput } = await import(pathToFileURL(path.join(root, 'index.mjs')));
const authority = await import(pathToFileURL(path.join(root, 'credential-authority.mjs')));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------ synthetic clock ----
// Virtual time starts at 0 per case and advances only in the router's sleeps.
// `events` are [virtualMs, action] pairs applied as time passes them.
const clock = { t: 0, sleeps: 0, events: [], gate: null, holdGate: null };
if (authority.credentialClock) {
    authority.credentialClock.now = () => clock.t;
    authority.credentialClock.sleep = async ms => {
        clock.sleeps++;
        if (clock.gate) await clock.gate.promise;
        clock.t += ms;
        while (clock.events.length && clock.events[0][0] <= clock.t) clock.events.shift()[1]();
        await new Promise(r => setImmediate(r));
    };
    // The 401 hold timer fires only when a case opens holdGate.
    authority.credentialClock.timeout = () => ({ promise: clock.holdGate ? clock.holdGate.promise : new Promise(() => {}), cancel() {} });
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function reset({ host = LOCAL, local = T.A, reader = null, accept = [], events = [] } = {}) {
    calls.length = 0; rejections = 0; rejectionBody = null; statusFor = null; onRequest = null; stall = null; rejectionType = 'authentication_error'; clock.holdGate = null;
    clock.t = 0; clock.sleeps = 0; clock.events = [...events].sort((a, b) => a[0] - b[0]); clock.gate = null;
    valid = new Set(accept);
    writeAuthority(host);
    if (local) setLocal(local); else fs.rmSync(localView, { force: true });
    if (reader) setReader(reader); else fs.rmSync(readerView, { force: true });
}

const REQUEST = { model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'rotation fixture' }] };
function send(extraHeaders = {}, body = REQUEST, urlPath = '/v1/messages', signal) {
    return fetch(endpoint + urlPath, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-claude-code-session-id': '9a7d1c52-6f0e-4b8e-9d1c-000000000001',
        authorization: `Bearer ${T.cli}`, 'anthropic-beta': 'fixture-beta-2026', ...extraHeaders }, body: JSON.stringify(body) });
}
const count = (text, needle) => text.split(needle).length - 1;
const bearers = () => calls.map(c => c.bearer);

let passed = 0;
const failures = [];
async function check(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 6).join('\n     ')}`); }
}

try {
    await check('local authority replaces the caller credential and fences placeholder API keys', async () => {
        reset({ local: T.A, accept: [T.A, T.cli] });
        const res = await send({ 'x-api-key': 'owned-local-placeholder' });
        const text = await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A]);
        assert.equal(calls[0].headers['x-api-key'], undefined);
        assert.deepEqual(calls[0].headers['anthropic-beta'].split(',').sort(), ['fixture-beta-2026', 'oauth-2025-04-20']);
        assert.equal(count(text, 'event: message_start'), 1);
    });

    await check('rotation 401 resends once with the next snapshot generation and streams one response', async () => {
        reset({ local: T.A, accept: [T.B], events: [[4000, () => setLocal(T.B)]] });
        const ledgerFile = path.join(temp, 'provider-usage-v1.jsonl');
        const ledgerLines = () => fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean) : [];
        const before = ledgerLines().length;
        const res = await send();
        const text = await res.text();
        assert.equal(res.status, 200, `client saw ${res.status}: ${text.slice(0, 160)}`);
        assert.deepEqual(bearers(), [T.A, T.B]);
        assert.equal(calls[0].raw, calls[1].raw, 'resend carries the identical body');
        assert.equal(count(text, 'event: message_start'), 1);
        assert.equal(count(text, 'event: message_stop'), 1);
        assert.ok(clock.t >= 4000 && clock.t < 15000, `virtual wait ${clock.t}ms`);
        const id = /"id":"(msg_fixture_\d+)"/.exec(text)?.[1];
        assert.equal(id, 'msg_fixture_2');
        const ledger = ledgerLines().slice(before).map(JSON.parse);
        assert.equal(ledger.filter(entry => entry.responseId === id).length, 1, 'usage recorded exactly once');
        assert.equal(ledger.length, 1, 'the rejected attempt records no usage');
        assert.equal(throughput.live.size, 0);
    });

    await check('concurrent requests caught by one rotation each recover with exactly one stream', async () => {
        reset({ local: T.A, accept: [T.B], events: [[4000, () => setLocal(T.B)]] });
        // Distinct sessions: the router admits one in-flight request per session and agent.
        const results = await Promise.all([0, 1, 2, 3].map(async i => { const res = await send({ 'x-claude-code-session-id': `9a7d1c52-6f0e-4b8e-9d1c-00000000010${i}` }); return { status: res.status, text: await res.text() }; }));
        for (const { status, text } of results) {
            assert.equal(status, 200);
            assert.equal(count(text, 'event: message_start'), 1);
            assert.equal(count(text, 'event: message_stop'), 1);
        }
        assert.equal(bearers().filter(b => b === T.A).length, 4);
        assert.equal(bearers().filter(b => b === T.B).length, 4);
        assert.equal(new Set(results.map(r => /"id":"(msg_fixture_\d+)"/.exec(r.text)?.[1])).size, 4);
        assert.equal(throughput.live.size, 0);
    });

    await check('a snapshot that already moved before the 401 is resent without waiting', async () => {
        reset({ local: T.A, accept: [T.B] });
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        const res = await send();
        await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A, T.B]);
        assert.equal(clock.sleeps, 0);
    });

    await check('two successive rotations while one request waits are both followed', async () => {
        reset({ local: T.A, accept: [T.C], events: [[2000, () => setLocal(T.B)], [5000, () => setLocal(T.C)]] });
        const res = await send();
        const text = await res.text();
        assert.equal(res.status, 200, `client saw ${res.status}`);
        assert.deepEqual(bearers(), [T.A, T.B, T.C]);
        assert.equal(count(text, 'event: message_start'), 1);
    });

    await check('a third 401 terminates: two resends at most, last rejection returned verbatim', async () => {
        reset({ local: T.A, accept: [], events: [[1000, () => setLocal(T.B)], [2000, () => setLocal(T.C)], [3000, () => setLocal(T.D)]] });
        const res = await send();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.deepEqual(bearers(), [T.A, T.B, T.C]);
        assert.equal(res.headers.get('x-fixture-rejection'), '3');
        assert.match(body, /fixture 3/);
    });

    await check('genuine 401 waits exactly the local bound, never tries the caller credential, and returns the original response', async () => {
        reset({ local: T.A, accept: [T.cli] });
        const res = await send();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.deepEqual(bearers(), [T.A]);
        assert.equal(res.headers.get('x-fixture-rejection'), '1');
        assert.equal(res.headers.get('request-id'), 'req_fixture_1');
        assert.equal(JSON.parse(body).error.message, 'OAuth token has been revoked (fixture 1)');
        assert.equal(clock.t, 15000);
        assert.equal(clock.sleeps, 60);
    });

    await check('reader host uses only the access view, waits past the local bound, and follows its rotation', async () => {
        reset({ host: AUTHORITY_ELSEWHERE, local: T.local, reader: T.A, accept: [T.B, T.local], events: [[20000, () => setReader(T.B)]] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A, T.B]);
        assert.ok(clock.t >= 20000 && clock.t < 30000, `virtual wait ${clock.t}ms`);
    });

    await check('reader genuine 401 is bounded at the reader limit', async () => {
        reset({ host: AUTHORITY_ELSEWHERE, local: T.local, reader: T.A, accept: [T.local, T.cli] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 401);
        assert.deepEqual(bearers(), [T.A]);
        assert.equal(clock.t, 30000);
    });

    await check('reader view carrying a refresh token fails closed before any upstream call', async () => {
        reset({ host: AUTHORITY_ELSEWHERE, reader: null, accept: [T.A, T.cli] });
        setReader(T.A, { refreshToken: 'fixture-refresh-must-not-travel' });
        const res = await send();
        await res.text();
        assert.equal(res.status, 502);
        assert.equal(calls.length, 0);
    });

    await check('missing local snapshot fails closed before any upstream call', async () => {
        reset({ local: null, accept: [T.cli] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 502);
        assert.equal(calls.length, 0);
    });

    await check('expired local snapshot fails closed before any upstream call', async () => {
        reset({ local: null, accept: [T.A, T.cli] });
        setLocal(T.A, { expiresAt: Date.now() - 1000 });
        const res = await send();
        await res.text();
        assert.equal(res.status, 502);
        assert.equal(calls.length, 0);
    });

    await check('a snapshot briefly missing or expired during the wait is skipped, not used or fallen back from', async () => {
        reset({ local: T.A, accept: [T.B, T.cli], events: [[1000, () => fs.rmSync(localView)], [2000, () => setLocal(T.D, { expiresAt: Date.now() - 1 })], [3000, () => setLocal(T.B)]] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A, T.B]);
    });

    await check('without an authority the caller credential passes through and its 401 is not retried', async () => {
        reset({ accept: [] });
        fs.rmSync(authorityFile);
        const res = await send({ 'x-api-key': 'caller-own-key' });
        await res.text();
        assert.equal(res.status, 401);
        assert.deepEqual(bearers(), [T.cli]);
        assert.equal(calls[0].headers['x-api-key'], 'caller-own-key');
        assert.equal(clock.sleeps, 0);
    });

    await check('non-401 statuses are never resent', async () => {
        reset({ local: T.A, accept: [T.A, T.B] });
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        statusFor = bearer => bearer === T.A ? 429 : 0;
        const res = await send();
        await res.text();
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '17');
        assert.deepEqual(bearers(), [T.A]);
    });

    await check('an over-bound 401 body passes through intact and is not resent', async () => {
        reset({ local: T.A, accept: [T.B] });
        rejectionBody = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x'.repeat(70 * 1024) } });
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        const res = await send();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.equal(body, rejectionBody);
        assert.deepEqual(bearers(), [T.A]);
    });

    await check('client disconnect during the wait ends recovery without another upstream call', async () => {
        reset({ local: T.A, accept: [T.B] });
        let release;
        clock.gate = { promise: new Promise(r => { release = r; }) };
        const entered = new Promise(resolve => {
            const prior = authority.credentialClock?.sleep;
            if (!prior) return;
            authority.credentialClock.sleep = ms => { authority.credentialClock.sleep = prior; resolve(true); return prior(ms); };
        });
        const closed = new Promise(resolve => server.once('request', (_req, res) => res.once('close', resolve)));
        const ac = new AbortController();
        const pending = send({}, REQUEST, '/v1/messages', ac.signal).then(res => res.text()).catch(error => error);
        // Without a rotation wait the 401 returns at once; settle it either way
        // so a failure here cannot hold the session's admission slot.
        const waited = await Promise.race([entered, pending.then(() => false)]);
        ac.abort();
        await pending;
        await closed;
        // A new generation is available before the waiter wakes; it must
        // still not be sent for a client that has gone.
        setLocal(T.B);
        release();
        assert.equal(waited, true, 'router never entered the rotation wait');
        // The router resolves gone() on its next poll; let that settle.
        for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
        assert.deepEqual(bearers(), [T.A]);
        assert.equal(throughput.live.size, 0, 'no throughput sample left live');
    });

    await check('a 401 that is not authentication_error is relayed without resend', async () => {
        reset({ local: T.A, accept: [T.B] });
        rejectionType = 'permission_error';
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        const res = await send();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.equal(JSON.parse(body).error.type, 'permission_error');
        assert.deepEqual(bearers(), [T.A]);
    });

    await check('a 401 body that stalls past the hold bound is relayed intact without resend', async () => {
        reset({ local: T.A, accept: [T.B] });
        const written = deferred(), release = deferred();
        stall = { written: written.resolve, release: release.promise };
        clock.holdGate = deferred();
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        const pending = send();
        await written.promise;
        clock.holdGate.resolve();
        const res = await pending;
        release.resolve();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.equal(JSON.parse(body).error.message, 'OAuth token has been revoked (fixture 1)');
        assert.deepEqual(bearers(), [T.A]);
    });

    await check('authority removed during the wait ends recovery without falling back to the caller credential', async () => {
        reset({ local: T.A, accept: [T.cli, T.B], events: [[1000, () => fs.rmSync(authorityFile)], [2000, () => setLocal(T.B)]] });
        const res = await send();
        const body = await res.text();
        assert.equal(res.status, 401);
        assert.equal(JSON.parse(body).request_id, 'req_fixture_1');
        assert.deepEqual(bearers(), [T.A]);
        assert.ok(clock.t < 15000);
    });

    await check('authority re-pointed during the wait ends recovery; the new source is not adopted mid-request', async () => {
        const other = path.join(temp, 'other-claude-view.json');
        fs.writeFileSync(other, JSON.stringify(claudeView(LOCAL, T.B)));
        reset({ local: T.A, accept: [T.B], events: [[1000, () => fs.writeFileSync(authorityFile, JSON.stringify({ version: 1, authorityHost: LOCAL, viewFile: readerView, claudeViewFile: other }))]] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 401);
        assert.deepEqual(bearers(), [T.A]);
    });

    await check('an unreadable authority file during the wait is transient', async () => {
        reset({ local: T.A, accept: [T.B], events: [[1000, () => fs.writeFileSync(authorityFile, '{ half-written')], [2000, () => writeAuthority(LOCAL)], [3000, () => setLocal(T.B)]] });
        const res = await send();
        await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A, T.B]);
    });

    await check('count_tokens shares the passthrough recovery', async () => {
        reset({ local: T.A, accept: [T.B], events: [[3000, () => setLocal(T.B)]] });
        const res = await send({}, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'count' }] }, '/v1/messages/count_tokens');
        await res.text();
        assert.equal(res.status, 200);
        assert.deepEqual(bearers(), [T.A, T.B]);
    });

    await check('/v1/models follows an already-moved snapshot but never extends its metadata bound', async () => {
        reset({ local: T.A, accept: [T.B] });
        onRequest = bearer => { if (bearer === T.A) setLocal(T.B); };
        let res = await fetch(endpoint + '/v1/models', { headers: { authorization: `Bearer ${T.cli}` } });
        let list = await res.json();
        assert.equal(res.status, 200);
        assert.ok(list.data.some(m => m.id === 'fixture-upstream-model'));
        assert.deepEqual(bearers(), [T.A, T.B]);
        reset({ local: T.A, accept: [T.B], events: [[1000, () => setLocal(T.B)]] });
        res = await fetch(endpoint + '/v1/models', { headers: { authorization: `Bearer ${T.cli}` } });
        list = await res.json();
        assert.equal(res.status, 200);
        assert.equal(list.data.some(m => m.id === 'fixture-upstream-model'), false);
        assert.deepEqual(bearers(), [T.A]);
        assert.equal(clock.sleeps, 0);
    });

    await check('router diagnostics never contain a credential', async () => {
        const log = fs.readFileSync(path.join(temp, 'bridge.log'), 'utf8');
        for (const value of Object.values(T)) assert.equal(log.includes(value), false);
        assert.equal(log.includes('fixture-refresh-must-not-travel'), false);
    });
} finally {
    server.close(); upstream.close();
    server.closeAllConnections?.(); upstream.closeAllConnections?.();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(' | ')); process.exitCode = 1; }
