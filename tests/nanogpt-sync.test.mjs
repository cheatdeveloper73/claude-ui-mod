// The NanoGPT sync script, against a stub registry. No NanoGPT calls.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flattenRegistry, syncNanoGptCatalogue, checkNanoGptPricing } from '../scripts/nanogpt-sync.mjs';

const temps = [];
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

function tempRoot(label)
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nanogpt-sync-${label}-`));
    temps.push(dir);
    return dir;
}

const nanogptEntry = (overrides = {}) => ({
    id: 'glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    efforts: [],
    provider: 'nanogpt',
    context: 1000,
    ...overrides,
});

const registryModel = (overrides = {}) => ({
    model: 'z-ai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    input_price_per_million: 0.075,
    output_price_per_million: 0.25,
    pricing: { cacheReadInputPer1kTokens: 1.5e-05 },
    ...overrides,
});

// ------------------------------------------------------------- catalogue ---

test('sync patches context, output cap and upstream id from the registry', () => {
    const { entries, changes, unmatched } = syncNanoGptCatalogue(
        [nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash' })],
        [registryModel()]);
    assert.deepEqual(unmatched, []);
    assert.deepEqual(entries[0].context, 1048576);
    assert.deepEqual(entries[0].maxOutput, 131072);
    assert.equal(changes.length, 2);
});

test('sync infers a unique vendored id and refuses an ambiguous one', () => {
    const unique = syncNanoGptCatalogue([nanogptEntry()], [registryModel()]);
    assert.deepEqual(unique.unmatched, []);
    assert.equal(unique.entries[0].upstreamId, 'z-ai/glm-5.3-flash');
    assert.equal(unique.entries[0].context, 1048576);

    // z-ai/ and TEE/ both end in /glm-5.3-flash; picking one would sync the
    // numbers of the wrong deployment.
    const ambiguous = syncNanoGptCatalogue([nanogptEntry()], [
        registryModel(),
        registryModel({ model: 'TEE/glm-5.3-flash', maxInputTokens: 999 }),
    ]);
    assert.deepEqual(ambiguous.unmatched, ['glm-5.3-flash']);
    assert.equal(ambiguous.entries[0].context, 1000);
    assert.equal(ambiguous.entries[0].upstreamId, undefined);
});

test('an exact id match wins over a suffix match', () => {
    const { entries } = syncNanoGptCatalogue(
        [nanogptEntry()],
        [registryModel({ model: 'glm-5.3-flash', maxInputTokens: 555 }), registryModel()]);
    assert.equal(entries[0].upstreamId, 'glm-5.3-flash');
    assert.equal(entries[0].context, 555);
});

test('a settled catalogue is idempotent and other providers are untouched', () => {
    const settled = nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash', context: 1048576, maxOutput: 131072 });
    const claude = { id: 'claude-opus-5', name: 'Claude', provider: 'claude', context: 200000 };
    const registry = [registryModel()];
    const once = syncNanoGptCatalogue([claude, settled], registry);
    assert.deepEqual(once.changes, []);
    assert.equal(once.entries[0], claude, 'the non-nanogpt entry must be the same object, not a copy');
    const twice = syncNanoGptCatalogue(once.entries, registry);
    assert.deepEqual(twice.changes, []);
});

test('a missing or non-finite registry number never overwrites the catalogue', () => {
    const { entries, changes } = syncNanoGptCatalogue(
        [nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash', context: 1000, maxOutput: 64000 })],
        [registryModel({ maxInputTokens: undefined, maxOutputTokens: 'lots' })]);
    assert.equal(entries[0].context, 1000);
    assert.equal(entries[0].maxOutput, 64000);
    assert.deepEqual(changes, []);
});

// --------------------------------------------------------------- pricing ---

const RATES = {
    'nanogpt/glm-5.3-flash': [
        { from: null, to: null, input: 0.075, cacheRead: 0.015, cacheWrite5m: 0.075, cacheWrite1h: 0.075, output: 0.25 },
    ],
};

test('matching registry and table rates read as ok', () => {
    const findings = checkNanoGptPricing(
        [nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash' })], [registryModel()], RATES);
    assert.deepEqual(findings.map(f => f.kind), ['ok']);
});

test('drifted and unpriced models name the correction', () => {
    const drifted = checkNanoGptPricing(
        [nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash' })],
        [registryModel({ output_price_per_million: 0.5 })], RATES);
    assert.equal(drifted[0].kind, 'drift');
    assert.match(drifted[0].message, /output 0\.25 -> 0\.5/);

    const unpriced = checkNanoGptPricing(
        [nanogptEntry({ id: 'other-model', upstreamId: 'z-ai/other-model' })],
        [registryModel({ model: 'z-ai/other-model' })], RATES);
    assert.equal(unpriced[0].kind, 'unpriced');
    assert.match(unpriced[0].message, /nanogpt\/other-model/);
});

// ---------------------------------------------------------- end to end ---

test('the script rewrites the catalogue in place and honours --check', () => {
    const dir = tempRoot('e2e');
    const catalogue = path.join(dir, 'catalogue.json');
    const secrets = path.join(dir, 'secrets.json');
    const settled = nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash', context: 1048576, maxOutput: 131072 });
    const stale = nanogptEntry({ upstreamId: 'z-ai/glm-5.3-flash' });
    fs.writeFileSync(secrets, JSON.stringify({ nanogpt: 'test-only' }));

    // A data: URL rather than a local HTTP stub: spawnSync blocks this
    // process's event loop, so a server hosted here could never answer the
    // child's fetch and the two would deadlock.
    const registryUrl = 'data:application/json;base64,'
        + Buffer.from(JSON.stringify({ models: { text: {
            'z-ai/glm-5.3-flash': registryModel(),
            // Known to the registry, absent from RATES: the unpriced exit.
            'z-ai/fake-model': registryModel({ model: 'z-ai/fake-model' }),
        } } })).toString('base64');

    const run = (args) => spawnSync(process.execPath,
        [fileURLToPath(new URL('../scripts/nanogpt-sync.mjs', import.meta.url)), ...args],
        { encoding: 'utf8', env: { ...process.env,
            MODEL_ROUTER_CATALOGUE_FILE: catalogue,
            MODEL_ROUTER_SECRETS_FILE: secrets,
            NANOGPT_MODELS_URL: registryUrl,
            NANOGPT_API_KEY: 'test-only' }, timeout: 30000 });

    // The real RATES table prices glm-5.3-flash, so the settled catalogue
    // passes both gates; a synthetic id exercises the unpriced exit below.
    fs.writeFileSync(catalogue, JSON.stringify([settled], null, 4) + '\n');
    const settledRun = run(['--check']);
    assert.equal(settledRun.status, 0, settledRun.stderr);
    assert.match(settledRun.stdout, /already matches/);
    assert.match(settledRun.stdout, /pricing ok: nanogpt\/glm-5\.3-flash/);

    fs.writeFileSync(catalogue, JSON.stringify([stale], null, 4) + '\n');
    const checked = run(['--check']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /context 1000 -> 1048576/);
    assert.match(checked.stdout, /check mode: catalogue not written/);
    assert.doesNotMatch(fs.readFileSync(catalogue, 'utf8'), /1048576/, '--check must not write');

    const applied = run([]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /catalogue written/);
    const written = JSON.parse(fs.readFileSync(catalogue, 'utf8'));
    assert.equal(written[0].context, 1048576);
    assert.equal(written[0].maxOutput, 131072);

    const rerun = run([]);
    assert.match(rerun.stdout, /already matches/);

    const unpriced = nanogptEntry({
        id: 'fake-model', upstreamId: 'z-ai/fake-model', context: 1048576, maxOutput: 131072,
    });
    fs.writeFileSync(catalogue, JSON.stringify([unpriced], null, 4) + '\n');
    const failed = run(['--check']);
    assert.equal(failed.status, 1, 'an unpriced model must fail the check');
    assert.match(failed.stdout, /unpriced: nanogpt\/fake-model/);
});

test('flattenRegistry walks every category and drops shapeless rows', () => {
    const registry = flattenRegistry({
        models: {
            text: { a: registryModel(), b: { name: 'no model field' } },
            image: { c: registryModel({ model: 'img/one' }) },
            broken: null,
        },
    });
    assert.deepEqual(registry.map(m => m.model), ['z-ai/glm-5.3-flash', 'img/one']);
});
