// openai.mjs -- Anthropic Messages <-> OpenAI Responses, on ChatGPT OAuth.
//
// This is the arm of the bridge that makes GPT models usable as the model of a
// Claude Code session. Claude Code speaks Anthropic Messages and executes tool
// calls with its own tools; everything here is translation, so a GPT session
// keeps Read/Edit/Bash/Task and the whole harness unchanged.
//
// Credential: the ChatGPT subscription OAuth that the codex CLI already holds in
// ~/.codex/auth.json. No metered platform API key is involved, and no request
// goes through any third-party gateway -- this file talks to chatgpt.com
// directly, the same endpoint codex itself uses.
//
// Everything about the wire format below was read out of openai/codex rather
// than guessed:
//
//   url        codex-rs/codex-api/src/endpoint/responses.rs:42 ("/responses")
//              on the provider base https://chatgpt.com/backend-api/codex,
//              which the provider-url tests in endpoint/realtime_call.rs:465
//              pin down independently.
//   headers    login/src/auth/default_client.rs:335 (originator, user-agent),
//              codex-api/src/requests/headers.rs (session-id, thread-id),
//              login/src/auth/auth_tests.rs:1379 (Authorization + account id).
//   body       core/src/client.rs:927, build_responses_request().
//   refresh    login/src/auth/manager.rs:1583, and CLIENT_ID at :1708.
//
// What is deliberately NOT copied from codex: `use_responses_lite`. Every model
// in the cache sets it, and it reshapes the request substantially -- empty
// instructions, tools moved into the input array as a content-hashed
// developer-role item, parallel tool calls forced off -- behind the internal
// header at core/src/client.rs:2129. The classic Responses shape is the public
// contract and is far simpler to keep correct, so that is what goes on the wire.
// If the backend ever requires lite for these slugs it fails as a clean 400 on
// the first request rather than as silent corruption.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readProviderSettings } from './settings.mjs';
import { applyPromptPolicy, policyChangesCachePrefix } from './prompt-policy.mjs';

const AUTH_FILE = process.env.CODEX_AUTH_FILE
    || path.join(os.homedir(), '.codex', 'auth.json');

const RESPONSES_URL = process.env.CODEX_RESPONSES_URL
    || 'https://chatgpt.com/backend-api/codex/responses';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

// login/src/auth/manager.rs:1708. Public by construction -- it is the client id
// of a native app doing PKCE, and it is in the published source.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const ORIGINATOR = 'codex_cli_rs';

// Tracks the Codex build installed on this machine, because the version is not
// cosmetic: it is sent as `client_version` on the models list, and the backend
// answers a different catalogue for different versions. At 0.151.0 the list came
// back with eight models and no gpt-6-astra, so the context-management arm found
// no entry for astra and silently fell back to the local table's window instead
// of the model's own ceiling. 0.153.4 returns nine. Measured 2026-09-05, and it
// is also the version the compaction protocol in this router was verified
// against. CODEX_USER_AGENT still overrides.
const USER_AGENT = process.env.CODEX_USER_AGENT || 'codex_cli_rs/0.153.4 (Windows 10.0.19045; x86_64)';

// ------------------------------------------------------------- models ----

// The listed frontier slugs, with the reasoning tiers each one actually
// accepts. Read from ~/.codex/models_cache.json (gpt-6-astra added from the
// 2026-09-04 fetch, client 0.153.1; the rest 2026-08-29, client 0.151.0): the
// tier lists are NOT uniform, and offering `max` on 5.5 or 5.4 -- which stop at
// xhigh -- would be offering a tier the backend rejects. An unlisted slug still
// routes, but only at the four tiers every model has, so a model that accepts
// `max` has to be named here to be offered it.
//
// astra's cache entry is the 5.6 profile exactly -- 272k client window, 872k
// maximum, the same six reasoning levels -- so it takes the same 1.05M raw
// window for the same reason. That number is inference from a shared profile,
// not a measurement, which is what the catalogue's contextNote says.
//
// `ultra` is excluded deliberately. The cache lists it under
// supported_reasoning_levels for sol and terra, but it is the multi-agent
// workflow tier, not a reasoning depth -- the same thing Claude Code spells
// `ultracode`. Only real reasoning efforts belong in a reasoning field.
// Context and output are the MODEL's limits, not the codex CLI's.
//
// This matters because the two disagree badly and the cache reports the CLI's
// numbers. The codex client caps 5.6 at 272k (Sol) / 872k (Terra, Luna) and 5.5
// at 400k, and those are its own client-side compaction budgets -- openai/codex
// issues #39144 and #19319 are users noticing exactly that gap. The raw models
// are 1.05M for the 5.6 series and 1M for 5.5 and 5.4, with 128k output across
// all of them.
//
// This bridge does not run inside the codex CLI. It posts straight to
// chatgpt.com/backend-api/codex, so the client cap never applies and the real
// ceiling is the model's own window.
//
// One consequence worth knowing rather than discovering: OpenAI bills a ChatGPT
// session at 2x input and 1.5x output once a prompt crosses 272k input tokens.
// Long context is available, and past that line it is not free.
const OUTPUT_LIMIT = 128000;

export const OPENAI_MODELS = [
    { id: 'gpt-6-astra',   name: 'GPT-6-Astra',   efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-5.6-sol',   name: 'GPT-5.6-Sol',   efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low',    context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-5.6-luna',  name: 'GPT-5.6-Luna',  efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-5.5',       name: 'GPT-5.5',       efforts: ['low', 'medium', 'high', 'xhigh'],        defaultEffort: 'medium', context: 1000000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-5.4',       name: 'GPT-5.4',       efforts: ['low', 'medium', 'high', 'xhigh'],        defaultEffort: 'medium', context: 1000000, maxOutput: OUTPUT_LIMIT },
];

const MODEL_BY_ID = new Map(OPENAI_MODELS.map((m) => [m.id, m]));

// Native Desktop effort arrives in output_config.effort, including xhigh/max
// (verified against CLI 2.1.222). Explicit :tier agent aliases still override it.
export const isOpenAI = (m) => typeof m === 'string' && /^(claude-)?gpt-/i.test(m);

// `[1m]` is a Claude Code context-window tag, not part of any model name, and it
// has to come off before the provider sees the id. See q5p() in claude.exe: the
// very first check is `/\[1m\]/i.test(model)`, returning a 1e6 window
// unconditionally. It is the only way to state a context window per MODEL rather
// than per process -- CLAUDE_CODE_MAX_CONTEXT_TOKENS is one value for the whole
// CLI, and is skipped outright for a `claude-` prefixed id.
const stripTags = (m) => String(m).replace(/^claude-/i, '').replace(/\[1m\]/ig, '');

export function parseOpenAIModel(raw, requestedEffort = null)
{
    const bare = stripTags(raw);
    const at = bare.lastIndexOf(':');
    const id = at === -1 ? bare : bare.slice(0, at);
    const asked = at === -1 ? requestedEffort : bare.slice(at + 1).toLowerCase();
    const info = MODEL_BY_ID.get(id);

    // An unknown slug still routes -- the model list is a convenience, not a
    // gate, and a slug added upstream should work without editing this file.
    const efforts = info ? info.efforts : ['low', 'medium', 'high', 'xhigh'];
    const fallback = info ? info.defaultEffort : 'medium';
    const effort = asked && efforts.includes(asked) ? asked : fallback;

    return { id, effort, known: !!info, rejectedEffort: asked && !efforts.includes(asked) ? asked : null };
}

// --------------------------------------------------------------- auth ----

function readAuth()
{
    const raw = fs.readFileSync(AUTH_FILE, 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(raw);
    const t = j?.tokens;
    if (!t?.access_token) throw new Error(`no tokens.access_token in ${AUTH_FILE}`);
    return { file: j, tokens: t };
}

function jwtExpiry(token)
{
    try
    {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
        return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
    }
    catch { return 0; }
}

// The refresh token is ROTATED: the response carries a new one and the old is
// spent. Writing it back is not optional bookkeeping -- a refresh performed and
// dropped invalidates the copy the codex CLI holds, and the next `codex` run
// fails to sign in. Write via tmp+rename so a crash mid-write cannot leave a
// truncated auth.json either.
async function refreshAuth(log)
{
    const { file, tokens } = readAuth();
    if (!tokens.refresh_token) throw new Error('no refresh_token to refresh with');

    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
        }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`token refresh ${res.status}: ${text.slice(0, 300)}`);

    let got;
    try { got = JSON.parse(text); }
    catch { throw new Error('token refresh returned non-JSON'); }

    const next = { ...file, tokens: { ...tokens } };
    if (got.access_token)  next.tokens.access_token  = got.access_token;
    if (got.refresh_token) next.tokens.refresh_token = got.refresh_token;
    if (got.id_token)      next.tokens.id_token      = got.id_token;
    next.last_refresh = new Date().toISOString();

    const tmp = AUTH_FILE + '.bridge-tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, AUTH_FILE);

    log?.(`refreshed chatgpt oauth (rotated=${!!got.refresh_token})`);
    return next.tokens;
}

// Read from disk per request rather than caching in memory: the codex CLI
// refreshes this same file, and re-reading is how the bridge inherits its
// refreshes instead of racing them.
let refreshInFlight = null;

export async function chatgptAuth(log)
{
    let { tokens } = readAuth();

    const exp = jwtExpiry(tokens.access_token);
    if (exp && Date.now() > exp - 300000)
    {
        // Collapse concurrent turns onto one refresh. Two parallel refreshes
        // would each spend the rotating token, and the loser's write would
        // persist a refresh_token the server has already retired.
        refreshInFlight ||= refreshAuth(log).finally(() => { refreshInFlight = null; });
        tokens = await refreshInFlight;
    }

    if (!tokens.account_id) throw new Error('no tokens.account_id in auth.json; run `codex login`');
    return tokens;
}

// ------------------------------------------- anthropic -> responses ------

function systemToText(system)
{
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
    return '';
}

// Two blocks Claude Code prepends to announce itself to Anthropic. The billing
// header is an HTTP header that ends up in the prompt by accident and means
// nothing to any model; the identity line asserts the assistant is Claude, which
// is simply false on this lane and worth removing before a GPT model has to
// reconcile it with its own system prompt.
const CLIENT_IDENTITY = [
    /^\s*x-anthropic-billing-header\s*:/i,
    /^\s*You are a Claude agent, built on Anthropic's Claude Agent SDK\.?\s*$/i,
];

function stripIdentity(text)
{
    return String(text)
        .split('\n')
        .filter((line) => !CLIENT_IDENTITY.some((re) => re.test(line)))
        .join('\n');
}

// Reasoning has to survive the round trip or a multi-turn agent loses its train
// of thought between every tool call.
//
// The Responses API returns an encrypted reasoning item meant to be handed
// straight back on the next request. There is nowhere in Anthropic Messages to
// put such a thing -- except a `thinking` block's `signature`, which Claude Code
// already stores and replays verbatim as part of the assistant turn. So the item
// id and its encrypted payload ride in the signature and the visible text stays
// the human-readable summary.
//
// The consequence worth stating: the bridge holds no per-conversation state.
// Parallel sessions and retries cannot corrupt each other, and a restarted
// bridge resumes a conversation mid-flight with nothing lost.
const SIG_PREFIX = 'oai1:';

function packReasoning(item)
{
    return SIG_PREFIX + Buffer.from(JSON.stringify({
        id: item?.id || null,
        ec: item?.encrypted_content || null,
    }), 'utf8').toString('base64');
}

function unpackReasoning(signature)
{
    if (typeof signature !== 'string' || !signature.startsWith(SIG_PREFIX)) return null;
    try { return JSON.parse(Buffer.from(signature.slice(SIG_PREFIX.length), 'base64').toString('utf8')); }
    catch { return null; }
}

function toResponsesTools(tools)
{
    if (!Array.isArray(tools) || !tools.length) return undefined;

    const out = [];
    for (const t of tools)
    {
        if (!t?.name) continue;
        out.push({
            type: 'function',
            name: t.name,
            description: t.description || '',
            // strict:false because Claude Code's schemas use constructs the
            // strict subset rejects (unions, absent additionalProperties), and a
            // strict violation is a hard request failure rather than a warning.
            strict: false,
            parameters: t.input_schema || { type: 'object', properties: {} },
        });
    }

    return out.length ? out : undefined;
}

function toResponsesToolChoice(tc)
{
    if (!tc) return 'auto';
    if (tc.type === 'any') return 'required';
    if (tc.type === 'tool' && tc.name) return { type: 'function', name: tc.name };
    if (tc.type === 'none') return 'none';
    return 'auto';
}

// A tool_result's content is an Anthropic block array; function_call_output
// takes a plain string. Images inside a tool result have nowhere to go in that
// field, so they are hoisted out to a sibling user message the same way the
// gemini arm hoists them -- an image delivered inside a tool result is otherwise
// dropped silently and the model answers from nothing.
function flattenToolResult(content)
{
    if (typeof content === 'string') return { text: content, images: [] };
    if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images: [] };

    const text = [];
    const images = [];

    for (const b of content)
    {
        if (b?.type === 'text') text.push(b.text);
        else if (b?.type === 'image') images.push(b);
        else if (b != null) text.push(typeof b === 'string' ? b : JSON.stringify(b));
    }

    return { text: text.join('\n'), images };
}

function imageToInput(block)
{
    const src = block?.source;
    if (src?.type === 'base64' && src.data) return { type: 'input_image', image_url: `data:${src.media_type || 'image/png'};base64,${src.data}` };
    if (src?.type === 'url' && src.url) return { type: 'input_image', image_url: src.url };
    return null;
}

function toResponsesInput(messages)
{
    const input = [];

    for (const msg of messages || [])
    {
        const role = msg?.role;
        const content = Array.isArray(msg?.content)
            ? msg.content
            : [{ type: 'text', text: String(msg?.content ?? '') }];

        if (role === 'assistant')
        {
            const parts = [];

            for (const b of content)
            {
                if (b?.type === 'thinking' || b?.type === 'redacted_thinking')
                {
                    const packed = unpackReasoning(b.signature);
                    // Only a reasoning item this bridge produced can be replayed.
                    // A thinking block from some other provider carries a
                    // signature the backend would reject, so it is dropped
                    // rather than forwarded.
                    if (packed?.ec)
                    {
                        input.push({
                            type: 'reasoning',
                            ...(packed.id ? { id: packed.id } : {}),
                            summary: [],
                            encrypted_content: packed.ec,
                        });
                    }
                }
                else if (b?.type === 'text' && b.text)
                {
                    parts.push({ type: 'output_text', text: b.text });
                }
                else if (b?.type === 'tool_use')
                {
                    // Flush any prose that preceded the call so ordering holds.
                    if (parts.length) { input.push({ type: 'message', role: 'assistant', content: parts.splice(0) }); }
                    input.push({
                        type: 'function_call',
                        call_id: b.id,
                        name: b.name,
                        arguments: JSON.stringify(b.input ?? {}),
                    });
                }
            }

            if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
            continue;
        }

        // user / everything else
        const parts = [];
        const trailing = [];

        for (const b of content)
        {
            if (b?.type === 'tool_result')
            {
                if (parts.length) { input.push({ type: 'message', role: 'user', content: parts.splice(0) }); }
                const { text, images } = flattenToolResult(b.content);
                input.push({
                    type: 'function_call_output',
                    call_id: b.tool_use_id,
                    output: b.is_error ? `ERROR: ${text || 'tool failed'}` : (text || '(no output)'),
                });
                for (const img of images)
                {
                    const conv = imageToInput(img);
                    if (conv) trailing.push(conv);
                }
            }
            else if (b?.type === 'text' && b.text)
            {
                parts.push({ type: 'input_text', text: b.text });
            }
            else if (b?.type === 'image')
            {
                const conv = imageToInput(b);
                if (conv) parts.push(conv);
            }
        }

        if (trailing.length) parts.push(...trailing);
        if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
    }

    return input;
}

// A stable key across the turns of one conversation lets the backend reuse its
// prefix cache; a key that changed per request would defeat it entirely. The
// system prompt plus the first user message is stable for the life of a Claude
// Code session and differs between sessions, which is exactly the property
// wanted. Nothing secret leaves the machine -- it is a hash.
function conversationKey(instructions, input, policy)
{
    const first = input.find((i) => i?.type === 'message' && i.role === 'user');
    const h = crypto.createHash('sha256');
    h.update(instructions || '');
    h.update(JSON.stringify(first?.content || ''));

    // User wrappers are already part of the first message above. System and
    // tool edits need their own namespace so identical first turns cannot read
    // an OpenAI prefix built under a different active policy generation.
    if (policyChangesCachePrefix(policy?.profile || policy)) {
        h.update('\nprompt-policy\n');
        h.update(policy.id);
        h.update('\n');
        h.update(String(policy.generation));
    }

    return h.digest('hex').slice(0, 32);
}

// A hex digest shaped into a uuid, so session-id/thread-id are stable per
// conversation without the bridge keeping a table of them.
function keyToUuid(key)
{
    const h = key.padEnd(32, '0').slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildResponsesRequest(body, settings = readProviderSettings(), policy, options = {})
{
    const parsed = parseOpenAIModel(body.model, body.output_config?.effort);
    if (parsed.rejectedEffort) {
        const error = new Error(`${parsed.id} does not support reasoning effort ${parsed.rejectedEffort}`);
        error.statusCode = 400;
        throw error;
    }
    const { id: model, effort } = parsed;

    // GPT accepts one instruction string. Strip Claude Code's provider identity
    // first, then apply the selected policy so a replacement is never filtered
    // as if it were client-generated text.
    const sourceBody = { ...body, system: stripIdentity(systemToText(body.system)).trim() };
    const policyBody = applyPromptPolicy(sourceBody, policy);
    const instructions = systemToText(policyBody.system).trim();
    let input = toResponsesInput(policyBody.messages);
    const restoration = typeof options.restoreCompaction === 'function'
        ? options.restoreCompaction(input)
        : null;
    if (restoration?.input) input = restoration.input;
    const key = conversationKey(instructions, input, policy);

    const req = {
        model,
        instructions,
        input,
        tool_choice: toResponsesToolChoice(body.tool_choice),
        parallel_tool_calls: true,
        reasoning: {
            effort,
            // Without a summary the turn renders as a silent gap next to a
            // Claude one -- the model reasons, and none of it is visible. The
            // encrypted item comes back either way; `auto` additionally asks for
            // the human-readable half.
            ...(settings.reasoningSummary === 'off' ? {} : { summary: settings.reasoningSummary }),
        },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: key,
    };

    const tools = toResponsesTools(policyBody.tools);
    if (tools) req.tools = tools;

    // No output ceiling is sent at all, and that is deliberate.
    //
    // This endpoint does not take one. ResponsesApiRequest in
    // codex-api/src/common.rs:275 has no max_output_tokens field, so the codex
    // client never sends it and the backend has no reason to accept it.
    //
    // Anthropic's max_tokens cannot be forwarded either, even where a ceiling is
    // accepted: it counts visible output only, while an output cap on this side
    // also has to cover reasoning, and on the high tiers reasoning is most of the
    // spend. Claude Code sends 32000 by default, which would be swallowed by
    // reasoning and truncate the answer -- the failure already measured on the
    // gemini lane, where a tight budget returned an empty content array and still
    // reported end_turn.
    //
    // So the model stops when it is finished, which is what the caps below are
    // for: OUTPUT_LIMIT is documentation of what each model can emit, not a
    // parameter.

    return {
        req, key, model, effort, restoration,
        promptSurface: {
            system: sourceBody.system ?? null,
            tools: Array.isArray(sourceBody.tools) ? sourceBody.tools : [],
            effectiveSystem: policyBody.system ?? null,
            effectiveTools: Array.isArray(policyBody.tools) ? policyBody.tools : [],
        },
    };
}

// ------------------------------------------- responses -> anthropic ------

const enc = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
export const anthropicPing = () => enc('ping', { type: 'ping' });

// Maps the Responses event stream onto the Anthropic one.
//
// The shapes do not correspond one to one: Anthropic indexes content blocks and
// requires start/delta/stop around each, while Responses emits item lifecycle
// events keyed by output_index. So this keeps its own block counter and opens an
// Anthropic block whenever an item that has an Anthropic equivalent starts.
export class ResponsesToAnthropic
{
    constructor(model, write, options = {})
    {
        this.model = model;
        this.write = write;
        this.showReasoningText = options.showReasoningText === true;
        // A model-only call is executed by the router and never reaches Claude
        // Code, so it must not open an Anthropic block. `deferFinish` lets one
        // Anthropic message span several upstream responses while that happens.
        this.suppressCall = typeof options.suppressCall === 'function' ? options.suppressCall : null;
        this.deferFinish = options.deferFinish === true;
        this.epoch = 0;
        this.suppressed = new Map();
        this.pendingCalls = [];
        this.reasoningTextSeen = new Set();
        this.reasoningTextBuffers = new Map();
        this.nextIndex = 0;
        this.blocks = new Map();   // output_index -> { index, type }
        this.started = false;
        this.stopReason = 'end_turn';
        this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        this.sawToolCall = false;
        this.completedToolCalls = 0;
        this.hasAssistantContent = false;
        this.terminal = false;
        this.failureMessage = null;
        this.closed = false;
        this.messageId = 'msg_' + crypto.randomBytes(12).toString('hex');
    }

    start(usage)
    {
        if (this.started) return;
        this.started = true;
        this.write(enc('message_start', {
            type: 'message_start',
            message: {
                id: this.messageId,
                type: 'message',
                role: 'assistant',
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: usage || { input_tokens: 0, output_tokens: 0 },
            },
        }));
    }

    // Output indices restart at zero on every upstream response, so they are
    // only unique within one. Anthropic block indices must stay unique for the
    // whole message, which is what `nextIndex` and the epoch key preserve.
    slot(outputIndex)
    {
        return `${this.epoch}:${outputIndex}`;
    }

    // Begins the next upstream response of the same Anthropic message.
    nextResponse()
    {
        for (const key of [...this.blocks.keys()]) this.blocks.delete(key);
        this.suppressed.clear();
        this.pendingCalls = [];
        this.epoch++;
        this.terminal = false;
    }

    takePendingCalls()
    {
        const calls = this.pendingCalls;
        this.pendingCalls = [];
        return calls;
    }

    open(outputIndex, block)
    {
        this.start();
        const index = this.nextIndex++;
        this.blocks.set(this.slot(outputIndex), { index, type: block.type });
        if (block.type === 'tool_use') this.hasAssistantContent = true;
        this.write(enc('content_block_start', { type: 'content_block_start', index, content_block: block }));
        return index;
    }

    delta(outputIndex, delta)
    {
        const b = this.blocks.get(this.slot(outputIndex));
        if (!b) return;
        if (Object.entries(delta).some(([key, value]) => key !== 'type' && typeof value === 'string' && value.length)) this.hasAssistantContent = true;
        this.write(enc('content_block_delta', { type: 'content_block_delta', index: b.index, delta }));
    }

    close(outputIndex)
    {
        const b = this.blocks.get(this.slot(outputIndex));
        if (!b) return;
        this.blocks.delete(this.slot(outputIndex));
        this.write(enc('content_block_stop', { type: 'content_block_stop', index: b.index }));
    }

    // One Responses SSE event in, zero or more Anthropic events out.
    reasoningText(outputIndex, text)
    {
        if (!this.showReasoningText || !text) return;
        this.reasoningTextSeen.add(outputIndex);
        this.reasoningTextBuffers.set(outputIndex, (this.reasoningTextBuffers.get(outputIndex) || '') + text);
    }

    takeReasoningText(outputIndex)
    {
        const text = this.reasoningTextBuffers.get(outputIndex) || '';
        this.reasoningTextBuffers.delete(outputIndex);
        return text;
    }

    handle(evt)
    {
        const t = evt?.type;
        if (!t || this.closed) return;

        switch (t)
        {
        case 'response.created':
            this.start(anthropicUsage(evt.response?.usage));
            break;

        case 'response.output_item.added':
        {
            const item = evt.item || {};
            const oi = evt.output_index ?? 0;

            if (item.type === 'reasoning')
            {
                this.open(oi, { type: 'thinking', thinking: '', signature: '' });
            }
            else if (item.type === 'function_call')
            {
                if (this.suppressCall && this.suppressCall(item))
                {
                    this.suppressed.set(this.slot(oi), { ...item, arguments: '' });
                    break;
                }
                this.sawToolCall = true;
                this.open(oi, { type: 'tool_use', id: item.call_id || item.id, name: item.name || '', input: {} });
            }
            else if (item.type === 'message')
            {
                this.open(oi, { type: 'text', text: '' });
            }
            break;
        }

        case 'response.output_text.delta':
            this.delta(evt.output_index ?? 0, { type: 'text_delta', text: evt.delta || '' });
            break;

        case 'response.reasoning_summary_text.delta':
            this.delta(evt.output_index ?? 0, { type: 'thinking_delta', thinking: evt.delta || '' });
            break;

        // This is a separately documented provider event. Display it only if
        // it is actually supplied; encrypted_content is never decoded as text.
        case 'response.reasoning_text.delta':
            this.reasoningText(evt.output_index ?? 0, evt.delta || '');
            break;

        case 'response.reasoning_text.done':
            if (!this.reasoningTextSeen.has(evt.output_index ?? 0)) this.reasoningText(evt.output_index ?? 0, evt.text || '');
            break;

        // A summary arriving as discrete parts rather than deltas still has to
        // read as continuous prose, so parts after the first are separated.
        case 'response.reasoning_summary_part.added':
            if ((evt.summary_index ?? 0) > 0) this.delta(evt.output_index ?? 0, { type: 'thinking_delta', thinking: '\n\n' });
            break;

        case 'response.function_call_arguments.delta':
        {
            const held = this.suppressed.get(this.slot(evt.output_index ?? 0));
            if (held) { held.arguments += evt.delta || ''; break; }
            this.delta(evt.output_index ?? 0, { type: 'input_json_delta', partial_json: evt.delta || '' });
            break;
        }

        case 'response.output_item.done':
        {
            const item = evt.item || {};
            const oi = evt.output_index ?? 0;

            // The encrypted payload only exists on the completed item, so the
            // signature can only be emitted here, immediately before the block
            // closes.
            if (item.type === 'reasoning')
            {
                const parts = (item.content || []).filter(p => p.type === 'reasoning_text');
                if (this.showReasoningText && parts.length) this.reasoningTextBuffers.set(oi, parts.map(p => p.text || '').join('\n'));
                const text = this.takeReasoningText(oi);
                if (text) this.delta(oi, { type: 'thinking_delta', thinking: '[OpenAI-supplied reasoning text]\n' + text });
                this.delta(oi, { type: 'signature_delta', signature: packReasoning(item) });
            }

            const held = this.suppressed.get(this.slot(oi));
            if (held)
            {
                this.suppressed.delete(this.slot(oi));
                const sealed = item.encrypted_function_args || held.encrypted_function_args;
                this.pendingCalls.push({
                    type: 'function_call',
                    call_id: item.call_id || held.call_id,
                    name: item.name || held.name,
                    ...(item.namespace || held.namespace ? { namespace: item.namespace || held.namespace } : {}),
                    arguments: typeof item.arguments === 'string' && item.arguments ? item.arguments : (held.arguments || ''),
                    // Parameters declared `encrypted: true` arrive sealed. The
                    // item is replayed with them so the backend can still
                    // decrypt on the round that follows.
                    ...(sealed ? { encrypted_function_args: sealed } : {}),
                });
                break;
            }

            const block = this.blocks.get(this.slot(oi));
            if (item.type === 'function_call' && block?.type === 'tool_use') this.completedToolCalls++;
            this.close(oi);
            break;
        }

        case 'response.completed':
        case 'response.incomplete':
        {
            this.terminal = true;
            const r = evt.response || {};
            const usage = anthropicUsage(r.usage);
            // Every round is a separately billed upstream response, so the
            // message reports what the turn actually cost, not its last leg.
            for (const [field, value] of Object.entries(usage))
            {
                if (typeof value !== 'number') { this.usage[field] = value; continue; }
                this.usage[field] = (Number(this.usage[field]) || 0) + value;
            }
            if (r.incomplete_details?.reason === 'max_output_tokens') this.stopReason = 'max_tokens';
            else this.stopReason = this.sawToolCall ? 'tool_use' : 'end_turn';
            if (this.deferFinish && this.pendingCalls.length) break;
            this.finish();
            break;
        }

        case 'response.failed':
            this.fail(evt.response?.error?.message || 'upstream response failed');
            break;

        case 'error':
            this.fail(evt.message || evt.error?.message || 'upstream error');
            break;

        default:
            break;
        }
    }

    finish()
    {
        if (this.closed) return;
        if (!this.hasAssistantContent) { this.fail('openai stream completed without assistant content'); return; }
        this.closed = true;
        this.start();

        for (const oi of [...this.blocks.keys()]) this.close(oi);

        // OpenAI reports exact input usage only on the terminal response. The
        // initial response.created event usually carries zeros, so emitting only
        // output_tokens here leaves Claude Code's final transcript permanently
        // claiming that every GPT prompt cost no input. The Gemini gateway sends
        // the complete terminal usage shape and the client accepts it; do the
        // same here so the final record replaces the provisional zero count.
        this.write(enc('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: this.stopReason, stop_sequence: null },
            usage: this.usage,
        }));
        this.write(enc('message_stop', { type: 'message_stop' }));
    }

    // A completed tool call is already executable and Claude Code may have run it
    // while the Responses stream was still waiting for its terminal event. If the
    // transport dies there, replaying the request can run the tool twice. Finish
    // the Anthropic turn as tool_use instead; the tool result drives the next call.
    recoverTransport()
    {
        if (this.closed) return true;
        if (!this.completedToolCalls || this.blocks.size) return false;
        this.terminal = true;
        this.stopReason = 'tool_use';
        this.finish();
        return true;
    }

    // A provider-declared failure remains an in-band API error. Transport errors
    // use recoverTransport() or a broken downstream socket so the client can make
    // its own safe retry decision from the content it actually received.
    fail(message)
    {
        if (this.closed) return;
        this.failureMessage = message;
        this.closed = true;
        for (const oi of [...this.blocks.keys()]) this.close(oi);
        this.write(enc('error', { type: 'error', error: { type: 'api_error', message } }));
    }
}

function anthropicUsage(u)
{
    const cached = u?.input_tokens_details?.cached_tokens || 0;
    const usage = {
        input_tokens: Math.max(0, (u?.input_tokens || 0) - cached),
        output_tokens: u?.output_tokens || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    };
    const reasoning = u?.output_tokens_details?.reasoning_tokens;
    if (typeof reasoning === 'number') usage.output_tokens_details = { thinking_tokens: reasoning };
    return usage;
}

// Parses an SSE byte stream into events. Responses sends `event:` lines the
// data already repeats in its `type` field, so only `data:` is read.
export function sseParser(onEvent)
{
    let buf = '';

    const parseFrame = raw => {
        const data = raw
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('');

        if (!data || data === '[DONE]') return;

        let event;
        try { event = JSON.parse(data); }
        catch { throw new Error('invalid JSON in upstream OpenAI SSE frame'); }
        onEvent(event);
    };

    return function feed(chunk = '', final = false)
    {
        buf += chunk;

        for (;;)
        {
            const boundary = /\r?\n\r?\n/.exec(buf);
            if (!boundary) break;
            const raw = buf.slice(0, boundary.index);
            buf = buf.slice(boundary.index + boundary[0].length);
            parseFrame(raw);
        }

        if (final && buf.trim()) parseFrame(buf);
        if (final) buf = '';
    };
}

function upstreamFailure(message)
{
    const error = new Error(message);
    error.statusCode = 502;
    return error;
}

// The non-streaming shape, assembled from the same event stream. Claude Code
// streams every turn, so this exists for callers that do not -- and for the
// selftest, which asserts on a whole message rather than on a byte sequence.
export function collectAnthropicMessage(model, events, options = {})
{
    const content = [];
    const byIndex = new Map();
    let stopReason = 'end_turn';
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let sawTool = false;
    let terminal = false;
    let failure = null;
    const reasoningText = new Map();

    for (const evt of events)
    {
        const oi = evt.output_index ?? 0;

        switch (evt.type)
        {
        case 'response.output_item.added':
        {
            const item = evt.item || {};
            if (item.type === 'reasoning')      byIndex.set(oi, { type: 'thinking', thinking: '', signature: '' });
            else if (item.type === 'message')   byIndex.set(oi, { type: 'text', text: '' });
            else if (item.type === 'function_call')
            {
                sawTool = true;
                byIndex.set(oi, { type: 'tool_use', id: item.call_id || item.id, name: item.name || '', _args: '' });
            }
            break;
        }

        case 'response.output_text.delta':
            if (byIndex.has(oi)) byIndex.get(oi).text += evt.delta || '';
            break;

        case 'response.reasoning_summary_text.delta':
            if (byIndex.has(oi)) byIndex.get(oi).thinking += evt.delta || '';
            break;

        case 'response.reasoning_text.delta':
            if (options.showReasoningText) reasoningText.set(oi, (reasoningText.get(oi) || '') + (evt.delta || ''));
            break;

        case 'response.reasoning_text.done':
            if (options.showReasoningText && !reasoningText.has(oi)) reasoningText.set(oi, evt.text || '');
            break;

        case 'response.function_call_arguments.delta':
            if (byIndex.has(oi)) byIndex.get(oi)._args += evt.delta || '';
            break;

        case 'response.output_item.done':
        {
            const b = byIndex.get(oi);
            if (!b) break;
            if (b.type === 'thinking')
            {
                const parts = (evt.item?.content || []).filter(p => p.type === 'reasoning_text');
                const text = options.showReasoningText
                    ? (parts.length ? parts.map(p => p.text || '').join('\n') : reasoningText.get(oi))
                    : '';
                if (text) b.thinking += '[OpenAI-supplied reasoning text]\n' + text;
                b.signature = packReasoning(evt.item || {});
            }
            if (b.type === 'tool_use')
            {
                try { b.input = JSON.parse(b._args || '{}'); } catch { b.input = {}; }
                delete b._args;
            }
            content.push(b);
            byIndex.delete(oi);
            break;
        }

        case 'response.completed':
        case 'response.incomplete':
            terminal = true;
            usage = anthropicUsage(evt.response?.usage);
            stopReason = evt.response?.incomplete_details?.reason === 'max_output_tokens'
                ? 'max_tokens'
                : (sawTool ? 'tool_use' : 'end_turn');
            break;

        case 'response.failed':
            failure = evt.response?.error?.message || 'upstream response failed';
            break;

        case 'error':
            failure = evt.message || evt.error?.message || 'upstream error';
            break;

        default:
            break;
        }
    }

    if (failure) throw upstreamFailure(`openai stream failed: ${failure}`);
    if (!terminal) throw upstreamFailure('openai stream ended before a terminal response event');
    const hasContent = content.some(block => block.type === 'tool_use'
        || (block.type === 'text' && block.text)
        || (block.type === 'thinking' && (block.thinking || block.signature)));
    if (!hasContent) throw upstreamFailure('openai stream completed without assistant content');

    return {
        id: 'msg_' + crypto.randomBytes(12).toString('hex'),
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage,
    };
}

// ------------------------------------------------------------ request ----

// The Codex client identity, shared by /responses and the alpha notes and
// history routes. Version is read out of the same user-agent string so the two
// can never disagree; the models list requires it as a query parameter.
export const CODEX_CLIENT_VERSION = (USER_AGENT.match(/codex_cli_rs\/([0-9][^\s(]*)/) || [, '0.0.0'])[1];

export function codexIdentityHeaders(key)
{
    const id = keyToUuid(key);
    return { originator: ORIGINATOR, 'User-Agent': USER_AGENT, 'session-id': id, 'thread-id': id };
}

export function responsesHeaders(tokens, key)
{
    const id = keyToUuid(key);
    return {
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        originator: ORIGINATOR,
        'User-Agent': USER_AGENT,
        'session-id': id,
        'thread-id': id,
    };
}

export { RESPONSES_URL, AUTH_FILE, packReasoning, unpackReasoning, toResponsesInput, toResponsesTools, systemToText, stripIdentity, anthropicUsage };
