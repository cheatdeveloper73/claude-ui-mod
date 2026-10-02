// Provider-native account limits. Credentials stay in the router process; the
// renderer receives only the upstream quota fields and their observation time.
//
// Two sources feed this. The ChatGPT subscription window is read here, because
// the OpenAI arm is compiled into the router. Everything else comes from the
// adapter registry, keyed by each adapter's limitKey, so a backend the router
// does not ship still appears in the same payload under its own name. With no
// adapters loaded the payload carries `openai` alone, which is the shape the
// dashboard already handles for a provider that is not configured.

const jsonData = value => value?.data ?? value;

function finite(value)
{
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rateWindow(value)
{
    if (!value || typeof value !== 'object') return null;
    return {
        usedPercent: finite(value.used_percent),
        limitWindowSeconds: finite(value.limit_window_seconds),
        resetAfterSeconds: finite(value.reset_after_seconds),
        resetAt: finite(value.reset_at),
    };
}

function rateLimit(value)
{
    if (!value || typeof value !== 'object') return null;
    return {
        allowed: value.allowed === true,
        limitReached: value.limit_reached === true,
        primary: rateWindow(value.primary_window),
        secondary: rateWindow(value.secondary_window),
    };
}

function sanitizeOpenAI(value, observedAt)
{
    return {
        source: 'chatgpt.wham.usage',
        exact: true,
        observedAt,
        planType: typeof value?.plan_type === 'string' ? value.plan_type : null,
        rateLimit: rateLimit(value?.rate_limit),
        additionalRateLimits: Array.isArray(value?.additional_rate_limits)
            ? value.additional_rate_limits.map(item => ({
                name: typeof item?.limit_name === 'string' ? item.limit_name : null,
                feature: typeof item?.metered_feature === 'string' ? item.metered_feature : null,
                rateLimit: rateLimit(item?.rate_limit),
            }))
            : [],
        resetCredits: finite(value?.rate_limit_reset_credits?.available_count),
        // Usage credits are independent of subscription windows and reset credits.
        // Preserve only explicitly reported fields; absence is unknown.
        credits: value?.credits && typeof value.credits === 'object' ? {
            hasCredits: typeof value.credits.has_credits === 'boolean' ? value.credits.has_credits : null,
            unlimited: typeof value.credits.unlimited === 'boolean' ? value.credits.unlimited : null,
            overageLimitReached: typeof value.credits.overage_limit_reached === 'boolean' ? value.credits.overage_limit_reached : null,
            balance: typeof value.credits.balance === 'string' && /^\d+(?:\.\d+)?$/.test(value.credits.balance)
                ? value.credits.balance : finite(value.credits.balance),
        } : null,
    };
}

async function responseJSON(response, label)
{
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    if (!response.ok) throw new Error(`${label} ${response.status}: ${String(value?.message || value?.error?.message || text).slice(0, 240)}`);
    if (value === null) throw new Error(`${label} returned non-JSON`);
    return jsonData(value);
}

export class ProviderLimits
{
    constructor(options)
    {
        this.openAIUsageURL = options.openAIUsageURL;
        this.getOpenAIAuth = options.getOpenAIAuth;
        this.adapters = options.adapters || null;
        this.fetch = options.fetch || ((...args) => fetch(...args));
        // Provider accounts are metered and some are paid seats. Cache regular
        // reads so the dashboard and Desktop share one snapshot rather than
        // multiplying provider calls.
        this.cacheMs = options.cacheMs ?? 30000;
        this.cache = null;
        this.inflight = null;
    }

    async openAI()
    {
        const tokens = await this.getOpenAIAuth();
        const response = await this.fetch(this.openAIUsageURL, {
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
                'chatgpt-account-id': tokens.account_id,
                Accept: 'application/json',
                originator: 'codex_cli_rs',
            },
        });
        const observedAt = new Date().toISOString();
        return sanitizeOpenAI(await responseJSON(response, 'openai usage'), observedAt);
    }

    async refresh(force = false)
    {
        if (!force && this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.value;
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            const [openai, adapters] = await Promise.allSettled([
                this.openAI(),
                this.adapters ? this.adapters.limitSnapshots(force) : Promise.resolve({}),
            ]);
            const value = {
                version: 1,
                observedAt: new Date().toISOString(),
                openai: openai.status === 'fulfilled' ? openai.value : { error: String(openai.reason?.message || openai.reason) },
                ...(adapters.status === 'fulfilled' ? adapters.value : {}),
            };
            this.cache = { at: Date.now(), value };
            return value;
        })().finally(() => { this.inflight = null; });
        return this.inflight;
    }
}

export { sanitizeOpenAI, rateLimit, rateWindow, finite, responseJSON };
