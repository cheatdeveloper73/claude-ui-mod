import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-routing-'));
const calls = [];
const verdict = { ok: false, reason: 'Fixture proof is missing.' };
const prefix = 'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.';
const schema = { type: 'object', properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, impossible: { type: 'boolean' } }, required: ['ok', 'reason'], additionalProperties: false };
const frame = e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
let id = 0;
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        calls.push({ url: req.url, body });
        if (req.url.startsWith('/models?')) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ models: ['gpt-5.6-sol', 'gpt-5.6-luna'].map(slug => ({ slug, max_context_window: 1000000, effective_context_window_percent: 100, model_messages: { token_budget: { enabled: false } } })) }));
            return;
        }
        if (req.url === '/stub/messages') {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end('{"type":"error","error":{"type":"api_error","message":"fixture helper unavailable"}}');
            return;
        }
        if (req.url.startsWith('/anthropic')) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ id: 'msg_claude', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'working' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
            return;
        }
        if (req.url === '/responses') {
            const responseId = 'resp_goal_' + ++id;
            const text = body.instructions?.includes(prefix) ? JSON.stringify(verdict) : 'working';
            const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
            const events = [{ type: 'response.created', response: { id: responseId, model: body.model } },
                { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
                { type: 'response.output_text.delta', output_index: 0, delta: text },
                { type: 'response.output_item.done', output_index: 0, item },
                { type: 'response.completed', response: { id: responseId, model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } } }];
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(events.map(frame).join(''));
            return;
        }
        res.writeHead(404); res.end();
    });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + upstream.address().port;
const file = (name, value) => { const p = path.join(temp, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
const auth = file('auth.json', { tokens: { access_token: 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.fixture', account_id: 'fixture' } });
const adapters = path.join(temp, 'adapters'); fs.mkdirSync(adapters);
fs.writeFileSync(path.join(temp, 'provider-throughput-v1.jsonl'), JSON.stringify({ version: 1, provider: 'openai', responseId: 'seed', sessionId: 'cold-session', requestedModel: 'claude-gpt-5.6-sol[1m]', subagent: false, completedAt: new Date().toISOString() }) + '\n');
Object.assign(process.env, {
    MODEL_ROUTER_STATE_DIR: temp, MODEL_ROUTER_AUTHORITY_FILE: path.join(temp, 'no-authority'),
    MODEL_ROUTER_SETTINGS_FILE: file('settings.json', { 'context-management': { enabled: true, historyTools: true, notesTools: true, windowReset: true } }),
    MODEL_ROUTER_CATALOGUE_FILE: file('catalogue.json', [{ id: 'stub-helper', name: 'Stub', provider: 'stub', backend: { protocol: 'anthropic-messages', baseUrl: base + '/stub', secret: 'stub', apiKeyHeader: 'x-api-key' } }]),
    MODEL_ROUTER_SECRETS_FILE: file('secrets.json', { stub: { apiKey: 'fixture-key' } }),
    MODEL_ROUTER_ADAPTER_DIR: adapters, MODEL_ROUTER_UPSTREAM: base + '/anthropic', CODEX_RESPONSES_URL: base + '/responses', CODEX_AUTH_FILE: auth,
});
const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port;
const post = (body, session, agent = 'root') => fetch(endpoint + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture', 'x-claude-code-session-id': session, 'x-claude-code-agent-id': agent }, body: JSON.stringify({ max_tokens: 1024, stream: false, ...body }) });
const evaluator = () => ({ model: 'stub-helper', tools: [], system: prefix, messages: [{ role: 'user', content: 'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: Fixture proof exists.' }], output_config: { format: { type: 'json_schema', schema } } });
const main = (model, sub = false) => ({ model, system: 'x-anthropic-billing-header: cc_is_subagent=' + sub, tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'work' }] });
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); } }
async function realVerdict(session, model, agent) {
    const before = calls.length;
    const response = await post(evaluator(), session, agent);
    const body = await response.json();
    assert.equal(response.headers.get('x-cuimod-goal-guard'), null, 'a guard fallback is not a successful evaluation');
    assert.deepEqual(JSON.parse(body.content.filter(b => b.type === 'text').map(b => b.text).join('')), verdict);
    const sent = calls.slice(before);
    assert.equal(sent.length, 1, 'no helper or root context-management requests');
    assert.equal(sent[0].url, '/responses');
    assert.equal(sent[0].body.model, model);
    assert.equal(sent[0].body.tools, undefined);
    assert.deepEqual(sent[0].body.text?.format, { type: 'json_schema', name: 'response', strict: false, schema });
}
try {
    await check('cold worker recovers the actual main model and obtains a real structured verdict', () => realVerdict('cold-session', 'gpt-5.6-sol'));
    await check('live main model governs its evaluator without changing the main context lane', async () => {
        await (await post(main('claude-gpt-5.6-luna[1m]'), 'live-session')).text();
        await realVerdict('live-session', 'gpt-5.6-luna');
    });
    await check('subagent evaluator follows only that subagent model', async () => {
        await (await post(main('claude-gpt-5.6-luna[1m]', true), 'live-session', 'worker')).text();
        await realVerdict('live-session', 'gpt-5.6-luna', 'worker');
    });
    await check('ordinary helper calls retain their provider and error', async () => {
        const r = await post({ model: 'stub-helper', messages: [{ role: 'user', content: 'helper task' }] }, 'live-session');
        assert.equal(r.status, 502); await r.text();
    });
    await check('native Claude model changes cannot inherit a stale OpenAI model', async () => {
        await (await post(main('claude-sonnet-5-5'), 'live-session')).text();
        const r = await post(evaluator(), 'live-session');
        assert.equal(r.headers.get('x-cuimod-goal-guard'), 'http-error'); await r.text();
        assert.equal(calls.at(-1).url, '/stub/messages');
    });
    await check('an unassociated goal never invents an evaluator model', async () => {
        const r = await post(evaluator(), 'unknown-session');
        assert.equal(r.headers.get('x-cuimod-goal-guard'), 'http-error'); await r.text();
    });
} finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log('goal routing failures: ' + failed);
process.exitCode = failed ? 1 : 0;
