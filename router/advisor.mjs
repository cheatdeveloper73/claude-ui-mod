// advisor.mjs -- Anthropic's native advisor tool (advisor_20260301), run by this router.
//
// Claude Code 2.1.260 and 2.1.284 declare it as
//     { type: 'advisor_20260301', name: 'advisor', model: <reviewer> }
// when the user has chosen an advisor and the CLI gate passes. The tool takes no
// parameters. Anthropic's server runs the reviewer over the executor's whole
// conversation and answers inside the same assistant message with
//     server_tool_use(name advisor, input {})
//     advisor_tool_result { type: 'advisor_result', text, stop_reason }
//       | { type: 'advisor_tool_result_error', error_code }
// then lets the executor continue. A GPT executor behind this router has no such
// server, so the router is the server: the OpenAI arm turns the declaration into a
// parameterless function, suppresses the model's call, consults the declared
// reviewer through the router's own dispatch, and writes the native blocks.
//
// This file is pure. It imports nothing from the router, so openai.mjs (replay) and
// index.mjs (execution) can both depend on it without a cycle.

export const ADVISOR_TOOL_TYPE = 'advisor_20260301';
export const ADVISOR_TOOL_NAME = 'advisor';

// Consultations per Anthropic message. The lead gets its fill of advice and then
// the tool is withdrawn, so a model that keeps asking still has to answer.
export const ADVISOR_MAX_CONSULTS = 3;

// Marks the router's own consultation request so the receiving arm can put it on
// the subagent lane. Validated against a per-consultation secret (see index.mjs),
// never trusted as sent, and never forwarded upstream.
export const ADVISOR_CONSULT_HEADER = 'x-cuimod-advisor-consult';

const ADVISOR_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 240000;

// The CLI's own "# Advisor Tool" system section tells the executor when to call
// it; this is only the tool's description for the function declaration.
const ADVISOR_DESCRIPTION = 'Consult a stronger reviewer model. Takes no parameters: your entire conversation so far is forwarded to the reviewer automatically. Returns the reviewer\'s guidance as text.';

const ADVISOR_INSTRUCTIONS = [
    'You are the advisor: a stronger reviewer that another AI model (the executor) consults in the middle of its task. You are not talking to the end user and you cannot run tools; everything you can know is in the executor\'s system prompt and transcript below. Tool calls and tool results in the transcript are shown as bracketed text.',
    '',
    'Reply with guidance the executor can act on immediately. Start with the single most important point. Name wrong assumptions, risks, missing steps and anything it should verify, and say plainly when the current approach is sound. Be specific to this task and concise. Do not restate the task, do not write the executor\'s final answer for it, and do not ask clarifying questions.',
].join('\n');

const CONSULT_PROMPT = 'The executor has just called the advisor tool. Give your advice now.';

export function isNativeAdvisorTool(tool)
{
    return tool?.type === ADVISOR_TOOL_TYPE && tool?.name === ADVISOR_TOOL_NAME
        && typeof tool.model === 'string' && tool.model.trim() !== '';
}

export function nativeAdvisorTool(tools)
{
    return Array.isArray(tools) ? tools.find(isNativeAdvisorTool) || null : null;
}

export function advisorFunctionTool()
{
    return {
        type: 'function',
        name: ADVISOR_TOOL_NAME,
        description: ADVISOR_DESCRIPTION,
        strict: false,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    };
}

export const advisorErrorContent = code => ({ type: 'advisor_tool_result_error', error_code: code });

// The text the executor sees for a result, on the live round and on every replay.
// Both must produce the same bytes or the prompt cache misses after the call.
export function advisorFeedbackText(content)
{
    if (content?.type === 'advisor_result' && typeof content.text === 'string') return content.text;
    if (content?.type === 'advisor_redacted_result')
        return 'ERROR: the advisor response is redacted and cannot be shown to this model.';
    if (content?.type === 'advisor_tool_result_error')
        return `ERROR: the advisor is unavailable (${String(content.error_code || 'unknown')}). Continue without its advice.`;
    return 'ERROR: the advisor returned no usable result.';
}

// ---- the reviewer's view of the conversation ---------------------------------

const IDENTITY_BLOCK = /x-anthropic-billing-header\s*:|Claude Agent SDK|You are Claude Code/i;

function withoutCacheControl(block)
{
    const { cache_control: _ignored, ...rest } = block;
    return rest;
}

function toolResultParts(content)
{
    if (typeof content === 'string') return { text: content, images: [] };
    if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images: [] };
    const text = [];
    const images = [];
    for (const part of content)
    {
        if (part?.type === 'text') text.push(part.text || '');
        else if (part?.type === 'image') images.push(withoutCacheControl(part));
        else if (part?.type === 'tool_reference') text.push(`Loaded tool: ${part.tool_name}`);
        else if (part != null) text.push(typeof part === 'string' ? part : JSON.stringify(part));
    }
    return { text: text.join('\n'), images };
}

function jsonText(value)
{
    try { return JSON.stringify(value ?? {}); }
    catch { return '{}'; }
}

// Renders Anthropic messages for a model that has no tools. Tool traffic becomes
// bracketed text because a request without a `tools` array may not carry tool_use
// or tool_result blocks. Reasoning blocks are dropped: their signatures belong to
// the executor's provider and are invalid for any other model, and they are opaque.
export function consultMessages(messages, partial)
{
    const sequence = [...(Array.isArray(messages) ? messages : [])];
    if (Array.isArray(partial) && partial.length) sequence.push({ role: 'assistant', content: partial });

    const toolNames = new Map();
    const out = [];
    const push = (role, blocks) =>
    {
        if (!blocks.length) return;
        if (out.length && out.at(-1).role === role) out.at(-1).content.push(...blocks);
        else out.push({ role, content: blocks });
    };

    for (const message of sequence)
    {
        const role = message?.role === 'assistant' ? 'assistant' : 'user';
        const note = message?.role === 'system' || message?.role === 'developer';
        const content = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }];
        const blocks = [];
        for (const block of content)
        {
            if (block?.type === 'text')
            {
                if (typeof block.text === 'string' && block.text.trim())
                    blocks.push({ type: 'text', text: note ? `[Harness note]\n${block.text}` : block.text });
            }
            else if (block?.type === 'image' || block?.type === 'document')
            {
                if (role === 'user') blocks.push(withoutCacheControl(block));
            }
            else if (block?.type === 'tool_use')
            {
                if (block.id) toolNames.set(block.id, block.name);
                blocks.push({ type: 'text', text: `[Tool call: ${block.name}] ${jsonText(block.input)}` });
            }
            else if (block?.type === 'tool_result')
            {
                const { text, images } = toolResultParts(block.content);
                const label = toolNames.get(block.tool_use_id) || 'tool';
                blocks.push({ type: 'text', text: `[Tool result: ${label}${block.is_error ? ' (error)' : ''}]\n${text || '(no output)'}` });
                blocks.push(...images);
            }
            else if (block?.type === 'advisor_tool_result')
            {
                const failed = block.content?.type !== 'advisor_result';
                blocks.push({ type: 'text', text: failed
                    ? `[Earlier advisor consultation failed: ${block.content?.error_code || 'no result'}]`
                    : `[Earlier advisor feedback]\n${block.content.text}` });
            }
        }
        // Images are only valid in user turns; a tool result may bring some into an
        // assistant-role replay, which the filter above already excluded.
        push(role, blocks);
    }

    if (!out.length || out[0].role !== 'user')
        out.unshift({ role: 'user', content: [{ type: 'text', text: '(The executor\'s conversation begins below.)' }] });
    if (out.at(-1).role === 'user') out.at(-1).content.push({ type: 'text', text: CONSULT_PROMPT });
    else out.push({ role: 'user', content: [{ type: 'text', text: CONSULT_PROMPT }] });
    return out;
}

function systemParts(system)
{
    const blocks = typeof system === 'string' ? [{ type: 'text', text: system }]
        : Array.isArray(system) ? system.filter(block => block?.type === 'text' && typeof block.text === 'string') : [];
    // The client's own identity blocks go first and verbatim: they are what the
    // same credential was admitted with on the executor's request. Other arms
    // strip them on their way out.
    const identity = blocks.filter(block => block.text.length < 600 && IDENTITY_BLOCK.test(block.text))
        .map(block => ({ type: 'text', text: block.text }));
    const rest = blocks.filter(block => !identity.some(kept => kept.text === block.text)).map(block => block.text).join('\n\n').trim();
    return { identity, rest };
}

export function buildConsultBody({ tool, system, messages, partial })
{
    const { identity, rest } = systemParts(system);
    const advisorSystem = rest
        ? `${ADVISOR_INSTRUCTIONS}\n\n<executor_system_prompt>\n${rest}\n</executor_system_prompt>`
        : ADVISOR_INSTRUCTIONS;
    return {
        model: tool.model,
        max_tokens: ADVISOR_MAX_TOKENS,
        stream: false,
        system: [...identity, { type: 'text', text: advisorSystem }],
        messages: consultMessages(messages, partial),
    };
}

export function consultHeaders(incoming, { token })
{
    const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'content-type', 'accept',
        'origin', 'referer', 'transfer-encoding', 'x-claude-code-agent-id', ADVISOR_CONSULT_HEADER]);
    const headers = {};
    for (const [name, value] of Object.entries(incoming || {}))
    {
        const key = name.toLowerCase();
        if (skip.has(key) || key.startsWith('sec-fetch-')) continue;
        headers[key] = value;
    }
    headers['content-type'] = 'application/json';
    headers.accept = 'application/json';
    // The router admits one in-flight /v1/messages per session+agent. The executor's
    // own request is still open, so the consultation needs a key of its own.
    headers['x-claude-code-agent-id'] = `${String(incoming?.['x-claude-code-agent-id'] || 'root').trim() || 'root'}~advisor`;
    headers[ADVISOR_CONSULT_HEADER] = token;
    return headers;
}

function errorCodeFor(status, text)
{
    if (status === 429) return 'too_many_requests';
    if (status === 529 || status === 503 || /overloaded/i.test(text)) return 'overloaded';
    if (status === 413 || /prompt is too long|too many tokens|context (window|length)|exceeds the maximum/i.test(text)) return 'prompt_too_long';
    return 'unavailable';
}

export function advisorTimeoutMs()
{
    const configured = Number(process.env.MODEL_ROUTER_ADVISOR_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 50 ? configured : DEFAULT_TIMEOUT_MS;
}

// Returns { content, iteration?, detail } or { aborted: true } when the executor's
// own client went away. Never returns a successful result that carries no advice.
export async function consultAdvisor({ origin, headers, body, tool, signal, timeoutMs = advisorTimeoutMs() })
{
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const failure = (code, detail) => ({ content: advisorErrorContent(code), detail });

    let status;
    let text;
    try
    {
        const response = await fetch(`${origin}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
        status = response.status;
        text = await response.text();
    }
    catch (error)
    {
        if (signal?.aborted) return { aborted: true };
        if (timeout.aborted) return failure('execution_time_exceeded', 'deadline');
        return failure('unavailable', String(error?.cause?.code || error?.name || 'error'));
    }

    if (status < 200 || status >= 300) return failure(errorCodeFor(status, text.slice(0, 2000)), `http ${status}`);

    let message;
    try { message = JSON.parse(text); }
    catch { return failure('unavailable', 'unparseable response'); }
    if (message?.type === 'error' || !Array.isArray(message?.content)) return failure('unavailable', 'not a message');

    const advice = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n\n').trim();
    const stopReason = typeof message.stop_reason === 'string' && message.stop_reason ? message.stop_reason : 'end_turn';
    const refused = stopReason === 'refusal';
    if (!advice && !refused) return failure('unavailable', 'empty advice');

    const usage = message.usage || {};
    const count = value => (Number.isFinite(value) ? value : 0);
    return {
        content: { type: 'advisor_result', text: advice || 'The advisor declined to respond.', stop_reason: stopReason },
        iteration: {
            type: 'advisor_message',
            model: typeof message.model === 'string' && message.model ? message.model : tool.model,
            input_tokens: count(usage.input_tokens),
            output_tokens: count(usage.output_tokens),
            cache_read_input_tokens: count(usage.cache_read_input_tokens),
            cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
            cache_creation: usage.cache_creation ?? null,
        },
    };
}
