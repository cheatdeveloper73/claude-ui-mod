import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AccountingStore, emptyTotals, mergeTotals } from '../router/accounting.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function tempRoot(label)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `provider-accounting-${label}-`));
    temps.push(dir);
    return dir;
}

const at = (minutes) => new Date(Date.UTC(2026, 7, 30, 0, 0) + minutes * 60000).toISOString();

function tokenValue(index, overrides = {})
{
    return {
        provider: 'openai',
        responseId: `resp-${index}`,
        sessionId: 'session-fixture',
        requestedModel: 'claude-gpt-5.6-sol[1m]',
        servedModel: 'gpt-5.6-sol',
        effort: 'high',
        status: 'completed',
        source: 'openai.response.usage',
        exact: true,
        observedAt: at(index),
        tokens: {
            inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 5,
            contextInputTokens: 125, outputTokens: 40,
            reasoningOutputTokens: 10, visibleOutputTokens: 30,
        },
        rawUsage: { input_tokens: 100, output_tokens: 40 },
        ...overrides,
    };
}

function readSegments(root, kind)
{
    const dir = path.join(root, 'segments', kind);
    const rows = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    {
        if (!name.endsWith('.jsonl')) continue;
        for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
        {
            if (!line.trim()) continue;
            try { rows.push(JSON.parse(line)); } catch (_) {}
        }
    }
    return rows;
}

function store(root, options = {})
{
    return new AccountingStore({ root, ...options });
}

test('the constructor touches no disk until a public operation runs', () => {
    const root = path.join(tempRoot('cold'), 'store');
    const cold = store(root);
    assert.equal(fs.existsSync(root), false);
    cold.status();
    assert.equal(fs.existsSync(root), false, 'status() must stay read-only');
    assert.equal(cold.record('token', tokenValue(1)), 'stored');
    assert.equal(fs.existsSync(root), true);
});

test('token events land in UTC daily segments and deduplicate exactly', () => {
    const root = tempRoot('dedupe');
    const acct = store(root);
    assert.equal(acct.record('token', tokenValue(1)), 'stored');
    assert.equal(acct.record('token', tokenValue(1)), 'duplicate');
    assert.equal(acct.record('token', tokenValue(2)), 'stored');

    const rows = readSegments(root, 'tokens');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.responseId).sort(), ['resp-1', 'resp-2']);
    assert.equal(rows[0].v, 2);
    assert.equal(acct.query('all').totals.responses, 2);
});

test('the durable segments answer a time window the in-memory tail cannot span', () => {
    const root = tempRoot('window');
    const acct = store(root);
    acct.record('token', tokenValue(11, { observedAt: '2026-08-30T23:50:00.000Z' }));
    acct.record('token', tokenValue(12, { observedAt: '2026-08-31T00:10:00.000Z' }));
    acct.record('token', tokenValue(13, { observedAt: '2026-08-31T02:00:00.000Z' }));

    const window = acct.tokenEventsSince(Date.parse('2026-08-30T23:00:00.000Z'), Date.parse('2026-08-31T01:00:00.000Z'));
    assert.deepEqual(window.map(row => row.responseId), ['resp-11', 'resp-12'], 'crosses the UTC boundary, stops at the end bound');

    // The size-keyed cache must not answer with a stale day once the segment
    // it was read from has grown.
    acct.record('token', tokenValue(14, { observedAt: '2026-08-31T00:30:00.000Z' }));
    const again = acct.tokenEventsSince(Date.parse('2026-08-30T23:00:00.000Z'), Date.parse('2026-08-31T01:00:00.000Z'));
    assert.deepEqual(again.map(row => row.responseId), ['resp-11', 'resp-12', 'resp-14']);
    assert.deepEqual(acct.tokenEventsSince(Number.NaN), []);
});

test('a duplicate response id split across two UTC days is counted once', () => {
    const root = tempRoot('crossday');
    const acct = store(root);
    assert.equal(acct.record('token', tokenValue(7, { observedAt: '2026-08-30T23:59:30.000Z' })), 'stored');
    assert.equal(acct.record('token', tokenValue(7, { observedAt: '2026-08-31T00:00:30.000Z' })), 'duplicate');
    assert.equal(readSegments(root, 'tokens').length, 1);
    assert.equal(acct.query('all').totals.responses, 1);
});

test('no prompt, tool or credential field survives sanitizing', () => {
    const root = tempRoot('content');
    const acct = store(root);
    acct.record('token', tokenValue(3, {
        prompt: 'SECRET-PROMPT', messages: [{ role: 'user', content: 'SECRET-BODY' }],
        system: 'SECRET-SYSTEM', tools: [{ name: 'SECRET-TOOL' }],
        apiKey: 'SECRET-KEY', authorization: 'Bearer SECRET-TOKEN',
        rawUsage: { input_tokens: 5, prompt: 'SECRET-RAW', text: 'SECRET-TEXT' },
    }));
    acct.record('quota', {
        key: 'openai:chatgpt:primary', provider: 'openai', accountId: 'chatgpt',
        accountName: 'ChatGPT pro', quotaId: 'primary', usedPercent: 12.5,
        remainingFraction: 0.875, observedAt: at(4), source: 'chatgpt.wham.usage', exact: true,
        email: 'SECRET-EMAIL@example.test', password: 'SECRET-PASSWORD',
    });

    const serialized = JSON.stringify([...readSegments(root, 'tokens'), ...readSegments(root, 'quotas')]);
    for (const secret of ['SECRET-PROMPT', 'SECRET-BODY', 'SECRET-SYSTEM', 'SECRET-TOOL', 'SECRET-KEY',
        'SECRET-TOKEN', 'SECRET-RAW', 'SECRET-TEXT', 'SECRET-EMAIL', 'SECRET-PASSWORD'])
        assert.equal(serialized.includes(secret), false, secret);
});

test('unchanged quota values collapse to a five minute heartbeat', () => {
    const root = tempRoot('heartbeat');
    const acct = store(root);
    const base = { key: 'openai:chatgpt:primary', provider: 'openai', accountId: 'chatgpt',
        quotaId: 'primary', usedPercent: 40, remainingFraction: 0.6, source: 'chatgpt.wham.usage', exact: true };

    assert.equal(acct.record('quota', { ...base, observedAt: at(0) }), 'stored');
    // A second worker generation restamps the same unchanged value one second later.
    assert.equal(acct.record('quota', { ...base, observedAt: at(0.016) }), 'duplicate');
    assert.equal(acct.record('quota', { ...base, observedAt: at(6) }), 'stored');
    assert.equal(acct.record('quota', { ...base, usedPercent: 41, observedAt: at(6.1) }), 'stored');
    assert.equal(readSegments(root, 'quotas').length, 3);
});

test('a contended append spools and merges without losing the record', () => {
    const root = tempRoot('spool');
    const acct = store(root);
    acct.ensure();
    fs.mkdirSync(acct.lockDir);
    fs.writeFileSync(path.join(acct.lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, nonce: 'held', at: Date.now() }));

    assert.equal(acct.record('token', tokenValue(11)), 'spooled');
    assert.equal(fs.readdirSync(acct.spoolDir).length, 1);
    assert.equal(readSegments(root, 'tokens').length, 0);

    fs.rmSync(acct.lockDir, { recursive: true, force: true });
    assert.equal(acct.record('token', tokenValue(12)), 'stored');
    assert.deepEqual(readSegments(root, 'tokens').map(row => row.responseId).sort(), ['resp-11', 'resp-12']);
    assert.equal(fs.readdirSync(acct.spoolDir).length, 0);
});

test('a stale lock is reclaimed and a live one is not', () => {
    const root = tempRoot('lock');
    const acct = store(root);
    acct.ensure();
    fs.mkdirSync(acct.lockDir);
    fs.writeFileSync(path.join(acct.lockDir, 'owner.json'),
        JSON.stringify({ pid: process.pid, nonce: 'live', at: Date.now() }));
    assert.equal(acct.acquire(), null, 'a live owner keeps the lock');

    fs.writeFileSync(path.join(acct.lockDir, 'owner.json'),
        JSON.stringify({ pid: 999999, nonce: 'dead', at: Date.now() - 120000 }));
    const token = acct.acquire();
    assert.ok(token, 'a dead owner is reclaimed');
    acct.release(token);
    assert.equal(fs.existsSync(acct.lockDir), false);
});

test('a release with the wrong nonce cannot delete the current holder lock', () => {
    const root = tempRoot('nonce');
    const acct = store(root);
    const token = acct.acquire();
    acct.release('not-the-owner');
    assert.equal(fs.existsSync(acct.lockDir), true);
    acct.release(token);
    assert.equal(fs.existsSync(acct.lockDir), false);
});

test('two processes writing concurrently lose nothing and duplicate nothing', () => {
    const root = tempRoot('concurrent');
    const worker = path.join(root, 'worker.mjs');
    fs.writeFileSync(worker, `
import { AccountingStore } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'router', 'accounting.mjs')).href)};
const [root, offset, count] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const store = new AccountingStore({ root });
for (let i = 0; i < count; i += 1) {
    const id = 'shared-' + ((Number(offset) + i) % 60);
    store.record('token', { provider: 'openai', responseId: id, servedModel: 'gpt-5.6-sol',
        source: 'fixture', exact: true, observedAt: new Date(Date.UTC(2026, 7, 30, 0, 0, i % 50)).toISOString(),
        tokens: { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 10, outputTokens: 4, reasoningOutputTokens: null, visibleOutputTokens: null } });
}
store.sync();
`);

    const children = [0, 30].map(offset => spawnSync(process.execPath, [worker, root, String(offset), '60'],
        { encoding: 'utf8' }));
    for (const child of children) assert.equal(child.status, 0, child.stderr);

    const reader = store(root);
    reader.sync();
    const rows = readSegments(root, 'tokens');
    const ids = rows.map(row => row.responseId);
    assert.equal(new Set(ids).size, 60, 'every unique response id survives');
    assert.equal(ids.length, 60, 'no response id is stored twice');
    assert.equal(reader.query('all').totals.responses, 60);
});

test('legacy v1 ledgers migrate once and keep importing a draining worker tail', () => {
    const root = tempRoot('migrate');
    const legacyTokens = path.join(root, 'provider-usage-v1.jsonl');
    const legacyQuotas = path.join(root, 'provider-limit-history-v1.jsonl');
    const planFile = path.join(root, 'plan.json');

    const legacyToken = (id, minute) => JSON.stringify({
        version: 1, provider: 'gemini', responseId: id, sessionId: 's1',
        requestedModel: 'claude-gemini-3.7-flash[1m]', servedModel: 'gemini-3.7-flash',
        status: 'completed', source: 'acme.usageMetadata', exact: true,
        observedAt: at(minute),
        tokens: { inputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 50, outputTokens: 20, reasoningOutputTokens: null, visibleOutputTokens: null },
        rawUsage: { input_tokens: 50, output_tokens: 20 },
    });
    fs.writeFileSync(legacyTokens, [legacyToken('old-1', 1), legacyToken('old-2', 2)].join('\n') + '\n');
    fs.writeFileSync(legacyQuotas, JSON.stringify({ version: 1, key: 'acme:1:acme-flash-tiered',
        provider: 'acme', model: 'acme-flash-tiered', observedAt: at(3), usedPercent: 22, resetAt: at(400) }) + '\n');
    fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [
        { t: Date.parse(at(1)), org: 'org-a', u: { fh: 10, sd: 20 } },
        { t: Date.parse(at(5)), org: 'org-a', u: { fh: 15, sd: 21 } },
    ] }));

    const acct = store(root, { legacyTokenFile: legacyTokens, legacyQuotaFile: legacyQuotas, planFile });
    assert.equal(acct.sync(4), true);
    assert.equal(readSegments(root, 'tokens').length, 2);
    assert.equal(readSegments(root, 'quotas').length, 5, '1 gemini row + 4 claude bucket samples');

    // Re-running is a no-op even with a fresh instance and a fresh state read.
    const again = store(root, { legacyTokenFile: legacyTokens, legacyQuotaFile: legacyQuotas, planFile });
    again.sync(4);
    assert.equal(readSegments(root, 'tokens').length, 2);
    assert.equal(readSegments(root, 'quotas').length, 5);

    // A pre-v2 worker that is still draining appends after the first import.
    fs.appendFileSync(legacyTokens, legacyToken('old-3', 9) + '\n');
    again.sync(4);
    assert.deepEqual(readSegments(root, 'tokens').map(row => row.responseId).sort(), ['old-1', 'old-2', 'old-3']);
});

test('a truncated or replaced legacy file rewinds without double counting', () => {
    const root = tempRoot('rewind');
    const legacyTokens = path.join(root, 'provider-usage-v1.jsonl');
    const row = (id) => JSON.stringify({ version: 1, provider: 'claude', responseId: id, servedModel: 'claude-opus-5',
        source: 'anthropic.message.usage', exact: true, observedAt: at(2),
        tokens: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 1, outputTokens: 1, reasoningOutputTokens: null, visibleOutputTokens: null } });
    fs.writeFileSync(legacyTokens, [row('a'), row('b')].join('\n') + '\n');

    const acct = store(root, { legacyTokenFile: legacyTokens });
    acct.sync(4);
    assert.equal(readSegments(root, 'tokens').length, 2);

    fs.writeFileSync(legacyTokens, [row('a'), row('b'), row('c')].join('\n') + '\n');
    acct.sync(4);
    assert.deepEqual(readSegments(root, 'tokens').map(r => r.responseId).sort(), ['a', 'b', 'c']);
});

test('a torn final line never blocks the next durable record', () => {
    const root = tempRoot('torn');
    const acct = store(root);
    acct.record('token', tokenValue(21));
    const segment = acct.tokenSegment('2026-08-30');
    fs.appendFileSync(segment, '{"v":2,"type":"token"');
    acct.shards.clear();
    assert.equal(acct.record('token', tokenValue(22)), 'stored');
    assert.deepEqual(readSegments(root, 'tokens').map(row => row.responseId).sort(), ['resp-21', 'resp-22']);
});

test('rollups are disposable and rebuild to the exact raw segment sums', () => {
    const root = tempRoot('rebuild');
    const acct = store(root);
    for (let index = 1; index <= 40; index += 1)
    {
        acct.record('token', tokenValue(index, {
            provider: index % 2 ? 'openai' : 'gemini',
            servedModel: index % 2 ? 'gpt-5.6-sol' : 'gemini-3.7-flash',
            observedAt: new Date(Date.UTC(2026, 7, 28 + (index % 3), 6, index)).toISOString(),
        }));
    }
    const before = acct.query('all');

    fs.rmSync(path.join(root, 'rollups'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'dedupe'), { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'provider-accounting.mjs'), 'rebuild', '--root', root],
        { encoding: 'utf8' });

    const after = store(root).query('all');
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.models, before.models);

    const raw = readSegments(root, 'tokens');
    const independent = emptyTotals();
    for (const event of raw)
    {
        independent.responses += 1;
        independent.inputTokens += event.tokens.inputTokens;
        independent.cacheReadInputTokens += event.tokens.cacheReadInputTokens;
        independent.cacheCreationInputTokens += event.tokens.cacheCreationInputTokens;
        independent.contextInputTokens += event.tokens.contextInputTokens;
        independent.outputTokens += event.tokens.outputTokens;
        if (event.tokens.reasoningOutputTokens !== null)
        {
            independent.reasoningDetailedResponses += 1;
            independent.reasoningOutputTokens += event.tokens.reasoningOutputTokens;
            independent.visibleOutputTokens += event.tokens.visibleOutputTokens;
        }
    }
    assert.deepEqual(after.totals, independent);
});

test('ranges are exact across a local day boundary and never scan more than one segment', () => {
    const root = tempRoot('range');
    const acct = store(root);
    const now = Date.UTC(2026, 7, 31, 3, 0);
    acct.now = () => now;

    // Local day for UTC-5 starts at 05:00Z on the 30th.
    const stamps = ['2026-08-30T04:30:00.000Z', '2026-08-30T06:00:00.000Z',
        '2026-08-30T23:00:00.000Z', '2026-08-31T02:00:00.000Z'];
    stamps.forEach((observedAt, index) => acct.record('token', tokenValue(100 + index, { observedAt })));

    const today = acct.query('today', 300);
    assert.equal(today.totals.responses, 3, 'the 04:30Z record is the previous local day');
    assert.equal(Date.parse(today.start), Date.UTC(2026, 7, 30, 5, 0));

    const utcToday = acct.query('today', 0);
    assert.equal(utcToday.totals.responses, 1);
    assert.equal(acct.query('all').totals.responses, 4);
    assert.equal(acct.query('7d', 300).totals.responses, 4);
    assert.equal(acct.query('not-a-range', 0).key, 'all');
});

test('a daily timeline and provider split match the all-time rollup', () => {
    const root = tempRoot('timeline');
    const acct = store(root);
    acct.record('token', tokenValue(1, { observedAt: '2026-08-29T10:00:00.000Z' }));
    acct.record('token', tokenValue(2, { observedAt: '2026-08-30T10:00:00.000Z', provider: 'gemini', servedModel: 'gemini-3.7-flash' }));
    const value = acct.query('all');
    assert.equal(value.dailyTimeline.length, 2);
    assert.deepEqual(value.dailyTimeline.map(row => row.date), ['2026-08-29', '2026-08-30']);
    const summed = emptyTotals();
    for (const row of value.dailyTimeline) mergeTotals(summed, row);
    assert.deepEqual(summed, value.totals);
    assert.deepEqual(Object.keys(value.providers).sort(), ['gemini', 'openai']);
});

test('verify reports a tampered sealed segment', () => {
    const root = tempRoot('seal');
    const acct = store(root);
    acct.record('token', tokenValue(1, { observedAt: '2026-08-29T10:00:00.000Z' }));
    const cli = path.join(ROOT, 'scripts', 'provider-accounting.mjs');
    execFileSync(process.execPath, [cli, 'seal', '--root', root, '--now', '2026-08-31T00:00:00.000Z'], { encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(root, 'seals', 'tokens-2026-08-29.json')), true);

    const clean = execFileSync(process.execPath, [cli, 'verify', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(clean).violations.length, 0);

    fs.appendFileSync(acct.tokenSegment('2026-08-29'), JSON.stringify({ v: 2, type: 'token', tampered: true }) + '\n');
    const result = spawnSync(process.execPath, [cli, 'verify', '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).violations[0].reason, 'sha256-mismatch');
});

test('a sealed segment can be backed up and recovered without touching the live day', () => {
    const root = tempRoot('recover');
    const backup = path.join(tempRoot('recover-backup'), 'backups');
    const acct = store(root, { backupRoot: backup });
    acct.record('token', tokenValue(1, { observedAt: '2026-08-29T10:00:00.000Z' }));
    acct.record('token', tokenValue(2, { observedAt: '2026-08-31T10:00:00.000Z' }));

    const cli = path.join(ROOT, 'scripts', 'provider-accounting.mjs');
    execFileSync(process.execPath, [cli, 'seal', '--root', root, '--backup', backup, '--now', '2026-08-31T00:00:00.000Z'],
        { encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(backup, 'segments', 'tokens', 'tokens-2026-08-29.jsonl')), true);

    fs.rmSync(acct.tokenSegment('2026-08-29'));
    const report = JSON.parse(execFileSync(process.execPath,
        [cli, 'recover', '--root', root, '--from', backup, '--json'], { encoding: 'utf8' }));
    assert.equal(report.restored.length, 1);
    assert.equal(fs.existsSync(acct.tokenSegment('2026-08-29')), true);
    assert.equal(store(root).query('all').totals.responses, 2);
});

test('export contains only accounting fields', () => {
    const root = tempRoot('export');
    const acct = store(root);
    acct.record('token', tokenValue(1));
    const out = path.join(root, 'export.json');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'provider-accounting.mjs'),
        'export', '--root', root, '--range', 'all', '--out', out], { encoding: 'utf8' });
    const value = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(value.range.key, 'all');
    assert.equal(value.totals.responses, 1);
    assert.equal(JSON.stringify(value).includes('rawUsage'), false);
});

test('a lost derived index tail is replayed from the raw segment, not double counted', () => {
    const root = tempRoot('repair');
    const acct = store(root);
    for (let index = 1; index <= 6; index += 1) acct.record('token', tokenValue(index));
    const before = acct.query('all');
    assert.equal(before.totals.responses, 6);

    // Simulate power loss after the synced raw append but before the unsynced
    // dedupe shard and rollup writes reached disk.
    fs.rmSync(path.join(root, 'dedupe'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'rollups'), { recursive: true, force: true });
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    state.segments = {};
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));

    // Repair only runs under the lock, so a normal locked operation drives it.
    const reopened = store(root);
    reopened.sync();
    assert.ok(reopened.repaired >= 1, 'the grown segment is detected and recomputed');
    assert.deepEqual(reopened.query('all').totals, before.totals);

    // Replaying the same records again must stay idempotent.
    assert.equal(reopened.record('token', tokenValue(3)), 'duplicate');
    assert.equal(reopened.query('all').totals.responses, 6);
    assert.equal(readSegments(root, 'tokens').length, 6);
});

test('rebuilt dedupe keys still match runtime lookups', () => {
    const root = tempRoot('rebuild-keys');
    const acct = store(root);
    acct.record('token', tokenValue(1));
    acct.record('token', tokenValue(2));

    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'provider-accounting.mjs'), 'rebuild', '--root', root],
        { encoding: 'utf8' });

    // A rebuild that hashed keys with its own separator would silently accept
    // these as new records and double count them.
    const after = store(root);
    assert.equal(after.record('token', tokenValue(1)), 'duplicate');
    assert.equal(after.record('token', tokenValue(2)), 'duplicate');
    assert.equal(readSegments(root, 'tokens').length, 2);
    assert.equal(after.query('all').totals.responses, 2);
});

test('the migrate command imports the real legacy ledgers it defaults to', () => {
    const root = tempRoot('cli-migrate');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const legacy = path.join(stateDir, 'provider-usage-v1.jsonl');
    fs.writeFileSync(legacy, JSON.stringify({
        version: 1, provider: 'openai', responseId: 'cli-1', servedModel: 'gpt-5.6-sol',
        source: 'fixture', exact: true, observedAt: at(3),
        tokens: { inputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 7, outputTokens: 2, reasoningOutputTokens: null, visibleOutputTokens: null },
    }) + '\n');

    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'provider-accounting.mjs'),
        'migrate', '--root', path.join(root, 'store'), '--legacy-usage', legacy,
        '--legacy-limits', path.join(stateDir, 'missing.jsonl'), '--plan', path.join(stateDir, 'missing.json'), '--json'],
        { encoding: 'utf8' });
    assert.equal(JSON.parse(out).totalResponses, 1, 'migrate must not report a completion it never performed');
    assert.equal(readSegments(path.join(root, 'store'), 'tokens').length, 1);
});

test('a legacy file with no trailing newline still yields its last record', () => {
    const root = tempRoot('no-newline');
    const legacy = path.join(root, 'provider-usage-v1.jsonl');
    const row = (id) => JSON.stringify({ version: 1, provider: 'claude', responseId: id, servedModel: 'claude-opus-5',
        source: 'fixture', exact: true, observedAt: at(2),
        tokens: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 1, outputTokens: 1, reasoningOutputTokens: null, visibleOutputTokens: null } });
    fs.writeFileSync(legacy, row('a') + '\n' + row('b'));

    const acct = store(root, { legacyTokenFile: legacy });
    for (let i = 0; i < 4; i += 1) acct.sync(4);
    assert.deepEqual(readSegments(root, 'tokens').map(r => r.responseId).sort(), ['a', 'b']);
});

test('an orphaned merge claim is reclaimed instead of stranding its record', () => {
    const root = tempRoot('orphan');
    const acct = store(root);
    acct.ensure();
    const event = { v: 2, type: 'token', provider: 'openai', responseId: 'orphan-1', servedModel: 'gpt-5.6-sol',
        sessionId: null, requestedModel: null, effort: null, status: 'completed', source: 'fixture', exact: true,
        observedAt: at(5), tokens: { inputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
            contextInputTokens: 3, outputTokens: 1, reasoningOutputTokens: null, visibleOutputTokens: null }, rawUsage: {} };
    const orphan = path.join(acct.spoolDir, '1-2-3-abc.jsonl.merging.999999.deadbeef');
    fs.writeFileSync(orphan, JSON.stringify(event) + '\n');
    const old = Date.now() - 10 * 60 * 1000;
    fs.utimesSync(orphan, old / 1000, old / 1000);

    acct.sync();
    assert.deepEqual(readSegments(root, 'tokens').map(r => r.responseId), ['orphan-1']);
    assert.equal(fs.readdirSync(acct.spoolDir).length, 0);
});

test('appending to a sealed day retires the stale manifest', () => {
    const root = tempRoot('reseal');
    const acct = store(root);
    acct.record('token', tokenValue(1, { observedAt: '2026-08-29T10:00:00.000Z' }));
    const cli = path.join(ROOT, 'scripts', 'provider-accounting.mjs');
    execFileSync(process.execPath, [cli, 'seal', '--root', root, '--now', '2026-08-31T00:00:00.000Z'], { encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(root, 'seals', 'tokens-2026-08-29.json')), true);

    // A late migrated record legitimately lands in a closed day.
    acct.record('token', tokenValue(2, { observedAt: '2026-08-29T11:00:00.000Z' }));
    assert.equal(fs.existsSync(path.join(root, 'seals', 'tokens-2026-08-29.json')), false,
        'the superseded seal must not report a tamper that never happened');
    const verified = execFileSync(process.execPath, [cli, 'verify', '--root', root, '--json'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(verified).violations, []);
});

test('Claude plan migration and live meters agree on one quota identifier', () => {
    const root = tempRoot('bucket-ids');
    const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [
        { t: Date.parse(at(1)), org: 'org-a', u: { fh: 11, so: 22 } },
    ] }));
    const acct = store(root, { planFile });
    acct.sync(4);
    const ids = readSegments(root, 'quotas').map(row => row.quotaId).sort();
    assert.deepEqual(ids, ['five_hour', 'seven_day_opus']);
    assert.equal(readSegments(root, 'quotas').find(r => r.quotaId === 'seven_day_opus').model, 'opus');
});

test('quota history is served per day for the selected window', () => {
    const root = tempRoot('quota-history');
    const acct = store(root);
    for (const [day, percent] of [['2026-08-28', 10], ['2026-08-29', 30], ['2026-08-30', 55]])
        acct.record('quota', { key: 'openai:chatgpt:primary', provider: 'openai', accountId: 'chatgpt',
            quotaId: 'primary', usedPercent: percent, remainingFraction: 1 - percent / 100,
            observedAt: `${day}T12:00:00.000Z`, source: 'chatgpt.wham.usage', exact: true });

    const history = acct.quotaHistory(['openai:chatgpt:primary'],
        { start: '2026-08-28T00:00:00.000Z', end: '2026-08-30T23:59:59.000Z' });
    assert.deepEqual(history['openai:chatgpt:primary'].map(row => row.usedPercent), [10, 30, 55]);
    assert.equal(acct.quotaHistory(['nope'], { start: '2026-08-28', end: '2026-08-30' })['nope'], undefined);
});

test('a derived-layout change recomputes every day, not only the ones that grew', () => {
    const root = tempRoot('derived-version');
    const acct = store(root);
    acct.record('token', tokenValue(1, { observedAt: '2026-08-29T10:00:00.000Z' }));
    acct.record('token', tokenValue(2, { observedAt: '2026-08-30T10:00:00.000Z' }));
    const before = acct.query('all');
    assert.equal(before.totals.responses, 2);

    // Simulate the rollup layout changing under a populated store: the derived
    // files are gone but the watermark still claims every segment is accounted
    // for, so only a version reset can rebuild the older day.
    fs.rmSync(path.join(root, 'rollups'), { recursive: true, force: true });
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    delete state.derivedVersion;
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));

    const reopened = store(root);
    reopened.sync();
    assert.deepEqual(reopened.query('all').totals, before.totals);
    assert.deepEqual(reopened.query('all').dailyTimeline.map(row => row.date), ['2026-08-29', '2026-08-30']);
});
