/* claude-ui-mod :: frontend-pin (main)
 *
 * Holds the Code UI on the bundled, content-hashed frontend release. CDP serves
 * its asset graph from disk under the original HTTPS URLs, preserving relative
 * imports, CSP and origin semantics. The document, authentication and APIs stay live. Interception is scoped
 * to each Code WebContents through CDP Fetch because Electron gives a session
 * only one webRequest callback and the app already owns it for navigation policy.
 *
 * Since 2026-09-28 the document's Link header preloads the entry and its
 * stylesheets where this target's Fetch domain cannot see them, so the gate
 * rewrites those URLs in the document response instead. The approved release
 * has never shipped its own utility CSS, so the bundle includes the utility
 * sheet used with that entry. The build id and server's gated imports stay
 * live. Live chunks insert their own shared-frame,
 * shared-styles and app sheets; before, the document's live-URL links carrying
 * pinned bytes made Vite's loader skip them, so those links are pointed at the
 * pinned twins here and in the renderer.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ASSET_ROOT, assetName, readRelease, createAssetStore, assetResponse } = require('../../../lib/frontend-assets');
let RELEASE = null;
let BUNDLE_ERROR = null;
try { RELEASE = readRelease(); } catch (error) { BUNDLE_ERROR = error.message; }
const PINNED_ENTRY = RELEASE ? ASSET_ROOT + RELEASE.entry : null;
const PINNED_STYLESHEETS = Object.freeze(Object.fromEntries(
    Object.entries(RELEASE?.stylesheets || {}).map(([key, name]) => [key, ASSET_ROOT + name])));
const ASSET_PATTERN = ASSET_ROOT + '*';
const DOCUMENT_PATTERN = 'https://claude.ai/epitaxy*';
const BOOTSTRAP_PATTERN = 'https://claude.ai/*bootstrap*';
const BOOTSTRAP_RE = /^https:\/\/claude\.ai\/(?:edge-)?api\/bootstrap(?:\/[^/?#]+\/app_start)?(?:\?|$)/;
// Server GrowthBook flags (djb2 keys, as the client's L() derives from
// "__gb__<key>") that the approved release itself branches on. Their live
// values select UI the release shipped dark; these are the values it ran with.
//   3413676205  code_transcript_renderer ("alluvium"): replaces the transcript
//               renderer and, through shell.renderer, forces the TurnStatus
//               working row; the client clears its localStorage latch
//               (claudeai.codeTranscriptRendererWanted.v1) once this reads off
//   2846116625  TurnStatus working row on its own; already off server-side on
//               2026-09-29, held so a later flip cannot bring the row back
const PINNED_FLAGS = Object.freeze(RELEASE?.flags || {});
const ENTRY_RE = /^https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/index-[A-Za-z0-9_-]+\.js(?:[?#].*)?$/;
const STYLESHEET_RE = /^https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/[A-Za-z0-9_-]+\.css(?:[?#].*)?$/;
const FRAME_STYLESHEET_RE = /\/shared-frame-[A-Za-z0-9_-]+\.css(?:[?#].*)?$/;
const SHARED_STYLESHEET_RE = /\/shared-styles-[A-Za-z0-9_-]+\.css(?:[?#].*)?$/;
const APP_STYLESHEET_RE = /\/cf1a02a1a-[A-Za-z0-9_-]+\.css(?:[?#].*)?$/;
const UTILITY_STYLESHEET_RE = /\/c6a992d55-[A-Za-z0-9_-]+\.css(?:[?#].*)?$/;
const ENTRY_TAG_RE = /<script\b[^>]*\bsrc="(https:\/\/assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/index-[A-Za-z0-9_-]+\.js)"[^>]*>/g;
const STYLESHEET_TAG_RE = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;
const HREF_RE = /\bhref="([^"]+)"/;
// The body is re-encoded after decoding, so the original framing headers would lie.
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
const CODE_RE = /^https:\/\/claude\.ai\/epitaxy(?:[/?#]|$)/;
const CANARY_PARAM = 'cuimod_pin_canary';
const HEALTH_TIMEOUT_MS = 30000;
// A fail-open covers the load that failed, not the rest of the app session.
// The gate re-arms after this backoff, doubling per failure until a pinned
// page mounts, so a release that genuinely cannot mount reloads rarely.
const RETRY_BASE_MS = 15000;
const RETRY_MAX_MS = 15 * 60 * 1000;
const ERR_ABORTED = -3;
const KEEP_REDIRECTS = 20;
const EVENT_LOG_LIMIT = 256 * 1024;

function readInitialEnabled(ctx) {
    try {
        const file = path.resolve(ctx.dir, '..', '..', '..', '.state', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        return settings?.['frontend-pin']?.enabled !== false;
    } catch (_) {
        return true;
    }
}

function newNavigation() {
    return { startedAt: Date.now() };
}

// The bundled twin of a release-wide sheet. Feature-specific chunk sheets keep
// their own hashes; the manifest supplies the approved ones directly.
function pinnedTwin(url) {
    if (!STYLESHEET_RE.test(url)) return null;
    const bare = String(url).replace(/[?#].*$/, '');
    let twin = null;
    if (FRAME_STYLESHEET_RE.test(bare)) twin = PINNED_STYLESHEETS.frame;
    else if (SHARED_STYLESHEET_RE.test(bare)) twin = PINNED_STYLESHEETS.shared;
    else if (APP_STYLESHEET_RE.test(bare)) twin = PINNED_STYLESHEETS.app;
    else if (UTILITY_STYLESHEET_RE.test(bare)) twin = PINNED_STYLESHEETS.utility;
    return twin && twin !== bare ? twin : null;
}

// Only the entry <script> and the render-blocking <link rel="stylesheet"> tags
// change. Inline scripts stay byte-identical because the document's CSP admits
// some of them by hash.
function planDocument(html) {
    const entries = [...html.matchAll(ENTRY_TAG_RE)].map((match) => match[1]);
    if (entries.length !== 1) return { error: 'document has ' + entries.length + ' entry scripts' };
    const urls = new Map([[entries[0], PINNED_ENTRY]]);
    const stylesheets = [];
    let frame = false;
    let shared = false;
    let app = false;
    let utility = false;
    for (const [tag] of html.matchAll(STYLESHEET_TAG_RE)) {
        const href = HREF_RE.exec(tag)?.[1];
        if (!href || !STYLESHEET_RE.test(href)) continue;
        if (FRAME_STYLESHEET_RE.test(href)) frame = true;
        else if (SHARED_STYLESHEET_RE.test(href)) shared = true;
        else if (APP_STYLESHEET_RE.test(href)) app = true;
        else if (UTILITY_STYLESHEET_RE.test(href)) utility = true;
        const twin = pinnedTwin(href);
        if (twin) {
            urls.set(href, twin);
            stylesheets.push({ from: href, to: twin });
        }
    }
    if (!frame || !shared) return { error: 'document lacks its shared-frame or shared-styles stylesheet' };
    return { from: entries[0], urls, stylesheets, injectApp: !app, injectUtility: !utility };
}

// Every GrowthBook `features` map within a few levels of the payload root: the
// signed-in bootstrap nests its SDK payload differently from the signed-out one.
function featureMaps(value, depth, out) {
    if (!value || typeof value !== 'object' || depth > 4) return out;
    for (const [key, child] of Object.entries(value)) {
        if (key === 'features' && child && typeof child === 'object' && !Array.isArray(child)) out.push(child);
        else if (child && typeof child === 'object' && !Array.isArray(child)) featureMaps(child, depth + 1, out);
    }
    return out;
}

// Key names only, for the event log: the bootstrap carries account data.
function payloadShape(value, depth) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return typeof value;
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) out[key] = payloadShape(child, depth + 1);
    return out;
}

// cowork_slate_finch_min_versions: { <model>: { local, remote, cli } }. The
// picker greys a model out with "Update Claude to use this model" when the
// Desktop shell is older than its entry, which is exactly the shell a pinned
// setup keeps (Haiku 5.5 on 2.9939.4, 2026-10-11). Matched by value shape
// because the key arrives hashed.
const MIN_VERSION_KEYS = new Set(['local', 'remote', 'cli']);
function isModelMinVersions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length > 0 && entries.some(([model]) => /^claude-/.test(model))
        && entries.every(([, row]) => row && typeof row === 'object' && !Array.isArray(row)
            && Object.keys(row).length > 0 && Object.keys(row).every(key => MIN_VERSION_KEYS.has(key)));
}
function holdsModelMinVersions(feature) {
    if (!feature || typeof feature !== 'object') return false;
    if (isModelMinVersions(feature.defaultValue)) return true;
    return Array.isArray(feature.rules) && feature.rules.some(rule => isModelMinVersions(rule?.force)
        || (Array.isArray(rule?.variations) && rule.variations.some(isModelMinVersions)));
}

// Returns { text } with the rewritten JSON, or { shape } when nothing changed.
function rewriteBootstrap(text) {
    let payload;
    try { payload = JSON.parse(text); } catch (_) { return { shape: 'not json' }; }
    if (!payload || typeof payload !== 'object') return { shape: typeof payload };
    let changed = false;
    for (const features of featureMaps(payload, 0, [])) {
        for (const [flag, feature] of Object.entries(features)) {
            if (!holdsModelMinVersions(feature)) continue;
            features[flag] = { defaultValue: {} };
            changed = true;
        }
        for (const [flag, value] of Object.entries(PINNED_FLAGS)) {
            const current = features[flag];
            if (current && current.defaultValue === value && !current.rules) continue;
            features[flag] = { defaultValue: value };
            changed = true;
        }
    }
    return changed ? { text: JSON.stringify(payload) } : { shape: payloadShape(payload, 0) };
}

function replaceUrls(text, urls) {
    for (const [from, to] of urls) text = text.split(from).join(to);
    return text;
}

function rewriteDocument(html, headers, plan) {
    const addedLinks = [plan.injectApp && PINNED_STYLESHEETS.app, plan.injectUtility && PINNED_STYLESHEETS.utility]
        .filter(Boolean).map((href) => '<link rel="stylesheet" crossorigin href="' + href + '" data-entry-stylesheet>').join('');
    const body = html
        .replace(ENTRY_TAG_RE, (tag) => replaceUrls(tag, plan.urls))
        .replace(STYLESHEET_TAG_RE, (tag) => {
            const next = replaceUrls(tag, plan.urls);
            return next.includes(PINNED_STYLESHEETS.shared) ? next + addedLinks : next;
        });
    const responseHeaders = [];
    for (const header of headers || []) {
        const name = String(header.name).toLowerCase();
        if (DROPPED_HEADERS.has(name)) continue;
        responseHeaders.push(name === 'link' ? { name: header.name, value: replaceUrls(header.value, plan.urls) } : header);
    }
    return { body, responseHeaders };
}

module.exports = function (ctx) {
    const { app, webContents } = ctx.electron;
    const watched = new Map();
    const attached = new Map();
    const detachWaiters = new Map();
    const failed = new Map();
    const strikes = new Map();
    const recoveryReloads = new WeakSet();
    const redirects = [];
    let enabled = readInitialEnabled(ctx);
    let disposed = false;
    let lastError = BUNDLE_ERROR;
    const assets = RELEASE ? createAssetStore() : null;

    function safeUrl(wc) {
        try { return wc.isDestroyed() ? '' : wc.getURL(); } catch (_) { return ''; }
    }

    // The warning shows the current failure; the bounded log preserves how the
    // view reached it without persisting bootstrap account data.
    const eventLog = path.resolve(ctx.dir, '..', '..', '..', '.state', 'frontend-pin-events.jsonl');
    function logEvent(event) {
        try {
            fs.mkdirSync(path.dirname(eventLog), { recursive: true });
            try { if (fs.statSync(eventLog).size > EVENT_LOG_LIMIT) fs.renameSync(eventLog, eventLog + '.1'); } catch (_) {}
            fs.appendFileSync(eventLog, JSON.stringify({ at: new Date().toISOString(), gen: ctx.boot?.generation ?? null, ...event }) + '\n');
        } catch (_) {}
    }

    function rememberRedirect(value) {
        redirects.push(value);
        if (redirects.length > KEEP_REDIRECTS) redirects.splice(0, redirects.length - KEEP_REDIRECTS);
    }

    function forgetAttached(wc, record) {
        if (attached.get(wc) !== record) return;
        try { wc.debugger.removeListener('message', record.onMessage); } catch (_) {}
        try { wc.debugger.removeListener('detach', record.onDetach); } catch (_) {}
        attached.delete(wc);
    }

    async function detachOne(wc, reason) {
        const record = attached.get(wc);
        if (!record || record.detaching) return;
        record.detaching = true;
        for (const requestId of record.pending) {
            try { await wc.debugger.sendCommand('Fetch.continueRequest', { requestId }); } catch (_) {}
        }
        record.pending.clear();
        try { await wc.debugger.sendCommand('Fetch.disable'); } catch (_) {}
        forgetAttached(wc, record);
        try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch (_) {}
        record.reason = reason;
    }

    function markFailed(wc, reason) {
        const strike = strikes.get(wc) || { count: 0, retryAt: Infinity };
        strike.count++;
        strike.retryAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (strike.count - 1), RETRY_MAX_MS);
        strikes.set(wc, strike);
        failed.set(wc, reason);
        return strike.retryAt - Date.now();
    }

    function failOpen(wc, reason, reload, detail) {
        if (failed.has(wc)) return;
        lastError = reason;
        const retryMs = markFailed(wc, reason);
        logEvent({ event: 'fail-open', viewId: wc.id, reason, reload, retryMs, ...detail, url: safeUrl(wc) });
        const finish = async () => {
            await detachOne(wc, 'fail-open');
            if (!reload || disposed || wc.isDestroyed() || !CODE_RE.test(safeUrl(wc))) return;
            // Only a rewritten document that failed to mount reloads here; it has
            // already replaced the old page, so no composer state is discarded.
            try { wc.reload(); } catch (_) {}
        };
        void finish();
    }

    async function continuePaused(wc, record, params) {
        const requestId = params?.requestId;
        const requestUrl = params?.request?.url || '';
        if (!requestId) return;
        const command = (method, values) => wc.debugger.sendCommand(method, values);
        record.pending.add(requestId);
        let continued = false;
        let failure = null;
        try {
            const active = enabled && !record.detaching && !failed.has(wc);
            const responseStage = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
            if (responseStage && active && record.navigation && params.resourceType === 'Document'
                && params.responseStatusCode === 200 && CODE_RE.test(requestUrl)) {
                record.navigation = null;
                record.pinnedDocument = false;
                const response = await command('Fetch.getResponseBody', { requestId });
                const html = response?.base64Encoded
                    ? Buffer.from(response.body || '', 'base64').toString('utf8')
                    : String(response?.body || '');
                const plan = planDocument(html);
                logEvent({ event: plan.error ? 'document-left-live' : 'document-pinned', viewId: wc.id,
                    url: requestUrl, error: plan.error || null, from: plan.from || null });
                if (plan.error) {
                    // Nothing has been rewritten, so the page loads whole on the
                    // server-selected release and needs no recovery reload.
                    await command('Fetch.continueRequest', { requestId });
                    continued = true;
                    failure = 'release gate left the document live: ' + plan.error;
                } else {
                    const rewritten = rewriteDocument(html, params.responseHeaders, plan);
                    const fulfill = {
                        requestId,
                        responseCode: 200,
                        responseHeaders: rewritten.responseHeaders,
                        body: Buffer.from(rewritten.body, 'utf8').toString('base64'),
                    };
                    if (params.responseStatusText) fulfill.responsePhrase = params.responseStatusText;
                    // The document's inline prelude requests the bootstrap as soon as
                    // it parses, which can pause before this fulfill resolves.
                    record.pinnedDocument = true;
                    try {
                        await command('Fetch.fulfillRequest', fulfill);
                    } catch (error) {
                        record.pinnedDocument = false;
                        throw error;
                    }
                    continued = true;
                    recoveryReloads.delete(wc);
                    record.liveRecovery = false;
                    record.awaitingHealthUntil = Date.now() + HEALTH_TIMEOUT_MS;
                    record.awaitingLoadFinish = true;
                    record.staleHealthOrigin = record.lastHealthyOrigin;
                    rememberRedirect({
                        at: new Date().toISOString(),
                        viewId: wc.id,
                        from: plan.from,
                        to: PINNED_ENTRY,
                        stylesheets: plan.stylesheets,
                        injectedApp: plan.injectApp,
                    });
                }
            } else if (responseStage && active && params.responseStatusCode === 200 && BOOTSTRAP_RE.test(requestUrl)
                && (record.pinnedDocument || await pagePinned(wc, record))) {
                const response = await command('Fetch.getResponseBody', { requestId });
                const text = response?.base64Encoded
                    ? Buffer.from(response.body || '', 'base64').toString('utf8')
                    : String(response?.body || '');
                const next = rewriteBootstrap(text);
                if (next.text === undefined) {
                    logEvent({ event: 'bootstrap-unchanged', viewId: wc.id, url: requestUrl.replace(/[?].*$/, ''),
                        bytes: text.length, shape: next.shape });
                    await command('Fetch.continueRequest', { requestId });
                } else {
                    const fulfill = {
                        requestId,
                        responseCode: 200,
                        responseHeaders: (params.responseHeaders || [])
                            .filter((header) => !DROPPED_HEADERS.has(String(header.name).toLowerCase())),
                        body: Buffer.from(next.text, 'utf8').toString('base64'),
                    };
                    if (params.responseStatusText) fulfill.responsePhrase = params.responseStatusText;
                    await command('Fetch.fulfillRequest', fulfill);
                    logEvent({ event: 'bootstrap-flags-pinned', viewId: wc.id, url: requestUrl.replace(/\?.*$/, '') });
                }
                continued = true;
            } else if (responseStage && BOOTSTRAP_RE.test(requestUrl)) {
                logEvent({ event: 'bootstrap-passed', viewId: wc.id, url: requestUrl.replace(/[?].*$/, ''),
                    status: params.responseStatusCode ?? null, pinned: !!record.pinnedDocument, active });
                await command('Fetch.continueRequest', { requestId });
                continued = true;
            } else if (!responseStage && active && requestUrl.startsWith(ASSET_ROOT)) {
                const token = ENTRY_RE.test(requestUrl) ? new URL(requestUrl).searchParams.get(CANARY_PARAM) : null;
                const canary = token && record.canary?.token === token;
                const url = canary ? PINNED_ENTRY : record.pinnedDocument ? pinnedTwin(requestUrl) || requestUrl : null;
                const name = url && assetName(url);
                if (name && assets.release.assets[name]) {
                    try {
                        const bytes = await assets.read(name);
                        // Disabling or disposing during disk IO releases the pause
                        // itself; the old generation must not fulfill it afterwards.
                        if (!enabled || record.detaching || !record.pending.has(requestId)) return;
                        const reply = assetResponse(requestId, assets.release.assets[name], bytes, params.request?.headers);
                        await command('Fetch.fulfillRequest', reply);
                        continued = true;
                        record.localAssets++;
                        if (canary) record.canary.seen = true;
                    } catch (error) {
                        if (!enabled || record.detaching || !record.pending.has(requestId)) return;
                        await command('Fetch.failRequest', { requestId, errorReason: 'Failed' });
                        continued = true;
                        failure = String(error.message || error);
                    }
                } else {
                    // Runtime gated imports are server-selected and intentionally
                    // remain live. Only the manifest's approved graph is archived.
                    await command('Fetch.continueRequest', { requestId });
                    continued = true;
                }
            } else {
                await command('Fetch.continueRequest', { requestId });
                continued = true;
            }
        } catch (error) {
            if (!continued) {
                try { await command('Fetch.continueRequest', { requestId }); } catch (_) {}
            }
            failure = failure || 'request continuation failed: ' + String(error?.message || error);
        } finally {
            record.pending.delete(requestId);
        }
        if (failure) failOpen(wc, failure, !!record.awaitingHealthUntil);
    }

    function clearDetachWaiter(wc) {
        const waiter = detachWaiters.get(wc);
        if (!waiter) return;
        try { wc.debugger.removeListener('detach', waiter); } catch (_) {}
        detachWaiters.delete(wc);
    }

    function waitForDebugger(wc) {
        if (disposed || detachWaiters.has(wc) || wc.isDestroyed()) return;
        const retry = () => {
            detachWaiters.delete(wc);
            if (!disposed && enabled && !failed.has(wc) && CODE_RE.test(safeUrl(wc))) void attachOne(wc);
        };
        detachWaiters.set(wc, retry);
        wc.debugger.once('detach', retry);
    }

    // `url` is the navigation being started. One that starts before the gate is
    // ready has its document request in flight already and Fetch.enable cannot
    // pause it, so it is issued again once the gate is armed. Chromium aborts
    // the first with ERR_ABORTED, which the app's load-failure handlers ignore.
    async function attachOne(wc, navigating = false, url = null) {
        if (disposed || !enabled || failed.has(wc) || wc.isDestroyed()) return false;
        if (!assets) { failed.set(wc, BUNDLE_ERROR); return false; }
        const current = attached.get(wc);
        if (current?.ready || current?.attaching) {
            if (navigating) {
                current.navigation = newNavigation();
                current.pinnedDocument = false;
                if (current.attaching) current.reissue = url;
            }
            return current.ready;
        }
        if (wc.debugger.isAttached()) {
            lastError = 'view ' + wc.id + ' already has a debugger client; pin left open';
            waitForDebugger(wc);
            return false;
        }
        clearDetachWaiter(wc);

        const record = {
            attaching: true,
            ready: false,
            detaching: false,
            owned: false,
            pending: new Set(),
            localAssets: 0,
            canary: null,
            canaryPassed: false,
            awaitingHealthUntil: 0,
            awaitingLoadFinish: false,
            lastHealthyOrigin: null,
            staleHealthOrigin: null,
            pinnedDocument: false,
            liveRecovery: false,
            navigation: navigating ? newNavigation() : null,
            reissue: navigating ? url : null,
            onMessage: null,
            onDetach: null,
        };
        record.onMessage = (_event, method, params) => {
            if (method === 'Fetch.requestPaused') void continuePaused(wc, record, params);
        };
        record.onDetach = (_event, reason) => {
            if (record.detaching) return;
            forgetAttached(wc, record);
            lastError = 'view ' + wc.id + ' debugger detached: ' + reason;
            if (!wc.isDestroyed()) markFailed(wc, lastError);
        };
        attached.set(wc, record);
        try {
            wc.debugger.on('message', record.onMessage);
            wc.debugger.on('detach', record.onDetach);
            wc.debugger.attach('1.3');
            record.owned = true;
            await wc.debugger.sendCommand('Fetch.enable', { patterns: [
                {
                    urlPattern: DOCUMENT_PATTERN,
                    resourceType: 'Document',
                    requestStage: 'Response',
                },
                {
                    urlPattern: BOOTSTRAP_PATTERN,
                    requestStage: 'Response',
                },
                // Chromium routes dedicated workers' asset requests through the
                // owning page's Fetch agent. Worker targets have no Fetch.enable.
                { urlPattern: ASSET_PATTERN, requestStage: 'Request' },
            ] });
            if (disposed || !enabled || failed.has(wc) || wc.isDestroyed()) {
                await detachOne(wc, 'state changed while attaching');
                return false;
            }
            record.attaching = false;
            record.ready = true;
            lastError = null;
            const reissue = record.reissue;
            record.reissue = null;
            if (reissue && record.navigation && CODE_RE.test(reissue)) {
                record.navigation = newNavigation();
                logEvent({ event: 'navigation-reissued', viewId: wc.id, url: reissue });
                Promise.resolve().then(() => wc.loadURL(reissue)).catch(() => {});
            }
            // A generation that arrives while the Code document is still loading
            // (a host reload during a slow cold launch) cannot pause a request that
            // is already in flight. Arming the transaction makes did-finish-load
            // notice the miss instead of leaving the live release up silently.
            if (!navigating && wc.isLoadingMainFrame()) record.navigation = newNavigation();
            if (!navigating) adoptOpenPage(wc, record);
            return true;
        } catch (error) {
            forgetAttached(wc, record);
            try { if (record.owned && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch (_) {}
            lastError = 'view ' + wc.id + ' attach failed: ' + String(error?.message || error);
            if (!record.owned && !wc.isDestroyed() && wc.debugger.isAttached()) waitForDebugger(wc);
            return false;
        }
    }

    // A host reload re-creates this plugin while the pinned page stays open.
    // The new generation never saw that document, but the page's periodic
    // bootstrap refetches still carry live flag values, so it reads the
    // page's entry script to learn whether it is pinned.
    function adoptOpenPage(wc, record) {
        Promise.resolve().then(() => pagePinned(wc, record)).catch(() => {});
    }

    // Asked over this generation's own CDP session: executeJavaScript waits for
    // a loading main frame to stop, and the bootstrap arrives well before that.
    // The answer marks the record pinned only when no document load is in
    // flight to replace the page it describes.
    async function pagePinned(wc, record) {
        const probe = '!!document.querySelector(' + JSON.stringify('script[src="' + PINNED_ENTRY + '"]') + ')';
        let pinned = false;
        try {
            const reply = await wc.debugger.sendCommand('Runtime.evaluate', { expression: probe, returnByValue: true });
            pinned = reply?.result?.value === true;
        } catch (_) {}
        if (pinned && !record.pinnedDocument && !record.navigation && attached.get(wc) === record && !disposed) {
            record.pinnedDocument = true;
            logEvent({ event: 'open-page-adopted', viewId: wc.id, via: 'cdp', url: safeUrl(wc) });
        }
        return pinned;
    }

    // The page that just finished loading is either already pinned (an earlier
    // generation rewrote it) or the live release. A live one has only just
    // loaded, so one reload with the gate armed costs nothing; a second miss on
    // the same view fails open rather than reloading forever.
    function recoverMissedDocument(wc, record, navigation) {
        const detail = navigation?.startedAt ? { sinceStartMs: Date.now() - navigation.startedAt } : {};
        const probe = '!!document.querySelector(' + JSON.stringify('script[src="' + PINNED_ENTRY + '"]') + ')';
        Promise.resolve()
            .then(() => wc.executeJavaScript(probe, false))
            .catch(() => false)
            .then((pinned) => {
                if (disposed || attached.get(wc) !== record || record.navigation || wc.isDestroyed()) return;
                if (pinned === true) {
                    record.pinnedDocument = true;
                    logEvent({ event: 'open-page-adopted', viewId: wc.id, url: safeUrl(wc) });
                    return;
                }
                if (recoveryReloads.has(wc)) {
                    failOpen(wc, 'release gate did not see the document response', false, detail);
                    return;
                }
                recoveryReloads.add(wc);
                logEvent({ event: 'document-missed-reload', viewId: wc.id, ...detail, url: safeUrl(wc) });
                try { wc.reload(); } catch (_) {}
            });
    }

    function onNavigation(wc, url, isInPlace, isMainFrame) {
        if (!isMainFrame) return;
        const record = attached.get(wc);
        if (!isInPlace) logEvent({ event: 'navigation', viewId: wc.id, url, attached: !!record?.ready, failed: failed.get(wc) || null });
        // The document whose mount was awaited is gone; a pinned successor
        // sets its own deadline when it is rewritten.
        if (!isInPlace && record) {
            record.awaitingHealthUntil = 0;
            record.awaitingLoadFinish = false;
        }
        if (CODE_RE.test(url)) {
            void attachOne(wc, !isInPlace, isInPlace ? null : url);
            return;
        }
        if (!record) {
            clearDetachWaiter(wc);
            return;
        }
        // A navigation that starts outside Code can redirect into it, and the
        // redirected document is the one to rewrite. Detaching here used to let
        // that document through before the next scan re-attached.
        if (!isInPlace) {
            record.navigation = newNavigation();
            record.pinnedDocument = false;
        }
    }

    function unwatch(wc) {
        const record = watched.get(wc);
        if (!record) return;
        try { wc.removeListener('did-start-navigation', record.onNavigation); } catch (_) {}
        try { wc.removeListener('did-finish-load', record.onFinished); } catch (_) {}
        try { wc.removeListener('did-fail-load', record.onFailed); } catch (_) {}
        try { wc.removeListener('destroyed', record.onDestroyed); } catch (_) {}
        clearDetachWaiter(wc);
        watched.delete(wc);
        failed.delete(wc);
        strikes.delete(wc);
        void detachOne(wc, 'view destroyed');
    }

    function watch(wc) {
        if (!wc || watched.has(wc) || wc.isDestroyed()) return;
        const record = {
            onNavigation: (_event, url, isInPlace, isMainFrame) => onNavigation(wc, url, isInPlace, isMainFrame),
            onFinished: () => {
                const pin = attached.get(wc);
                if (pin?.navigation) {
                    // The error page's finish; the app retries or navigates on its
                    // own, and that navigation re-arms the gate.
                    if (pin.navigation.failedLoad !== undefined) return;
                    const navigation = pin.navigation;
                    pin.navigation = null;
                    if (CODE_RE.test(safeUrl(wc))) recoverMissedDocument(wc, pin, navigation);
                    return;
                }
                if (pin?.awaitingHealthUntil) pin.awaitingLoadFinish = false;
            },
            onFailed: (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
                const pin = attached.get(wc);
                if (!isMainFrame || errorCode === ERR_ABORTED || !pin?.navigation) return;
                pin.navigation.failedLoad = errorCode;
                logEvent({ event: 'document-load-failed', viewId: wc.id, errorCode, errorDescription,
                    sinceStartMs: Date.now() - pin.navigation.startedAt, url: String(validatedURL || '') });
            },
            onDestroyed: () => unwatch(wc),
        };
        watched.set(wc, record);
        wc.on('did-start-navigation', record.onNavigation);
        wc.on('did-finish-load', record.onFinished);
        wc.on('did-fail-load', record.onFailed);
        wc.on('destroyed', record.onDestroyed);
        if (CODE_RE.test(safeUrl(wc))) void attachOne(wc);
    }

    function scan() {
        if (disposed) return;
        for (const wc of webContents.getAllWebContents()) watch(wc);
        if (!enabled) return;
        const now = Date.now();
        for (const [wc, strike] of strikes) {
            if (now < strike.retryAt || !failed.has(wc) || wc.isDestroyed()) continue;
            strike.retryAt = Infinity;
            failed.delete(wc);
            recoveryReloads.delete(wc);
            logEvent({ event: 'gate-retry', viewId: wc.id, strikes: strike.count, url: safeUrl(wc) });
        }
        for (const wc of watched.keys()) {
            if (!wc.isDestroyed() && CODE_RE.test(safeUrl(wc)) && !attached.has(wc) && !failed.has(wc))
                void attachOne(wc);
        }
        for (const [wc, record] of attached) {
            if (record.awaitingHealthUntil && now > record.awaitingHealthUntil)
                failOpen(wc, 'pinned frontend did not mount within ' + HEALTH_TIMEOUT_MS + 'ms', true);
            if (record.canary && now > record.canary.deadline)
                failOpen(wc, 'entry redirect canary timed out', false);
        }
    }

    function setEnabled(next) {
        const changed = enabled !== next;
        enabled = next;
        if (!enabled) {
            for (const wc of [...detachWaiters.keys()]) clearDetachWaiter(wc);
            for (const wc of [...attached.keys()]) void detachOne(wc, 'disabled');
            return;
        }
        if (changed) { failed.clear(); strikes.clear(); }
        scan();
    }

    ctx.method('settings', (params) => {
        if (typeof params?.enabled === 'boolean') setEnabled(params.enabled);
        return { enabled };
    });

    ctx.method('status', (_params, event) => {
        const wc = event?.sender;
        const record = wc && attached.get(wc);
        return {
            enabled,
            pinnedEntry: PINNED_ENTRY,
            pinnedStylesheets: { ...PINNED_STYLESHEETS },
            bundledAssets: Object.keys(RELEASE?.assets || {}).length,
            localAssets: record?.localAssets || 0,
            pinnedDocument: !!record?.pinnedDocument,
            ready: !!record?.ready,
            canaryPassed: !!record?.canaryPassed,
            awaitingHealth: !!record?.awaitingHealthUntil,
            awaitingLoadFinish: !!record?.awaitingLoadFinish,
            failed: wc ? failed.get(wc) || null : null,
            senderFrameMatches: !!(wc && event?.senderFrame && wc.mainFrame && event.senderFrame === wc.mainFrame),
            attachedViews: [...attached.values()].filter((value) => value.ready).length,
            redirects: redirects.slice(),
            lastError,
        };
    });

    ctx.method('beginCanary', async (_params, event) => {
        const wc = event?.sender;
        if (!wc || wc.isDestroyed() || !CODE_RE.test(safeUrl(wc)) || !enabled)
            return { ready: false, enabled, error: 'Code view is not eligible' };
        watch(wc);
        if (failed.has(wc)) return { ready: false, enabled, failed: true, error: failed.get(wc) };
        await attachOne(wc);
        const record = attached.get(wc);
        if (!record?.ready) return { ready: false, enabled, error: lastError || 'interceptor not ready' };
        if (record.canaryPassed) return { ready: true, passed: true };
        if (!record.canary) {
            const token = crypto.randomBytes(12).toString('hex');
            record.canary = { token, seen: false, deadline: Date.now() + HEALTH_TIMEOUT_MS };
        }
        const probe = new URL('index-cuimod-pin-canary.js', PINNED_ENTRY);
        probe.searchParams.set(CANARY_PARAM, record.canary.token);
        return { ready: true, passed: false, token: record.canary.token, url: probe.href };
    });

    ctx.method('finishCanary', (params, event) => {
        const wc = event?.sender;
        const record = wc && attached.get(wc);
        if (!record?.canary || params?.token !== record.canary.token) return { ok: false, error: 'stale canary' };
        const ok = params?.ok === true && record.canary.seen;
        record.canary = null;
        record.canaryPassed = ok;
        if (!ok) failOpen(wc, 'entry redirect canary failed', false);
        return { ok, failed: !ok };
    });

    // A Code page can come up live without a Code document load: a relogin
    // lands on /login and the app routes back to /epitaxy in place, so the
    // gate never sees a document to rewrite. The renderer reports such a page
    // and it gets the same single recovery reload as a missed document.
    ctx.method('reloadLive', (_params, event) => {
        const wc = event?.sender;
        const record = wc && attached.get(wc);
        if (!enabled || !record?.ready || record.liveRecovery || record.navigation || record.pinnedDocument
            || record.awaitingHealthUntil || failed.has(wc) || !CODE_RE.test(safeUrl(wc))) return false;
        if (!event.senderFrame || event.senderFrame !== wc.mainFrame) return false;
        record.liveRecovery = true;
        logEvent({ event: 'live-page-reload', viewId: wc.id, url: safeUrl(wc) });
        recoverMissedDocument(wc, record);
        return true;
    });

    ctx.method('healthy', (params, event) => {
        const wc = event?.sender;
        const record = wc && attached.get(wc);
        const timeOrigin = Number(params?.timeOrigin);
        if (!record || params?.ready !== true || !Number.isFinite(timeOrigin) || timeOrigin <= 0) return false;
        if (record.awaitingHealthUntil && record.awaitingLoadFinish) return false;
        if (record.awaitingHealthUntil && (!event?.senderFrame || !wc.mainFrame || event.senderFrame !== wc.mainFrame)) return false;
        if (record.awaitingHealthUntil && record.staleHealthOrigin === timeOrigin) return false;
        // A pinned page that mounted ends the backoff.
        if (record.awaitingHealthUntil) strikes.delete(wc);
        record.lastHealthyOrigin = timeOrigin;
        record.staleHealthOrigin = null;
        record.awaitingHealthUntil = 0;
        return true;
    });

    const onCreated = (_event, wc) => watch(wc);
    app.on('web-contents-created', onCreated);
    ctx.onDispose(() => {
        disposed = true;
        enabled = false;
        try { app.removeListener('web-contents-created', onCreated); } catch (_) {}
        for (const wc of [...watched.keys()]) unwatch(wc);
    });

    scan();
    ctx.every(500, scan);
};

module.exports.PINNED_ENTRY = PINNED_ENTRY;
module.exports.PINNED_STYLESHEETS = PINNED_STYLESHEETS;
module.exports.ENTRY_RE = ENTRY_RE;
module.exports.STYLESHEET_RE = STYLESHEET_RE;
module.exports.pinnedTwin = pinnedTwin;
module.exports.rewriteBootstrap = rewriteBootstrap;
module.exports.planDocument = planDocument;
module.exports.rewriteDocument = rewriteDocument;
