// Command Code subscription limits from the same read-only billing surface used
// by the CLI's /usage overlay. The router keeps the API key; only sanitized
// quota fields leave this adapter.

import { finite } from '../../limits.mjs';

const SOURCE = 'command-code.alpha.billing';

function timestamp(value)
{
    const millis = typeof value === 'number' ? value
        : typeof value === 'string' ? Date.parse(value) : NaN;
    const date = new Date(millis);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizeWindow(value)
{
    if (!value || typeof value !== 'object') return null;
    const used = finite(value.used);
    const cap = finite(value.cap);
    const resetAt = timestamp(value.resetAt);
    if (used === null && cap === null && resetAt === null) return null;
    return { used, cap, resetAt };
}

function sanitizeWindowLimits(value)
{
    if (!value || typeof value !== 'object') return null;
    return {
        limited: value.limited === true,
        fiveHour: sanitizeWindow(value.fiveHour),
        weekly: sanitizeWindow(value.weekly),
    };
}

function sanitizeCredits(value)
{
    if (!value || typeof value !== 'object') return null;
    const monthlyCredits = finite(value.monthlyCredits);
    const purchasedCredits = finite(value.purchasedCredits);
    const freeCredits = finite(value.freeCredits);
    if (monthlyCredits === null && purchasedCredits === null && freeCredits === null) return null;
    const monthly = Math.max(0, monthlyCredits || 0);
    const purchased = Math.max(0, purchasedCredits || 0);
    const free = Math.max(0, freeCredits || 0);
    return {
        planId: typeof value.planId === 'string' ? value.planId : null,
        monthlyRemaining: monthly,
        purchasedRemaining: purchased,
        freeRemaining: free,
        totalRemaining: monthly + purchased + free,
    };
}

function sanitizeSpendLimit(value)
{
    if (!value || typeof value !== 'object') return null;
    const spent = finite(value.spent);
    const limit = finite(value.limit);
    if (spent === null && limit === null && value.exceeded !== true) return null;
    return {
        scope: typeof value.scope === 'string' ? value.scope : null,
        model: typeof value.model === 'string' ? value.model : null,
        modelLabel: typeof value.modelLabel === 'string' ? value.modelLabel : null,
        spent,
        limit,
        exceeded: value.exceeded === true,
        resetAt: timestamp(value.resetAt),
        resetInterval: typeof value.resetInterval === 'string' ? value.resetInterval : null,
    };
}

function sanitizeSpendLimits(value)
{
    return Array.isArray(value) ? value.map(sanitizeSpendLimit).filter(Boolean) : [];
}

async function responseJSON(response, label)
{
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    if (!response.ok)
        throw new Error(`${label} ${response.status}: ${String(value?.message || value?.error?.message || text).slice(0, 240)}`);
    if (value === null) throw new Error(`${label} returned non-JSON`);
    return value;
}

export class CommandCodeLimits
{
    constructor(options)
    {
        this.baseURL = String(options.baseURL || 'https://api.commandcode.ai').replace(/\/$/, '');
        this.getApiKey = options.getApiKey;
        this.fetch = options.fetch || ((...args) => fetch(...args));
    }

    async get(path, apiKey)
    {
        const response = await this.fetch(`${this.baseURL}${path}`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'User-Agent': 'claude-ui-mod/1.0',
            },
        });
        return responseJSON(response, `command-code ${path.split('?')[0]}`);
    }

    async safeGet(path, apiKey)
    {
        try { return { value: await this.get(path, apiKey), error: null }; }
        catch (error) { return { value: null, error: String(error?.message || error) }; }
    }

    async read()
    {
        const apiKey = this.getApiKey?.();
        if (!apiKey) throw new Error('command-code billing unavailable: no API key');

        const whoami = await this.safeGet('/alpha/whoami?limits=1', apiKey);
        const orgId = whoami.value?.org?.id;
        const suffix = orgId === undefined || orgId === null ? '' : `?orgId=${encodeURIComponent(String(orgId))}`;
        const [credits, subscription] = await Promise.all([
            this.safeGet(`/alpha/billing/credits${suffix}`, apiKey),
            this.safeGet(`/alpha/billing/subscriptions${suffix}`, apiKey),
        ]);
        const subscriptionValue = subscription.value?.data || subscription.value;
        const errors = {};
        if (whoami.error) errors.whoami = whoami.error;
        if (credits.error) errors.credits = credits.error;
        if (subscription.error) errors.subscription = subscription.error;

        return {
            source: SOURCE,
            exact: true,
            observedAt: new Date().toISOString(),
            credits: sanitizeCredits(credits.value?.credits),
            windowLimits: sanitizeWindowLimits(credits.value?.windowLimits),
            subscription: subscriptionValue ? {
                planId: typeof subscriptionValue.planId === 'string' ? subscriptionValue.planId : null,
                status: typeof subscriptionValue.status === 'string' ? subscriptionValue.status : null,
                currentPeriodStart: timestamp(subscriptionValue.currentPeriodStart),
                currentPeriodEnd: timestamp(subscriptionValue.currentPeriodEnd),
            } : null,
            orgLimits: sanitizeSpendLimits(whoami.value?.orgLimits),
            errors,
        };
    }
}

export { SOURCE, sanitizeCredits, sanitizeSpendLimit, sanitizeSpendLimits, sanitizeWindow, sanitizeWindowLimits };
