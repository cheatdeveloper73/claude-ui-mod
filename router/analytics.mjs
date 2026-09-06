// Usage intelligence joins provider quota snapshots with exact terminal token
// records. Quotas remain provider-owned; forecasts are derived only from
// observed movement and never invent a nominal token allowance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Claude's own history file records utilization but never reset times, so a
// Claude window could not tell whether it would exhaust or simply reset. The
// path is resolved per call: reading it at module load left the default inert
// in the router and forced every test to re-import the module.
const DEFAULT_CLAUDE_RESETS_FILE = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '.state', 'claude-plan-resets.json');
const claudeResetsFile = () => process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE || DEFAULT_CLAUDE_RESETS_FILE;

const CLAUDE_BUCKETS = {
    fh: { id: 'five_hour', label: 'Session · 5 hour' },
    sd: { id: 'seven_day', label: 'Weekly · all models' },
    so: { id: 'seven_day_opus', label: 'Weekly · Opus' },
    sn: { id: 'seven_day_sonnet', label: 'Weekly · Sonnet' },
    oa: { id: 'seven_day_oauth_apps', label: 'Weekly · OAuth apps' },
    cw: { id: 'seven_day_cowork', label: 'Weekly · Cowork' },
    om: { id: 'seven_day_omelette', label: 'Weekly · Omelette' },
    op: { id: 'omelette_promotional', label: 'Omelette promotional' },
    xu: { id: 'extra_usage', label: 'Extra usage' },
};

// Window length in seconds, used to discard samples recorded before the
// current window began.
const CLAUDE_WINDOW_SECONDS = {
    five_hour: 18000,
    seven_day: 604800,
    seven_day_opus: 604800,
    seven_day_sonnet: 604800,
    seven_day_oauth_apps: 604800,
    seven_day_cowork: 604800,
    seven_day_omelette: 604800,
};

const HORIZONS = [5, 15, 30, 60, 120];
const HISTORY_LIMIT = 20000;
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const HISTORY_HEARTBEAT_MS = 5 * 60 * 1000;

// Keys the limits payload uses for things that are not an account pool.
const NON_POOL_KEYS = new Set(['version', 'observedAt', 'openai']);

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clampPercent = value => finite(value) === null ? null : Math.max(0, Math.min(100, value));

function iso(value)
{
    if (typeof value === 'number')
    {
        const millis = value > 1e11 ? value : value > 1e8 ? value * 1000 : NaN;
        return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
    }
    if (typeof value !== 'string' || !value) return null;
    const millis = Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function openAIWindow(rows, window, key, label, observedAt, accountName, feature = null)
{
    if (!window || finite(window.usedPercent) === null) return;
    const usedPercent = clampPercent(window.usedPercent);
    rows.push({
        key: `openai:chatgpt:${key}`,
        provider: 'openai',
        accountId: 'chatgpt',
        accountName,
        quotaId: key,
        label,
        model: feature,
        usedPercent,
        remainingFraction: 1 - usedPercent / 100,
        resetAt: iso(window.resetAt) || (finite(window.resetAfterSeconds) === null
            ? null : new Date(Date.parse(observedAt) + window.resetAfterSeconds * 1000).toISOString()),
        observedAt,
        source: 'chatgpt.wham.usage',
        exact: true,
        windowSeconds: finite(window.limitWindowSeconds),
        schedulable: window.limitReached !== true,
        aggregate: true,
    });
}

function quotaPercent(quota)
{
    if (finite(quota?.utilization) !== null) return clampPercent(quota.utilization);
    if (finite(quota?.remainingFraction) !== null) return clampPercent((1 - quota.remainingFraction) * 100);
    return null;
}

const EMPTY_CLAUDE_LIMITS = { resets: {}, scoped: [], observedAt: null };

function readClaudeLimits(file)
{
    if (!file) return EMPTY_CLAUDE_LIMITS;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return EMPTY_CLAUDE_LIMITS; }
    if (doc?.version !== 1 || !doc.buckets || typeof doc.buckets !== 'object') return EMPTY_CLAUDE_LIMITS;

    const resets = {};
    for (const [name, value] of Object.entries(doc.buckets))
    {
        const at = iso(value?.resetsAt);
        if (at) resets[name] = at;
    }

    const scoped = [];
    for (const item of Array.isArray(doc.scoped) ? doc.scoped : [])
    {
        const percent = clampPercent(item?.percent);
        if (!item?.model || percent === null) continue;
        scoped.push({
            model: String(item.model).slice(0, 96),
            percent,
            // A scoped weekly limit carries no reset of its own. It belongs to
            // the weekly group, so it empties when that group's window does.
            resetAt: iso(item.resetsAt) || (item.group === 'weekly' ? resets.seven_day || null : null),
            severity: item.severity ? String(item.severity).slice(0, 32) : null,
        });
    }
    return { resets, scoped, observedAt: iso(doc.observedAt) };
}

export function normalizeLimitRows(limits, claude)
{
    const rows = [];
    const plan = claude?.current;
    if (plan)
    {
        const claudeLimits = readClaudeLimits(claudeResetsFile());
        for (const [bucket, meta] of Object.entries(CLAUDE_BUCKETS))
        {
            const usedPercent = clampPercent(plan.usage?.[bucket]);
            if (usedPercent === null) continue;
            rows.push({
                key: `claude:${plan.org || 'current'}:${bucket}`,
                provider: 'claude',
                accountId: plan.org || 'current',
                accountName: 'Claude plan',
                quotaId: meta.id,
                label: meta.label,
                model: bucket === 'so' ? 'opus' : bucket === 'sn' ? 'sonnet' : null,
                usedPercent,
                remainingFraction: 1 - usedPercent / 100,
                resetAt: claudeLimits.resets[meta.id] || null,
                windowSeconds: CLAUDE_WINDOW_SECONDS[meta.id] ?? null,
                observedAt: plan.observedAt,
                source: 'claude.plan-usage-history',
                exact: true,
                schedulable: usedPercent < 100,
                aggregate: true,
            });
        }

        // Per-model weekly limits exist only in the usage response's limits[]
        // array. There is no bucket for them, so without this they are the one
        // Claude limit the interface can never show.
        for (const item of claudeLimits.scoped)
        {
            rows.push({
                key: `claude:${plan.org || 'current'}:weekly_scoped:${item.model}`,
                provider: 'claude',
                accountId: plan.org || 'current',
                accountName: 'Claude plan',
                quotaId: `weekly_scoped:${item.model}`,
                label: `Weekly · ${item.model}`,
                model: item.model,
                usedPercent: item.percent,
                remainingFraction: 1 - item.percent / 100,
                resetAt: item.resetAt,
                windowSeconds: CLAUDE_WINDOW_SECONDS.seven_day,
                // Observed when the response was captured, which is its own
                // cadence, not when the plan history file was last written.
                observedAt: claudeLimits.observedAt || plan.observedAt,
                source: 'claude.plan-usage-limits',
                exact: true,
                schedulable: item.percent < 100,
                severity: item.severity,
                aggregate: true,
            });
        }
    }

    const openai = limits?.openai;
    if (openai && !openai.error)
    {
        const observedAt = iso(openai.observedAt) || new Date().toISOString();
        const accountName = `ChatGPT ${openai.planType || 'account'}`;
        openAIWindow(rows, openai.rateLimit?.primary, 'primary', 'Primary window', observedAt, accountName);
        openAIWindow(rows, openai.rateLimit?.secondary, 'secondary', 'Secondary window', observedAt, accountName);
        for (const [index, item] of (openai.additionalRateLimits || []).entries())
        {
            const name = item.name || item.feature || `Additional limit ${index + 1}`;
            openAIWindow(rows, item.rateLimit?.primary, `additional:${item.feature || item.name || index}:primary`, name, observedAt, accountName, item.feature);
            openAIWindow(rows, item.rateLimit?.secondary, `additional:${item.feature || item.name || index}:secondary`, `${name} · secondary`, observedAt, accountName, item.feature);
        }
    }

    // Account pools. Any provider whose limits snapshot carries an `accounts`
    // array is rendered the same way, so a backend the router does not ship
    // gets per-account meters and a pool average without naming itself here.
    // The snapshot carries its own meter policy -- which quota ids are worth a
    // history row, what the pool is called, how a served model maps onto a
    // quota name -- because only the adapter knows the backend.
    for (const [provider, snapshot] of Object.entries(limits || {}))
    {
        if (NON_POOL_KEYS.has(provider) || !Array.isArray(snapshot?.accounts)) continue;

        const tracked = Array.isArray(snapshot.trackedQuotas) ? new Set(snapshot.trackedQuotas) : null;
        const aliases = Array.isArray(snapshot.modelAliases) ? snapshot.modelAliases : [];
        const poolLabel = typeof snapshot.poolLabel === 'string' ? snapshot.poolLabel : `${provider} pool`;
        const poolScope = typeof snapshot.poolScope === 'string' ? snapshot.poolScope : null;
        const pools = new Map();

        for (const account of snapshot.accounts)
        {
            for (const [model, quota] of Object.entries(account.quotas || {}))
            {
                const usedPercent = quotaPercent(quota);
                if (usedPercent === null) continue;
                const observedAt = iso(account.observedAt) || iso(snapshot.observedAt) || new Date().toISOString();
                rows.push({
                    key: `${provider}:${account.id}:${model}`,
                    provider,
                    accountId: String(account.id),
                    accountName: account.name || `Account ${account.id}`,
                    quotaId: model,
                    label: model,
                    model,
                    usedPercent,
                    remainingFraction: finite(quota.remainingFraction),
                    resetAt: iso(quota.resetTime),
                    observedAt,
                    source: account.source || snapshot.source || null,
                    exact: account.exact === true,
                    schedulable: account.status === 'active' && account.schedulable !== false,
                    status: account.status || null,
                    tier: account.tier || null,
                    windowSeconds: null,
                    aggregate: false,
                    track: tracked ? tracked.has(model) : true,
                    aliases,
                });
                const schedulable = account.status === 'active' && account.schedulable !== false;
                if (!pools.has(model)) pools.set(model, []);
                pools.get(model).push({ usedPercent, quota, observedAt, schedulable });
            }
        }

        for (const [model, all] of pools)
        {
            if (!all.length) continue;

            // Prefer the accounts the scheduler can actually pick. When none is
            // schedulable the pool still has to appear, marked unavailable, or
            // the model would silently disappear exactly when it matters most.
            const schedulable = all.filter(item => item.schedulable);
            const members = schedulable.length ? schedulable : all;
            const usedPercent = members.reduce((sum, item) => sum + item.usedPercent, 0) / members.length;
            const resetTimes = members.map(item => iso(item.quota.resetTime)).filter(Boolean).sort();
            const fractions = members.map(item => finite(item.quota.remainingFraction)).filter(value => value !== null);
            rows.push({
                key: `${provider}:pool:${model}`,
                provider,
                accountId: 'pool',
                accountName: `${poolLabel} · ${members.length} account${members.length === 1 ? '' : 's'}`,
                quotaId: model,
                label: `${model} · pool average`,
                model,
                usedPercent,
                remainingFraction: fractions.length === members.length
                    ? fractions.reduce((sum, value) => sum + value, 0) / members.length
                    : 1 - usedPercent / 100,
                resetAt: resetTimes[0] || null,
                observedAt: members.map(item => item.observedAt).sort().at(-1),
                source: snapshot.source || null,
                exact: true,
                schedulable: schedulable.length > 0,
                windowSeconds: null,
                aggregate: true,
                accountCount: members.length,
                schedulableCount: schedulable.length,
                track: tracked ? tracked.has(model) : true,
                aliases,
                scope: poolScope,
            });
        }
    }
    return rows;
}

export function readClaudePlan(file)
{
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (error) { return { current: null, history: [], error: String(error?.message || error) }; }
    const samples = Array.isArray(doc?.samples) ? doc.samples.filter(sample => finite(sample?.t) !== null && sample?.u) : [];
    const last = samples.at(-1) || null;
    const org = last?.org || null;
    const selected = org ? samples.filter(sample => sample.org === org) : samples;
    const history = [];
    for (const sample of selected)
    {
        for (const bucket of Object.keys(CLAUDE_BUCKETS))
        {
            const usedPercent = clampPercent(sample.u?.[bucket]);
            if (usedPercent === null) continue;
            history.push({
                key: `claude:${org || 'current'}:${bucket}`,
                provider: 'claude',
                observedAt: new Date(sample.t).toISOString(),
                usedPercent,
                resetAt: null,
            });
        }
    }
    return {
        current: last ? { org, observedAt: new Date(last.t).toISOString(), usage: last.u } : null,
        history,
        samples: selected.length,
        error: null,
    };
}

function durableAppend(file, lines)
{
    if (!lines.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a+');
    try
    {
        const size = fs.fstatSync(fd).size;
        let prefix = '';
        if (size > 0)
        {
            const tail = Buffer.allocUnsafe(1);
            fs.readSync(fd, tail, 0, 1, size - 1);
            if (tail[0] !== 10) prefix = '\n';
        }
        fs.writeSync(fd, prefix + lines.map(line => JSON.stringify(line)).join('\n') + '\n');
        fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
}

export class LimitHistory
{
    constructor(file)
    {
        this.file = file;
        this.rows = [];
        this.latest = new Map();
        this.load();
    }

    load()
    {
        let text = '';
        try { text = fs.readFileSync(this.file, 'utf8'); } catch (_) { return; }
        let parsed = 0;
        for (const line of text.split('\n'))
        {
            if (!line.trim()) continue;
            let row;
            try { row = JSON.parse(line); } catch (_) { continue; }
            if (row?.version !== 1 || !row.key || finite(row.usedPercent) === null || !iso(row.observedAt)) continue;
            parsed += 1;
            this.rows.push(row);
            this.latest.set(row.key, row);
        }
        if (this.rows.length > HISTORY_LIMIT) this.rows = this.rows.slice(-HISTORY_LIMIT);
        if (parsed > HISTORY_LIMIT * 2)
        {
            const tmp = this.file + '.tmp';
            const fd = fs.openSync(tmp, 'w');
            try
            {
                fs.writeSync(fd, this.rows.map(row => JSON.stringify(row)).join('\n') + '\n');
                fs.fsyncSync(fd);
            }
            finally { fs.closeSync(fd); }
            fs.renameSync(tmp, this.file);
        }
    }

    record(rows)
    {
        const added = [];
        for (const row of rows)
        {
            if (row.provider === 'claude') continue;
            // An adapter marks the quota ids that actually move. The rest are
            // catalogue aliases that are flat by construction, and a history
            // row per alias per account swamps the store with straight lines.
            if (row.track === false) continue;
            const observedAt = iso(row.observedAt) || new Date().toISOString();
            const prior = this.latest.get(row.key);
            const same = prior && prior.usedPercent === row.usedPercent && prior.resetAt === row.resetAt
                && Date.parse(observedAt) - Date.parse(prior.observedAt) < HISTORY_HEARTBEAT_MS;
            if (same) continue;
            const entry = { version: 1, key: row.key, provider: row.provider, model: row.model || null,
                observedAt, usedPercent: row.usedPercent, resetAt: row.resetAt || null };
            added.push(entry);
            this.rows.push(entry);
            this.latest.set(entry.key, entry);
        }
        durableAppend(this.file, added);
        if (this.rows.length > HISTORY_LIMIT) this.rows = this.rows.slice(-HISTORY_LIMIT);
        return added.length;
    }
}

function activeHistory(rows, now, meter = null)
{
    const sorted = rows
        .filter(row => finite(row.usedPercent) !== null && Number.isFinite(Date.parse(row.observedAt)))
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const firstRecent = sorted.findIndex(row => Date.parse(row.observedAt) >= now - LOOKBACK_MS);
    const recent = sorted.slice(firstRecent === -1 ? Math.max(0, sorted.length - 1) : firstRecent);

    // When the provider tells us both when this window resets and how long it
    // is, the previous window's samples can be cut exactly instead of guessed
    // at from a drop in the value.
    let floor = 0;
    const resetMs = Date.parse(meter?.resetAt ?? '');
    const windowSeconds = typeof meter?.windowSeconds === 'number' && Number.isFinite(meter.windowSeconds)
        ? meter.windowSeconds : null;
    if (Number.isFinite(resetMs) && windowSeconds)
    {
        const startedAt = resetMs - windowSeconds * 1000;
        for (let i = 0; i < recent.length; i += 1)
            if (Date.parse(recent[i].observedAt) < startedAt) floor = i + 1;
    }

    let reset = 0;
    for (let i = 1; i < recent.length; i += 1)
    {
        const previousReset = Date.parse(recent[i - 1].resetAt);
        const currentReset = Date.parse(recent[i].resetAt);
        const resetMoved = Number.isFinite(previousReset) && Number.isFinite(currentReset)
            && Math.abs(currentReset - previousReset) > 60000;
        if (recent[i].usedPercent + 0.5 < recent[i - 1].usedPercent || resetMoved) reset = i;
    }
    return recent.slice(Math.max(reset, floor));
}

export function forecastMeter(meter, history, now = Date.now())
{
    const samples = activeHistory(history, now, meter);
    const first = samples[0];
    const last = samples.at(-1);
    const spanMinutes = first && last ? (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 60000 : 0;
    const delta = first && last ? Math.max(0, last.usedPercent - first.usedPercent) : 0;
    const ratePerMinute = spanMinutes >= 2 && delta > 0 ? delta / spanMinutes : 0;
    const etaMinutes = ratePerMinute > 0 ? Math.max(0, (100 - meter.usedPercent) / ratePerMinute) : null;
    const resetMinutes = meter.resetAt ? Math.max(0, (Date.parse(meter.resetAt) - now) / 60000) : null;
    const exhaustsBeforeReset = etaMinutes !== null && (resetMinutes === null || etaMinutes < resetMinutes);
    let confidence = 'insufficient';
    if (samples.length >= 2 && spanMinutes >= 10) confidence = 'low';
    if (samples.length >= 4 && spanMinutes >= 30 && delta >= 1) confidence = 'medium';
    if (samples.length >= 8 && spanMinutes >= 90 && delta >= 3) confidence = 'high';
    return {
        ratePerMinute,
        etaMinutes,
        resetMinutes,
        exhaustsBeforeReset,
        confidence,
        sampleCount: samples.length,
        spanMinutes,
        projected: HORIZONS.map(minutes => ({ minutes, usedPercent: Math.min(100, meter.usedPercent + ratePerMinute * minutes) })),
    };
}

function tokenMatch(event, meter)
{
    if (event.provider !== meter.provider) return false;
    if (!meter.model) return true;
    const eventModel = String(event.servedModel || event.requestedModel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const quotaModel = String(meter.model).toLowerCase().replace(/tiered|[^a-z0-9]/g, '');
    if (eventModel.includes(quotaModel) || quotaModel.includes(eventModel)) return true;

    // A quota name and a model name can describe the same thing without sharing
    // a substring long enough to match above -- a quota called "<vendor>-pro-agent"
    // against a model called "<vendor>-3.1-pro", say. The adapter supplies the
    // family words that bridge its own naming; this layer never learns them.
    for (const alias of meter.aliases || [])
    {
        if (eventModel.includes(meter.provider) && eventModel.includes(alias) && quotaModel.includes(alias)) return true;
    }
    return false;
}

export function calibrateMeter(meter, history, events, now = Date.now())
{
    if (!meter.aggregate) return null;
    const samples = activeHistory(history, now, meter);
    if (samples.length < 2) return null;
    const matchedEvents = events.filter(event => tokenMatch(event, meter)
        && Number.isFinite(Date.parse(event.observedAt))).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    if (!matchedEvents.length) return null;

    // The ledger snapshot retains a bounded recent tail. Start at the first
    // quota sample after its oldest retained event so missing older responses
    // can never make tokens-per-percent look artificially cheap.
    const oldestEvent = Date.parse(matchedEvents[0].observedAt);
    const firstIndex = samples.findIndex(sample => Date.parse(sample.observedAt) >= oldestEvent);
    if (firstIndex === -1 || firstIndex >= samples.length - 1) return null;
    const first = samples[firstIndex];
    const latest = samples.at(-1);
    const deltaPercent = latest.usedPercent - first.usedPercent;
    if (deltaPercent <= 0.05) return null;
    const start = Date.parse(first.observedAt);
    const end = Date.parse(latest.observedAt);
    const intervalEvents = matchedEvents.filter(event => {
        const at = Date.parse(event.observedAt);
        return at > start && at <= end;
    });
    if (!intervalEvents.length) return null;
    const tokens = intervalEvents.reduce((sum, event) => sum
        + (event.tokens?.contextInputTokens || 0) + (event.tokens?.outputTokens || 0), 0);
    if (!tokens) return null;
    return {
        tokensPerPercent: tokens / deltaPercent,
        observedTokens: tokens,
        observedPercent: deltaPercent,
        responseCount: intervalEvents.length,
        spanMinutes: (end - start) / 60000,
        exactTokens: intervalEvents.every(event => event.exact === true),
        scope: meter.scope || meter.label,
    };
}

export class UsageAnalytics
{
    constructor(options)
    {
        this.planFile = options.planFile;
        this.history = new LimitHistory(options.historyFile);
        this.accounting = options.accounting || null;
    }

    // calibrateMeter discards every quota reading older than the oldest
    // response it was handed, so it can never charge a percent delta against
    // tokens it does not hold. The in-memory ledger tail is a hundred
    // responses, which under load spans less wall clock than the gap between
    // two readings -- that tail leaves a single reading standing, no delta
    // exists, and the calibration reads "learning" for the life of the session
    // however long it runs. The durable segments keep every response, so draw
    // the same window activeHistory draws its samples from.
    calibrationEvents(now, usage)
    {
        if (this.accounting)
        {
            try
            {
                const rows = this.accounting.tokenEventsSince(now - LOOKBACK_MS, now);
                if (rows.length) return rows;
            }
            catch (_) {}
        }
        return usage?.recent || [];
    }

    snapshot(limits, usage)
    {
        const now = Date.now();
        const claude = readClaudePlan(this.planFile);
        const meters = normalizeLimitRows(limits, claude);
        this.history.record(meters);

        // The bounded history file drives current forecasts; the permanent
        // store keeps every observation, including the provider and account
        // rows the forecast surface deliberately ignores.
        if (this.accounting) try { this.accounting.recordQuotas(meters); } catch (_) {}
        const historyRows = [...claude.history, ...this.history.rows];
        const byKey = new Map();
        for (const row of historyRows)
        {
            if (!byKey.has(row.key)) byKey.set(row.key, []);
            byKey.get(row.key).push(row);
        }
        const events = this.calibrationEvents(now, usage);
        const enriched = meters.map(meter => {
            const history = byKey.get(meter.key) || [];
            return { ...meter, forecast: forecastMeter(meter, history, now), calibration: calibrateMeter(meter, history, events, now),
                history: history.slice(-128).map(row => ({ observedAt: row.observedAt, usedPercent: row.usedPercent })) };
        });
        return {
            version: 1,
            generatedAt: new Date(now).toISOString(),
            // One entry per provider the limits payload carried, so an adapter
            // reports its own freshness and its own errors without this file
            // holding a list of which backends exist.
            sources: {
                claude: { source: 'claude.plan-usage-history', observedAt: claude.current?.observedAt || null, error: claude.error },
                ...Object.fromEntries(Object.entries(limits || {})
                    .filter(([key]) => key !== 'version' && key !== 'observedAt')
                    .map(([key, value]) => [key, {
                        source: value?.source || null,
                        observedAt: value?.observedAt || null,
                        error: value?.error || null,
                    }])),
            },
            meters: enriched,
            usage,
            limits,
        };
    }
}

export { CLAUDE_BUCKETS, HORIZONS };
