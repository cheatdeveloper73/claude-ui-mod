// Generation-rate ledger. One durable record per completed provider response,
// carrying clocks and token counts only -- no prompts, no response text, no
// credentials, no request bodies.
//
// Why a second file rather than more fields on provider-usage-v1.jsonl: that
// ledger is the input to permanent accounting, which carries its own schema
// evolution, and a rollback to a pre-throughput worker would keep writing usage
// records with no timing in them. Two append-only files joined on
// provider+responseId cannot disagree about a response either one of them saw,
// and that same key already joins a response to the CLI transcript line that
// names which agent produced it.
//
// What "exact" means here. Token counts come from the provider's own terminal
// usage, never from counting characters. The clocks are this process's, so they
// include the hop to the upstream and back but nothing of the client's own
// rendering. Three intervals are recorded separately because they answer
// different questions:
//
//   ttfb    dispatch -> upstream response headers      queueing and routing
//   ttft    dispatch -> first content delta            prefill
//   stream  first content delta -> terminal event      generation
//
// outputTps divides output tokens by the stream interval, so it is the rate the
// model actually generated at. endToEndTps divides by the whole request, so it
// is what the session felt. A non-streaming response has no first delta and
// therefore no honest generation rate: it reports endToEndTps only.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeUsage } from './telemetry.mjs';
import { replayJsonl } from './jsonl-archive.mjs';

// A cumulative-token observation series is what makes an intra-response rate
// curve possible at all. Providers that report usage once, at the end, produce
// one point; capping the array bounds the file for the ones that do not.
const SERIES_MAX = 64;
const RECENT_MAX = 200;

// A handler that throws between begin() and its finally would leave an entry in
// the live map forever. Nothing streams for a quarter of an hour, so anything
// older than that is a leak rather than a slow response.
const LIVE_STALE_MS = 15 * 60 * 1000;

const OPENAI_DELTA = new Set([
    'response.output_text.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_text.delta',
    'response.function_call_arguments.delta',
    'response.refusal.delta',
]);
const OPENAI_TERMINAL = new Set(['response.completed', 'response.incomplete']);

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value, places) => (finite(value) === null ? null : Number(value.toFixed(places)));

// Tokens per second, or null. A zero or negative interval is not a very fast
// response, it is a clock with nothing to say -- two events inside the same
// millisecond. Reporting Infinity there would poison every percentile
// downstream, so an unmeasurable rate stays unmeasured.
function rate(tokens, millis)
{
    if (finite(tokens) === null || finite(millis) === null) return null;
    if (millis <= 0 || tokens <= 0) return null;
    return Number(((tokens * 1000) / millis).toFixed(2));
}

function durableAppend(file, line)
{
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
        fs.writeSync(fd, prefix + line + '\n');
        fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
}

// Claude Code ships an x-anthropic-billing-header block as system[0] of every
// agent request, and `cc_is_subagent=true` appears in it only for subagent
// turns -- a main-session turn omits the key rather than setting it false. That
// is the only in-request signal separating the two lanes, and it is why this
// lives here: it exists to label a measurement, not to route anything.
//
// The body does not identify which subagent sent it. CLI 2.1.260 does provide
// that identity separately as x-claude-code-agent-id; provider adapters may use
// the header, while this body-only measurement helper still joins through the
// provider response id and CLI transcript.
//
// Read from the client body, before any provider preparation, because the
// some provider arms deliberately strip those blocks before they go upstream.
export function isSubagentRequest(body)
{
    const system = body?.system;
    const blocks = typeof system === 'string'
        ? [system]
        : Array.isArray(system)
            ? system.slice(0, 3).map(block => (typeof block === 'string' ? block : block?.text))
            : [];
    for (const text of blocks)
    {
        if (typeof text !== 'string' || !text.includes('x-anthropic-billing-header')) continue;
        return /cc_is_subagent=true/.test(text);
    }
    return null;
}

export function percentiles(values)
{
    const sorted = values.filter(value => finite(value) !== null).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1) + 0.5))];
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        samples: sorted.length,
        min: round(sorted[0], 2),
        p50: round(at(0.5), 2),
        p90: round(at(0.9), 2),
        max: round(sorted[sorted.length - 1], 2),
        mean: round(sum / sorted.length, 2),
    };
}

// A response is one sample of every statistic here, so grouping is a plain
// bucket-and-summarize. Percentiles rather than a mean alone: generation rate is
// skewed by prefill-bound short responses and by provider-side contention, and
// a mean hides both.
export function summarize(records, keyOf)
{
    const groups = new Map();
    for (const record of records)
    {
        const key = keyOf(record);
        if (key === null || key === undefined) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    const out = [];
    for (const [key, rows] of groups)
    {
        const tokens = rows.reduce((total, row) => total + (row.tokens?.outputTokens || 0), 0);
        const streamMs = rows.reduce((total, row) => total + (finite(row.streamMs) || 0), 0);
        out.push({
            key,
            responses: rows.length,
            outputTokens: tokens,
            contextInputTokens: rows.reduce((total, row) => total + (row.tokens?.contextInputTokens || 0), 0),
            reasoningOutputTokens: rows.reduce((total, row) => total + (row.tokens?.reasoningOutputTokens || 0), 0),
            // Total tokens over total generation time, which is the rate the
            // group sustained. Deliberately not the mean of the per-response
            // rates: that would weight a 12-token response the same as a
            // 4,000-token one.
            sustainedTps: rate(tokens, streamMs),
            outputTps: percentiles(rows.map(row => row.outputTps)),
            endToEndTps: percentiles(rows.map(row => row.endToEndTps)),
            ttftMs: percentiles(rows.map(row => row.ttftMs)),
            ttfbMs: percentiles(rows.map(row => row.ttfbMs)),
            firstAt: rows.reduce((min, row) => (min === null || row.completedAt < min ? row.completedAt : min), null),
            lastAt: rows.reduce((max, row) => (max === null || row.completedAt > max ? row.completedAt : max), null),
        });
    }
    return out.sort((a, b) => b.outputTokens - a.outputTokens);
}

class Sample
{
    constructor(ledger, meta)
    {
        this.ledger = ledger;
        this.id = ++ledger.counter;
        this.meta = meta;
        this.startedAt = ledger.now();
        this.startedIso = new Date(this.startedAt).toISOString();
        this.headersAt = null;
        this.firstDeltaAt = null;
        this.terminalAt = null;
        this.deltaEvents = 0;
        this.deltaChars = 0;
        this.series = [];          // [{ ms, tokens }], cumulative and exact
        this.seriesTruncated = false;
        this.responseId = null;
        this.servedModel = null;
        this.settled = false;
    }

    upstream()
    {
        if (this.headersAt === null) this.headersAt = this.ledger.now();
    }

    // Cumulative output tokens as the provider reports them mid-stream. Every
    // observation keeps its own clock, so a provider that reports more than once
    // yields a real curve and one that reports only at the end yields a single
    // interval, with no interpolation inventing the difference.
    observeTokens(tokens)
    {
        const value = finite(tokens);
        if (value === null || value <= 0) return;
        const last = this.series[this.series.length - 1];
        if (last && last.tokens >= value) return;
        if (this.series.length >= SERIES_MAX)
        {
            this.seriesTruncated = true;
            this.series.pop();
        }
        this.series.push({ ms: this.ledger.now() - this.startedAt, tokens: value });
    }

    delta(chars)
    {
        if (this.firstDeltaAt === null) this.firstDeltaAt = this.ledger.now();
        this.deltaEvents++;
        if (typeof chars === 'number' && chars > 0) this.deltaChars += chars;
    }

    anthropic(event)
    {
        const type = event && event.type;
        if (!type) return;
        if (type === 'message_start')
        {
            this.responseId = event.message?.id || this.responseId;
            this.servedModel = event.message?.model || this.servedModel;
            this.observeTokens(event.message?.usage?.output_tokens);
            return;
        }
        if (type === 'content_block_delta')
        {
            const d = event.delta || {};
            this.delta(String(d.text ?? d.thinking ?? d.partial_json ?? d.signature ?? '').length);
            return;
        }
        if (type === 'message_delta') { this.observeTokens(event.usage?.output_tokens); return; }
        if (type === 'message_stop' && this.terminalAt === null) this.terminalAt = this.ledger.now();
    }

    openai(event)
    {
        const type = event && event.type;
        if (!type) return;
        if (OPENAI_DELTA.has(type)) { this.delta(String(event.delta ?? '').length); return; }
        if (OPENAI_TERMINAL.has(type))
        {
            this.observeTokens(event.response?.usage?.output_tokens);
            // A single Anthropic turn may span hidden model-only Responses
            // rounds. complete() is deferred to the visible terminal, so its
            // clock must advance with that terminal instead of staying on round 1.
            this.terminalAt = this.ledger.now();
        }
    }

    nextOpenAIResponse()
    {
        // The durable record is keyed by the final response id. A hidden
        // model-only response has its own cumulative usage, so carrying that
        // point into the next response would create a false cross-response curve.
        this.series = [];
        this.seriesTruncated = false;
        this.terminalAt = null;
    }

    // Called from the same place the usage ledger is written, so the two files
    // record the same terminal usage object or neither of them does.
    complete(value)
    {
        if (this.settled) return false;
        const responseId = (value && value.responseId) || this.responseId;
        if (!responseId || !value || !value.usage) { this.end(); return false; }
        this.settled = true;
        this.ledger.live.delete(this.id);

        const end = this.terminalAt === null ? this.ledger.now() : this.terminalAt;
        const totalMs = end - this.startedAt;
        const streamMs = this.firstDeltaAt === null ? null : end - this.firstDeltaAt;
        const tokens = normalizeUsage(value.usage);

        return this.ledger.write({
            version: 1,
            provider: this.meta.provider,
            responseId: String(responseId),
            sessionId: this.meta.sessionId ? String(this.meta.sessionId) : null,
            requestedModel: this.meta.requestedModel ? String(this.meta.requestedModel) : null,
            servedModel: String(value.servedModel || this.servedModel || this.meta.requestedModel || 'unknown'),
            effort: this.meta.effort ? String(this.meta.effort) : null,
            subagent: typeof this.meta.subagent === 'boolean' ? this.meta.subagent : null,
            streaming: this.meta.streaming === true,
            status: value.status || 'completed',
            startedAt: this.startedIso,
            completedAt: new Date(end).toISOString(),
            ttfbMs: this.headersAt === null ? null : this.headersAt - this.startedAt,
            ttftMs: this.firstDeltaAt === null ? null : this.firstDeltaAt - this.startedAt,
            streamMs,
            totalMs,
            tokens,
            outputTps: rate(tokens.outputTokens, streamMs),
            endToEndTps: rate(tokens.outputTokens, totalMs),
            deltaEvents: this.deltaEvents,
            deltaChars: this.deltaChars,
            series: this.series.length > 1 ? this.series : null,
            seriesTruncated: this.seriesTruncated,
        });
    }

    // Idempotent, and safe to call from a finally. A response that never reached
    // a terminal usage object leaves no durable record, because a rate computed
    // from a truncated stream measures the disconnection rather than the model.
    end()
    {
        this.settled = true;
        this.ledger.live.delete(this.id);
    }

    snapshot(now)
    {
        const last = this.series[this.series.length - 1] || null;
        return {
            id: this.id,
            provider: this.meta.provider,
            sessionId: this.meta.sessionId || null,
            requestedModel: this.meta.requestedModel || null,
            servedModel: this.servedModel || this.meta.requestedModel || null,
            responseId: this.responseId,
            effort: this.meta.effort || null,
            subagent: typeof this.meta.subagent === 'boolean' ? this.meta.subagent : null,
            streaming: this.meta.streaming === true,
            startedAt: this.startedIso,
            elapsedMs: now - this.startedAt,
            ttfbMs: this.headersAt === null ? null : this.headersAt - this.startedAt,
            ttftMs: this.firstDeltaAt === null ? null : this.firstDeltaAt - this.startedAt,
            deltaEvents: this.deltaEvents,
            deltaChars: this.deltaChars,
            // Exact, because the provider said so. Null until it does.
            observedTokens: last ? last.tokens : null,
            observedTokensAtMs: last ? last.ms : null,
            observedTps: last && this.firstDeltaAt !== null
                ? rate(last.tokens, this.startedAt + last.ms - this.firstDeltaAt)
                : null,
            charsPerSecond: this.firstDeltaAt === null
                ? null : rate(this.deltaChars, now - this.firstDeltaAt),
        };
    }
}

export class ThroughputLedger
{
    constructor(file, options = {})
    {
        this.file = file;
        this.now = options.now || (() => Date.now());
        this.recentMax = options.recentMax || RECENT_MAX;
        this.counter = 0;
        this.live = new Map();
        this.recent = [];
        this.records = [];
        this.seen = new Set();
        this.summaryCache = null;
        this.load();
    }

    load()
    {
        replayJsonl(this.file, record => {
            if (record?.version !== 1 || !record.provider || !record.responseId) return;
            // The series is the one unbounded field. It stays on disk; holding
            // one per historical response is what would make this unbounded too.
            record.series = null;
            this.index(record);
        });
    }

    index(record)
    {
        const key = record.provider + ':' + record.responseId;
        if (this.seen.has(key)) return false;
        this.seen.add(key);
        this.records.push(record);
        this.recent.push(record);
        if (this.recent.length > this.recentMax) this.recent.shift();
        this.summaryCache = null;
        return true;
    }

    write(record)
    {
        const key = record.provider + ':' + record.responseId;
        if (this.seen.has(key)) return false;
        try { durableAppend(this.file, JSON.stringify(record)); }
        catch (_) { /* a full or locked disk must not break the response */ }
        return this.index(record);
    }

    // The response is the cleanup handle. A finally in the caller is skipped by
    // a fetch that throws before the try, and the live map would then show a
    // phantom in-flight stream until the stale sweep fifteen minutes later --
    // which is exactly the kind of thing that makes a live readout untrustworthy.
    // Node emits 'close' on every response, whether it finished or the socket
    // died, and complete() has already removed the sample by then, so end() is a
    // no-op on the normal path.
    begin(meta, res)
    {
        const sample = new Sample(this, meta || {});
        this.live.set(sample.id, sample);
        if (res && typeof res.once === 'function') res.once('close', () => sample.end());
        this.sweep();
        return sample;
    }

    sweep()
    {
        const now = this.now();
        for (const [id, sample] of this.live)
        {
            if (now - sample.startedAt > LIVE_STALE_MS) this.live.delete(id);
        }
    }

    // Chars per output token, measured on this ledger's own completed responses
    // for one model. It is the calibration an in-flight stream needs to show a
    // token rate before its provider has reported any tokens -- and the caller
    // is expected to label anything derived from it as estimated, because it is.
    calibration(model)
    {
        let chars = 0;
        let tokens = 0;
        let samples = 0;
        for (let i = this.records.length - 1; i >= 0 && samples < 40; i--)
        {
            const record = this.records[i];
            if (record.servedModel !== model || !record.deltaChars || !record.tokens?.outputTokens) continue;
            chars += record.deltaChars;
            tokens += record.tokens.outputTokens;
            samples++;
        }
        if (!samples || !tokens) return null;
        return { model, charsPerToken: round(chars / tokens, 3), samples };
    }

    snapshot()
    {
        const now = this.now();
        // Historical aggregates scan and percentile-sort the full ledger. The
        // UI polls this endpoint every second, while the ledger can contain
        // hundreds of thousands of responses. Recompute only when index() adds
        // a completed response; live samples and recent rows remain fresh on
        // every poll without pinning the inference worker's event loop.
        this.summaryCache ||= {
            providers: summarize(this.records, record => record.provider),
            models: summarize(this.records, record => record.provider + ':' + record.servedModel),
        };
        const live = [...this.live.values()].map(sample => sample.snapshot(now));
        for (const entry of live)
        {
            const calibration = entry.servedModel ? this.calibration(entry.servedModel) : null;
            entry.calibration = calibration;
            entry.estimatedTps = calibration && entry.charsPerSecond !== null
                ? round(entry.charsPerSecond / calibration.charsPerToken, 2)
                : null;
        }
        return {
            version: 1,
            observedAt: new Date(now).toISOString(),
            file: this.file,
            records: this.records.length,
            live,
            recent: this.recent.slice(-40).map(record => ({ ...record, series: undefined })),
            providers: this.summaryCache.providers,
            models: this.summaryCache.models,
        };
    }

    // History. Filtering runs over the in-memory index; the series, the only
    // field left behind on disk, is not reconstituted here.
    query(options = {})
    {
        const since = Date.parse(options.since || '');
        const until = Date.parse(options.until || '');
        const limit = Math.max(1, Math.min(5000, Number(options.limit) || 500));
        // The in-app chip asks for the last one (and the visible panel for the
        // last forty) for one session every second. Scanning and summarizing the
        // entire historical ledger before slicing those rows made a 186k-record
        // archive consume a full CPU core. With no analytical filters, walk the
        // append-only index backward and stop as soon as the requested tail is
        // complete. These callers consume records only, not global rollups.
        const tailOnly = !!options.session && limit <= 40
            && !options.provider && !options.model && typeof options.subagent !== 'boolean'
            && !Number.isFinite(since) && !Number.isFinite(until);
        if (tailOnly)
        {
            const records = [];
            for (let i = this.records.length - 1; i >= 0 && records.length < limit; i--)
            {
                const record = this.records[i];
                if (record.sessionId === options.session) records.push({ ...record, series: undefined });
            }
            records.reverse();
            return { version: 1, matched: records.length, returned: records.length, records,
                providers: [], models: [], sessions: [], lanes: [] };
        }
        const rows = this.records.filter(record => {
            if (options.session && record.sessionId !== options.session) return false;
            if (options.provider && record.provider !== options.provider) return false;
            if (options.model && record.servedModel !== options.model) return false;
            if (typeof options.subagent === 'boolean' && record.subagent !== options.subagent) return false;
            const at = Date.parse(record.completedAt);
            if (Number.isFinite(since) && !(at >= since)) return false;
            if (Number.isFinite(until) && !(at <= until)) return false;
            return true;
        });
        return {
            version: 1,
            matched: rows.length,
            returned: Math.min(rows.length, limit),
            records: rows.slice(-limit).map(record => ({ ...record, series: undefined })),
            providers: summarize(rows, record => record.provider),
            models: summarize(rows, record => record.provider + ':' + record.servedModel),
            sessions: summarize(rows, record => record.sessionId),
            lanes: summarize(rows, record => (record.subagent === null ? 'unknown' : record.subagent ? 'subagent' : 'main')),
        };
    }
}

export { SERIES_MAX, rate };
