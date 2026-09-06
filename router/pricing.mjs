// What the traffic we actually sent would have cost through each provider's
// paid API, priced from the token counts the accounting store already holds.
//
// Cost is never stored. It is recomputed from tokens on every read, which is
// what makes a price correction retroactive for free: fix a number here and
// every historical day is right on the next request, with no migration and no
// rollup rebuild. Storing dollars would have made the table a schema.
//
// Rates are USD per 1,000,000 tokens and carry the window they are in force
// for, because providers change prices on announced dates. A record from
// August must be priced at August's rate even when read in December.

import crypto from 'node:crypto';

// A period runs [from, to) on the record's observation date. `null` is open.
// cacheWrite5m / cacheWrite1h differ only where the provider sells the cache
// entry's lifetime; elsewhere they are equal and the distinction never fires.
const RATES = {
    // OpenAI, standard tier, short-context bracket. Verified against
    // platform.openai.com/docs/pricing on 2026-09-03, which prices input
    // beyond 272k tokens at roughly 2x; the rollup constraint above applies
    // here too, so these are floors for conversations that cross the bracket.
    // Sol's rate is promotional at least through 2026-11-21 -- revisit then
    // rather than guessing the successor rate. Cache writes bill at 1.25x
    // input; our openai records carry no cache creation, so that multiplier
    // is carried for completeness, not use.
    'openai/gpt-6-astra': [
        { from: null, to: null,
          input: 10.00, cacheRead: 1.00, cacheWrite5m: 12.50, cacheWrite1h: 12.50, output: 50.00 },
    ],
    'openai/gpt-5.6-sol': [
        { from: null, to: null,
          input: 4.00, cacheRead: 0.40, cacheWrite5m: 5.00, cacheWrite1h: 5.00, output: 20.00 },
    ],
    'openai/gpt-5.6-terra': [
        { from: null, to: null,
          input: 2.00, cacheRead: 0.20, cacheWrite5m: 2.50, cacheWrite1h: 2.50, output: 12.00 },
    ],
    'openai/gpt-5.6-luna': [
        { from: null, to: null,
          input: 0.20, cacheRead: 0.02, cacheWrite5m: 0.25, cacheWrite1h: 0.25, output: 1.20 },
    ],

    // Anthropic first-party API. Verified against
    // docs.claude.com/en/docs/about-claude/pricing on 2026-09-03. Cache reads
    // bill at 0.1x input -- 0.025x on Fable 5.1 specifically -- and cache
    // writes at 1.25x for the 5-minute TTL and 2x for the 1-hour TTL.
    'claude/claude-opus-5': [
        { from: null, to: null,
          input: 5.00, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10.00, output: 25.00 },
    ],
    'claude/claude-opus-4-6': [
        { from: null, to: null,
          input: 5.00, cacheRead: 0.50, cacheWrite5m: 6.25, cacheWrite1h: 10.00, output: 25.00 },
    ],
    'claude/claude-sonnet-5': [
        // The $2 launch price was published as introductory through
        // 2026-08-31, and this table briefly carried a $3/$15 step from
        // 2026-09-01. The page now states that increase will not occur and
        // $2 is the standard price; the step was retracted on 2026-09-03.
        { from: null, to: null,
          input: 2.00, cacheRead: 0.20, cacheWrite5m: 2.50, cacheWrite1h: 4.00, output: 10.00 },
    ],
    'claude/claude-haiku-4-5': [
        { from: null, to: null,
          input: 1.00, cacheRead: 0.10, cacheWrite5m: 1.25, cacheWrite1h: 2.00, output: 5.00 },
    ],
    'claude/claude-fable-5': [
        { from: null, to: null,
          input: 10.00, cacheRead: 1.00, cacheWrite5m: 12.50, cacheWrite1h: 20.00, output: 50.00 },
    ],
    'claude/claude-fable-5-1': [
        { from: null, to: null,
          input: 10.00, cacheRead: 0.25, cacheWrite5m: 12.50, cacheWrite1h: 20.00, output: 50.00 },
    ],

    // Meta direct API, verified 2026-09-05 against the single-provider Meta
    // listings. The authenticated model endpoint confirms both exact ids but
    // exposes no rate fields. Meta publishes no cache-write charge, and every
    // stored Meta record has zero cache creation, so that absent operation stays
    // zero rather than borrowing an input multiplier from another provider.
    'meta/muse-spark-1.3': [
        { from: null, to: null,
          input: 1.25, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0, output: 4.25 },
    ],
    'meta/muse-spark-1.3-contributor': [
        { from: null, to: null,
          input: 0.10, cacheRead: 0.002, cacheWrite5m: 0, cacheWrite1h: 0, output: 0.20 },
    ],

    // Retired Qwen traffic remains in the accounting ledger. These entries only
    // price those historical records; the model catalogue and fail-closed route
    // remain untouched. All three Nexus aliases named the same qwen3.8-max
    // upstream id, whose published international standard rate is $2/$6. No
    // stored record carries cache usage, but the published implicit-cache and
    // explicit-cache-creation prices are retained for complete arithmetic.
    'qwen/Qwen3.8-Max-agent': [
        { from: null, to: null,
          input: 2.00, cacheRead: 0.25, cacheWrite5m: 2.50, cacheWrite1h: 2.50, output: 6.00 },
    ],
    'qwen/Qwen3.8-Max-fast-agent': [
        { from: null, to: null,
          input: 2.00, cacheRead: 0.25, cacheWrite5m: 2.50, cacheWrite1h: 2.50, output: 6.00 },
    ],
    'qwen/Qwen3.8-Max-thinking-agent': [
        { from: null, to: null,
          input: 2.00, cacheRead: 0.25, cacheWrite5m: 2.50, cacheWrite1h: 2.50, output: 6.00 },
    ],

    // NanoGPT, prepaid per request. Verified against its model registry
    // (https://nano-gpt.com/api/models) on 2026-09-03; the registry numbers are
    // re-checked by scripts/nanogpt-sync.mjs, which reports drift with the
    // block to apply. No cache-write premium is published, so a cache write
    // prices as plain input. Records key on the served model, which echoes the
    // bare slug we send, not the vendored z-ai/ id the registry lists.
    'nanogpt/glm-5.3-flash': [
        { from: null, to: null,
          input: 0.075, cacheRead: 0.015, cacheWrite5m: 0.075, cacheWrite1h: 0.075, output: 0.25 },
    ],
};

// Where a record predates the cache-TTL split being captured, the whole cache
// write is priced at this TTL. Measured, not assumed: across 14,589 Anthropic
// usage objects on disk, every cache write was ephemeral_1h and none was 5m.
const DEFAULT_CACHE_TTL = { claude: '1h', openai: '5m' };
const FALLBACK_CACHE_TTL = '5m';

// An adapter adds a provider, so it has to be able to price it -- otherwise its
// traffic reads as a permanent gap in the bill. Rates registered here are
// keyed and dated exactly like the built-in table and are looked up the same
// way, so a correction to an adapter's number is retroactive for free too.
//
// Registration happens once at adapter load, before the server takes a request.
// A later call replacing an existing key is allowed and simply wins: that is
// how a running deployment corrects a rate without a restart.
const TIER_IN_MODEL_ID = new Set();

const fingerprint = () => crypto.createHash('sha256')
    .update(JSON.stringify(RATES)).digest('hex').slice(0, 12);
export let PRICING_FINGERPRINT = fingerprint();

// Some backends spend the effort tier on the model id rather than on a request
// field (`a-model:high` -> `a-model-high`), and price the whole family flat
// across tiers -- the published output price is stated as including thinking
// tokens. The suffix is the same SKU, not a neighbour, so it
// folds into the family rate. Registered rather than hardcoded, and scoped to
// the providers that declare it, so an effort tier some other provider might
// one day put in an id is never silently merged.
const TIER_SUFFIX = /-(?:high|medium|low|tiered)$/;

export function registerRates(rates, cacheTTL = {}, options = {})
{
    for (const provider of options.tierInModelId || []) TIER_IN_MODEL_ID.add(provider);
    for (const [key, periods] of Object.entries(rates || {}))
    {
        if (!Array.isArray(periods) || !periods.length) throw new Error(`rate ${key} must be a non-empty period list`);
        RATES[key] = periods;
    }
    for (const [provider, ttl] of Object.entries(cacheTTL || {}))
    {
        if (ttl !== '5m' && ttl !== '1h') throw new Error(`cache TTL for ${provider} must be 5m or 1h`);
        DEFAULT_CACHE_TTL[provider] = ttl;
    }
    PRICING_FINGERPRINT = fingerprint();
}

// A dated snapshot ID prices as its family. Anything else is left alone, so an
// unrecognised model surfaces as unpriced rather than being coerced into a
// neighbouring model's rate.
const DATED_SUFFIX = /-\d{8}$/;

export function canonicalModel(model, provider)
{
    const name = String(model || '').trim();
    if (!name) return '';
    const dated = name.replace(DATED_SUFFIX, '');
    return TIER_IN_MODEL_ID.has(provider) ? dated.replace(TIER_SUFFIX, '') : dated;
}

export function rateKey(provider, model)
{
    const p = String(provider || '').trim();
    return p + '/' + canonicalModel(model, p);
}

export function rateFor(provider, model, observedAt)
{
    const periods = RATES[rateKey(provider, model)];
    if (!periods) return null;
    const day = String(observedAt || '').slice(0, 10);
    for (const period of periods)
    {
        if (period.from && day && day < period.from) continue;
        if (period.to && day && day >= period.to) continue;
        return period;
    }
    return null;
}

const num = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

// Splits a cache-write total across the two TTL prices. Records written before
// the split was captured report only the total; that remainder is priced at
// the provider's measured default rather than silently at the cheaper rate.
function cacheWriteCost(tokens, rate, provider)
{
    const known5m = num(tokens?.cacheCreation5mTokens);
    const known1h = num(tokens?.cacheCreation1hTokens);
    const total = num(tokens?.cacheCreationInputTokens);
    const residual = Math.max(0, total - known5m - known1h);
    const ttl = DEFAULT_CACHE_TTL[provider] || FALLBACK_CACHE_TTL;
    const fallback = ttl === '1h' ? rate.cacheWrite1h : rate.cacheWrite5m;
    return (known5m * rate.cacheWrite5m + known1h * rate.cacheWrite1h + residual * fallback) / 1e6;
}

// `tokens` is any TOTAL_KEYS-shaped object: one response, or a whole day's
// aggregate for one model. Same arithmetic either way, which is why cost can
// be derived from the rollup instead of from every raw record.
export function costOfTokens(provider, model, tokens, observedAt)
{
    const rate = rateFor(provider, model, observedAt);
    if (!rate) return null;
    const input = num(tokens?.inputTokens) * rate.input / 1e6;
    const cacheRead = num(tokens?.cacheReadInputTokens) * rate.cacheRead / 1e6;
    const cacheWrite = cacheWriteCost(tokens, rate, provider);
    const output = num(tokens?.outputTokens) * rate.output / 1e6;
    return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

export function emptyCost()
{
    return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0,
        unpricedResponses: 0, unpricedTokens: 0 };
}

export function addCost(target, cost)
{
    for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'total'])
        target[key] = (target[key] || 0) + (cost?.[key] || 0);
    return target;
}

// Folds one model's slice of one day into a cost accumulator. A model with no
// rate is counted as unpriced instead of contributing zero, so an unrecognised
// model reads as a gap in the bill rather than as free traffic.
export function foldCost(target, provider, model, tokens, observedAt)
{
    const cost = costOfTokens(provider, model, tokens, observedAt);
    if (!cost)
    {
        target.unpricedResponses = (target.unpricedResponses || 0) + num(tokens?.responses);
        target.unpricedTokens = (target.unpricedTokens || 0)
            + num(tokens?.contextInputTokens) + num(tokens?.outputTokens);
        return target;
    }
    return addCost(target, cost);
}

export function pricedModels()
{
    return Object.keys(RATES).sort();
}

// PRICING_FINGERPRINT is a live binding because adapter registration extends
// this table after the shared module itself has evaluated.

export { RATES, DEFAULT_CACHE_TTL };
