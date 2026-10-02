// Generation-rate ledger. Every clock here is injected, so the assertions are
// about arithmetic and durability rather than about how fast this machine is.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const { ThroughputLedger, percentiles, summarize, rate, isSubagentRequest } =
    await import(pathToFileURL(path.join(root, 'throughput.mjs')).href);

// Verbatim from a captured request, minus the build hash. The main-session form
// omits cc_is_subagent entirely rather than setting it false, so absence of the
// key is the signal, not a false value.
const BILLING_SUBAGENT = 'x-anthropic-billing-header: cc_version=2.1.222.209; cc_entrypoint=claude-desktop; cch=8e6f1; cc_is_subagent=true;';
const BILLING_MAIN = 'x-anthropic-billing-header: cc_version=2.1.222.332; cc_entrypoint=claude-desktop; cch=3ea2e; cc_prev_req=req_011CebnUBw6FMeeo1o2WD7AT;';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-throughput-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// A hand-cranked clock. Every test advances it explicitly, so an interval in an
// assertion is a fact about the code and not about scheduler jitter.
function clock(start = 1_000_000)
{
    let value = start;
    return { now: () => value, tick: ms => { value += ms; return value; } };
}

const ledgerAt = (name, c) => new ThroughputLedger(path.join(temp, name), { now: c.now });

function anthropicStream(sample, c, { deltas = 4, deltaMs = 100, tokens = 400 })
{
    sample.anthropic({ type: 'message_start', message: { id: 'msg_1', model: 'served-model', usage: { output_tokens: 1 } } });
    for (let i = 0; i < deltas; i++)
    {
        c.tick(deltaMs);
        sample.anthropic({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcde' } });
    }
    sample.anthropic({ type: 'message_delta', usage: { output_tokens: tokens } });
    sample.anthropic({ type: 'message_stop' });
}

test('the subagent lane is read from the billing header block, not guessed', () => {
    const agentSystem = [
        { type: 'text', text: BILLING_SUBAGENT },
        { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { type: 'text', text: 'the agent definition body' },
    ];
    assert.equal(isSubagentRequest({ system: agentSystem }), true);
    assert.equal(isSubagentRequest({ system: [{ type: 'text', text: BILLING_MAIN }, { type: 'text', text: 'body' }] }), false);
    assert.equal(isSubagentRequest({ system: BILLING_SUBAGENT }), true);
    // No billing block at all is unknown, which is a third answer and not a
    // silent "main". Tool-less control-plane calls arrive looking like this.
    assert.equal(isSubagentRequest({ system: 'plain system text' }), null);
    assert.equal(isSubagentRequest({}), null);
    assert.equal(isSubagentRequest(null), null);
});

test('rate refuses to report an unmeasurable interval', () => {
    assert.equal(rate(100, 0), null);
    assert.equal(rate(100, -5), null);
    assert.equal(rate(0, 1000), null);
    assert.equal(rate(null, 1000), null);
    assert.equal(rate(250, 1000), 250);
});

test('a streamed response separates prefill from generation', () => {
    const c = clock();
    const ledger = ledgerAt('stream.jsonl', c);
    const sample = ledger.begin({
        provider: 'claude', sessionId: 'sess-1', requestedModel: 'claude-opus-5',
        subagent: false, streaming: true,
    });

    c.tick(300);
    sample.upstream();
    c.tick(700);                                   // prefill, before the first delta
    anthropicStream(sample, c, { deltas: 4, deltaMs: 250, tokens: 400 });

    assert.equal(sample.complete({
        responseId: 'msg_1', servedModel: 'served-model', status: 'completed',
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 400,
                 output_tokens_details: { thinking_tokens: 100 } },
    }), true);

    const [record] = ledger.records;
    assert.equal(record.ttfbMs, 300);
    assert.equal(record.ttftMs, 1250);             // 300 + 700 + the first delta's 250
    assert.equal(record.streamMs, 750);            // three further deltas
    assert.equal(record.totalMs, 2000);
    // 400 tokens in 750ms of generation, and in 2000ms end to end.
    assert.equal(record.outputTps, 533.33);
    assert.equal(record.endToEndTps, 200);
    assert.equal(record.tokens.reasoningOutputTokens, 100);
    assert.equal(record.tokens.contextInputTokens, 100);
    assert.equal(record.deltaEvents, 4);
    assert.equal(record.deltaChars, 20);
    assert.equal(record.subagent, false);
    assert.equal(ledger.live.size, 0);
});

test('a response with no content delta reports no generation rate', () => {
    const c = clock();
    const ledger = ledgerAt('nonstream.jsonl', c);
    const sample = ledger.begin({ provider: 'stub', requestedModel: 'Stub-Compat-agent', streaming: false });
    c.tick(4000);
    sample.complete({ responseId: 'q1', servedModel: 'stub-compat-1', usage: { input_tokens: 5, output_tokens: 200 } });

    const [record] = ledger.records;
    assert.equal(record.ttftMs, null);
    assert.equal(record.streamMs, null);
    assert.equal(record.outputTps, null, 'a rate with no measured generation window must stay null');
    assert.equal(record.endToEndTps, 50);
});

test('a stream that never terminates leaves no record and no live entry', () => {
    const c = clock();
    const ledger = ledgerAt('aborted.jsonl', c);
    const sample = ledger.begin({ provider: 'gemini', requestedModel: 'gemini-3.7-flash', streaming: true });
    sample.anthropic({ type: 'message_start', message: { id: 'g1', model: 'gemini-3.7-flash' } });
    c.tick(400);
    sample.anthropic({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } });
    assert.equal(ledger.live.size, 1);

    sample.end();
    assert.equal(ledger.live.size, 0);
    assert.equal(ledger.records.length, 0, 'a truncated stream would measure the disconnection, not the model');
    assert.equal(fs.existsSync(path.join(temp, 'aborted.jsonl')), false);
});

test('the ledger is durable and deduplicates by provider response id', () => {
    const c = clock();
    const first = ledgerAt('durable.jsonl', c);
    for (const id of ['a', 'b'])
    {
        const sample = first.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
        anthropicStream(sample, c, { deltas: 2, deltaMs: 200, tokens: 100 });
        sample.complete({ responseId: id, servedModel: 'claude-opus-5', usage: { output_tokens: 100 } });
    }

    const reopened = ledgerAt('durable.jsonl', clock());
    assert.equal(reopened.records.length, 2);
    assert.deepEqual(reopened.records.map(r => r.responseId), ['a', 'b']);
    assert.equal(reopened.records[0].series, null, 'the series is left on disk, not held per historical record');

    const again = reopened.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    assert.equal(again.complete({ responseId: 'a', servedModel: 'claude-opus-5', usage: { output_tokens: 9 } }), false);
    assert.equal(reopened.records.length, 2);
});

test('an intra-stream token series is recorded with its own clocks', () => {
    const c = clock();
    const ledger = ledgerAt('series.jsonl', c);
    const sample = ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    sample.anthropic({ type: 'message_start', message: { id: 'msg_s', usage: { output_tokens: 4 } } });
    c.tick(100);
    sample.anthropic({ type: 'content_block_delta', delta: { text: 'x' } });
    c.tick(400);
    sample.anthropic({ type: 'message_delta', usage: { output_tokens: 120 } });
    c.tick(400);
    sample.anthropic({ type: 'message_delta', usage: { output_tokens: 300 } });
    // A repeated or lower cumulative count is not a new observation.
    sample.anthropic({ type: 'message_delta', usage: { output_tokens: 300 } });
    sample.anthropic({ type: 'message_stop' });
    sample.complete({ responseId: 'msg_s', servedModel: 'claude-opus-5', usage: { output_tokens: 300 } });

    const line = JSON.parse(fs.readFileSync(path.join(temp, 'series.jsonl'), 'utf8').trim());
    assert.deepEqual(line.series, [
        { ms: 0, tokens: 4 },
        { ms: 500, tokens: 120 },
        { ms: 900, tokens: 300 },
    ]);
});

test('an in-flight snapshot reports only what the provider has already said', () => {
    const c = clock();
    const ledger = ledgerAt('live.jsonl', c);
    const sample = ledger.begin({ provider: 'claude', sessionId: 's', requestedModel: 'claude-opus-5', streaming: true });
    c.tick(200);
    sample.anthropic({ type: 'message_start', message: { id: 'msg_l', model: 'claude-opus-5' } });
    c.tick(300);
    sample.anthropic({ type: 'content_block_delta', delta: { text: '0123456789' } });
    c.tick(1000);

    const [live] = ledger.snapshot().live;
    assert.equal(live.responseId, 'msg_l');
    assert.equal(live.elapsedMs, 1500);
    assert.equal(live.ttftMs, 500);
    assert.equal(live.observedTokens, null, 'no token count has arrived, so none is reported');
    assert.equal(live.observedTps, null);
    assert.equal(live.charsPerSecond, 10);
    assert.equal(live.estimatedTps, null, 'nothing completed yet, so there is no calibration to estimate from');
});

test('an estimated in-flight rate is calibrated from completed responses of the same model', () => {
    const c = clock();
    const ledger = ledgerAt('calibrate.jsonl', c);
    const done = ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    done.anthropic({ type: 'message_start', message: { id: 'msg_c', model: 'claude-opus-5' } });
    c.tick(100);
    // 1000 chars for 250 tokens: four chars per token.
    done.anthropic({ type: 'content_block_delta', delta: { text: 'x'.repeat(1000) } });
    c.tick(1000);
    done.anthropic({ type: 'message_stop' });
    done.complete({ responseId: 'msg_c', servedModel: 'claude-opus-5', usage: { output_tokens: 250 } });

    const live = ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    live.anthropic({ type: 'message_start', message: { id: 'msg_d', model: 'claude-opus-5' } });
    live.anthropic({ type: 'content_block_delta', delta: { text: 'y'.repeat(400) } });
    c.tick(1000);

    const entry = ledger.snapshot().live.find(row => row.responseId === 'msg_d');
    assert.equal(entry.calibration.charsPerToken, 4);
    assert.equal(entry.charsPerSecond, 400);
    assert.equal(entry.estimatedTps, 100);
});

test('the OpenAI Responses adapter finds the same three intervals', () => {
    const c = clock();
    const ledger = ledgerAt('openai.jsonl', c);
    const sample = ledger.begin({ provider: 'openai', requestedModel: 'gpt-5.6-sol', effort: 'high', streaming: true });
    c.tick(250);
    sample.upstream();
    c.tick(750);
    sample.openai({ type: 'response.reasoning_text.delta', delta: 'thinking' });
    c.tick(500);
    sample.openai({ type: 'response.output_text.delta', delta: 'answer' });
    c.tick(500);
    sample.openai({ type: 'response.completed', response: { id: 'resp_1', usage: { output_tokens: 200 } } });
    sample.complete({ responseId: 'resp_1', servedModel: 'gpt-5.6-sol', usage: { input_tokens: 4, output_tokens: 200 } });

    const [record] = ledger.records;
    assert.equal(record.ttfbMs, 250);
    assert.equal(record.ttftMs, 1000);
    assert.equal(record.streamMs, 1000);
    assert.equal(record.outputTps, 200);
    assert.equal(record.deltaEvents, 2);
});

test('a hidden Responses round cannot own the final turn clock or token series', () => {
    const c = clock();
    const ledger = ledgerAt('openai-hidden-round.jsonl', c);
    const sample = ledger.begin({ provider: 'openai', requestedModel: 'gpt-5.6-sol', streaming: true });
    sample.upstream();
    c.tick(100);
    sample.openai({ type: 'response.completed', response: { id: 'resp_hidden', usage: { output_tokens: 4 } } });
    assert.equal(ledger.snapshot().live[0].observedTokens, 4);
    sample.nextOpenAIResponse();
    assert.equal(ledger.snapshot().live[0].observedTokens, null);
    c.tick(400);
    sample.openai({ type: 'response.output_text.delta', delta: 'visible answer' });
    c.tick(500);
    sample.openai({ type: 'response.completed', response: { id: 'resp_final', usage: { output_tokens: 2 } } });
    assert.equal(ledger.snapshot().live[0].observedTokens, 2,
        'a smaller final response count must not be rejected behind the hidden response');
    sample.complete({ responseId: 'resp_final', servedModel: 'gpt-5.6-sol', usage: { output_tokens: 2 } });

    const [record] = ledger.records;
    assert.equal(record.responseId, 'resp_final');
    assert.equal(record.totalMs, 1000);
    assert.equal(record.streamMs, 500);
    assert.equal(record.series, null, 'the hidden response is not part of the final response curve');
});

test('percentiles ignore unmeasured samples and never invent one', () => {
    assert.equal(percentiles([null, null]), null);
    const p = percentiles([10, null, 20, 30, 40]);
    assert.equal(p.samples, 4);
    assert.equal(p.min, 10);
    assert.equal(p.max, 40);
    assert.equal(p.mean, 25);
});

test('a group rate is tokens over time, not the mean of the rates', () => {
    const rows = [
        { tokens: { outputTokens: 10 }, streamMs: 1000, outputTps: 10, endToEndTps: 5, ttftMs: 100, ttfbMs: 50,
          provider: 'claude', completedAt: '2026-09-01T00:00:00.000Z' },
        { tokens: { outputTokens: 4000 }, streamMs: 1000, outputTps: 4000, endToEndTps: 2000, ttftMs: 900, ttfbMs: 80,
          provider: 'claude', completedAt: '2026-09-01T00:01:00.000Z' },
    ];
    const [group] = summarize(rows, row => row.provider);
    assert.equal(group.responses, 2);
    assert.equal(group.outputTokens, 4010);
    // 4010 tokens over 2000ms of generation. The mean of the two rates would be
    // 2005, which would let a ten-token response outvote a four-thousand one.
    assert.equal(group.sustainedTps, 2005);
    assert.equal(group.outputTps.p50, 4000);
    assert.equal(group.ttftMs.max, 900);
    assert.equal(group.firstAt, '2026-09-01T00:00:00.000Z');
    assert.equal(group.lastAt, '2026-09-01T00:01:00.000Z');
});

test('history filters by session, provider and lane', () => {
    const c = clock();
    const ledger = ledgerAt('query.jsonl', c);
    const add = (id, meta) => {
        const sample = ledger.begin({ streaming: true, ...meta });
        anthropicStream(sample, c, { deltas: 2, deltaMs: 100, tokens: 50 });
        sample.complete({ responseId: id, servedModel: meta.requestedModel, usage: { output_tokens: 50 } });
    };
    add('m1', { provider: 'claude', sessionId: 'S1', requestedModel: 'claude-opus-5', subagent: false });
    add('s1', { provider: 'gemini', sessionId: 'S1', requestedModel: 'gemini-3.7-flash', subagent: true });
    add('o1', { provider: 'claude', sessionId: 'S2', requestedModel: 'claude-opus-5', subagent: false });

    assert.equal(ledger.query({ session: 'S1' }).matched, 2);
    assert.equal(ledger.query({ session: 'S1', subagent: true }).records[0].provider, 'gemini');
    assert.equal(ledger.query({ provider: 'claude' }).matched, 2);
    assert.deepEqual(ledger.query({}).lanes.map(lane => lane.key).sort(), ['main', 'subagent']);
    assert.equal(ledger.query({}).sessions.length, 2);
    assert.equal(ledger.query({ limit: 1 }).returned, 1);
});

test('a sample bound to a response is cleaned up when that response closes', () => {
    const c = clock();
    const ledger = ledgerAt('close.jsonl', c);
    const handlers = [];
    const res = { once: (event, fn) => { if (event === 'close') handlers.push(fn); } };

    // A fetch that throws before the caller's try block never reaches its
    // finally, so the response close event is what has to do the removing.
    ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true }, res);
    assert.equal(ledger.live.size, 1);
    handlers.forEach(fn => fn());
    assert.equal(ledger.live.size, 0);
    assert.equal(ledger.records.length, 0);
});

test('a stale live entry is swept rather than accumulating', () => {
    const c = clock();
    const ledger = ledgerAt('sweep.jsonl', c);
    ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    assert.equal(ledger.live.size, 1);
    c.tick(16 * 60 * 1000);
    ledger.begin({ provider: 'claude', requestedModel: 'claude-opus-5', streaming: true });
    assert.equal(ledger.live.size, 1, 'the abandoned sample is gone, the new one remains');
});
