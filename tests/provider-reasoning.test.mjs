import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResponsesRequest, collectAnthropicMessage, ResponsesToAnthropic, sseParser, toResponsesInput } from '../router/openai.mjs';
import { readProviderSettings } from '../router/settings.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-reasoning-'));
const file = path.join(temp, 'settings.json');
process.env.MODEL_ROUTER_SETTINGS_FILE = file;
const write = values => fs.writeFileSync(file, JSON.stringify({ 'provider-picker': values }));
after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(temp); });
const body = { model: 'claude-gpt-5.6-sol[1m]', output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'test' }] };

test('summary settings change per request without changing effort or replay', () => {
    write({ reasoningSummary: 'auto' });
    assert.equal(buildResponsesRequest(body).req.reasoning.summary, 'auto');
    write({ reasoningSummary: 'detailed' });
    assert.equal(buildResponsesRequest(body).req.reasoning.summary, 'detailed');
    write({ reasoningSummary: 'off' });
    const req = buildResponsesRequest(body).req;
    assert.equal(req.reasoning.summary, undefined);
    assert.equal(req.reasoning.effort, 'high');
    assert.deepEqual(req.include, ['reasoning.encrypted_content']);
    write({ reasoningSummary: 'raw', showReasoningText: 'yes' });
    assert.equal(readProviderSettings().reasoningSummary, 'auto');
    assert.equal(readProviderSettings().showReasoningText, false);
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

test('nonstream output preserves exactly one encrypted replay item', () => {
    const response = collectAnthropicMessage(body.model, events(), { showReasoningText: true });
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].thinking, 'Provider summary.[OpenAI-supplied reasoning text]\nAdditional provider text.');
    const input = toResponsesInput([{ role: 'assistant', content: response.content }]);
    assert.equal(input.filter(x => x.type === 'reasoning').length, 1);
    assert.equal(input.find(x => x.type === 'reasoning').encrypted_content, 'opaque-replay-fixture');
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
