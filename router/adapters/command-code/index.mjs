// Command Code adapter -- translates Anthropic Messages <-> OpenAI Chat Completions
// for open-source and Chinese models served by Command Code GOAT API.
//
// Command Code exposes /provider/v1/chat/completions (OpenAI format) for OSS models
// including DeepSeek V4, GLM 5.3, Kimi K3, Qwen 3.8, and MiniMax M3.
// Calls through the API consume GOAT plan allowances.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DROP_RES,
    NO_STATUS_RETRY,
    fetchResilient,
    pipeBody,
    prepareProviderBody,
} from '../../relay.mjs';
import { readProviderSettings } from '../../settings.mjs';
import { applyPromptPolicy, promptPolicyHeaders, resolvePromptPolicy } from '../../prompt-policy.mjs';
import { capturePrompt } from '../../prompt-capture.mjs';
import { isSubagentRequest } from '../../throughput.mjs';
import { registerRates } from '../../pricing.mjs';
import { CommandCodeLimits } from './limits.mjs';

// Market rates for models routed by Command Code.
registerRates({
    // V4.1 has recurring peak/off-peak pricing that the date-window rate table
    // cannot express. Keep the published undiscounted rate as the comparison cost.
    'command-code/deepseek-v4.1-flash': [{ from: null, to: null, input: 0.30, cacheRead: 0.006, cacheWrite5m: 0, cacheWrite1h: 0, output: 1.20 }],
    'command-code/deepseek-v4-flash':   [{ from: null, to: null, input: 0.14, cacheRead: 0.014, cacheWrite5m: 0, cacheWrite1h: 0, output: 0.28 }],
    'command-code/deepseek-v4-pro':   [{ from: null, to: null, input: 0.55, cacheRead: 0.055, cacheWrite5m: 0, cacheWrite1h: 0, output: 2.19 }],
    'command-code/glm-5.3-flash':     [{ from: null, to: null, input: 0.10, cacheRead: 0.010, cacheWrite5m: 0, cacheWrite1h: 0, output: 0.20 }],
    'command-code/glm-5.3':           [{ from: null, to: null, input: 0.50, cacheRead: 0.050, cacheWrite5m: 0, cacheWrite1h: 0, output: 1.00 }],
    'command-code/kimi-k3':           [{ from: null, to: null, input: 0.60, cacheRead: 0.060, cacheWrite5m: 0, cacheWrite1h: 0, output: 2.40 }],
    'command-code/qwen-3.8-max':      [{ from: null, to: null, input: 1.20, cacheRead: 0.120, cacheWrite5m: 0, cacheWrite1h: 0, output: 4.80 }],
    'command-code/minimax-m3':        [{ from: null, to: null, input: 0.20, cacheRead: 0.020, cacheWrite5m: 0, cacheWrite1h: 0, output: 0.80 }],
});

const BASE = process.env.COMMAND_CODE_BASE_URL || 'https://api.commandcode.ai/provider/v1';
const BILLING_BASE = process.env.COMMAND_CODE_API_BASE_URL || 'https://api.commandcode.ai';
const SECRETS_FILE = process.env.MODEL_ROUTER_SECRETS_FILE
    || fileURLToPath(new URL('../../../.state/provider-secrets.json', import.meta.url));

const MODELS = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', upstreamId: 'deepseek/deepseek-v4.1-flash', context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'deepseek-v4-flash',   name: 'DeepSeek V4 Flash',   upstreamId: 'deepseek/deepseek-v4-flash',   context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',   upstreamId: 'deepseek/deepseek-v4-pro',   context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'glm-5.3-flash',     name: 'GLM 5.3 Flash',     upstreamId: 'z-ai/glm-5.3-flash',         context: 1048576, maxOutput: 131072, efforts: [] },
    { id: 'glm-5.3',           name: 'GLM 5.3',           upstreamId: 'zai-org/GLM-5.3',            context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'kimi-k3',           name: 'Kimi K3',           upstreamId: 'moonshotai/Kimi-K3',         context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'qwen-3.8-max',      name: 'Qwen 3.8 Max',      upstreamId: 'Qwen/Qwen3.8-Max',           context: 1000000, maxOutput: 65536, efforts: [] },
    { id: 'minimax-m3',        name: 'MiniMax M3',        upstreamId: 'MiniMaxAI/MiniMax-M3',       context: 1000000, maxOutput: 65536, efforts: [] },
];

const KNOWN_IDS = new Set(MODELS.map(m => m.id.toLowerCase()));
const UPSTREAM_IDS = new Set(MODELS.map(m => m.upstreamId.toLowerCase()));
const NON_ZDR = new Set(['qwen/qwen3.8-flash']);

// A key holding a space or control character makes fetch throw a TypeError
// that quotes the whole Authorization header, and that text reaches the log,
// the 502 body and /limitsz. Such a value is treated as no key at all.
function usableKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    return /^[\x21-\x7e]+$/.test(key) ? key : null;
}

function readApiKey() {
    const fromEnv = usableKey(process.env.COMMAND_CODE_API_KEY);
    if (fromEnv) return fromEnv;
    try {
        const raw = fs.readFileSync(SECRETS_FILE, 'utf8').replace(/^﻿/, '');
        const obj = JSON.parse(raw);
        return usableKey(obj['command-code']) || usableKey(obj['commandcode']) || usableKey(obj['command_code']);
    } catch (_) {
        return null;
    }
}

function normalizeId(m) {
    return String(m || '')
        .replace(/\[1m\]/ig, '')
        .split(':')[0]
        .replace(/^(?:claude-)+/i, '')
        .toLowerCase();
}

function claims(model) {
    if (typeof model !== 'string') return false;
    const id = normalizeId(model);
    return KNOWN_IDS.has(id) || UPSTREAM_IDS.has(id) || /^(claude-)?(deepseek|command-code)/i.test(model);
}

function resolveModel(model) {
    const id = normalizeId(model);
    return MODELS.find(m => m.id.toLowerCase() === id || m.upstreamId.toLowerCase() === id)
        || { id, name: id, upstreamId: id, context: 1000000, maxOutput: 65536, efforts: [] };
}

function enc(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicUsage(u) {
    const cached = u?.input_tokens_details?.cached_tokens || u?.prompt_tokens_details?.cached_tokens || 0;
    const prompt = u?.input_tokens || u?.prompt_tokens || 0;
    const completion = u?.output_tokens || u?.completion_tokens || 0;
    const usage = {
        input_tokens: Math.max(0, prompt - cached),
        output_tokens: completion,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    };
    const reasoning = u?.output_tokens_details?.reasoning_tokens || u?.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoning === 'number') usage.output_tokens_details = { thinking_tokens: reasoning };
    return usage;
}

function anthropicToOpenAI(anthropicBody) {
    const messages = [];

    // System instructions
    if (anthropicBody.system) {
        let systemText = '';
        if (typeof anthropicBody.system === 'string') {
            systemText = anthropicBody.system;
        } else if (Array.isArray(anthropicBody.system)) {
            systemText = anthropicBody.system
                .map(block => typeof block === 'string' ? block : block.text || '')
                .filter(Boolean)
                .join('\n\n');
        }
        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }
    }

    // Messages
    for (const msg of anthropicBody.messages || []) {
        if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
            continue;
        }

        if (!Array.isArray(msg.content)) {
            messages.push({ role: msg.role, content: String(msg.content || '') });
            continue;
        }

        let textParts = [];
        let toolCalls = [];

        for (const block of msg.content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                    }
                });
            } else if (block.type === 'tool_result') {
                let resultText = '';
                if (typeof block.content === 'string') {
                    resultText = block.content;
                } else if (Array.isArray(block.content)) {
                    resultText = block.content.map(b => typeof b === 'string' ? b : b.text || '').join('\n');
                } else {
                    resultText = JSON.stringify(block.content || '');
                }
                messages.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id,
                    content: resultText
                });
            }
        }

        if (msg.role === 'assistant') {
            const assistantMsg = { role: 'assistant' };
            if (textParts.length) assistantMsg.content = textParts.join('\n');
            if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
            if (!assistantMsg.content && !assistantMsg.tool_calls) assistantMsg.content = '';
            messages.push(assistantMsg);
        } else if (msg.role === 'user') {
            if (textParts.length) {
                messages.push({ role: 'user', content: textParts.join('\n') });
            }
        }
    }

    // Tools
    let tools = undefined;
    if (Array.isArray(anthropicBody.tools) && anthropicBody.tools.length) {
        tools = anthropicBody.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema || { type: 'object', properties: {} }
            }
        }));
    }

    return {
        messages,
        tools,
        max_tokens: anthropicBody.max_tokens || 4096,
        temperature: anthropicBody.temperature ?? undefined,
    };
}

export default function createAdapter(kit) {
    const log = kit.log || (() => {});
    const limits = new CommandCodeLimits({ baseURL: BILLING_BASE, getApiKey: readApiKey });

    async function handle(req, res, body) {
        const gone = () => res.writableEnded || res.destroyed;
        const clientModel = body.model;
        const sessionId = req.headers['x-claude-code-session-id'] || null;
        const selection = resolvePromptPolicy(body, 'command-code', readProviderSettings(), sessionId);

        let prepared = prepareProviderBody(body);
        prepared = applyPromptPolicy(prepared, selection);

        const resolved = resolveModel(clientModel);
        const oaiPayload = anthropicToOpenAI(prepared);
        oaiPayload.model = resolved.upstreamId;

        const isStreaming = body.stream === true;
        oaiPayload.stream = isStreaming;
        if (isStreaming) {
            oaiPayload.stream_options = { include_usage: true };
        }

        capturePrompt({
            provider: 'command-code',
            sessionId,
            model: resolved.id,
            selection,
            system: prepared.system,
            tools: prepared.tools,
            effectiveSystem: prepared.system,
            effectiveTools: prepared.tools,
        });

        const rate = kit.throughput.begin({
            provider: 'command-code',
            sessionId,
            requestedModel: clientModel,
            subagent: isSubagentRequest(body),
            streaming: isStreaming,
        }, res);

        const apiKey = readApiKey();
        if (!apiKey) {
            rate.end();
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                type: 'error',
                // The secrets path would carry the Windows user name into the reply.
                error: { type: 'authentication_error', message: 'No Command Code API key: set COMMAND_CODE_API_KEY or "command-code" in .state/provider-secrets.json' }
            }));
            return;
        }

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'claude-ui-mod/1.0',
        };
        if (!NON_ZDR.has(resolved.upstreamId.toLowerCase())) {
            headers['x-cmd-zdr'] = '1';
        }

        log(`command-code ${clientModel} -> ${resolved.upstreamId} stream=${isStreaming} msgs=${oaiPayload.messages.length} tools=${oaiPayload.tools?.length ?? 0}`);

        const upstream = await fetchResilient(`${BASE}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(oaiPayload),
        }, 'command-code', gone, NO_STATUS_RETRY, log);

        rate.upstream();
        if (gone()) { rate.end(); return; }

        if (!upstream.ok) {
            rate.end();
            const outHeaders = {};
            upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) outHeaders[k] = v; });
            res.writeHead(upstream.status, { ...outHeaders, ...promptPolicyHeaders(selection) });
            await pipeBody(upstream, res);
            return;
        }

        // Non-streaming response
        if (!isStreaming) {
            try {
                const data = await upstream.json();
                const choice = data.choices?.[0] || {};
                const message = choice.message || {};
                const content = [];
                if (message.reasoning) {
                    content.push({ type: 'thinking', thinking: message.reasoning, signature: '' });
                }
                if (message.content) {
                    content.push({ type: 'text', text: message.content });
                }
                if (Array.isArray(message.tool_calls)) {
                    for (const tc of message.tool_calls) {
                        let input = {};
                        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (_) {}
                        content.push({
                            type: 'tool_use',
                            id: tc.id || `call_${Date.now()}`,
                            name: tc.function?.name,
                            input,
                        });
                    }
                }
                const response = {
                    id: 'msg_' + (data.id || Date.now()),
                    type: 'message',
                    role: 'assistant',
                    model: clientModel,
                    content,
                    stop_reason: message.tool_calls?.length ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
                    stop_sequence: null,
                    usage: anthropicUsage(data.usage),
                };

                const sample = {
                    responseId: data.id || null,
                    servedModel: resolved.id,
                    status: 'completed',
                    usage: response.usage,
                    rawUsage: data.usage,
                };
                kit.recordUsage({
                    provider: 'command-code',
                    sessionId,
                    requestedModel: clientModel,
                    source: 'command-code.chat.usage',
                    exact: true,
                    ...sample,
                });
                rate.complete(sample);

                res.writeHead(200, { 'Content-Type': 'application/json', ...promptPolicyHeaders(selection) });
                res.end(JSON.stringify(response));
            } finally {
                rate.end();
            }
            return;
        }

        // Streaming response
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...promptPolicyHeaders(selection),
        });

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let messageStarted = false;
        let thinkingBlockStarted = false;
        let thinkingBlockClosed = false;
        let textBlockStarted = false;
        let textBlockClosed = false;
        let currentBlockIndex = 0;
        const toolCalls = new Map();
        let promptTokens = 0;
        let completionTokens = 0;
        let msgId = 'msg_' + Date.now();
        let rawUsage = null;

        // The thinking block has to close before the text block opens, and
        // OpenAI-style providers interleave arbitrarily across models, so every
        // transition is gated here rather than assumed from event order.
        function closeThinking() {
            if (thinkingBlockStarted && !thinkingBlockClosed) {
                thinkingBlockClosed = true;
                res.write(enc('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
                currentBlockIndex++;
            }
        }
        function closeText() {
            if (textBlockStarted && !textBlockClosed) {
                textBlockClosed = true;
                res.write(enc('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
                currentBlockIndex++;
            }
        }

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (gone()) { try { await reader.cancel(); } catch (_) {} return; }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') break;
                    let parsed;
                    try { parsed = JSON.parse(raw); } catch { continue; }

                    if (parsed.id && !messageStarted) {
                        msgId = 'msg_' + parsed.id;
                    }

                    if (parsed.usage) {
                        rawUsage = parsed.usage;
                        promptTokens = parsed.usage.prompt_tokens || promptTokens;
                        completionTokens = parsed.usage.completion_tokens || completionTokens;
                    }

                    if (!messageStarted) {
                        messageStarted = true;
                        res.write(enc('message_start', {
                            type: 'message_start',
                            message: {
                                id: msgId,
                                type: 'message',
                                role: 'assistant',
                                content: [],
                                model: clientModel,
                                stop_reason: null,
                                stop_sequence: null,
                                usage: { input_tokens: promptTokens, output_tokens: 1 },
                            }
                        }));
                    }

                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.reasoning) {
                        if (!thinkingBlockStarted) {
                            thinkingBlockStarted = true;
                            res.write(enc('content_block_start', {
                                type: 'content_block_start',
                                index: currentBlockIndex,
                                content_block: { type: 'thinking', thinking: '', signature: '' },
                            }));
                        }
                        res.write(enc('content_block_delta', {
                            type: 'content_block_delta',
                            index: currentBlockIndex,
                            delta: { type: 'thinking_delta', thinking: delta.reasoning },
                        }));
                    }

                    if (delta.content) {
                        closeThinking();
                        if (!textBlockStarted) {
                            textBlockStarted = true;
                            res.write(enc('content_block_start', {
                                type: 'content_block_start',
                                index: currentBlockIndex,
                                content_block: { type: 'text', text: '' },
                            }));
                        }
                        res.write(enc('content_block_delta', {
                            type: 'content_block_delta',
                            index: currentBlockIndex,
                            delta: { type: 'text_delta', text: delta.content },
                        }));
                    }

                    if (Array.isArray(delta.tool_calls)) {
                        closeThinking();
                        closeText();

                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            let call = toolCalls.get(idx);
                            if (!call) {
                                call = {
                                    index: currentBlockIndex++,
                                    id: tc.id || `call_${Date.now()}_${idx}`,
                                    name: tc.function?.name || '',
                                    args: '',
                                };
                                toolCalls.set(idx, call);
                                res.write(enc('content_block_start', {
                                    type: 'content_block_start',
                                    index: call.index,
                                    content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
                                }));
                            }
                            if (tc.function?.name && !call.name) {
                                call.name = tc.function.name;
                            }
                            if (tc.function?.arguments) {
                                call.args += tc.function.arguments;
                                res.write(enc('content_block_delta', {
                                    type: 'content_block_delta',
                                    index: call.index,
                                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                                }));
                            }
                        }
                    }
                }
            }

            for (const call of toolCalls.values()) {
                res.write(enc('content_block_stop', {
                    type: 'content_block_stop',
                    index: call.index,
                }));
            }

            closeThinking();
            closeText();

            const usage = anthropicUsage(rawUsage || { prompt_tokens: promptTokens, completion_tokens: completionTokens });
            res.write(enc('message_delta', {
                type: 'message_delta',
                delta: {
                    stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn',
                    stop_sequence: null,
                },
                usage: { output_tokens: usage.output_tokens },
            }));
            res.write(enc('message_stop', { type: 'message_stop' }));
            res.end();

            const sample = {
                responseId: msgId,
                servedModel: resolved.id,
                status: 'completed',
                usage,
                rawUsage,
            };
            kit.recordUsage({
                provider: 'command-code',
                sessionId,
                requestedModel: clientModel,
                source: 'command-code.chat.usage',
                exact: true,
                ...sample,
            });
            rate.complete(sample);
        } finally {
            rate.end();
        }
    }

    async function count(req, res, body) {
        const sessionId = req.headers['x-claude-code-session-id'] || null;
        const selection = resolvePromptPolicy(body, 'command-code', readProviderSettings(), sessionId);
        let chars = 0;
        if (typeof body.system === 'string') chars += body.system.length;
        else if (Array.isArray(body.system)) {
            for (const b of body.system) chars += (b?.text || '').length;
        }
        for (const m of body.messages || []) {
            if (typeof m.content === 'string') chars += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const b of m.content) chars += (b?.text || JSON.stringify(b || '')).length;
            }
        }
        if (Array.isArray(body.tools)) {
            chars += JSON.stringify(body.tools).length;
        }
        // Rough token estimate: 1 token ~ 3.5 chars
        const input_tokens = Math.max(1, Math.round(chars / 3.5));
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'X-Cuimod-Token-Count-Source': 'command-code.estimate',
            ...promptPolicyHeaders(selection),
        });
        res.end(JSON.stringify({ input_tokens }));
    }

    return {
        id: 'command-code',
        provider: 'command-code',
        limitKey: 'command-code',
        models: MODELS,
        claims,
        handle,
        count,
        modelIds: () => MODELS.map(m => m.id),
        limits: () => limits.read(),
        health: () => ({
            backend: BASE,
            keyOk: !!readApiKey(),
            models: MODELS.map(m => m.id),
        }),
    };
}
