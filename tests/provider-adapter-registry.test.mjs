// The adapter registry is the public extension point, so its failure modes
// matter more than its happy path: a router that dies because someone dropped a
// broken directory into router/adapters is worse than no adapter at all.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdapterRegistry, discover } from '../router/adapter-registry.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-registry-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

let counter = 0;
function adapterDir(files) {
    const dir = path.join(temp, `case-${++counter}`);
    for (const [name, source] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const logged = [];
const kit = { log: message => logged.push(message), stateDir: temp, accountingDir: temp, recordUsage() {}, throughput: null };

const WORKING = `export default function (kit) {
    return {
        id: 'acme', provider: 'acme', limitKey: 'acme',
        models: [{ id: 'acme-1', name: 'Acme One', efforts: ['low', 'high'] }],
        claims: (model) => /^(claude-)?acme/i.test(String(model)),
        handle: async () => {},
        count: async () => {},
        modelIds: async () => ['acme-1', 'acme-live'],
        limits: async (force) => ({ source: 'acme.fixture', forced: force === true, accounts: [] }),
        health: () => ({ ready: true }),
    };
}`;

test('an absent adapter directory is a normal, empty registry', async () => {
    const registry = await AdapterRegistry.load(kit, path.join(temp, 'does-not-exist'));
    assert.deepEqual(registry.adapters, []);
    assert.deepEqual(registry.errors, []);
    assert.equal(registry.resolve('acme-1'), null);
    assert.deepEqual(registry.modelEntries(), []);
    assert.deepEqual(await registry.modelIds(), []);
    assert.deepEqual(await registry.limitSnapshots(false), {});
});

test('a directory without index.mjs is skipped, not an error', async () => {
    const dir = adapterDir({ 'README.md': '# how to write one', 'notes/thoughts.txt': 'wip' });
    assert.deepEqual(discover(dir), []);
    const registry = await AdapterRegistry.load(kit, dir);
    assert.deepEqual(registry.adapters, []);
    assert.deepEqual(registry.errors, []);
});

test('a working adapter contributes models, ids and limits under its key', async () => {
    const registry = await AdapterRegistry.load(kit, adapterDir({ 'acme/index.mjs': WORKING }));
    assert.deepEqual(registry.adapters.map(a => a.id), ['acme']);
    assert.equal(registry.resolve('claude-acme-1[1m]').id, 'acme');
    assert.equal(registry.resolve('gpt-5.6-sol'), null);
    assert.deepEqual(registry.modelEntries().map(m => m.id), ['acme-1']);
    assert.deepEqual(await registry.modelIds(), ['acme-1', 'acme-live']);

    const limits = await registry.limitSnapshots(true);
    assert.equal(limits.acme.source, 'acme.fixture');
    assert.equal(limits.acme.forced, true, 'force must reach the adapter');
});

test('a broken adapter is recorded and skipped while the rest still load', async () => {
    const dir = adapterDir({
        'acme/index.mjs': WORKING,
        'exploding/index.mjs': 'export default function () { throw new Error("boom"); }',
        'no-default/index.mjs': 'export const something = 1;',
        'half-built/index.mjs': 'export default function () { return { id: "half" }; }',
        'bad-syntax/index.mjs': 'export default function ( {',
    });
    const registry = await AdapterRegistry.load(kit, dir);

    assert.deepEqual(registry.adapters.map(a => a.id), ['acme'], 'the working adapter still loads');
    assert.deepEqual(registry.errors.map(e => e.adapter).sort(), ['bad-syntax', 'exploding', 'half-built', 'no-default']);
    assert.match(registry.errors.find(e => e.adapter === 'exploding').error, /boom/);
    assert.match(registry.errors.find(e => e.adapter === 'half-built').error, /claims\(\) and handle\(\)/);

    // /healthz has to name what was rejected, or a silently missing provider
    // looks like a routing bug rather than a broken adapter.
    const health = registry.health();
    assert.equal(health.errors.length, 4);
    assert.deepEqual(health.loaded.map(row => row.id), ['acme']);
    assert.equal(health.loaded[0].ready, true);
});

test('one adapter failing at request time cannot empty the others', async () => {
    const dir = adapterDir({
        'acme/index.mjs': WORKING,
        'flaky/index.mjs': `export default function () {
            return {
                id: 'flaky', provider: 'flaky',
                claims: () => false,
                handle: async () => {},
                modelIds: async () => { throw new Error('backend down'); },
                limits: async () => { throw new Error('backend down'); },
                health: () => { throw new Error('backend down'); },
            };
        }`,
    });
    const registry = await AdapterRegistry.load(kit, dir);

    assert.deepEqual(await registry.modelIds(), ['acme-1', 'acme-live'], 'a dead backend contributes nothing, not an exception');

    const limits = await registry.limitSnapshots(false);
    assert.equal(limits.acme.source, 'acme.fixture');
    assert.match(limits.flaky.error, /backend down/);

    const health = registry.health();
    assert.match(health.loaded.find(row => row.id === 'flaky').error, /backend down/);
});

test('a throwing claims() cannot break resolution for other adapters', async () => {
    const dir = adapterDir({
        'angry/index.mjs': `export default function () {
            return { id: 'angry', provider: 'angry', claims: () => { throw new Error('nope'); }, handle: async () => {} };
        }`,
        'zzz-acme/index.mjs': WORKING,
    });
    const registry = await AdapterRegistry.load(kit, dir);
    assert.equal(registry.resolve('acme-1').id, 'acme');
    assert.equal(registry.resolve('unclaimed-model'), null);
});

test('adapters load in directory-name order so routing is deterministic', async () => {
    const one = `export default () => ({ id: 'one', provider: 'one', claims: () => true, handle: async () => {} });`;
    const two = `export default () => ({ id: 'two', provider: 'two', claims: () => true, handle: async () => {} });`;
    const dir = adapterDir({ 'b-two/index.mjs': two, 'a-one/index.mjs': one });
    const registry = await AdapterRegistry.load(kit, dir);
    assert.deepEqual(registry.adapters.map(a => a.id), ['one', 'two']);
    assert.equal(registry.resolve('anything').id, 'one', 'the first adapter in name order wins a contested model');
});
