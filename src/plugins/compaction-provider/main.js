/* claude-ui-mod :: compaction-provider (main)
 *
 * Exposes the router's sanitized checkpoint status to the isolated renderer.
 * Compacted history and encrypted provider state never cross this RPC.
 */
'use strict';
const http = require('http');

const ROUTER = process.env.CUIMOD_ROUTER_URL || 'http://127.0.0.1:8789';
const SESSION_RE = /^[0-9a-fA-F-]{8,64}$/;
const ASSET_RE = /^https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/[A-Za-z0-9_.-]+\.js(?:\?.*)?$/;
const STORE_CHUNK_RE = /\/c06cf64bb-[A-Za-z0-9_-]+\.js(?:\?.*)?$/;

function nativeStatusPatch(enabled, urls, owner) {
    const input = JSON.stringify((Array.isArray(urls) ? urls : []).filter(url => typeof url === 'string' && ASSET_RE.test(url)));
    const ownerText = JSON.stringify(typeof owner === 'string' ? owner.slice(0, 100) : '');
    return `(async () => {
        const key = '__cuimodNativeCompactStatus';
        const owner = ${ownerText};
        const old = globalThis[key];
        if (!${enabled ? 'true' : 'false'}) {
            if (old?.owner === owner && old.store.getState().markCompacting === old.patched) {
                old.store.setState({ markCompacting: old.original });
                delete globalThis[key];
            }
            return { installed: false };
        }
        if (old) { old.owner = owner; return { installed: true }; }
        const urls = ${input};
        const url = urls.find(value => ${STORE_CHUNK_RE}.test(value));
        if (!url) return { installed: false, reason: 'store-chunk-unavailable' };
        let mod;
        try { mod = await import(url); }
        catch (_) { return { installed: false, reason: 'store-chunk-import-failed' }; }
        const store = Object.values(mod).find(value => {
            if (!value || typeof value.getState !== 'function' || typeof value.setState !== 'function') return false;
            const state = value.getState();
            return state?.buckets && typeof state.markCompacting === 'function';
        });
        if (!store) return { installed: false, reason: 'activity-store-unavailable' };
        const original = store.getState().markCompacting;
        const hold = sessionId => {
            const bucket = store.getState().buckets?.[sessionId];
            if (bucket?.compactionStatus === 'compacting' && bucket.pendingTurn)
                bucket.pendingTurn.capAnchorAt = Date.now() + 0x7fffffff;
        };
        const patched = function () {
            const result = original.apply(this, arguments);
            hold(arguments[0]);
            return result;
        };
        store.setState({ markCompacting: patched });
        for (const sessionId of Object.keys(store.getState().buckets || {})) hold(sessionId);
        globalThis[key] = { store, original, patched, owner };
        return { installed: true };
    })()`;
}

module.exports = function (ctx) {
    // The Code UI expires a pending response after five silent minutes. Native
    // /compact has no assistant stream before its summary is ready, so that
    // generic guard hides the native "Compacting session…" row while the worker
    // is still running. Move only that compact turn's cap far enough out that its
    // real result/error owns teardown; provider traffic and cache keys are untouched.
    ctx.method('nativeStatusPatch', (p, event) => event.sender.executeJavaScript(
        nativeStatusPatch(p?.enabled === true, p?.urls, p?.owner), false));

    ctx.method('status', (p) => new Promise((resolve, reject) => {
        const sessionId = typeof p?.sessionId === 'string' && SESSION_RE.test(p.sessionId)
            ? p.sessionId : '';
        const req = http.get(ROUTER + '/compactionz' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''),
            { timeout: 5000 }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > 1024 * 1024) { req.destroy(new Error('compaction status too large')); return; }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error('router ' + res.statusCode)); return; }
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (error) { reject(error); }
                });
            });
        req.on('timeout', () => req.destroy(new Error('router timeout')));
        req.on('error', reject);
    }));
};
