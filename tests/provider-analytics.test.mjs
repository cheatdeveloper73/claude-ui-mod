import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LimitHistory, UsageAnalytics, calibrateMeter, forecastMeter, normalizeLimitRows, readClaudePlan } from '../router/analytics.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-analytics-'));
const planFile = path.join(temp, 'plan.json');
const historyFile = path.join(temp, 'limits.jsonl');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const at = minute => new Date(Date.UTC(2026, 7, 31, 12, minute)).toISOString();
const now = Date.parse(at(40));

fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [
    { t: Date.parse(at(0)), org: 'other', u: { fh: 99 } },
    { t: Date.parse(at(10)), org: 'mine', u: { fh: 10, sd: 20 } },
    { t: Date.parse(at(40)), org: 'mine', u: { fh: 40, sd: 23 } },
] }));

test('Claude plan history stays scoped to the current organization', () => {
    const plan = readClaudePlan(planFile);
    assert.equal(plan.samples, 2);
    assert.equal(plan.current.usage.fh, 40);
    assert.equal(plan.history.filter(row => row.key.endsWith(':fh')).length, 2);
    assert.equal(JSON.stringify(plan).includes('other'), false);
});

// The account-pool arm is provider-agnostic on purpose: any adapter whose
// limits snapshot carries an `accounts` array gets per-account meters and a
// pool average. These fixtures use a provider that does not exist so the test
// cannot pass by accident on a name the analytics layer knows about.
test('provider limits normalize every account plus a schedulable pool', () => {
    const rows = normalizeLimitRows({
        openai: { observedAt: at(40), planType: 'pro', rateLimit: {
            primary: { usedPercent: 12.5, resetAt: Date.parse(at(50)) / 1000 }, secondary: null,
        }, additionalRateLimits: [] },
        acme: { observedAt: at(40), source: 'acme.fixture', poolLabel: 'Acme pool', accounts: [
            { id: 1, name: 'One', status: 'active', schedulable: true, exact: true, quotas: {
                'acme-flash-tiered': { utilization: 20, remainingFraction: 0.8, resetTime: at(50), windowSeconds: 604800 },
            } },
            { id: 2, name: 'Two', status: 'active', schedulable: true, exact: true, quotas: {
                'acme-flash-tiered': { utilization: 40, remainingFraction: 0.6, resetTime: at(55), windowSeconds: 604800 },
            } },
            { id: 3, name: 'Off', status: 'active', schedulable: false, exact: true, quotas: {
                'acme-flash-tiered': { utilization: 0, remainingFraction: 1, resetTime: at(55) },
            } },
        ] },
    }, readClaudePlan(planFile));
    assert.equal(rows.find(row => row.key === 'openai:chatgpt:primary').usedPercent, 12.5);
    assert.equal(rows.filter(row => row.provider === 'acme' && !row.aggregate).length, 3);
    const pool = rows.find(row => row.key === 'acme:pool:acme-flash-tiered');
    assert.equal(pool.usedPercent, 30);
    assert.equal(pool.accountCount, 2);
    assert.equal(pool.windowSeconds, 604800);
    assert.equal(rows.find(row => row.key === 'acme:1:acme-flash-tiered').windowSeconds, 604800);
});

test('a quota unit correction starts a new forecast history without erasing old samples', () => {
    const file = path.join(temp, 'versioned-limits.jsonl');
    const key = 'acme:pool:weekly';
    fs.writeFileSync(file, JSON.stringify({ version: 1, key, provider: 'acme', model: 'weekly',
        observedAt: new Date(Date.now() - 5 * 60000).toISOString(), usedPercent: 0.33, resetAt: null }) + '\n');
    const analytics = new UsageAnalytics({ planFile, historyFile: file });
    const result = analytics.snapshot({ acme: { historyVersion: 2, trackedQuotas: ['weekly'], accounts: [
        { id: 1, status: 'active', schedulable: true, observedAt: new Date().toISOString(), quotas: {
            weekly: { utilization: 33, remainingFraction: 0.67, windowSeconds: 604800 },
        } },
    ] } }, { recent: [], models: [], sessions: [], exactRecords: 0 });
    const meter = result.meters.find(row => row.key === key);
    assert.equal(meter.usedPercent, 33);
    assert.equal(meter.forecast.sampleCount, 1);
    assert.equal(meter.forecast.ratePerMinute, 0);
    assert.equal(meter.history.length, 1);
    const stored = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(stored.length, 3);
    assert.equal(stored[0].usedPercent, 0.33);
    assert.equal(stored[1].historyVersion, 2);
});

test('forecast reports observed burn rate and whether reset wins', () => {
    const meter = { usedPercent: 40, resetAt: at(55) };
    const history = [
        { observedAt: at(10), usedPercent: 10, resetAt: at(55) },
        { observedAt: at(25), usedPercent: 25, resetAt: at(55) },
        { observedAt: at(40), usedPercent: 40, resetAt: at(55) },
    ];
    const forecast = forecastMeter(meter, history, now);
    assert.equal(forecast.ratePerMinute, 1);
    assert.equal(forecast.etaMinutes, 60);
    assert.equal(forecast.exhaustsBeforeReset, false);
    assert.equal(forecast.projected.find(row => row.minutes === 30).usedPercent, 70);
});

test('token calibration uses only the interval covered by retained events', () => {
    const meter = { provider: 'openai', model: null, aggregate: true, label: 'Primary window' };
    const history = [
        { observedAt: at(10), usedPercent: 4, resetAt: null },
        { observedAt: at(25), usedPercent: 10, resetAt: null },
        { observedAt: at(27), usedPercent: 10.5, resetAt: null },
        { observedAt: at(40), usedPercent: 11.5, resetAt: null },
    ];
    const events = [
        { provider: 'openai', observedAt: at(15), exact: true, tokens: { contextInputTokens: 9000, outputTokens: 1000 } },
        { provider: 'openai', observedAt: at(26), exact: true, tokens: { contextInputTokens: 1800, outputTokens: 200 } },
        { provider: 'openai', observedAt: at(30), exact: true, tokens: { contextInputTokens: 900, outputTokens: 100 } },
    ];
    const value = calibrateMeter(meter, history, events.slice(1), now);
    assert.equal(value.tokensPerPercent, 1000);
    assert.equal(value.observedTokens, 1000);
    assert.equal(value.observedPercent, 1);
    assert.equal(value.responseCount, 1);
});

// A quota name and a model name can name the same thing without sharing a
// substring: "acme-pro-agent" against "claude-acme-3.1-pro[1m]" has no common
// run long enough to match. The adapter supplies the family words that bridge
// the two, and without them this calibration silently finds no events.
test('an adapter model alias calibrates the quota family it belongs to', () => {
    const meter = { provider: 'acme', model: 'acme-pro-agent', aggregate: true, label: 'Pro pool',
        aliases: ['flash', 'pro'] };
    const history = [
        { observedAt: at(20), usedPercent: 10, resetAt: null },
        { observedAt: at(40), usedPercent: 12, resetAt: null },
    ];
    const events = [
        { provider: 'acme', servedModel: 'claude-acme-3.1-pro[1m]', observedAt: at(15), exact: true,
            tokens: { contextInputTokens: 900, outputTokens: 100 } },
        { provider: 'acme', servedModel: 'claude-acme-3.1-pro[1m]', observedAt: at(30), exact: true,
            tokens: { contextInputTokens: 900, outputTokens: 100 } },
    ];
    const value = calibrateMeter(meter, history, events, now);
    assert.equal(value.tokensPerPercent, 500);
    assert.equal(value.responseCount, 1);

    // Without the aliases the same fixture matches nothing at all.
    assert.equal(calibrateMeter({ ...meter, aliases: [] }, history, events, now), null);
});

test('small reset timestamp jitter does not erase forecast history', () => {
    const meter = { usedPercent: 40, resetAt: at(55) };
    const history = [
        { observedAt: at(10), usedPercent: 10, resetAt: '2026-08-31T13:00:00.000Z' },
        { observedAt: at(25), usedPercent: 25, resetAt: '2026-08-31T13:00:00.500Z' },
        { observedAt: at(40), usedPercent: 40, resetAt: '2026-08-31T13:00:01.000Z' },
    ];
    const forecast = forecastMeter(meter, history, now);
    assert.equal(forecast.ratePerMinute, 1);
    assert.equal(forecast.sampleCount, 3);
});

test('analytics persists remote snapshots without duplicating a hot-cache read', () => {
    const analytics = new UsageAnalytics({ planFile, historyFile });
    const limits = { openai: { observedAt: at(40), planType: 'pro', rateLimit: {
        primary: { usedPercent: 12.5, resetAt: Date.parse(at(50)) / 1000 }, secondary: null,
    }, additionalRateLimits: [] }, acme: { accounts: [] } };
    const first = analytics.snapshot(limits, { recent: [], models: [], sessions: [], exactRecords: 0 });
    const second = analytics.snapshot(limits, { recent: [], models: [], sessions: [], exactRecords: 0 });
    assert.equal(first.meters.some(row => row.provider === 'claude'), true);
    assert.equal(second.meters.some(row => row.provider === 'openai'), true);
    assert.equal(fs.readFileSync(historyFile, 'utf8').trim().split('\n').length, 1);
    assert.equal(new LimitHistory(historyFile).rows.length, 1);
});

test('limit history keeps only the quotas an adapter tracks, plus heartbeats', () => {
    const file = path.join(temp, 'heartbeat.jsonl');
    const history = new LimitHistory(file);
    // `track` is set by normalizeLimitRows from the adapter's trackedQuotas.
    // An untracked catalogue alias is flat by construction, and a history row
    // per alias per account fills the store with straight lines.
    const row = { key: 'acme:1:acme-flash-tiered', provider: 'acme', quotaId: 'acme-flash-tiered',
        model: 'acme-flash-tiered', usedPercent: 10, resetAt: at(50), observedAt: at(0), track: true };
    assert.equal(history.record([row, { ...row, key: 'acme:1:unused-alias', quotaId: 'unused-alias', track: false }]), 1);
    assert.equal(history.record([{ ...row, observedAt: at(1) }]), 0);
    assert.equal(history.record([{ ...row, observedAt: at(6) }]), 1);
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('a single account still produces a correctly labelled pool', () => {
    const limits = {
        acme: {
            poolLabel: 'Acme pool',
            accounts: [
                {
                    id: 1,
                    name: 'Solo',
                    status: 'active',
                    schedulable: true,
                    quotas: {
                        'acme-flash-tiered': {
                            utilization: 40,
                            remainingFraction: 0.6,
                            resetTime: at(50),
                        },
                    },
                },
            ],
        },
    };
    const rows = normalizeLimitRows(limits, { current: null, history: [] });
    const pool = rows.find(row => row.key === 'acme:pool:acme-flash-tiered');
    assert.equal(pool.accountName, 'Acme pool · 1 account');
    assert.equal(pool.usedPercent, 40);
    assert.equal(pool.accountCount, 1);
    assert.equal(pool.schedulableCount, 1);
});

test('four accounts average only the schedulable ones', () => {
    const limits = {
        acme: {
            poolLabel: 'Acme pool',
            accounts: [
                { id: 1, name: 'One', status: 'active', schedulable: true, quotas: { 'acme-flash-tiered': { utilization: 10, remainingFraction: 0.9, resetTime: at(50) } } },
                { id: 2, name: 'Two', status: 'active', schedulable: true, quotas: { 'acme-flash-tiered': { utilization: 20, remainingFraction: 0.8, resetTime: at(50) } } },
                { id: 3, name: 'Three', status: 'active', schedulable: true, quotas: { 'acme-flash-tiered': { utilization: 30, remainingFraction: 0.7, resetTime: at(50) } } },
                { id: 4, name: 'Four', status: 'active', schedulable: false, quotas: { 'acme-flash-tiered': { utilization: 100, remainingFraction: 0, resetTime: at(50) } } },
            ],
        },
    };
    const rows = normalizeLimitRows(limits, { current: null, history: [] });
    const pool = rows.find(row => row.key === 'acme:pool:acme-flash-tiered');
    assert.equal(pool.usedPercent, 20);
    assert.equal(pool.accountCount, 3);
    assert.equal(pool.schedulableCount, 3);
    assert.equal(pool.accountName, 'Acme pool · 3 accounts');
});

test('a pool with no schedulable account is still reported, marked unavailable', () => {
    const limits = {
        acme: {
            poolLabel: 'Acme pool',
            accounts: [
                { id: 1, name: 'One', status: 'active', schedulable: false, quotas: { 'acme-flash-tiered': { utilization: 90, remainingFraction: 0.1, resetTime: at(50) } } },
                { id: 2, name: 'Two', status: 'active', schedulable: false, quotas: { 'acme-flash-tiered': { utilization: 100, remainingFraction: 0, resetTime: at(50) } } },
            ],
        },
    };
    const rows = normalizeLimitRows(limits, { current: null, history: [] });
    const pool = rows.find(row => row.key === 'acme:pool:acme-flash-tiered');
    assert.ok(pool);
    assert.equal(pool.schedulable, false);
    assert.equal(pool.schedulableCount, 0);
    assert.equal(pool.usedPercent, 95);
});

test('Claude windows take their reset time from the captured plan resets', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resets-'));
    const resetsFile = path.join(tempDir, 'claude-plan-resets.json');
    fs.writeFileSync(resetsFile, JSON.stringify({
        version: 1,
        observedAt: '2026-08-31T12:00:00.000Z',
        buckets: {
            five_hour: {
                resetsAt: '2026-08-31T18:00:00.000Z',
                usedPercent: 19,
            },
        },
    }));
    const prevEnv = process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE;
    process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE = resetsFile;
    try {
        const fresh = await import('../router/analytics.mjs?claude-resets-test');
        const rows = fresh.normalizeLimitRows({}, { current: { org: 'o', observedAt: '2026-08-31T12:00:00.000Z', usage: { fh: 19 } }, history: [] });
        const row = rows.find(r => r.quotaId === 'five_hour');
        assert.ok(row);
        assert.equal(row.resetAt, '2026-08-31T18:00:00.000Z');
        assert.equal(row.windowSeconds, 18000);
    } finally {
        if (prevEnv !== undefined) {
            process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE = prevEnv;
        } else {
            delete process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('samples from a previous window are excluded from the forecast', () => {
    const meter = { usedPercent: 20, resetAt: '2026-08-31T10:00:00.000Z', windowSeconds: 18000 };
    const history = [
        { observedAt: '2026-08-31T04:00:00.000Z', usedPercent: 90, resetAt: '2026-08-31T10:00:00.000Z' },
        { observedAt: '2026-08-31T04:30:00.000Z', usedPercent: 95, resetAt: '2026-08-31T10:00:00.000Z' },
        { observedAt: '2026-08-31T06:00:00.000Z', usedPercent: 10, resetAt: '2026-08-31T10:00:00.000Z' },
        { observedAt: '2026-08-31T08:00:00.000Z', usedPercent: 20, resetAt: '2026-08-31T10:00:00.000Z' },
    ];
    const forecast = forecastMeter(meter, history, Date.parse('2026-08-31T08:00:00.000Z'));
    assert.equal(forecast.sampleCount, 2);
    assert.ok(forecast.ratePerMinute > 0);
});

async function withClaudeLimits(doc, run)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scoped-'));
    const file = path.join(dir, 'claude-plan-resets.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    const previous = process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE;
    process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE = file;
    try { return await run(); }
    finally
    {
        if (previous === undefined) delete process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE;
        else process.env.MODEL_ROUTER_CLAUDE_RESETS_FILE = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const claudePlan = { current: { org: 'org-a', observedAt: '2026-08-31T12:00:00.000Z', usage: { fh: 19, sd: 4 } }, history: [] };

test('a per-model weekly limit becomes its own meter', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: { seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 } },
        scoped: [{ model: 'Fable', percent: 12, group: 'weekly', resetsAt: null, severity: 'normal' }],
    }, () => normalizeLimitRows({}, claudePlan));

    const scoped = rows.find(row => row.quotaId === 'weekly_scoped:Fable');
    assert.ok(scoped, 'the scoped weekly limit must appear as a meter');
    assert.equal(scoped.key, 'claude:org-a:weekly_scoped:Fable');
    assert.equal(scoped.label, 'Weekly · Fable');
    assert.equal(scoped.provider, 'claude');
    assert.equal(scoped.model, 'Fable');
    assert.equal(scoped.usedPercent, 12);
    assert.equal(scoped.remainingFraction, 0.88);
    assert.equal(scoped.aggregate, true);
    assert.equal(scoped.schedulable, true);
    assert.equal(scoped.source, 'claude.plan-usage-limits');
    assert.equal(scoped.observedAt, '2026-08-31T23:13:39.230Z');
});

test('a scoped weekly limit inherits the reset of the weekly group it belongs to', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: { seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 } },
        scoped: [{ model: 'Fable', percent: 0, group: 'weekly', resetsAt: null, severity: 'normal' }],
    }, () => normalizeLimitRows({}, claudePlan));

    const scoped = rows.find(row => row.quotaId === 'weekly_scoped:Fable');
    assert.equal(scoped.resetAt, '2026-09-07T13:00:00.000Z', 'it empties when the weekly window does');
    assert.equal(scoped.windowSeconds, 604800);
});

test('an explicit scoped reset is preferred over the group reset', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: { seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 } },
        scoped: [{ model: 'Fable', percent: 3, group: 'weekly', resetsAt: '2026-09-03T09:00:00.000Z' }],
    }, () => normalizeLimitRows({}, claudePlan));

    assert.equal(rows.find(row => row.quotaId === 'weekly_scoped:Fable').resetAt, '2026-09-03T09:00:00.000Z');
});

test('several scoped models each get their own meter and an exhausted one is unschedulable', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: { seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 } },
        scoped: [
            { model: 'Fable', percent: 10, group: 'weekly', resetsAt: null },
            { model: 'Opus', percent: 100, group: 'weekly', resetsAt: null },
        ],
    }, () => normalizeLimitRows({}, claudePlan));

    const scoped = rows.filter(row => String(row.quotaId).startsWith('weekly_scoped:'));
    assert.equal(scoped.length, 2);
    assert.deepEqual(scoped.map(row => row.model).sort(), ['Fable', 'Opus']);
    assert.equal(scoped.find(row => row.model === 'Opus').schedulable, false);
    assert.equal(scoped.find(row => row.model === 'Fable').schedulable, true);
});

test('the scoped meter never duplicates the session or weekly-all buckets', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: {
            five_hour: { resetsAt: '2026-09-01T01:40:00.000Z', usedPercent: 19 },
            seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 },
        },
        scoped: [{ model: 'Fable', percent: 0, group: 'weekly', resetsAt: null }],
    }, () => normalizeLimitRows({}, claudePlan));

    const claudeRows = rows.filter(row => row.provider === 'claude');
    assert.equal(claudeRows.filter(row => row.quotaId === 'five_hour').length, 1);
    assert.equal(claudeRows.filter(row => row.quotaId === 'seven_day').length, 1);
    assert.equal(new Set(claudeRows.map(row => row.key)).size, claudeRows.length, 'meter keys must stay unique');
});

test('a malformed scoped entry is dropped without losing the rest', async () => {
    const rows = await withClaudeLimits({
        version: 1, observedAt: '2026-08-31T23:13:39.230Z',
        buckets: { seven_day: { resetsAt: '2026-09-07T13:00:00.000Z', usedPercent: 4 } },
        scoped: [
            { model: 'Fable', percent: 7, group: 'weekly' },
            { model: null, percent: 5, group: 'weekly' },
            { model: 'NoPercent', percent: 'nope', group: 'weekly' },
        ],
    }, () => normalizeLimitRows({}, claudePlan));

    const scoped = rows.filter(row => String(row.quotaId).startsWith('weekly_scoped:'));
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].model, 'Fable');
});

test('calibration reads the durable store, not the hundred-row ledger tail', () => {
    // The regression this pins: the in-memory tail spans less wall clock than
    // the gap between two quota readings, so calibrateMeter clamps to a single
    // reading and never resolves. Same meters, same plan file -- only the event
    // source differs. snapshot() reads the wall clock, so the fixture has to be
    // anchored to it rather than to this file's fixed minute grid.
    const t0 = Date.now();
    const ago = minutes => t0 - minutes * 60000;
    const live = path.join(temp, 'live-plan.json');
    fs.writeFileSync(live, JSON.stringify({ version: 2, samples: [
        { t: ago(32), org: 'mine', u: { sd: 10 } },
        { t: ago(2), org: 'mine', u: { sd: 40 } },
    ] }));

    const event = (minutes, tokens) => ({ provider: 'claude', servedModel: 'claude-opus-5', exact: true,
        observedAt: new Date(ago(minutes)).toISOString(), tokens: { contextInputTokens: tokens, outputTokens: 0 } });
    const durable = [event(34, 500), event(25, 1000), event(10, 2000)];
    const accounting = { recordQuotas() {}, tokenEventsSince: (since, end) => durable.filter(row => {
        const observed = Date.parse(row.observedAt);
        return observed >= since && observed <= end;
    }) };
    const limits = { acme: { accounts: [] } };
    const tail = { recent: [event(10, 2000)], models: [], sessions: [], exactRecords: 1 };
    // The seven-day bucket, not the five-hour one: activeHistory cuts samples
    // that fall before the current window started, and the five-hour window on
    // the host machine can be minutes old.
    const weekly = rows => rows.meters.find(row => row.key === 'claude:mine:sd');

    const starved = new UsageAnalytics({ planFile: live, historyFile: path.join(temp, 'starved.jsonl') });
    assert.equal(weekly(starved.snapshot(limits, tail)).calibration, null, 'the tail covers one reading, so no delta exists');

    const fed = new UsageAnalytics({ planFile: live, historyFile: path.join(temp, 'fed.jsonl'), accounting });
    const value = weekly(fed.snapshot(limits, tail)).calibration;
    assert.equal(value.observedPercent, 30);
    assert.equal(value.observedTokens, 3000, 'the event before the first reading sets the clamp and is not itself charged');
    assert.equal(value.tokensPerPercent, 100);
    assert.equal(value.responseCount, 2);
});
