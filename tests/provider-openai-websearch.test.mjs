import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const routerDir = process.env.PROVIDER_ROUTER_DIR || path.join(here, '..', 'router');
const openai = await import(pathToFileURL(path.join(routerDir, 'openai.mjs')).href);
const {
    ResponsesToAnthropic,
    buildResponsesRequest,
    collectAnthropicMessage,
} = openai;

const settings = { reasoningEnabled: true, reasoningSummary: 'auto' };
const model = 'claude-gpt-5.6-luna[1m]';

const webTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    allowed_domains: ['openai.com', 'developers.openai.com'],
    blocked_domains: [],
    user_location: {
        type: 'approximate',
        country: 'US',
        region: 'WA',
        city: 'Seattle',
        timezone: 'America/Los_Angeles',
    },
};

function requestBody(overrides = {}) {
    return {
        model,
        messages: [{ role: 'user', content: 'Search for the official OpenAI home page.' }],
        tools: [webTool],
        ...overrides,
    };
}

function searchEvents({ calls = 1, text = 'The official OpenAI site is openai.com.', citations = true } = {}) {
    const events = [
        { type: 'response.created', response: {} },
    ];
    for (let i = 0; i < calls; i++)
    {
        events.push({
            type: 'response.output_item.added',
            output_index: i,
            item: { type: 'web_search_call', id: `ws_${i + 1}`, status: 'in_progress' },
        });
        events.push({
            type: 'response.web_search_call.in_progress',
            output_index: i,
            item_id: `ws_${i + 1}`,
            status: 'in_progress',
        });
        events.push({
            type: 'response.output_item.done',
            output_index: i,
            item: {
                type: 'web_search_call',
                id: `ws_${i + 1}`,
                status: 'completed',
                action: {
                    type: 'search',
                    queries: ['official OpenAI home page'],
                    query: 'official OpenAI home page',
                },
            },
        });
    }
    events.push(
        { type: 'response.output_text.annotation.added', output_index: calls, annotation: { type: 'url_citation', title: 'ignored', url: 'https://ignored.example/' } },
        { type: 'response.output_item.added', output_index: calls, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: calls, delta: text },
        { type: 'response.output_text.annotation.added', output_index: calls, annotation: { type: 'url_citation', title: 'ignored again', url: 'https://ignored-again.example/' } },
        {
            type: 'response.output_item.done',
            output_index: calls,
            item: {
                type: 'message',
                content: [{
                    type: 'output_text',
                    text,
                    annotations: citations ? [
                        { type: 'url_citation', start_index: 0, end_index: 4, title: 'OpenAI', url: 'https://openai.com/' },
                        { type: 'url_citation', start_index: 5, end_index: 9, title: 'OpenAI alternate', url: 'https://openai.com/' },
                        { type: 'url_citation', start_index: 10, end_index: 14, title: 'Developers', url: 'https://developers.openai.com/' },
                    ] : [],
                }],
            },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 7 } } },
    );
    return events;
}

function openAndFindEvents() {
    const actions = [
        { type: 'open_page', url: 'https://openai.com/' },
        { type: 'find_in_page', url: 'https://openai.com/docs', pattern: 'Responses API' },
    ];
    const events = [{ type: 'response.created', response: {} }];
    actions.forEach((action, index) => {
        events.push(
            {
                type: 'response.output_item.added', output_index: index,
                item: { type: 'web_search_call', id: `ws_action_${index}`, status: 'open' },
            },
            {
                type: 'response.web_search_call.in_progress', output_index: index,
                item_id: `ws_action_${index}`, status: 'open',
            },
            {
                type: 'response.output_item.done', output_index: index,
                item: { type: 'web_search_call', id: `ws_action_${index}`, status: 'completed', action },
            },
        );
    });
    events.push(
        { type: 'response.output_item.added', output_index: actions.length, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: actions.length, delta: 'Opened and searched.' },
        {
            type: 'response.output_item.done', output_index: actions.length,
            item: { type: 'message', content: [{ type: 'output_text', text: 'Opened and searched.', annotations: [] }] },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 2 } } },
    );
    return events;
}

function stream(events, options = {}) {
    const frames = [];
    const translator = new ResponsesToAnthropic(model, frame => frames.push(frame), options);
    for (const event of events) translator.handle(event);
    return frames.map(frame => {
        const match = /^event: [^\n]+\ndata: (.+)\n\n$/.exec(frame);
        assert.ok(match, `unexpected Anthropic frame: ${frame}`);
        return JSON.parse(match[1]);
    });
}

test('maps Anthropic web_search exactly to the Codex hosted tool', () => {
    const req = buildResponsesRequest(requestBody(), settings).req;
    assert.deepEqual(req.tools, [{
        type: 'web_search',
        external_web_access: true,
        filters: { allowed_domains: ['openai.com', 'developers.openai.com'] },
        user_location: {
            type: 'approximate',
            country: 'US',
            region: 'WA',
            city: 'Seattle',
            timezone: 'America/Los_Angeles',
        },
    }]);
    assert.equal(req.tool_choice, 'auto');
});

test('forced web_search becomes auto while ordinary function choice is unchanged', () => {
    const forcedSearch = buildResponsesRequest(requestBody({
        tool_choice: { type: 'tool', name: 'web_search' },
    }), settings).req;
    assert.equal(forcedSearch.tool_choice, 'auto');

    const ordinary = buildResponsesRequest(requestBody({
        tools: [{ name: 'bash', description: 'run a command', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'bash' },
    }), settings).req;
    assert.deepEqual(ordinary.tool_choice, { type: 'function', name: 'bash' });
    assert.deepEqual(ordinary.tools, [{
        type: 'function', name: 'bash', description: 'run a command', strict: false,
        parameters: { type: 'object', properties: {} },
    }]);

    const coincidentalName = buildResponsesRequest(requestBody({
        tools: [{ name: 'web_search', description: 'an ordinary function', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'web_search' },
    }), settings).req;
    assert.deepEqual(coincidentalName.tool_choice, { type: 'function', name: 'web_search' });
});

test('non-empty blocked_domains fails instead of claiming to enforce it', () => {
    assert.throws(() => buildResponsesRequest(requestBody({
        tools: [{ ...webTool, blocked_domains: ['example.com'] }],
    }), settings), error => error?.statusCode === 400
        && error.message.includes('blocked_domains')
        && error.message.includes('cannot be enforced'));
    assert.doesNotThrow(() => buildResponsesRequest(requestBody({
        tools: [{ ...webTool, blocked_domains: [] }],
    }), settings));
});

test('stream emits server tool, deduplicated result, then buffered assistant text', () => {
    const output = stream(searchEvents());
    const starts = output.filter(event => event.type === 'content_block_start');
    assert.deepEqual(starts.map(event => event.content_block.type), [
        'server_tool_use', 'web_search_tool_result', 'text',
    ]);
    assert.deepEqual(starts[0].content_block, {
        type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: {},
    });
    const inputDelta = output.find(event => event.delta?.type === 'input_json_delta');
    assert.deepEqual(JSON.parse(inputDelta.delta.partial_json), { query: 'official OpenAI home page' });
    assert.deepEqual(starts[1].content_block, {
        type: 'web_search_tool_result',
        tool_use_id: 'ws_1',
        content: [
            { type: 'web_search_result', title: 'OpenAI', url: 'https://openai.com/' },
            { type: 'web_search_result', title: 'Developers', url: 'https://developers.openai.com/' },
        ],
    });
    assert.deepEqual(output.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text), [
        'The official OpenAI site is openai.com.',
    ]);
    const resultStop = output.findIndex(event => event.type === 'content_block_stop' && event.index === starts[1].index);
    const textDelta = output.findIndex(event => event.delta?.type === 'text_delta');
    assert.ok(resultStop >= 0 && textDelta > resultStop);
    assert.equal(output.find(event => event.type === 'message_delta').delta.stop_reason, 'end_turn');
});

test('multiple search calls attach citations once to the last result', () => {
    const output = stream(searchEvents({ calls: 2 }));
    const results = output
        .filter(event => event.type === 'content_block_start')
        .map(event => event.content_block)
        .filter(block => block.type === 'web_search_tool_result');
    assert.equal(results.length, 2);
    assert.deepEqual(results[0].content, []);
    assert.deepEqual(results[1].content, [
        { type: 'web_search_result', title: 'OpenAI', url: 'https://openai.com/' },
        { type: 'web_search_result', title: 'Developers', url: 'https://developers.openai.com/' },
    ]);
});

test('preserves max_uses and rejects hosted calls beyond the limit', () => {
    assert.equal(buildResponsesRequest(requestBody(), settings).webSearchMaxUses, 3);
    const limited = buildResponsesRequest(requestBody({
        tools: [{ ...webTool, max_uses: 1 }],
    }), settings);
    assert.equal(limited.webSearchMaxUses, 1);
    assert.throws(() => buildResponsesRequest(requestBody({
        tools: [{ ...webTool, max_uses: 0 }],
    }), settings), error => error?.statusCode === 400 && /max_uses.*positive integer/.test(error.message));

    const options = { ...settings, webSearchMaxUses: limited.webSearchMaxUses };
    const output = stream(searchEvents({ calls: 2 }), options);
    assert.deepEqual(output.map(event => event.type), ['message_start', 'error']);
    assert.match(output[1].error.message, /max_uses 1 exceeded/);
    assert.throws(() => collectAnthropicMessage(model, searchEvents({ calls: 2 }), options), error => error?.statusCode === 502
        && /max_uses 1 exceeded/.test(error.message));
});

test('mixed hosted search and function call without a message finishes as tool_use', () => {
    const events = [
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', output_index: 0,
            item: { type: 'web_search_call', id: 'ws_mixed', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0,
            item: { type: 'web_search_call', id: 'ws_mixed', status: 'completed',
                action: { type: 'search', query: 'mixed search' } } },
        { type: 'response.output_item.added', output_index: 1,
            item: { type: 'function_call', call_id: 'call_mixed', name: 'bash' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"command":"pwd"}' },
        { type: 'response.output_item.done', output_index: 1,
            item: { type: 'function_call', call_id: 'call_mixed', name: 'bash', arguments: '{"command":"pwd"}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];

    const streamed = stream(events);
    assert.deepEqual(streamed.filter(event => event.type === 'content_block_start')
        .map(event => event.content_block.type), ['tool_use', 'server_tool_use', 'web_search_tool_result']);
    const result = streamed.find(event => event.content_block?.type === 'web_search_tool_result');
    assert.deepEqual(result.content_block.content, []);
    assert.equal(streamed.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');

    const collected = collectAnthropicMessage(model, events, settings);
    assert.equal(collected.stop_reason, 'tool_use');
    assert.deepEqual(collected.content.map(block => block.type), [
        'tool_use', 'server_tool_use', 'web_search_tool_result',
    ]);
    assert.deepEqual(collected.content.at(-1).content, []);
});

test('open_page and find_in_page actions accept open status and derive query labels', () => {
    const events = openAndFindEvents();
    const response = collectAnthropicMessage(model, events, settings);
    assert.deepEqual(response.content.slice(0, 4), [
        { type: 'server_tool_use', id: 'ws_action_0', name: 'web_search', input: { query: 'https://openai.com/' } },
        { type: 'web_search_tool_result', tool_use_id: 'ws_action_0', content: [] },
        { type: 'server_tool_use', id: 'ws_action_1', name: 'web_search', input: { query: 'https://openai.com/docs Responses API' } },
        { type: 'web_search_tool_result', tool_use_id: 'ws_action_1', content: [] },
    ]);
    const output = stream(events);
    assert.deepEqual(output.filter(event => event.delta?.type === 'input_json_delta').map(event => JSON.parse(event.delta.partial_json)), [
        { query: 'https://openai.com/' },
        { query: 'https://openai.com/docs Responses API' },
    ]);
});

test('nonstream collection matches the streamed server-tool mapping', () => {
    const response = collectAnthropicMessage(model, searchEvents(), settings);
    assert.deepEqual(response.content, [
        { type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: { query: 'official OpenAI home page' } },
        { type: 'web_search_tool_result', tool_use_id: 'ws_1', content: [
            { type: 'web_search_result', title: 'OpenAI', url: 'https://openai.com/' },
            { type: 'web_search_result', title: 'Developers', url: 'https://developers.openai.com/' },
        ] },
        { type: 'text', text: 'The official OpenAI site is openai.com.' },
    ]);
    assert.equal(response.stop_reason, 'end_turn');
});

test('ordinary function calls still stream as tool_use', () => {
    const output = stream([
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"command":"pwd"}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assert.deepEqual(output.filter(event => event.type === 'content_block_start').map(event => event.content_block), [{
        type: 'tool_use', id: 'call_1', name: 'bash', input: {},
    }]);
    assert.equal(output.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('failed web_search_call is a retryable upstream error', () => {
    const events = [
        { type: 'response.created', response: {} },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_failed', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_failed', status: 'failed' } },
    ];
    const output = stream(events);
    assert.deepEqual(output.map(event => event.type), ['message_start', 'error']);
    assert.match(output[1].error.message, /web_search_call.*status failed/);
    assert.throws(() => collectAnthropicMessage(model, events, settings), error => error?.statusCode === 502
        && /web_search_call.*status failed/.test(error.message));
});
