'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { ASSET_ROOT, MIME, assetName, assetReferences, sha256, verifyBundle, BUNDLE_DIR } = require('../lib/frontend-assets');

async function main() {
    const args = process.argv.slice(2);
    const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const out = value('--out');
    if (!out) throw new Error('usage: node scripts/capture-frontend.cjs --out <new-directory> [--manifest <release.json>]');
    const dir = path.resolve(out);
    if (fs.existsSync(dir) && !args.includes('--resume')) throw new Error('capture output must be a new directory (or use --resume for an interrupted capture)');
    const seed = JSON.parse(fs.readFileSync(value('--manifest') || path.join(BUNDLE_DIR, 'release.json'), 'utf8'));
    if (seed.assetRoot !== ASSET_ROOT) throw new Error('capture only accepts the approved public asset origin');
    const seeds = [seed.entry, ...Object.values(seed.stylesheets)];
    for (const name of seeds) if (assetName(ASSET_ROOT + name) !== name) throw new Error('invalid release seed: ' + name);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    const queue = [...new Set(seeds)];
    const seen = new Set(queue);
    const parents = new Map();
    const assets = {};
    while (queue.length) {
        const batch = queue.splice(0, 6);
        const results = await Promise.all(batch.map(async (name) => {
            const file = path.join(dir, 'assets', name + '.gz');
            let raw;
            let stored;
            if (args.includes('--resume') && fs.existsSync(file)) {
                stored = fs.readFileSync(file);
                raw = zlib.gunzipSync(stored);
            } else {
                let response;
                try { response = await fetch(ASSET_ROOT + name, { signal: AbortSignal.timeout(30000), redirect: 'error' }); }
                catch (error) { throw new Error(name + ': ' + error.message + ': ' + String(error.cause || ''), { cause: error }); }
                if (!response.ok) throw new Error(name + ': HTTP ' + response.status + ' (referenced by ' + (parents.get(name) || 'release manifest') + ')');
                raw = Buffer.from(await response.arrayBuffer());
                if (/\.(js|css)$/.test(name) && !/javascript|text\/css/.test(response.headers.get('content-type') || ''))
                    throw new Error(name + ': unexpected content type');
                stored = zlib.gzipSync(raw, { level: 9 });
                fs.writeFileSync(file, stored);
            }
            const mediaType = MIME[path.extname(name).slice(1)];
            const dependencies = /\.(js|css)$/.test(name) ? assetReferences(raw.toString('utf8'), name) : [];
            return { name, asset: { sha256: sha256(raw), bytes: raw.length, storedBytes: stored.length, mediaType, dependencies } };
        }));
        for (const { name, asset } of results) {
            assets[name] = asset;
            for (const dep of asset.dependencies) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                parents.set(dep, name);
                queue.push(dep);
            }
        }
        if (Object.keys(assets).length % 100 < 6) console.log('captured ' + Object.keys(assets).length + ', queued ' + queue.length);
    }
    const release = {
        schema: 1, assetRoot: ASSET_ROOT, entry: seed.entry,
        stylesheets: seed.stylesheets, flags: seed.flags,
        capturedAt: new Date().toISOString(),
        assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    };
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    const result = verifyBundle(dir);
    if (result.problems.length) throw new Error(result.problems.join('\n'));
    console.log(JSON.stringify({ ...result, storedBytes: Object.values(assets).reduce((sum, asset) => sum + asset.storedBytes, 0) }));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
