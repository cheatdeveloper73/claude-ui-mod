import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountingStore } from '../router/accounting.mjs';
import { normalizeUsage } from '../router/telemetry.mjs';
import {
    canonicalModel, costOfTokens, emptyCost, foldCost, pricedModels, rateFor, registerRates,
    PRICING_FINGERPRINT,
} from '../router/pricing.mjs';

// An adapter adds a provider, so it registers that provider's rates. Doing the
// same thing here means the dated-period arithmetic below is exercised through
// the public hook rather than only through the compiled-in table.
registerRates({
    'acme/acme-flash': [
        { from: null, to: '2027-01-01',
          input: 0.75, cacheRead: 0.075, cacheWrite5m: 0, cacheWrite1h: 0, output: 3.75 },
        { from: '2027-01-01', to: null,
          input: 1.50, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0, output: 7.50 },
    ],
}, { acme: '5m' });

const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function tempRoot(label)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `provider-pricing-${label}-`));
    temps.push(dir);
    return dir;
}

const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

const tokensOf = (overrides = {}) => ({
    responses: 1,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    contextInputTokens: 0,
    outputTokens: 0,
    ...overrides,
});

// ------------------------------------------------------------ rate lookup ---

test('a published rate prices each component independently', () => {
    const cost = costOfTokens('acme', 'acme-flash',
        tokensOf({ inputTokens: 1_000_000, cacheReadInputTokens: 2_000_000, outputTokens: 100_000 }),
        '2026-09-01T00:00:00.000Z');
    near(cost.input, 0.75, 'input');
    near(cost.cacheRead, 0.15, 'cache read');
    near(cost.output, 0.375, 'output');
    near(cost.total, 1.275, 'total');
});

test('a dated model snapshot prices as its family', () => {
    assert.equal(canonicalModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    const dated = costOfTokens('claude', 'claude-haiku-4-5-20251001',
        tokensOf({ inputTokens: 1_000_000 }), '2026-09-01T00:00:00.000Z');
    const plain = costOfTokens('claude', 'claude-haiku-4-5',
        tokensOf({ inputTokens: 1_000_000 }), '2026-09-01T00:00:00.000Z');
    assert.deepEqual(dated, plain);
    near(dated.input, 1.00, 'haiku input');
});

test('a name that merely resembles a priced model is not coerced into its rate', () => {
    assert.equal(canonicalModel('claude-opus-5-turbo'), 'claude-opus-5-turbo');
    assert.equal(rateFor('claude', 'claude-opus-5-turbo', '2026-09-01T00:00:00.000Z'), null);
    assert.equal(rateFor('acme', 'acme-9.9-flash', '2026-09-01T00:00:00.000Z'), null);
});

test('a model served by the wrong provider is unpriced rather than misattributed', () => {
    // The store holds exactly this: one adapter record whose servedModel is a
    // Claude id. Pricing it as Claude would invent spend on the wrong account.
    assert.equal(rateFor('acme', 'claude-haiku-4-5-20251001', '2026-09-01T00:00:00.000Z'), null);
    assert.equal(costOfTokens('acme', 'claude-haiku-4-5-20251001', tokensOf({ inputTokens: 404 }), '2026-09-01'), null);
});

test('every key in the table is provider/model with an undated model name', () => {
    for (const key of pricedModels())
    {
        const [provider, ...rest] = key.split('/');
        const model = rest.join('/');
        assert.ok(provider && model, `malformed key ${key}`);
        assert.equal(canonicalModel(model), model, `key ${key} carries a dated snapshot id`);
    }
});

test('the fingerprint identifies the table that produced a number', () => {
    assert.match(PRICING_FINGERPRINT, /^[0-9a-f]{12}$/);
});

test('NanoGPT prices from its published registry rates', () => {
    const cost = costOfTokens('nanogpt', 'glm-5.3-flash',
        tokensOf({ inputTokens: 4_000_000, cacheReadInputTokens: 1_000_000, outputTokens: 1_000_000 }),
        '2026-09-03');
    near(cost.input, 0.30, 'input');
    near(cost.cacheRead, 0.015, 'cache read');
    near(cost.output, 0.25, 'output');
    near(cost.total, 0.565, 'total');
});

test('a NanoGPT cache write bills as plain input, there being no premium', () => {
    const cost = costOfTokens('nanogpt', 'glm-5.3-flash',
        tokensOf({ cacheCreationInputTokens: 1_000_000 }), '2026-09-03');
    near(cost.cacheWrite, 0.075, 'cache write');
});

test('the newer Anthropic models price at their published rates', () => {
    // docs.claude.com pricing, checked 2026-09-03. Fable 5.1's cache read is
    // 0.025x input, a discount no other model on the page gets; Fable 5 reads
    // at the ordinary 0.1x. The two must not collapse into one entry.
    const usage = tokensOf({ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, outputTokens: 100_000 });
    const fable51 = costOfTokens('claude', 'claude-fable-5-1', usage, '2026-09-03');
    near(fable51.input, 10.00, 'fable 5.1 input');
    near(fable51.cacheRead, 0.25, 'fable 5.1 cache read at its special 0.025x');
    near(fable51.output, 5.00, 'fable 5.1 output');
    const fable5 = costOfTokens('claude', 'claude-fable-5', usage, '2026-09-03');
    near(fable5.cacheRead, 1.00, 'fable 5 cache read at the ordinary 0.1x');
    const opus46 = costOfTokens('claude', 'claude-opus-4-6',
        tokensOf({ inputTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }), '2026-09-03');
    near(opus46.input, 5.00, 'opus 4.6 input');
    near(opus46.cacheWrite, 10.00, 'opus 4.6 one-hour write');
});

test('the newer OpenAI models price at their published rates', () => {
    const usage = tokensOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    near(costOfTokens('openai', 'gpt-6-astra', usage, '2026-09-05').total, 10.00 + 50.00, 'astra');
    const pricedUsage = tokensOf({ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000,
        cacheCreation5mTokens: 1_000_000, outputTokens: 1_000_000 });
    const sol = costOfTokens('openai', 'gpt-6-sol', pricedUsage, '2026-09-22');
    near(sol.input, 2.00, 'gpt-6 sol input');
    near(sol.cacheRead, 0.20, 'gpt-6 sol cached input');
    near(sol.cacheWrite, 2.50, 'gpt-6 sol cache write');
    near(sol.output, 10.00, 'gpt-6 sol output');
    const next = costOfTokens('openai', 'gpt-6.1-sol', pricedUsage, '2026-09-29');
    near(next.input, 2.00, 'gpt-6.1 sol input');
    near(next.cacheRead, 0.10, 'gpt-6.1 sol cached input');
    near(next.output, 10.00, 'gpt-6.1 sol output');
    const luna = costOfTokens('openai', 'gpt-6-luna', pricedUsage, '2026-09-22');
    near(luna.input, 0.10, 'gpt-6 luna input');
    near(luna.cacheRead, 0.01, 'gpt-6 luna cached input');
    near(luna.cacheWrite, 0.125, 'gpt-6 luna cache write');
    near(luna.output, 0.50, 'gpt-6 luna output');
    near(costOfTokens('openai', 'gpt-5.6-terra', usage, '2026-09-03').total, 2.00 + 12.00, 'terra');
    near(costOfTokens('openai', 'gpt-5.6-luna', usage, '2026-09-03').total, 0.20 + 1.20, 'luna');
});

test('Meta standard and contributor traffic keep their distinct direct rates', () => {
    const usage = tokensOf({ inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, outputTokens: 1_000_000 });
    near(costOfTokens('meta', 'muse-spark-1.3', usage, '2026-09-05').total, 1.25 + 0.15 + 4.25, 'standard');
    near(costOfTokens('meta', 'muse-spark-1.3-contributor', usage, '2026-09-05').total, 0.10 + 0.002 + 0.20, 'contributor');
});

test('retired Qwen aliases price historical traffic without canonicalizing distinct ids', () => {
    const usage = tokensOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    for (const model of ['Qwen3.8-Max-agent', 'Qwen3.8-Max-fast-agent', 'Qwen3.8-Max-thinking-agent'])
        near(costOfTokens('qwen', model, usage, '2026-09-05').total, 2.00 + 6.00, model);
    assert.equal(rateFor('qwen', 'Qwen3.8-Max-search', '2026-09-05'), null);
});

// -------------------------------------------------------- effective dating ---

test('a future rate change is already encoded and does not leak backwards', () => {
    const usage = tokensOf({ inputTokens: 1_000_000 });
    near(costOfTokens('acme', 'acme-flash', usage, '2026-12-31T00:00:00.000Z').input, 0.75, 'before the change');
    near(costOfTokens('acme', 'acme-flash', usage, '2027-01-01T00:00:00.000Z').input, 1.50, 'on the change');
});

test('a scheduled increase the provider cancelled prices at the published rate on both sides', () => {
    // This table briefly carried a $3/$15 Sonnet 5 step from 2026-09-01; the
    // pricing page now states that increase will not occur. Retroactive
    // correction is free, so the wrong period is simply gone.
    const usage = tokensOf({ inputTokens: 1_000_000 });
    near(costOfTokens('claude', 'claude-sonnet-5', usage, '2026-08-31T23:59:59.999Z').input, 2.00, 'August');
    near(costOfTokens('claude', 'claude-sonnet-5', usage, '2026-09-03T00:00:00.000Z').input, 2.00, 'September');
});

test('the 5.5 generation is priced, including the 0.05x Opus 5.5 cache read', () => {
    const usage = tokensOf({ inputTokens: 1_000_000, outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 2_000_000,
        cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 });
    for (const [model, want] of [
        ['claude-opus-5-5', { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 13.00 }],
        ['claude-sonnet-5-5', { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 6.50 }],
    ]) {
        const cost = costOfTokens('claude', model, usage, '2026-09-28');
        assert.ok(cost, model + ' must not be unpriced');
        for (const [field, value] of Object.entries(want)) near(cost[field], value, model + ' ' + field);
    }
});

// ------------------------------------------------------------- cache write ---

test('a cache write is priced by the TTL it was actually written at', () => {
    const short = costOfTokens('claude', 'claude-opus-5',
        tokensOf({ cacheCreationInputTokens: 1_000_000, cacheCreation5mTokens: 1_000_000 }), '2026-09-01');
    const long = costOfTokens('claude', 'claude-opus-5',
        tokensOf({ cacheCreationInputTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }), '2026-09-01');
    near(short.cacheWrite, 6.25, '5-minute write');
    near(long.cacheWrite, 10.00, '1-hour write');
    assert.ok(long.cacheWrite > short.cacheWrite, 'the longer TTL must cost more');
});

test('a record written before the split was captured falls back to the measured default', () => {
    // Every Anthropic cache write observed on disk was ephemeral_1h, so the
    // fallback must be the 2x rate; defaulting to 1.25x would under-bill.
    const legacy = costOfTokens('claude', 'claude-opus-5',
        tokensOf({ cacheCreationInputTokens: 1_000_000 }), '2026-09-01');
    near(legacy.cacheWrite, 10.00, 'legacy cache write');
});

test('a partly-split cache write prices the known part exactly and the rest by default', () => {
    const mixed = costOfTokens('claude', 'claude-opus-5',
        tokensOf({ cacheCreationInputTokens: 1_000_000, cacheCreation5mTokens: 400_000 }), '2026-09-01');
    near(mixed.cacheWrite, 0.4 * 6.25 + 0.6 * 10.00, 'mixed cache write');
});

test('a split larger than the reported total never produces negative spend', () => {
    // Three records in the observed corpus disagree between the split and the
    // total; the residual must clamp rather than subtract.
    const skewed = costOfTokens('claude', 'claude-opus-5',
        tokensOf({ cacheCreationInputTokens: 100, cacheCreation1hTokens: 500 }), '2026-09-01');
    assert.ok(skewed.cacheWrite > 0);
    near(skewed.cacheWrite, 500 * 10.00 / 1e6, 'clamped residual');
});

test('a rollup written before the split existed still prices', () => {
    const oldShape = { responses: 3, inputTokens: 1_000_000, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1_000_000, contextInputTokens: 2_000_000, outputTokens: 0 };
    const cost = costOfTokens('claude', 'claude-opus-5', oldShape, '2026-09-01');
    near(cost.total, 5.00 + 10.00, 'old-shape bucket');
});

// ------------------------------------------------------------- robustness ---

test('absent, negative and non-numeric token counts contribute nothing', () => {
    const cost = costOfTokens('claude', 'claude-opus-5',
        { inputTokens: -5, cacheReadInputTokens: null, outputTokens: 'many', cacheCreationInputTokens: NaN },
        '2026-09-01');
    near(cost.total, 0, 'garbage in, zero out');
});

test('pricing an aggregate equals pricing each response and summing', () => {
    const rows = [
        tokensOf({ inputTokens: 1234, cacheReadInputTokens: 98_765, outputTokens: 321 }),
        tokensOf({ inputTokens: 4321, cacheReadInputTokens: 12_345, outputTokens: 89 }),
        tokensOf({ inputTokens: 77, cacheCreationInputTokens: 5000, cacheCreation1hTokens: 5000, outputTokens: 9 }),
    ];
    const perRow = rows.reduce((sum, row) =>
        sum + costOfTokens('claude', 'claude-opus-5', row, '2026-09-01').total, 0);
    const aggregate = tokensOf({
        responses: 3,
        inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
        cacheReadInputTokens: rows.reduce((s, r) => s + r.cacheReadInputTokens, 0),
        cacheCreationInputTokens: rows.reduce((s, r) => s + r.cacheCreationInputTokens, 0),
        cacheCreation1hTokens: rows.reduce((s, r) => s + r.cacheCreation1hTokens, 0),
        outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    });
    near(costOfTokens('claude', 'claude-opus-5', aggregate, '2026-09-01').total, perRow,
        'aggregate must equal the sum of its parts');
});

test('an unpriced model is counted as a gap, never as free traffic', () => {
    const target = emptyCost();
    foldCost(target, 'someone', 'unknown-model',
        tokensOf({ responses: 4, contextInputTokens: 900, outputTokens: 100 }), '2026-09-01');
    assert.equal(target.total, 0);
    assert.equal(target.unpricedResponses, 4);
    assert.equal(target.unpricedTokens, 1000);
});

// -------------------------------------------------- telemetry passes it on ---

test('the cache TTL split survives normalization', () => {
    const usage = normalizeUsage({
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 800 },
    });
    assert.equal(usage.cacheCreation5mTokens, 100);
    assert.equal(usage.cacheCreation1hTokens, 800);
    assert.equal(usage.cacheCreationInputTokens, 900);
});

test('a provider that sends no split normalizes to zeros rather than undefined', () => {
    const usage = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 900 });
    assert.equal(usage.cacheCreation5mTokens, 0);
    assert.equal(usage.cacheCreation1hTokens, 0);
});

// ------------------------------------------------------- store integration ---

function record(store, overrides)
{
    return store.record('token', {
        provider: 'acme',
        responseId: overrides.responseId,
        servedModel: 'acme-flash',
        source: 'acme.usageMetadata',
        exact: true,
        observedAt: overrides.observedAt,
        tokens: normalizeUsage({ input_tokens: 1_000_000, output_tokens: 0 }),
    });
}

// The boundary is in the future relative to the wall clock, and an all-time
// query bounds its window at now(), so the store reads the clock from here
// rather than pretending the change already happened.
const afterTheChange = () => Date.parse('2027-01-02T00:00:00.000Z');

test('a window spanning a price change bills each day at its own rate', () => {
    const store = new AccountingStore({ root: tempRoot('boundary'), now: afterTheChange });
    assert.equal(record(store, { responseId: 'a', observedAt: '2026-12-31T12:00:00.000Z' }), 'stored');
    assert.equal(record(store, { responseId: 'b', observedAt: '2027-01-01T12:00:00.000Z' }), 'stored');

    const q = store.query('all', 0);
    // One million input tokens on each side of the change: $0.75 then $1.50.
    near(q.cost.total, 2.25, 'window total');
    const byDay = Object.fromEntries(q.dailyTimeline.map(row => [row.date, row.cost.total]));
    near(byDay['2026-12-31'], 0.75, 'promo day');
    near(byDay['2027-01-01'], 1.50, 'announced day');
});

test('provider and model totals agree with the window total', () => {
    const store = new AccountingStore({ root: tempRoot('agree'), now: afterTheChange });
    record(store, { responseId: 'a', observedAt: '2026-12-31T12:00:00.000Z' });
    record(store, { responseId: 'b', observedAt: '2027-01-01T12:00:00.000Z' });
    store.record('token', {
        provider: 'claude', responseId: 'c', servedModel: 'claude-opus-5',
        source: 'anthropic.message.usage', exact: true,
        observedAt: '2026-12-31T15:00:00.000Z',
        tokens: normalizeUsage({ input_tokens: 1_000_000, output_tokens: 0 }),
    });

    const q = store.query('all', 0);
    const providerSum = Object.values(q.providers).reduce((sum, row) => sum + row.cost.total, 0);
    const modelSum = q.models.reduce((sum, row) => sum + row.cost.total, 0);
    const daySum = q.dailyTimeline.reduce((sum, row) => sum + row.cost.total, 0);
    near(providerSum, q.cost.total, 'providers vs window');
    near(modelSum, q.cost.total, 'models vs window');
    near(daySum, q.cost.total, 'days vs window');
    near(q.providers.acme.cost.total, 2.25, 'adapter leg: one day either side of the change');
    near(q.providers.claude.cost.total, 5.00, 'claude leg');
});

test('an unpriced model shows as a gap in the store query, not as zero spend', () => {
    const store = new AccountingStore({ root: tempRoot('gap') });
    store.record('token', {
        provider: 'acme', responseId: 'x', servedModel: 'claude-haiku-4-5-20251001',
        source: 'acme.usageMetadata', exact: true,
        observedAt: '2026-09-01T12:00:00.000Z',
        tokens: normalizeUsage({ input_tokens: 404, output_tokens: 7 }),
    });
    const q = store.query('all', 0);
    assert.equal(q.cost.total, 0);
    assert.equal(q.cost.unpricedResponses, 1);
    assert.equal(q.cost.unpricedTokens, 411);
    assert.equal(q.models[0].cost.unpricedResponses, 1);
});

test('the cache TTL split reaches the rollup and changes the bill', () => {
    const store = new AccountingStore({ root: tempRoot('ttl') });
    const write = (id, cacheCreation) => store.record('token', {
        provider: 'claude', responseId: id, servedModel: 'claude-opus-5',
        source: 'anthropic.message.usage', exact: true,
        observedAt: '2026-09-01T12:00:00.000Z',
        tokens: normalizeUsage({ input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 1_000_000, cache_creation: cacheCreation }),
    });
    write('short', { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 });
    write('long', { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 });

    const q = store.query('all', 0);
    near(q.cost.cacheWrite, 6.25 + 10.00, 'both TTLs billed at their own rate');
    assert.equal(q.totals.cacheCreation5mTokens, 1_000_000);
    assert.equal(q.totals.cacheCreation1hTokens, 1_000_000);
});

test('cost is derived on read, so it is absent from the rollup on disk', () => {
    // The guarantee that makes a price correction retroactive: nothing on disk
    // encodes dollars, so there is no stale money to migrate.
    const root = tempRoot('derived');
    const store = new AccountingStore({ root });
    record(store, { responseId: 'a', observedAt: '2026-09-01T12:00:00.000Z' });
    store.query('all', 0);
    const rollups = path.join(root, 'rollups');
    for (const name of fs.readdirSync(rollups))
    {
        const raw = fs.readFileSync(path.join(rollups, name), 'utf8');
        assert.ok(!/"cost"/.test(raw), `${name} must not persist a cost field`);
        assert.ok(!/costUsd/.test(raw), `${name} must not persist a cost field`);
    }
});
