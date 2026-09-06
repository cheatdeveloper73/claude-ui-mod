// Hot-loaded registry for providers that already speak Anthropic Messages.
// Catalogue and credential edits apply to the next request. A malformed edit
// keeps the last parsed value, so one provider cannot take down the router.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOGUE_FILE = process.env.MODEL_ROUTER_CATALOGUE_FILE
    || fileURLToPath(new URL('../src/plugins/provider-picker/catalogue.json', import.meta.url));
const SECRETS_FILE = process.env.MODEL_ROUTER_SECRETS_FILE
    || fileURLToPath(new URL('../.state/provider-secrets.json', import.meta.url));

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const HEADERS = new Set(['x-api-key', 'authorization']);

let catalogue = { raw: null, models: new Map(), providers: new Map() };
let secrets = { raw: null, values: {} };
let catalogueError = null;
let secretsError = null;

function backend(value, provider)
{
    if (!value || value.protocol !== 'anthropic-messages') throw new Error(`${provider}: unsupported compatible-provider protocol`);
    const url = new URL(value.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
        throw new Error(`${provider}: baseUrl must use HTTPS or loopback HTTP`);
    const apiKeyHeader = String(value.apiKeyHeader || 'x-api-key').toLowerCase();
    if (!HEADERS.has(apiKeyHeader)) throw new Error(`${provider}: unsupported API-key header`);
    const secret = String(value.secret || provider);
    if (!ID.test(secret)) throw new Error(`${provider}: invalid secret key`);
    return { protocol: value.protocol, baseUrl: url.href.replace(/\/$/, ''), apiKeyHeader, secret };
}

function parseCatalogue(raw)
{
    const values = JSON.parse(raw.replace(/^﻿/, ''));
    if (!Array.isArray(values)) throw new Error('provider catalogue must be an array');
    const models = new Map();
    const providers = new Map();

    for (const value of values)
    {
        if (!value?.backend) continue;
        if (!ID.test(value.id) || !ID.test(value.provider)) throw new Error('compatible provider has an invalid model or provider id');
        const route = backend(value.backend, value.provider);
        const prior = providers.get(value.provider);
        if (prior && JSON.stringify(prior.route) !== JSON.stringify(route)) throw new Error(`${value.provider}: models disagree on backend configuration`);
        const model = {
            id: value.id,
            name: typeof value.name === 'string' ? value.name : value.id,
            provider: value.provider,
            efforts: Array.isArray(value.efforts) ? value.efforts.filter((effort) => typeof effort === 'string') : [],
            route,
        };
        const key = value.id.toLowerCase();
        if (models.has(key)) throw new Error(`duplicate compatible model ${value.id}`);
        models.set(key, model);
        if (!prior) providers.set(value.provider, { id: value.provider, route, models: [] });
        providers.get(value.provider).models.push(value.id);
    }

    return { raw, models, providers };
}

// A deployment may carry models the published tree does not. They live in a
// sibling private catalogue, are read the same way, and are concatenated before
// parsing so a duplicate id is still caught. Absent is the normal case.
const PRIVATE_CATALOGUE_FILE = CATALOGUE_FILE.replace(/catalogue\.json$/, 'catalogue.private.json');

function loadCatalogue()
{
    try
    {
        let raw = fs.readFileSync(CATALOGUE_FILE, 'utf8');
        try
        {
            const extra = fs.readFileSync(PRIVATE_CATALOGUE_FILE, 'utf8');
            raw = JSON.stringify([...JSON.parse(raw.replace(/^﻿/, '')), ...JSON.parse(extra.replace(/^﻿/, ''))]);
        }
        catch (_) {}
        if (raw !== catalogue.raw) catalogue = parseCatalogue(raw);
        catalogueError = null;
    }
    catch (error) { catalogueError = String(error?.message || error); }
    return catalogue;
}

function loadSecrets()
{
    try
    {
        const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
        if (raw !== secrets.raw)
        {
            const values = JSON.parse(raw.replace(/^﻿/, ''));
            if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('provider secrets must be an object');
            secrets = { raw, values };
        }
        secretsError = null;
    }
    catch (error) { secretsError = String(error?.message || error); }
    return secrets.values;
}

export function stripCompatibleModel(raw)
{
    return String(raw || '').replace(/^claude-/i, '').replace(/\[1m\]/ig, '');
}

export function resolveCompatibleModel(raw)
{
    const bare = stripCompatibleModel(raw);
    const current = loadCatalogue();
    let model = current.models.get(bare.toLowerCase());
    let effort = null;

    if (!model)
    {
        const at = bare.lastIndexOf(':');
        if (at !== -1)
        {
            const candidate = current.models.get(bare.slice(0, at).toLowerCase());
            const requested = bare.slice(at + 1).toLowerCase();
            if (candidate?.efforts.includes(requested)) { model = candidate; effort = requested; }
        }
    }

    return model ? { ...model, effort } : null;
}

export function compatibleCredentials(model)
{
    const value = loadSecrets()[model.route.secret];
    const apiKey = typeof value === 'string' ? value : value?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) throw new Error(`no apiKey for provider ${model.provider} in ${SECRETS_FILE}`);
    return { apiKey };
}

export function compatibleHeaders(model, requestHeaders = {})
{
    const { apiKey } = compatibleCredentials(model);
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': requestHeaders['anthropic-version'] || '2023-06-01',
    };
    headers[model.route.apiKeyHeader] = model.route.apiKeyHeader === 'authorization' ? `Bearer ${apiKey}` : apiKey;
    return headers;
}

export function compatibleModelEntries()
{
    return [...loadCatalogue().models.values()];
}

export function compatibleStatus()
{
    const current = loadCatalogue();
    const values = loadSecrets();
    return {
        catalogueFile: CATALOGUE_FILE,
        secretsFile: SECRETS_FILE,
        catalogueError,
        secretsError,
        providers: [...current.providers.values()].map((provider) => {
            const secret = values[provider.route.secret];
            return {
                id: provider.id,
                protocol: provider.route.protocol,
                baseUrl: provider.route.baseUrl,
                models: provider.models,
                ready: !!(typeof secret === 'string' ? secret : secret?.apiKey),
            };
        }),
    };
}

export { CATALOGUE_FILE, SECRETS_FILE };
