'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'vendor', 'claude-code-frontend');

test('a clean checkout includes the approved frontend and every recorded asset', () => {
    assert.ok(fs.existsSync(path.join(BUNDLE, 'release.json')), 'approved frontend release must ship in the repository');
    const { verifyBundle } = require('../lib/frontend-assets');
    const result = verifyBundle(BUNDLE);
    assert.deepEqual(result.problems, []);
    assert.ok(result.assets > 0);
});

test('public packaging retains the frontend pin, tests and bundled assets', () => {
    const manifest = path.join(ROOT, 'scripts', 'publish-public.mjs');
    if (!fs.existsSync(manifest)) return; // The exported tree has no export script.
    const source = fs.readFileSync(manifest, 'utf8');
    assert.doesNotMatch(source, /\['src\/plugins\/frontend-pin'/);
    assert.doesNotMatch(source, /\[\/\^tests\\\/frontend-pin-/);
});

test('asset URLs stay inside the original directory and ignore query strings', () => {
    const { assetName, ASSET_ROOT } = require('../lib/frontend-assets');
    assert.equal(assetName(ASSET_ROOT + 'index-Cuw5J4F9.js?cold=1'), 'index-Cuw5J4F9.js');
    assert.equal(assetName(ASSET_ROOT + '../secret.json'), null);
    assert.equal(assetName(ASSET_ROOT + 'folder/secret.json'), null);
    assert.equal(assetName(ASSET_ROOT + '%2e%2e%2fsecret.json'), null);
    assert.equal(assetName('https://other.example/index-Cuw5J4F9.js'), null);
});

test('reference discovery includes Vite tables, workers and CSS without treating prose as assets', () => {
    const { assetReferences, ASSET_ROOT } = require('../lib/frontend-assets');
    const source = 'import "./entry-ABCDEF12.js"; const deps=["font-ABCD1234.woff2"]; '
        + 'const prose="Changed `managed-settings.json` and `firebase-messaging-sw.js`"; '
        + 'const imports={"./clarkdown_editor_bg.js":{}}; '
        + 'const worker=new URL("worker-abcdefgh.js",import.meta.url); '
        + 'const regex=/["\\\']/;const icon="' + ASSET_ROOT + 'icon-ABCDEFGH.svg";';
    assert.deepEqual(assetReferences(source, 'entry-ABCDEFGH.js'), [
        'entry-ABCDEF12.js', 'font-ABCD1234.woff2', 'icon-ABCDEFGH.svg', 'worker-abcdefgh.js',
    ]);
    assert.deepEqual(assetReferences('a{src:url("./font-abcdefgh.woff2")}b{background:url(data:image/png;base64,AA)}', 'theme-ABCDEFGH.css'), ['font-abcdefgh.woff2']);
});

test('corrupt bundled bytes fail the exact hash check and intact bytes pass it', async () => {
    const { createAssetStore, readRelease, sha256 } = require('../lib/frontend-assets');
    const dir = fs.mkdtempSync(path.join(process.env.CUIMOD_TEST_TMP || os.tmpdir(), 'cuimod-frontend-'));
    try {
        fs.mkdirSync(path.join(dir, 'assets'));
        const release = readRelease(BUNDLE);
        const raw = Buffer.from('export default 1;');
        release.assets[release.entry] = { sha256: sha256(raw), bytes: raw.length, mediaType: 'text/javascript', dependencies: [] };
        fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
        const file = path.join(dir, 'assets', release.entry + '.gz');
        fs.writeFileSync(file, zlib.gzipSync(Buffer.from('export default 2;')));
        const store = createAssetStore(dir);
        await assert.rejects(store.read(release.entry), /integrity failed/);
        fs.writeFileSync(file, zlib.gzipSync(raw));
        assert.deepEqual(await store.read(release.entry), raw);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('installation refuses a missing bundle before touching the app archive', () => {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
        if (String(file) === path.join(BUNDLE, 'release.json')) throw new Error('test bundle is missing');
        return read.call(this, file, ...args);
    };
    try {
        const patch = require('../patch');
        assert.throws(() => patch.patchOne({ name: 'fixture', asar: 'never-touch-this-file' }), /bundled frontend verification failed: test bundle is missing/);
        assert.throws(() => patch.apply(), /bundled frontend verification failed: test bundle is missing/);
    } finally {
        fs.readFileSync = read;
    }
});

test('local responses carry CORS, MIME and correct single-byte-range semantics', () => {
    const { assetResponse } = require('../lib/frontend-assets');
    const bytes = Buffer.from('0123456789');
    const asset = { mediaType: 'application/wasm' };
    const full = assetResponse('full', asset, bytes);
    assert.equal(full.responseCode, 200);
    assert.equal(full.responseHeaders.find((header) => header.name === 'Access-Control-Allow-Origin').value, '*');
    const partial = assetResponse('range', asset, bytes, { Range: 'bytes=2-4' });
    assert.equal(partial.responseCode, 206);
    assert.equal(Buffer.from(partial.body, 'base64').toString(), '234');
    assert.equal(partial.responseHeaders.find((header) => header.name === 'Content-Range').value, 'bytes 2-4/10');
    assert.equal(Buffer.from(assetResponse('suffix', asset, bytes, { range: 'bytes=-2' }).body, 'base64').toString(), '89');
    assert.equal(assetResponse('bad', asset, bytes, { range: 'bytes=20-' }).responseCode, 416);
});
