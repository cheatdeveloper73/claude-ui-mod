import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResponsesRequest, collectAnthropicMessage, ResponsesToAnthropic, sseParser } from '../router/openai.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fast-mode-'));
process.env.MODEL_ROUTER_SETTINGS_FILE = path.join(temp, 'settings.json');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const body = { model: 'claude-gpt-6.1-sol[1m]', output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'test' }] };

// Claude Code 2.1.284 marks a fast turn with body.speed === 'fast' (and the
// fast-mode-2026-02-01 beta); Codex spells the same thing service_tier priority.
test('a fast Claude Code turn asks the Codex backend for the priority tier', () => {
    assert.equal(buildResponsesRequest({ ...body, speed: 'fast' }).req.service_tier, 'priority');
});

test('a standard turn leaves the tier to the account default', () => {
    assert.equal('service_tier' in buildResponsesRequest(body).req, false);
    assert.equal('service_tier' in buildResponsesRequest({ ...body, speed: 'standard' }).req, false);
});


// Claude Code reads fast mode once per turn; the session's switch is read per
// request, so a flip reaches the next request even inside a running turn.
test('the session switch sets the tier of every main-agent request, live', async () => {
    const { fastTier } = await import('../router/fast-mode.mjs');
    const state = path.join(temp, 'fast-mode.json');
    const cache = path.join(temp, 'models_cache.json');
    process.env.MODEL_ROUTER_FAST_MODE_FILE = state;
    process.env.CODEX_MODELS_CACHE = cache;
    fs.writeFileSync(cache, JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', service_tiers: [{ id: 'priority' }] }, { slug: 'gpt-5.4', service_tiers: [] },
    ] }));
    const set = value => fs.writeFileSync(state, JSON.stringify({ sessions: {}, cli: { 'cli-a': value } }));
    const tier = (extra, sessionId = 'cli-a', subagent = false, model = 'gpt-6.1-sol') => {
        const req = { ...body, ...extra };
        return buildResponsesRequest(req, undefined, undefined, { fast: fastTier({ body: req, model, sessionId, subagent }) }).req.service_tier;
    };

    set(true);
    assert.equal(tier({}), 'priority', 'switch on, turn started standard');
    set(false);
    assert.equal(tier({ speed: 'fast' }), undefined, 'switch off, turn started fast');
    assert.equal(tier({ speed: 'fast' }, 'cli-other'), 'priority', 'a session nobody set follows its request');
    assert.equal(tier({}, 'cli-other'), undefined);
    set(true);
    assert.equal(tier({}, 'cli-a', true), undefined, 'the orchestrator switch does not reach its subagents');
    assert.equal(tier({}, 'cli-a', false, 'gpt-5.4'), undefined, 'no priority tier for this slug');
});

// A subagent's first message as CLI 2.1.284 sends it: reminder blocks, then the
// launch prompt as its own text block.
const launched = prompt => ({ ...body, model: 'claude-gpt-5.6-luna[1m]:high', messages: [{ role: 'user', content: [
    { type: 'text', text: '<system-reminder>\nproject instructions\n</system-reminder>' },
    { type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>\n' },
    { type: 'text', text: prompt },
] }, { role: 'assistant', content: [{ type: 'text', text: 'working' }] }] });

test('a subagent runs fast only when its launch prompt says #fast', async () => {
    const { fastTier } = await import('../router/fast-mode.mjs');
    fs.writeFileSync(process.env.MODEL_ROUTER_FAST_MODE_FILE, JSON.stringify({ cli: { 'cli-a': true } }));
    fs.writeFileSync(process.env.CODEX_MODELS_CACHE, JSON.stringify({ models: [
        { slug: 'gpt-5.6-luna', service_tiers: [{ id: 'priority' }] }, { slug: 'gpt-5.4', service_tiers: [] },
    ] }));
    const build = (req, model = 'gpt-5.6-luna') =>
        buildResponsesRequest(req, undefined, undefined, { fast: fastTier({ body: req, model, sessionId: 'cli-a', subagent: true }) }).req;

    const marked = build(launched('#fast\nRead the log.'));
    assert.equal(marked.service_tier, 'priority');
    assert.equal(JSON.stringify(marked.input).includes('#fast'), false, 'the model never sees the marker');
    assert.equal(JSON.stringify(marked.input).includes('Read the log.'), true);
    assert.equal(build({ ...launched('Read the log.'), speed: 'fast' }).service_tier, undefined,
        'a fast parent does not make its subagents fast');
    assert.equal(build(launched('Mention #fast in passing.')).service_tier, undefined, 'only a leading line counts');
    assert.equal(build(launched('#fast\nRead.'), 'gpt-5.4').service_tier, undefined, 'no priority tier for this slug');
    assert.deepEqual(buildResponsesRequest(launched('#fast\nRead.')).req.input, buildResponsesRequest(launched('Read.')).req.input,
        'with the marker gone the agent sends what an unmarked one would');
});

test('each translated GPT response carries the tier that was sent', () => {
    const events = [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'Read' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'Read' } },
        { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2 }, service_tier: 'default' } },
    ];
    for (const speed of ['fast', 'standard']) {
        assert.equal(collectAnthropicMessage('m', events, { speed }).usage.speed, speed);
        const frames = [];
        const parse = sseParser(event => frames.push(event));
        const stream = new ResponsesToAnthropic('m', frame => parse(frame), { speed });
        for (const event of events) stream.handle(event);
        assert.equal(frames.find(e => e.type === 'message_start').message.usage.speed, speed);
        assert.equal(frames.find(e => e.type === 'message_delta').usage.speed, speed);
    }
});
