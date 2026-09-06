import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, normalizeUsage } from '../router/telemetry.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-telemetry-'));
const file = path.join(temp, 'usage.jsonl');
const broken = path.join(temp, 'broken.jsonl');
after(() => { for (const f of [file, broken]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmdirSync(temp); });

test('normalization separates current context from output reasoning', () => {
    assert.deepEqual(normalizeUsage({
        input_tokens: 11,
        cache_read_input_tokens: 13,
        cache_creation_input_tokens: 17,
        output_tokens: 19,
        output_tokens_details: { thinking_tokens: 7 },
    }), {
        inputTokens: 11,
        cacheReadInputTokens: 13,
        cacheCreationInputTokens: 17,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        contextInputTokens: 41,
        outputTokens: 19,
        reasoningOutputTokens: 7,
        visibleOutputTokens: 12,
    });
});

test('ledger is durable and deduplicates provider response ids across restarts', () => {
    const first = new UsageLedger(file);
    const value = {
        provider: 'openai',
        responseId: 'resp_one',
        sessionId: 'session-one',
        requestedModel: 'gpt-requested',
        servedModel: 'gpt-served',
        effort: 'high',
        source: 'fixture.usage',
        exact: true,
        observedAt: '2026-08-30T00:00:00.000Z',
        usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 },
        rawUsage: { input_tokens: 12, input_tokens_details: { cached_tokens: 7 }, output_tokens: 3 },
    };
    assert.equal(first.record(value), true);
    assert.equal(first.record(value), false);

    const second = new UsageLedger(file);
    assert.equal(second.record(value), false);
    const snapshot = second.snapshot('session-one');
    assert.equal(snapshot.exactRecords, 1);
    assert.equal(snapshot.models[0].responses, 1);
    assert.equal(snapshot.models[0].contextInputTokens, 12);
    assert.equal(snapshot.sessions[0].latest.rawUsage.input_tokens, 12);
    assert.equal(JSON.stringify(snapshot).includes('prompt'), false);
});

test('a torn final line cannot consume the next durable record', () => {
    const first = new UsageLedger(broken);
    assert.equal(first.record({
        provider: 'gemini', responseId: 'gem_one', sessionId: 'session-two',
        requestedModel: 'gemini-requested', servedModel: 'gemini-served',
        source: 'fixture.usage', exact: true,
        usage: { input_tokens: 2, output_tokens: 1 },
    }), true);
    fs.appendFileSync(broken, '{"version":');

    const recovered = new UsageLedger(broken);
    assert.equal(recovered.record({
        provider: 'gemini', responseId: 'gem_two', sessionId: 'session-two',
        requestedModel: 'gemini-requested', servedModel: 'gemini-served',
        source: 'fixture.usage', exact: true,
        usage: { input_tokens: 3, output_tokens: 1 },
    }), true);
    assert.equal(new UsageLedger(broken).snapshot().exactRecords, 2);
});
