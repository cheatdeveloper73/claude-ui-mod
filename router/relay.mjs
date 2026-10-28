// The transport every provider arm shares: retry policy, header filtering, and
// the Anthropic SSE relay.
//
// This lives outside index.mjs so a provider adapter can reach it without
// importing the router back -- an adapter is loaded *by* index.mjs, so any
// import in the other direction is a cycle. Nothing here knows which provider
// it is serving.

const DROP_REQ = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function errorBody(message, type = 'api_error')
{
    return JSON.stringify({ type: 'error', error: { type, message } });
}

// ---------------------------------------------------- transport safety ----

const HEADERS_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const NO_STATUS_RETRY = new Set();
const TRANSIENT = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(500 * 2 ** (n - 1), 4000) + Math.floor(Math.random() * 250);

function isTransient(err)
{
    const code = err?.cause?.code || err?.code || '';
    return TRANSIENT.has(code) || err?.name === 'TimeoutError' || /terminated|socket hang up/i.test(err?.message || '');
}

// Retries are safe here in a way they are not mid-stream: nothing has been
// written to the client until the upstream headers arrive, so an attempt that
// dies before that point can simply be repeated.
//
// `retryStatus` is a parameter rather than a constant because retrying a status
// is WRONG in front of a gateway that already fails over internally across an
// account pool before it answers: there, a 429 or 503 means the whole pool is
// exhausted, not that this attempt was unlucky. Measured 2026-08-29 on the
// account-pool arm: a single subagent spawn retried here on top of that
// failover drove every account to RESOURCE_EXHAUSTED and turned a soft
// rate-limit into "no available accounts" for a full minute. Passing the status
// straight back lets the Anthropic SDK's own backoff, which honours
// Retry-After, do the waiting instead.
async function fetchResilient(url, opts, label, clientGone, retryStatus = RETRY_STATUS, log = () => {}, headersTimeoutMs = HEADERS_TIMEOUT_MS)
{
    let last;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
    {
        if (clientGone && clientGone()) throw new Error('client disconnected');

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), headersTimeoutMs);

        try
        {
            const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal;
            const res = await fetch(url, { ...opts, signal });
            clearTimeout(timer);

            if (retryStatus.has(res.status) && attempt < MAX_ATTEMPTS)
            {
                log(`${label} ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1}`);
                try { await res.arrayBuffer(); } catch (_) {}
                await sleep(backoff(attempt));
                continue;
            }

            return res;
        }
        catch (e)
        {
            clearTimeout(timer);
            last = e;
            if (clientGone && clientGone()) throw new Error('client disconnected');
            if (!isTransient(e) || attempt === MAX_ATTEMPTS) throw e;
            log(`${label} ${e?.cause?.code || e?.name}, retry ${attempt}/${MAX_ATTEMPTS - 1}`);
            await sleep(backoff(attempt));
        }
    }

    throw last || new Error(`${label} failed`);
}

// ------------------------------------------------------- body reshaping ----

// Claude Code prepends two system blocks that announce the client to Anthropic:
// an `x-anthropic-billing-header:` line that is a HTTP header shipped in the
// prompt by accident, and a one-line "You are a Claude agent" identity.
//
// A non-Anthropic backend has no use for either, and at least one refuses a
// request carrying them outright -- see docs/provider-adapters.md. Removing
// them costs nothing: the billing header is meaningless to any model, and the
// identity is contradicted by whatever identity the backend injects ahead of it
// anyway.
//
// Note the scope: only SYSTEM blocks are filtered. A message body mentioning
// Claude or Anthropic -- CLAUDE.md pasted into a brief, for instance -- passes
// fine, measured, so there is nothing to scrub there.
const CLIENT_IDENTITY_BLOCK = [
    /^\s*x-anthropic-billing-header\s*:/i,
    /^\s*You are a Claude agent, built on Anthropic's Claude Agent SDK\.?\s*$/i,
];

const isClientIdentity = (text) => CLIENT_IDENTITY_BLOCK.some((re) => re.test(String(text || '')));

function stripClientIdentity(system)
{
    if (Array.isArray(system))
    {
        const kept = system.filter((b) => !(b?.type === 'text' && isClientIdentity(b.text)));
        return kept.length ? kept : undefined;
    }

    if (typeof system === 'string')
    {
        const kept = system.split('\n').filter((line) => !isClientIdentity(line)).join('\n');
        return kept.trim() ? kept : undefined;
    }

    return system;
}

// An image inside a tool_result never reaches some backends, and the model does
// not notice it is missing -- it answers from nothing. Measured 2026-08-29 with
// a PNG reading "KRYPTON-73" beside a red circle: delivered as a plain user
// image block the model read it exactly, at 1452 input tokens; delivered inside
// a tool_result it answered "I am a potato" and "Blue" at 434 input tokens,
// which is the token count of the prompt with no image in it at all.
//
// The loss is in the translation layer, not here: a translator that reduces a
// tool_result content array to a string by keeping the text and nothing else
// leaves an image block no trace, and an all-image result then collapses to a
// literal "Command executed successfully."
//
// So hoist the image out to a sibling block immediately after the tool_result,
// where an image block is handled normally, and in the same turn. This is a
// re-shaping of the request; the backend needs no change.
//
// The tool_result is left in place carrying its text, so the model still sees
// which call produced the image. A result that was ONLY an image would
// otherwise read as a tool that returned nothing, so it gets an explicit note.
function hoistToolResultImages(messages)
{
    if (!Array.isArray(messages)) return messages;

    let touched = false;

    const out = messages.map((msg) =>
    {
        if (!msg || !Array.isArray(msg.content)) return msg;

        const rebuilt = [];
        let changed = false;

        for (const block of msg.content)
        {
            if (block?.type !== 'tool_result' || !Array.isArray(block.content))
            {
                rebuilt.push(block);
                continue;
            }

            const images = block.content.filter((c) => c?.type === 'image');
            if (!images.length) { rebuilt.push(block); continue; }

            changed = true;
            const rest = block.content.filter((c) => c?.type !== 'image');
            const note = images.length === 1
                ? '[1 image returned by this tool follows]'
                : `[${images.length} images returned by this tool follow]`;

            rebuilt.push({ ...block, content: rest.concat([{ type: 'text', text: note }]) });
            for (const img of images) rebuilt.push(img);
        }

        if (!changed) return msg;
        touched = true;
        return { ...msg, content: rebuilt };
    });

    return touched ? out : messages;
}

function prepareProviderBody(body)
{
    const out = { ...body };
    if (out.system)
    {
        const cleaned = stripClientIdentity(out.system);
        if (cleaned === undefined) delete out.system;
        else out.system = cleaned;
    }
    return out;
}

// --------------------------------------------------------------- relay ----

function anthropicUsageObserver(onUsage, fallbackModel)
{
    const observed = { responseId: null, servedModel: null, usage: {}, stopReason: null, recorded: false };
    const merge = usage => {
        if (!usage || typeof usage !== 'object') return;
        observed.usage = {
            ...observed.usage,
            ...usage,
            ...(observed.usage.output_tokens_details || usage.output_tokens_details
                ? { output_tokens_details: { ...observed.usage.output_tokens_details, ...usage.output_tokens_details } }
                : {}),
        };
    };
    return event => {
        if (event?.type === 'message_start' && event.message)
        {
            observed.responseId = event.message.id || observed.responseId;
            observed.servedModel = event.message.model || observed.servedModel;
            merge(event.message.usage);
        }
        else if (event?.type === 'message_delta')
        {
            merge(event.usage);
            observed.stopReason = event.delta?.stop_reason || observed.stopReason;
        }
        else if (event?.type === 'message_stop' && !observed.recorded && observed.responseId)
        {
            observed.recorded = true;
            onUsage?.({ responseId: observed.responseId, servedModel: observed.servedModel || fallbackModel,
                usage: observed.usage, rawUsage: observed.usage,
                status: observed.stopReason === 'max_tokens' ? 'incomplete' : 'completed' });
        }
    };
}

function eventFromFrame(frame)
{
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch (_) { return null; }
}

// Reasoning-off is the one state where a missing detail has a known value. The
// enabled path never calls this helper: if a provider omits its hidden-token
// split, the omission remains unknown rather than being inferred from output.
function zeroReasoningUsage(usage)
{
    if (!usage || typeof usage !== 'object') return usage;
    const details = { ...(usage.output_tokens_details || {}), thinking_tokens: 0 };
    if (Object.hasOwn(details, 'reasoning_tokens')) details.reasoning_tokens = 0;
    return {
        ...usage,
        ...(Object.hasOwn(usage, 'thoughtsTokenCount') ? { thoughtsTokenCount: 0 } : {}),
        output_tokens_details: details,
    };
}

const isReasoningBlock = block => block?.type === 'thinking' || block?.type === 'redacted_thinking';

function stripReasoningPayload(payload)
{
    if (!payload || typeof payload !== 'object') return payload;
    return {
        ...payload,
        ...(Array.isArray(payload.content) ? { content: payload.content.filter(block => !isReasoningBlock(block)) } : {}),
        ...(payload.usage ? { usage: zeroReasoningUsage(payload.usage) } : {}),
    };
}

// A provider honoring the disabled request emits no thinking blocks. This
// filter keeps the downstream contract true if a gateway echoes one anyway,
// and compacts block indices so removing index zero cannot leave text at one.
function noReasoningEventFilter()
{
    const suppressed = new Set();
    const indices = new Map();
    let nextIndex = 0;

    return event => {
        if (!event || typeof event !== 'object') return event;
        if (event.type === 'message_start' && event.message)
        {
            return { ...event, message: stripReasoningPayload(event.message) };
        }
        if (event.type === 'message_delta')
        {
            return event.usage ? { ...event, usage: zeroReasoningUsage(event.usage) } : event;
        }
        if (event.type === 'content_block_start')
        {
            const source = event.index ?? 0;
            if (isReasoningBlock(event.content_block)) { suppressed.add(source); return null; }
            const target = nextIndex++;
            indices.set(source, target);
            return target === source ? event : { ...event, index: target };
        }
        if (event.type === 'content_block_delta')
        {
            const source = event.index ?? 0;
            if (suppressed.has(source) || ['thinking_delta', 'signature_delta'].includes(event.delta?.type)) return null;
            const target = indices.get(source);
            return target === undefined || target === source ? event : { ...event, index: target };
        }
        if (event.type === 'content_block_stop')
        {
            const source = event.index ?? 0;
            if (suppressed.delete(source)) return null;
            const target = indices.get(source);
            indices.delete(source);
            return target === undefined || target === source ? event : { ...event, index: target };
        }
        return event;
    };
}

// Stream the upstream body through untouched. A backend that already emits the
// Anthropic SSE event sequence needs no re-framing -- and relaying rather than
// collecting means first-token latency is the backend's, not ours.
async function pipeBody(upstream, res)
{
    if (!upstream.body) { res.end(); return; }

    const reader = upstream.body.getReader();

    for (;;)
    {
        const { value, done } = await reader.read();
        if (done) break;

        if (res.writableEnded || res.destroyed) { try { await reader.cancel(); } catch (_) {} return; }

        // Respect backpressure: a subagent transcript can outrun a slow client
        // socket, and ignoring the write() return value buffers all of it in
        // memory.
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
    }

    res.end();
}

async function pipeObservedAnthropicBody(upstream, res, streaming, onUsage, fallbackModel, probe)
{
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    const usage = anthropicUsageObserver(onUsage, fallbackModel);
    // The rate probe sees the same parsed event the usage observer does, so the
    // two ledgers cannot disagree about what arrived or when.
    const observe = event => { probe?.(event); usage(event); };
    const decoder = new TextDecoder();
    let text = '';
    const chunks = [];
    for (;;)
    {
        const { value, done } = await reader.read();
        if (done) break;
        if (res.writableEnded || res.destroyed) { try { await reader.cancel(); } catch (_) {} return; }
        const bytes = Buffer.from(value);
        if (streaming)
        {
            text += decoder.decode(value, { stream: true });
            for (;;)
            {
                const boundary = /\r?\n\r?\n/.exec(text);
                if (!boundary) break;
                const frame = text.slice(0, boundary.index);
                text = text.slice(boundary.index + boundary[0].length);
                const event = eventFromFrame(frame);
                if (event) observe(event);
            }
        }
        else chunks.push(bytes);
        if (!res.write(bytes)) await new Promise(resolve => res.once('drain', resolve));
    }
    if (streaming)
    {
        text += decoder.decode();
        const event = eventFromFrame(text);
        if (event) observe(event);
    }
    else
    {
        try
        {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (payload?.id && payload?.usage) onUsage?.({ responseId: payload.id,
                servedModel: payload.model || fallbackModel, usage: payload.usage, rawUsage: payload.usage,
                status: payload.stop_reason === 'max_tokens' ? 'incomplete' : 'completed' });
        }
        catch (_) {}
    }
    res.end();
}

function canonicalizeJson(value)
{
    if (Array.isArray(value)) return value.map(canonicalizeJson);
    if (!value || typeof value !== 'object') return value;

    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeJson(value[key]);
    return out;
}

function toolCallSignature(name, input, rawInput = '')
{
    if (rawInput)
    {
        try { input = JSON.parse(rawInput); }
        catch (_) { return `${name}\x1f${rawInput.trim()}`; }
    }
    return `${name}\x1f${JSON.stringify(canonicalizeJson(input || {}))}`;
}

function dedupeToolUsePayload(payload)
{
    if (!Array.isArray(payload?.content)) return { payload, duplicate: null };

    const seen = new Set();
    let duplicate = null;
    const content = payload.content.filter(block => {
        if (block?.type !== 'tool_use') return true;
        const signature = toolCallSignature(block.name || '', block.input);
        if (!seen.has(signature)) { seen.add(signature); return true; }
        duplicate ||= block.name || 'unknown';
        return false;
    });

    return duplicate ? { payload: { ...payload, content }, duplicate } : { payload, duplicate: null };
}

function cancelReaderOnResponseClose(reader, res)
{
    let canceled = false;
    const cancel = () => {
        if (canceled) return;
        canceled = true;
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
    };
    if (typeof res.once === 'function')
    {
        res.once('close', cancel);
        res.once('error', cancel);
    }
    if (res.writableEnded || res.destroyed) cancel();
    return {
        canceled: () => canceled || res.writableEnded || res.destroyed,
        dispose: () => {
            if (typeof res.off === 'function')
            {
                res.off('close', cancel);
                res.off('error', cancel);
            }
            else if (typeof res.removeListener === 'function')
            {
                res.removeListener('close', cancel);
                res.removeListener('error', cancel);
            }
        },
    };
}

// The backend sees the bare provider slug; retain the requested alias in the
// Anthropic envelope so the native transcript matches the selected model.
async function pipeAnthropicBody(upstream, res, clientModel, streaming, onUsage, probe, options = {})
{
    if (!upstream.body) { res.end(); return; }
    const reasoningEnabled = options.reasoningEnabled !== false;
    const stopOnDuplicateToolCall = options.stopOnDuplicateToolCall === true;
    const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
        ? options.idleTimeoutMs
        : 0;

    if (!streaming)
    {
        let payload = await upstream.json();
        let duplicate = null;
        if (!reasoningEnabled) payload = stripReasoningPayload(payload);
        if (options.payloadFilter) payload = options.payloadFilter(payload);
        if (stopOnDuplicateToolCall) ({ payload, duplicate } = dedupeToolUsePayload(payload));
        if (payload && typeof payload === 'object')
        {
            if (payload.usage && payload.id) onUsage?.({ responseId: payload.id, servedModel: payload.model || clientModel,
                usage: payload.usage, rawUsage: payload.usage,
                status: payload.stop_reason === 'max_tokens' ? 'incomplete' : 'completed' });
            if (payload.model) payload.model = clientModel;
        }
        res.end(JSON.stringify(payload));
        return duplicate ? { duplicateTool: duplicate, responseId: payload?.id || null, canceled: false } : null;
    }

    const reader = upstream.body.getReader();
    const downstream = cancelReaderOnResponseClose(reader, res);
    const readNext = async () => {
        if (!idleTimeoutMs) return reader.read();
        let timer;
        try
        {
            return await Promise.race([
                reader.read(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error(`upstream stream produced no bytes for ${idleTimeoutMs}ms`);
                        error.code = 'STREAM_IDLE_TIMEOUT';
                        reject(error);
                    }, idleTimeoutMs);
                }),
            ]);
        }
        finally { clearTimeout(timer); }
    };
    const dec = new TextDecoder();
    const usage = anthropicUsageObserver(onUsage, clientModel);
    const filters = [reasoningEnabled ? null : noReasoningEventFilter(), options.eventFilter].filter(Boolean);
    const seenToolCalls = new Set();
    const pendingToolBlocks = new Map();
    let buffer = '';
    let responseId = null;
    let duplicateTool = null;
    let terminal = false;

    const prepareFrame = frame => {
        if (!frame) return null;
        const lines = frame.split(/\r?\n/);
        let event = eventFromFrame(frame);
        let observedEvent = event;
        if (event)
        {
            for (const filter of filters)
            {
                event = filter(event);
                if (!event) return null;
            }
            observedEvent = event;
            // Observe the provider's real model before changing only the client
            // envelope. Accounting and the native transcript need different ids.
            if (event.message?.model) event = { ...event, message: { ...event.message, model: clientModel } };
            if (event.model) event = { ...event, model: clientModel };
            const i = lines.findIndex(line => line.startsWith('data:'));
            if (i !== -1)
            {
                lines.splice(i, lines.length - i, 'data: ' + JSON.stringify(event));
                frame = lines.join(String.fromCharCode(10));
            }
        }
        return { event, observedEvent, frame };
    };

    const writePrepared = async (prepared, observeUsage = true) => {
        if (!prepared) return;
        if (prepared.observedEvent || prepared.event)
        {
            const observedEvent = prepared.observedEvent || prepared.event;
            probe?.(observedEvent);
            if (observeUsage) usage(observedEvent);
        }
        if (!res.write(prepared.frame + String.fromCharCode(10, 10))) await new Promise(resolve => res.once('drain', resolve));
    };

    const processFrame = async frame => {
        const prepared = prepareFrame(frame);
        if (!prepared) return false;
        const event = prepared.event;
        if (options.stopOnMessageStop && event?.type === 'message_stop')
        {
            await writePrepared(prepared);
            terminal = true;
            return true;
        }
        if (!stopOnDuplicateToolCall || !event)
        {
            await writePrepared(prepared);
            return false;
        }

        if (event.type === 'message_start') responseId = event.message?.id || responseId;
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
        {
            pendingToolBlocks.set(event.index ?? 0, {
                frames: [prepared],
                name: event.content_block.name || '',
                input: event.content_block.input || {},
                rawInput: '',
            });
            return false;
        }

        const pending = pendingToolBlocks.get(event.index ?? 0);
        if (pending)
        {
            pending.frames.push(prepared);
            if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta')
                pending.rawInput += event.delta.partial_json || '';
            if (event.type !== 'content_block_stop') return false;

            pendingToolBlocks.delete(event.index ?? 0);
            const signature = toolCallSignature(pending.name, pending.input, pending.rawInput);
            if (seenToolCalls.has(signature))
            {
                duplicateTool = pending.name || 'unknown';
                return true;
            }
            seenToolCalls.add(signature);
            for (const item of pending.frames) await writePrepared(item);
            return false;
        }

        await writePrepared(prepared);
        return false;
    };

    try
    {
        outer: for (;;)
        {
            const { value, done } = await readNext();
            if (done) break;
            if (downstream.canceled()) return null;
            buffer += dec.decode(value, { stream: true });
            for (;;)
            {
                const boundary = /\r?\n\r?\n/.exec(buffer);
                if (!boundary) break;
                const frame = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary[0].length);
                if (await processFrame(frame)) break outer;
            }
        }
    }
    catch (error)
    {
        if (error?.code === 'STREAM_IDLE_TIMEOUT')
        {
            try { await reader.cancel(); } catch (_) {}
            if (downstream.canceled()) return null;
            const event = { type: 'error', error: { type: 'api_error', message: 'Upstream stream timed out waiting for output.' } };
            await writePrepared({ event, observedEvent: event,
                frame: `event: error\ndata: ${JSON.stringify(event)}` }, false);
            res.end();
            return { idleTimeout: true };
        }
        if (!downstream.canceled()) throw error;
        return null;
    }
    finally { downstream.dispose(); }

    if (downstream.canceled()) return null;
    if (terminal)
    {
        // message_stop owns the completed turn. Cancel only this HTTP/2 stream;
        // waiting for EOF can hold up tools or admit a late transport failure.
        try { await reader.cancel(); } catch (_) {}
        res.end();
        return null;
    }

    if (!duplicateTool)
    {
        buffer += dec.decode();
        if (buffer) await processFrame(buffer);
    }

    if (duplicateTool)
    {
        try { await reader.cancel(); } catch (_) {}
        // The duplicate block was never exposed. The first identical call is a
        // complete valid block, so close the message as an ordinary tool turn
        // and let its result drive a fresh provider response.
        const delta = { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 0 } };
        const stop = { type: 'message_stop' };
        await writePrepared({ event: delta, frame: `event: message_delta\ndata: ${JSON.stringify(delta)}` }, false);
        await writePrepared({ event: stop, frame: `event: message_stop\ndata: ${JSON.stringify(stop)}` }, false);
        res.end();
        return { duplicateTool, responseId, canceled: true };
    }

    for (const pending of pendingToolBlocks.values())
        for (const item of pending.frames) await writePrepared(item);
    res.end();
    return null;
}

export {
    DROP_REQ,
    DROP_RES,
    errorBody,
    HEADERS_TIMEOUT_MS,
    MAX_ATTEMPTS,
    RETRY_STATUS,
    NO_STATUS_RETRY,
    isTransient,
    fetchResilient,
    stripClientIdentity,
    hoistToolResultImages,
    prepareProviderBody,
    anthropicUsageObserver,
    eventFromFrame,
    zeroReasoningUsage,
    stripReasoningPayload,
    noReasoningEventFilter,
    pipeBody,
    pipeObservedAnthropicBody,
    pipeAnthropicBody,
};
