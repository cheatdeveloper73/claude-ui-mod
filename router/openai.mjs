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
import { stripFastMarker } from './fast-mode.mjs';

const AUTH_FILE = process.env.CODEX_AUTH_FILE
    || path.join(os.homedir(), '.codex', 'auth.json');
const AUTH_LOCK = AUTH_FILE + '.cuimod-lock';

const RESPONSES_URL = process.env.CODEX_RESPONSES_URL
    || 'https://chatgpt.com/backend-api/codex/responses';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';

// login/src/auth/manager.rs:1708. Public by construction -- it is the client id
// of a native app doing PKCE, and it is in the published source.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const ORIGINATOR = 'codex_cli_rs';

// The client version is part of the catalogue contract, not cosmetic metadata.
// The backend omitted gpt-6-sol and gpt-6-luna for 0.153.4 and returned both for
// 0.155.0 on 2026-09-22; gpt-6.1-sol first appears at 0.159.0 (absent at 0.158.0)
// on 2026-09-29, with every older entry byte-identical across the three versions.
// Context management fetches that same versioned list, so the shared user agent
// must move with the newest verified catalogue contract. CODEX_USER_AGENT still
// overrides it.
const USER_AGENT = process.env.CODEX_USER_AGENT || 'codex_cli_rs/0.159.0 (Windows 10.0.19045; x86_64)';

// ------------------------------------------------------------- models ----

// The listed frontier slugs, with the reasoning tiers each one actually
// accepts. GPT-6 Sol and Luna were read from the live versioned catalogue on
// 2026-09-22 with client 0.155.0, GPT-6.1 Sol on 2026-09-29 with 0.159.0; the older entries came from the earlier cache
// captures recorded below. The tier lists are NOT uniform, and offering `max`
// on 5.5 or 5.4 -- which stop at xhigh -- would offer a tier the backend rejects.
// An unlisted slug still routes, but only at the four tiers every model has, so a
// model that accepts `max` has to be named here to be offered it.
//
// GPT-6.1 Sol, GPT-6 Sol and Luna's official model pages specify a 1.05M context window and
// 128k maximum output. The subscription catalogue reports the same 272k client
// window, 872k maximum and cache profile for all three GPT-6 entries and the 5.6
// series. Astra's 1.05M value remains inferred from that shared profile, which is
// why only Astra carries a contextNote in the picker catalogue.
//
// `ultra` is excluded deliberately. The catalogue lists it for GPT-6 Astra and
// Sol and for 5.6 Sol and Terra, but it is the multi-agent workflow tier, not a
// reasoning depth -- the same thing Claude Code spells `ultracode`. Only real
// reasoning efforts belong in a reasoning field.
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
    { id: 'gpt-6.1-sol',   name: 'GPT-6.1-Sol',   efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low',    context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-6-astra',   name: 'GPT-6-Astra',   efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-6-sol',     name: 'GPT-6-Sol',     efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
    { id: 'gpt-6-luna',    name: 'GPT-6-Luna',    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', context: 1050000, maxOutput: OUTPUT_LIMIT },
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withAuthLock(fn)
{
    let handle = null;
    for (let i = 0; i < 200; i++)
    {
        try
        {
            handle = fs.openSync(AUTH_LOCK, 'wx');
            break;
        }
        catch (err)
        {
            if (err?.code !== 'EEXIST') throw err;
            try
            {
                if (Date.now() - fs.statSync(AUTH_LOCK).mtimeMs > 300000) fs.unlinkSync(AUTH_LOCK);
            }
            catch (_) {}
            await wait(50);
        }
    }
    if (!handle) throw new Error('OpenAI credentials are busy; try again');
    try { return await fn(); }
    finally
    {
        try { fs.closeSync(handle); } catch (_) {}
        try { fs.unlinkSync(AUTH_LOCK); } catch (_) {}
    }
}

// The refresh token is ROTATED: the response carries a new one and the old is
// spent. Writing it back is not optional bookkeeping -- a refresh performed and
// dropped invalidates the copy the codex CLI holds, and the next `codex` run
// fails to sign in. The account picker takes the same lock before replacing the
// file, so a refresh can finish on the old account or the switch can win first;
// neither operation can overwrite the other's credentials.
async function refreshAuth(log)
{
    return withAuthLock(async () => {
        const { file, tokens } = readAuth();
        const exp = jwtExpiry(tokens.access_token);
        if (exp && Date.now() <= exp - 300000) return tokens;
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

        const tmp = AUTH_FILE + `.bridge-tmp-${process.pid}`;
        try
        {
            fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
            fs.renameSync(tmp, AUTH_FILE);
        }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }

        log?.(`refreshed chatgpt oauth (rotated=${!!got.refresh_token})`);
        return next.tokens;
    });
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

const ANTHROPIC_WEB_SEARCH_TYPE = 'web_search_20250305';
const ANTHROPIC_WEB_SEARCH_NAME = 'web_search';

function isAnthropicWebSearchTool(tool)
{
    return tool?.type === ANTHROPIC_WEB_SEARCH_TYPE && tool?.name === ANTHROPIC_WEB_SEARCH_NAME;
}

function unsupportedBlockedDomainsError()
{
    const error = new Error('Anthropic web_search blocked_domains cannot be enforced by OpenAI Responses');
    error.statusCode = 400;
    return error;
}

function hasBlockedDomains(tool)
{
    const blocked = tool?.blocked_domains;
    if (Array.isArray(blocked)) return blocked.length > 0;
    return blocked !== undefined && blocked !== null && String(blocked).trim() !== '';
}

// The Responses endpoint rejects max_uses in native tool JSON; retain this
// metadata locally so the bridge cancels output that exceeds Claude's limit.
function validatedWebSearchMaxUses(tool)
{
    if (!isAnthropicWebSearchTool(tool) || tool.max_uses === undefined) return null;
    if (!Number.isInteger(tool.max_uses) || tool.max_uses < 1)
    {
        const error = new Error('Anthropic web_search max_uses must be a positive integer');
        error.statusCode = 400;
        throw error;
    }
    return tool.max_uses;
}

function approximateUserLocation(value)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const location = { type: 'approximate' };
    for (const key of ['country', 'region', 'city', 'timezone'])
    {
        if (typeof value[key] === 'string' && value[key]) location[key] = value[key];
    }
    return location;
}

function toResponsesWebSearchTool(tool)
{
    if (hasBlockedDomains(tool)) throw unsupportedBlockedDomainsError();

    const allowed = Array.isArray(tool.allowed_domains) && tool.allowed_domains.length
        ? { filters: { allowed_domains: tool.allowed_domains } }
        : {};
    const userLocation = approximateUserLocation(tool.user_location);

    return {
        type: 'web_search',
        external_web_access: true,
        ...allowed,
        ...(userLocation ? { user_location: userLocation } : {}),
    };
}

function toResponsesTool(t)
{
    return {
        type: 'function',
        name: t.name,
        description: t.description || '',
        // strict:false because Claude Code's schemas use constructs the
        // strict subset rejects (unions, absent additionalProperties), and a
        // strict violation is a hard request failure rather than a warning.
        strict: false,
        parameters: t.input_schema || { type: 'object', properties: {} },
    };
}

// Deferred tools are left out: tools[] is rendered ahead of the whole
// conversation, so a tool joining it mid-session invalidated every cached token
// after it. They are loaded in the input instead, by toResponsesInput.
function toResponsesTools(tools)
{
    if (!Array.isArray(tools) || !tools.length) return undefined;

    const out = [];
    for (const t of tools)
    {
        if (isAnthropicWebSearchTool(t))
        {
            out.push(toResponsesWebSearchTool(t));
            continue;
        }
        if (!t?.name || t.defer_loading === true) continue;
        out.push(toResponsesTool(t));
    }

    return out.length ? out : undefined;
}

function toResponsesToolChoice(tc, tools)
{
    if (!tc) return 'auto';
    if (tc.type === 'any') return 'required';
    // Responses has no forced choice for its hosted web search tool. Only an
    // Anthropic server-tool declaration makes this name special; a normal
    // function coincidentally named web_search remains a function choice.
    const hasWebSearch = Array.isArray(tools) && tools.some(isAnthropicWebSearchTool);
    if (tc.type === 'tool' && tc.name === ANTHROPIC_WEB_SEARCH_NAME && hasWebSearch) return 'auto';
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
    if (typeof content === 'string') return { text: content, images: [], references: [] };
    if (!Array.isArray(content)) return { text: content == null ? '' : JSON.stringify(content), images: [], references: [] };

    const text = [];
    const images = [];
    const references = [];

    for (const b of content)
    {
        if (b?.type === 'text') text.push(b.text);
        else if (b?.type === 'image') images.push(b);
        else if (b?.type === 'tool_reference')
        {
            text.push(`Loaded tool: ${b.tool_name}`);
            references.push(b.tool_name);
        }
        else if (b != null) text.push(typeof b === 'string' ? b : JSON.stringify(b));
    }

    return { text: text.join('\n'), images, references };
}

function imageToInput(block)
{
    const src = block?.source;
    if (src?.type === 'base64' && src.data) return { type: 'input_image', image_url: `data:${src.media_type || 'image/png'};base64,${src.data}` };
    if (src?.type === 'url' && src.url) return { type: 'input_image', image_url: src.url };
    return null;
}

// Claude Code declares a deferred tool in tools[] with defer_loading and shows
// it to the model only from the point a message loads it: a tool_reference in a
// ToolSearch result, or a tool_addition (by reference or inline definition) in a
// mid-conversation system message; tool_removal withdraws it. Responses has the
// same thing in additional_tools, whose tools become callable from where the item
// sits and which the backend renders without disturbing the cached prefix.
// A removal cannot be expressed without rewriting the earlier item, which would
// break the cache from there, so it is announced instead and a later re-add
// loads the definition again.
function toResponsesInput(messages, tools)
{
    const input = [];
    const declared = new Map((Array.isArray(tools) ? tools : []).filter(t => t?.name).map(t => [t.name, t]));
    const deferred = name => (declared.get(name)?.defer_loading === true ? declared.get(name) : null);
    const loaded = new Set();
    const loadTools = (definitions) => {
        const fresh = [];
        for (const def of definitions)
        {
            if (!def?.name || loaded.has(def.name)) continue;
            const top = declared.get(def.name);
            if (top && top.defer_loading !== true) continue;
            loaded.add(def.name);
            fresh.push(toResponsesTool(def));
        }
        if (fresh.length) input.push({ type: 'additional_tools', role: 'developer', tools: fresh });
    };

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

        // Claude Code 2.1.260 emits dynamic harness context as a system message
        // after the real user turn. Preserve its authority instead of turning it
        // into a newer user request that the model tries to answer.
        const inputRole = role === 'system' || role === 'developer' ? 'developer' : 'user';
        const parts = [];
        const trailing = [];
        // Consecutive additions share one item; any other block closes the run
        // so everything keeps its position.
        const additions = [];
        const flushParts = () => { if (parts.length) input.push({ type: 'message', role: inputRole, content: parts.splice(0) }); };
        const flushAdditions = () => { if (additions.length) loadTools(additions.splice(0)); };

        for (const b of content)
        {
            if (b?.type === 'tool_addition')
            {
                flushParts();
                const def = b.tool?.type === 'tool_definition' ? b.tool.definition : deferred(b.tool?.name);
                if (def) additions.push(def);
                continue;
            }
            flushAdditions();
            if (b?.type === 'tool_result')
            {
                flushParts();
                const { text, images, references } = flattenToolResult(b.content);
                input.push({
                    type: 'function_call_output',
                    call_id: b.tool_use_id,
                    output: b.is_error ? `ERROR: ${text || 'tool failed'}` : (text || '(no output)'),
                });
                loadTools(references.map(deferred).filter(Boolean));
                for (const img of images)
                {
                    const conv = imageToInput(img);
                    if (conv) trailing.push(conv);
                }
            }
            else if (b?.type === 'tool_removal')
            {
                const name = b.tool?.name;
                if (!name) continue;
                loaded.delete(name);
                parts.push({ type: 'input_text', text: `Tool no longer available: ${name}` });
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

        flushAdditions();
        if (trailing.length) parts.push(...trailing);
        flushParts();
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
    // A subagent's #fast launch line is an instruction to this router only.
    body = stripFastMarker(body);
    const parsed = parseOpenAIModel(body.model, body.output_config?.effort);
    const reasoningEnabled = settings.reasoningEnabled !== false;
    if (reasoningEnabled && parsed.rejectedEffort) {
        const error = new Error(`${parsed.id} does not support reasoning effort ${parsed.rejectedEffort}`);
        error.statusCode = 400;
        throw error;
    }
    const model = parsed.id;
    const effort = reasoningEnabled ? parsed.effort : 'none';

    // GPT accepts one instruction string. Strip Claude Code's provider identity
    // first, then apply the selected policy so a replacement is never filtered
    // as if it were client-generated text.
    const sourceBody = { ...body, system: stripIdentity(systemToText(body.system)).trim() };
    const policyBody = applyPromptPolicy(sourceBody, policy);
    const instructions = systemToText(policyBody.system).trim();
    const effectiveWebSearchTool = Array.isArray(policyBody.tools)
        ? policyBody.tools.find(isAnthropicWebSearchTool)
        : null;
    const webSearchMaxUses = validatedWebSearchMaxUses(effectiveWebSearchTool);
    let input = toResponsesInput(policyBody.messages, policyBody.tools);
    const restoration = typeof options.restoreCompaction === 'function'
        ? options.restoreCompaction(input)
        : null;
    if (restoration?.input) input = restoration.input;
    const key = conversationKey(instructions, input, policy);

    const req = {
        model,
        instructions,
        input,
        tool_choice: toResponsesToolChoice(body.tool_choice, policyBody.tools),
        parallel_tool_calls: true,
        reasoning: {
            effort,
            // `none` is the Responses API's native no-reasoning value. Summary
            // controls remain independent when reasoning is enabled: hiding a
            // summary must never change the selected effort tier.
            ...(reasoningEnabled && settings.reasoningSummary !== 'off' ? { summary: settings.reasoningSummary } : {}),
            // The replayed reasoning items are only worth their input tokens if
            // the model is shown them. GPT-5.6 renders earlier turns by default;
            // GPT-6's default is undocumented and older families default to
            // current_turn, which drops every reasoning item before the latest
            // user message. Naming it removes the dependence on per-model defaults.
            ...(reasoningEnabled ? { context: 'all_turns' } : {}),
        },
        store: false,
        stream: true,
        // There is no reasoning item to replay in off mode. Omitting the include
        // also prevents a future backend from returning opaque reasoning state
        // despite the explicit `none` request.
        ...(reasoningEnabled ? { include: ['reasoning.encrypted_content'] } : {}),
        prompt_cache_key: key,
        // Desktop's fast toggle reaches the CLI as a flag setting, and the CLI
        // marks a fast turn with body.speed (CLI 2.1.284). Codex's /fast is the
        // same request with service_tier priority; the models cache lists it
        // per slug as {id:"priority", name:"Fast"}. The backend rejects "fast"
        // and "flex" with 400 Unsupported service_tier, and its terminal
        // response reports "default" whether or not priority was asked for
        // (measured 2026-09-30; openai/codex#30413), so nothing reads it back.
        // options.fast, when given, is the session's own switch (fast-mode.mjs)
        // and wins over the per-turn body.speed.
        ...((options.fast ?? body.speed === 'fast') ? { service_tier: 'priority' } : {}),
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
        req, key, model, effort, restoration, webSearchMaxUses,
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

const WEB_SEARCH_PROGRESS_STATUSES = new Set(['open', 'in_progress', 'searching', 'completed']);

function webSearchCallId(item)
{
    return typeof item?.id === 'string' && item.id ? item.id : null;
}

function webSearchQuery(item)
{
    const action = item?.action;
    if (!action) return null;
    if (action.type === 'search')
    {
        if (typeof action.query === 'string' && action.query.trim()) return action.query;
        const first = Array.isArray(action.queries) ? action.queries[0] : null;
        return typeof first === 'string' && first.trim() ? first : null;
    }
    if (action.type === 'open_page' || action.type === 'find_in_page')
    {
        if (typeof action.url !== 'string' || !action.url.trim()) return null;
        const url = action.url.trim();
        const pattern = typeof action.pattern === 'string' ? action.pattern.trim() : '';
        return action.type === 'find_in_page' && pattern ? `${url} ${pattern}` : url;
    }
    return null;
}

function webSearchAddedError(item)
{
    const id = webSearchCallId(item);
    if (!id) return 'web_search_call is missing its id';
    if (!['open', 'in_progress'].includes(item.status)) return `web_search_call ${id} has invalid start status ${String(item.status)}`;
    return null;
}

function webSearchDoneError(item, expectedId)
{
    const id = webSearchCallId(item);
    if (!id) return 'web_search_call completion is missing its id';
    if (expectedId && id !== expectedId) return `web_search_call id changed from ${expectedId} to ${id}`;
    if (item.status !== 'completed') return `web_search_call ${id} ended with status ${String(item.status)}`;
    if (!webSearchQuery(item)) return `web_search_call ${id} has no search query`;
    return null;
}

function webSearchLifecycleError(event)
{
    const type = String(event?.type || '');
    if (type.endsWith('.failed') || type.endsWith('.error')) return 'web_search_call reported a failed status';
    const status = event?.status || event?.item?.status;
    if (!status || WEB_SEARCH_PROGRESS_STATUSES.has(status)) return null;
    return `web_search_call has invalid status ${String(status)}`;
}

function webSearchMaxUsesError(maxUses)
{
    return `web_search max_uses ${maxUses} exceeded`;
}

function messageTextAndCitations(item, fallbackText = '')
{
    const output = Array.isArray(item?.content)
        ? item.content.find(part => part?.type === 'output_text')
        : null;
    const text = typeof output?.text === 'string' ? output.text : fallbackText;
    const annotations = Array.isArray(output?.annotations) ? output.annotations : [];
    const citations = [];
    const seen = new Set();
    for (const annotation of annotations)
    {
        if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string' || !annotation.url) continue;
        const title = typeof annotation.title === 'string' ? annotation.title : '';
        const key = annotation.url;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ type: 'web_search_result', title, url: annotation.url });
    }
    return { text, citations };
}

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
        this.reasoningEnabled = options.reasoningEnabled !== false;
        this.showReasoningText = this.reasoningEnabled && options.showReasoningText === true;
        // A model-only call is executed by the router and never reaches Claude
        // Code, so it must not open an Anthropic block. `deferFinish` lets one
        // Anthropic message span several upstream responses while that happens.
        this.suppressCall = typeof options.suppressCall === 'function' ? options.suppressCall : null;
        this.deferFinish = options.deferFinish === true;
        this.epoch = 0;
        this.suppressed = new Map();
        this.pendingCalls = [];
        this.webSearchMaxUses = options.webSearchMaxUses ?? null;
        this.webSearchCallCount = 0;
        this.webSearchCalls = new Map();       // slot -> { id, query, done }
        this.pendingWebSearchCalls = [];
        this.bufferedWebMessages = new Map();  // slot -> { text }
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
        // The tier this router sent, in Anthropic's own usage.speed field, so
        // it lands in every transcript line. The backend's reported tier is
        // always "default" and cannot be used instead.
        this.speed = ['fast', 'standard'].includes(options.speed) ? options.speed : null;
    }

    stamp(usage)
    {
        return this.speed && usage ? { ...usage, speed: this.speed } : usage;
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
                usage: this.stamp(usage || { input_tokens: 0, output_tokens: 0 }),
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
        this.webSearchCalls.clear();
        this.pendingWebSearchCalls = [];
        this.bufferedWebMessages.clear();
        this.reasoningTextSeen.clear();
        this.reasoningTextBuffers.clear();
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

    webSearchLifecycle(event)
    {
        const statusError = webSearchLifecycleError(event);
        if (statusError)
        {
            this.fail(`openai ${statusError}`);
            return;
        }

        const outputIndex = event?.output_index ?? event?.item?.output_index;
        let call = outputIndex === undefined ? null : this.webSearchCalls.get(this.slot(outputIndex));
        const id = event?.item_id || event?.item?.id;
        if (!call && id)
        {
            call = [...this.webSearchCalls.values()].find(value => value.id === id) || null;
        }
        const status = event?.status || event?.item?.status;
        if (call && status) call.status = status;
    }

    addWebSearchCall(item)
    {
        const error = webSearchAddedError(item);
        if (error)
        {
            this.fail(`openai ${error}`);
            return null;
        }
        this.webSearchCallCount++;
        if (this.webSearchMaxUses !== null && this.webSearchCallCount > this.webSearchMaxUses)
        {
            this.fail(`openai ${webSearchMaxUsesError(this.webSearchMaxUses)}`);
            return null;
        }
        return { id: item.id, status: item.status, query: null, done: false };
    }

    emitWebSearchBlock(call, citations)
    {
        const useIndex = this.nextIndex++;
        this.hasAssistantContent = true;
        this.write(enc('content_block_start', {
            type: 'content_block_start',
            index: useIndex,
            content_block: { type: 'server_tool_use', id: call.id, name: ANTHROPIC_WEB_SEARCH_NAME, input: {} },
        }));
        this.write(enc('content_block_delta', {
            type: 'content_block_delta',
            index: useIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: call.query }) },
        }));
        this.write(enc('content_block_stop', { type: 'content_block_stop', index: useIndex }));

        const resultIndex = this.nextIndex++;
        this.write(enc('content_block_start', {
            type: 'content_block_start',
            index: resultIndex,
            content_block: { type: 'web_search_tool_result', tool_use_id: call.id, content: citations },
        }));
        this.write(enc('content_block_stop', { type: 'content_block_stop', index: resultIndex }));
    }

    emitWebSearchMessage(item, fallbackText)
    {
        const calls = this.pendingWebSearchCalls;
        if (!calls.length) return false;
        const incomplete = calls.find(call => !call.done || !call.query);
        if (incomplete)
        {
            this.fail(`openai web_search_call ${incomplete.id} completed without a valid search result`);
            return true;
        }

        const { text, citations } = messageTextAndCitations(item, fallbackText);
        for (let i = 0; i < calls.length; i++)
            this.emitWebSearchBlock(calls[i], i === calls.length - 1 ? citations : []);

        const textIndex = this.nextIndex++;
        this.hasAssistantContent = true;
        this.write(enc('content_block_start', {
            type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' },
        }));
        if (text) this.write(enc('content_block_delta', {
            type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text },
        }));
        this.write(enc('content_block_stop', { type: 'content_block_stop', index: textIndex }));
        this.pendingWebSearchCalls = [];
        this.webSearchCalls.clear();
        return true;
    }

    emitPendingWebSearchResults()
    {
        const incomplete = this.pendingWebSearchCalls.find(call => !call.done || !call.query);
        if (incomplete)
        {
            this.fail(`openai web_search_call ${incomplete.id} completed without a valid search result`);
            return false;
        }
        for (const call of this.pendingWebSearchCalls) this.emitWebSearchBlock(call, []);
        this.pendingWebSearchCalls = [];
        this.webSearchCalls.clear();
        return true;
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
        if (t.startsWith('response.web_search_call.'))
        {
            this.webSearchLifecycle(evt);
            return;
        }

        switch (t)
        {
        case 'response.created':
            this.start(anthropicUsage(evt.response?.usage, this.reasoningEnabled));
            break;

        case 'response.output_item.added':
        {
            const item = evt.item || {};
            const oi = evt.output_index ?? 0;

            if (item.type === 'reasoning')
            {
                // A native `none` request should not produce this item. Keep the
                // downstream contract strict if an upstream starts sending one
                // anyway: reasoning-off responses contain no thinking block.
                if (this.reasoningEnabled) this.open(oi, { type: 'thinking', thinking: '', signature: '' });
            }
            else if (item.type === 'web_search_call')
            {
                const call = this.addWebSearchCall(item);
                if (!call) break;
                this.webSearchCalls.set(this.slot(oi), call);
                this.pendingWebSearchCalls.push(call);
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
                if (this.pendingWebSearchCalls.length) this.bufferedWebMessages.set(this.slot(oi), { text: '' });
                else this.open(oi, { type: 'text', text: '' });
            }
            break;
        }

        case 'response.output_text.delta':
        {
            const oi = evt.output_index ?? 0;
            const buffered = this.bufferedWebMessages.get(this.slot(oi));
            if (buffered) buffered.text += evt.delta || '';
            else this.delta(oi, { type: 'text_delta', text: evt.delta || '' });
            break;
        }

        case 'response.reasoning_summary_text.delta':
            if (this.reasoningEnabled) this.delta(evt.output_index ?? 0, { type: 'thinking_delta', thinking: evt.delta || '' });
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
            if (this.reasoningEnabled && (evt.summary_index ?? 0) > 0) this.delta(evt.output_index ?? 0, { type: 'thinking_delta', thinking: '\n\n' });
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
            if (item.type === 'web_search_call')
            {
                const call = this.webSearchCalls.get(this.slot(oi));
                const error = !call
                    ? 'web_search_call completion has no matching start'
                    : webSearchDoneError(item, call.id);
                if (error)
                {
                    this.fail(`openai ${error}`);
                    break;
                }
                call.query = webSearchQuery(item);
                call.done = true;
                call.status = item.status;
                break;
            }
            if (item.type === 'reasoning' && this.reasoningEnabled)
            {
                const parts = (item.content || []).filter(p => p.type === 'reasoning_text');
                if (this.showReasoningText && parts.length) this.reasoningTextBuffers.set(oi, parts.map(p => p.text || '').join('\n'));
                const text = this.takeReasoningText(oi);
                if (text) this.delta(oi, { type: 'thinking_delta', thinking: '[OpenAI-supplied reasoning text]\n' + text });
                this.delta(oi, { type: 'signature_delta', signature: packReasoning(item) });
            }

            const buffered = this.bufferedWebMessages.get(this.slot(oi));
            if (item.type === 'message' && buffered)
            {
                this.bufferedWebMessages.delete(this.slot(oi));
                this.emitWebSearchMessage(item, buffered.text);
                break;
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
            // Claude Code treats terminal input usage as the current context
            // snapshot. Hidden model-only rounds are accounted separately by the
            // router; summing them here makes one prompt look N times larger.
            this.usage = anthropicUsage(r.usage, this.reasoningEnabled);
            if (r.incomplete_details?.reason === 'max_output_tokens') this.stopReason = 'max_tokens';
            else this.stopReason = this.sawToolCall ? 'tool_use' : 'end_turn';
            if (this.pendingWebSearchCalls.length || this.bufferedWebMessages.size)
            {
                // A search may share a response with an ordinary function call.
                // There is no assistant message to carry citations in that case,
                // but the completed search still belongs in the tool-use turn.
                if (this.sawToolCall && !this.bufferedWebMessages.size && this.pendingWebSearchCalls.length)
                {
                    if (!this.emitPendingWebSearchResults()) break;
                }
                else
                {
                    this.fail('openai web_search_call completed without an assistant message');
                    break;
                }
            }
            if (this.deferFinish && this.pendingCalls.length) break;
            this.finish();
            break;
        }

        case 'response.failed':
        {
            const failure = responseFailure(evt.response?.error, 'upstream response failed');
            if (failure.stopDetails)
                this.refuse(failure.stopDetails, anthropicUsage(evt.response?.usage, this.reasoningEnabled));
            else
                this.fail(failure.message, failure.errorType);
            break;
        }

        case 'error':
        {
            const failure = responseFailure({ ...evt.error, message: evt.message || evt.error?.message }, 'upstream error');
            if (failure.stopDetails) this.refuse(failure.stopDetails);
            else this.fail(failure.message, failure.errorType);
            break;
        }

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
            usage: this.stamp(this.usage),
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

    // Claude Code recognizes a safeguard refusal from the terminal message shape,
    // then owns the native cyber notice and any configured model fallback.
    refuse(stopDetails, usage)
    {
        if (this.closed) return;
        this.terminal = true;
        this.closed = true;
        this.stopReason = 'refusal';
        if (usage) this.usage = usage;
        this.start();
        for (const oi of [...this.blocks.keys()]) this.close(oi);
        this.write(enc('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: stopDetails },
            usage: this.stamp(this.usage),
        }));
        this.write(enc('message_stop', { type: 'message_stop' }));
    }

    // Other provider-declared failures remain in-band typed errors. Transport
    // errors use recoverTransport() or a broken downstream socket so the client
    // can make its own safe retry decision from the content it actually received.
    fail(message, errorType = 'api_error')
    {
        if (this.closed) return;
        this.failureMessage = message;
        this.closed = true;
        for (const oi of [...this.blocks.keys()]) this.close(oi);
        this.write(enc('error', { type: 'error', error: { type: errorType, message } }));
    }
}

function openAIRawUsage(u, reasoningEnabled = true)
{
    if (reasoningEnabled) return u || {};
    const details = { ...(u?.output_tokens_details || {}), reasoning_tokens: 0 };
    if (Object.hasOwn(details, 'thinking_tokens')) details.thinking_tokens = 0;
    return {
        ...(u || {}),
        ...(Object.hasOwn(u || {}, 'thoughtsTokenCount') ? { thoughtsTokenCount: 0 } : {}),
        output_tokens_details: details,
    };
}

function anthropicUsage(u, reasoningEnabled = true)
{
    const raw = openAIRawUsage(u, reasoningEnabled);
    const cached = raw?.input_tokens_details?.cached_tokens || 0;
    const usage = {
        input_tokens: Math.max(0, (raw?.input_tokens || 0) - cached),
        output_tokens: raw?.output_tokens || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
    };
    const reasoning = raw?.output_tokens_details?.reasoning_tokens;
    // Off mode is the one case where zero is known even if the provider omits
    // detail. On mode remains provider-reported only; absence stays unknown.
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

function responseFailure(error, fallback)
{
    const message = error?.message || fallback;
    const code = String(error?.code || error?.type || '').toLowerCase();
    if (/flagged for possible cybersecurity risk/i.test(message))
        return { message, stopDetails: { type: 'refusal', category: 'cyber', explanation: message } };
    if (code === 'rate_limit_exceeded' || code === 'rate_limit_error')
        return { message, statusCode: 429, errorType: 'rate_limit_error' };
    if (code === 'invalid_prompt' || code === 'invalid_request_error')
        return { message, statusCode: 400, errorType: 'invalid_request_error' };
    return { message, statusCode: 502, errorType: 'api_error' };
}

function upstreamFailure(message, failure = {})
{
    const error = new Error(message);
    error.statusCode = failure.statusCode || 502;
    error.errorType = failure.errorType || 'api_error';
    return error;
}

// The non-streaming shape, assembled from the same event stream. Claude Code
// streams every turn, so this exists for callers that do not -- and for the
// selftest, which asserts on a whole message rather than on a byte sequence.
export function collectAnthropicMessage(model, events, options = {})
{
    const content = [];
    const byIndex = new Map();
    const webSearchMaxUses = options.webSearchMaxUses ?? null;
    let webSearchCallCount = 0;
    const webSearchCalls = new Map();
    const pendingWebSearchCalls = [];
    const bufferedWebMessages = new Map();
    let stopReason = 'end_turn';
    let stopDetails = null;
    let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let sawTool = false;
    let terminal = false;
    let failure = null;
    const reasoningEnabled = options.reasoningEnabled !== false;
    const reasoningText = new Map();
    const addFailure = message => { failure ||= responseFailure({ message: `openai ${message}` }); };
    const emitWebSearchMessage = (item, fallbackText) => {
        const incomplete = pendingWebSearchCalls.find(call => !call.done || !call.query);
        if (incomplete)
        {
            addFailure(`web_search_call ${incomplete.id} completed without a valid search result`);
            return;
        }
        const { text, citations } = messageTextAndCitations(item, fallbackText);
        for (let i = 0; i < pendingWebSearchCalls.length; i++)
        {
            const call = pendingWebSearchCalls[i];
            content.push({ type: 'server_tool_use', id: call.id, name: ANTHROPIC_WEB_SEARCH_NAME, input: { query: call.query } });
            content.push({ type: 'web_search_tool_result', tool_use_id: call.id,
                content: i === pendingWebSearchCalls.length - 1 ? citations : [] });
        }
        content.push({ type: 'text', text });
        pendingWebSearchCalls.length = 0;
        webSearchCalls.clear();
    };
    const emitPendingWebSearchResults = () => {
        const incomplete = pendingWebSearchCalls.find(call => !call.done || !call.query);
        if (incomplete)
        {
            addFailure(`web_search_call ${incomplete.id} completed without a valid search result`);
            return false;
        }
        for (const call of pendingWebSearchCalls)
        {
            content.push({ type: 'server_tool_use', id: call.id, name: ANTHROPIC_WEB_SEARCH_NAME, input: { query: call.query } });
            content.push({ type: 'web_search_tool_result', tool_use_id: call.id, content: [] });
        }
        pendingWebSearchCalls.length = 0;
        webSearchCalls.clear();
        return true;
    };

    for (const evt of events)
    {
        if (terminal || failure) break;
        const oi = evt.output_index ?? 0;

        if (String(evt.type || '').startsWith('response.web_search_call.'))
        {
            const lifecycleError = webSearchLifecycleError(evt);
            if (lifecycleError)
            {
                addFailure(lifecycleError);
                break;
            }
            const status = evt.status || evt.item?.status;
            const id = evt.item_id || evt.item?.id;
            let call = webSearchCalls.get(oi);
            if (!call && id) call = [...webSearchCalls.values()].find(value => value.id === id) || null;
            if (call && status) call.status = status;
            continue;
        }

        switch (evt.type)
        {
        case 'response.output_item.added':
        {
            const item = evt.item || {};
            if (item.type === 'reasoning' && reasoningEnabled) byIndex.set(oi, { type: 'thinking', thinking: '', signature: '' });
            else if (item.type === 'web_search_call')
            {
                const error = webSearchAddedError(item);
                if (error)
                {
                    addFailure(error);
                    break;
                }
                webSearchCallCount++;
                if (webSearchMaxUses !== null && webSearchCallCount > webSearchMaxUses)
                {
                    addFailure(webSearchMaxUsesError(webSearchMaxUses));
                    break;
                }
                const call = { id: item.id, status: item.status, query: null, done: false };
                webSearchCalls.set(oi, call);
                pendingWebSearchCalls.push(call);
            }
            else if (item.type === 'message')
            {
                if (pendingWebSearchCalls.length) bufferedWebMessages.set(oi, { type: 'text', text: '' });
                else byIndex.set(oi, { type: 'text', text: '' });
            }
            else if (item.type === 'function_call')
            {
                sawTool = true;
                byIndex.set(oi, { type: 'tool_use', id: item.call_id || item.id, name: item.name || '', _args: '' });
            }
            break;
        }

        case 'response.output_text.delta':
        {
            const buffered = bufferedWebMessages.get(oi);
            if (buffered) buffered.text += evt.delta || '';
            else if (byIndex.has(oi)) byIndex.get(oi).text += evt.delta || '';
            break;
        }

        case 'response.reasoning_summary_text.delta':
            if (reasoningEnabled && byIndex.has(oi)) byIndex.get(oi).thinking += evt.delta || '';
            break;

        case 'response.reasoning_text.delta':
            if (reasoningEnabled && options.showReasoningText) reasoningText.set(oi, (reasoningText.get(oi) || '') + (evt.delta || ''));
            break;

        case 'response.reasoning_text.done':
            if (reasoningEnabled && options.showReasoningText && !reasoningText.has(oi)) reasoningText.set(oi, evt.text || '');
            break;

        case 'response.function_call_arguments.delta':
            if (byIndex.has(oi)) byIndex.get(oi)._args += evt.delta || '';
            break;

        case 'response.output_item.done':
        {
            const item = evt.item || {};
            if (item.type === 'web_search_call')
            {
                const call = webSearchCalls.get(oi);
                const error = !call
                    ? 'web_search_call completion has no matching start'
                    : webSearchDoneError(item, call.id);
                if (error)
                {
                    addFailure(error);
                    break;
                }
                call.query = webSearchQuery(item);
                call.done = true;
                call.status = item.status;
                break;
            }

            const buffered = bufferedWebMessages.get(oi);
            if (item.type === 'message' && buffered)
            {
                bufferedWebMessages.delete(oi);
                emitWebSearchMessage(item, buffered.text);
                break;
            }

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
            if (pendingWebSearchCalls.length || bufferedWebMessages.size)
            {
                if (sawTool && !bufferedWebMessages.size && pendingWebSearchCalls.length)
                {
                    if (!emitPendingWebSearchResults()) break;
                }
                else
                {
                    addFailure('web_search_call completed without an assistant message');
                    break;
                }
            }
            terminal = true;
            usage = anthropicUsage(evt.response?.usage, reasoningEnabled);
            stopReason = evt.response?.incomplete_details?.reason === 'max_output_tokens'
                ? 'max_tokens'
                : (sawTool ? 'tool_use' : 'end_turn');
            break;

        case 'response.failed':
        {
            const result = responseFailure(evt.response?.error, 'upstream response failed');
            if (result.stopDetails)
            {
                terminal = true;
                stopReason = 'refusal';
                stopDetails = result.stopDetails;
                usage = anthropicUsage(evt.response?.usage, reasoningEnabled);
            }
            else failure = result;
            break;
        }

        case 'error':
        {
            const result = responseFailure({ ...evt.error, message: evt.message || evt.error?.message }, 'upstream error');
            if (result.stopDetails)
            {
                terminal = true;
                stopReason = 'refusal';
                stopDetails = result.stopDetails;
            }
            else failure = result;
            break;
        }

        default:
            break;
        }
    }

    if (failure) throw upstreamFailure(`openai stream failed: ${failure.message}`, failure);
    if (!terminal) throw upstreamFailure('openai stream ended before a terminal response event');
    const hasContent = content.some(block => block.type === 'tool_use'
        || block.type === 'server_tool_use'
        || block.type === 'web_search_tool_result'
        || (block.type === 'text' && block.text)
        || (block.type === 'thinking' && (block.thinking || block.signature)));
    if (!hasContent && stopReason !== 'refusal')
        throw upstreamFailure('openai stream completed without assistant content');

    return {
        id: 'msg_' + crypto.randomBytes(12).toString('hex'),
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details: stopDetails,
        usage: ['fast', 'standard'].includes(options.speed) ? { ...usage, speed: options.speed } : usage,
    };
}

// ------------------------------------------------------------ request ----

// The Codex client identity, shared by /responses and the alpha notes and
// history routes. Version is read out of the same user-agent string so the two
// can never disagree; the models list requires it as a query parameter.
export const CODEX_CLIENT_VERSION = (USER_AGENT.match(/codex_cli_rs\/([0-9][^\s(]*)/) || [, '0.0.0'])[1];

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIdentity(key, sessionId)
{
    const value = String(sessionId || '').trim();
    return SESSION_ID_RE.test(value) ? value.toLowerCase() : keyToUuid(key);
}

// Codex sends one stable session/thread id on every Responses and extension
// request. prompt_cache_key is a separate cache concern: deriving these headers
// from it let sessions with the same prefix share backend notes/history state.
export function codexIdentityHeaders(key, sessionId)
{
    const id = requestIdentity(key, sessionId);
    return { originator: ORIGINATOR, 'User-Agent': USER_AGENT, 'session-id': id, 'thread-id': id };
}

export function responsesHeaders(tokens, key, sessionId)
{
    const id = requestIdentity(key, sessionId);
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

export { RESPONSES_URL, AUTH_FILE, packReasoning, unpackReasoning, toResponsesInput, toResponsesTools, systemToText, stripIdentity, anthropicUsage, openAIRawUsage };
