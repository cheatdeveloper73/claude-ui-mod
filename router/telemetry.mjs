// Exact provider usage ledger. One durable record per completed provider
// response; no prompts, content, credentials, or request bodies ever enter it.
import fs from 'node:fs';
import path from 'node:path';
import { replayJsonl } from './jsonl-archive.mjs';

const TOKEN_FIELDS = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'promptTokenCount',
    'cachedContentTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'totalTokenCount',
    'totalBillableCharacters',
];

const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;

function usageCopy(usage)
{
    const out = {};
    for (const key of TOKEN_FIELDS) if (typeof usage?.[key] === 'number') out[key] = nonnegative(usage[key]);

    const thinking = usage?.output_tokens_details?.thinking_tokens;
    const reasoning = usage?.output_tokens_details?.reasoning_tokens;
    if (typeof thinking === 'number' || typeof reasoning === 'number')
    {
        out.output_tokens_details = {};
        if (typeof thinking === 'number') out.output_tokens_details.thinking_tokens = nonnegative(thinking);
        if (typeof reasoning === 'number') out.output_tokens_details.reasoning_tokens = nonnegative(reasoning);
    }

    const cached = usage?.input_tokens_details?.cached_tokens;
    if (typeof cached === 'number') out.input_tokens_details = { cached_tokens: nonnegative(cached) };

    // Anthropic sells a cache write by the lifetime of the entry: 1.25x input
    // for the 5-minute TTL, 2x for the 1-hour one. Without this split the
    // cost of a cache write is a guess between two rates 1.6x apart.
    const ttl = usage?.cache_creation;
    const short = ttl?.ephemeral_5m_input_tokens;
    const long = ttl?.ephemeral_1h_input_tokens;
    if (typeof short === 'number' || typeof long === 'number')
    {
        out.cache_creation = {};
        if (typeof short === 'number') out.cache_creation.ephemeral_5m_input_tokens = nonnegative(short);
        if (typeof long === 'number') out.cache_creation.ephemeral_1h_input_tokens = nonnegative(long);
    }
    return out;
}

export function normalizeUsage(usage)
{
    const input = nonnegative(usage?.input_tokens);
    const output = nonnegative(usage?.output_tokens);
    const cacheRead = nonnegative(usage?.cache_read_input_tokens);
    const cacheWrite = nonnegative(usage?.cache_creation_input_tokens);
    const write5m = usage?.cache_creation?.ephemeral_5m_input_tokens;
    const write1h = usage?.cache_creation?.ephemeral_1h_input_tokens;
    const detail = usage?.output_tokens_details || {};
    const hasReasoning = typeof detail.thinking_tokens === 'number' || typeof detail.reasoning_tokens === 'number';
    const reasoning = nonnegative(detail.thinking_tokens ?? detail.reasoning_tokens);

    return {
        inputTokens: input,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        // The split is reported alongside the total rather than replacing it:
        // three records in the observed corpus disagree between the two, and
        // the total is the field the provider bills against.
        cacheCreation5mTokens: nonnegative(write5m),
        cacheCreation1hTokens: nonnegative(write1h),
        contextInputTokens: input + cacheRead + cacheWrite,
        outputTokens: output,
        reasoningOutputTokens: hasReasoning ? reasoning : null,
        visibleOutputTokens: hasReasoning ? Math.max(0, output - reasoning) : null,
    };
}

function aggregateTarget(target, entry)
{
    target.responses = (target.responses || 0) + 1;
    for (const key of [
        'inputTokens',
        'cacheReadInputTokens',
        'cacheCreationInputTokens',
        'cacheCreation5mTokens',
        'cacheCreation1hTokens',
        'contextInputTokens',
        'outputTokens',
    ]) target[key] = (target[key] || 0) + (entry.tokens[key] || 0);

    if (entry.tokens.reasoningOutputTokens !== null)
    {
        target.reasoningDetailedResponses = (target.reasoningDetailedResponses || 0) + 1;
        target.reasoningOutputTokens = (target.reasoningOutputTokens || 0) + entry.tokens.reasoningOutputTokens;
        target.visibleOutputTokens = (target.visibleOutputTokens || 0) + entry.tokens.visibleOutputTokens;
    }
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

export class UsageLedger
{
    constructor(file)
    {
        this.file = file;
        this.seen = new Set();
        this.models = new Map();
        this.sessionModels = new Map();
        this.latestBySession = new Map();
        this.recent = [];
        this.load();
    }

    load()
    {
        replayJsonl(this.file, entry => this.apply(entry));
    }

    apply(entry)
    {
        if (!entry || entry.version !== 1 || !entry.provider || !entry.responseId || !entry.tokens) return false;
        const responseKey = entry.provider + ':' + entry.responseId;
        if (this.seen.has(responseKey)) return false;
        this.seen.add(responseKey);

        const modelKey = entry.provider + ':' + entry.servedModel;
        if (!this.models.has(modelKey)) this.models.set(modelKey, { provider: entry.provider, model: entry.servedModel });
        aggregateTarget(this.models.get(modelKey), entry);

        if (entry.sessionId)
        {
            const sessionModelKey = entry.sessionId + ':' + modelKey;
            if (!this.sessionModels.has(sessionModelKey)) this.sessionModels.set(sessionModelKey, {
                sessionId: entry.sessionId,
                provider: entry.provider,
                model: entry.servedModel,
            });
            aggregateTarget(this.sessionModels.get(sessionModelKey), entry);
            this.latestBySession.set(entry.sessionId, entry);
        }

        this.recent.push(entry);
        if (this.recent.length > 100) this.recent.shift();
        return true;
    }

    record(value)
    {
        if (!value?.provider || !value?.responseId || !value?.servedModel || !value?.usage) return false;
        const entry = {
            version: 1,
            provider: value.provider,
            responseId: String(value.responseId),
            sessionId: value.sessionId ? String(value.sessionId) : null,
            requestedModel: value.requestedModel ? String(value.requestedModel) : null,
            servedModel: String(value.servedModel),
            effort: value.effort ? String(value.effort) : null,
            status: value.status || 'completed',
            source: String(value.source || 'unknown'),
            exact: value.exact === true,
            observedAt: value.observedAt || new Date().toISOString(),
            tokens: normalizeUsage(value.usage),
            rawUsage: usageCopy(value.rawUsage || value.usage),
        };

        const responseKey = entry.provider + ':' + entry.responseId;
        if (this.seen.has(responseKey)) return false;
        durableAppend(this.file, JSON.stringify(entry));
        return this.apply(entry);
    }

    snapshot(sessionId = null)
    {
        const sessions = [...this.latestBySession.entries()]
            .filter(([id]) => !sessionId || id === sessionId)
            .map(([id, latest]) => ({
                sessionId: id,
                latest,
                models: [...this.sessionModels.values()].filter(row => row.sessionId === id),
            }));
        return {
            version: 1,
            exactRecords: this.seen.size,
            models: [...this.models.values()],
            sessions,
            recent: this.recent.filter(entry => !sessionId || entry.sessionId === sessionId),
        };
    }
}
