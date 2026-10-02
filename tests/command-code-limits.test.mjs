import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandCodeLimits } from '../router/adapters/command-code/limits.mjs';

function json(value, status = 200)
{
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(value),
    };
}

test('Command Code limits reads the CLI billing surface and returns only sanitized quota data', async () => {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/alpha/whoami?limits=1')) return json({
            user: { id: 'private-user', email: 'private@example.com' },
            org: { id: 'org-123', login: 'private-org' },
            orgLimits: [
                { scope: 'org', spent: 12, limit: 50, exceeded: false,
                    resetAt: '2026-10-01T00:00:00Z', resetInterval: 'monthly' },
                { scope: 'model', model: 'glm-5.3-flash', modelLabel: 'GLM 5.3 Flash', spent: 4, limit: 10,
                    exceeded: false, resetAt: '2026-10-01T00:00:00Z', resetInterval: 'monthly' },
            ],
        });
        if (url.endsWith('/alpha/billing/credits?orgId=org-123')) return json({
            credits: { planId: 'goat', monthlyCredits: 1.5, purchasedCredits: 2, freeCredits: 0.5 },
            windowLimits: {
                limited: true,
                fiveHour: { used: 3, cap: 10, resetAt: 1789835512284 },
                weekly: { used: 20, cap: 100, resetAt: '2026-09-20T00:00:00Z' },
            },
        });
        if (url.endsWith('/alpha/billing/subscriptions?orgId=org-123')) return json({
            success: true,
            data: { planId: 'goat', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z',
                currentPeriodEnd: '2026-10-01T00:00:00Z' },
        });
        return json({ error: { message: 'unexpected URL' } }, 404);
    };
    const limits = new CommandCodeLimits({
        baseURL: 'https://api.commandcode.test',
        getApiKey: () => 'secret-command-key',
        fetch,
    });

    const value = await limits.read();

    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer secret-command-key'));
    assert.equal(value.source, 'command-code.alpha.billing');
    assert.equal(value.exact, true);
    assert.deepEqual(value.credits, {
        planId: 'goat', monthlyRemaining: 1.5, purchasedRemaining: 2, freeRemaining: 0.5, totalRemaining: 4,
    });
    assert.equal(value.windowLimits.fiveHour.used, 3);
    assert.equal(value.windowLimits.fiveHour.cap, 10);
    assert.equal(value.windowLimits.fiveHour.resetAt, '2026-09-19T16:31:52.284Z');
    assert.equal(value.windowLimits.weekly.resetAt, '2026-09-20T00:00:00.000Z');
    assert.equal(value.subscription.status, 'active');
    assert.equal(value.orgLimits.length, 2);
    assert.equal(value.orgLimits[1].model, 'glm-5.3-flash');
    const serialized = JSON.stringify(value);
    for (const forbidden of ['secret-command-key', 'private-user', 'private@example.com', 'private-org'])
        assert.equal(serialized.includes(forbidden), false);
});

test('Command Code limits preserve usable partial data when one billing endpoint fails', async () => {
    const fetch = async url => {
        if (url.endsWith('/alpha/whoami?limits=1')) return json({ org: { id: 'org-123' }, orgLimits: [] });
        if (url.includes('/alpha/billing/credits')) return json({
            credits: { planId: 'goat', monthlyCredits: 0, purchasedCredits: 3, freeCredits: 0 },
            windowLimits: { limited: false },
        });
        if (url.includes('/alpha/billing/subscriptions')) return json({ error: { message: 'temporary failure' } }, 503);
        return json({}, 404);
    };
    const limits = new CommandCodeLimits({ baseURL: 'https://api.commandcode.test', getApiKey: () => 'key', fetch });

    const value = await limits.read();

    assert.equal(value.credits.totalRemaining, 3);
    assert.equal(value.subscription, null);
    assert.match(value.errors.subscription, /503/);
});
