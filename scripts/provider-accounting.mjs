#!/usr/bin/env node
// Operator tooling for the permanent provider accounting store.
//
//   verify   hash sealed segments against their manifests            (read-only)
//   rebuild  regenerate every derived index from the raw segments
//   seal     close finished UTC days and copy them to the backup root
//   migrate  import the legacy v1 ledgers and the Claude plan history
//   export   write one range's accounting totals to a file
//   recover  restore a missing or corrupt closed segment from backup
//
// Raw segments are never deleted by any subcommand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountingStore, emptyTotals, addTotals, tokenKeyOf, quotaKeyOf } from '../router/accounting.mjs';

const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback = null)
{
    const at = args.indexOf('--' + name);
    if (at === -1) return fallback;
    const value = args[at + 1];
    return value && !value.startsWith('--') ? value : true;
}

const JSON_OUT = args.includes('--json');
const ROOT = flag('root') || process.env.MODEL_ROUTER_ACCOUNTING_DIR
    || path.join(os.homedir(), '.claude', 'gemini-bridge', 'provider-accounting-v2');
const BACKUP = flag('backup') || process.env.MODEL_ROUTER_ACCOUNTING_BACKUP_DIR || path.join(ROOT, 'backups');

const say = (value) => process.stdout.write(JSON_OUT ? JSON.stringify(value, null, 2) + '\n' : value.text + '\n');

function newStore()
{
    const nowFlag = flag('now');
    const stateDir = process.env.MODEL_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'gemini-bridge');
    const options = {
        root: ROOT,
        backupRoot: BACKUP,
        // Without these the migrate subcommand imports nothing and then reports
        // a completion it never performed.
        legacyTokenFile: flag('legacy-usage')
            || process.env.MODEL_ROUTER_USAGE_FILE || path.join(stateDir, 'provider-usage-v1.jsonl'),
        legacyQuotaFile: flag('legacy-limits')
            || process.env.MODEL_ROUTER_LIMIT_HISTORY_FILE || path.join(stateDir, 'provider-limit-history-v1.jsonl'),
        planFile: flag('plan') || process.env.MODEL_ROUTER_PLAN_USAGE_FILE
            || path.join(process.env.APPDATA || os.homedir(), 'Claude', 'plan-usage-history.json'),
    };
    if (typeof nowFlag === 'string') options.now = () => Date.parse(nowFlag);
    return new AccountingStore(options);
}

function segmentFiles(store, kind)
{
    const dir = kind === 'tokens' ? store.tokensDir : store.quotasDir;
    try { return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
    catch (_) { return []; }
}

const dayOfName = (name) => name.slice(name.indexOf('-') + 1, -6);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function readEvents(file)
{
    const rows = [];
    let malformed = 0;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { rows, malformed }; }
    for (const line of raw.split('\n'))
    {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); }
        catch (_) { malformed += 1; }
    }
    return { rows, malformed };
}

// ------------------------------------------------------------------ rebuild --
function rebuild(store)
{
    store.ensure();
    const result = store.locked(() => {
        for (const name of ['dedupe', 'rollups'])
            fs.rmSync(path.join(store.root, name), { recursive: true, force: true });
        store.shards.clear();
        store.quotaIds.clear();
        store.quotaLatest = {};
        store.quotaLatestDirty = true;
        store.tokenYears.clear();
        store.quotaYears.clear();
        store.yearSummaries = {};
        store.state.segments = {};
        store.dirtyState = true;
        fs.mkdirSync(store.tokenShardDir, { recursive: true });

        let tokenCount = 0;
        let quotaCount = 0;
        let malformed = 0;
        for (const kind of ['tokens', 'quotas'])
        {
            for (const name of segmentFiles(store, kind))
            {
                const day = dayOfName(name);
                const parsed = readEvents(path.join(kind === 'tokens' ? store.tokensDir : store.quotasDir, name));
                malformed += parsed.malformed;
                store.recomputeDay(kind, day);
                const rows = store.readSegment(kind, day);
                if (kind === 'tokens') { tokenCount += rows.length; continue; }
                quotaCount += rows.length;
                for (const event of rows)
                {
                    const previous = store.quotaLatest[event.key];
                    if (!previous || Date.parse(event.observedAt) >= Date.parse(previous.observedAt))
                        store.quotaLatest[event.key] = { usedPercent: event.usedPercent,
                            remainingFraction: event.remainingFraction, resetAt: event.resetAt, observedAt: event.observedAt };
                }
            }
        }
        return { tokenCount, quotaCount, malformed };
    });
    if (!result.held) throw new Error('another process holds the accounting lock');
    return { ...result.value, totals: store.allTime().totals };
}

// --------------------------------------------------------------------- seal --
function copyInto(file, destDir)
{
    fs.mkdirSync(destDir, { recursive: true });
    const target = path.join(destDir, path.basename(file));
    // Stage inside the destination directory so the rename never crosses a
    // volume: an external backup root is usually a different drive.
    const temp = `${target}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    fs.copyFileSync(file, temp);
    fs.renameSync(temp, target);
    return target;
}

function seal(store)
{
    store.ensure();
    const today = new Date(store.now()).toISOString().slice(0, 10);
    const sealed = [];
    const backedUp = [];
    for (const kind of ['tokens', 'quotas'])
    {
        const dir = kind === 'tokens' ? store.tokensDir : store.quotasDir;
        for (const name of segmentFiles(store, kind))
        {
            const day = dayOfName(name);
            if (day >= today) continue;
            const file = path.join(dir, name);
            const stat = fs.statSync(file);
            const parsed = readEvents(file);
            const totals = emptyTotals();
            let first = null;
            let last = null;
            for (const event of parsed.rows)
            {
                if (kind === 'tokens' && event?.tokens) addTotals(totals, event);
                if (!first || event.observedAt < first) first = event.observedAt;
                if (!last || event.observedAt > last) last = event.observedAt;
            }
            const manifest = {
                version: 1, kind, segment: name, day,
                byteLength: stat.size, records: parsed.rows.length, malformed: parsed.malformed,
                firstObservedAt: first, lastObservedAt: last,
                sha256: sha256(file), sealedAt: new Date(store.now()).toISOString(),
                totals: kind === 'tokens' ? totals : null,
            };
            store.writeAtomic(path.join(store.sealDir, `${kind}-${day}.json`), manifest);
            sealed.push(name);
            backedUp.push(copyInto(file, path.join(BACKUP, 'segments', kind)));
            copyInto(path.join(store.sealDir, `${kind}-${day}.json`), path.join(BACKUP, 'seals'));
        }
    }
    for (const name of ['all-time.json', 'daily.json', 'quota-daily.json'])
    {
        const file = path.join(store.rollupDir, name);
        if (fs.existsSync(file)) copyInto(file, path.join(BACKUP, 'rollups'));
    }
    return { sealed, backedUp, backupRoot: BACKUP };
}

// ------------------------------------------------------------------- verify --
function verify(store)
{
    const violations = [];
    let verified = 0;
    let seals = [];
    try { seals = fs.readdirSync(store.sealDir).filter(name => name.endsWith('.json')); }
    catch (_) {}
    for (const name of seals)
    {
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(path.join(store.sealDir, name), 'utf8')); }
        catch (error) { violations.push({ seal: name, reason: 'unreadable-manifest' }); continue; }
        const dir = manifest.kind === 'tokens' ? store.tokensDir : store.quotasDir;
        const file = path.join(dir, manifest.segment);
        if (!fs.existsSync(file)) { violations.push({ seal: name, segment: manifest.segment, reason: 'missing-segment' }); continue; }
        const actual = sha256(file);
        if (actual !== manifest.sha256)
            violations.push({ seal: name, segment: manifest.segment, reason: 'sha256-mismatch', expected: manifest.sha256, actual });
        else verified += 1;
    }
    return { verified, violations, backupRoot: BACKUP };
}

// ------------------------------------------------------------------ recover --
function recover(store, from)
{
    if (!from) throw new Error('recover requires --from <backup-root>');
    const today = new Date(store.now()).toISOString().slice(0, 10);
    const restored = [];
    const refused = [];
    for (const kind of ['tokens', 'quotas'])
    {
        const sourceDir = path.join(from, 'segments', kind);
        const targetDir = kind === 'tokens' ? store.tokensDir : store.quotasDir;
        let names = [];
        try { names = fs.readdirSync(sourceDir).filter(name => name.endsWith('.jsonl')); }
        catch (_) { continue; }
        for (const name of names)
        {
            const day = dayOfName(name);
            const target = path.join(targetDir, name);
            if (day >= today) { refused.push({ segment: name, reason: 'active-day-requires-explicit-restore' }); continue; }
            const source = path.join(sourceDir, name);
            if (fs.existsSync(target) && sha256(target) === sha256(source)) continue;
            if (fs.existsSync(target))
            {
                const quarantine = `${target}.superseded.${Date.now()}`;
                fs.renameSync(target, quarantine);
                refused.push({ segment: name, reason: 'live-copy-preserved', at: quarantine });
            }
            fs.mkdirSync(targetDir, { recursive: true });
            copyInto(source, targetDir);
            restored.push(name);
        }
    }
    const rebuilt = restored.length ? rebuild(store) : null;
    return { restored, refused, rebuilt: rebuilt ? rebuilt.totals : null };
}

// ------------------------------------------------------------------- export --
function exportRange(store, range, out)
{
    const value = store.query(range || 'all', Number(flag('tz', '0')) || 0);
    const payload = {
        version: 1,
        generatedAt: new Date(store.now()).toISOString(),
        range: { key: value.key, start: value.start, end: value.end },
        totals: value.totals,
        providers: value.providers,
        models: value.models,
        dailyTimeline: value.dailyTimeline,
    };
    if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2)); }
    return payload;
}

// --------------------------------------------------------------------- main --
try
{
    const store = newStore();
    if (command === 'verify')
    {
        const result = verify(store);
        say({ ...result, text: `verified ${result.verified} sealed segment(s); ${result.violations.length} violation(s)` });
        process.exit(result.violations.length ? 1 : 0);
    }
    else if (command === 'rebuild')
    {
        const result = rebuild(store);
        say({ ...result, text: `rebuilt ${result.tokenCount} token and ${result.quotaCount} quota record(s); ${result.malformed} malformed line(s) skipped` });
    }
    else if (command === 'seal')
    {
        const result = seal(store);
        say({ ...result, text: `sealed ${result.sealed.length} segment(s) into ${result.backupRoot}` });
    }
    else if (command === 'migrate')
    {
        if (args.includes('--dry-run'))
        {
            const preview = store.migrateBatch();
            say({ tokens: preview.tokens.length, quotas: preview.quotas.length, done: preview.done,
                text: `would import ${preview.tokens.length} token and ${preview.quotas.length} quota record(s)` });
        }
        else
        {
            let complete = false;
            for (let i = 0; i < 512 && !complete; i += 1) complete = store.sync(4);
            const status = store.status();
            say({ ...status, text: `migration complete=${complete}; ${status.totalResponses} response(s) recorded` });
        }
    }
    else if (command === 'export')
    {
        const payload = exportRange(store, flag('range', 'all'), flag('out'));
        say({ ...payload, text: `exported ${payload.totals.responses} response(s) for range ${payload.range.key}` });
    }
    else if (command === 'recover')
    {
        const result = recover(store, flag('from'));
        say({ ...result, text: `restored ${result.restored.length} segment(s); ${result.refused.length} refused` });
    }
    else if (command === 'status')
    {
        const status = store.status();
        say({ ...status, text: `${status.totalResponses} response(s); first=${status.firstRecordedAt}; backup external=${status.backup.external}` });
    }
    else
    {
        process.stderr.write('usage: provider-accounting.mjs <verify|rebuild|seal|migrate|export|recover|status> [--root DIR] [--backup DIR] [--json]\n');
        process.exit(2);
    }
}
catch (error)
{
    process.stderr.write(String(error?.stack || error) + '\n');
    process.exit(1);
}
