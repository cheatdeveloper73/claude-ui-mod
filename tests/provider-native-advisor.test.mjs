// Native Anthropic advisor tool (advisor_20260301) on the OpenAI arm.
// Real router, local mock upstreams only, synthetic credentials. No provider requests.
//
// Claude Code declares {type:'advisor_20260301',name:'advisor',model} and expects the
// server to run it: server_tool_use(name advisor) + advisor_tool_result in the SAME
// assistant message, then the lead model continuing. Before this arm existed the router
// turned the declaration into a plain function, so the lead's call surfaced to Claude
// Code as an ordinary tool_use that nothing could answer.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-native-advisor-test-'));
const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.test';
const auth = path.join(temp, 'auth.json');
fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: token, account_id: 'test-only', refresh_token: 'test' }, last_refresh: new Date().toISOString() }));
const FAKE_CLAUDE_CREDENTIAL = 'Bearer test-only-claude-credential';
const SESSION = '5c0f6d3a-6a39-4cb1-9a6e-0d1bd1d93a11';

// ---- mock upstreams ---------------------------------------------------------
const leadCalls = [];      // /responses requests that carry tools (the lead model)
const consultCalls = [];   // /responses requests for a GPT-model advisor (tool-less)
const claudeCalls = [];    // Anthropic-side requests (the advisor when it is a Claude model)
let modelsRequests = 0;
let idSeq = 0;   // unique ids: the usage ledger de-duplicates on provider+response id
const state = { lead: 'single', claude: 'ok', claudeHang: false, claudeClosed: 0, gptAdvise: 'GPT_ADVISE_TEXT' };

const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const usage = (input = 100, output = 10) => ({ input_tokens: input, output_tokens: output });
function reasoningEvents(oi, n)
{
    return [
        { type: 'response.output_item.added', output_index: oi, item: { type: 'reasoning', id: `rs_${n}` } },
        { type: 'response.reasoning_summary_text.delta', output_index: oi, delta: `thinking ${n}` },
        { type: 'response.output_item.done', output_index: oi, item: { type: 'reasoning', id: `rs_${n}`, encrypted_content: `enc-${n}` } },
    ];
}
function messageEvents(oi, text)
{
    return [
        { type: 'response.output_item.added', output_index: oi, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: oi, delta: text },
        { type: 'response.output_item.done', output_index: oi, item: { type: 'message', content: [{ type: 'output_text', text }] } },
    ];
}
function callEvents(oi, id, name, args, namespace)
{
    const item = { type: 'function_call', call_id: id, name, ...(namespace ? { namespace } : {}) };
    return [
        { type: 'response.output_item.added', output_index: oi, item },
        { type: 'response.function_call_arguments.delta', output_index: oi, delta: args },
        { type: 'response.output_item.done', output_index: oi, item: { ...item, arguments: args } },
    ];
}
const done = (id, u) => ({ type: 'response.completed', response: { id, model: 'gpt-fixture', usage: u } });
const created = id => ({ type: 'response.created', response: { id, model: 'gpt-fixture', usage: usage(1, 0) } });

function leadResponse(body)
{
    const advisorOutputs = (body.input || []).filter(item => item?.type === 'function_call_output' && String(item.call_id).startsWith('advisor_call'));
    const n = advisorOutputs.length;
    const hasAdvisor = (body.tools || []).some(tool => tool.name === 'advisor');
    const id = `resp_lead_${++idSeq}`;
    let events;
    if (state.lead === 'context-first' && !(body.input || []).some(item => item.call_id === 'context_call' && item.type === 'function_call_output'))
        events = [created(id), ...callEvents(0, 'context_call', 'read_item', '{"window_id":"fixture","item_id":"fixture"}', 'history'), done(id, usage())];
    else if (state.lead === 'user-function')
        events = [created(id), ...callEvents(0, 'user_call_1', 'advisor', '{"question":"a user tool"}'), done(id, usage())];
    else if (state.lead === 'mixed' && n === 0)
        events = [created(id), ...reasoningEvents(0, 1), ...callEvents(1, 'advisor_call_1', 'advisor', '{}'),
            ...callEvents(2, 'read_call_1', 'Read', '{"file_path":"x"}'), done(id, usage())];
    else if (state.lead === 'loop' && hasAdvisor)
        events = [created(id), ...reasoningEvents(0, n + 1), ...callEvents(1, `advisor_call_${n + 1}`, 'advisor', '{}'), done(id, usage())];
    else if (['single', 'context-first'].includes(state.lead) && n === 0)
        events = [created(id), ...reasoningEvents(0, 1), ...messageEvents(1, 'Before advice.'),
            ...callEvents(2, 'advisor_call_1', 'advisor', '{}'), done(id, usage(100, 12))];
    else
        events = [created(id), ...reasoningEvents(0, n + 1), ...messageEvents(1, 'FINAL_AFTER_ADVISOR'), done(id, usage(130, 7))];
    return events;
}

const upstream = http.createServer((req, res) =>
{
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () =>
    {
        const raw = Buffer.concat(chunks).toString();
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        if (req.url.startsWith('/models?'))
        {
            modelsRequests++;
            const token_budget = { enabled: false, use_history_notes_extension: false, reminder_threshold_tokens: 500, auto_compact_fallback_buffer_tokens: 2000,
                reminder_message_template: '{n_remaining}', guidance_message: 'notes', auto_compact_fallback_prompt: 'budget' };
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', max_context_window: 100000, effective_context_window_percent: 100, model_messages: { token_budget } },
                { slug: 'gpt-5.6-luna', max_context_window: 100000, effective_context_window_percent: 100, model_messages: { token_budget } }] }));
            return;
        }
        if (req.url.includes('/alpha/history/v2/read_item'))
        {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ text: 'CONTEXT_ONLY_EVIDENCE' }));
            return;
        }
        if (req.url === '/responses')
        {
            const consult = !body.tools && String(body.instructions || '').includes('You are the advisor');
            res.setHeader('content-type', 'text/event-stream');
            if (consult)
            {
                consultCalls.push({ body, headers: req.headers });
                const id = `resp_consult_${++idSeq}`;
                res.end([created(id), ...messageEvents(0, state.gptAdvise), done(id, usage(40, 5))].map(frame).join(''));
                return;
            }
            leadCalls.push({ body, headers: req.headers });
            res.end(leadResponse(body).map(frame).join(''));
            return;
        }
        if (req.url === '/anthropic/v1/messages' || req.url === '/anthropic/messages')
        {
            claudeCalls.push({ body, headers: req.headers });
            res.on('close', () => { if (!res.writableEnded) state.claudeClosed++; });
            if (state.claudeHang) return;
            if (state.claude === 'rate-limit')
            {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
                res.end('{"type":"error","error":{"type":"rate_limit_error","message":"advisor quota exhausted"}}');
                return;
            }
            if (state.claude === 'empty')
            {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ id: `msg_adv_${++idSeq}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 0 } }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: `msg_adv_${++idSeq}`, type: 'message', role: 'assistant', model: body.model,
                content: [{ type: 'text', text: 'ADVISE: split the module before editing.' }], stop_reason: 'end_turn',
                usage: { input_tokens: 321, output_tokens: 17, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 } }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + upstream.address().port;
const adapterDir = path.join(temp, 'no-adapters');
fs.mkdirSync(adapterDir, { recursive: true });
fs.writeFileSync(path.join(temp, 'catalogue.json'), '[]');
fs.writeFileSync(path.join(temp, 'provider-secrets.json'), '{}');
// A missing authority file keeps this suite off the live credential view; the only
// Claude credential in play is the synthetic one this test sends.
Object.assign(process.env, {
    MODEL_ROUTER_AUTHORITY_FILE: path.join(temp, 'no-credential-authority.json'),
    CODEX_AUTH_FILE: auth,
    CODEX_RESPONSES_URL: base + '/responses',
    MODEL_ROUTER_UPSTREAM: base + '/anthropic',
    MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'),
    MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'provider-secrets.json'),
    MODEL_ROUTER_ADVISOR_TIMEOUT_MS: '700',
});
const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = 'http://127.0.0.1:' + server.address().port;

// ---- helpers ----------------------------------------------------------------
const ADVISOR_TOOL = { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-8' };
const READ_TOOL = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
const SYSTEM = [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.260; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are the executor harness. EXECUTOR_PROMPT_MARKER' },
];
const baseBody = (extra = {}) => ({
    model: 'claude-gpt-5.6-sol[1m]', max_tokens: 2000, system: SYSTEM,
    messages: [{ role: 'user', content: 'review this migration plan' }],
    tools: [READ_TOOL, ADVISOR_TOOL], ...extra,
});
async function post(body, { signal, session = SESSION } = {})
{
    return fetch(endpoint + '/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session, 'x-claude-code-agent-id': 'lead-agent', authorization: FAKE_CLAUDE_CREDENTIAL, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
        body: JSON.stringify(body),
    });
}
function parseSse(text)
{
    return text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join(''))
        .filter(Boolean).map(data => JSON.parse(data));
}
// Accumulates blocks the way Claude Code does, so the replay test sends back exactly what a client stores.
function assemble(events)
{
    const blocks = [];
    for (const event of events)
    {
        if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block, ...(['tool_use', 'server_tool_use'].includes(event.content_block.type) ? { input: '' } : {}) };
        else if (event.type === 'content_block_delta')
        {
            const block = blocks[event.index];
            if (event.delta.type === 'text_delta') block.text += event.delta.text;
            else if (event.delta.type === 'input_json_delta') block.input += event.delta.partial_json;
            else if (event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking;
            else if (event.delta.type === 'signature_delta') block.signature = event.delta.signature;
        }
        else if (event.type === 'content_block_stop')
        {
            const block = blocks[event.index];
            if (['tool_use', 'server_tool_use'].includes(block.type)) block.input = block.input ? JSON.parse(block.input) : {};
        }
    }
    return blocks;
}
function reset(mode = 'single')
{
    leadCalls.length = 0; consultCalls.length = 0; claudeCalls.length = 0;
    Object.assign(state, { lead: mode, claude: 'ok', claudeHang: false, claudeClosed: 0, gptAdvise: 'GPT_ADVISE_TEXT' });
}
const advisorFunction = request => (request.body.tools || []).find(tool => tool.name === 'advisor');

const failures = [];
let passed = 0;
async function check(name, fn)
{
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.log('FAIL ' + name + '\n     ' + String(error?.message || error).split('\n').join('\n     ')); }
}

try
{
    // ------------------------------------------------------------------ streaming
    reset();
    const streamResponse = await post(baseBody({ stream: true }));
    const streamText = await streamResponse.text();
    const streamEvents = streamResponse.status === 200 ? parseSse(streamText) : [];
    const streamBlocks = assemble(streamEvents);

    await check('streaming: advisor runs router-side and emits native server_tool_use + advisor_tool_result', () =>
    {
        assert.equal(streamResponse.status, 200, streamText.slice(0, 300));
        const use = streamBlocks.find(block => block.type === 'server_tool_use');
        assert.ok(use, 'no server_tool_use block; blocks=' + JSON.stringify(streamBlocks.map(block => block?.type)));
        assert.equal(use.name, 'advisor');
        assert.equal(use.id, 'advisor_call_1');
        assert.deepEqual(use.input, {});
        const result = streamBlocks.find(block => block.type === 'advisor_tool_result');
        assert.ok(result, 'no advisor_tool_result block');
        assert.equal(result.tool_use_id, 'advisor_call_1');
        assert.deepEqual(result.content, { type: 'advisor_result', text: 'ADVISE: split the module before editing.', stop_reason: 'end_turn' });
        assert.ok(!streamBlocks.some(block => block.type === 'tool_use' && block.name === 'advisor'), 'advisor leaked to the client as an ordinary tool_use');
    });

    await check('streaming: the lead resumes inside the same Anthropic message', () =>
    {
        assert.equal(streamEvents.filter(event => event.type === 'message_start').length, 1);
        assert.equal(streamEvents.filter(event => event.type === 'message_stop').length, 1);
        assert.ok(!streamEvents.some(event => event.type === 'error'));
        const types = streamBlocks.map(block => block.type);
        assert.deepEqual(types, ['thinking', 'text', 'server_tool_use', 'advisor_tool_result', 'thinking', 'text']);
        assert.equal(streamBlocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
        assert.equal(streamEvents.find(event => event.type === 'message_delta').delta.stop_reason, 'end_turn');
        const starts = streamEvents.filter(event => event.type === 'content_block_start').map(event => event.index);
        const stops = streamEvents.filter(event => event.type === 'content_block_stop').map(event => event.index);
        assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
        assert.equal(new Set(starts).size, starts.length, 'block indices must stay unique for the whole message');
        assert.deepEqual(starts.slice().sort((a, b) => a - b), stops.slice().sort((a, b) => a - b));
        assert.equal(leadCalls.length, 2, 'lead should be called exactly twice');
    });

    await check('streaming: usage carries the advisor iteration for the client cost display', () =>
    {
        const usageBlock = streamEvents.find(event => event.type === 'message_delta').usage;
        const iteration = (usageBlock.iterations || []).find(entry => entry.type === 'advisor_message');
        assert.ok(iteration, 'no advisor_message iteration in ' + JSON.stringify(usageBlock));
        assert.equal(iteration.model, 'claude-opus-4-8');
        assert.equal(iteration.input_tokens, 321);
        assert.equal(iteration.output_tokens, 17);
        assert.equal(iteration.cache_read_input_tokens, 11);
        assert.equal(iteration.cache_creation_input_tokens, 3);
    });

    await check('lead request: advisor is a parameterless function; resume replays reasoning, call and feedback', () =>
    {
        const first = advisorFunction(leadCalls[0]);
        assert.ok(first, 'advisor function missing from the first lead request');
        assert.equal(first.type, 'function');
        assert.deepEqual(first.parameters.properties || {}, {});
        assert.ok(leadCalls[0].body.tools.some(tool => tool.name === 'Read'), 'ordinary tools must be untouched');
        const input = leadCalls[1]?.body.input || [];
        const kinds = input.map(item => item.type + (item.name ? ':' + item.name : ''));
        const callIndex = input.findIndex(item => item.type === 'function_call' && item.name === 'advisor');
        assert.ok(callIndex > 0, 'resume lost the advisor call; input=' + kinds.join(','));
        assert.equal(input[callIndex].call_id, 'advisor_call_1');
        assert.equal(input[callIndex].arguments, '{}');
        assert.equal(input[callIndex - 1].type, 'message', 'text preceding the call must stay in order');
        assert.equal(input[callIndex - 2].type, 'reasoning');
        assert.equal(input[callIndex - 2].encrypted_content, 'enc-1', 'reasoning payload must be replayed untouched');
        const output = input.find(item => item.type === 'function_call_output' && item.call_id === 'advisor_call_1');
        assert.ok(output, 'resume has no function_call_output for the advisor');
        assert.match(output.output, /ADVISE: split the module before editing\./);
    });

    await check('advisor request: configured model, no tools, whole conversation, exact session context, no leaked internals', () =>
    {
        assert.equal(claudeCalls.length, 1);
        const call = claudeCalls[0];
        assert.equal(call.body.model, 'claude-opus-4-8');
        assert.equal(call.body.tools, undefined, 'advisor must not recurse');
        assert.notEqual(call.body.stream, true);
        assert.ok(call.body.max_tokens > 0);
        assert.equal(call.body.messages.at(-1).role, 'user', 'a trailing assistant turn would be treated as a prefill');
        const flat = JSON.stringify(call.body);
        assert.match(flat, /review this migration plan/);
        assert.match(flat, /Before advice\./, 'the lead text already emitted in this message must be forwarded');
        assert.match(flat, /EXECUTOR_PROMPT_MARKER/);
        assert.ok(!flat.includes('enc-1') && !call.body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'thinking')), 'opaque reasoning must not reach the reviewer');
        assert.equal(call.headers['x-claude-code-session-id'], SESSION);
        assert.equal(call.headers.authorization, FAKE_CLAUDE_CREDENTIAL);
        assert.equal(call.headers['anthropic-beta'], 'oauth-2025-04-20');
        assert.notEqual(call.headers['x-claude-code-agent-id'], 'lead-agent', 'a distinct agent key is needed to pass in-flight admission');
        assert.ok(!Object.keys(call.headers).some(name => name.startsWith('x-cuimod-')), 'router-internal headers must not reach Anthropic');
    });

    // ------------------------------------------------------------------ replay
    await check('replay: the stored native blocks round-trip into function_call + output for the next turn', async () =>
    {
        reset();
        const assistant = { role: 'assistant', content: streamBlocks };
        const response = await post(baseBody({ stream: true, messages: [
            { role: 'user', content: 'review this migration plan' }, assistant, { role: 'user', content: 'thanks, now proceed' }] }));
        const text = await response.text();
        assert.equal(response.status, 200, text.slice(0, 200));
        assert.equal(claudeCalls.length, 0, 'replaying history must not consult the advisor again');
        assert.equal(leadCalls.length, 1);
        const input = leadCalls[0].body.input;
        const call = input.findIndex(item => item.type === 'function_call' && item.name === 'advisor');
        assert.ok(call > 0, 'advisor server_tool_use was dropped from replay');
        assert.equal(input[call].call_id, 'advisor_call_1');
        assert.equal(input[call].arguments, '{}');
        const output = input[call + 1];
        assert.equal(output?.type, 'function_call_output');
        assert.equal(output.call_id, 'advisor_call_1');
        assert.match(output.output, /ADVISE: split the module before editing\./);
        assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'enc-1'));
        assert.ok(input.some(item => item.type === 'reasoning' && item.encrypted_content === 'enc-2'));
    });

    await check('replay: an advisor result error is replayed as an error, never as feedback', async () =>
    {
        reset();
        const history = [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [
                { type: 'server_tool_use', id: 'advisor_call_9', name: 'advisor', input: {} },
                { type: 'advisor_tool_result', tool_use_id: 'advisor_call_9', content: { type: 'advisor_tool_result_error', error_code: 'overloaded' } },
                { type: 'text', text: 'continuing without it' }] },
            { role: 'user', content: 'ok' }];
        const response = await post(baseBody({ stream: true, messages: history }));
        await response.text();
        const input = leadCalls[0].body.input;
        const output = input.find(item => item.type === 'function_call_output' && item.call_id === 'advisor_call_9');
        assert.ok(output, 'error result was dropped from replay');
        assert.match(output.output, /overloaded/);
        assert.doesNotMatch(output.output, /ADVISE/);
    });

    // ------------------------------------------------------------------ unary
    await check('unary: the same lifecycle arrives as one assembled Message', async () =>
    {
        reset();
        const response = await post(baseBody({ stream: false }));
        const message = await response.json();
        assert.equal(response.status, 200, JSON.stringify(message).slice(0, 300));
        assert.deepEqual(message.content.map(block => block.type), ['thinking', 'text', 'server_tool_use', 'advisor_tool_result', 'thinking', 'text']);
        const use = message.content.find(block => block.type === 'server_tool_use');
        assert.equal(use.name, 'advisor');
        assert.deepEqual(use.input, {});
        const result = message.content.find(block => block.type === 'advisor_tool_result');
        assert.equal(result.tool_use_id, use.id);
        assert.equal(result.content.type, 'advisor_result');
        assert.equal(result.content.stop_reason, 'end_turn');
        assert.equal(message.content.at(-1).text, 'FINAL_AFTER_ADVISOR');
        assert.equal(message.stop_reason, 'end_turn');
        assert.equal(message.usage.iterations.find(entry => entry.type === 'advisor_message').output_tokens, 17);
        assert.equal(leadCalls.length, 2);
        assert.equal(claudeCalls.length, 1);
    });

    // ------------------------------------------------------------------ failures
    for (const stream of [true, false])
    {
        await check(`${stream ? 'streaming' : 'unary'}: advisor rate limit is a native error result, not fake feedback`, async () =>
        {
            reset();
            state.claude = 'rate-limit';
            const response = await post(baseBody({ stream }));
            const body = stream ? assemble(parseSse(await response.text())) : (await response.json()).content;
            const result = body.find(block => block.type === 'advisor_tool_result');
            assert.ok(result, 'no advisor_tool_result');
            assert.deepEqual(result.content, { type: 'advisor_tool_result_error', error_code: 'too_many_requests' });
            assert.equal(body.at(-1).text, 'FINAL_AFTER_ADVISOR', 'the lead must still finish its turn');
            const output = leadCalls[1].body.input.find(item => item.type === 'function_call_output' && item.call_id === 'advisor_call_1');
            assert.doesNotMatch(output.output, /ADVISE|split the module/);
            assert.match(output.output, /unavailable|too_many_requests/i);
        });
    }

    await check('an empty advisor answer is an error result, not a successful empty one', async () =>
    {
        reset();
        state.claude = 'empty';
        const result = assemble(parseSse(await (await post(baseBody({ stream: true }))).text())).find(block => block.type === 'advisor_tool_result');
        assert.equal(result.content.type, 'advisor_tool_result_error');
    });

    await check('a stalled advisor hits the finite deadline and the lead still answers', async () =>
    {
        reset();
        state.claudeHang = true;
        const blocks = assemble(parseSse(await (await post(baseBody({ stream: true }))).text()));
        const result = blocks.find(block => block.type === 'advisor_tool_result');
        assert.deepEqual(result?.content, { type: 'advisor_tool_result_error', error_code: 'execution_time_exceeded' });
        assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(state.claudeClosed, 1, 'the abandoned advisor request was not cancelled');
    });

    await check('client disconnect during a consultation cancels the advisor request and never resumes the lead', async () =>
    {
        reset();
        state.claudeHang = true;
        const controller = new AbortController();
        const response = await post(baseBody({ stream: true }), { signal: controller.signal });
        const reader = response.body.getReader();
        let seen = '';
        const decoder = new TextDecoder();
        // Read until the router is demonstrably waiting on the advisor.
        for (let i = 0; i < 40 && claudeCalls.length === 0; i++)
        {
            const chunk = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 25))]);
            if (chunk.value) seen += decoder.decode(chunk.value);
        }
        assert.equal(claudeCalls.length, 1, 'consultation never started');
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(state.claudeClosed, 1, 'advisor request was not cancelled with the downstream');
        assert.equal(leadCalls.length, 1, 'the lead must not resume for a client that is gone');
    });

    // ------------------------------------------------------------------ boundaries
    await check('an ordinary user function named advisor is untouched', async () =>
    {
        reset('user-function');
        const userTool = { name: 'advisor', description: 'a user tool', input_schema: { type: 'object', properties: { question: { type: 'string' } } } };
        const response = await post(baseBody({ stream: true, tools: [READ_TOOL, userTool] }));
        const events = parseSse(await response.text());
        const blocks = assemble(events);
        assert.equal(claudeCalls.length + consultCalls.length, 0, 'no consultation may run without the typed declaration');
        assert.ok(blocks.some(block => block.type === 'tool_use' && block.name === 'advisor' && block.input.question === 'a user tool'));
        assert.ok(!blocks.some(block => block.type === 'server_tool_use' || block.type === 'advisor_tool_result'));
        assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');
        const fn = advisorFunction(leadCalls[0]);
        assert.deepEqual(fn.parameters.properties, { question: { type: 'string' } }, 'the user schema must reach the model as written');
        assert.equal(fn.description, 'a user tool');
        assert.equal(leadCalls.length, 1);
    });

    await check('advisor consultations are bounded even when the lead keeps asking', async () =>
    {
        reset('loop');
        const blocks = assemble(parseSse(await (await post(baseBody({ stream: true }))).text()));
        assert.equal(claudeCalls.length, 3, 'consultations=' + claudeCalls.length);
        assert.equal(blocks.at(-1).type, 'text');
        assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
        assert.equal(leadCalls.length, 4, 'lead calls=' + leadCalls.length);
        assert.equal(advisorFunction(leadCalls.at(-1)), undefined, 'the advisor must be withdrawn once its budget is spent');
    });

    await check('advisor next to an ordinary tool call ends the turn as tool_use without resuming', async () =>
    {
        reset('mixed');
        const events = parseSse(await (await post(baseBody({ stream: true }))).text());
        const blocks = assemble(events);
        assert.ok(blocks.some(block => block.type === 'server_tool_use' && block.name === 'advisor'));
        assert.ok(blocks.some(block => block.type === 'advisor_tool_result' && block.content.type === 'advisor_result'));
        assert.ok(blocks.some(block => block.type === 'tool_use' && block.name === 'Read' && block.input.file_path === 'x'));
        assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');
        assert.equal(leadCalls.length, 1, 'an unanswered ordinary tool call must not be resumed past');
        assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
    });

    await check('a GPT advisor model is dispatched through the router as a tool-less subagent-lane request', async () =>
    {
        reset();
        const tool = { ...ADVISOR_TOOL, model: 'claude-gpt-5.6-luna[1m]' };
        const blocks = assemble(parseSse(await (await post(baseBody({ stream: true, tools: [READ_TOOL, tool] }))).text()));
        assert.equal(claudeCalls.length, 0, 'a GPT advisor must not be sent to Anthropic');
        assert.equal(consultCalls.length, 1);
        assert.equal(consultCalls[0].body.model, 'gpt-5.6-luna');
        assert.equal(consultCalls[0].body.tools, undefined);
        assert.match(JSON.stringify(consultCalls[0].body.input), /review this migration plan/);
        const result = blocks.find(block => block.type === 'advisor_tool_result');
        assert.equal(result.content.text, 'GPT_ADVISE_TEXT');
        assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
    });

    await check('with context management on, the lead still resumes and a GPT advisor never touches the lead window', async () =>
    {
        reset();
        fs.writeFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, JSON.stringify({ 'context-management': { enabled: true, notesTools: false, historyTools: false, windowReset: false, reminders: false } }));
        try
        {
            modelsRequests = 0;
            const tool = { ...ADVISOR_TOOL, model: 'claude-gpt-5.6-luna[1m]' };
            const blocks = assemble(parseSse(await (await post(baseBody({ stream: true, tools: [READ_TOOL, tool] }))).text()));
            assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
            assert.ok(blocks.some(block => block.type === 'advisor_tool_result' && block.content.type === 'advisor_result'));
            assert.equal(leadCalls.length, 2);
            assert.equal(consultCalls.length, 1);
            assert.equal(modelsRequests, 1, 'only the lead may prepare context management; the consultation is not the root lane');
            const unary = await (await post(baseBody({ stream: false, tools: [READ_TOOL, tool] }))).json();
            assert.equal(unary.content.at(-1).text, 'FINAL_AFTER_ADVISOR');
            assert.ok(unary.content.some(block => block.type === 'advisor_tool_result'));
        }
        finally { fs.rmSync(process.env.MODEL_ROUTER_SETTINGS_FILE, { force: true }); }
    });

    await check('withdrawing the advisor also clears a forced choice while other tools remain', async () =>
    {
        reset('loop');
        const blocks = assemble(parseSse(await (await post(baseBody({ stream: true, tool_choice: { type: 'tool', name: 'advisor' } }))).text()));
        assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
        assert.equal(advisorFunction(leadCalls.at(-1)), undefined);
        assert.equal(leadCalls.at(-1).body.tool_choice, 'auto');
        assert.ok(leadCalls.at(-1).body.tools.some(tool => tool.name === 'Read'));
    });

    await check('a compatible reviewer receives no router-internal consultation marker', async () =>
    {
        reset();
        fs.writeFileSync(process.env.MODEL_ROUTER_CATALOGUE_FILE, JSON.stringify([{
            id: 'stub-advisor', name: 'Stub Advisor', efforts: [], provider: 'stub',
            backend: { protocol: 'anthropic-messages', baseUrl: base + '/anthropic', apiKeyHeader: 'x-api-key', secret: 'stub' },
        }]));
        fs.writeFileSync(process.env.MODEL_ROUTER_SECRETS_FILE, JSON.stringify({ stub: { apiKey: 'synthetic-stub-key' } }));
        try
        {
            await (await post(baseBody({ stream: true, tools: [READ_TOOL, { ...ADVISOR_TOOL, model: 'stub-advisor' }] }))).text();
            assert.equal(claudeCalls.length, 1);
            assert.equal(claudeCalls[0].body.model, 'stub-advisor');
            assert.equal(claudeCalls[0].headers['x-cuimod-advisor-consult'], undefined);
        }
        finally
        {
            fs.writeFileSync(process.env.MODEL_ROUTER_CATALOGUE_FILE, '[]');
            fs.writeFileSync(process.env.MODEL_ROUTER_SECRETS_FILE, '{}');
        }
    });

    await check('the reviewer sees history-tool evidence fetched inside this message', async () =>
    {
        reset('context-first');
        fs.writeFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, JSON.stringify({ 'context-management': {
            enabled: true, notesTools: false, historyTools: true, windowReset: false, reminders: false,
        } }));
        try
        {
            const blocks = assemble(parseSse(await (await post(baseBody({ stream: true }))).text()));
            assert.equal(blocks.at(-1).text, 'FINAL_AFTER_ADVISOR');
            assert.equal(claudeCalls.length, 1);
            assert.match(JSON.stringify(claudeCalls[0].body.messages), /CONTEXT_ONLY_EVIDENCE/);
        }
        finally { fs.rmSync(process.env.MODEL_ROUTER_SETTINGS_FILE, { force: true }); }
    });

    await check('accounting: the lead rounds and the reviewer response are each recorded under the session', async () =>
    {
        reset();
        const session = '0a1b2c3d-1111-4222-8333-444455556666';
        await (await post(baseBody({ stream: true }), { session })).text();
        const snapshot = await (await fetch(`${endpoint}/usagez?session=${session}`)).json();
        const rows = snapshot.recent;
        assert.equal(rows.filter(row => row.provider === 'openai').length, 2, 'both lead rounds: ' + JSON.stringify(rows.map(r => r.provider + ':' + r.responseId)));
        const advisor = rows.filter(row => row.provider === 'claude');
        assert.equal(advisor.length, 1, 'the reviewer response');
        assert.equal(advisor[0].tokens.input ?? advisor[0].tokens.inputTokens ?? advisor[0].tokens.input_tokens, 321);
    });

    await check('no advisor declaration, no advisor behaviour (plain GPT turn)', async () =>
    {
        reset('single');
        const response = await post(baseBody({ stream: true, tools: [READ_TOOL] }));
        const blocks = assemble(parseSse(await response.text()));
        assert.equal(claudeCalls.length + consultCalls.length, 0);
        assert.ok(!blocks.some(block => block.type === 'server_tool_use'));
    });
}
finally
{
    server.closeAllConnections();
    await Promise.all([
        new Promise(resolve => server.close(resolve)),
        new Promise(resolve => { upstream.closeAllConnections?.(); upstream.close(resolve); }),
    ]);
    fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length)
{
    console.log('FAILED:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
    process.exit(1);
}
console.log('PASS native advisor lifecycle');
