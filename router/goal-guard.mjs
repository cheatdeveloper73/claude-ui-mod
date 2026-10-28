// Fail-closed guard for Claude Code's Stop-hook goal evaluator.
//
// /goal installs a prompt hook whose evaluator is an ordinary tool-less
// Messages request. The native client treats an API error, an unreadable
// reply and a schema mismatch as *nonblocking*: the hook is skipped and the
// session stops with the goal unverified. Only a well-formed {"ok":false}
// keeps the goal running. Whatever provider answered the evaluator, a bad
// reply therefore silently ends the goal.
//
// This module recognises exactly that request and holds the upstream reply
// until it is complete. A reply that is a valid verdict goes to the client
// byte for byte; anything else (HTTP error, truncation, malformed or
// non-text output, schema mismatch, or a deadline) is replaced by a valid
// {"ok":false} verdict that says the goal is unverified. It never fabricates
// success, never retries, never starts a second provider request and never
// invents usage. It knows no provider by name, so it sits in front of every
// arm, including adapters.

import crypto from 'node:crypto';

export const EVALUATOR_SYSTEM_PREFIX = 'You are evaluating a stop-condition hook in Claude Code. '
    + 'Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.';
export const EVALUATOR_USER_PREFIX = 'Based on the conversation transcript above, has the following stopping condition '
    + 'been satisfied? Answer based on transcript evidence only.\n\nCondition: ';

// The native hook gives up at 30 s and treats that as "cancelled, allow stop".
// Answering first keeps the failure on our side of that line.
export const DEFAULT_DEADLINE_MS = 20000;
const MAX_DEADLINE_MS = 25000;
// A verdict is a few hundred bytes. A reply this large is not one.
export const MAX_HELD_BYTES = 1024 * 1024;

const VERDICT_KEYS = new Set(['ok', 'reason', 'impossible']);
const overflowRetries = new Map();
const MAX_OVERFLOW_RETRIES = 256;

const REASON_TEXT = {
    'http-error': 'the evaluator request failed upstream',
    'upstream-error': 'the evaluator stream reported an error',
    'malformed': 'the evaluator returned an unreadable response',
    'non-text': 'the evaluator returned no text verdict',
    'truncated': 'the evaluator response was cut off',
    'invalid-verdict': 'the evaluator verdict did not match the required schema',
    'timeout': 'the evaluator timed out',
    'oversize': 'the evaluator response was too large',
    'interrupted': 'the evaluator response was interrupted',
};

// Context overflow is the one error the native client recovers from itself
// (it retries once with a halved transcript), so it must stay an error.
const PROMPT_TOO_LONG = /prompt is too long|input is too long|context[ _]length|maximum context|exceeds the context window|too many tokens/i;

const textOf = (content) => typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';

function systemText(body)
{
    return textOf(body.system);
}

export function isGoalEvaluatorRequest(body)
{
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.tools !== undefined && !(Array.isArray(body.tools) && body.tools.length === 0)) return false;

    const format = body.output_config?.format ?? body.output_format;
    const schema = format?.schema;
    if (format?.type !== 'json_schema' || schema?.type !== 'object') return false;
    const props = schema.properties;
    if (!props || typeof props !== 'object') return false;
    if (props.ok?.type !== 'boolean' || props.reason?.type !== 'string') return false;
    if (Object.keys(props).some(k => !VERDICT_KEYS.has(k))) return false;
    if (props.impossible !== undefined && props.impossible.type !== 'boolean') return false;
    if (!Array.isArray(schema.required) || !schema.required.includes('ok') || !schema.required.includes('reason')) return false;

    const system = systemText(body);
    const at = system.indexOf(EVALUATOR_SYSTEM_PREFIX);
    if (at !== 0 && !(at > 0 && system[at - 1] === '\n')) return false;

    const messages = body.messages;
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    if (last?.role !== 'user') return false;
    const blocks = typeof last.content === 'string' ? [last.content]
        : Array.isArray(last.content) ? last.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text) : [];
    return blocks.length > 0 && blocks[blocks.length - 1].startsWith(EVALUATOR_USER_PREFIX);
}

function parseVerdict(text)
{
    let value;
    try { value = JSON.parse(String(text).trim()); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).some(k => !VERDICT_KEYS.has(k))) return null;
    if (typeof value.ok !== 'boolean' || typeof value.reason !== 'string') return null;
    if ('impossible' in value && typeof value.impossible !== 'boolean') return null;
    return value;
}

class Unusable extends Error
{
    constructor(code) { super(code); this.code = code; }
}

function textFromMessage(message)
{
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) throw new Unusable('malformed');
    let text = '';
    for (const block of message.content)
    {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') continue;
        else throw new Unusable('non-text');
    }
    return text;
}

function textFromStream(raw)
{
    const frames = raw.split(/\r?\n\r?\n/);
    const kinds = new Map();
    const open = new Set();
    let text = '';
    let started = false;
    let stopped = false;
    let terminal = false;
    let unparsable = false;
    frames.forEach((frame) => {
        const data = [];
        for (const line of frame.split(/\r?\n/))
        {
            if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) return;
        const payload = data.join('\n');
        if (payload.trim() === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); }
        catch { unparsable = true; return; }
        if (event?.type === 'error') throw new Unusable('upstream-error');
        if (event?.type === 'ping') return;
        if (stopped) throw new Unusable('malformed');
        if (event?.type === 'message_start')
        {
            if (started) throw new Unusable('malformed');
            started = true;
            return;
        }
        if (!started) throw new Unusable('malformed');
        if (event?.type === 'message_stop')
        {
            if (open.size || !terminal) throw new Unusable('truncated');
            stopped = true;
        }
        else if (event?.type === 'content_block_start')
        {
            if (!Number.isInteger(event.index) || event.index < 0 || kinds.has(event.index)) throw new Unusable('malformed');
            const type = event.content_block?.type;
            if (type === 'text') { kinds.set(event.index, 'text'); text += typeof event.content_block.text === 'string' ? event.content_block.text : ''; }
            else if (type === 'thinking' || type === 'redacted_thinking') kinds.set(event.index, 'thinking');
            else throw new Unusable('non-text');
            open.add(event.index);
        }
        else if (event?.type === 'content_block_delta')
        {
            if (!open.has(event.index)) throw new Unusable('malformed');
            const kind = kinds.get(event.index);
            const delta = event.delta;
            if (delta?.type === 'text_delta' && kind === 'text' && typeof delta.text === 'string') text += delta.text;
            else if (kind === 'thinking' && ['thinking_delta', 'signature_delta'].includes(delta?.type)) return;
            else if (kind === 'text' && delta?.type === 'citations_delta') return;
            else throw new Unusable('malformed');
        }
        else if (event?.type === 'content_block_stop')
        {
            if (!open.delete(event.index)) throw new Unusable('malformed');
        }
        else if (event?.type === 'message_delta')
        {
            if (typeof event.delta?.stop_reason === 'string' && event.delta.stop_reason) terminal = true;
        }
        else throw new Unusable('malformed');
    });
    if (!started || !stopped) throw new Unusable('truncated');
    if (unparsable) throw new Unusable('malformed');
    return text;
}

// -> { pass: true } | { pass: true, error: true } | { pass: false, code }
export function inspectEvaluatorResponse({ status, body, stream, allowOverflowRetry = true })
{
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    if (status !== 200)
    {
        if (allowOverflowRetry && (status === 400 || status === 413) && PROMPT_TOO_LONG.test(raw.slice(0, 4096)))
            return { pass: true, error: true };
        return { pass: false, code: 'http-error' };
    }
    try
    {
        let text;
        if (stream) text = textFromStream(raw);
        else
        {
            let message;
            try { message = JSON.parse(raw); } catch { throw new Unusable(raw.trim() ? 'malformed' : 'truncated'); }
            if (message?.type === 'error') throw new Unusable('http-error');
            text = textFromMessage(message);
        }
        if (!text.trim()) throw new Unusable('non-text');
        if (!parseVerdict(text)) throw new Unusable('invalid-verdict');
        return { pass: true };
    }
    catch (error)
    {
        if (error instanceof Unusable) return { pass: false, code: error.code };
        throw error;
    }
}

export function fallbackVerdictText(code)
{
    const what = REASON_TEXT[code] || REASON_TEXT.malformed;
    return JSON.stringify({
        ok: false,
        reason: `Goal evaluator unavailable (${what}); the stop condition could not be verified, so the goal remains unverified. `
            + 'Keep working toward the goal, then stop again so it is re-evaluated.',
    });
}

export function fallbackResponse({ code, stream, model })
{
    const text = fallbackVerdictText(code);
    const id = 'msg_goalguard_' + Math.random().toString(36).slice(2, 14);
    const message = { id, type: 'message', role: 'assistant', model: typeof model === 'string' ? model : 'goal-guard',
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 } };
    if (!stream) return { contentType: 'application/json', payload: JSON.stringify(message) };
    const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
        { type: 'message_stop' },
    ];
    return { contentType: 'text/event-stream', payload: events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') };
}

function deadlineMs(options)
{
    const raw = options.deadlineMs ?? Number(process.env.MODEL_ROUTER_GOAL_GUARD_DEADLINE_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_DEADLINE_MS) : DEFAULT_DEADLINE_MS;
}

const defaultTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

const safeLabel = (value) => String(value ?? '').replace(/[^\w.:\[\]\/-]/g, '?').slice(0, 80);

// Returns a stand-in for `real` when `body` is the goal evaluator, else null.
// The stand-in holds writeHead/setHeader/write/end/destroy; everything else
// (event registration, `once('close')`, `destroyed`) is the real response's,
// so a handler's own disconnect handling still cancels its upstream work when
// the real response ends.
export function guardGoalEvaluator(req, real, body, options = {})
{
    if (!isGoalEvaluatorRequest(body)) return null;

    const log = options.log || (() => {});
    const setTimer = options.setTimer || defaultTimer;
    const clearTimer = options.clearTimer || clearTimeout;
    const maxBytes = options.maxBytes ?? MAX_HELD_BYTES;
    const stream = body.stream === true;
    const model = body.model;
    const started = Date.now();
    const budget = deadlineMs(options);
    // Native retries context overflow once with half the transcript. Keep that
    // recovery, but its second failure must not escape as a skipped Stop hook.
    const retryKey = crypto.createHash('sha256').update(JSON.stringify([
        req.headers?.['x-claude-code-session-id'], req.headers?.['x-claude-code-agent-id'], model,
        textOf(body.messages.at(-1).content),
    ])).digest('hex');
    const previous = overflowRetries.get(retryKey);
    overflowRetries.delete(retryKey);
    const retry = previous && previous.expires > started ? previous : null;
    const remaining = retry ? Math.max(1, Math.min(budget, retry.deadline - started)) : budget;

    const held = { phase: 'holding', status: 200, headArgs: null, headers: new Map(), chunks: [], bytes: 0,
        headersSent: false, ended: false, destroyed: false, timer: null };

    const settle = () => {
        if (held.timer !== null) { clearTimer(held.timer); held.timer = null; }
        held.chunks = [];
    };

    function fallback(code)
    {
        if (held.phase !== 'holding') return;
        const upstreamStatus = held.status;
        const heldBytes = held.bytes;
        // Still running when we answer for it (deadline, oversize, destroy)?
        const abandon = !held.ended;
        held.phase = 'committed';
        held.ended = true;
        settle();
        log(`goal-guard fallback code=${code} upstreamStatus=${upstreamStatus} stream=${stream} model=${safeLabel(model)} heldBytes=${heldBytes}`);
        if (real.destroyed || real.writableEnded) return;
        try
        {
            const { contentType, payload } = fallbackResponse({ code, stream, model });
            // Handlers cancel their upstream work on the response's 'close', and
            // downstreamGone() drops that listener on 'finish', which precedes the
            // real 'close'. Announce the departure first or a unary handler stays
            // parked on a hung upstream with nothing left to answer.
            if (abandon) real.emit('close');
            real.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Cuimod-Goal-Guard': code });
            real.end(payload);
        }
        catch { try { real.destroy(); } catch { /* socket already gone */ } }
    }

    function release()
    {
        held.phase = 'committed';
        const chunks = held.chunks;
        settle();
        if (real.destroyed || real.writableEnded) return;
        try
        {
            for (const [name, value] of held.headers) real.setHeader(name, value);
            if (held.headArgs) real.writeHead(...held.headArgs); else real.statusCode = held.status;
            for (const chunk of chunks) real.write(chunk);
            real.end();
        }
        catch { try { real.destroy(); } catch { /* socket already gone */ } }
    }

    function finish()
    {
        if (held.phase !== 'holding') return;
        let verdict;
        try { verdict = inspectEvaluatorResponse({ status: held.status, body: Buffer.concat(held.chunks), stream, allowOverflowRetry: !retry }); }
        catch { verdict = { pass: false, code: 'malformed' }; }
        if (verdict.error)
        {
            for (const [key, entry] of overflowRetries)
                if (entry.expires <= Date.now()) overflowRetries.delete(key);
            if (overflowRetries.size >= MAX_OVERFLOW_RETRIES) overflowRetries.delete(overflowRetries.keys().next().value);
            overflowRetries.set(retryKey, { expires: started + 30000, deadline: started + budget });
        }
        if (verdict.pass) release(); else fallback(verdict.code);
    }

    function hold(chunk, encoding)
    {
        if (chunk === undefined || chunk === null || held.phase !== 'holding') return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        held.bytes += buffer.length;
        if (held.bytes > maxBytes) { fallback('oversize'); return; }
        held.chunks.push(buffer);
    }

    held.timer = setTimer(() => { held.timer = null; fallback('timeout'); }, remaining);
    real.once('close', () => { if (held.phase === 'holding') held.phase = 'disposed'; settle(); });

    const callback = (cb) => { if (typeof cb === 'function') process.nextTick(cb); };
    const overrides = {
        writeHead(status, ...rest)
        {
            if (held.phase === 'holding') { held.status = status; held.headArgs = [status, ...rest]; held.headersSent = true; }
            return stand;
        },
        setHeader(name, value) { if (held.phase === 'holding') held.headers.set(name, value); return stand; },
        getHeader(name) { return held.phase === 'holding' ? held.headers.get(name) : real.getHeader(name); },
        hasHeader(name) { return held.phase === 'holding' ? held.headers.has(name) : real.hasHeader(name); },
        removeHeader(name) { if (held.phase === 'holding') held.headers.delete(name); },
        flushHeaders() { held.headersSent = true; },
        write(chunk, encoding, cb) { hold(chunk, encoding); callback(typeof encoding === 'function' ? encoding : cb); return true; },
        end(chunk, encoding, cb)
        {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (held.phase === 'holding')
            {
                hold(chunk, encoding);
                held.ended = true;
                finish();
            }
            callback(cb);
            return stand;
        },
        destroy()
        {
            if (held.phase === 'holding') { held.destroyed = true; fallback('interrupted'); }
            return stand;
        },
    };
    const bound = new Map();
    const stand = new Proxy(real, {
        get(target, prop)
        {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
            switch (prop)
            {
                case 'statusCode': return held.phase === 'holding' ? held.status : target.statusCode;
                case 'headersSent': return held.headersSent || target.headersSent;
                case 'writableEnded': case 'finished': return held.ended || target.writableEnded;
                case 'destroyed': return held.destroyed || target.destroyed;
                default: break;
            }
            const value = target[prop];
            if (typeof value !== 'function') return value;
            if (!bound.has(prop)) bound.set(prop, value.bind(target));
            return bound.get(prop);
        },
        set(target, prop, value)
        {
            if (prop === 'statusCode' && held.phase === 'holding') { held.status = value; return true; }
            target[prop] = value;
            return true;
        },
    });
    return stand;
}
