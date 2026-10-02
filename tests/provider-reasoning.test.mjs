import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anthropicUsage, buildResponsesRequest, CODEX_CLIENT_VERSION, collectAnthropicMessage, OPENAI_MODELS, openAIRawUsage, parseOpenAIModel, ResponsesToAnthropic, sseParser, toResponsesInput } from '../router/openai.mjs';
import { readProviderSettings } from '../router/settings.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-reasoning-'));
const file = path.join(temp, 'settings.json');
process.env.MODEL_ROUTER_SETTINGS_FILE = file;
const write = values => fs.writeFileSync(file, JSON.stringify({ 'provider-picker': values }));
after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(temp); });
const body = { model: 'claude-gpt-5.6-sol[1m]', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'test' }] };

test('GPT-6 Sol and Luna use the verified catalogue contract', () => {
    assert.equal(CODEX_CLIENT_VERSION, '0.159.0');
    assert.deepEqual(OPENAI_MODELS.slice(0, 4).map(model => model.id), [
        'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
    ]);
    const next = OPENAI_MODELS.find(entry => entry.id === 'gpt-6.1-sol');
    assert.deepEqual(next.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(next.defaultEffort, 'low');
    assert.equal(next.context, 1050000);
    assert.deepEqual(parseOpenAIModel('claude-gpt-6.1-sol[1m]:max'), {
        id: 'gpt-6.1-sol', effort: 'max', known: true, rejectedEffort: null,
    });
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
        const model = OPENAI_MODELS.find(entry => entry.id === id);
        assert.deepEqual(model.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
        assert.equal(model.defaultEffort, 'medium');
        assert.equal(model.context, 1050000);
        assert.equal(model.maxOutput, 128000);
        assert.deepEqual(parseOpenAIModel(`claude-${id}[1m]:max`), {
            id, effort: 'max', known: true, rejectedEffort: null,
        });
    }
    assert.deepEqual(parseOpenAIModel('claude-gpt-6-sol[1m]:ultra'), {
        id: 'gpt-6-sol', effort: 'medium', known: true, rejectedEffort: 'ultra',
    });
});

test('summary settings change per request without changing enabled effort or replay', () => {
    write({ reasoningSummary: 'auto' });
    assert.equal(buildResponsesRequest(body).req.reasoning.summary, 'auto');
    write({ reasoningSummary: 'detailed' });
    assert.equal(buildResponsesRequest(body).req.reasoning.summary, 'detailed');
    write({ reasoningSummary: 'off' });
    const req = buildResponsesRequest(body).req;
    assert.equal(req.reasoning.summary, undefined);
    assert.equal(req.reasoning.effort, 'high');
    assert.equal(req.reasoning.context, 'all_turns');
    assert.deepEqual(req.include, ['reasoning.encrypted_content']);
    write({ reasoningEnabled: 'broken', reasoningSummary: 'raw', showReasoningText: 'yes' });
    assert.equal(readProviderSettings().reasoningEnabled, true);
    assert.equal(readProviderSettings().reasoningSummary, 'auto');
    assert.equal(readProviderSettings().showReasoningText, false);
});

test('Claude Code trailing system context stays developer-owned', () => {
    const input = toResponsesInput([
        { role: 'user', content: 'the actual request' },
        { role: 'system', content: [{ type: 'text', text: 'project and harness context' }] },
    ]);
    assert.deepEqual(input, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the actual request' }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'project and harness context' }] },
    ]);
});

test('reasoning off uses native none and omits summary and replay requests', () => {
    write({ reasoningEnabled: false, reasoningSummary: 'detailed', showReasoningText: true });
    const built = buildResponsesRequest(body);
    assert.deepEqual(built.req.reasoning, { effort: 'none' });
    assert.equal(built.req.include, undefined);
    assert.equal(built.effort, 'none');
    assert.equal(readProviderSettings().showReasoningText, true);
});

function events(extra = true) {
    return [
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture' } },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Provider summary.' },
        ...(extra ? [
            { type: 'response.reasoning_text.delta', output_index: 0, delta: 'Additional ' },
            { type: 'response.reasoning_text.delta', output_index: 0, delta: 'provider text.' },
            { type: 'response.reasoning_text.done', output_index: 0, text: 'Additional provider text.' },
        ] : []),
        { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-replay-fixture' } },
        { type: 'response.completed', response: { usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 2 },
        } } },
    ];
}

function stream(options, input = events()) {
    const output = [];
    const parse = sseParser(e => output.push(e));
    const translator = new ResponsesToAnthropic(body.model, parse, options);
    input.forEach(e => translator.handle(e));
    return output;
}

test('default stream shows summaries and never decodes opaque reasoning as text', () => {
    const output = stream({});
    const text = output.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('');
    assert.equal(text, 'Provider summary.');
    assert.equal(text.includes('opaque-replay-fixture'), false);
    assert.equal(output.filter(e => e.delta?.type === 'signature_delta').length, 1);
    const terminal = output.find(e => e.type === 'message_delta');
    assert.deepEqual(terminal.usage, {
        input_tokens: 6,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 2 },
    });
});

test('optional provider text stays inside its signed reasoning block', () => {
    const output = stream({ showReasoningText: true });
    const text = output.filter(e => e.delta?.type === 'thinking_delta').map(e => e.delta.thinking).join('');
    assert.equal(text, 'Provider summary.[OpenAI-supplied reasoning text]\nAdditional provider text.');
    let open = null;
    for (const e of output) {
        if (e.type === 'content_block_start') { assert.equal(open, null); open = e.index; }
        if (e.type === 'content_block_delta') assert.equal(e.index, open);
        if (e.type === 'content_block_stop') { assert.equal(e.index, open); open = null; }
    }
    assert.equal(open, null);
    assert.equal(output.filter(e => e.content_block?.type === 'thinking').length, 1);
    assert.equal(output.filter(e => e.delta?.type === 'signature_delta').length, 1);
});

test('no additional text is invented when the provider supplies summaries only', () => {
    const output = stream({ showReasoningText: true }, events(false));
    assert.equal(output.filter(e => e.type === 'content_block_start').length, 1);
});

function mixedEvents() {
    const input = events();
    input.splice(-1, 0,
        { type: 'response.output_item.added', output_index: 1, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: 1, delta: 'Visible answer.' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'message' } });
    return input;
}

test('reasoning off returns no thinking content and an explicit zero-token split', () => {
    const input = mixedEvents();
    const output = stream({ reasoningEnabled: false, showReasoningText: true }, input);
    assert.deepEqual(output.filter(e => e.type === 'content_block_start').map(e => e.content_block.type), ['text']);
    assert.equal(output.filter(e => ['thinking_delta', 'signature_delta'].includes(e.delta?.type)).length, 0);
    assert.equal(output.find(e => e.type === 'message_delta').usage.output_tokens_details.thinking_tokens, 0);

    const response = collectAnthropicMessage(body.model, input, { reasoningEnabled: false, showReasoningText: true });
    assert.deepEqual(response.content, [{ type: 'text', text: 'Visible answer.' }]);
    assert.deepEqual(response.usage.output_tokens_details, { thinking_tokens: 0 });
});

test('enabled usage leaves an omitted reasoning split unknown', () => {
    assert.equal(anthropicUsage({ input_tokens: 2, output_tokens: 1 }).output_tokens_details, undefined);
    assert.deepEqual(anthropicUsage({ input_tokens: 2, output_tokens: 1 }, false).output_tokens_details, { thinking_tokens: 0 });
    assert.deepEqual(openAIRawUsage({ output_tokens: 1 }, false).output_tokens_details, { reasoning_tokens: 0 });
});

test('nonstream output preserves exactly one encrypted replay item', () => {
    const response = collectAnthropicMessage(body.model, events(), { showReasoningText: true });
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].thinking, 'Provider summary.[OpenAI-supplied reasoning text]\nAdditional provider text.');
    const input = toResponsesInput([{ role: 'assistant', content: response.content }]);
    assert.equal(input.filter(x => x.type === 'reasoning').length, 1);
    assert.equal(input.find(x => x.type === 'reasoning').encrypted_content, 'opaque-replay-fixture');
});

test('nonstream collection stops at the first terminal response', () => {
    const response = collectAnthropicMessage(body.model, [
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'first' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'late' },
        { type: 'response.completed', response: { usage: { input_tokens: 99, output_tokens: 99 } } },
    ]);
    assert.deepEqual(response.content, [{ type: 'text', text: 'first' }]);
    assert.equal(response.usage.input_tokens, 1);
});

test('reasoning text ownership resets between hidden upstream rounds', () => {
    const output = [];
    const parse = sseParser(event => output.push(event));
    const translator = new ResponsesToAnthropic(body.model, parse, { showReasoningText: true, deferFinish: true });
    translator.handle({ type: 'response.created', response: {} });
    translator.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } });
    translator.handle({ type: 'response.reasoning_text.delta', output_index: 0, delta: 'first-round' });
    translator.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'one' } });
    translator.nextResponse();
    translator.handle({ type: 'response.created', response: {} });
    translator.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } });
    translator.handle({ type: 'response.reasoning_text.done', output_index: 0, text: 'second-round' });
    translator.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'two' } });
    translator.handle({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } });
    const text = output.filter(event => event.delta?.type === 'thinking_delta').map(event => event.delta.thinking).join('');
    assert.ok(text.includes('first-round'));
    assert.ok(text.includes('second-round'));
});

test('OpenAI SSE parser accepts CRLF and flushes a final unterminated frame', () => {
    const output = [];
    const feed = sseParser(event => output.push(event));
    feed('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
    feed('event: response.completed\ndata: {"type":"response.completed"}', true);
    assert.deepEqual(output.map(event => event.type), ['response.created', 'response.completed']);
});

test('nonstream upstream failures and truncation remain retryable HTTP errors', () => {
    assert.throws(() => collectAnthropicMessage(body.model, [
        { type: 'response.created', response: {} },
        { type: 'response.failed', response: { error: { message: 'fixture failure' } } },
    ]), error => error?.statusCode === 502 && error.message.includes('fixture failure'));
    assert.throws(() => collectAnthropicMessage(body.model, [
        { type: 'response.created', response: {} },
    ]), error => error?.statusCode === 502 && error.message.includes('terminal response'));
});

test('completed streams without assistant content emit an error instead of message_stop', () => {
    const input = [
        { type: 'response.created', response: {} },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 0 } } },
    ];
    const output = stream({}, input);
    assert.deepEqual(output.map(event => event.type), ['message_start', 'error']);
    assert.throws(() => collectAnthropicMessage(body.model, input), error => error?.statusCode === 502 && error.message.includes('without assistant content'));
});
