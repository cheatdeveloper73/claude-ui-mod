// model-router -- one endpoint, many providers, chosen per request by model.
//
// Claude Code points ANTHROPIC_BASE_URL at this server. Every request is routed
// on body.model:
//
//   gpt-*       translated to the OpenAI Responses API in ./openai.mjs and sent
//               to chatgpt.com on the ChatGPT subscription OAuth the codex CLI
//               already holds. No gateway, no metered API key.
//   catalogued  forwarded to a hot-loaded Anthropic-compatible backend named in
//               the shared provider catalogue. Credentials stay in .state. This
//               is the zero-code way to add a backend that already speaks
//               Anthropic Messages -- see docs/provider-adapters.md.
//   adapter     claimed by a provider adapter under ./adapters, for a backend
//               that needs real code. None ships by default; the registry is
//               happy with an empty directory.
//   everything  forwarded to api.anthropic.com. Preserve keeps the raw request
//   else        bytes identical; an active prompt policy rewrites the JSON body.
//
// Routing per REQUEST rather than per process is the whole point. A session's
// endpoint is fixed at spawn -- it is an environment variable -- so switching
// provider mid-conversation is impossible at the transport layer. Making the
// endpoint uniform and dispatching on the model instead turns a provider switch
// into a model switch, which the CLI accepts live over its `set_model` control
// request. That is what lets the picker change provider without restarting a
// session.
//
// The transport every arm shares -- retry policy, header filtering, the
// Anthropic SSE relay, body reshaping -- is in ./relay.mjs, so an adapter can
// use it without importing this file back.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccountingStore } from './accounting.mjs';
import { UsageAnalytics } from './analytics.mjs';
import { ProviderLimits } from './limits.mjs';
import { ResetCredits } from './reset-credits.mjs';
import { AdapterRegistry } from './adapter-registry.mjs';
import { readAutoCompactBudget, readCompactionSettings, readContextSettings, readProviderSettings } from './settings.mjs';
import { UsageLedger, normalizeUsage } from './telemetry.mjs';
import { ThroughputLedger, isSubagentRequest } from './throughput.mjs';
import { estimateOpenAIInput } from './count-tokens.mjs';
import { applyPromptPolicy, promptPolicyHeaders, resolvePromptPolicy } from './prompt-policy.mjs';
import { capturePrompt } from './prompt-capture.mjs';
import { fastTier } from './fast-mode.mjs';
import { openAIRequest } from './openai-transport.mjs';
import {
    CompactionStore,
    anthropicSummaryResponse,
    buildFallbackPayload,
    buildRemoteCompactionPayload,
    collectRemoteCompaction,
    collectResponseText,
    isClaudeCompactionRequest,
    restoreCheckpointInput,
    removeCompactionPrompt,
    retainCompactionHistory,
    stripCheckpointMarkers,
    summaryText,
} from './compaction.mjs';
import {
    DROP_REQ,
    DROP_RES,
    NO_STATUS_RETRY,
    errorBody,
    fetchResilient,
    hoistToolResultImages,
    pipeAnthropicBody,
    pipeBody,
    pipeObservedAnthropicBody,
    prepareProviderBody,
    stripClientIdentity,
} from './relay.mjs';
import {
    FALLBACK_TOKEN_BUDGET,
    MAX_THREAD_HINT_BYTES,
    ModelMessages,
    NEW_CONTEXT_TOOL,
    ROUTE_BY_CALL,
    THREAD_HINT_ROUTE,
    turnMetadata,
    WindowStore,
    applyWindowCut,
    callBackend,
    codexBase,
    contextBudgetLimits,
    contextBudgetStatus,
    contextResetSummary,
    contextTools,
    contextWindowMessage,
    driftReport,
    guidanceMessage,
    isContextCall,
    reminderMessage,
    restoreContextResetInput,
    stripConcealment,
    stripContextResetMarkers,
    tokenBudgetFor,
    toolOutputContent,
    userMessages,
    windowCutsMatch,
} from './context-management.mjs';
import { publicRouterPort, rejectRequest } from './request-guard.mjs';
import {
    compatibleHeaders,
    compatibleModelEntries,
    compatibleStatus,
    resolveCompatibleModel,
} from './compatible.mjs';

import {
    CODEX_CLIENT_VERSION,
    codexIdentityHeaders,
    AUTH_FILE,
    OPENAI_MODELS,
    RESPONSES_URL,
    anthropicPing,
    anthropicUsage,
    collectAnthropicMessage,
    ResponsesToAnthropic,
    buildResponsesRequest,
    chatgptAuth,
    isOpenAI,
    openAIRawUsage,
    parseOpenAIModel,
    responsesHeaders,
    sseParser,
} from './openai.mjs';

// `gemini-bridge` is the directory this router was first shipped under and it
// still holds every deployed accounting store, so it stays the default. Moving
// it would silently orphan the permanent usage history rather than migrate it.
// Set MODEL_ROUTER_STATE_DIR for anything new.
const HERE      = process.env.MODEL_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'gemini-bridge');
const PORT      = Number(process.env.MODEL_ROUTER_WORKER_PORT || process.env.MODEL_ROUTER_PORT || process.env.GEMINI_BRIDGE_PORT || 8789);
const ANTHROPIC = process.env.MODEL_ROUTER_UPSTREAM || process.env.GEMINI_BRIDGE_UPSTREAM || 'https://api.anthropic.com';
const USAGE_FILE = process.env.MODEL_ROUTER_USAGE_FILE || path.join(HERE, 'provider-usage-v1.jsonl');
const LIMIT_HISTORY_FILE = process.env.MODEL_ROUTER_LIMIT_HISTORY_FILE || path.join(HERE, 'provider-limit-history-v1.jsonl');
const PLAN_FILE = process.env.MODEL_ROUTER_PLAN_USAGE_FILE
    || path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'plan-usage-history.json');
const ACCOUNTING_DIR = process.env.MODEL_ROUTER_ACCOUNTING_DIR || path.join(HERE, 'provider-accounting-v2');
const THROUGHPUT_FILE = process.env.MODEL_ROUTER_THROUGHPUT_FILE || path.join(HERE, 'provider-throughput-v1.jsonl');
const usageLedger = new UsageLedger(USAGE_FILE);
const compactionStore = new CompactionStore(HERE);
const windowStore = new WindowStore(HERE);

// The notes and history routes live beside /responses on the same host and the
// same OAuth, so the base is derived rather than configured; pointing one at a
// different origin than the other could only ever be a mistake.
const CODEX_BASE = codexBase(RESPONSES_URL);
const modelMessages = new ModelMessages({ base: CODEX_BASE, clientVersion: CODEX_CLIENT_VERSION });

// AgentPath::ROOT, protocol/src/agent_path.rs:18. The notes store is namespaced
// by (session id, agent name), and the root agent is the only one this router
// runs.
const CONTEXT_AGENT = '/root';

// A turn that keeps calling model-only tools without answering is a loop, not
// work. The last round is served without the tools so the model has to reply.
const MAX_CONTEXT_ROUNDS = 8;

let contextHealth = { drift: null, lastError: null };

// Generation rate, measured per response. The constructor only reads, so a
// candidate generation that never gets accepted leaves nothing behind here
// either -- the file is created by the first completed response, not by import.
const throughput = new ThroughputLedger(THROUGHPUT_FILE);

// Permanent accounting. The constructor only computes paths, so importing this
// module for /healthz or the semantic canary cannot create or mutate the store;
// a candidate generation that is never accepted leaves no trace.
const accounting = new AccountingStore({
    root: ACCOUNTING_DIR,
    backupRoot: process.env.MODEL_ROUTER_ACCOUNTING_BACKUP_DIR || undefined,
    legacyTokenFile: USAGE_FILE,
    legacyQuotaFile: LIMIT_HISTORY_FILE,
    planFile: PLAN_FILE,
});
const usageAnalytics = new UsageAnalytics({ planFile: PLAN_FILE, historyFile: LIMIT_HISTORY_FILE, accounting });
// The in-app usage bar needs current limits, not permanent accounting. Keep its
// background refresh off the inference worker's segment/rollup write path.
const liveUsageAnalytics = new UsageAnalytics({ planFile: PLAN_FILE, historyFile: LIMIT_HISTORY_FILE, accounting: null });

const OPENAI_USAGE_URL = process.env.CODEX_USAGE_URL
    || 'https://chatgpt.com/backend-api/wham/usage';
const configuredHeartbeat = Number(process.env.CODEX_STREAM_HEARTBEAT_MS);
const OPENAI_HEARTBEAT_MS = Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat : 30000;
const configuredIdle = Number(process.env.CODEX_STREAM_IDLE_TIMEOUT_MS);
const OPENAI_STREAM_IDLE_MS = Number.isFinite(configuredIdle) && configuredIdle >= 50
    ? configuredIdle : 60000;

async function readOpenAIStream(reader)
{
    let timer;
    try
    {
        return await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`openai stream produced no event for ${OPENAI_STREAM_IDLE_MS}ms`);
                    error.code = 'OPENAI_STREAM_IDLE_TIMEOUT';
                    reject(error);
                }, OPENAI_STREAM_IDLE_MS);
                timer.unref?.();
            }),
        ]);
    }
    finally { clearTimeout(timer); }
}

const log = (s) =>
{
    const line = `${new Date().toISOString()} ${s}\n`;
    process.stdout.write(line);
    // A clean install has no state directory until the first record is written,
    // and losing every startup line to ENOENT hides exactly the failures that
    // happen at startup.
    try { fs.mkdirSync(HERE, { recursive: true }); } catch {}
    try { fs.appendFileSync(path.join(HERE, 'bridge.log'), line); } catch {}
};

function recordProviderUsage(value)
{
    let stored = false;
    try { stored = usageLedger.record(value); }
    catch (error) { log(`usage ledger write failed: ${String(error?.message || error).slice(0, 240)}`); }

    // Permanent store. Independent of the v1 ledger so a rollback to a pre-v2
    // generation keeps its own view while this one keeps the authoritative
    // history; both are deduplicated by provider response id.
    try
    {
        accounting.record('token', {
            ...value,
            tokens: normalizeUsage(value?.usage),
            rawUsage: value?.rawUsage || value?.usage,
        });
    }
    catch (error) { log(`accounting write failed: ${String(error?.message || error).slice(0, 240)}`); }
    return stored;
}

// Adapters are loaded before the server accepts anything, so a request can
// never arrive at a half-built registry. Top-level await is what buys that;
// making it lazy would mean the first request of a generation races the import.
//
// The kit is the whole surface an adapter gets from this file. Everything else
// it needs is in relay.mjs or one of the shared router modules, which it
// imports directly.
const providerAdapters = await AdapterRegistry.load({
    log,
    stateDir: HERE,
    accountingDir: ACCOUNTING_DIR,
    recordUsage: recordProviderUsage,
    throughput,
});

const providerLimits = new ProviderLimits({
    openAIUsageURL: OPENAI_USAGE_URL,
    getOpenAIAuth: () => chatgptAuth(log),
    adapters: providerAdapters,
    // Some provider accounts are paid seats. Cache regular reads so the
    // dashboard and Desktop share a snapshot without multiplying calls.
    cacheMs: 60000,
});

// A reset credit is spent on exhaustion, never on a percentage, and only when
// something outside this router asks. The journal is outside the process so a
// blue-green worker swap between two asks still knows a credit was already
// redeemed for this window.
const resetCredits = new ResetCredits({
    limits: providerLimits,
    journalFile: path.join(HERE, 'reset-credits.jsonl'),
    log,
});

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');
const DASHBOARD_ASSETS = new Map([
    ['/usage/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/usage/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/usage/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

function serveDashboard(req, res, urlPath)
{
    if (urlPath === '/usage')
    {
        res.writeHead(308, { Location: '/usage/', 'Cache-Control': 'no-store' });
        res.end();
        return true;
    }
    const asset = DASHBOARD_ASSETS.get(urlPath);
    if (!asset) return false;
    let body;
    try { body = fs.readFileSync(path.join(DASHBOARD_DIR, asset.file)); }
    catch (_) { return false; }
    const headers = {
        'Content-Type': asset.type,
        'Content-Length': body.length,
        'Cache-Control': asset.file === 'index.html' ? 'no-store' : 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
}

// Claude Code speaks a newer Anthropic Messages than any compatible provider
// implements, and a provider rejects the whole request over a single unknown
// field -- so one new field upstream costs a whole session. Fixing them one at
// a time does not converge: `cache_control.scope` uncovered
// `eager_input_streaming`, which uncovered `diagnostics`. So this is an
// allowlist. An unrecognized field is dropped rather than forwarded, and a
// field Claude Code adds next release cannot break the provider.
//
// The set was measured, not assumed -- each name below was sent to Meta alone
// on an otherwise minimal body and kept only if it was not rejected:
//
//   accepted   system tools tool_choice temperature top_p stream metadata
//              service_tier thinking output_config context_management
//   rejected   top_k stop_sequences diagnostics betas mcp_servers container
//
// top_k and stop_sequences are core Anthropic Messages fields that Meta does
// not implement. Dropping stop_sequences changes behavior if a caller sets it;
// forwarding it fails the request outright, so dropping is the lesser loss.
// Claude Code sets neither.
const REQUEST_FIELDS = new Set([
    'model', 'messages', 'max_tokens', 'system', 'tools', 'tool_choice',
    'temperature', 'top_p', 'stream', 'metadata', 'service_tier',
    'thinking', 'output_config', 'context_management',
]);

// Nested fields need their own pruning: these ride inside values the allowlist
// keeps. `cache_control` keeps its `type` rather than being dropped whole --
// verified worth it, a repeated request reads its prefix at $0.002/M against
// $0.10/M, and Meta charges no cache-write premium.
const NESTED_DROP = new Set(['eager_input_streaming']);

function pruneAnthropicExtensions(value)
{
    if (Array.isArray(value)) return value.map(pruneAnthropicExtensions);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, entry] of Object.entries(value))
    {
        if (NESTED_DROP.has(key)) continue;
        out[key] = key === 'cache_control' && entry && typeof entry === 'object' && !Array.isArray(entry)
            ? { type: entry.type }
            : pruneAnthropicExtensions(entry);
    }
    return out;
}

// input_schema is the caller's JSON Schema and belongs to the tool, not to us.
// A property legitimately named `eager_input_streaming` or `cache_control` in
// someone's schema must survive verbatim or the tool silently changes shape.
function pruneRequest(body)
{
    const out = {};
    for (const [key, value] of Object.entries(body))
    {
        if (!REQUEST_FIELDS.has(key)) continue;
        out[key] = key === 'tools' && Array.isArray(value)
            ? value.map(tool => {
                const { input_schema, ...rest } = pruneAnthropicExtensions(tool);
                return input_schema === undefined ? rest : { ...rest, input_schema: tool.input_schema };
            })
            : pruneAnthropicExtensions(value);
    }
    return out;
}

function prepareCompatibleBody(body, model, selection)
{
    let out = prepareProviderBody(stripCheckpointMarkers(stripContextResetMarkers(body)));
    out.model = model.id;
    out = applyPromptPolicy(out, selection);

    // These providers select reasoning behavior through the model variant.
    // Claude Code's effort fields belong to a different model and can survive
    // a model switch, so never let them silently change the selected variant.
    delete out.output_config;
    delete out.thinking;
    return pruneRequest(out);
}

const compatibleCounts = new Map();

async function handleCompatibleCount(req, res, body, model)
{
    const selection = resolvePromptPolicy(body, model.provider, readProviderSettings(), req.headers['x-claude-code-session-id']);
    const serialized = JSON.stringify(prepareCompatibleBody(body, model, selection));
    const key = crypto.createHash('sha256').update(model.provider + '\n' + model.route.baseUrl + '\n' + serialized).digest('hex');
    const cached = compatibleCounts.get(key);
    let count = cached?.expires > Date.now() ? cached.promise : null;

    if (!count)
    {
        count = (async () => {
            const upstream = await fetchResilient(`${model.route.baseUrl}/messages/count_tokens`, {
                method: 'POST',
                headers: compatibleHeaders(model, req.headers),
                body: serialized,
            }, `${model.provider}-count`, () => res.writableEnded || res.destroyed, NO_STATUS_RETRY, log);
            const payload = await upstream.text();
            const headers = Object.fromEntries([...upstream.headers].filter(([name]) => !DROP_RES.has(name.toLowerCase())));
            if (!upstream.ok) compatibleCounts.delete(key);
            else
            {
                const tokens = JSON.parse(payload)?.input_tokens;
                if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`${model.provider} returned an invalid native token count`);
            }
            return { status: upstream.status, headers, payload };
        })().catch(error => { compatibleCounts.delete(key); throw error; });
        compatibleCounts.set(key, { promise: count, expires: Date.now() + 300000 });
        if (compatibleCounts.size > 128) compatibleCounts.delete(compatibleCounts.keys().next().value);
    }

    const result = await count;
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(result.status, {
        ...result.headers,
        'X-Cuimod-Token-Count-Source': `${model.provider}.messages.count_tokens`,
        'X-Cuimod-Token-Count-Exact': String(result.status >= 200 && result.status < 300),
        ...promptPolicyHeaders(selection),
    });
    res.end(result.payload);
}

async function handleCompatible(req, res, body, model)
{
    const gone = () => res.writableEnded || res.destroyed;
    const clientModel = body.model;
    const selection = resolvePromptPolicy(body, model.provider, readProviderSettings(), req.headers['x-claude-code-session-id']);
    const source = prepareProviderBody(body);
    const prepared = prepareCompatibleBody(body, model, selection);
    capturePrompt({ provider: model.provider, sessionId: req.headers['x-claude-code-session-id'], model: prepared.model,
        selection, system: source.system, tools: source.tools,
        effectiveSystem: prepared.system, effectiveTools: prepared.tools });
    log(`${model.provider} ${body.model} -> ${prepared.model} stream=${!!body.stream} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} body=${JSON.stringify(prepared).length}B`);

    // This arm used to pass no usage observer at all, so a compatible provider
    // produced no exact token record and therefore no rate either. It speaks
    // Anthropic Messages natively, so its terminal usage is exact by the same
    // definition every other arm uses.
    const sessionId = req.headers['x-claude-code-session-id'] || null;
    const rate = throughput.begin({
        provider: model.provider, sessionId, requestedModel: clientModel,
        subagent: isSubagentRequest(body), streaming: !!body.stream,
    }, res);
    const recordUsage = sample => {
        recordProviderUsage({
            provider: model.provider, sessionId, requestedModel: clientModel,
            source: `${model.provider}.message.usage`, exact: true, ...sample,
        });
        rate.complete(sample);
    };

    const upstream = await fetchResilient(`${model.route.baseUrl}/messages`, {
        method: 'POST',
        headers: compatibleHeaders(model, req.headers),
        body: JSON.stringify(prepared),
    }, model.provider, gone, NO_STATUS_RETRY, log);
    rate.upstream();

    if (gone()) { rate.end(); return; }
    const headers = {};
    upstream.headers.forEach((value, name) => { if (!DROP_RES.has(name.toLowerCase())) headers[name] = value; });
    res.writeHead(upstream.status, { ...headers, ...promptPolicyHeaders(selection) });
    if (!upstream.ok)
    {
        rate.end();
        log(`${model.provider} ${upstream.status} on ${prepared.model} (passed through, not retried)`);
        await pipeBody(upstream, res);
        return;
    }
    try { await pipeAnthropicBody(upstream, res, clientModel, !!body.stream, recordUsage, event => rate.anthropic(event)); }
    finally { rate.end(); }
}

function restoreForSession(sessionId, includeSessionState = true)
{
    return input => {
        // Every root restoration path also performs the one-way migration. This
        // includes disabled settings: an old mixed-agent marker must never be
        // trusted merely because the feature was switched off before this turn.
        const state = includeSessionState && typeof sessionId === 'string'
            ? windowStore.quarantineLegacy(sessionId) : null;
        const reset = restoreContextResetInput(input, state);
        // Subagents receive the parent's transcript and therefore its marker, but
        // have no distinct transport identity. Strip the marker with a null
        // lookup rather than injecting the parent's opaque checkpoint history.
        const checkpoint = restoreCheckpointInput(reset.input,
            includeSessionState ? sessionId : null, compactionStore);
        return {
            ...checkpoint,
            resetIds: reset.resetIds,
            resetRestored: reset.restored,
            resetDegraded: reset.degraded,
        };
    };
}

// Scoped by session so identical prompts in two Claude sessions stay apart.
function conversationThread(sessionId, key)
{
    return crypto.createHash('sha256').update(`${sessionId || ''}\n${key}`).digest('hex').slice(0, 32);
}

async function bufferedResponses(payload, tokens, key, gone, label, sessionId)
{
    const upstream = await openAIRequest(RESPONSES_URL, {
        method: 'POST',
        headers: responsesHeaders(tokens, key, sessionId),
        body: JSON.stringify(payload),
    }, gone, log);
    if (!upstream.ok)
    {
        const text = await upstream.text().catch(() => '');
        const error = new Error(`${label} ${upstream.status}: ${text.slice(0, 400)}`);
        error.upstreamStatus = upstream.status;
        error.upstreamHeaders = upstream.headers;
        error.upstreamText = text;
        throw error;
    }
    const events = [];
    let terminal = false;
    const feed = sseParser(event => {
        // One terminal event owns the buffered transaction. sseParser can emit
        // several frames from one chunk, so cancellation outside this callback
        // is too late to stop trailing output from being misattributed.
        if (terminal) return;
        events.push(event);
        if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event?.type)) terminal = true;
    });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try
    {
        for (;;)
        {
            const { value, done } = await reader.read();
            if (done) break;
            if (gone()) throw new Error('client disconnected');
            feed(decoder.decode(value, { stream: true }));
            if (terminal) break;
        }
        if (!terminal) feed(decoder.decode(), true);
        if (gone()) throw new Error('client disconnected');
        return events;
    }
    finally { try { await reader.cancel(); } catch (_) {} }
}

function combinedUsage(reasoningEnabled, ...values)
{
    const out = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const value of values)
    {
        const usage = anthropicUsage(value || {}, reasoningEnabled);
        for (const key of Object.keys(out)) out[key] += Number(usage[key]) || 0;
    }
    if (!reasoningEnabled) out.output_tokens_details = { thinking_tokens: 0 };
    return out;
}

function recordCompactionResponse(response, source, sessionId, requestedModel, reasoningEnabled)
{
    if (!response?.id || !response.usage) return;
    recordProviderUsage({
        provider: 'openai', sessionId, requestedModel,
        responseId: response.id, servedModel: response.model || requestedModel,
        effort: response.reasoning?.effort || (reasoningEnabled ? null : 'none'),
        source, exact: true, status: 'completed',
        usage: anthropicUsage(response.usage, reasoningEnabled),
        rawUsage: openAIRawUsage(response.usage, reasoningEnabled),
    });
}

// In Codex context-management mode manual and automatic compaction start a new
// window without asking a model to summarize. Claude Code still expects one
// assistant response from its compaction transaction, so return an opaque marker
// and remove that synthetic message on the next count/inference request.
async function handleContextCompaction(req, res, body)
{
    const request = isClaudeCompactionRequest(body);
    const settings = readContextSettings();
    if (!request || !settings.enabled || !settings.windowReset || isSubagentRequest(body) === true) return false;
    const sessionId = req.headers['x-claude-code-session-id'];
    if (typeof sessionId !== 'string' || !sessionId) return false;
    // Migrate a pre-isolation namespace before restoration can consult its cut.
    windowStore.ensure(sessionId);

    const providerSettings = readProviderSettings();
    const selection = resolvePromptPolicy(body, 'openai', providerSettings, sessionId);
    const built = buildResponsesRequest(body, providerSettings, selection, {
        restoreCompaction: restoreForSession(sessionId),
    });
    const input = removeCompactionPrompt(built.req.input);
    const reset = windowStore.beginClientReset(sessionId, input);
    const text = contextResetSummary(reset.id);
    let inputTokens = 0;
    try { inputTokens = await estimateOpenAIInput({ ...built.req, input }); } catch (_) {}
    const usage = {
        input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...(providerSettings.reasoningEnabled === false ? { output_tokens_details: { thinking_tokens: 0 } } : {}),
    };
    res.writeHead(200, {
        'Content-Type': body.stream !== true ? 'application/json' : 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...promptPolicyHeaders(selection),
        'X-Cuimod-Compaction': 'context-window-reset',
        'X-Cuimod-Context-Window': reset.state.windowId,
    });
    res.end(anthropicSummaryResponse(body.model, text, usage, body.stream === true));
    log(`openai context compaction ${sessionId} window=${reset.state.windowId.slice(0, 8)} windows=${reset.state.windows}${reset.reused ? ' retry=1' : ''}`);
    return true;
}

async function handleCodexCompaction(req, res, body)
{
    const request = isClaudeCompactionRequest(body);
    const settings = readCompactionSettings();
    const subagent = isSubagentRequest(body);
    if (!request || settings.strategy !== 'codex' || subagent === true) return false;
    const sessionId = req.headers['x-claude-code-session-id'];
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const gone = () => res.writableEnded || res.destroyed;

    try
    {
        const providerSettings = readProviderSettings();
        const contextSettings = readContextSettings();
        // A disabled setting must not resurrect a prefix retired by an earlier
        // window reset. Quarantine legacy mixed-agent state before consulting it;
        // only an enabled lane uses that store as its backend request identity.
        const storedWindowState = contextSettings.enabled
            ? windowStore.ensure(sessionId) : windowStore.quarantineLegacy(sessionId);
        const contextState = contextSettings.enabled ? storedWindowState : null;
        const windowState = storedWindowState;
        const selection = resolvePromptPolicy(body, 'openai', providerSettings, sessionId);
        const selectedBody = settings.model === 'current'
            ? body
            : { ...body, model: `claude-${settings.model}[1m]`, output_config: { ...(body.output_config || {}), effort: 'low' } };
        const built = buildResponsesRequest(selectedBody, providerSettings, selection, {
            restoreCompaction: restoreForSession(sessionId, subagent !== true),
        });
        let compactionInput = built.req.input;
        let windowCut = null;
        if (windowState?.cut)
        {
            windowCut = windowState.cut;
            const alreadyApplied = built.restoration?.windowCuts?.some(cut => windowCutsMatch(cut, windowCut));
            if (!alreadyApplied)
            {
                const cut = applyWindowCut(compactionInput, windowCut);
                compactionInput = cut.input;
                if (cut.degraded) log(`openai compaction window cut degraded: ${cut.degraded}`);
            }
        }
        const compactPayload = buildRemoteCompactionPayload({ ...built.req, input: compactionInput });
        const tokens = await chatgptAuth(log);
        // Same thread as the conversation being compacted, whose prefix it reads.
        const compactEvents = await bufferedResponses(compactPayload, tokens,
            contextState?.storeId ? built.key : conversationThread(sessionId, built.key), gone, 'openai-compaction',
            contextState?.storeId || null);
        const compacted = collectRemoteCompaction(compactEvents);
        const retained = await retainCompactionHistory(compactPayload.input, built.model, estimateOpenAIInput);
        if (gone()) throw new Error('client disconnected');

        let fallback = 'This conversation is preserved in a Codex checkpoint and requires a compatible GPT model to continue.';
        let fallbackResponse = null;
        if (settings.portableFallback)
        {
            const fallbackKey = crypto.createHash('sha256').update(built.key + '\ncompaction-fallback').digest('hex').slice(0, 32);
            const fallbackEvents = await bufferedResponses(
                buildFallbackPayload(built.model, compacted.item, fallbackKey, providerSettings),
                tokens, contextState?.storeId ? fallbackKey : conversationThread(sessionId, fallbackKey), gone, 'openai-compaction-fallback',
                contextState?.storeId || null);
            const rendered = collectResponseText(fallbackEvents);
            fallback = rendered.text;
            fallbackResponse = rendered.response;
        }
        if (gone()) throw new Error('client disconnected');

        const record = compactionStore.save({
            sessionId,
            sourceModel: built.model,
            trigger: request.kind,
            history: retained.concat([compacted.item]),
            fallback,
            windowCut,
            remoteResponseId: compacted.response.id || null,
            fallbackResponseId: fallbackResponse?.id || null,
        });
        const reasoningEnabled = providerSettings.reasoningEnabled !== false;
        recordCompactionResponse(compacted.response, 'openai.compaction.v2', sessionId, built.model, reasoningEnabled);
        if (fallbackResponse) recordCompactionResponse(fallbackResponse, 'openai.compaction.fallback', sessionId, built.model, reasoningEnabled);

        const text = summaryText(record.id, fallback);
        const usage = combinedUsage(reasoningEnabled, compacted.response.usage, fallbackResponse?.usage);
        const headers = { 'Content-Type': body.stream !== true ? 'application/json' : 'text/event-stream',
            'Cache-Control': 'no-cache', ...promptPolicyHeaders(selection),
            'X-Cuimod-Compaction': 'codex-v2', 'X-Cuimod-Compaction-Checkpoint': record.id };
        res.writeHead(200, headers);
        res.end(anthropicSummaryResponse(body.model, text, usage, body.stream === true));
        log(`openai compaction ${sessionId} checkpoint=${record.id} model=${built.model} retained=${record.history.length} fallback=${fallback.length}B`);
        return true;
    }
    catch (error)
    {
        const message = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);
        if (gone() || message === 'client disconnected') {
            log(`openai compaction cancelled: ${message}`);
            return true;
        }
        // A provider that rejects the compaction endpoint may still use Claude
        // Code's selected native summary path. A malformed/empty successful
        // response is a protocol failure: falling through would rerun the same
        // dedicated prompt as an ordinary tool-enabled turn and could replace
        // usable context with another empty result.
        if (Number.isInteger(error?.upstreamStatus) && [400, 404].includes(error.upstreamStatus)) {
            log(`openai compaction unavailable; using native summary: ${message}`);
            return false;
        }
        if (!Number.isInteger(error?.upstreamStatus)) {
            log(`openai compaction failed closed: ${message}`);
            res.writeHead(502, { 'Content-Type': 'application/json', 'X-Cuimod-Compaction': 'failed' });
            res.end(errorBody(`openai compaction failed: ${message}`, 'api_error'));
            return true;
        }
        const headers = { 'Content-Type': 'application/json' };
        for (const name of ['retry-after', 'retry-after-ms', 'x-request-id'])
        {
            const value = error.upstreamHeaders?.get(name);
            if (value !== null && value !== undefined) headers[name] = value;
        }
        res.writeHead(error.upstreamStatus, headers);
        res.end(errorBody(`openai compaction ${error.upstreamStatus}: ${String(error.upstreamText || '').slice(0, 500)}`,
            error.upstreamStatus === 429 ? 'rate_limit_error' : 'api_error'));
        return true;
    }
}

// --------------------------------------------- context management ------

// `max_context_window` is the model's real ceiling; `context_window` is the
// smaller default Codex starts a plain session at and that its own
// `model_context_window` config routinely overrides. This arm runs these models
// at their ceiling, so budgeting against the 272000 default would fire the
// wrap-up reminder while the model still had most of its room -- measured
// 2026-09-05: astra, reserve, sol, terra and luna all report a 872000 ceiling
// against a 272000 default, while 5.5, 5.4-mini and codex-spark report the same
// value for both.
//
// `effective_context_window_percent` is the headroom the backend reserves for
// the system prompt, tools and output. The endpoint never sends it at any
// client_version tried and the client defaults it to 95
// (openai_models.rs:383, usable_context_window at :504).
function contextWindowSize(models, model)
{
    const entry = (models?.models || []).find(value => value?.slug === model);
    const ceiling = [entry?.max_context_window, entry?.context_window]
        .map(Number)
        .find(value => Number.isFinite(value) && value > 0);
    if (!Number.isFinite(ceiling)) return OPENAI_MODELS.find(value => value.id === model)?.context || 272000;
    const percent = Number(entry?.effective_context_window_percent);
    return Math.floor(ceiling * (Number.isFinite(percent) && percent > 0 ? percent : 95) / 100);
}

async function measureContextBudget(payload, model, models, budget, autoCompact, reminders)
{
    try
    {
        const used = await estimateOpenAIInput(payload);
        const limits = contextBudgetLimits(contextWindowSize(models, model), autoCompact, budget, reminders);
        return contextBudgetStatus(used, limits);
    }
    catch (_) { return null; }
}

// The one plaintext route. Everything else the backend returns is Fernet and is
// replayed to the model untouched, so this hint is the only thing this process
// can honestly show a user about what the model is keeping.
async function threadHint(base, tokens, identity, storeId)
{
    const result = await callBackend({ base, route: THREAD_HINT_ROUTE, tokens, sessionId: storeId,
        agentName: CONTEXT_AGENT, args: {}, identityHeaders: identity, truncationBytes: MAX_THREAD_HINT_BYTES });
    if (!result.ok) return { text: '', error: result.error };
    const text = typeof result.value?.text === 'string' ? result.value.text : '';
    // extension.rs:137 drops an oversized hint rather than truncating it, because
    // a hint cut mid-path points the model at a note that does not exist.
    return { text: Buffer.byteLength(text) > MAX_THREAD_HINT_BYTES ? '' : text, error: null };
}

async function prepareContextManagement({ payload, model, sessionId, tokens, key, settings, restoration, autoCompact })
{
    if (!settings.enabled || typeof sessionId !== 'string' || !sessionId) return null;

    let state;
    try { state = windowStore.ensure(sessionId); }
    catch (error)
    {
        contextHealth = { ...contextHealth, lastError: `window store: ${String(error?.message || error).slice(0, 160)}` };
        return null;
    }

    const identity = codexIdentityHeaders(key, state.storeId);
    let models = null;
    try { models = await modelMessages.load(tokens, identity); }
    catch (error) { contextHealth = { ...contextHealth, lastError: `models list: ${String(error?.message || error).slice(0, 160)}` }; }
    const upstreamBudget = tokenBudgetFor(models, model);
    const budget = upstreamBudget || FALLBACK_TOKEN_BUDGET;

    let input = payload.input;
    let cut = null;
    if (restoration?.resetIds?.length)
    {
        // Stripping the synthetic marker prepares this attempt; it does not prove
        // the replacement turn reached the client. Retire the durable reset only
        // after a terminal response so a 429 or transport retry stays clean.
        cut = { applied: false, clientReset: true };
    }
    else if (settings.windowReset && state.cut)
    {
        const compacted = restoration?.windowCuts?.some(value => windowCutsMatch(value, state.cut));
        if (compacted)
        {
            state = windowStore.clearCut(sessionId, state.cut);
            cut = { applied: false, compacted: true };
        }
        else
        {
            cut = applyWindowCut(input, state.cut);
            input = cut.input;
        }
    }

    let status = await measureContextBudget({ ...payload, input }, model, models, budget, autoCompact, settings.reminders);
    // Codex forces a reset at the buffered boundary. Preserve the latest user
    // turn by cutting before it, which is the router equivalent of Codex's
    // InitialContextInjection::BeforeLastUserMessage.
    if (settings.windowReset && status?.forceRemaining === 0 && userMessages(input).length > 1)
    {
        state = windowStore.rotate(sessionId, input, { cause: 'forced', beforeLastUser: true });
        const forced = applyWindowCut(input, state.cut);
        input = forced.input;
        cut = { ...forced, forced: true };
        status = await measureContextBudget({ ...payload, input }, model, models, budget, autoCompact, settings.reminders);
    }

    const hint = settings.notesTools ? await threadHint(CODEX_BASE, tokens, identity, state.storeId) : { text: '', error: null };
    if (hint.error) contextHealth = { ...contextHealth, lastError: `thread hint: ${hint.error}` };

    let removed = 0;
    const leading = [contextWindowMessage({
        agentName: CONTEXT_AGENT,
        firstWindowId: state.firstWindowId,
        previousWindowId: state.previousWindowId,
        windowId: state.windowId,
        threadHint: hint.text || null,
    })];
    if (settings.reminders)
    {
        const guidance = guidanceMessage(budget.guidance_message);
        removed += guidance.removed;
        if (guidance.message) leading.push(guidance.message);
    }

    const trailing = [];
    const threshold = Number(budget.reminder_threshold_tokens) || 0;
    if (settings.reminders && status && threshold > 0 && status.remaining <= threshold
        && windowStore.claimReminder(sessionId))
    {
        const reminder = reminderMessage(budget.reminder_message_template, status.remaining);
        removed += reminder.removed;
        if (reminder.message) trailing.push(reminder.message);
    }
    if (settings.reminders && status?.remaining === 0 && status.forceRemaining > 0
        && windowStore.claimFallback(sessionId))
    {
        const fallback = reminderMessage(budget.auto_compact_fallback_prompt, 0);
        removed += fallback.removed;
        if (fallback.message) trailing.push(fallback.message);
    }

    const clientNames = new Set((payload.tools || []).map(tool => tool?.name));
    const tools = contextTools().filter(tool => {
        if (tool.name === 'notes' && !settings.notesTools) return false;
        if (tool.name === 'history' && !settings.historyTools) return false;
        if (tool.name === NEW_CONTEXT_TOOL && !settings.windowReset) return false;
        return !clientNames.has(tool.name);
    });

    // Ingestion is requested only when the history tools are on, because the
    // index exists to serve them and nothing else here reads it.
    const metadata = settings.historyTools ? turnMetadata({
        installationId: state.installationId,
        sessionId: state.storeId,
        windowId: WindowStore.compoundWindowId(state),
        windowNumber: (state.windows || 1) - 1,
        contextWindowId: state.windowId,
        agentName: CONTEXT_AGENT,
    }) : null;

    state = windowStore.recordTurn(sessionId, {
        hint: settings.notesTools,
        failure: !!hint.error,
        budget: status,
        threadHint: hint.error ? null : hint.text,
    });
    contextHealth = { ...contextHealth, drift: driftReport(upstreamBudget, { total: removed }) };

    return {
        state, identity, budget, tools, remaining: status?.remaining ?? null,
        forceRemaining: status?.forceRemaining ?? null, cut,
        resetIds: restoration?.resetIds || [],
        concealmentRemoved: removed,
        ingesting: !!metadata,
        requestHeaders: metadata ? metadata.headers : null,
        prepared: {
            ...payload,
            input: leading.concat(input, trailing),
            ...(tools.length ? { tools: (payload.tools || []).concat(tools) } : {}),
            ...(metadata ? { client_metadata: { ...(payload.client_metadata || {}), ...metadata.clientMetadata } } : {}),
        },
    };
}

// Model-only calls, executed here and replayed as ordinary tool output. Nothing
// about a call or its result is logged: the arguments are the model's own notes
// and the result is ciphertext this process cannot read anyway.
async function runContextCalls(calls, { context, sessionId, tokens, model, payload, settings })
{
    const items = [];
    for (const call of calls)
    {
        let output;
        if (call.name === NEW_CONTEXT_TOOL)
        {
            try
            {
                context.state = windowStore.rotate(sessionId, payload.input, { cause: 'model' });
                context.state = windowStore.recordModelCall(sessionId, call);
                output = [{ type: 'input_text', text: 'A new context window will start without summarizing conversation history.' }];
            }
            catch (error)
            {
                context.state = windowStore.recordModelCall(sessionId, call, true);
                output = [{ type: 'input_text', text: `Unable to start a new context window: ${String(error?.message || error).slice(0, 160)}` }];
            }
        }
        else
        {
            const route = ROUTE_BY_CALL.get(`${call.namespace}.${call.name}`);
            let args = {};
            try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
            catch (_) { args = {}; }
            const result = route
                ? await callBackend({
                    base: CODEX_BASE, route, tokens, sessionId: context.state.storeId,
                    agentName: CONTEXT_AGENT, args, identityHeaders: context.identity,
                    truncationBytes: settings.truncationBytes,
                })
                : { ok: false, error: 'unknown model-only tool' };
            context.state = windowStore.recordModelCall(sessionId, call, !result.ok);
            if (!result.ok) contextHealth = { ...contextHealth, lastError: `${route || call.name}: ${result.error}` };
            output = result.ok
                ? toolOutputContent(result.value)
                : [{ type: 'input_text', text: `Unable to perform operation: ${result.error}` }];
        }
        items.push({ type: 'function_call_output', call_id: call.call_id, output });
    }
    return items;
}

async function handleOpenAI(req, res, body)
{
    const gone = () => res.writableEnded || res.destroyed;
    const clientModel = body.model;
    const settings = readProviderSettings();
    const contextSettings = readContextSettings();
    const sessionId = req.headers['x-claude-code-session-id'];
    const subagent = isSubagentRequest(body);
    // buildResponsesRequest restores local reset markers. Isolate the root first,
    // or the first request after this upgrade could still consume a mixed-agent
    // cut before prepareContextManagement gets a chance to migrate the store.
    if (contextSettings.enabled && subagent !== true && typeof sessionId === 'string')
    {
        try { windowStore.ensure(sessionId); }
        catch (error) { contextHealth = { ...contextHealth, lastError: `window store: ${String(error?.message || error).slice(0, 160)}` }; }
    }
    const selection = resolvePromptPolicy(body, 'openai', settings, sessionId);
    const { req: payload, key, model, effort, promptSurface, restoration, webSearchMaxUses } = buildResponsesRequest(body, settings, selection, {
        restoreCompaction: restoreForSession(sessionId, subagent !== true),
        fast: fastTier({ body, model: parseOpenAIModel(body.model).id, sessionId, subagent }),
    });
    capturePrompt({ provider: 'openai', sessionId: req.headers['x-claude-code-session-id'], model,
        selection, ...promptSurface });
    const parsed = parseOpenAIModel(body.model, body.output_config?.effort);
    const speed = payload.service_tier === 'priority' ? 'fast' : 'standard';
    const autoCompact = readAutoCompactBudget(model, sessionId);
    // Set once the translator exists. A round that still owes model-only tool
    // results is not the end of the turn, and settling the rate sample there
    // would measure the first leg instead of the whole answer.
    let translator = null;
    let nonstreamPending = false;
    const moreRounds = () => translator ? translator.pendingCalls.length > 0 : nonstreamPending;
    const identities = new Set();
    function observeIdentity(event) {
        if (!settings.logUpstreamIdentity || !['response.created', 'response.completed', 'response.incomplete'].includes(event?.type)) return;
        const response = event.response || {};
        const identity = {
            type: 'openai-response-identity',
            sessionId: req.headers['x-claude-code-session-id'] || null,
            requestedModel: model, requestedEffort: effort,
            reportedModel: typeof response.model === 'string' ? response.model : null,
            reportedEffort: typeof response.reasoning?.effort === 'string' ? response.reasoning.effort : null,
            responseId: typeof response.id === 'string' ? response.id : null,
        };
        const serialized = JSON.stringify(identity);
        if (!identities.has(serialized)) { identities.add(serialized); log(serialized); }
    }
    function observeUsage(event) {
        if (!['response.completed', 'response.incomplete'].includes(event?.type)) return;
        const response = event.response || {};
        if (!response.id || !response.usage) return;
        const sample = {
            responseId: response.id, servedModel: response.model || model,
            effort: response.reasoning?.effort || effort,
            status: event.type === 'response.incomplete' ? 'incomplete' : 'completed',
            usage: anthropicUsage(response.usage, settings.reasoningEnabled !== false),
            rawUsage: openAIRawUsage(response.usage, settings.reasoningEnabled !== false),
        };
        recordProviderUsage({
            provider: 'openai',
            sessionId: req.headers['x-claude-code-session-id'] || null,
            requestedModel: model,
            source: 'openai.response.usage', exact: true, ...sample,
        });
        if (moreRounds()) rate.nextOpenAIResponse();
        else rate.complete(sample);
    }
    const rate = throughput.begin({
        provider: 'openai', sessionId: req.headers['x-claude-code-session-id'] || null,
        requestedModel: model, effort,
        subagent, streaming: body.stream === true,
    }, res);
    const observe = event => { observeIdentity(event); rate.openai(event); observeUsage(event); };

    const effortNote = parsed.rejectedEffort
        ? (settings.reasoningEnabled === false ? ` (ignored ${parsed.rejectedEffort}, reasoning is off)` : ` (rejected ${parsed.rejectedEffort}, not supported by this model)`)
        : '';
    log(`openai ${body.model} -> ${model} effort=${effort}${effortNote} tier=${payload.service_tier || 'default'}${subagent === true ? ' sub' : ''} items=${payload.input.length} tools=${payload.tools?.length ?? 0} instr=${payload.instructions.length}B key=${key.slice(0, 8)}`
        + `${restoration?.restored ? ` compact-restored=${restoration.restored}` : ''}${restoration?.degraded ? ` compact-degraded=${restoration.degraded}` : ''}`);

    if (process.env.GEMINI_BRIDGE_DUMP)
    {
        try
        {
            const dir = path.join(HERE, 'reqdump');
            fs.mkdirSync(dir, { recursive: true });
            globalThis.__no = (globalThis.__no || 0) + 1;
            fs.writeFileSync(path.join(dir, `oai-${String(globalThis.__no % 20).padStart(2, '0')}.json`), JSON.stringify(payload, null, 1));
        }
        catch (_) {}
    }

    const tokens = await chatgptAuth(log);

    // Notes, history and the window tools are model-only: they run here and
    // never surface to Claude Code, which is why one Anthropic message can span
    // several upstream responses. A failed preparation degrades to an ordinary
    // turn rather than to no turn.
    let context = null;
    if (subagent !== true)
    {
        try { context = await prepareContextManagement({ payload, model, sessionId, tokens, key, settings: contextSettings, restoration, autoCompact }); }
        catch (error)
        {
            contextHealth = { ...contextHealth, lastError: String(error?.message || error).slice(0, 200) };
            log(`context management skipped for this turn: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    }
    let outbound = context ? context.prepared : payload;
    if (context)
    {
        log(`openai context-management session=${sessionId} window=${context.state.windowId.slice(0, 8)} windows=${context.state.windows}`
            + ` tools=+${context.tools.length} remaining=${context.remaining ?? 'unknown'} force-remaining=${context.forceRemaining ?? 'unknown'} stripped=${context.concealmentRemoved}`
            + `${context.ingesting ? ' ingest=on' : ''}`
            + `${context.cut?.applied ? ` cut-dropped=${context.cut.dropped}` : ''}${context.cut?.compacted ? ' cut-compacted=1' : ''}${context.cut?.degraded ? ` cut-degraded=${context.cut.degraded}` : ''}`);
    }

    // Runs the model-only calls a round produced and appends both halves to the
    // outbound history, so the next round sees exactly what Codex would.
    const advanceRound = async (calls) => {
        const outputs = await runContextCalls(calls, {
            context, sessionId, tokens, model, payload: outbound, settings: contextSettings,
        });
        outbound = { ...outbound, input: outbound.input.concat(calls, outputs) };
        return outbound;
    };

    // The backend keeps prompt-cache affinity per thread, so this must be one
    // stable thread per conversation. Both earlier choices broke that: a fresh
    // uuid per subagent request missed every time, and the shared Claude session
    // id put a lead and all its parallel workers on one thread, where misses
    // climbed from 2% solo to ~34% at six workers (ledger, 2026-09-24..27).
    // Subagents never send client_metadata, so no backend history is shared.
    const responseSessionId = context?.state?.storeId || null;
    const threadKey = responseSessionId ? key : conversationThread(sessionId, key);
    // No status retry. A 429 here is the ChatGPT plan's own rate limit, and
    // hammering it is how a soft limit becomes a hard one; the Anthropic SDK on
    // the client side honours Retry-After and will do the waiting.
    const upstreamHeaders = () => ({
        ...responsesHeaders(tokens, threadKey, responseSessionId),
        ...(context?.requestHeaders || {}),
    });
    let upstream = await openAIRequest(RESPONSES_URL, {
        method: 'POST',
        headers: upstreamHeaders(),
        body: JSON.stringify(outbound),
    }, gone, log);

    if (gone()) { rate.end(); return; }
    rate.upstream();

    if (!upstream.ok)
    {
        rate.end();
        const text = await upstream.text().catch(() => '');
        log(`openai ${upstream.status} on ${model}: ${text.slice(0, 400)}`);
        const headers = { 'Content-Type': 'application/json', ...promptPolicyHeaders(selection) };
        for (const name of ['retry-after', 'retry-after-ms', 'x-request-id']) {
            const value = upstream.headers.get(name);
            if (value !== null) headers[name] = value;
        }
        res.writeHead(upstream.status, headers);
        res.end(errorBody(`openai ${upstream.status}: ${text.slice(0, 500)}`, upstream.status === 429 ? 'rate_limit_error' : 'api_error'));
        return;
    }

    // Agent turns stream. Unary control-plane calls omit `stream` and need one
    // assembled Message with terminal usage, which is also the selftest path.
    if (body.stream !== true)
    {
        const kept = [];
        try
        {
            for (let round = 0; ; round++)
            {
                const events = [];
                const pending = [];
                const internal = new Set();
                const argumentsByIndex = new Map();
                nonstreamPending = false;
                let terminal = false;
                const feed = sseParser((e) => {
                    if (terminal) return;
                    const oi = e?.output_index ?? 0;
                    if (e?.type === 'response.output_item.added' && isContextCall(e.item)) {
                        internal.add(oi);
                        argumentsByIndex.set(oi, typeof e.item?.arguments === 'string' ? e.item.arguments : '');
                    }
                    const hidden = internal.has(oi) && ['response.output_item.added', 'response.output_item.done', 'response.function_call_arguments.delta'].includes(e?.type);
                    if (hidden && e.type === 'response.function_call_arguments.delta')
                        argumentsByIndex.set(oi, (argumentsByIndex.get(oi) || '') + (e.delta || ''));
                    if (hidden && e.type === 'response.output_item.done') {
                        pending.push({ ...e.item, type: 'function_call',
                            arguments: typeof e.item?.arguments === 'string' && e.item.arguments
                                ? e.item.arguments : (argumentsByIndex.get(oi) || '') });
                        nonstreamPending = true;
                    }
                    if (!hidden) events.push(e);
                    observe(e);
                    if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(e?.type)) terminal = true;
                });
                const reader = upstream.body.getReader();
                const dec = new TextDecoder();
                try
                {
                    for (;;)
                    {
                        const { value, done } = await readOpenAIStream(reader);
                        if (done) break;
                        if (gone()) return;
                        feed(dec.decode(value, { stream: true }));
                        if (terminal) break;
                    }
                    if (!terminal) feed(dec.decode(), true);
                }
                finally { try { await reader.cancel(); } catch (_) {} }

                // A hidden round's terminal belongs to that upstream response,
                // while the Anthropic message remains open for the final answer.
                kept.push(...(pending.length
                    ? events.filter(event => !['response.completed', 'response.incomplete'].includes(event?.type))
                    : events));

                if (!context || !pending.length) break;
                const next = await advanceRound(pending);
                // The final round is served without the model-only tools, so a
                // model that keeps taking notes still has to answer.
                const last = round + 1 >= MAX_CONTEXT_ROUNDS;
                const request = last ? { ...next, tools: (payload.tools || []) } : next;
                if (last && !request.tools.length) delete request.tools;
                upstream = await openAIRequest(RESPONSES_URL, {
                    method: 'POST', headers: upstreamHeaders(), body: JSON.stringify(request),
                }, gone, log);
                if (!upstream.ok)
                {
                    const text = await upstream.text().catch(() => '');
                    log(`openai ${upstream.status} on ${model} after a model-only round: ${text.slice(0, 300)}`);
                    const headers = { 'Content-Type': 'application/json', ...promptPolicyHeaders(selection) };
                    for (const name of ['retry-after', 'retry-after-ms', 'x-request-id']) {
                        const value = upstream.headers.get(name);
                        if (value !== null) headers[name] = value;
                    }
                    res.writeHead(upstream.status, headers);
                    res.end(errorBody(`openai ${upstream.status}: ${text.slice(0, 500)}`,
                        upstream.status === 429 ? 'rate_limit_error' : 'api_error'));
                    return;
                }
            }
        }
        finally { rate.end(); }

        const message = collectAnthropicMessage(clientModel, kept, { ...settings, webSearchMaxUses, speed });
        if (context?.resetIds?.length) {
            context.state = windowStore.acknowledgeClientReset(sessionId, context.resetIds);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...promptPolicyHeaders(selection) });
        res.end(JSON.stringify(message));
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...promptPolicyHeaders(selection),
    });

    let lastWriteAt = Date.now();
    const write = value => {
        if (gone()) return;
        lastWriteAt = Date.now();
        res.write(value);
    };
    const heartbeat = setInterval(() => {
        if (!gone() && Date.now() - lastWriteAt >= OPENAI_HEARTBEAT_MS) write(anthropicPing());
    }, OPENAI_HEARTBEAT_MS);
    heartbeat.unref?.();

    const out = new ResponsesToAnthropic(clientModel, write, {
        ...settings,
        webSearchMaxUses,
        speed,
        ...(context ? { suppressCall: isContextCall, deferFinish: true } : {}),
    });
    translator = out;
    const feed = sseParser((e) => {
        observe(e);
        if (e?.type === 'response.failed' || e?.type === 'error') {
            const message = e.response?.error?.message || e.message || e.error?.message || 'upstream error';
            log(`openai ${e.type} on ${model}: ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`);
        }
        out.handle(e);
    });
    const dec = new TextDecoder();

    try
    {
        for (let round = 0; ; round++)
        {
            const reader = upstream.body.getReader();
            try
            {
                for (;;)
                {
                    const { value, done } = await readOpenAIStream(reader);
                    if (done) break;
                    if (gone()) { try { await reader.cancel(); } catch (_) {} return; }
                    feed(dec.decode(value, { stream: true }));
                    if (out.closed) { try { await reader.cancel(); } catch (_) {} break; }
                }
                if (!out.closed) feed(dec.decode(), true);
            }
            catch (error)
            {
                log(`openai transport interrupted on ${model} [${error?.cause?.code || error?.code || error?.name || 'error'}]: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240)}`);
                try { await reader.cancel(); } catch (_) {}
                if (out.recoverTransport()) { res.end(); return; }
                res.destroy(error);
                return;
            }

            const calls = out.closed ? [] : out.takePendingCalls();
            if (!calls.length) break;

            // The model asked for notes, history or a window reset. Run them,
            // append both halves, and continue the same Anthropic message.
            let next;
            try { next = await advanceRound(calls); }
            catch (error)
            {
                out.fail(`context tools failed: ${String(error?.message || error).slice(0, 200)}`);
                res.end();
                return;
            }
            const last = round + 1 >= MAX_CONTEXT_ROUNDS;
            const request = last ? { ...next, tools: (payload.tools || []) } : next;
            if (last && !request.tools.length) delete request.tools;
            out.nextResponse();
            upstream = await openAIRequest(RESPONSES_URL, {
                method: 'POST', headers: upstreamHeaders(), body: JSON.stringify(request),
            }, gone, log);
            if (gone()) return;
            if (!upstream.ok)
            {
                const text = await upstream.text().catch(() => '');
                log(`openai ${upstream.status} on ${model} after a model-only round: ${text.slice(0, 300)}`);
                out.fail(`openai ${upstream.status} after a model-only tool round`);
                res.end();
                return;
            }
        }

        if (!out.closed && out.terminal) out.finish();
        if (out.terminal || out.failureMessage) {
            if (out.terminal && !out.failureMessage && context?.resetIds?.length)
                context.state = windowStore.acknowledgeClientReset(sessionId, context.resetIds);
            res.end();
            return;
        }
        const error = new Error('openai stream ended before a terminal response event');
        log(`${error.message} on ${model}`);
        if (out.recoverTransport()) { res.end(); return; }
        res.destroy(error);
    }
    finally
    {
        clearInterval(heartbeat);
        rate.end();
    }
}

async function handlePassthrough(req, res, rawBody, body, urlPath)
{
    const gone = () => res.writableEnded || res.destroyed;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v;

    let selection = null;
    let outgoing = rawBody;
    const messagesRequest = body && (urlPath === '/v1/messages' || urlPath === '/v1/messages/count_tokens');
    if (messagesRequest)
    {
        const portableBody = stripCheckpointMarkers(stripContextResetMarkers(body));
        selection = resolvePromptPolicy(portableBody, 'anthropic', readProviderSettings(), req.headers['x-claude-code-session-id']);
        const prepared = applyPromptPolicy(portableBody, selection);
        if (prepared !== body) outgoing = Buffer.from(JSON.stringify(prepared));
        if (urlPath === '/v1/messages')
        {
            capturePrompt({ provider: 'anthropic', sessionId: req.headers['x-claude-code-session-id'], model: portableBody.model,
                selection, system: portableBody.system, tools: portableBody.tools,
                effectiveSystem: prepared.system, effectiveTools: prepared.tools });
        }
    }

    const rate = messagesRequest && urlPath === '/v1/messages'
        ? throughput.begin({
            provider: 'claude', sessionId: req.headers['x-claude-code-session-id'] || null,
            requestedModel: body.model, subagent: isSubagentRequest(body), streaming: body.stream === true,
        }, res)
        : null;

    const upstream = await fetchResilient(ANTHROPIC + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : outgoing,
    }, 'anthropic', gone, NO_STATUS_RETRY, log);
    rate?.upstream();

    if (gone()) { rate?.end(); return upstream.status; }

    const out = {};
    upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k.toLowerCase())) out[k] = v; });
    res.writeHead(upstream.status, selection ? { ...out, ...promptPolicyHeaders(selection) } : out);

    if (upstream.ok && rate)
    {
        const recordUsage = sample => {
            recordProviderUsage({
                provider: 'claude', sessionId: req.headers['x-claude-code-session-id'] || null,
                requestedModel: body.model, source: 'anthropic.message.usage', exact: true, ...sample,
            });
            rate.complete(sample);
        };
        try
        {
            await pipeObservedAnthropicBody(upstream, res, body.stream === true, recordUsage, body.model,
                event => rate.anthropic(event));
        }
        finally { rate.end(); }
    }
    else
    {
        rate?.end();
        await pipeBody(upstream, res);
    }
    return upstream.status;
}

// --------------------------------------------------------- model lists ----

// The Agent tool validates a custom agent's model against /v1/models before
// spawning. Anthropic's list carries only Anthropic models, so without the
// additions below a subagent on any other provider dies client-side with
// "model may not exist" while a top-level request on the same model works fine.
function modelEntry(id)
{
    return { type: 'model', id, display_name: id, created_at: '2026-08-13T00:00:00Z' };
}

// Anthropic passthrough, listed by hand: the upstream list does not carry the
// thinking variant's id, and the Agent tool validates a subagent's model
// against the list before spawning.
const CLAUDE_OFFICIAL_MODELS = [
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
];

// ------------------------------------------------------------- server ----

const activeMessageRequests = new Map();
const controlPlaneModels = new Map();
const MAX_MESSAGE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_PLANE_MODELS = 2048;
const AUTO_MODE_SYSTEM_MARKER = 'security monitor for autonomous AI coding agents';

function requestAgentKey(req)
{
    const session = String(req.headers['x-claude-code-session-id'] || '').trim();
    if (!session) return null;
    const agent = String(req.headers['x-claude-code-agent-id'] || 'root').trim() || 'root';
    return `${session}\0${agent}`;
}

function systemText(body)
{
    if (typeof body?.system === 'string') return body.system;
    if (!Array.isArray(body?.system)) return '';
    return body.system.map(block => typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : '').join('\n');
}

function isAlternateModel(model)
{
    return !!(isOpenAI(model) || providerAdapters.resolve(model) || resolveCompatibleModel(model));
}

function inheritControlPlaneModel(req, body)
{
    const key = requestAgentKey(req);
    if (!key || !body || typeof body.model !== 'string') return body;

    const tools = Array.isArray(body.tools) ? body.tools : [];
    const lane = isSubagentRequest(body);
    const agent = key.slice(key.indexOf('\0') + 1);
    if (tools.length > 0 && (lane === false || (lane === true && agent !== 'root')))
    {
        controlPlaneModels.delete(key);
        if (isAlternateModel(body.model))
        {
            controlPlaneModels.set(key, body.model);
            while (controlPlaneModels.size > MAX_CONTROL_PLANE_MODELS)
                controlPlaneModels.delete(controlPlaneModels.keys().next().value);
        }
        return body;
    }

    if (tools.length !== 0 || !systemText(body).includes(AUTO_MODE_SYSTEM_MARKER)) return body;
    const model = controlPlaneModels.get(key);
    if (!model || model === body.model) return body;
    return { ...body, model };
}

const server = http.createServer((req, res) =>
{
    // First, before admission bookkeeping or any body is read: a browser page
    // must not be able to spend credits or read state through this port.
    if (rejectRequest(req, res, [req.socket.localPort, publicRouterPort()])) return;
    const earlyPath = (req.url || '').split('?')[0];
    let admissionKey = null;
    if (req.method === 'POST' && earlyPath === '/v1/messages')
    {
        const session = String(req.headers['x-claude-code-session-id'] || '').trim();
        const agent = String(req.headers['x-claude-code-agent-id'] || 'root').trim();
        if (session) admissionKey = `${session}\0${agent}`;
        if (admissionKey && activeMessageRequests.has(admissionKey))
        {
            req.resume();
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '2', Connection: 'close' });
            res.end(errorBody('a request for this session agent is already in flight; retry shortly', 'rate_limit_error'));
            return;
        }
        if (admissionKey)
        {
            const token = Symbol(admissionKey);
            activeMessageRequests.set(admissionKey, token);
            res.once('close', () => {
                if (activeMessageRequests.get(admissionKey) === token) activeMessageRequests.delete(admissionKey);
            });
        }
    }
    const chunks = [];
    let bodyBytes = 0;
    req.on('data', (c) => {
        bodyBytes += c.length;
        if (bodyBytes > MAX_MESSAGE_BODY_BYTES)
        {
            res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(errorBody('request body exceeds the 64 MiB router limit', 'invalid_request_error'));
            req.destroy();
            return;
        }
        chunks.push(c);
    });

    req.on('end', async () =>
    {
        let rawBody = Buffer.concat(chunks);
        const started = Date.now();

        let body = null;
        try { body = JSON.parse(rawBody.toString('utf8')); } catch {}

        const requestURL = new URL(req.url || '/', 'http://127.0.0.1');
        const urlPath = requestURL.pathname;

        try
        {
            if (req.method === 'POST' && urlPath === '/v1/messages' && body)
            {
                const originalModel = body.model;
                body = inheritControlPlaneModel(req, body);
                if (body.model !== originalModel)
                {
                    rawBody = Buffer.from(JSON.stringify(body));
                    log(`control-plane ${originalModel} -> ${body.model}`);
                }
            }

            if (['GET', 'HEAD'].includes(req.method) && serveDashboard(req, res, urlPath)) return;

            if (req.method === 'GET' && urlPath === '/usagez')
            {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify(usageLedger.snapshot(requestURL.searchParams.get('session'))));
                return;
            }

            // Live in-flight streams plus completed-response rates. Cheap
            // enough to poll at a UI cadence: everything it serves is already
            // in memory, and it touches no provider.
            if (req.method === 'GET' && urlPath === '/throughputz')
            {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                res.end(JSON.stringify(throughput.snapshot()));
                return;
            }

            if (req.method === 'GET' && urlPath === '/throughput/api')
            {
                const params = requestURL.searchParams;
                const lane = params.get('lane');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                res.end(JSON.stringify(throughput.query({
                    session: params.get('session') || null,
                    provider: params.get('provider') || null,
                    model: params.get('model') || null,
                    subagent: lane === 'subagent' ? true : lane === 'main' ? false : undefined,
                    since: params.get('since') || null,
                    until: params.get('until') || null,
                    limit: params.get('limit'),
                })));
                return;
            }

            if (req.method === 'GET' && urlPath === '/limitsz')
            {
                const limits = await providerLimits.refresh(requestURL.searchParams.get('force') === '1');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify(limits));
                return;
            }

            // The reset-credit surface an orchestrator watches: credit count,
            // whether a window is actually exhausted, and every redemption this
            // account has made. POST redeems, and only a `force=1` POST can do
            // so without a window at its limit.
            if (urlPath === '/resetz' && (req.method === 'GET' || req.method === 'POST'))
            {
                const force = requestURL.searchParams.get('force') === '1';
                const value = req.method === 'GET'
                    ? await resetCredits.state(force)
                    : { attempt: await resetCredits.attempt({ force, reason: 'requested via /resetz' }),
                        ...await resetCredits.state(true) };
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff' });
                res.end(JSON.stringify(value));
                return;
            }

            // The generic pool-pin control: find a loaded adapter that exposes
            // the optional `poolPin` capability (a manual pool-wide diagnostic
            // override) and drive it. The core knows only that capability --
            // no backend specifics here. No adapter exposes it -> 501.
            if (urlPath === '/poolpinz' && (req.method === 'GET' || req.method === 'POST'))
            {
                const cap = [...providerAdapters.adapters].map(a => a.poolPin).find(Boolean);
                if (!cap)
                {
                    res.writeHead(501, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ error: { type: 'not_supported_error', message: 'no adapter exposes a pool pin' } }));
                    return;
                }
                const jsonError = (status, type, message) => {
                    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ error: { type, message } }));
                };
                try
                {
                    let value;
                    if (req.method === 'GET')
                    {
                        value = await cap.status();
                    }
                    else
                    {
                        let body = {};
                        try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch { jsonError(400, 'invalid_request_error', 'body must be JSON'); return; }
                        const action = body.action;
                        if (action === 'pin')
                        {
                            const id = body.id;
                            if (!Number.isSafeInteger(id) || id <= 0)
                            {
                                jsonError(400, 'invalid_request_error', 'pin requires a positive integer id');
                                return;
                            }
                            value = await cap.pin(id);
                        }
                        else if (action === 'auto')
                        {
                            value = await cap.auto();
                        }
                        else
                        {
                            jsonError(400, 'invalid_request_error', 'action must be "pin" or "auto"');
                            return;
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(value));
                }
                catch (error)
                {
                    // The adapter throws a client-validation error with a
                    // status for an invalid/unknown target; surface that as 4xx.
                    // Everything else is an upstream/application failure -> 502.
                    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
                        ? error.status : 502;
                    jsonError(status, status === 502 ? 'upstream_error' : 'invalid_request_error',
                        String(error?.message || 'pool pin failed').slice(0, 200));
                }
                return;
            }
            if (req.method === 'GET' && urlPath === '/usage/api')
            {
                const limits = requestURL.searchParams.get('scope') === 'claude'
                    ? { version: 1, observedAt: new Date().toISOString(), openai: null, gemini: null }
                    : await providerLimits.refresh(requestURL.searchParams.get('force') === '1');
                const usage = usageLedger.snapshot(requestURL.searchParams.get('session'));

                // Spooled responses have to reach the segments before the
                // snapshot reads them: the calibrator draws its responses from
                // the durable store now, not from the in-memory tail.
                const requestedRange = requestURL.searchParams.get('range');
                if (requestedRange) accounting.sync(2);
                const value = (requestedRange ? usageAnalytics : liveUsageAnalytics).snapshot(limits, usage);
                value.range = null;
                // The compact usage bar requests live limits with no range. It
                // neither displays nor consumes archival accounting, so treating
                // an omitted range as "all" made every background refresh scan
                // the entire quota archive on the inference event loop. Full
                // accounting remains opt-in through the dashboard's explicit
                // range selector.
                if (requestedRange) try
                {
                    const rangeKey = requestedRange;
                    const tz = Number(requestURL.searchParams.get('tz_offset'));
                    const archive = accounting.query(rangeKey, Number.isFinite(tz) ? tz : 0);
                    value.range = { key: archive.key, start: archive.start, end: archive.end };
                    value.storage = accounting.status();

                    // An adapter may hold accounting its backend exposes and we
                    // do not, such as an upstream billing basis. It decorates
                    // the payload rather than the router knowing the field.
                    for (const adapter of providerAdapters.adapters)
                    {
                        if (typeof adapter.usage !== 'function') continue;
                        try { adapter.usage(value); }
                        catch (error) { log(`adapter ${adapter.id} usage decoration failed: ${String(error?.message || error).slice(0, 160)}`); }
                    }

                    // A wide range must reach the meter sparklines too, or the
                    // quota history would silently stay on the short-term
                    // window whatever the selector says.
                    if (rangeKey !== 'today')
                    {
                        const history = accounting.quotaHistory(value.meters.map(meter => meter.key), value.range);
                        for (const meter of value.meters)
                            if (history[meter.key]?.length > 1) meter.history = history[meter.key];
                    }
                    value.usage = {
                        ...value.usage,
                        cost: archive.cost,
                        pricing: archive.pricing,
                        exactRecords: archive.totals.responses,
                        totalTokens: archive.totals.contextInputTokens + archive.totals.outputTokens,
                        totals: archive.totals,
                        models: archive.models.length ? archive.models : value.usage.models,
                        providers: archive.providers,
                        dailyTimeline: archive.dailyTimeline,
                        recent: (value.usage.recent || []).filter(entry => {
                            const at = Date.parse(entry?.observedAt);
                            return Number.isFinite(at) && at >= Date.parse(archive.start) && at <= Date.parse(archive.end);
                        }),
                    };
                }
                catch (error) { log(`accounting query failed: ${String(error?.message || error).slice(0, 240)}`); }
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                res.end(JSON.stringify(value));
                return;
            }

            if (req.method === 'GET' && urlPath === '/compactionz')
            {
                const sessionId = requestURL.searchParams.get('session');
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                res.end(JSON.stringify({
                    version: 1,
                    settings: readCompactionSettings(),
                    checkpoints: compactionStore.status(sessionId || null),
                }));
                return;
            }

            if (req.method === 'GET' && urlPath === '/contextz')
            {
                const sessionId = requestURL.searchParams.get('session');
                // Window bookkeeping, the plaintext thread hint the backend
                // itself returns, and drift. Note content is Fernet and never
                // reaches this process, so there is nothing here to redact.
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
                const window = sessionId ? windowStore.status(sessionId) : null;
                res.end(JSON.stringify({
                    version: 1,
                    settings: readContextSettings(),
                    backend: CODEX_BASE,
                    clientVersion: CODEX_CLIENT_VERSION,
                    window,
                    drift: contextHealth.drift,
                    // Activity is stored beside the window, so a hot worker swap
                    // cannot turn real resets back into "none yet".
                    activity: window?.activity || null,
                    lastError: contextHealth.lastError,
                }));
                return;
            }

            // Worker diagnostics. The stable supervisor has its own /supervisorz
            // liveness endpoint so a busy inference worker is never a daemon probe.
            if (urlPath === '/healthz')
            {
                // Report whether the ChatGPT credential is readable without
                // touching it: a 401 on every gpt request with nothing pointing
                // at the cause is the failure this is here to pre-empt.
                let chatgptOk = false;
                let chatgptExpiresIn = null;
                try
                {
                    const t = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8').replace(/^﻿/, ''))?.tokens;
                    chatgptOk = !!(t?.access_token && t?.account_id);
                    const payload = JSON.parse(Buffer.from(String(t.access_token).split('.')[1], 'base64url').toString('utf8'));
                    if (payload?.exp) chatgptExpiresIn = Math.round(payload.exp - Date.now() / 1000);
                }
                catch (_) {}

                const adapterHealth = providerAdapters.health();
                // Adapters are resolved before built-in arms for inference, so
                // contested ids must report the same owner here.
                const modelRoutes = [
                    ...adapterHealth.loaded.flatMap(adapter => adapter.modelRoutes || []),
                    ...OPENAI_MODELS.map(model => ({ id: model.id, provider: 'openai',
                        context: Number.isFinite(model.context) ? model.context : null })),
                    ...CLAUDE_OFFICIAL_MODELS.map(model => ({ id: model.id, provider: 'claude',
                        context: Number.isFinite(model.context) ? model.context : null })),
                ];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    anthropic: ANTHROPIC,
                    openai: RESPONSES_URL,
                    authFile: AUTH_FILE,
                    chatgptOk,
                    chatgptExpiresIn,
                    models: OPENAI_MODELS.map((m) => m.id),
                    modelRoutes,
                    compatible: compatibleStatus(),
                    // Adapters report readiness, never a credential value.
                    adapters: adapterHealth,
                    providerSettings: readProviderSettings(),
                    compaction: { settings: readCompactionSettings(), api: '/compactionz' },
                    contextManagement: { settings: readContextSettings(), api: '/contextz',
                        drift: contextHealth.drift, backend: CODEX_BASE },
                    usage: { file: USAGE_FILE, limitHistoryFile: LIMIT_HISTORY_FILE,
                        accountingDir: ACCOUNTING_DIR,
                        exactRecords: usageLedger.snapshot().exactRecords, dashboard: '/usage/' },
                    throughput: { file: THROUGHPUT_FILE, records: throughput.records.length,
                        live: throughput.live.size, api: '/throughputz' },
                    uptimeSec: Math.round(process.uptime()),
                }));
                return;
            }

            if (['GET', 'HEAD'].includes(req.method) && urlPath.startsWith('/v1/models/'))
            {
                const id = decodeURIComponent(urlPath.split('/').pop());
                if (isOpenAI(id) || providerAdapters.resolve(id) || resolveCompatibleModel(id)
                    || CLAUDE_OFFICIAL_MODELS.some((m) => m.id === id.replace(/^claude-claude-/i, 'claude-').replace(/\[1m\]/ig, '').split(':')[0]))
                {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(modelEntry(id)));
                    log(`models: served synthetic ${id}`);
                    return;
                }
            }

            if (['GET', 'HEAD'].includes(req.method) && urlPath === '/v1/models')
            {
                // Optional upstream model metadata must not make locally routed
                // providers unavailable during an Anthropic outage. Bound this
                // metadata request independently of inference retries.
                const [upstream, adapterIds] = await Promise.all([
                    fetch(ANTHROPIC + req.url, {
                        method: 'GET',
                        signal: AbortSignal.timeout(3000),
                        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_REQ.has(k.toLowerCase()))),
                    }).then(async response => response.ok ? await response.json().catch(() => null) : (await response.body?.cancel(), null)).catch(() => null),
                    providerAdapters.modelIds(),
                ]);

                let payload = { data: [], has_more: false, first_id: null, last_id: null };
                if (upstream && typeof upstream === 'object' && !Array.isArray(upstream)) payload = upstream;
                if (!Array.isArray(payload.data)) payload.data = [];

                for (const id of adapterIds)
                {
                    if (!payload.data.some((m) => m?.id === id)) payload.data.push(modelEntry(id));
                }

                // The effort-suffixed spellings are listed too. The Agent tool
                // validates a custom agent's model against this list before
                // spawning, so `gpt-5.6-sol:xhigh` has to appear here or a
                // subagent naming a tier dies client-side.
                for (const m of [...OPENAI_MODELS, ...CLAUDE_OFFICIAL_MODELS, ...providerAdapters.modelEntries(), ...compatibleModelEntries()])
                {
                    for (const id of [m.id, ...(m.efforts || []).map((e) => `${m.id}:${e}`)])
                    {
                        if (!payload.data.some((x) => x?.id === id)) payload.data.push(modelEntry(id));
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
                log(`models: list served with ${adapterIds.length} adapter entries (${payload.data.length} total)`);
                return;
            }

            // An adapter that claims a model owns every request for it. Letting
            // one fall through would answer a non-Anthropic model out of
            // Anthropic, under the requested label, and bill the wrong account.
            const adapter = body ? providerAdapters.resolve(body.model) : null;
            if (adapter)
            {
                const adapterBody = stripCheckpointMarkers(stripContextResetMarkers(body));
                if (urlPath.endsWith('/count_tokens'))
                {
                    // count_tokens is optional on the adapter interface. Without
                    // it the honest answer is 501: the client then falls back to
                    // its own estimate, which is better than a count produced by
                    // a tokenizer that is not the one about to serve the prompt.
                    if (typeof adapter.count !== 'function')
                    {
                        res.writeHead(501, { 'Content-Type': 'application/json' });
                        res.end(errorBody(`${adapter.id} does not implement native token counting`, 'not_supported_error'));
                        return;
                    }
                    await adapter.count(req, res, adapterBody);
                    return;
                }

                await adapter.handle(req, res, adapterBody);
                return;
            }

            const compatible = body ? resolveCompatibleModel(body.model) : null;
            if (body && compatible)
            {
                if (urlPath.endsWith('/count_tokens'))
                {
                    await handleCompatibleCount(req, res, body, compatible);
                    return;
                }
                await handleCompatible(req, res, body, compatible);
                return;
            }

            // Qwen was removed from the catalogue. This arm deliberately outlives
            // it: a session still pinned to a Qwen alias must get a hard 503, not
            // fall through to Anthropic and be answered as Claude under a Qwen label.
            if (body && /^(claude-)?qwen/i.test(body.model))
            {
                const error = new Error(`Qwen was removed; ${body.model} has no compatible-provider catalogue entry`);
                error.statusCode = 503;
                throw error;
            }

            if (body && isOpenAI(body.model))
            {
                // Public Responses has input_tokens, but this ChatGPT OAuth
                // endpoint does not expose it (verified 403). Tokenize locally;
                // the terminal response supplies actual usage after generation.
                if (urlPath.endsWith('/count_tokens'))
                {
                    const settings = readProviderSettings();
                    const contextSettings = readContextSettings();
                    const sessionId = req.headers['x-claude-code-session-id'];
                    const subagent = isSubagentRequest(body);
                    const state = contextSettings.enabled && contextSettings.windowReset
                        && subagent !== true && typeof sessionId === 'string'
                        ? windowStore.ensure(sessionId) : null;
                    const selection = resolvePromptPolicy(body, 'openai', settings, sessionId);
                    const built = buildResponsesRequest(body, settings, selection, {
                        restoreCompaction: restoreForSession(sessionId, subagent !== true),
                    });
                    let payload = built.req;
                    const compacted = built.restoration?.windowCuts?.some(cut => windowCutsMatch(cut, state?.cut));
                    // Claude Code asks this endpoint before deciding whether to
                    // compact. Count the same post-cut transcript inference will
                    // receive, or an old window can immediately trigger another
                    // client compaction after new_context.
                    if (state?.cut && !built.restoration?.resetIds?.length && !compacted)
                        payload = { ...payload, input: applyWindowCut(payload.input, state.cut).input };
                    const input_tokens = await estimateOpenAIInput(payload);
                    res.writeHead(200, { 'Content-Type': 'application/json',
                        'X-Cuimod-Token-Count-Source': 'o200k_base-estimate', ...promptPolicyHeaders(selection) });
                    res.end(JSON.stringify({ input_tokens }));
                    return;
                }

                if (urlPath === '/v1/messages' && await handleContextCompaction(req, res, body)) return;
                if (urlPath === '/v1/messages' && await handleCodexCompaction(req, res, body)) return;
                await handleOpenAI(req, res, body);
                return;
            }

            const status = await handlePassthrough(req, res, rawBody, body, urlPath);
            if (process.env.GEMINI_LOG_ALL === '1' || (status && status >= 400)) log(`anthropic ${status} ${Date.now() - started}ms ${urlPath.slice(0, 40)}`);
        }
        catch (e)
        {
            const gone = res.destroyed || e?.message === 'client disconnected' || (e?.name === 'AbortError' && res.writableEnded);

            if (Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode <= 599 && !res.headersSent) {
                const errorType = e.errorType || (e.statusCode === 400 ? 'invalid_request_error' : 'api_error');
                res.writeHead(e.statusCode, { 'Content-Type': 'application/json' });
                res.end(errorBody(e.message, errorType));
                return;
            }

            if (gone) { log(`client disconnected after ${Date.now() - started}ms`); try { res.end(); } catch (_) {} return; }

            const code = e?.cause?.code || e?.name || 'error';
            log(`handler error [${code}] ${e?.message || e} after ${Date.now() - started}ms`);

            // Headers already sent means we are mid-stream: the only honest
            // move is to close, because a half-written SSE body cannot be
            // corrected after the fact.
            if (res.headersSent) { try { res.end(); } catch (_) {} return; }

            // 502 rather than 500: the Anthropic SDK treats 5xx as retryable,
            // and an upstream network failure genuinely is.
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(errorBody(`bridge upstream failure [${code}]: ${String(e?.message || e).slice(0, 300)}`));
        }
    });
});

// Node's defaults are tuned for short web requests and will guillotine a long
// model stream mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 125000;
server.keepAliveTimeout = 120000;
server.timeout = 0;

server.on('clientError', (err, socket) =>
{
    // A reset socket cannot receive an HTTP error. Writing back to it can
    // trigger another clientError and flood the daemon log indefinitely.
    if (err?.code === 'ECONNRESET' || !socket.writable || socket.destroyed) {
        socket.destroy();
        return;
    }
    log(`clientError ${err?.code || err?.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', () => socket.destroy());
});

// The pure helpers are what selftest.mjs imports directly, so binding the port
// has to be conditional on being run as the entry point rather than imported.
// Re-exported for the tests that already import them from here. The
// definitions live in relay.mjs now; this keeps one import path for callers
// that want "whatever the router uses".
export { prepareProviderBody, stripClientIdentity, hoistToolResultImages };
export { isOpenAI, parseOpenAIModel, buildResponsesRequest, OPENAI_MODELS };
export { resolveCompatibleModel, prepareCompatibleBody };
export { accounting, compactionStore, providerAdapters, providerLimits, resetCredits, server, usageAnalytics, usageLedger, windowStore };
export { isSubagentRequest, throughput };

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint)
{
    process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.stack || e}`));
    process.on('uncaughtException', (e) => log(`uncaughtException: ${e?.stack || e}`));
    server.on('error', (e) => {
        log(`router listen failed: ${e.code || e.message}`);
        process.exitCode = 1;
    });
    server.listen(PORT, '127.0.0.1', () => log(`listening 127.0.0.1:${PORT} -> anthropic=${ANTHROPIC}`
        + ` adapters=[${providerAdapters.adapters.map(a => a.id).join(',') || 'none'}]`));
}
