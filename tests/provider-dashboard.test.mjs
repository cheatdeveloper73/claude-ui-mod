import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import './dashboard-ui.test.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-dashboard-'));
const now = Date.now();
const planFile = path.join(temp, 'plan.json');
const authFile = path.join(temp, 'auth.json');
fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [
    { t: now - 1800000, org: 'fixture-org', u: { fh: 10, sd: 20 } },
    { t: now, org: 'fixture-org', u: { fh: 15, sd: 21 } },
] }));
const jwt = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600 })).toString('base64url');
fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: `x.${jwt}.x`, account_id: 'fixture-account-secret' } }));

let remoteCalls = 0;
const remotePaths = [];
const fixture = http.createServer((req, res) => {
    remoteCalls += 1;
    remotePaths.push(req.url);
    const reply = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/wham/usage') return reply({
        plan_type: 'pro',
        rate_limit: { allowed: true, limit_reached: false,
            primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(Date.now() / 1000) + 3600 },
            secondary_window: null },
        additional_rate_limits: [],
        email: 'must-not-escape@example.test',
    });
    res.writeHead(404); res.end();
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
const adapterDir = path.join(temp, 'no-adapters');
fs.mkdirSync(adapterDir, { recursive: true });

Object.assign(process.env, {
    MODEL_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_PLAN_USAGE_FILE: planFile,
    MODEL_ROUTER_USAGE_FILE: path.join(temp, 'usage.jsonl'),
    MODEL_ROUTER_LIMIT_HISTORY_FILE: path.join(temp, 'limits.jsonl'),
    CODEX_AUTH_FILE: authFile,
    CODEX_USAGE_URL: fixtureOrigin + '/wham/usage',
    MODEL_ROUTER_UPSTREAM: fixtureOrigin + '/anthropic',
    // No adapter, deliberately: this file has to pass identically in a tree
    // that ships one and a tree that does not.
    MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    // Nor the machine's own catalogue and credentials: a configured compatible
    // provider would otherwise be polled for real from a test.
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'),
    MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'provider-secrets.json'),
});
fs.writeFileSync(process.env.MODEL_ROUTER_CATALOGUE_FILE, '[]');
fs.writeFileSync(process.env.MODEL_ROUTER_SECRETS_FILE, '{}');
const { server } = await import('../router/index.mjs?provider-dashboard-test');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

after(async () => {
    await Promise.all([
        new Promise(resolve => server.close(resolve)),
        new Promise(resolve => fixture.close(resolve)),
    ]);
    fs.rmSync(temp, { recursive: true, force: true });
});

test('router hosts self-contained dashboard assets with a same-origin CSP', async () => {
    const page = await fetch(origin + '/usage/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<title>Provider Usage Atlas<\/title>/);
    assert.match(html, /id="horizon-combo"/);
    assert.match(html, /id="copy-meters-tsv"/);
    assert.match(html, /id="popups"/);
    assert.match(html, /id="rate-table"/);
    assert.match(html, /id="rate-fingerprint"/);
    assert.match(html, /class="section-nav"/);
    assert.match(html, /href="#rates"/);
    assert.doesNotMatch(html, /<select/i);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(page.headers.has('access-control-allow-origin'), false);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    const styles = await (await fetch(origin + '/usage/styles.css')).text();
    const script = await (await fetch(origin + '/usage/app.js')).text();
    assert.match(styles, /::-webkit-scrollbar-thumb/);
    assert.match(styles, /\.popup-list\.closing/);
    assert.match(styles, /@keyframes surface-out/);
    assert.match(styles, /\.toast\.hiding/);
    assert.match(styles, /user-select: none/);
    assert.match(styles, /\.status-badge/);
    assert.match(styles, /radial-gradient/);
    assert.match(styles, /--openai: #eb6834/);
    assert.match(styles, /--gemini: #1baf7a/);
    assert.match(styles, /@keyframes pop-in/);
    assert.match(styles, /\.table-shell \{ position: relative;/);
    assert.match(styles, /td\.provider-cell, td\.cell-stack \{ display: table-cell;/);
    assert.match(script, /navigator\.clipboard\.writeText/);
    assert.doesNotMatch(script, /addEventListener\('selectstart'/);
    assert.match(script, /function swapChildren/);
    assert.match(script, /function patchNode/);
    assert.match(script, /function copyText/);
    assert.match(script, /function closePopup/);
    assert.match(script, /function toggleAudit/);
    assert.match(script, /function renderRates/);
    assert.match(script, /const providerLabel/);
    assert.match(script, /motionDisabled/);
});

test('Claude-only analytics does not poll paid alternate providers', async () => {
    const before = remoteCalls;
    const value = await (await fetch(origin + '/usage/api?scope=claude')).json();
    assert.equal(remoteCalls, before);
    assert.deepEqual([...new Set(value.meters.map(row => row.provider))], ['claude']);
    assert.equal(value.limits.openai, null);
    assert.equal(remotePaths.some(path => /anthropic|claude|oauth\/usage/i.test(path)), false);
});

test('dashboard API joins all providers and exposes no credentials', async () => {
    const response = await fetch(origin + '/usage/api?range=all');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    assert.deepEqual([...new Set(value.meters.map(row => row.provider))].sort(), ['claude', 'openai']);
    assert.equal(value.meters.find(row => row.key === 'openai:chatgpt:primary').usedPercent, 12.5);
    assert.equal(remotePaths.some(path => /anthropic|claude|oauth\/usage/i.test(path)), false);

    const serialized = JSON.stringify(value);
    for (const secret of [
        'fixture-account-secret', 'must-not-escape',
    ]) assert.equal(serialized.includes(secret), false, secret);

    // The rate card renders from this table, so the newer models must be in it
    // the moment they are priced, and every period must carry its window.
    const rates = value.usage.pricing.rates;
    assert.ok(rates['claude/claude-fable-5-1'].every(period => 'from' in period && 'to' in period));
    assert.equal(rates['claude/claude-fable-5-1'][0].input, 10.00);
    // Every published period carries its window, so the card can render the
    // date a price changed instead of implying today's rate always held. The
    // count guard is the point: an emptied table would satisfy the loop below
    // without checking anything.
    assert.ok(Object.keys(rates).length >= 8, 'the rate table lost entries');
    for (const [key, periods] of Object.entries(rates))
        assert.ok(periods.every(period => 'from' in period && 'to' in period), key);
});

test('sanitized raw usage and limits endpoints remain available', async () => {
    const usage = await (await fetch(origin + '/usagez')).json();
    const limits = await (await fetch(origin + '/limitsz')).json();
    assert.equal(usage.version, 1);
    assert.equal(limits.version, 1);
    assert.deepEqual(Object.keys(limits).sort(), ['observedAt', 'openai', 'version']);
});

test('pool pin control is optional when no adapter provides it', async () => {
    const response = await fetch(origin + '/poolpinz');
    assert.equal(response.status, 501);
    const value = await response.json();
    assert.equal(value.error.type, 'not_supported_error');

    const dashboard = await fetch(origin + '/usage/');
    assert.equal(dashboard.status, 200);
});

test('every range is bounded, exact and falls back closed on invalid input', async () => {
    for (const range of ['today', '7d', '30d', '90d', 'all'])
    {
        const value = await (await fetch(`${origin}/usage/api?range=${range}&tz_offset=300`)).json();
        assert.equal(value.range.key, range, range);
        assert.ok(Date.parse(value.range.start) <= Date.parse(value.range.end), range);
        assert.ok(Array.isArray(value.usage.dailyTimeline), range);
        assert.ok(value.usage.recent.length <= 100, range);
        for (const meter of value.meters) assert.ok((meter.history || []).length <= 128, range);
    }

    const fallback = await (await fetch(origin + '/usage/api?range=../etc/passwd&tz_offset=NaN')).json();
    assert.equal(fallback.range.key, 'all');

    const clamped = await (await fetch(origin + '/usage/api?range=today&tz_offset=99999')).json();
    assert.ok(Number.isFinite(Date.parse(clamped.range.start)));
});

test('the response reports permanent storage health without leaking paths of other users', async () => {
    const value = await (await fetch(origin + '/usage/api?range=all')).json();
    assert.equal(typeof value.storage.migrationComplete, 'boolean');
    assert.equal(typeof value.storage.backup.sameVolume, 'boolean');
    assert.ok('firstRecordedAt' in value.storage);
    assert.equal(value.storage.error, null);
});

test('the dashboard ships a range combobox bound to the accounting API', async () => {
    const html = await (await fetch(origin + '/usage/')).text();
    const script = await (await fetch(origin + '/usage/app.js')).text();
    assert.match(html, /id="range-combo"/);
    assert.match(html, /id="daily-timeline"/);
    assert.match(html, /id="range-note"/);
    assert.match(script, /const ranges = \[/);
    assert.match(script, /function openRangePopup/);
    assert.match(script, /function renderTimeline/);
    assert.match(script, /tz_offset/);
});
