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
// The name the provider itself knows the model by. Adapters claim id prefixes
// ahead of this registry, so a provider serving a model an adapter already
// claims needs its own catalogue alias and must still send its own name.
const UPSTREAM_ID = /^[a-z0-9][a-z0-9._/-]{0,255}$/i;
const HEADERS = new Set(['x-api-key', 'authorization']);
// Local exact counters, for providers that have no count_tokens endpoint.
const COUNTERS = new Set(['deepseek-v4.1-fireworks', 'glm-5.3-fireworks']);

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
        if (value.upstreamId !== undefined && (typeof value.upstreamId !== 'string' || !UPSTREAM_ID.test(value.upstreamId)))
            throw new Error(`${value.id}: invalid upstreamId`);
        if (value.counter !== undefined && !COUNTERS.has(value.counter)) throw new Error(`${value.id}: unknown counter ${value.counter}`);
        // effortField names the request field the provider reads its reasoning
        // budget from; effortValues maps each picker tier onto that field's value.
        if (value.effortField !== undefined && (!/^[a-z_]{1,64}$/.test(value.effortField)
            || !value.effortValues || typeof value.effortValues !== 'object'
            || !Object.values(value.effortValues).every(v => typeof v === 'string' || Number.isInteger(v))))
            throw new Error(`${value.id}: invalid effortField/effortValues`);
        const model = {
            id: value.id,
            upstreamId: value.upstreamId || value.id,
            counter: value.counter || null,
            defaultEffort: typeof value.defaultEffort === 'string' ? value.defaultEffort : null,
            effortField: value.effortField || null,
            effortValues: value.effortField ? { ...value.effortValues } : null,
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
            let values;
            try { values = JSON.parse(raw.replace(/^﻿/, '')); }
            catch (_) { throw new Error('provider secrets file is not valid JSON'); }
            if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('provider secrets must be an object');
            secrets = { raw, values };
        }
        secretsError = null;
    }
    // /healthz publishes this string. A JSON.parse message quotes the text it
    // choked on, which here is a credential file, and an fs error carries the
    // absolute path, so only messages written above are passed through.
    catch (error) { secretsError = error?.code === 'ENOENT' ? 'provider secrets file is missing'
        : error?.code ? 'provider secrets file could not be read'
        : /^provider secrets (file is not valid JSON|must be an object)$/.test(error?.message) ? error.message
        : 'provider secrets file could not be read'; }
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
            // A tier can be valid without being a slider stop: the native
            // selector rejects ids like `none`, so they live only in effortValues
            // and arrive as a model suffix. Missing one here would fall through
            // to Anthropic under this provider's label.
            if (candidate?.efforts.includes(requested) || (candidate?.effortValues && Object.hasOwn(candidate.effortValues, requested)))
            { model = candidate; effort = requested; }
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
