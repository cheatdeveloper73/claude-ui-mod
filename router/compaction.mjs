import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const RETAINED_TOKENS = 64000;
const ID_RE = /^[A-Za-z0-9_-]{24}$/;
const MARKER_RE = /^\[\[cuimod:codex-compact:v1:([A-Za-z0-9_-]{24})\]\]$/m;
const COMPACTION_PROMPTS = [
    'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.',
    'Your task is to create a detailed summary of the RECENT portion of the conversation',
];

const textOfContent = content => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(part => part?.type === 'text' || part?.type === 'input_text')
        .map(part => part.text || '').join('\n');
};

const responseItemText = item => item?.type === 'message'
    ? textOfContent(item.content)
    : '';

export function compactionPromptKind(text)
{
    const value = String(text || '').trimStart();
    const at = COMPACTION_PROMPTS.findIndex(prompt => value.startsWith(prompt));
    return at === 0 ? 'full' : at === 1 ? 'recent' : null;
}

export function isClaudeCompactionRequest(body)
{
    if (!body || !Array.isArray(body.messages) || !body.messages.length) return null;
    const last = body.messages.at(-1);
    if (last?.role !== 'user') return null;
    const kind = compactionPromptKind(textOfContent(last.content));
    return kind ? { kind, messageIndex: body.messages.length - 1 } : null;
}

export function removeCompactionPrompt(input)
{
    const out = Array.isArray(input) ? input.slice() : [];
    for (let index = out.length - 1; index >= 0; index--)
    {
        if (out[index]?.type !== 'message' || out[index]?.role !== 'user') continue;
        const text = responseItemText(out[index]);
        if (!COMPACTION_PROMPTS.some(prompt => text.includes(prompt))) continue;
        out.splice(index, 1);
        return out;
    }
    throw new Error('translated compaction prompt was not found');
}

export function buildRemoteCompactionPayload(payload)
{
    return {
        ...payload,
        input: removeCompactionPrompt(payload.input).concat([{ type: 'compaction_trigger' }]),
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
    };
}

export function collectRemoteCompaction(events)
{
    const items = (events || [])
        .filter(event => event?.type === 'response.output_item.done' && event.item?.type === 'compaction')
        .map(event => event.item);
    const terminal = (events || []).findLast(event => event?.type === 'response.completed');
    const failed = (events || []).findLast(event => event?.type === 'response.failed' || event?.type === 'error');
    if (failed) throw new Error(failed.response?.error?.message || failed.message || failed.error?.message || 'remote compaction failed');
    if (!terminal) throw new Error('remote compaction stream ended before response.completed');
    if (items.length !== 1 || typeof items[0].encrypted_content !== 'string' || !items[0].encrypted_content)
        throw new Error(`remote compaction expected one encrypted item, got ${items.length}`);
    return { item: items[0], response: terminal.response || {} };
}

export function collectResponseText(events)
{
    const failed = (events || []).findLast(event => event?.type === 'response.failed' || event?.type === 'error');
    if (failed) throw new Error(failed.response?.error?.message || failed.message || failed.error?.message || 'fallback summary failed');
    const terminal = (events || []).findLast(event => event?.type === 'response.completed');
    if (!terminal) throw new Error('fallback stream ended before response.completed');
    const text = (events || []).filter(event => event?.type === 'response.output_text.delta')
        .map(event => event.delta || '').join('').trim();
    if (!text) throw new Error('fallback summary returned no text');
    return { text, response: terminal.response || {} };
}

export function buildFallbackPayload(model, compactionItem, key)
{
    return {
        model,
        instructions: 'Render a portable context handoff from the supplied compacted state. Return only the summary. Preserve every explicit user request, decision, constraint, completed action, current state, exact identifier and path, failure, unresolved question, and concrete next step needed to continue without the opaque checkpoint. Do not omit information to meet an arbitrary length target; use as much space as the handoff requires.',
        input: [
            compactionItem,
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write the portable handoff summary now.' }] },
        ],
        tool_choice: 'none',
        parallel_tool_calls: false,
        reasoning: { effort: 'low', summary: 'auto' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: key,
    };
}

async function itemTokens(item, model, estimate)
{
    return estimate({ model, instructions: '', input: [item] });
}

function truncateMessage(item, ratio)
{
    const content = (item.content || []).map(part => {
        if (!['input_text', 'output_text'].includes(part?.type) || typeof part.text !== 'string') return part;
        const keep = Math.max(32, Math.floor(part.text.length * ratio));
        if (keep >= part.text.length) return part;
        const head = Math.floor(keep * 0.55);
        const tail = keep - head;
        return { ...part, text: part.text.slice(0, head) + `\n…${part.text.length - keep} characters compacted…\n` + part.text.slice(-tail) };
    });
    return { ...item, content };
}

async function fitMessage(item, budget, model, estimate)
{
    const full = await itemTokens(item, model, estimate);
    if (full <= budget) return { item, tokens: full };
    let low = 0;
    let high = 1;
    let best = null;
    for (let attempt = 0; attempt < 10; attempt++)
    {
        const ratio = (low + high) / 2;
        const candidate = truncateMessage(item, ratio);
        const tokens = await itemTokens(candidate, model, estimate);
        if (tokens <= budget) { best = { item: candidate, tokens }; low = ratio; }
        else high = ratio;
    }
    return best;
}

export async function retainCompactionHistory(input, model, estimate, budget = RETAINED_TOKENS)
{
    const candidates = (input || []).filter(item => item?.type === 'message' && item.role === 'user'
        && !compactionPromptKind(responseItemText(item)));
    let remaining = budget;
    const reversed = [];
    for (const item of candidates.slice().reverse())
    {
        if (remaining <= 0) break;
        const fitted = await fitMessage(item, remaining, model, estimate);
        if (!fitted) break;
        reversed.push(fitted.item);
        remaining -= fitted.tokens;
        if (fitted.item !== item) break;
    }
    return reversed.reverse();
}

export function checkpointMarker(id)
{
    if (!ID_RE.test(id)) throw new Error('invalid checkpoint id');
    return `[[cuimod:codex-compact:v1:${id}]]`;
}

export function summaryText(id, fallback)
{
    return `${checkpointMarker(id)}\n\n${String(fallback || '').trim()}`;
}

export function stripCheckpointMarker(text)
{
    return String(text || '').replace(MARKER_RE, '').replace(/^\s+/, '');
}

function stripMarkerContent(content)
{
    if (typeof content === 'string') {
        const next = stripCheckpointMarker(content);
        return next === content ? content : next;
    }
    if (!Array.isArray(content)) return content;
    let changed = false;
    const next = content.map(part => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part;
        const text = stripCheckpointMarker(part.text);
        if (text === part.text) return part;
        changed = true;
        return { ...part, text };
    });
    return changed ? next : content;
}

export function stripCheckpointMarkers(body)
{
    if (!body || !Array.isArray(body.messages)) return body;
    let changed = false;
    const messages = body.messages.map(message => {
        const content = stripMarkerContent(message?.content);
        if (content === message?.content) return message;
        changed = true;
        return { ...message, content };
    });
    return changed ? { ...body, messages } : body;
}

export class CompactionStore
{
    constructor(root)
    {
        this.root = path.join(root, 'compactions-v1');
    }

    file(id)
    {
        if (!ID_RE.test(id)) throw new Error('invalid checkpoint id');
        return path.join(this.root, id + '.json');
    }

    save(value)
    {
        if (!value || typeof value.sessionId !== 'string' || !value.sessionId) throw new Error('checkpoint session id required');
        if (!Array.isArray(value.history) || !value.history.some(item => item?.type === 'compaction'))
            throw new Error('checkpoint history has no compaction item');
        const id = crypto.randomBytes(18).toString('base64url');
        const record = { version: VERSION, id, createdAt: new Date().toISOString(), ...value };
        fs.mkdirSync(this.root, { recursive: true });
        const target = this.file(id);
        const temp = target + `.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
        fs.renameSync(temp, target);
        const item = record.history.find(entry => entry?.type === 'compaction');
        const metadata = {
            version: VERSION, id, sessionId: record.sessionId, createdAt: record.createdAt,
            sourceModel: record.sourceModel, retainedItems: record.history.length,
            encryptedBytes: Buffer.byteLength(item?.encrypted_content || ''),
            fallbackCharacters: String(record.fallback || '').length,
        };
        const metaTarget = path.join(this.root, id + '.meta.json');
        const metaTemp = metaTarget + `.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(metaTemp, JSON.stringify(metadata), { mode: 0o600 });
        fs.renameSync(metaTemp, metaTarget);
        return record;
    }

    load(id, sessionId)
    {
        try
        {
            const record = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
            if (record?.version !== VERSION || record.id !== id || record.sessionId !== sessionId) return null;
            if (!Array.isArray(record.history) || !record.history.some(item => item?.type === 'compaction')) return null;
            return record;
        }
        catch { return null; }
    }

    status(sessionId = null)
    {
        let names = [];
        try { names = fs.readdirSync(this.root).filter(name => /^[A-Za-z0-9_-]{24}\.meta\.json$/.test(name)); }
        catch (_) {}
        let latest = null;
        let count = 0;
        for (const name of names)
        {
            try
            {
                const value = JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'));
                if (value?.version !== VERSION || (sessionId && value.sessionId !== sessionId)) continue;
                count++;
                if (!latest || Date.parse(value.createdAt) > Date.parse(latest.createdAt)) latest = value;
            }
            catch (_) {}
        }
        return {
            count,
            latest: latest ? {
                id: latest.id,
                createdAt: latest.createdAt,
                sourceModel: latest.sourceModel,
                retainedItems: latest.retainedItems || 0,
                encryptedBytes: latest.encryptedBytes || 0,
                fallbackCharacters: latest.fallbackCharacters || 0,
            } : null,
        };
    }
}

export function restoreCheckpointInput(input, sessionId, store)
{
    let restored = 0;
    let degraded = 0;
    const output = [];
    for (const item of input || [])
    {
        const text = responseItemText(item);
        const match = MARKER_RE.exec(text);
        if (!match)
        {
            output.push(item);
            continue;
        }
        const record = typeof sessionId === 'string' ? store.load(match[1], sessionId) : null;
        if (record)
        {
            output.push(...record.history);
            restored++;
            continue;
        }
        const content = (item.content || []).map(part => {
            if (!['input_text', 'output_text'].includes(part?.type) || typeof part.text !== 'string') return part;
            return { ...part, text: stripCheckpointMarker(part.text) };
        });
        output.push({ ...item, content });
        degraded++;
    }
    return { input: output, restored, degraded };
}

export function anthropicSummaryResponse(model, text, usage, stream)
{
    const message = {
        id: 'msg_' + crypto.randomBytes(12).toString('hex'),
        type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: usage || { input_tokens: 0, output_tokens: 0 },
    };
    if (!stream) return JSON.stringify(message);
    const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
        + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        + event('content_block_stop', { type: 'content_block_stop', index: 0 })
        + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })
        + event('message_stop', { type: 'message_stop' });
}
