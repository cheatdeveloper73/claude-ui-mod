// Syncs the NanoGPT catalogue entries with the model registry NanoGPT itself
// publishes. The catalogue is the only place a backend is registered, but the
// numbers in it -- context window and output cap -- were hand-entered once and
// providers revise them without notice. This re-reads the registry and rewrites
// what drifted, so a context window comes from the source instead of being
// guessed from a model family name.
//
// Pricing lives in router/pricing.mjs as a curated table, so it is not written
// from here; the script prices the registry's numbers against that table and
// reports drift with the exact block to apply.
//
// Usage: node scripts/nanogpt-sync.mjs [--check]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RATES } from '../router/pricing.mjs';

const CATALOGUE_FILE = process.env.MODEL_ROUTER_CATALOGUE_FILE
    || fileURLToPath(new URL('../src/plugins/provider-picker/catalogue.json', import.meta.url));
const SECRETS_FILE = process.env.MODEL_ROUTER_SECRETS_FILE
    || fileURLToPath(new URL('../.state/provider-secrets.json', import.meta.url));
const MODELS_URL = process.env.NANOGPT_MODELS_URL || 'https://nano-gpt.com/api/models';
const PROVIDER = 'nanogpt';

function parseJsonFile(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function readApiKey(file)
{
    if (process.env.NANOGPT_API_KEY) return process.env.NANOGPT_API_KEY;
    const values = parseJsonFile(file);
    const value = values[PROVIDER];
    return typeof value === 'string' ? value : value?.apiKey;
}

// The registry nests models under categories (models.text, models.image, ...),
// keyed by vendored id.
export function flattenRegistry(api)
{
    const groups = api?.models && typeof api.models === 'object' ? Object.values(api.models) : [];
    return groups.flatMap((group) => Object.values(group && typeof group === 'object' ? group : []))
        .filter((m) => m && typeof m.model === 'string');
}

// The catalogue carries the bare slug the Messages endpoint accepts, while the
// registry keys models by their vendored id. upstreamId records the mapping so
// later runs are exact; the first run infers it, refusing an ambiguous suffix
// -- guessing between z-ai/glm-5.3-flash and TEE/glm-5.3-flash would sync the
// numbers of the wrong deployment.
function findRegistryModel(entry, registry)
{
    if (entry.upstreamId)
        return registry.find((m) => m.model === entry.upstreamId) || null;
    const exact = registry.find((m) => m.model === entry.id);
    if (exact) return exact;
    const suffix = registry.filter((m) => m.model.endsWith('/' + entry.id));
    return suffix.length === 1 ? suffix[0] : null;
}

export function syncNanoGptCatalogue(entries, registry)
{
    const changes = [];
    const unmatched = [];
    const updated = entries.map((entry) =>
    {
        if (entry.provider !== PROVIDER) return entry;
        const model = findRegistryModel(entry, registry);
        if (!model)
        {
            unmatched.push(entry.id);
            return entry;
        }
        let out = entry;
        const set = (key, value) =>
        {
            if (!Number.isFinite(value) || out[key] === value) return;
            changes.push(`${entry.id}: ${key} ${out[key] ?? '(absent)'} -> ${value}`);
            out = { ...out, [key]: value };
        };
        if (!out.upstreamId)
        {
            changes.push(`${entry.id}: upstreamId -> ${model.model}`);
            out = { ...out, upstreamId: model.model };
        }
        set('context', model.maxInputTokens);
        set('maxOutput', model.maxOutputTokens);
        return out;
    });
    return { entries: updated, changes, unmatched };
}

// NanoGPT lists no cache-write premium, so a cache write prices as plain
// input; only the three published rates are compared. toPrecision(10) undoes
// the float noise of multiplying the registry's per-1k rate to per-1M
// (1.5e-05 * 1000 must read 0.015, not 0.015000000000000001).
const PER_MILLION = (model) => {
    const clean = (value) => Number.isFinite(value) ? Number(value.toPrecision(10)) : value;
    return {
        input: clean(model.input_price_per_million),
        cacheRead: clean(model.pricing?.cacheReadInputPer1kTokens * 1000),
        output: clean(model.output_price_per_million),
    };
};

const ratesBlock = (key, rate) => `${key}: [
    { from: null, to: null,
      input: ${rate.input}, cacheRead: ${rate.cacheRead}, cacheWrite5m: ${rate.input}, cacheWrite1h: ${rate.input}, output: ${rate.output} },
],`;

// entries must already carry upstreamId (run syncNanoGptCatalogue first).
// rates defaults to the live RATES table; tests inject synthetic ones.
export function checkNanoGptPricing(entries, registry, rates)
{
    const findings = [];
    const byId = new Map(registry.map((m) => [m.model, m]));
    for (const entry of entries)
    {
        if (entry.provider !== PROVIDER) continue;
        const key = `${PROVIDER}/${entry.id}`;
        const model = byId.get(entry.upstreamId || entry.id);
        if (!model) continue; // already reported unmatched by the sync pass
        const registryRate = PER_MILLION(model);
        const period = (rates?.[key] || []).find((p) => !p.to) || null;
        if (!period)
        {
            findings.push({ entry: entry.id, kind: 'unpriced',
                message: `unpriced: ${key} -- add to router/pricing.mjs RATES:\n${ratesBlock(key, registryRate)}` });
            continue;
        }
        const drifted = Object.entries(registryRate)
            .filter(([field, value]) => Number.isFinite(value) && Math.abs(period[field] - value) > 1e-9)
            .map(([field, value]) => `${field} ${period[field]} -> ${value}`);
        if (drifted.length)
            findings.push({ entry: entry.id, kind: 'drift',
                message: `pricing drift: ${key} ${drifted.join(', ')} -- router/pricing.mjs RATES:\n${ratesBlock(key, registryRate)}` });
        else
            findings.push({ entry: entry.id, kind: 'ok',
                message: `pricing ok: ${key} (input $${registryRate.input}/M, cache read $${registryRate.cacheRead}/M, output $${registryRate.output}/M)` });
    }
    return findings;
}

async function main()
{
    const checkOnly = process.argv.includes('--check');
    const catalogue = parseJsonFile(CATALOGUE_FILE);
    if (!Array.isArray(catalogue)) throw new Error('provider catalogue must be an array');
    if (!catalogue.some((entry) => entry?.provider === PROVIDER))
    {
        console.log(`no ${PROVIDER} entries in the catalogue; nothing to sync`);
        return;
    }
    const apiKey = readApiKey(SECRETS_FILE);
    if (!apiKey) throw new Error(`no ${PROVIDER} API key in ${SECRETS_FILE} or NANOGPT_API_KEY`);

    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`${MODELS_URL} answered ${res.status}`);
    const registry = flattenRegistry(await res.json());
    if (!registry.length) throw new Error('the NanoGPT registry carried no models');

    const { entries, changes, unmatched } = syncNanoGptCatalogue(catalogue, registry);
    if (changes.length)
    {
        console.log(changes.join('\n'));
        if (checkOnly) console.log('(check mode: catalogue not written)');
        else
        {
            const raw = fs.readFileSync(CATALOGUE_FILE, 'utf8');
            fs.writeFileSync(CATALOGUE_FILE, JSON.stringify(entries, null, 4) + (raw.endsWith('\n') ? '\n' : ''));
            console.log(`catalogue written: ${CATALOGUE_FILE}`);
        }
    }
    else console.log('catalogue already matches the registry');

    const findings = checkNanoGptPricing(entries, registry, RATES);
    for (const finding of findings) console.log(finding.message);

    // An unmatched id cannot be synced and a pricing finding means the
    // dashboard is mispricing or about to; both want a nonzero exit so the
    // problem survives being skimmed.
    if (unmatched.length || findings.some((f) => f.kind !== 'ok')) process.exitCode = 1;
    if (unmatched.length) console.error(`unmatched catalogue entries: ${unmatched.join(', ')}`);
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) await main();
