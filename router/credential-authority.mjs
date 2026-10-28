// Other hosts receive access tokens only. Missing authority state is never
// permission to refresh a copied rotating credential.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = process.env.MODEL_ROUTER_AUTHORITY_FILE
    || fileURLToPath(new URL('../.state/credential-authority.json', import.meta.url));
const CLAUDE_VIEW_FILE = fileURLToPath(new URL('../.state/credential-claude-view.json', import.meta.url));

function readJSON(file)
{
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch { throw new Error('credential authority state could not be read'); }
}

export function authorityConfig()
{
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const value = readJSON(CONFIG_FILE);
    if (value?.version !== 1 || typeof value.authorityHost !== 'string' || !value.authorityHost
        || typeof value.viewFile !== 'string' || !path.isAbsolute(value.viewFile))
        throw new Error('credential authority configuration is invalid');
    return { ...value, reader: value.authorityHost.toLowerCase() !== os.hostname().toLowerCase() };
}

export function replaceCredential(file, value)
{
    const tag = `${Date.now()}-${crypto.randomUUID()}`;
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${tag}`, fs.constants.COPYFILE_EXCL);
    const tmp = `${file}.tmp-${tag}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
}

export function accessExpiry(token)
{
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp * 1000; }
    catch { return 0; }
}

function validateView(view, config, provider)
{
    const tokens = view?.[provider];
    if (view?.version !== 1 || view.authorityHost !== config.authorityHost || !tokens
        || 'refresh_token' in tokens || 'refreshToken' in tokens
        || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now())
        throw new Error('credential authority access view is invalid or expired');
    if (provider === 'openai')
    {
        if (!tokens.access_token || !tokens.account_id) throw new Error('credential authority OpenAI view is incomplete');
        return { access_token: tokens.access_token, account_id: tokens.account_id };
    }
    if (!tokens.accessToken) throw new Error('credential authority Claude view is incomplete');
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes,
        subscriptionType: tokens.subscriptionType, rateLimitTier: tokens.rateLimitTier };
}

export function readerCredential(provider)
{
    const config = authorityConfig();
    if (!config?.reader) return null;
    return validateView(readJSON(config.viewFile), config, provider);
}

function claudeSource(config)
{
    return config.reader ? config.viewFile : config.claudeViewFile || CLAUDE_VIEW_FILE;
}

export async function claudeCredential(config = authorityConfig())
{
    if (!config) throw new Error('credential authority is not configured');
    // The live Desktop keeper owns Claude OAuth, not the stale CLI login file.
    // Its hot plugin publishes exact cached expiry and never exports refresh tokens.
    return validateView(readJSON(claudeSource(config)), config, 'claude');
}

// Headers this module substituted, keyed by the object it returned, with the
// configuration and token they carry. Recovery acts only on these.
const issued = new WeakMap();

function withClaudeToken(headers, config, tokens)
{
    const next = { ...headers, authorization: `Bearer ${tokens.accessToken}` };
    delete next['x-api-key'];
    const betas = new Set(String(next['anthropic-beta'] || '').split(',').filter(Boolean));
    betas.add('oauth-2025-04-20');
    next['anthropic-beta'] = [...betas].join(',');
    issued.set(next, { config, token: tokens.accessToken });
    return next;
}

export async function authorizeClaude(headers)
{
    const config = authorityConfig();
    if (!config) return headers;
    return withClaudeToken(headers, config, await claudeCredential(config));
}

// The keeper revokes the predecessor as soon as it rotates, but the snapshot
// lags it: the Desktop plugin republishes on a 10 s tick, and a reader's copy
// waits a further 10 s handoff loop plus remoting. A request sent with the
// predecessor in that window gets 401, and Claude Code treats a 401 whose own
// token did not change as terminal. Measured 2026-10-12: rotation 03:39:51Z,
// 401 at :53.22, snapshot replaced at :57.405. So an authentication_error on
// a credential this module substituted waits, within these bounds, for a
// different snapshot token and resends. The bounds cover the ordinary
// cadence only; a skipped tick or a slow handoff still ends in the 401. The
// request's own credential is never a fallback: local callers include
// terminal CLIs on their own (possibly other-account) login and probes that
// send placeholder API keys.
const ROTATION_WAIT_MS = { local: 15000, reader: 30000 };
const ROTATION_POLL_MS = 250;
// Two resends cover two rotations inside one wait; a third 401 is returned.
const ROTATION_RETRIES = 2;
// Anthropic's 401 is a few hundred bytes sent with its headers. A body over
// either bound is relayed as it arrives and never resent.
const REJECTION_HOLD_BYTES = 64 * 1024;
const REJECTION_HOLD_MS = 5000;

// Replaced by tests so waits run on a synthetic schedule.
export const credentialClock = {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeout(ms)
    {
        let timer;
        const promise = new Promise(resolve => { timer = setTimeout(resolve, ms); });
        return { promise, cancel: () => clearTimeout(timer) };
    },
};

async function holdRejection(response)
{
    const keep = init => new Response(init, { status: response.status, statusText: response.statusText, headers: response.headers });
    if (!response.body) return { response: keep(null), body: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const expiry = credentialClock.timeout(REJECTION_HOLD_MS);
    const EXPIRED = Symbol('expired');
    const chunks = [];
    let bytes = 0;
    let pending = null;
    try
    {
        for (;;)
        {
            pending = reader.read();
            const step = await Promise.race([pending, expiry.promise.then(() => EXPIRED)]);
            if (step === EXPIRED) break;
            pending = null;
            if (step.done)
            {
                const body = Buffer.concat(chunks);
                return { response: keep(chunks.length ? body : null), body };
            }
            chunks.push(Buffer.from(step.value));
            bytes += step.value.byteLength;
            if (bytes > REJECTION_HOLD_BYTES) break;
        }
    }
    finally { expiry.cancel(); }
    // Over a bound: relay what was read, then the rest, including a read
    // still outstanding when the timer fired.
    const rest = new ReadableStream({
        start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
        async pull(controller)
        {
            const { value, done } = await (pending || reader.read());
            pending = null;
            if (done) controller.close(); else controller.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); },
    });
    return { response: keep(rest), body: null };
}

function authenticationError(body)
{
    try { return JSON.parse(body.toString('utf8'))?.error?.type === 'authentication_error'; }
    catch { return false; }
}

const configIdentity = config => JSON.stringify([config.authorityHost, config.reader, claudeSource(config)]);

async function nextGeneration(incoming, config, tried, deadline, gone)
{
    for (;;)
    {
        if (gone?.()) return null;
        let current = config;
        try { current = authorityConfig(); }
        catch { /* unreadable mid-edit: keep the frozen configuration */ }
        // Authority removed or re-pointed mid-request: stop, and never fall
        // back to the caller's own credential.
        if (!current || configIdentity(current) !== configIdentity(config)) return null;
        try
        {
            const tokens = await claudeCredential(config);
            if (!tried.has(tokens.accessToken)) return withClaudeToken(incoming, config, tokens);
        }
        catch { /* missing or expired mid-publication: keep waiting */ }
        const left = deadline - credentialClock.now();
        if (left <= 0) return null;
        await credentialClock.sleep(Math.min(ROTATION_POLL_MS, left));
    }
}

// `incoming` is what authorizeClaude was given and `sent` what it returned.
// Must run before anything is written to the client: a resend replaces the
// response, so it is only safe while the 401 is the whole answer.
export async function recoverClaudeRotation(response, incoming, sent, send, { gone, log = () => {}, waitMs } = {})
{
    const owner = issued.get(sent);
    if (response.status !== 401 || !owner) return response;
    const tried = new Set([owner.token]);
    let deadline = null;
    let started = null;
    for (let retry = 1; response.status === 401 && retry <= ROTATION_RETRIES; retry++)
    {
        const hold = await holdRejection(response);
        if (!hold.body) { log('anthropic 401 body over the hold bound; relayed without resend'); return hold.response; }
        if (!authenticationError(hold.body)) return hold.response;
        if (deadline === null)
        {
            started = credentialClock.now();
            deadline = started + (waitMs ?? ROTATION_WAIT_MS[owner.config.reader ? 'reader' : 'local']);
        }
        const next = await nextGeneration(incoming, owner.config, tried, deadline, gone);
        if (!next)
        {
            log(`anthropic 401 on the authority credential; no newer generation within ${credentialClock.now() - started}ms`);
            return hold.response;
        }
        tried.add(issued.get(next).token);
        log(`anthropic 401 on a superseded authority credential; resending with the next generation after ${credentialClock.now() - started}ms (${retry}/${ROTATION_RETRIES})`);
        response = await send(next);
    }
    return response;
}

export async function publishAccessView(openai)
{
    const config = authorityConfig();
    if (!config || config.reader) throw new Error('credential authority publication refused on a reader host');
    const claude = await claudeCredential();
    const value = { version: 1, authorityHost: config.authorityHost,
        openai: { access_token: openai.access_token, account_id: openai.account_id, expiresAt: accessExpiry(openai.access_token) },
        claude };
    let previous = null;
    try { previous = readJSON(config.viewFile); } catch {}
    const { publishedAt: _, ...prior } = previous || {};
    if (JSON.stringify(prior) !== JSON.stringify(value)) replaceCredential(config.viewFile, { ...value, publishedAt: Date.now() });
    return config.viewFile;
}
