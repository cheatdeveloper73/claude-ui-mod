'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const BUNDLE_DIR = path.resolve(__dirname, '..', 'vendor', 'claude-code-frontend');
const ASSET_ROOT = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
const gunzip = promisify(zlib.gunzip);
const FILE_RE = /^[A-Za-z0-9_-]+\.(?:js|css|wasm|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|json|mp3|mp4|ogg)$/;
const HASHED_RE = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i;
const MIME = {
    js: 'text/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', mp3: 'audio/mpeg', mp4: 'video/mp4', ogg: 'audio/ogg',
};

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assetName(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    const bare = parsed.origin + parsed.pathname;
    if (!bare.startsWith(ASSET_ROOT)) return null;
    const name = bare.slice(ASSET_ROOT.length);
    return FILE_RE.test(name) ? name : null;
}

// Vite's import tables use both absolute URLs and bare hashed filenames. CSS
// url() also admits unquoted filenames. Only this CDN directory is archived;
// account URLs and runtime bootstrap data never enter the bundle.
function assetReferences(text, sourceName) {
    const names = new Set();
    const add = (value, imported = false) => {
        value = value.trim();
        if (value.startsWith('data:') || value.includes('${')) return;
        const bare = value.replace(/[?#].*$/, '');
        const hash = /-([A-Za-z0-9_-]{8})\.[a-z0-9]+$/i.exec(bare)?.[1];
        if (!imported && !value.startsWith(ASSET_ROOT)
            && !(HASHED_RE.test(bare) && /[A-Z0-9_-]/.test(hash))) return;
        let url;
        try { url = new URL(value, ASSET_ROOT + sourceName).href; } catch (_) { return; }
        const name = assetName(url);
        if (name) names.add(name);
    };
    // Consume whole string literals: a backticked filename inside a quoted
    // changelog paragraph is prose, and Wasm import-object keys are not files.
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g)) {
        const value = match[0].slice(1, -1);
        if (value.length <= 300) add(value);
    }
    // Regex literals may contain quote characters. Sweep exact asset-shaped
    // literals independently so one cannot hide later URLs from the string walk.
    for (const match of text.matchAll(/["'`]((?:https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/|\.\/)?[A-Za-z0-9_-]+\.(?:js|css|wasm|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|json|mp3|mp4|ogg))["'`]/g)) add(match[1]);
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'])(\.\/[^"'\r\n]+)\1/g)) add(match[2], true);
    for (const match of text.matchAll(/new URL\(\s*(["'])([^"'\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)) add(match[2], true);
    if (sourceName.endsWith('.css')) {
        for (const match of text.matchAll(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/g)) add(match[2], true);
    }
    return [...names].sort();
}

function readRelease(dir = BUNDLE_DIR) {
    const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
    if (release.schema !== 1 || release.assetRoot !== ASSET_ROOT || !FILE_RE.test(release.entry)
        || !release.assets || !release.stylesheets || !release.flags) throw new Error('invalid frontend release manifest');
    for (const name of [release.entry, ...Object.values(release.stylesheets)]) {
        if (!FILE_RE.test(name) || !release.assets[name]) throw new Error('missing release asset: ' + name);
    }
    for (const [name, asset] of Object.entries(release.assets)) {
        if (!FILE_RE.test(name) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.bytes)
            || asset.bytes < 0 || !Array.isArray(asset.dependencies)) throw new Error('invalid asset record: ' + name);
    }
    return release;
}

function checkBytes(name, asset, bytes) {
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error('frontend asset integrity failed: ' + name);
    return bytes;
}

function verifyBundle(dir = BUNDLE_DIR) {
    const problems = [];
    let release;
    try { release = readRelease(dir); } catch (error) { return { assets: 0, bytes: 0, problems: [error.message] }; }
    let bytes = 0;
    for (const [name, asset] of Object.entries(release.assets)) {
        try {
            const raw = checkBytes(name, asset, zlib.gunzipSync(fs.readFileSync(path.join(dir, 'assets', name + '.gz'))));
            bytes += raw.length;
            if (/\.(js|css)$/.test(name)) {
                const dependencies = assetReferences(raw.toString('utf8'), name);
                if (JSON.stringify(dependencies) !== JSON.stringify(asset.dependencies)) problems.push('dependency inventory differs: ' + name);
                for (const dep of dependencies) if (!release.assets[dep]) problems.push(name + ' references missing asset: ' + dep);
            }
        } catch (error) { problems.push(error.message); }
    }
    return { assets: Object.keys(release.assets).length, bytes, problems };
}

function createAssetStore(dir = BUNDLE_DIR) {
    const release = readRelease(dir);
    const cache = new Map();
    let cachedBytes = 0;
    const limit = 32 * 1024 * 1024;
    async function read(name) {
        const asset = release.assets[name];
        if (!asset || !FILE_RE.test(name)) throw new Error('frontend asset is not bundled: ' + name);
        if (cache.has(name)) {
            const bytes = cache.get(name);
            cache.delete(name);
            cache.set(name, bytes);
            return bytes;
        }
        const stored = await fs.promises.readFile(path.join(dir, 'assets', name + '.gz'));
        const bytes = checkBytes(name, asset, await gunzip(stored));
        if (cache.has(name)) return cache.get(name);
        cache.set(name, bytes);
        cachedBytes += bytes.length;
        while (cachedBytes > limit && cache.size > 1) {
            const oldest = cache.keys().next().value;
            cachedBytes -= cache.get(oldest).length;
            cache.delete(oldest);
        }
        return bytes;
    }
    return { release, read };
}

function assetResponse(requestId, asset, bytes, headers = {}) {
    const responseHeaders = [
        { name: 'Content-Type', value: asset.mediaType },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        { name: 'Cache-Control', value: 'no-store' },
        { name: 'Accept-Ranges', value: 'bytes' },
    ];
    const range = Object.entries(headers).find(([key]) => key.toLowerCase() === 'range')?.[1];
    let responseCode = 200;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
        const end = match?.[1] && match?.[2] ? Number(match[2]) : bytes.length - 1;
        if (!match || (!match[1] && !match[2]) || start > end || start >= bytes.length) {
            responseCode = 416;
            responseHeaders.push({ name: 'Content-Range', value: 'bytes */' + bytes.length });
            bytes = Buffer.alloc(0);
        } else {
            responseCode = 206;
            const last = Math.min(end, bytes.length - 1);
            responseHeaders.push({ name: 'Content-Range', value: 'bytes ' + start + '-' + last + '/' + bytes.length });
            bytes = bytes.subarray(start, last + 1);
        }
    }
    responseHeaders.push({ name: 'Content-Length', value: String(bytes.length) });
    return { requestId, responseCode, responseHeaders, body: bytes.toString('base64') };
}

module.exports = { ASSET_ROOT, BUNDLE_DIR, MIME, assetName, assetReferences, sha256, readRelease, verifyBundle, createAssetStore, assetResponse };
