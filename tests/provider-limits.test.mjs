import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderLimits } from '../router/limits.mjs';

function reply(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

const WHAM = {
    plan_type: 'prolite',
    rate_limit: { allowed: true, limit_reached: false,
        primary_window: { used_percent: 8.125, limit_window_seconds: 604800, reset_after_seconds: 50, reset_at: 1788651675 },
        secondary_window: null },
    additional_rate_limits: [],
    rate_limit_reset_credits: { available_count: 0 },
    email: 'must-not-escape@example.test',
};

test('OpenAI limits preserve precision and expose no credentials', async () => {
    const calls = [];
    const fetch = async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/wham/usage')) return reply(WHAM);
        throw new Error('unexpected fixture URL ' + url);
    };
    const limits = new ProviderLimits({
        openAIUsageURL: 'http://openai.test/wham/usage',
        getOpenAIAuth: async () => ({ access_token: 'openai-token-secret', account_id: 'openai-account-secret' }),
        fetch, cacheMs: 60000,
    });

    const value = await limits.refresh();
    assert.equal(value.openai.rateLimit.primary.usedPercent, 8.125);
    assert.equal(value.openai.rateLimit.secondary, null);
    assert.equal(value.openai.planType, 'prolite');

    // The upstream payload carries the account email and the request carries
    // the bearer token. Neither may reach a renderer.
    const serialized = JSON.stringify(value);
    for (const secret of ['openai-token-secret', 'openai-account-secret', 'must-not-escape'])
        assert.equal(serialized.includes(secret), false);

    const before = calls.length;
    assert.equal(await limits.refresh(), value);
    assert.equal(calls.length, before, 'a cached read must not call the provider again');
});

test('the payload carries adapter snapshots under their own limitKey', async () => {
    let forced = null;
    const adapters = { limitSnapshots: async (force) => { forced = force; return {
        acme: { source: 'acme.fixture', observedAt: '2026-08-30T05:42:10Z', accounts: [{ id: 1 }] },
    }; } };
    const limits = new ProviderLimits({
        openAIUsageURL: 'http://openai.test/wham/usage',
        getOpenAIAuth: async () => ({ access_token: 't', account_id: 'a' }),
        fetch: async () => reply(WHAM),
        adapters, cacheMs: 0,
    });

    const value = await limits.refresh();
    assert.equal(value.acme.accounts.length, 1);
    assert.equal(value.acme.source, 'acme.fixture');
    assert.ok(value.openai, 'the built-in arm survives alongside an adapter');

    await limits.refresh(true);
    assert.equal(forced, true, 'force must reach the adapter, not just the built-in arm');
});

test('with no adapters the payload is the built-in arm alone', async () => {
    const limits = new ProviderLimits({
        openAIUsageURL: 'http://openai.test/wham/usage',
        getOpenAIAuth: async () => ({ access_token: 't', account_id: 'a' }),
        fetch: async () => reply(WHAM),
        cacheMs: 0,
    });
    const value = await limits.refresh();
    assert.deepEqual(Object.keys(value).sort(), ['observedAt', 'openai', 'version']);
});

// One unreachable source must not empty the payload: the dashboard still has
// to render everything that did answer, and say so about the one that did not.
test('a failing source reports its error in its own slot', async () => {
    const adapters = { limitSnapshots: async () => ({ acme: { error: 'acme gateway refused' } }) };
    const limits = new ProviderLimits({
        openAIUsageURL: 'http://openai.test/wham/usage',
        getOpenAIAuth: async () => { throw new Error('no chatgpt credential'); },
        fetch: async () => reply(WHAM),
        adapters, cacheMs: 0,
    });
    const value = await limits.refresh();
    assert.match(value.openai.error, /no chatgpt credential/);
    assert.match(value.acme.error, /acme gateway refused/);
    assert.equal(value.version, 1);
});

test('an adapter that throws cannot take the whole payload down', async () => {
    const adapters = { limitSnapshots: async () => { throw new Error('registry exploded'); } };
    const limits = new ProviderLimits({
        openAIUsageURL: 'http://openai.test/wham/usage',
        getOpenAIAuth: async () => ({ access_token: 't', account_id: 'a' }),
        fetch: async () => reply(WHAM),
        adapters, cacheMs: 0,
    });
    const value = await limits.refresh();
    assert.equal(value.openai.rateLimit.primary.usedPercent, 8.125);
});
