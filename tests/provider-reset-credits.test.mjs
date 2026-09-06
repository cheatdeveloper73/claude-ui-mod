import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResetCredits } from '../router/reset-credits.mjs';

function window(usedPercent, limitWindowSeconds, resetAt = 1789161841) {
    return { usedPercent, limitWindowSeconds, resetAfterSeconds: null, resetAt };
}

function limitsValue({ primary = window(59, 604800), secondary = null, limitReached = false, credits = 1, additional = [] } = {}) {
    return { version: 1, observedAt: '2026-09-06T01:00:00.000Z', openai: {
        source: 'chatgpt.wham.usage', exact: true, planType: 'pro',
        rateLimit: { allowed: !limitReached, limitReached, primary, secondary },
        additionalRateLimits: additional,
        resetCredits: credits,
    } };
}

function harness(value, options = {}) {
    const calls = [];
    const credits = new ResetCredits({
        limits: { refresh: async () => value },
        rpc: async (method, params) => { calls.push({ method, params }); return { outcome: options.outcome ?? 'reset' }; },
        log: () => {},
        journalFile: options.journalFile ?? null,
        now: options.now,
        ...options.construct,
    });
    return { credits, calls };
}

test('a 429 with no window at its limit spends nothing', async () => {
    const { credits, calls } = harness(limitsValue({ primary: window(99, 604800) }));
    const attempt = await credits.attempt({ reason: 'upstream 429' });
    assert.equal(attempt.outcome, 'skipped');
    assert.match(attempt.reason, /at its limit/);
    assert.equal(calls.length, 0, 'the consume endpoint must not be called on a near-full window');
});

test('an exhausted window with a credit redeems exactly one reset', async () => {
    const journalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reset-')), 'reset-credits.jsonl');
    const { credits, calls } = harness(limitsValue({ primary: window(100, 604800) }), { journalFile });
    const attempt = await credits.attempt({ reason: 'upstream 429' });

    assert.equal(attempt.outcome, 'reset');
    assert.equal(attempt.scope, 'primary');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'account/rateLimitResetCredit/consume');
    assert.match(calls[0].params.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(journal.length, 1);
    assert.equal(journal[0].outcome, 'reset');
});

// limit_reached is the provider saying so outright; a used_percent that has not
// yet ticked to 100 must not make that read as "not exhausted".
test('limitReached is exhaustion on its own', async () => {
    const { credits, calls } = harness(limitsValue({ primary: window(99.6, 604800), limitReached: true }));
    assert.equal((await credits.attempt({ reason: 'upstream 429' })).outcome, 'reset');
    assert.equal(calls.length, 1);
});

test('no credit available means no call at all', async () => {
    const { credits, calls } = harness(limitsValue({ primary: window(100, 604800), credits: 0 }));
    const attempt = await credits.attempt({ reason: 'upstream 429' });
    assert.equal(attempt.outcome, 'skipped');
    assert.match(attempt.reason, /no reset credit/);
    assert.equal(calls.length, 0);
});

test('concurrent asks collapse onto one redemption', async () => {
    const { credits, calls } = harness(limitsValue({ primary: window(100, 604800) }));
    const results = await Promise.all([
        credits.attempt({ reason: 'upstream 429' }),
        credits.attempt({ reason: 'upstream 429' }),
        credits.attempt({ reason: 'upstream 429' }),
    ]);
    assert.equal(calls.length, 1);
    for (const result of results) assert.equal(result.outcome, 'reset');
});

// The in-memory guard dies with the worker; the derived key is what stops a
// blue-green swap mid-episode from spending a second credit on one window.
test('the idempotency key is a function of the window, not of the process', async () => {
    const value = limitsValue({ primary: window(100, 604800, 1789161841) });
    const first = harness(value);
    const second = harness(value);
    await first.credits.attempt({ reason: 'upstream 429' });
    await second.credits.attempt({ reason: 'upstream 429' });
    assert.equal(first.calls[0].params.idempotencyKey, second.calls[0].params.idempotencyKey);

    const other = harness(limitsValue({ primary: window(100, 604800, 1789766641) }));
    await other.credits.attempt({ reason: 'upstream 429' });
    assert.notEqual(other.calls[0].params.idempotencyKey, first.calls[0].params.idempotencyKey);
});

test('a redemption inside the cooldown is refused', async () => {
    let clock = 1_757_000_000_000;
    const journalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reset-')), 'reset-credits.jsonl');
    const { credits, calls } = harness(limitsValue({ primary: window(100, 604800) }),
        { journalFile, now: () => clock, construct: { cooldownMs: 300000 } });

    assert.equal((await credits.attempt({ reason: 'upstream 429' })).outcome, 'reset');
    clock += 60000;
    const second = await credits.attempt({ reason: 'upstream 429' });
    assert.equal(second.outcome, 'skipped');
    assert.match(second.reason, /cooldown/);
    assert.equal(calls.length, 1);

    // The journal is the durable half: a fresh instance reading it must refuse
    // for the same reason a surviving one does.
    const fresh = new ResetCredits({
        limits: { refresh: async () => limitsValue({ primary: window(100, 604800) }) },
        rpc: async () => { throw new Error('a fresh worker must not redeem inside the cooldown'); },
        journalFile, now: () => clock,
    });
    assert.equal((await fresh.attempt({ reason: 'upstream 429' })).outcome, 'skipped');
});

// A five-hour bucket and the weekly bucket can both read full. Only the weekly
// one is worth a credit; the short one returns on its own within the hour.
test('the longest exhausted window is the one redeemed for', async () => {
    const { credits } = harness(limitsValue({
        primary: window(100, 18000),
        additional: [{ name: 'weekly', feature: 'weekly', rateLimit: {
            allowed: false, limitReached: true, primary: window(100, 604800, 1789264035), secondary: null } }],
    }));
    const attempt = await credits.attempt({ reason: 'upstream 429' });
    assert.equal(attempt.scope, 'weekly:primary');
});

test('state reports the credit, the exhaustion and the redemption history', async () => {
    const { credits } = harness(limitsValue({ primary: window(100, 604800) }));
    await credits.attempt({ reason: 'upstream 429' });
    const state = await credits.state();
    assert.equal(state.credits, 1);
    assert.equal(state.exhausted.scope, 'primary');
    assert.equal(state.lastReset.outcome, 'reset');
    assert.equal(state.attempts.length, 1);
});
