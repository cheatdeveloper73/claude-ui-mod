// Permanent provider accounting. Timestamped token events and subscription
// quota observations only -- no prompt, response, tool, or credential text ever
// reaches this store. See docs/orchestration/usage-all-time/contract.md.
//
// Raw daily JSONL segments are authoritative. Every index, rollup and seal is
// derived: deleting the whole rollups/ and dedupe/ tree loses nothing.
//
// Two router generations overlap for up to ten minutes during a blue-green
// swap, so every mutation is guarded by a cross-process lock. The inference
// path never waits on that lock: a contended append goes to its own immutable
// one-event spool file and is merged by whoever holds the lock next. Losing the
// race must never cost a token record, and must never stall an SSE stream.
import crypto from 'node:crypto';

import { emptyCost, foldCost, pricedModels, PRICING_FINGERPRINT, RATES } from './pricing.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 2;

// Bumped whenever the derived layout changes. A mismatch clears the watermark
// so every segment is recomputed once: the year-sharded rollups replaced a flat
// daily file, and without this the new code would start from an empty rollup
// and only backfill the days that happened to grow afterwards.
const DERIVED_VERSION = 2;
const STALE_LOCK_MS = 30000;
const STALE_MERGE_MS = 120000;
const SHARD_CACHE = 64;
const QUOTA_HEARTBEAT_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 128;
const LEGACY_CHUNK = 512 * 1024;

// A 128-bit prefix of SHA-256. Full-width hashes would trade ~2x the dedupe
// index size for collision odds already far below the chance of disk error.
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

// NUL is the separator because it cannot occur in any provider identifier, so
// no two different field pairs can collapse onto one key. Every producer of a
// dedupe key must import these: a tool that rebuilt the index with a different
// separator would silently stop matching runtime lookups.
export const tokenKeyOf = (event) => digest(event.provider + '\u0000' + event.responseId);
export const quotaKeyOf = (event) => digest(event.key + '\u0000' + event.observedAt);

const nonce = () => crypto.randomBytes(9).toString('hex');
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonneg = (value) => Math.max(0, finite(value) ?? 0);
const clampPercent = (value) => finite(value) === null ? null : Math.max(0, Math.min(100, value));

function isoOf(value)
{
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const dayOf = (iso) => iso.slice(0, 10);
const yearOf = (day) => day.slice(0, 4);

const TOTAL_KEYS = [
    'responses',
    'inputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    // The cache write's TTL decides its price, so the split has to survive
    // into the rollup; the aggregate alone cannot be priced without guessing.
    'cacheCreation5mTokens',
    'cacheCreation1hTokens',
    'contextInputTokens',
    'outputTokens',
    'reasoningDetailedResponses',
    'reasoningOutputTokens',
    'visibleOutputTokens',
];

const emptyTotals = () => Object.fromEntries(TOTAL_KEYS.map(key => [key, 0]));

function addTotals(target, entry)
{
    target.responses += 1;
    target.inputTokens += nonneg(entry.tokens.inputTokens);
    target.cacheReadInputTokens += nonneg(entry.tokens.cacheReadInputTokens);
    target.cacheCreationInputTokens += nonneg(entry.tokens.cacheCreationInputTokens);
    target.cacheCreation5mTokens += nonneg(entry.tokens.cacheCreation5mTokens);
    target.cacheCreation1hTokens += nonneg(entry.tokens.cacheCreation1hTokens);
    target.contextInputTokens += nonneg(entry.tokens.contextInputTokens);
    target.outputTokens += nonneg(entry.tokens.outputTokens);
    if (finite(entry.tokens.reasoningOutputTokens) !== null)
    {
        target.reasoningDetailedResponses += 1;
        target.reasoningOutputTokens += nonneg(entry.tokens.reasoningOutputTokens);
        target.visibleOutputTokens += nonneg(entry.tokens.visibleOutputTokens);
    }
    return target;
}

function mergeTotals(target, source)
{
    for (const key of TOTAL_KEYS) target[key] = (target[key] || 0) + (source?.[key] || 0);
    return target;
}

// ------------------------------------------------------------ sanitizing ----

// The allowlist is the security boundary, not a convenience: anything the
// provider adds later is dropped rather than persisted by accident.
const RAW_TOKEN_KEYS = new Set([
    'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
    'promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount',
    'totalTokenCount', 'totalBillableCharacters',
]);

// Claude Desktop abbreviates its plan buckets. Migration and live normalization
// have to agree on one identifier or the same window lands under two ids.
const CLAUDE_BUCKETS = {
    fh: 'five_hour', sd: 'seven_day', so: 'seven_day_opus', sn: 'seven_day_sonnet',
    oa: 'seven_day_oauth_apps', cw: 'seven_day_cowork', om: 'seven_day_omelette',
    op: 'omelette_promotional', xu: 'extra_usage',
};
const CLAUDE_BUCKET_MODEL = { so: 'opus', sn: 'sonnet' };

function rawUsageCopy(raw)
{
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const key of RAW_TOKEN_KEYS) if (typeof raw[key] === 'number') out[key] = nonneg(raw[key]);
    const thinking = raw.output_tokens_details?.thinking_tokens;
    const reasoning = raw.output_tokens_details?.reasoning_tokens;
    if (typeof thinking === 'number' || typeof reasoning === 'number')
    {
        out.output_tokens_details = {};
        if (typeof thinking === 'number') out.output_tokens_details.thinking_tokens = nonneg(thinking);
        if (typeof reasoning === 'number') out.output_tokens_details.reasoning_tokens = nonneg(reasoning);
    }
    const cached = raw.input_tokens_details?.cached_tokens;
    if (typeof cached === 'number') out.input_tokens_details = { cached_tokens: nonneg(cached) };
    return out;
}

const text = (value, limit = 200) => value === null || value === undefined
    ? null
    : String(value).replace(/[\r\n\t]+/g, ' ').slice(0, limit);

export function tokenEvent(value)
{
    const observedAt = isoOf(value?.observedAt) || new Date().toISOString();
    if (!value?.provider || !value?.responseId || !value?.servedModel || !value?.tokens) return null;
    return {
        v: SCHEMA,
        type: 'token',
        provider: text(value.provider, 32),
        responseId: text(value.responseId, 128),
        sessionId: value.sessionId ? text(value.sessionId, 128) : null,
        requestedModel: value.requestedModel ? text(value.requestedModel, 128) : null,
        servedModel: text(value.servedModel, 128),
        effort: value.effort ? text(value.effort, 32) : null,
        status: text(value.status || 'completed', 32),
        source: text(value.source || 'unknown', 64),
        exact: value.exact === true,
        observedAt,
        tokens: {
            inputTokens: nonneg(value.tokens.inputTokens),
            cacheReadInputTokens: nonneg(value.tokens.cacheReadInputTokens),
            cacheCreationInputTokens: nonneg(value.tokens.cacheCreationInputTokens),
            cacheCreation5mTokens: nonneg(value.tokens.cacheCreation5mTokens),
            cacheCreation1hTokens: nonneg(value.tokens.cacheCreation1hTokens),
            contextInputTokens: nonneg(value.tokens.contextInputTokens),
            outputTokens: nonneg(value.tokens.outputTokens),
            reasoningOutputTokens: finite(value.tokens.reasoningOutputTokens) === null ? null : nonneg(value.tokens.reasoningOutputTokens),
            visibleOutputTokens: finite(value.tokens.visibleOutputTokens) === null ? null : nonneg(value.tokens.visibleOutputTokens),
        },
        rawUsage: rawUsageCopy(value.rawUsage),
    };
}

export function quotaEvent(value)
{
    const observedAt = isoOf(value?.observedAt);
    const usedPercent = clampPercent(value?.usedPercent);
    if (!value?.key || !value?.provider || !observedAt || usedPercent === null) return null;
    return {
        v: SCHEMA,
        type: 'quota',
        key: text(value.key, 160),
        provider: text(value.provider, 32),
        accountId: value.accountId === null || value.accountId === undefined ? null : text(value.accountId, 96),
        accountName: value.accountName ? text(value.accountName, 160) : null,
        quotaId: value.quotaId ? text(value.quotaId, 96) : null,
        model: value.model ? text(value.model, 96) : null,
        usedPercent,
        remainingFraction: finite(value.remainingFraction),
        resetAt: isoOf(value.resetAt),
        observedAt,
        source: text(value.source || 'unknown', 96),
        exact: value.exact === true,
        schedulable: value.schedulable !== false,
        aggregate: value.aggregate === true,
        status: value.status ? text(value.status, 32) : null,
        tier: value.tier ? text(value.tier, 32) : null,
    };
}

// ----------------------------------------------------------------- store ----

export class AccountingStore
{
    // The constructor computes paths and nothing else. A rejected candidate
    // worker imports this module, answers /healthz and runs the canary without
    // ever creating a directory, so an unaccepted generation cannot mutate
    // permanent state.
    constructor(options = {})
    {
        this.root = options.root;
        this.backupRoot = options.backupRoot || path.join(this.root, 'backups');
        this.legacyTokenFile = options.legacyTokenFile || null;
        this.legacyQuotaFile = options.legacyQuotaFile || null;
        this.planFile = options.planFile || null;
        this.now = options.now || (() => Date.now());

        this.tokensDir = path.join(this.root, 'segments', 'tokens');
        this.quotasDir = path.join(this.root, 'segments', 'quotas');
        this.tokenShardDir = path.join(this.root, 'dedupe', 'tokens');
        this.quotaIdDir = path.join(this.root, 'dedupe');
        this.rollupDir = path.join(this.root, 'rollups');
        this.sealDir = path.join(this.root, 'seals');
        this.spoolDir = path.join(this.root, 'spool');
        this.lockDir = path.join(this.root, 'writer.lock');
        this.stateFile = path.join(this.root, 'state.json');
        this.quotaLatestFile = path.join(this.root, 'dedupe', 'quota-latest.json');

        this.shards = new Map();
        this.eventCache = new Map();
        this.quotaIds = new Map();
        this.quotaLatest = null;
        this.quotaLatestDirty = false;
        this.state = null;
        this.yearSummaries = null;
        this.tokenYears = new Map();
        this.quotaYears = new Map();
        this.dirtyTokenYears = new Set();
        this.dirtyQuotaYears = new Set();
        this.dirtyState = false;
        this.ready = false;
        this.spooled = 0;
        this.repaired = 0;
        this.lastError = null;
    }

    // -------------------------------------------------------------- paths --
    tokenSegment(day) { return path.join(this.tokensDir, `tokens-${day}.jsonl`); }
    quotaSegment(day) { return path.join(this.quotasDir, `quotas-${day}.jsonl`); }
    tokenShard(prefix) { return path.join(this.tokenShardDir, prefix + '.ids'); }
    quotaIdFile(day) { return path.join(this.quotaIdDir, `quotas-${day}.ids`); }
    tokenYearFile(year) { return path.join(this.rollupDir, `daily-${year}.json`); }
    quotaYearFile(year) { return path.join(this.rollupDir, `quota-${year}.json`); }
    summaryFile() { return path.join(this.rollupDir, 'all-time.json'); }
    sealFile(kind, day) { return path.join(this.sealDir, `${kind}-${day}.json`); }
    segmentFile(kind, day) { return kind === 'tokens' ? this.tokenSegment(day) : this.quotaSegment(day); }

    ensure()
    {
        if (this.ready) return;
        for (const dir of [this.tokensDir, this.quotasDir, this.tokenShardDir, this.rollupDir,
            this.sealDir, this.spoolDir]) fs.mkdirSync(dir, { recursive: true });
        this.ready = true;
    }

    // --------------------------------------------------------------- lock --
    readOwner()
    {
        try { return JSON.parse(fs.readFileSync(path.join(this.lockDir, 'owner.json'), 'utf8')); }
        catch (_) { return null; }
    }

    alive(pid)
    {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        if (pid === process.pid) return true;
        try { process.kill(pid, 0); return true; }
        catch (error) { return error.code === 'EPERM'; }
    }

    // Reclaiming a crashed owner is a claim, not a delete: two contenders that
    // both see the same stale owner would otherwise each delete the other's
    // fresh lock and both believe they hold it.
    reclaim()
    {
        const owner = this.readOwner();
        if (owner)
        {
            if (this.alive(owner.pid)) return false;
            if (this.now() - (owner.at || 0) < STALE_LOCK_MS) return false;
        }
        else
        {
            let stat;
            try { stat = fs.statSync(this.lockDir); } catch (_) { return false; }
            if (this.now() - stat.mtimeMs < STALE_LOCK_MS) return false;
        }

        const claim = path.join(this.lockDir, 'reclaim');
        try { fs.closeSync(fs.openSync(claim, 'wx')); }
        catch (_) { return false; }

        const again = this.readOwner();
        if (JSON.stringify(again) !== JSON.stringify(owner))
        {
            try { fs.unlinkSync(claim); } catch (_) {}
            return false;
        }

        const tomb = `${this.lockDir}.dead.${nonce()}`;
        try { fs.renameSync(this.lockDir, tomb); }
        catch (_) { return false; }
        try { fs.mkdirSync(this.lockDir); }
        catch (_) { try { fs.rmSync(tomb, { recursive: true, force: true }); } catch (_) {} return false; }
        try { fs.rmSync(tomb, { recursive: true, force: true }); } catch (_) {}
        return true;
    }

    acquire()
    {
        this.ensure();
        let created = false;
        try { fs.mkdirSync(this.lockDir); created = true; }
        catch (error)
        {
            if (error.code !== 'EEXIST') throw error;
            created = this.reclaim();
        }
        if (!created) return null;
        const token = nonce();
        fs.writeFileSync(path.join(this.lockDir, 'owner.json'),
            JSON.stringify({ pid: process.pid, nonce: token, at: this.now() }));
        return token;
    }

    release(token)
    {
        const owner = this.readOwner();
        if (owner && owner.nonce !== token) return;
        try { fs.rmSync(this.lockDir, { recursive: true, force: true }); } catch (_) {}
    }

    // Every mutation runs here. Derived state is loaded, repaired and flushed
    // inside one lock, so a reader can never observe a half-swapped rollup and
    // two writers can never interleave index writes.
    locked(work)
    {
        const token = this.acquire();
        if (!token) return { held: false, value: undefined };
        try
        {
            this.load();
            this.repairLocked();
            const value = work();
            this.flush();
            return { held: true, value };
        }
        finally { this.release(token); }
    }

    // --------------------------------------------------------- derived io --
    loadJSON(file, fallback)
    {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (_) { return fallback; }
    }

    writeAtomic(file, value)
    {
        // The temp file is created beside its destination so the rename stays
        // on one volume: an external backup root is often a different drive.
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp.${process.pid}.${nonce()}`;
        const fd = fs.openSync(temp, 'w');
        try
        {
            fs.writeFileSync(fd, JSON.stringify(value));
            fs.fsyncSync(fd);
        }
        finally { fs.closeSync(fd); }
        fs.renameSync(temp, file);
    }

    writeAtomicLines(file, lines)
    {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp.${process.pid}.${nonce()}`;
        fs.writeFileSync(temp, lines.length ? lines.join('\n') + '\n' : '');
        fs.renameSync(temp, file);
    }

    // Reading is pure. Repair and flush only happen under the lock, so a
    // dashboard query can never mutate the store out from under a writer.
    load()
    {
        if (this.state) return;
        this.state = this.loadJSON(this.stateFile, { version: 1, legacy: {}, segments: {}, migrationComplete: false });
        this.yearSummaries = this.loadJSON(this.summaryFile(), { version: 1, years: {} }).years || {};
        if (this.state.derivedVersion !== DERIVED_VERSION)
        {
            this.state.derivedVersion = DERIVED_VERSION;
            this.state.segments = {};
            this.yearSummaries = {};
            this.dirtyState = true;
        }
    }

    // Rollups are sharded by year and loaded on demand: a decade of quota
    // observations is far too large to hold whole, and a range query only ever
    // needs the years it covers.
    tokenYear(year)
    {
        if (!this.tokenYears.has(year)) this.tokenYears.set(year, this.loadJSON(this.tokenYearFile(year), { days: {} }).days || {});
        return this.tokenYears.get(year);
    }

    quotaYear(year)
    {
        if (!this.quotaYears.has(year)) this.quotaYears.set(year, this.loadJSON(this.quotaYearFile(year), { days: {} }).days || {});
        return this.quotaYears.get(year);
    }

    availableYears(kind)
    {
        const prefix = kind === 'tokens' ? 'daily-' : 'quota-';
        const years = new Set();
        try
        {
            for (const name of fs.readdirSync(this.rollupDir))
                if (name.startsWith(prefix) && name.endsWith('.json')) years.add(name.slice(prefix.length, -5));
        }
        catch (_) {}
        for (const year of kind === 'tokens' ? this.tokenYears.keys() : this.quotaYears.keys()) years.add(year);
        return [...years].sort();
    }

    flush()
    {
        for (const year of this.dirtyTokenYears)
        {
            this.writeAtomic(this.tokenYearFile(year), { version: 1, generatedAt: new Date(this.now()).toISOString(), days: this.tokenYear(year) });
            this.yearSummaries[year] = this.summarizeYear(year);
        }
        for (const year of this.dirtyQuotaYears)
            this.writeAtomic(this.quotaYearFile(year), { version: 1, generatedAt: new Date(this.now()).toISOString(), days: this.quotaYear(year) });
        if (this.dirtyTokenYears.size)
            this.writeAtomic(this.summaryFile(), { version: 1, generatedAt: new Date(this.now()).toISOString(), years: this.yearSummaries });
        if (this.quotaLatestDirty) { this.writeAtomic(this.quotaLatestFile, this.quotaLatest); this.quotaLatestDirty = false; }

        // The watermark is written last. A crash before it replays the segment
        // tail on the next locked operation, and replay recomputes whole days
        // rather than re-adding rows, so replaying is idempotent.
        if (this.dirtyState || this.dirtyTokenYears.size || this.dirtyQuotaYears.size)
        {
            this.state.segments = this.segmentSizes();
            this.writeAtomic(this.stateFile, this.state);
        }
        this.dirtyTokenYears.clear();
        this.dirtyQuotaYears.clear();
        this.dirtyState = false;
    }

    summarizeYear(year)
    {
        const totals = emptyTotals();
        const byProvider = {};
        const byModel = {};
        let first = null;
        let last = null;
        for (const bucket of Object.values(this.tokenYear(year)))
        {
            mergeTotals(totals, bucket.totals);
            for (const [provider, value] of Object.entries(bucket.byProvider || {})) mergeTotals(byProvider[provider] ||= emptyTotals(), value);
            for (const [id, value] of Object.entries(bucket.byModel || {}))
                mergeTotals(byModel[id] ||= { provider: value.provider, model: value.model, ...emptyTotals() }, value);
            if (bucket.first && (!first || bucket.first < first)) first = bucket.first;
            if (bucket.last && (!last || bucket.last > last)) last = bucket.last;
        }
        return { totals, byProvider, byModel, first, last };
    }

    allTime()
    {
        this.load();
        const totals = emptyTotals();
        const byProvider = {};
        const byModel = {};
        let first = null;
        let last = null;
        for (const summary of Object.values(this.yearSummaries))
        {
            mergeTotals(totals, summary.totals);
            for (const [provider, value] of Object.entries(summary.byProvider || {})) mergeTotals(byProvider[provider] ||= emptyTotals(), value);
            for (const [id, value] of Object.entries(summary.byModel || {}))
                mergeTotals(byModel[id] ||= { provider: value.provider, model: value.model, ...emptyTotals() }, value);
            if (summary.first && (!first || summary.first < first)) first = summary.first;
            if (summary.last && (!last || summary.last > last)) last = summary.last;
        }
        return { totals, byProvider, byModel, firstRecordedAt: first, lastRecordedAt: last };
    }

    // ------------------------------------------------------------- dedupe --
    shardSet(prefix)
    {
        const file = this.tokenShard(prefix);
        const cached = this.shards.get(file);
        if (cached)
        {
            this.shards.delete(file);
            this.shards.set(file, cached);
            return cached;
        }
        const set = new Set();
        try
        {
            for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.length === 32) set.add(line);
        }
        catch (_) {}
        this.shards.set(file, set);
        while (this.shards.size > SHARD_CACHE) this.shards.delete(this.shards.keys().next().value);
        return set;
    }

    quotaIdSet(day)
    {
        const cached = this.quotaIds.get(day);
        if (cached) return cached;
        const set = new Set();
        try
        {
            for (const line of fs.readFileSync(this.quotaIdFile(day), 'utf8').split('\n')) if (line.length === 32) set.add(line);
        }
        catch (_) {}
        this.quotaIds.set(day, set);
        while (this.quotaIds.size > 8) this.quotaIds.delete(this.quotaIds.keys().next().value);
        return set;
    }

    loadQuotaLatest()
    {
        if (this.quotaLatest) return this.quotaLatest;
        this.quotaLatest = this.loadJSON(this.quotaLatestFile, {});
        return this.quotaLatest;
    }

    // -------------------------------------------------------------- append --

    // `durable` is false for derived indexes. Measured on the first import of
    // 5,365 legacy records: fsyncing every dedupe shard cost 5.9s of 7.6s. The
    // raw segment is the evidence and is always synced; a lost index tail is
    // detected by recorded segment size and rebuilt by repairLocked().
    appendLines(file, lines, durable = true)
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
            fs.writeSync(fd, prefix + lines.join('\n') + '\n');
            if (durable) fs.fsyncSync(fd);
        }
        finally { fs.closeSync(fd); }
    }

    segmentSizes()
    {
        const sizes = {};
        for (const [kind, dir] of [['tokens', this.tokensDir], ['quotas', this.quotasDir]])
        {
            let names = [];
            try { names = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')); }
            catch (_) { continue; }
            for (const name of names)
            {
                try { sizes[`${kind}/${name}`] = fs.statSync(path.join(dir, name)).size; } catch (_) {}
            }
        }
        return sizes;
    }

    readSegment(kind, day)
    {
        const rows = [];
        let raw = '';
        try { raw = fs.readFileSync(this.segmentFile(kind, day), 'utf8'); }
        catch (_) { return rows; }
        const seen = new Set();
        for (const line of raw.split('\n'))
        {
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch (_) { continue; }
            if (kind === 'tokens' && (event?.type !== 'token' || !event.tokens || !event.observedAt)) continue;
            if (kind === 'quotas' && (event?.type !== 'quota' || !event.observedAt)) continue;
            const key = kind === 'tokens' ? tokenKeyOf(event) : quotaKeyOf(event);
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(event);
        }
        return rows;
    }

    // Recomputing a whole day from its raw segment is what makes replay safe.
    // Incrementally re-adding rows would double count whenever a rollup reached
    // disk but its watermark did not.
    recomputeDay(kind, day)
    {
        const year = yearOf(day);
        const rows = this.readSegment(kind, day);
        if (kind === 'tokens')
        {
            const bucket = { totals: emptyTotals(), byProvider: {}, byModel: {}, first: null, last: null };
            const keys = [];
            for (const event of rows)
            {
                const modelId = `${event.provider}:${event.servedModel}`;
                addTotals(bucket.totals, event);
                addTotals(bucket.byProvider[event.provider] ||= emptyTotals(), event);
                addTotals(bucket.byModel[modelId] ||= { provider: event.provider, model: event.servedModel, ...emptyTotals() }, event);
                if (!bucket.first || event.observedAt < bucket.first) bucket.first = event.observedAt;
                if (!bucket.last || event.observedAt > bucket.last) bucket.last = event.observedAt;
                keys.push(tokenKeyOf(event));
            }
            const days = this.tokenYear(year);
            if (rows.length) days[day] = bucket; else delete days[day];
            this.dirtyTokenYears.add(year);
            for (const key of keys) this.shardSet(key.slice(0, 2)).add(key);
            for (const prefix of new Set(keys.map(key => key.slice(0, 2))))
                this.writeAtomicLines(this.tokenShard(prefix), [...this.shardSet(prefix)]);
        }
        else
        {
            const bucket = {};
            const set = this.quotaIdSet(day);
            for (const event of rows)
            {
                this.foldQuota(bucket, event);
                set.add(quotaKeyOf(event));
            }
            const days = this.quotaYear(year);
            if (rows.length) days[day] = bucket; else delete days[day];
            this.dirtyQuotaYears.add(year);
            this.writeAtomicLines(this.quotaIdFile(day), [...set]);
        }
    }

    // A crash between a synced raw append and an unsynced index write leaves
    // derived state behind the evidence. Comparing recorded segment sizes costs
    // one stat per segment; any day that grew is recomputed from scratch.
    repairLocked()
    {
        const recorded = this.state.segments || {};
        const actual = this.segmentSizes();
        let repaired = 0;
        for (const [id, size] of Object.entries(actual))
        {
            if (size <= (recorded[id] || 0)) continue;
            const kind = id.slice(0, id.indexOf('/'));
            const name = id.slice(id.indexOf('/') + 1);
            this.recomputeDay(kind, name.slice(name.indexOf('-') + 1, -6));
            repaired += 1;
        }
        if (repaired) { this.repaired += repaired; this.dirtyState = true; }
        return repaired;
    }

    // -------------------------------------------------------------- commit --
    commit(tokens, quotas)
    {
        const tokenLines = new Map();
        const tokenIds = new Map();

        // Group by dedupe shard before touching disk. A migration batch spans
        // most of the 256 shards, and checking them in arrival order evicts and
        // reloads the same shard files repeatedly.
        const byShard = new Map();
        for (const event of tokens)
        {
            const key = tokenKeyOf(event);
            const prefix = key.slice(0, 2);
            (byShard.get(prefix) || byShard.set(prefix, []).get(prefix)).push({ event, key });
        }
        for (const [prefix, items] of [...byShard.entries()].sort())
        {
            const set = this.shardSet(prefix);
            const file = this.tokenShard(prefix);
            for (const { event, key } of items)
            {
                if (set.has(key)) continue;
                set.add(key);
                const day = dayOf(event.observedAt);
                (tokenLines.get(day) || tokenLines.set(day, []).get(day)).push(JSON.stringify(event));
                (tokenIds.get(file) || tokenIds.set(file, []).get(file)).push(key);
                this.applyToken(event, day);
            }
        }

        const quotaLines = new Map();
        const quotaIds = new Map();
        const latest = this.loadQuotaLatest();
        for (const event of quotas)
        {
            const key = quotaKeyOf(event);
            const day = dayOf(event.observedAt);
            const set = this.quotaIdSet(day);
            if (set.has(key)) continue;

            // Providers without a native observation timestamp are stamped on
            // read, so two overlapping generations produce distinct keys for
            // one unchanged value. Collapse those to a five-minute heartbeat.
            const previous = latest[event.key];
            if (previous
                && previous.usedPercent === event.usedPercent
                && (previous.resetAt || null) === (event.resetAt || null)
                && Date.parse(event.observedAt) - Date.parse(previous.observedAt) < QUOTA_HEARTBEAT_MS
                && Date.parse(event.observedAt) >= Date.parse(previous.observedAt)) continue;

            set.add(key);
            (quotaLines.get(day) || quotaLines.set(day, []).get(day)).push(JSON.stringify(event));
            (quotaIds.get(day) || quotaIds.set(day, []).get(day)).push(key);
            if (!previous || Date.parse(event.observedAt) >= Date.parse(previous.observedAt))
            {
                latest[event.key] = {
                    usedPercent: event.usedPercent,
                    remainingFraction: event.remainingFraction,
                    resetAt: event.resetAt,
                    observedAt: event.observedAt,
                };
                this.quotaLatestDirty = true;
            }
            this.applyQuota(event, day);
        }

        for (const [day, lines] of tokenLines) { this.appendLines(this.tokenSegment(day), lines, true); this.breakSeal('tokens', day); }
        for (const [file, ids] of tokenIds) this.appendLines(file, ids, false);
        for (const [day, lines] of quotaLines) { this.appendLines(this.quotaSegment(day), lines, true); this.breakSeal('quotas', day); }
        for (const [day, ids] of quotaIds) this.appendLines(this.quotaIdFile(day), ids, false);
        if (tokenLines.size || quotaLines.size) this.dirtyState = true;
        return { tokens: [...tokenLines.values()].reduce((n, l) => n + l.length, 0),
            quotas: [...quotaLines.values()].reduce((n, l) => n + l.length, 0) };
    }

    // A late migrated record can legitimately land in a day that was already
    // sealed. Retiring the stale manifest keeps `verify` meaningful instead of
    // reporting a tamper that never happened.
    breakSeal(kind, day)
    {
        const file = this.sealFile(kind, day);
        if (!fs.existsSync(file)) return;
        try { fs.renameSync(file, `${file}.superseded.${this.now()}`); }
        catch (_) { try { fs.unlinkSync(file); } catch (_) {} }
    }

    applyToken(event, day)
    {
        const year = yearOf(day);
        const bucket = this.tokenYear(year)[day] ||= { totals: emptyTotals(), byProvider: {}, byModel: {}, first: null, last: null };
        const modelId = `${event.provider}:${event.servedModel}`;
        addTotals(bucket.totals, event);
        addTotals(bucket.byProvider[event.provider] ||= emptyTotals(), event);
        addTotals(bucket.byModel[modelId] ||= { provider: event.provider, model: event.servedModel, ...emptyTotals() }, event);
        if (!bucket.first || event.observedAt < bucket.first) bucket.first = event.observedAt;
        if (!bucket.last || event.observedAt > bucket.last) bucket.last = event.observedAt;
        this.dirtyTokenYears.add(year);
    }

    foldQuota(bucket, event)
    {
        const row = bucket[event.key] ||= {
            provider: event.provider, accountId: event.accountId, accountName: event.accountName,
            quotaId: event.quotaId, model: event.model, aggregate: event.aggregate,
            firstObservedAt: event.observedAt, lastObservedAt: event.observedAt,
            firstPercent: event.usedPercent, lastPercent: event.usedPercent,
            minPercent: event.usedPercent, maxPercent: event.usedPercent,
            samples: 0, resets: 0, resetAt: event.resetAt,
        };
        if (event.observedAt < row.firstObservedAt) { row.firstObservedAt = event.observedAt; row.firstPercent = event.usedPercent; }
        if (event.observedAt >= row.lastObservedAt)
        {
            if (event.resetAt !== row.resetAt || event.usedPercent + 0.5 < row.lastPercent) row.resets += 1;
            row.lastObservedAt = event.observedAt;
            row.lastPercent = event.usedPercent;
            row.resetAt = event.resetAt;
            row.accountName = event.accountName ?? row.accountName;
        }
        row.minPercent = Math.min(row.minPercent, event.usedPercent);
        row.maxPercent = Math.max(row.maxPercent, event.usedPercent);
        row.samples += 1;
        return row;
    }

    applyQuota(event, day)
    {
        const year = yearOf(day);
        this.foldQuota(this.quotaYear(year)[day] ||= {}, event);
        this.dirtyQuotaYears.add(year);
    }

    // -------------------------------------------------------------- spool --
    spool(events)
    {
        this.ensure();
        for (const event of events)
        {
            const line = JSON.stringify(event);
            const name = `${this.now()}-${process.pid}-${nonce()}-${digest(line).slice(0, 8)}.jsonl`;
            const file = path.join(this.spoolDir, name);
            let fd;
            try { fd = fs.openSync(file, 'wx'); }
            catch (_) { continue; }
            try { fs.writeFileSync(fd, line + '\n'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            this.spooled += 1;
        }
    }

    drainSpool()
    {
        let names = [];
        try { names = fs.readdirSync(this.spoolDir); }
        catch (_) { return { tokens: [], quotas: [], claimed: [] }; }

        // A merge that died mid-flight left its claim behind. Reclaiming those
        // is the only way the records inside them are ever committed.
        const stale = names.filter(name => name.includes('.merging.')).filter(name => {
            try { return this.now() - fs.statSync(path.join(this.spoolDir, name)).mtimeMs > STALE_MERGE_MS; }
            catch (_) { return false; }
        });

        const tokens = [];
        const quotas = [];
        const claimed = [];
        for (const name of [...names.filter(item => item.endsWith('.jsonl')), ...stale].sort())
        {
            const from = path.join(this.spoolDir, name);
            const to = name.includes('.merging.') ? from : `${from}.merging.${process.pid}.${nonce()}`;
            if (to !== from)
            {
                try { fs.renameSync(from, to); }
                catch (_) { continue; }
            }
            claimed.push(to);
            let raw = '';
            try { raw = fs.readFileSync(to, 'utf8'); } catch (_) { continue; }
            for (const line of raw.split('\n'))
            {
                if (!line.trim()) continue;
                let event;
                try { event = JSON.parse(line); } catch (_) { continue; }
                if (event?.type === 'token') tokens.push(event);
                else if (event?.type === 'quota') quotas.push(event);
            }
        }
        return { tokens, quotas, claimed };
    }

    // ---------------------------------------------------------- migration --
    legacySlot(name, file)
    {
        const slot = this.state.legacy[name] ||= { path: file, offset: 0, size: 0, mtimeMs: 0, partial: '' };
        if (slot.path !== file) { slot.path = file; slot.offset = 0; slot.partial = ''; }
        return slot;
    }

    // Legacy JSONL files are append-only, so a byte offset is a valid cursor.
    // It has to be a cursor rather than a one-shot marker: a pre-v2 worker that
    // is still draining, or one restored by a rollback, keeps appending after
    // the first import.
    readLegacyTail(name, file, budget)
    {
        const slot = this.legacySlot(name, file);
        let stat;
        try { stat = fs.statSync(file); }
        catch (_) { return { lines: [], done: true }; }
        if (stat.size < slot.offset) { slot.offset = 0; slot.partial = ''; }
        if (stat.size === slot.offset)
        {
            slot.size = stat.size;
            slot.mtimeMs = stat.mtimeMs;

            // A file with no terminating newline leaves its last record here.
            // Emitting it only once it parses means a line still being written
            // is never truncated into the store.
            if (slot.partial.trim())
            {
                try { JSON.parse(slot.partial); }
                catch (_) { return { lines: [], done: true }; }
                const line = slot.partial;
                slot.partial = '';
                this.dirtyState = true;
                return { lines: [line], done: true };
            }
            return { lines: [], done: true };
        }

        const length = Math.min(budget, stat.size - slot.offset);
        const buffer = Buffer.allocUnsafe(length);
        const fd = fs.openSync(file, 'r');
        let read = 0;
        try { read = fs.readSync(fd, buffer, 0, length, slot.offset); }
        finally { fs.closeSync(fd); }

        const chunk = slot.partial + buffer.subarray(0, read).toString('utf8');
        const parts = chunk.split('\n');
        slot.partial = parts.pop();
        slot.offset += read;
        slot.size = stat.size;
        slot.mtimeMs = stat.mtimeMs;
        this.dirtyState = true;
        return { lines: parts.filter(line => line.trim()), done: slot.offset >= stat.size };
    }

    migrateBatch()
    {
        const tokens = [];
        const quotas = [];
        let done = true;

        if (this.legacyTokenFile)
        {
            const tail = this.readLegacyTail('tokens', this.legacyTokenFile, LEGACY_CHUNK);
            done = done && tail.done;
            for (const line of tail.lines)
            {
                let row;
                try { row = JSON.parse(line); } catch (_) { continue; }
                if (row?.version !== 1 || !row.tokens) continue;
                const event = tokenEvent({ ...row, tokens: row.tokens, rawUsage: row.rawUsage });
                if (event) tokens.push(event);
            }
        }

        if (this.legacyQuotaFile)
        {
            const tail = this.readLegacyTail('quotas', this.legacyQuotaFile, LEGACY_CHUNK);
            done = done && tail.done;
            for (const line of tail.lines)
            {
                let row;
                try { row = JSON.parse(line); } catch (_) { continue; }
                if (row?.version !== 1) continue;
                const provider = row.provider || String(row.key || '').split(':')[0];
                const event = quotaEvent({ ...row, provider, accountId: String(row.key || '').split(':')[1] || null });
                if (event) quotas.push(event);
            }
        }

        // plan-usage-history.json is a structured document Desktop rewrites
        // atomically and prunes, so a byte cursor is meaningless. Reparse it
        // whenever it changes and let exact dedupe absorb the overlap.
        if (this.planFile)
        {
            const slot = this.state.legacy.plan ||= { path: this.planFile, size: 0, mtimeMs: 0 };
            let stat = null;
            try { stat = fs.statSync(this.planFile); } catch (_) {}
            if (stat && (stat.size !== slot.size || stat.mtimeMs !== slot.mtimeMs))
            {
                let doc = null;
                try { doc = JSON.parse(fs.readFileSync(this.planFile, 'utf8').replace(/^﻿/, '')); } catch (_) {}
                for (const sample of Array.isArray(doc?.samples) ? doc.samples : [])
                {
                    const at = isoOf(sample?.t);
                    if (!at || !sample?.u) continue;
                    for (const [bucket, value] of Object.entries(sample.u))
                    {
                        const event = quotaEvent({
                            key: `claude:${sample.org || 'current'}:${bucket}`,
                            provider: 'claude',
                            accountId: sample.org || 'current',
                            accountName: 'Claude plan',
                            quotaId: CLAUDE_BUCKETS[bucket] || bucket,
                            model: CLAUDE_BUCKET_MODEL[bucket] || null,
                            usedPercent: value,
                            remainingFraction: clampPercent(value) === null ? null : 1 - clampPercent(value) / 100,
                            observedAt: at,
                            source: 'claude.plan-usage-history',
                            exact: true,
                            aggregate: true,
                        });
                        if (event) quotas.push(event);
                    }
                }
                slot.size = stat.size;
                slot.mtimeMs = stat.mtimeMs;
                this.dirtyState = true;
            }
        }

        return { tokens, quotas, done };
    }

    // ------------------------------------------------------------- public --

    // Returns 'stored', 'duplicate', 'spooled' or 'invalid'. Never throws and
    // never blocks: this runs inside terminal response handling.
    record(kind, value)
    {
        try
        {
            const event = kind === 'token' ? tokenEvent(value) : quotaEvent(value);
            if (!event) return 'invalid';
            const result = this.locked(() => {
                const merged = this.drainSpool();
                const counts = this.commit(
                    [...merged.tokens, ...(kind === 'token' ? [event] : [])],
                    [...merged.quotas, ...(kind === 'quota' ? [event] : [])]);
                for (const file of merged.claimed) { try { fs.unlinkSync(file); } catch (_) {} }
                return counts;
            });
            if (!result.held) { this.spool([event]); return 'spooled'; }
            return result.value.tokens + result.value.quotas > 0 ? 'stored' : 'duplicate';
        }
        catch (error) { this.lastError = String(error?.message || error); return 'invalid'; }
    }

    recordQuotas(rows)
    {
        const events = [];
        for (const row of rows || []) { const event = quotaEvent(row); if (event) events.push(event); }
        if (!events.length) return 0;
        try
        {
            const result = this.locked(() => {
                const merged = this.drainSpool();
                const counts = this.commit(merged.tokens, [...merged.quotas, ...events]);
                for (const file of merged.claimed) { try { fs.unlinkSync(file); } catch (_) {} }
                return counts;
            });
            if (!result.held) { this.spool(events); return 0; }
            return result.value.quotas;
        }
        catch (error) { this.lastError = String(error?.message || error); return 0; }
    }

    // Advances migration and merges spools. Called from accepted public
    // request paths only, in bounded batches.
    sync(rounds = 1)
    {
        try
        {
            const result = this.locked(() => {
                let complete = true;
                for (let i = 0; i < rounds; i += 1)
                {
                    const merged = this.drainSpool();
                    const batch = this.migrateBatch();
                    complete = batch.done;
                    this.commit([...merged.tokens, ...batch.tokens], [...merged.quotas, ...batch.quotas]);
                    for (const file of merged.claimed) { try { fs.unlinkSync(file); } catch (_) {} }
                    if (batch.done && !merged.tokens.length && !merged.quotas.length) break;
                }
                if (complete !== this.state.migrationComplete)
                {
                    this.state.migrationComplete = complete;
                    this.dirtyState = true;
                }
                return complete;
            });
            return result.held ? result.value : false;
        }
        catch (error) { this.lastError = String(error?.message || error); return false; }
    }

    // --------------------------------------------------------------- read --
    rangeWindow(key, tzOffsetMinutes = 0)
    {
        const end = this.now();
        const offset = Math.max(-840, Math.min(840, finite(tzOffsetMinutes) ?? 0));
        const shifted = end - offset * 60000;
        const localMidnight = Math.floor(shifted / 86400000) * 86400000 + offset * 60000;
        const days = { today: 0, '7d': 6, '30d': 29, '90d': 89 };
        if (key === 'all')
        {
            // Anchored to the start of the first recorded UTC day so the whole
            // window is answerable from rollups with no segment scan at all.
            const first = this.allTime().firstRecordedAt;
            const start = first ? Date.parse(first.slice(0, 10) + 'T00:00:00.000Z') : end;
            return { key, start: Math.min(start, end), end };
        }
        return { key, start: localMidnight - days[key] * 86400000, end };
    }

    scanTokenDay(day, startMs, endMs)
    {
        const totals = emptyTotals();
        const byProvider = {};
        const byModel = {};
        for (const event of this.readSegment('tokens', day))
        {
            const at = Date.parse(event.observedAt);
            if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
            const modelId = `${event.provider}:${event.servedModel}`;
            addTotals(totals, event);
            addTotals(byProvider[event.provider] ||= emptyTotals(), event);
            addTotals(byModel[modelId] ||= { provider: event.provider, model: event.servedModel, ...emptyTotals() }, event);
        }
        return { totals, byProvider, byModel };
    }

    // Every response ever recorded lives in the day segments; the in-memory
    // ledger holds a hundred rows. Anything that has to line responses up
    // against quota readings minutes or hours apart reads from here instead.
    tokenEventsSince(sinceMs, endMs = this.now())
    {
        if (!Number.isFinite(sinceMs) || !Number.isFinite(endMs) || endMs < sinceMs) return [];
        const rows = [];
        const endDay = dayOf(new Date(endMs).toISOString());
        for (let at = sinceMs; ; at += 86400000)
        {
            const day = dayOf(new Date(at).toISOString());
            for (const event of this.cachedTokenSegment(day))
            {
                const observed = Date.parse(event.observedAt);
                if (Number.isFinite(observed) && observed >= sinceMs && observed <= endMs) rows.push(event);
            }
            if (day >= endDay) break;
        }
        return rows.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    }

    // Keyed on segment size rather than mtime: segments are append-only, so a
    // byte count that has not moved is a file that has not changed, and a
    // polled dashboard does not reparse a whole day of responses every few
    // seconds.
    cachedTokenSegment(day)
    {
        let size = -1;
        try { size = fs.statSync(this.tokenSegment(day)).size; }
        catch (_) { return []; }
        const hit = this.eventCache.get(day);
        if (hit && hit.size === size) return hit.rows;
        const rows = this.readSegment('tokens', day);
        this.eventCache.set(day, { size, rows });
        if (this.eventCache.size > 4) this.eventCache.delete(this.eventCache.keys().next().value);
        return rows;
    }

    // A full UTC day inside the window comes from the daily rollup; only the
    // day a local window starts in is ever scanned, so an all-time query costs
    // the same as a seven-day one.
    query(key = 'all', tzOffsetMinutes = 0)
    {
        this.load();
        const range = this.rangeWindow(['all', 'today', '7d', '30d', '90d'].includes(key) ? key : 'all', tzOffsetMinutes);
        const startISO = new Date(range.start).toISOString();
        const endISO = new Date(range.end).toISOString();
        const startDay = startISO.slice(0, 10);
        const endDay = endISO.slice(0, 10);
        const partial = startISO.slice(11) !== '00:00:00.000Z';

        const totals = emptyTotals();
        const byProvider = {};
        const byModel = {};
        const timeline = [];
        // Cost is folded per (day, model) rather than over the whole window,
        // because a price change lands on a date: pricing an aggregate would
        // bill August's traffic at September's rate.
        const cost = emptyCost();
        const costByProvider = {};
        const costByModel = {};

        for (const year of this.availableYears('tokens'))
        {
            if (year < startDay.slice(0, 4) || year > endDay.slice(0, 4)) continue;
            const days = this.tokenYear(year);
            for (const day of Object.keys(days).sort())
            {
                if (day < startDay || day > endDay) continue;
                const bucket = day === startDay && partial ? this.scanTokenDay(day, range.start, range.end) : days[day];
                mergeTotals(totals, bucket.totals);
                for (const [provider, value] of Object.entries(bucket.byProvider || {})) mergeTotals(byProvider[provider] ||= emptyTotals(), value);
                const dayCost = emptyCost();
                for (const [id, value] of Object.entries(bucket.byModel || {}))
                {
                    mergeTotals(byModel[id] ||= { provider: value.provider, model: value.model, ...emptyTotals() }, value);
                    foldCost(costByModel[id] ||= emptyCost(), value.provider, value.model, value, day);
                    foldCost(costByProvider[value.provider] ||= emptyCost(), value.provider, value.model, value, day);
                    foldCost(dayCost, value.provider, value.model, value, day);
                    foldCost(cost, value.provider, value.model, value, day);
                }
                if (bucket.totals.responses) timeline.push({ date: day, ...bucket.totals, cost: dayCost });
            }
        }

        return {
            key: range.key,
            start: startISO,
            end: endISO,
            totals,
            cost,
            pricing: { fingerprint: PRICING_FINGERPRINT, models: pricedModels(),
                // The full rate table: the dashboard renders the card the
                // fingerprint only names. Rates are public published numbers
                // and add no credential surface.
                rates: RATES },
            providers: Object.fromEntries(Object.entries(byProvider)
                .map(([provider, value]) => [provider, { ...value, cost: costByProvider[provider] || emptyCost() }])),
            models: Object.entries(byModel)
                .map(([id, value]) => ({ ...value, cost: costByModel[id] || emptyCost() }))
                .sort((a, b) =>
                    (b.contextInputTokens + b.outputTokens) - (a.contextInputTokens + a.outputTokens)),
            dailyTimeline: timeline,
        };
    }

    // Daily quota aggregates for the selected window, downsampled to the bound
    // the live sparkline already uses.
    quotaHistory(keys, range, limit = HISTORY_LIMIT)
    {
        this.load();
        const wanted = new Set(keys);
        const startDay = String(range.start).slice(0, 10);
        const endDay = String(range.end).slice(0, 10);
        const out = new Map();
        for (const year of this.availableYears('quotas'))
        {
            if (year < startDay.slice(0, 4) || year > endDay.slice(0, 4)) continue;
            const days = this.quotaYear(year);
            for (const day of Object.keys(days).sort())
            {
                if (day < startDay || day > endDay) continue;
                for (const [key, row] of Object.entries(days[day]))
                {
                    if (!wanted.has(key)) continue;
                    if (!out.has(key)) out.set(key, []);
                    out.get(key).push({ observedAt: row.lastObservedAt, usedPercent: row.lastPercent,
                        minPercent: row.minPercent, maxPercent: row.maxPercent, samples: row.samples, resets: row.resets });
                }
            }
        }
        for (const [key, rows] of out)
        {
            if (rows.length <= limit) continue;
            const step = rows.length / limit;
            out.set(key, Array.from({ length: limit }, (_, index) => rows[Math.min(rows.length - 1, Math.floor(index * step))]));
        }
        return Object.fromEntries(out);
    }

    status()
    {
        this.load();
        const all = this.allTime();
        let sameVolume = true;
        try { sameVolume = fs.statSync(this.root).dev === fs.statSync(path.dirname(this.backupRoot)).dev; }
        catch (_) {}
        return {
            root: this.root,
            migrationComplete: this.state.migrationComplete === true,
            firstRecordedAt: all.firstRecordedAt,
            lastRecordedAt: all.lastRecordedAt,
            totalResponses: all.totals.responses,
            backup: { root: this.backupRoot, sameVolume, external: !sameVolume },
            spooled: this.spooled,
            repaired: this.repaired,
            error: this.lastError,
        };
    }
}

export { SCHEMA, emptyTotals, mergeTotals, addTotals, digest, TOTAL_KEYS, CLAUDE_BUCKETS };
