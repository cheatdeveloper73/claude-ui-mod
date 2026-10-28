// Real router, local fake upstreams, synthetic credentials. No external inference.
//
// The Stop-hook goal evaluator is a tool-less Messages request. The native client
// treats an HTTP error, an unreadable reply or a schema mismatch as a skipped hook,
// so a bad evaluator reply ends the goal silently. The router must instead answer
// with an explicit {"ok":false} verdict -- and must leave every valid verdict and
// every non-evaluator request exactly as it was.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-goal-guard-test-'));
const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.test';
const auth = path.join(temp, 'auth.json');
fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: token, account_id: 'test-only', refresh_token: 'test' }, last_refresh: new Date().toISOString() }));

const SYSTEM_PREFIX = 'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.';
const USER_PREFIX = 'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ';
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, impossible: { type: 'boolean' } }, required: ['ok', 'reason'], additionalProperties: false };

// ------------------------------------------------------------ fake upstream
const calls = [];
const state = { mode: 'valid-false', openai: 'verdict', anthropic: 'verdict' };
const upstreamClosed = [];

function messageEvents(text, extra = {}) {
    const msg = { id: 'msg_stub_fixture', type: 'message', role: 'assistant', model: 'stub-compat-1', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
    return { msg, events: [
        { type: 'message_start', message: { ...msg, content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
    ], ...extra };
}
const frames = (events) => events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');

function stubReply(req, res, body) {
    const mode = state.mode;
    res.on('close', () => upstreamClosed.push(mode));
    if (mode === 'hang') { res.writeHead(200, { 'content-type': body.stream ? 'text/event-stream' : 'application/json' }); res.flushHeaders(); return; }
    if (mode === 'http502' || mode === 'http500' || mode === 'http429') {
        const status = Number(mode.slice(4));
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end('{"type":"error","error":{"type":"api_error","message":"fixture upstream failure SECRET-PROVIDER-DETAIL"}}'); return;
    }
    if (mode === 'prompt-too-long') { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}'); return; }
    const verdicts = {
        'valid-true': { ok: true, reason: 'Fixture proof verified.' },
        'valid-false': { ok: false, reason: 'Fixture proof missing.' },
        'valid-impossible': { ok: false, impossible: true, reason: 'Cannot be satisfied.' },
    };
    let text = verdicts[mode] ? JSON.stringify(verdicts[mode]) : null;
    let { msg, events } = messageEvents(text ?? '');
    switch (mode) {
        case 'malformed-text': text = 'not a JSON verdict'; break;
        case 'fenced': text = '```json\n{"ok":true,"reason":"fenced"}\n```'; break;
        case 'extra-key': text = '{"ok":true,"reason":"x","confidence":1}'; break;
        case 'wrong-type': text = '{"ok":"true","reason":"x"}'; break;
        case 'missing-reason': text = '{"ok":true}'; break;
        case 'empty-text': text = '  '; break;
        case 'huge': text = JSON.stringify({ ok: true, reason: 'x'.repeat(1300000) }); break;
        default: break;
    }
    if (text !== null && !verdicts[mode]) ({ msg, events } = messageEvents(text));
    if (mode === 'tool-use') {
        msg.content = [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }];
        events = [events[0], { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }, { type: 'content_block_stop', index: 0 }, events[4], events[5]];
    }
    if (mode === 'thinking-only') {
        msg.content = [{ type: 'thinking', thinking: 'hmm', signature: 's' }];
        events = [events[0], { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }, { type: 'content_block_stop', index: 0 }, events[4], events[5]];
    }
    if (mode === 'error-event') events = [events[0], events[1], { type: 'error', error: { type: 'overloaded_error', message: 'fixture overloaded' } }];
    if (['missing-block-stop', 'missing-message-delta', 'duplicate-start', 'delta-after-close'].includes(mode))
    {
        ({ msg, events } = messageEvents('{"ok":true,"reason":"Fixture proof verified."}'));
        if (mode === 'missing-block-stop') events = events.filter(e => e.type !== 'content_block_stop');
        if (mode === 'missing-message-delta') events = events.filter(e => e.type !== 'message_delta');
        if (mode === 'duplicate-start') events.splice(1, 0, events[0]);
        if (mode === 'delta-after-close') events.splice(4, 0, events[2]);
    }
    if (mode === 'no-stop') events = events.slice(0, 5);
    if (mode === 'cut-frame') {
        const full = frames(events.slice(0, 3));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(full + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_d'); return;
    }
    if (mode === 'cut-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(msg).slice(0, 40)); return; }
    if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames(events)); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(msg));
}

const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let body = {}; try { body = JSON.parse(raw); } catch { /* not JSON */ }
        calls.push({ path: req.url, body });
        if (req.url === '/stub/messages') { stubReply(req, res, body); return; }
        if (req.url.startsWith('/anthropic')) {
            if (state.anthropic === 'http429') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '19' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}'); return; }
            if (state.anthropic === 'passthrough') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"passthrough":true}'); return; }
            const { msg, events } = messageEvents('{"ok":true,"reason":"native verdict"}');
            if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frames(events)); return; }
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(msg)); return;
        }
        if (req.url === '/responses') {
            res.setHeader('content-type', 'text/event-stream');
            const created = { type: 'response.created', response: { id: 'resp_goal', model: 'reported', usage: { input_tokens: 10, output_tokens: 0 } } };
            const verdict = '{"ok":false,"reason":"Fixture proof missing."}';
            const events = state.openai === 'truncated' ? [created]
                : state.openai === 'failed' ? [created, { type: 'response.failed', response: { error: { message: 'fixture stream failure' } } }]
                    : [created, { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
                        { type: 'response.output_text.delta', output_index: 0, delta: state.openai === 'prose' ? 'Looks fine to me.' : verdict },
                        { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
                        { type: 'response.completed', response: { id: 'resp_goal', model: 'reported', usage: { input_tokens: 10, output_tokens: 2 } } }];
            res.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('')); return;
        }
        res.writeHead(404); res.end();
    });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + upstream.address().port;
const catalogueFile = path.join(temp, 'catalogue.json');
const secretsFile = path.join(temp, 'provider-secrets.json');
fs.writeFileSync(catalogueFile, JSON.stringify([{ id: 'Stub-Compat-agent', name: 'Stub Compat Agent', efforts: [], provider: 'stub',
    backend: { protocol: 'anthropic-messages', baseUrl: base + '/stub', apiKeyHeader: 'x-api-key', secret: 'stub' } }]));
fs.writeFileSync(secretsFile, JSON.stringify({ stub: { apiKey: 'stub-test-key-one' } }));
const adapterDir = path.join(temp, 'no-adapters'); fs.mkdirSync(adapterDir, { recursive: true });
Object.assign(process.env, { MODEL_ROUTER_AUTHORITY_FILE: path.join(temp, 'no-credential-authority.json'), CODEX_AUTH_FILE: auth,
    CODEX_RESPONSES_URL: base + '/responses', MODEL_ROUTER_UPSTREAM: base + '/anthropic', MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp, MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: catalogueFile, MODEL_ROUTER_SECRETS_FILE: secretsFile });
delete process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS;
const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = 'http://127.0.0.1:' + server.address().port;

// ----------------------------------------------------------------- helpers
const failures = [];
let passed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.log('FAIL ' + name + '\n     ' + String(error.message).split('\n').slice(0, 4).join('\n     ')); }
}
const evaluator = (over = {}) => ({
    model: 'Stub-Compat-agent', max_tokens: 1024, stream: true, tools: [],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.284' }, { type: 'text', text: SYSTEM_PREFIX + '\n\nYour response must be a JSON object.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'transcript of the conversation' }] }, { role: 'user', content: [{ type: 'text', text: USER_PREFIX + 'Create fixture proof.' }] }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    ...over,
});
async function post(body, sid = '573cf3ba-87d3-4bd2-8f56-ea1b4446f72d', signal) {
    // A router that never answers must fail the check, not hang the suite.
    const bound = AbortSignal.timeout(8000);
    return fetch(endpoint + '/v1/messages?beta=true', { method: 'POST', signal: signal ? AbortSignal.any([signal, bound]) : bound, headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sid, 'x-api-key': 'client-key' }, body: JSON.stringify(body) });
}
function parseSseText(raw) {
    const events = raw.split(/\r?\n\r?\n/).map(f => f.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')).filter(Boolean).map(d => JSON.parse(d));
    return { events, text: events.filter(e => e.delta?.type === 'text_delta').map(e => e.delta.text).join('') };
}
// -> { status, headers, message events, verdict }
async function run(body, sid) {
    const res = await post(body, sid);
    const raw = await res.text();
    let text = null; let events = null; let id = null;
    if (res.status === 200 && body.stream) {
        const parsed = parseSseText(raw); events = parsed.events; text = parsed.text; id = events[0]?.message?.id;
        assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop');
    } else if (res.status === 200) { const m = JSON.parse(raw); text = m.content.map(b => b.text).join(''); id = m.id; }
    let verdict = null; try { verdict = JSON.parse(text); } catch { /* not a verdict */ }
    return { status: res.status, headers: res.headers, raw, text, verdict, id, events };
}
const guarded = (r, code) => { assert.equal(r.status, 200); assert.ok([].concat(code).includes(r.headers.get('x-cuimod-goal-guard')), 'guard code ' + r.headers.get('x-cuimod-goal-guard')); assert.equal(r.verdict.ok, false); assert.equal(typeof r.verdict.reason, 'string'); assert.ok(/unverified/.test(r.verdict.reason)); assert.ok(r.id.startsWith('msg_goalguard_')); assert.equal(r.verdict.impossible, undefined); assert.equal(r.raw.includes('SECRET-PROVIDER-DETAIL'), false); };
const untouched = (r, verdict) => { assert.equal(r.status, 200); assert.equal(r.headers.get('x-cuimod-goal-guard'), null); assert.deepEqual(r.verdict, verdict); assert.equal(r.id, 'msg_stub_fixture'); };

const VERDICTS = { 'valid-true': { ok: true, reason: 'Fixture proof verified.' }, 'valid-false': { ok: false, reason: 'Fixture proof missing.' }, 'valid-impossible': { ok: false, impossible: true, reason: 'Cannot be satisfied.' } };

try {
    // ---- valid verdicts are the provider's own bytes, accounting stays upstream's
    for (const stream of [true, false]) for (const [mode, verdict] of Object.entries(VERDICTS)) {
        await check(`${mode} ${stream ? 'SSE' : 'unary'} verdict passes through unchanged`, async () => {
            state.mode = mode; const before = calls.length;
            untouched(await run(evaluator({ stream })), verdict);
            assert.equal(calls.length - before, 1);
        });
    }
    await check('valid verdict bytes equal the same arm answering a non-evaluator request', async () => {
        state.mode = 'valid-false';
        const evalRes = await run(evaluator());
        const plain = await post({ model: 'Stub-Compat-agent', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'plain' }] });
        assert.equal(evalRes.raw, await plain.text());
    });

    // ---- failure paths become explicit unverified verdicts
    for (const stream of [true, false]) {
        const shape = stream ? 'SSE' : 'unary';
        for (const [mode, code] of [['http502', 'http-error'], ['http500', 'http-error'], ['http429', 'http-error']]) {
            await check(`${mode} ${shape} becomes an unverified verdict, not an HTTP error`, async () => {
                state.mode = mode; const before = calls.length;
                guarded(await run(evaluator({ stream })), code);
                assert.equal(calls.length - before, 1, 'no retry or replay');
            });
        }
        for (const [mode, code] of [['malformed-text', 'invalid-verdict'], ['fenced', 'invalid-verdict'], ['extra-key', 'invalid-verdict'], ['wrong-type', 'invalid-verdict'], ['missing-reason', 'invalid-verdict'], ['empty-text', 'non-text'], ['tool-use', 'non-text'], ['thinking-only', 'non-text']]) {
            await check(`${mode} ${shape} becomes an unverified verdict`, async () => { state.mode = mode; guarded(await run(evaluator({ stream })), code); });
        }
    }
    for (const [mode, stream, code] of [['no-stop', true, 'truncated'], ['cut-frame', true, 'truncated'], ['error-event', true, 'upstream-error'], ['cut-json', false, 'truncated']]) {
        await check(`${mode} output becomes an unverified verdict`, async () => { state.mode = mode; guarded(await run(evaluator({ stream })), code); });
    }
    for (const mode of ['missing-block-stop', 'missing-message-delta', 'duplicate-start', 'delta-after-close'])
        await check(`${mode} cannot pass a verdict the native stream reader would reject`, async () => {
            state.mode = mode;
            guarded(await run(evaluator()), ['malformed', 'truncated']);
        });
    await check('an oversized reply is bounded and replaced', async () => { state.mode = 'huge'; guarded(await run(evaluator()), 'oversize'); });
    await check('context overflow stays an error so the native halved-transcript retry still happens', async () => {
        state.mode = 'prompt-too-long'; const res = await post(evaluator()); assert.equal(res.status, 400); assert.equal(res.headers.get('x-cuimod-goal-guard'), null); assert.ok((await res.text()).includes('prompt is too long'));
    });

    await check('a failed native halved-transcript retry becomes an unverified verdict', async () => {
        state.mode = 'prompt-too-long';
        const sid = 'overflow-retry-fixture';
        const first = await post(evaluator(), sid);
        assert.equal(first.status, 400);
        await first.text();
        guarded(await run(evaluator(), sid), 'http-error');
    });

    // ---- every other request keeps its ordinary failure behaviour
    await check('an ordinary request still sees the upstream HTTP error', async () => {
        state.mode = 'http502';
        const res = await post({ model: 'Stub-Compat-agent', max_tokens: 10, stream: true, tools: [], messages: [{ role: 'user', content: 'plain' }] });
        assert.equal(res.status, 502); assert.equal(res.headers.get('retry-after'), '7'); assert.equal(res.headers.get('x-cuimod-goal-guard'), null);
        assert.ok((await res.text()).includes('SECRET-PROVIDER-DETAIL'));
    });
    const lookalikes = {
        'tools present': evaluator({ tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }] }),
        'other system prompt': evaluator({ system: 'You are evaluating a hook condition in Claude Code. Judge whether the user-provided condition is met.' }),
        'other final user text': evaluator({ messages: [{ role: 'user', content: 'Condition: Create fixture proof.' }] }),
        'no output format': evaluator({ output_config: undefined }),
        'other schema': evaluator({ output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { allow: { type: 'boolean' } }, required: ['allow'] } } } }),
        'final message is assistant': evaluator({ messages: [{ role: 'user', content: USER_PREFIX + 'x' }, { role: 'assistant', content: 'y' }] }),
    };
    for (const [name, body] of Object.entries(lookalikes)) {
        await check(`lookalike request (${name}) keeps its upstream HTTP error`, async () => {
            state.mode = 'http502'; const res = await post(body); assert.equal(res.status, 502); assert.equal(res.headers.get('x-cuimod-goal-guard'), null); await res.text();
        });
    }
    await check('count_tokens for an evaluator-shaped body is not guarded', async () => {
        state.mode = 'http502';
        const res = await fetch(endpoint + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(evaluator()) });
        assert.equal(res.headers.get('x-cuimod-goal-guard'), null); await res.text();
    });

    // ---- other arms: the guard is provider-neutral
    await check('OpenAI Responses arm: truncated upstream (HTTP 502) becomes an unverified verdict', async () => {
        state.openai = 'truncated'; guarded(await run(evaluator({ model: 'claude-gpt-5.6-sol[1m]' })), ['http-error', 'interrupted']);
    });
    await check('OpenAI Responses arm: response.failed becomes an unverified verdict', async () => {
        state.openai = 'failed'; guarded(await run(evaluator({ model: 'claude-gpt-5.6-sol[1m]', stream: false })), 'http-error');
    });
    await check('OpenAI Responses arm: prose instead of a verdict becomes an unverified verdict', async () => {
        state.openai = 'prose'; guarded(await run(evaluator({ model: 'claude-gpt-5.6-sol[1m]' })), 'invalid-verdict');
    });
    await check('OpenAI Responses arm: a valid verdict is preserved', async () => {
        state.openai = 'verdict'; const r = await run(evaluator({ model: 'claude-gpt-5.6-sol[1m]' }));
        assert.equal(r.status, 200); assert.equal(r.headers.get('x-cuimod-goal-guard'), null); assert.deepEqual(r.verdict, { ok: false, reason: 'Fixture proof missing.' });
    });
    await check('Anthropic passthrough arm: 429 and non-verdict bodies become unverified verdicts, a valid verdict passes', async () => {
        state.anthropic = 'http429'; guarded(await run(evaluator({ model: 'claude-sonnet-5' })), 'http-error');
        state.anthropic = 'passthrough'; guarded(await run(evaluator({ model: 'claude-sonnet-5', stream: false })), 'malformed');
        state.anthropic = 'verdict'; const r = await run(evaluator({ model: 'claude-sonnet-5' }));
        assert.deepEqual(r.verdict, { ok: true, reason: 'native verdict' }); assert.equal(r.headers.get('x-cuimod-goal-guard'), null);
    });

    // ---- deadline (real timer, short) and cancellation
    const settle = async (predicate, ms = 3000) => { const t = Date.now(); while (!predicate() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 25)); return predicate(); };
    for (const stream of [true, false]) {
        await check(`a hung upstream hits the deadline, answers ${stream ? 'SSE' : 'unary'}, and its upstream request is cancelled`, async () => {
            process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS = '300'; state.mode = 'hang';
            const closedBefore = upstreamClosed.length; const callsBefore = calls.length;
            try { guarded(await run(evaluator({ stream })), 'timeout'); } finally { delete process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS; }
            assert.ok(await settle(() => upstreamClosed.length > closedBefore), 'upstream work was terminated');
            assert.equal(calls.length - callsBefore, 1, 'no retry');
        });
    }
    await check('a client that disconnects mid-evaluation cancels upstream work and leaves the router healthy', async () => {
        process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS = '20000'; state.mode = 'hang';
        const closedBefore = upstreamClosed.length; const callsBefore = calls.length;
        const controller = new AbortController();
        const pending = post(evaluator(), '0f0f0f0f-1111-4222-8333-444444444444', controller.signal).catch(e => e.name);
        assert.ok(await settle(() => calls.length > callsBefore)); controller.abort();
        assert.equal(await pending, 'AbortError');
        assert.ok(await settle(() => upstreamClosed.length > closedBefore), 'upstream work was terminated');
        delete process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS;
        assert.equal((await fetch(endpoint + '/healthz')).status, 200);
        state.mode = 'valid-true'; untouched(await run(evaluator(), '0f0f0f0f-1111-4222-8333-444444444444'), VERDICTS['valid-true']);
    });
    await check('the failure is logged without prompt text or provider detail', async () => {
        const log = fs.readFileSync(path.join(temp, 'bridge.log'), 'utf8');
        assert.ok(/goal-guard fallback code=http-error upstreamStatus=502 stream=true model=Stub-Compat-agent/.test(log));
        assert.equal(log.includes('SECRET-PROVIDER-DETAIL'), false); assert.equal(log.includes('Create fixture proof'), false); assert.equal(log.includes('stub-test-key'), false);
    });

    // ---- deterministic unit part with an injected clock
    let guard = null;
    try { guard = await import(pathToFileURL(path.join(root, 'goal-guard.mjs'))); } catch (error) { failures.push('goal-guard.mjs import: ' + error.message); console.log('FAIL goal-guard.mjs import: ' + error.message); }
    if (guard) {
        const fakeRes = () => {
            const res = new EventEmitter(); res.log = []; res.headersSent = false; res.writableEnded = false; res.destroyed = false; res.statusCode = 200;
            res.setHeader = (n, v) => res.log.push(['setHeader', n, v]);
            res.writeHead = (...a) => { res.headersSent = true; res.log.push(['writeHead', ...a]); return res; };
            res.write = (c) => { res.log.push(['write', Buffer.from(c).toString()]); return true; };
            res.end = (c) => { if (c !== undefined) res.log.push(['end', Buffer.from(c).toString()]); else res.log.push(['end']); res.writableEnded = true; res.emit('finish'); res.emit('close'); };
            res.destroy = () => { res.destroyed = true; res.log.push(['destroy']); res.emit('close'); };
            return res;
        };
        const clock = () => { const timers = new Map(); let next = 1; return { timers, setTimer: (fn, ms) => { timers.set(next, { fn, ms }); return next++; }, clearTimer: (id) => timers.delete(id), fire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } } }; };
        const verdictFrames = (text) => frames(messageEvents(text).events);
        const textOf = (res) => { const out = res.log.find(e => e[0] === 'end')[1]; return parseSseText(out).text; };

        await check('unit: deadline fires on the injected clock, answers once, and later upstream output is dropped', () => {
            const c = clock(); const real = fakeRes();
            const res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, deadlineMs: 20000, log: () => {} });
            assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].ms, 20000);
            res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message_start\n');
            assert.equal(real.log.length, 0, 'nothing reaches the client while holding');
            assert.equal(res.headersSent, true); assert.equal(res.writableEnded, false);
            c.fire();
            assert.deepEqual(real.log.map(e => e[0]), ['writeHead', 'end']);
            assert.equal(real.log[0][2]['X-Cuimod-Goal-Guard'], 'timeout'); assert.equal(JSON.parse(textOf(real)).ok, false);
            assert.equal(res.writableEnded, true);
            res.write('late'); res.end('late'); res.destroy();
            assert.deepEqual(real.log.map(e => e[0]), ['writeHead', 'end'], 'a late upstream finish writes nothing more');
            assert.equal(c.timers.size, 0);
        });
        await check('unit: real response close disposes the timer and writes nothing', () => {
            const c = clock(); const real = fakeRes();
            const res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, log: () => {} });
            res.writeHead(200); real.emit('close');
            assert.equal(c.timers.size, 0); res.end(verdictFrames('{"ok":true,"reason":"x"}'));
            assert.equal(real.log.length, 0);
        });
        await check('unit: a valid verdict replays headers, status and chunks and cancels the timer', () => {
            const c = clock(); const real = fakeRes();
            const res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, log: () => {} });
            res.setHeader('x-extra', '1'); res.writeHead(200, { 'content-type': 'text/event-stream' });
            const full = verdictFrames('{"ok":true,"reason":"x"}'); res.write(full.slice(0, 50)); res.end(full.slice(50));
            assert.deepEqual(real.log.map(e => e[0]), ['setHeader', 'writeHead', 'write', 'write', 'end']);
            assert.equal(real.log.filter(e => e[0] === 'write').map(e => e[1]).join(''), full); assert.equal(c.timers.size, 0);
        });
        await check('unit: destroy and over-budget output produce a verdict instead of dropping the stream', () => {
            const c = clock(); let real = fakeRes();
            let res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, log: () => {} });
            res.writeHead(200); res.write('event: message_start\n'); res.destroy(new Error('boom'));
            assert.equal(real.log[0][2]['X-Cuimod-Goal-Guard'], 'interrupted'); assert.equal(real.destroyed, false);
            real = fakeRes();
            res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, maxBytes: 16, log: () => {} });
            res.writeHead(200); assert.equal(res.write('x'.repeat(32)), true);
            assert.equal(real.log[0][2]['X-Cuimod-Goal-Guard'], 'oversize'); assert.equal(res.writableEnded, true);
        });
        await check('unit: passthrough proxies listeners and flags to the real response', () => {
            const real = fakeRes(); const c = clock();
            const res = guard.guardGoalEvaluator({}, real, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, log: () => {} });
            let closed = 0; res.once('close', () => closed++); real.emit('close'); assert.equal(closed, 1);
            const other = fakeRes(); const res2 = guard.guardGoalEvaluator({}, other, evaluator(), { setTimer: c.setTimer, clearTimer: c.clearTimer, log: () => {} });
            other.destroyed = true; assert.equal(res2.destroyed, true);
            res2.writeHead(502); res2.end('{}'); assert.equal(other.log.length, 0, 'a destroyed client is never written to');
        });
        await check('unit: only the exact native evaluator request is recognised', () => {
            assert.equal(guard.isGoalEvaluatorRequest(evaluator()), true);
            assert.equal(guard.isGoalEvaluatorRequest(evaluator({ tools: undefined })), true);
            assert.equal(guard.isGoalEvaluatorRequest(evaluator({ system: SYSTEM_PREFIX + '\n\nrest' })), true);
            assert.equal(guard.isGoalEvaluatorRequest(evaluator({ messages: [{ role: 'user', content: USER_PREFIX + 'x' }] })), true);
            for (const body of [null, [], {}, ...Object.values(lookalikes)]) assert.equal(guard.isGoalEvaluatorRequest(body), false);
            assert.equal(guard.isGoalEvaluatorRequest(evaluator({ system: 'Prefix. ' + SYSTEM_PREFIX })), false);
            assert.equal(guard.isGoalEvaluatorRequest(evaluator({ output_config: { format: { type: 'json_schema', schema: { ...SCHEMA, required: ['ok'] } } } })), false);
        });
    }
} finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
    fs.rmSync(temp, { recursive: true, force: true });
}
if (failures.length) { console.log(`${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log(`${passed} goal-guard checks passed; no external requests`);
