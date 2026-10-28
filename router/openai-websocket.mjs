import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { connectWebSocket, MAX_WEBSOCKET_MESSAGE_BYTES } from './websocket.mjs';

const connections = new Set();
let opened = 0;
const sends = { warm: 0, cold: 0, chunked: 0, resent: 0 };
const IDLE_MS = 5 * 60 * 1000;
// Leave half the server's one-hour socket lifetime for a long reasoning turn.
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_CONNECTIONS = 64;
const MAX_ATTEMPTS = 3;
// Measured 2026-10-11: chatgpt.com codex/responses accepts a 16,777,216-byte
// response.create text message and closes on one byte more with 1009.
export const MAX_OPENAI_WEBSOCKET_REQUEST_BYTES = 16 * 1024 * 1024;
const CHUNK_MARGIN = 64 * 1024;
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
const PRELUDE = new Set(['response.created', 'response.in_progress', 'codex.response.metadata', 'codex.rate_limits', 'responsesapi.websocket_timing']);
const UPGRADE_ERRORS = new Set(['OPENAI_WS_UPGRADE_FAILED', 'OPENAI_WS_UPGRADE_INVALID', 'OPENAI_WS_UPGRADE_TIMEOUT']);
const encoder = new TextEncoder();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function remove(entry)
{
    connections.delete(entry);
    clearTimeout(entry.timer);
    entry.connection?.destroy();
}

function release(entry)
{
    if (!connections.has(entry)) return;
    entry.busy = false;
    entry.connection.onmessage = () => {};
    entry.connection.onerror = () => remove(entry);
    entry.connection.socket.unref();
    if (entry.connection.dead || performance.now() - entry.created >= MAX_AGE_MS) { remove(entry); return; }
    entry.timer = setTimeout(() => remove(entry), IDLE_MS);
    entry.timer.unref();
}

export function closeOpenAIWebSockets()
{
    for (const entry of connections) remove(entry);
}

export function openAIWebSocketState()
{
    return { protocol: 'websocket', opened, connections: connections.size, active: [...connections].filter(entry => entry.busy).length, sends: { ...sends } };
}

function canonical(value)
{
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

function argumentsPrint(text)
{
    try { return canonical(JSON.parse(text)); }
    catch (_) { return String(text); }
}

const isModelOutput = item => item?.type === 'reasoning' || item?.type === 'function_call'
    || (item?.type === 'message' && item.role === 'assistant');

// Model output as it comes back from Claude Code: reasoning returns as opaque
// state the server already holds, text is re-split around tool calls, and call
// arguments are re-serialized from parsed JSON. Compare what survives that trip.
function outputPrint(items)
{
    const print = [];
    for (const item of items)
    {
        if (item?.type === 'reasoning') continue;
        if (item?.type === 'message' && item.role === 'assistant')
        {
            const text = (Array.isArray(item.content) ? item.content : [])
                .filter(part => part?.type === 'output_text').map(part => part.text || '').join('');
            if (!text) continue;
            if (print.at(-1)?.startsWith('m:')) print[print.length - 1] += text;
            else print.push(`m:${text}`);
        }
        else if (item?.type === 'function_call') print.push(`f:${canonical([item.call_id, item.name, argumentsPrint(item.arguments)])}`);
        else print.push(`x:${canonical(item)}`);
    }
    return print;
}

// The server keeps the previous response only on this socket and only until an
// error. A later request may send just its new items when every other field is
// unchanged, its input starts with the previous input, and the items after that
// are the previous output as Claude Code replayed it (openai/codex
// core/src/client.rs get_incremental_items). Anything else is a full send.
function continuation(chain, props, inputJson, input)
{
    if (!chain || chain.props !== props || inputJson.length <= chain.inputJson.length) return null;
    for (let i = 0; i < chain.inputJson.length; i++) if (inputJson[i] !== chain.inputJson[i]) return null;
    let end = chain.inputJson.length;
    while (end < input.length && isModelOutput(input[end])) end++;
    if (end >= input.length) return null;
    const print = outputPrint(input.slice(chain.inputJson.length, end));
    if (print.length !== chain.print.length || print.some((value, i) => value !== chain.print[i])) return null;
    return { previous: chain.id, start: end };
}

// Every response.create must validate alone, so a chunk never separates a tool
// call from its output. All chunks but the last are generate:false uploads,
// the same request shape Codex uses for its prewarm.
function chunkPlan(rest, inputJson, start, previous)
{
    const envelope = Buffer.byteLength(JSON.stringify({ ...rest, input: [], type: 'response.create',
        previous_response_id: previous || `resp_${'0'.repeat(64)}`, generate: false }));
    const budget = MAX_OPENAI_WEBSOCKET_REQUEST_BYTES - envelope - CHUNK_MARGIN;
    const sizes = inputJson.slice(start).map(text => Buffer.byteLength(text) + 1);
    if (sizes.reduce((sum, size) => sum + size, 0) <= budget) return [[start, inputJson.length]];
    const groups = [];
    const open = new Set();
    let from = start;
    let bytes = 0;
    for (let i = start; i < inputJson.length; i++)
    {
        const item = JSON.parse(inputJson[i]);
        bytes += sizes[i - start];
        if (item?.type === 'function_call' || item?.type === 'custom_tool_call') open.add(item.call_id);
        if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') open.delete(item.call_id);
        if (!open.size || i === inputJson.length - 1) { groups.push([from, i + 1, bytes]); from = i + 1; bytes = 0; }
    }
    const chunks = [];
    for (const [a, b, size] of groups)
    {
        if (size > budget)
        {
            const error = new Error(`items ${a}-${b - 1} must travel in one WebSocket message but are ${(size / 1048576).toFixed(1)} MiB; the server limit is 16 MiB`);
            error.code = 'OPENAI_WS_REQUEST_TOO_LARGE';
            throw error;
        }
        const last = chunks.at(-1);
        if (last && last[2] + size <= budget) { last[1] = b; last[2] += size; }
        else chunks.push([a, b, size]);
    }
    return chunks.map(([a, b]) => [a, b]);
}

async function acquire(url, headers, signal, timeout, prefer)
{
    // Hash the complete upgrade identity. OAuth rotation and routing-header changes
    // must never reuse a socket authenticated or affined by the previous request.
    const identity = Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
        .sort(([a], [b]) => a.localeCompare(b));
    const key = crypto.createHash('sha256').update(JSON.stringify([url, identity])).digest('hex');
    let fallback = null;
    let chosen = null;
    for (const entry of connections)
    {
        if (!entry.busy && (entry.connection.dead || performance.now() - entry.created >= MAX_AGE_MS)) { remove(entry); continue; }
        if (entry.busy || entry.key !== key) continue;
        if (prefer?.(entry)) { chosen = entry; break; }
        // An idle socket without a chain costs no warm continuation to reuse.
        if (!fallback || (fallback.chain && !entry.chain)) fallback = entry;
    }
    chosen ||= fallback;
    if (chosen)
    {
        clearTimeout(chosen.timer);
        chosen.busy = true;
        chosen.connection.socket.ref();
        return chosen;
    }
    if (connections.size >= MAX_CONNECTIONS)
    {
        const idle = [...connections].find(entry => !entry.busy);
        if (idle) remove(idle);
        else
        {
            const error = new Error('OpenAI WebSocket pool is busy');
            error.code = 'OPENAI_WS_POOL_BUSY';
            throw error;
        }
    }
    const entry = { key, busy: true, created: performance.now(), turns: 0, chain: null, connection: null, timer: null };
    connections.add(entry);
    try
    {
        const connection = await connectWebSocket(url, headers, { signal, timeout });
        if (connection instanceof Response) { connections.delete(entry); return connection; }
        entry.connection = connection;
        opened++;
        return entry;
    }
    catch (error) { remove(entry); throw error; }
}

function errorResponse(event)
{
    const error = event.error || {};
    const code = String(error.code || error.type || '').toLowerCase();
    const supplied = Number(event.status || event.status_code);
    const status = Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied
        : ['rate_limit_exceeded', 'rate_limit_error'].includes(code) ? 429
        : ['invalid_prompt', 'invalid_request_error'].includes(code) ? 400 : 502;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const source of [event.headers, error.headers])
        for (const [name, value] of Object.entries(source || {}))
            if (['retry-after', 'retry-after-ms', 'x-request-id'].includes(name.toLowerCase())) headers.set(name, String(value));
    return new Response(JSON.stringify(event), { status, headers });
}

// Both refusals mean the request was never accepted, so a full send on a new
// socket is the exact retry: the server lost this socket's previous response,
// or retired the socket at its 60-minute limit.
function freshSocketRefusal(event)
{
    const error = event?.error || {};
    const code = String(error.code || '').toLowerCase();
    return code === 'previous_response_not_found' || code === 'websocket_connection_limit_reached'
        || /previous_response_id|previous response/i.test(String(error.message || ''));
}

function lossMessage(error, entry, forwarded)
{
    if (!/client disconnected|canceled/.test(error.message))
        error.message += ` (socket age ${Math.round((performance.now() - entry.created) / 1000)}s, turn ${entry.turns}, ${forwarded ? 'after' : 'before'} first event)`;
    return error;
}

// generate:false upload of one history chunk. Resolves the response id, or the
// error event when the server refused it.
function upload(entry, body, signal, timeout)
{
    const connection = entry.connection;
    return new Promise((resolve, reject) => {
        let done = false;
        let id = null;
        const finish = (value, error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            connection.onmessage = null;
            connection.onerror = null;
            if (error) { error.requestSent = true; remove(entry); reject(error); }
            else resolve(value);
        };
        const abort = () => finish(null, new Error('client disconnected'));
        let timer = setTimeout(() => finish(null, lossMessage(new Error('OpenAI WebSocket upload timed out'), entry, false)), timeout);
        connection.onerror = error => finish(null, lossMessage(error, entry, false));
        connection.onmessage = text => {
            let event;
            try { event = JSON.parse(text); }
            catch (_) { finish(null, new Error('invalid JSON in upstream OpenAI WebSocket message')); return; }
            clearTimeout(timer);
            timer = setTimeout(() => finish(null, lossMessage(new Error('OpenAI WebSocket upload timed out'), entry, false)), timeout);
            if (typeof event?.response?.id === 'string') id = event.response.id;
            if (event?.type === 'error' || event?.type === 'response.failed') { remove(entry); finish({ refused: event }); return; }
            if (event?.type === 'response.completed' && id) finish({ id });
            else if (event?.type === 'response.incomplete') { remove(entry); finish({ refused: event }); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try
        {
            connection.send(JSON.stringify(body));
            entry.turns++;
            connection.start();
        }
        catch (error) { finish(null, error); }
    });
}

function stream(entry, body, signal, clientGone, timeout, record)
{
    const connection = entry.connection;
    return new Promise((resolve, reject) => {
        let controller;
        let waiting = false;
        let resolved = false;
        let finished = false;
        let failed = false;
        let sent = false;
        let queuedBytes = 0;
        let responseId = null;
        const output = [];
        const queue = [];
        let timer;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const fail = error => {
            if (failed || finished) return;
            failed = true;
            error.requestSent = sent;
            // Nothing reached the consumer before the first non-prelude event, so
            // no tool call can have been acted on; the caller may resend once.
            error.forwarded = resolved;
            if (sent) lossMessage(error, entry, resolved);
            cleanup();
            connection.onmessage = null;
            connection.onerror = null;
            remove(entry);
            queue.length = 0;
            if (!resolved) reject(error);
            else controller.error(error);
        };
        const abort = () => fail(new Error('client disconnected'));
        const pump = () => {
            if (!waiting || failed) return;
            if (queue.length)
            {
                const chunk = queue.shift();
                queuedBytes -= chunk.byteLength;
                waiting = false;
                controller.enqueue(chunk);
            }
            else if (finished) { waiting = false; controller.close(); }
        };
        const body$ = new ReadableStream({
            start(value) { controller = value; },
            pull() { waiting = true; pump(); },
            cancel() {
                if (!finished && !failed) fail(new Error('OpenAI WebSocket response canceled'));
                queue.length = 0;
                queuedBytes = 0;
            },
        }, { highWaterMark: 0 });
        const respond = () => {
            if (resolved) return;
            resolved = true;
            resolve({ response: new Response(body$, { status: 200, headers: { 'Content-Type': 'text/event-stream',
                ...(connection.headers.get('x-request-id') ? { 'X-Request-Id': connection.headers.get('x-request-id') } : {}) } }) });
        };
        connection.onerror = fail;
        connection.onmessage = text => {
            if (failed || finished) return;
            let event;
            try { event = JSON.parse(text); }
            catch (_) { fail(new Error('invalid JSON in upstream OpenAI WebSocket message')); return; }
            if (!event || typeof event.type !== 'string') { fail(new Error('invalid upstream OpenAI WebSocket event')); return; }
            clearTimeout(timer);
            // A live prelude is activity, even before the first output item. Keep
            // waiting so a handshake-level rate limit retains its HTTP status.
            if (!resolved && PRELUDE.has(event.type)) timer = setTimeout(() => fail(new Error('OpenAI WebSocket response timed out')), timeout);
            if (!resolved && event.type === 'error')
            {
                finished = true;
                cleanup();
                queue.length = 0;
                remove(entry);
                resolve(freshSocketRefusal(event) ? { retry: event } : { response: errorResponse(event) });
                return;
            }
            if (typeof event.response?.id === 'string') responseId = event.response.id;
            if (event.type === 'response.output_item.done' && event.item) output.push(event.item);
            const chunk = encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            queuedBytes += chunk.byteLength;
            if (queuedBytes > MAX_WEBSOCKET_MESSAGE_BYTES) { fail(new Error('OpenAI WebSocket response buffer exceeds limit')); return; }
            queue.push(chunk);
            if (!PRELUDE.has(event.type)) respond();
            if (TERMINAL.has(event.type))
            {
                finished = true;
                cleanup();
                if (event.type === 'response.completed' && responseId) entry.chain = { ...record, id: responseId, print: outputPrint(output) };
                release(entry);
            }
            pump();
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || clientGone?.()) { abort(); return; }
        timer = setTimeout(() => fail(new Error('OpenAI WebSocket response timed out')), timeout);
        try
        {
            connection.send(JSON.stringify(body));
            sent = true;
            entry.turns++;
            connection.start();
        }
        catch (error) { fail(error); }
    });
}

function tooLarge(error)
{
    return new Response(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: error.message } }),
        { status: 413, headers: { 'Content-Type': 'application/json' } });
}

export async function responsesWebSocketRequest(url, options, clientGone)
{
    const target = new URL(url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : target.protocol === 'http:' ? 'ws:' : target.protocol;
    const signal = options.signal || clientGone?.signal;
    if (signal?.aborted || clientGone?.()) throw new Error('client disconnected');
    const headers = Object.fromEntries(new Headers(options.headers));
    headers['openai-beta'] = 'responses_websockets=2026-02-06';
    // These describe the HTTP SSE leg, not the authenticated WebSocket upgrade.
    delete headers.accept;
    delete headers['content-type'];
    const payload = JSON.parse(options.body);
    if (payload.type !== undefined) throw new Error('Responses request already has an event type');
    const { input: rawInput, ...rest } = payload;
    const input = Array.isArray(rawInput) ? rawInput : [];
    const props = JSON.stringify(rest);
    const inputJson = input.map(item => JSON.stringify(item));
    const timeout = options.headersTimeoutMs || 120000;
    let lossResent = false;
    for (let attempt = 1; ; attempt++)
    {
        const fresh = attempt > 1;
        let entry;
        try
        {
            entry = await acquire(target.href, headers, signal, timeout,
                fresh ? null : candidate => !!continuation(candidate.chain, props, inputJson, input));
        }
        catch (error)
        {
            if (!UPGRADE_ERRORS.has(error.code) || attempt >= MAX_ATTEMPTS || signal?.aborted || clientGone?.()) throw error;
            await delay(500 * attempt);
            continue;
        }
        if (entry instanceof Response)
        {
            // Authentication and rate-limit rejections keep their status; only a
            // server-side upgrade failure is worth another handshake.
            if (entry.status < 500 || attempt >= MAX_ATTEMPTS) return entry;
            await entry.body?.cancel();
            await delay(500 * attempt);
            continue;
        }
        const resume = fresh ? null : continuation(entry.chain, props, inputJson, input);
        entry.chain = null;
        let chunks;
        try { chunks = chunkPlan(rest, inputJson, resume?.start ?? 0, resume?.previous); }
        catch (error) { release(entry); return tooLarge(error); }
        try
        {
            let previous = resume?.previous;
            let refused = null;
            for (const [a, b] of chunks.slice(0, -1))
            {
                const result = await upload(entry, { type: 'response.create', ...rest, input: input.slice(a, b),
                    ...(previous ? { previous_response_id: previous } : {}), generate: false }, signal, timeout);
                if (result.refused) { refused = result.refused; break; }
                previous = result.id;
            }
            if (refused)
            {
                if (freshSocketRefusal(refused) && attempt < MAX_ATTEMPTS) { sends.resent++; continue; }
                return errorResponse(refused);
            }
            const [a, b] = chunks.at(-1);
            const result = await stream(entry, { type: 'response.create', ...rest, input: input.slice(a, b),
                ...(previous ? { previous_response_id: previous } : {}) }, signal, clientGone, timeout, { props, inputJson });
            if (result.retry)
            {
                if (attempt < MAX_ATTEMPTS) { sends.resent++; continue; }
                return errorResponse(result.retry);
            }
            sends[resume ? 'warm' : 'cold']++;
            if (chunks.length > 1) sends.chunked++;
            return result.response;
        }
        catch (error)
        {
            // An idle socket can die unnoticed; a loss before any event reached
            // the consumer is resent once on a fresh socket, as Codex does.
            if (error.forwarded || lossResent || attempt >= MAX_ATTEMPTS || signal?.aborted || clientGone?.()) throw error;
            lossResent = true;
            sends.resent++;
        }
    }
}
