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

export async function claudeCredential()
{
    const config = authorityConfig();
    if (!config) throw new Error('credential authority is not configured');
    // The live Desktop keeper owns Claude OAuth, not the stale CLI login file.
    // Its hot plugin publishes exact cached expiry and never exports refresh tokens.
    return validateView(readJSON(config.reader ? config.viewFile : config.claudeViewFile || CLAUDE_VIEW_FILE), config, 'claude');
}

export async function authorizeClaude(headers)
{
    if (!authorityConfig()) return headers;
    const tokens = await claudeCredential();
    const next = { ...headers, authorization: `Bearer ${tokens.accessToken}` };
    delete next['x-api-key'];
    const betas = new Set(String(next['anthropic-beta'] || '').split(',').filter(Boolean));
    betas.add('oauth-2025-04-20');
    next['anthropic-beta'] = [...betas].join(',');
    return next;
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
