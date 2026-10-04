'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = path.resolve(__dirname, '..', 'src', 'plugins', 'frontend-pin', 'main.js');
const factory = require(SOURCE);
const PINNED = factory.PINNED_ENTRY;
const PINNED_CSS = factory.PINNED_STYLESHEETS;
const ASSET_ROOT = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';

class FakeDebugger extends EventEmitter {
    constructor(attached = false, raceOnAttach = false) {
        super();
        this.attached = attached;
        this.raceOnAttach = raceOnAttach;
        this.attachCalls = 0;
        this.detachCalls = 0;
        this.commands = [];
        this.documentBody = '';
    }
    isAttached() { return this.attached; }
    attach(version) {
        assert.equal(version, '1.3');
        if (this.attached) throw new Error('already attached');
        if (this.raceOnAttach) {
            this.attached = true;
            throw new Error('another debugger attached during race');
        }
        this.attached = true;
        this.attachCalls++;
    }
    detach() {
        if (!this.attached) return;
        this.attached = false;
        this.detachCalls++;
        this.emit('detach', {}, 'target closed');
    }
    async sendCommand(method, params, sessionId) {
        const call = { method, params, ...(sessionId ? { sessionId } : {}) };
        this.commands.push(call);
        this.emit('command', call);
        if (method === 'Fetch.getResponseBody') {
            return { body: Buffer.from(this.documentBody, 'utf8').toString('base64'), base64Encoded: true };
        }
        return {};
    }
}

class FakeWebContents extends EventEmitter {
    constructor(id, url, debuggerAttached = false, raceOnAttach = false) {
        super();
        this.id = id;
        this.url = url;
        this.dead = false;
        this.reloads = 0;
        this.mainFrame = { id: 'frame-' + id };
        this.debugger = new FakeDebugger(debuggerAttached, raceOnAttach);
    }
    getURL() { return this.url; }
    getType() { return 'window'; }
    isDestroyed() { return this.dead; }
    isLoadingMainFrame() { return this.loading === true; }
    reload() { this.reloads++; }
    async executeJavaScript(code) {
        return this.pinnedPage === true && code.includes('index-Cuw5J4F9.js');
    }
}

function harness(contents = [], shared = {}) {
    const app = shared.app || new EventEmitter();
    const methods = new Map();
    const intervals = [];
    const disposers = [];
    const stateDir = fs.mkdtempSync(path.join(process.env.CUIMOD_TEST_TMP || os.tmpdir(), 'cuimod-pin-view-'));
    const ctx = {
        dir: path.join(stateDir, 'src', 'plugins', 'frontend-pin'),
        electron: { app, webContents: { getAllWebContents: () => contents } },
        method: (name, fn) => methods.set(name, fn),
        every: (_ms, fn) => { intervals.push(fn); return fn; },
        onDispose: (fn) => disposers.push(fn),
        log: () => {},
    };
    factory(ctx);
    return {
        app, methods, intervals,
        async settle() {
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
        },
        dispose() {
            for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
            fs.rmSync(stateDir, { recursive: true, force: true });
        },
    };
}

async function pause(h, wc, requestId, url, sessionId, headers) {
    const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            wc.debugger.removeListener('command', receive);
            reject(new Error('no paused-request reply: ' + requestId));
        }, 5000);
        const receive = (call) => {
            if (call.params?.requestId !== requestId || call.method === 'Fetch.getResponseBody') return;
            clearTimeout(timer);
            wc.debugger.removeListener('command', receive);
            resolve(call);
        };
        wc.debugger.on('command', receive);
    });
    wc.debugger.emit('message', {}, 'Fetch.requestPaused', { requestId, request: { url, headers } }, sessionId);
    const call = await reply;
    await h.settle();
    return call;
}

function releaseDocument(entry, stylesheets, buildId = 'live0build') {
    return '<!doctype html><html data-build-id="' + buildId + '" data-build-timestamp="1790646492" lang="en"><head>'
        + '<script nonce="n">window.inline="' + entry + '"</script>'
        + '<script type="module" crossorigin src="' + entry + '" nonce="n"></script>'
        + '<link rel="preload" as="style" crossorigin href="' + ASSET_ROOT + 'transcript-Live.css">'
        + '<link rel="modulepreload" crossorigin href="' + ASSET_ROOT + 'shared-10-Live.js">'
        + '<link rel="modulepreload" crossorigin href="' + ASSET_ROOT + 'vendor-frame-CvMkXlR3.js">'
        + '<link rel="preload" as="script" crossorigin href="' + ASSET_ROOT + 'cf52a4cc1-Live.js" fetchpriority="low">'
        + stylesheets.map((href) => '<link rel="stylesheet" crossorigin href="' + href + '" data-entry-stylesheet>').join('')
        + '</head><body><div id="root"></div></body></html>';
}

async function beginRelease(h, wc, entry = ASSET_ROOT + 'index-Next.js', stylesheets = [
    ASSET_ROOT + 'shared-frame-Current.css',
    ASSET_ROOT + 'shared-styles-Current.css',
    ASSET_ROOT + 'c6a992d55-Utility.css',
]) {
    wc.emit('did-start-navigation', {}, wc.url, false, true);
    await h.settle();
    wc.debugger.documentBody = releaseDocument(entry, stylesheets);
    wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
        requestId: 'release',
        resourceType: 'Document',
        responseStatusCode: 200,
        responseStatusText: 'OK',
        request: { url: wc.url },
        responseHeaders: [
            { name: 'Content-Type', value: 'text/html' },
            { name: 'Content-Encoding', value: 'br' },
            { name: 'Set-Cookie', value: 'a=1' },
            { name: 'Link', value: '<' + entry + '>; rel=modulepreload, <' + stylesheets[0] + '>; rel=preload; as=style, <'
                + ASSET_ROOT + 'vendor-zod-Live.js>; rel=modulepreload' },
        ],
    });
    await h.settle();
    return wc.debugger.commands.find((call) => call.params?.requestId === 'release' && call.method !== 'Fetch.getResponseBody');
}

function fulfilledBody(call) {
    return Buffer.from(call.params.body, 'base64').toString('utf8');
}

test('rewrites the document to the bundled entry, release sheets and utility sheet', async () => {
    const wc = new FakeWebContents(2, 'https://claude.ai/epitaxy/local_abc');
    const h = harness([wc]);
    await h.settle();

    assert.equal(wc.debugger.attachCalls, 1);
    assert.equal(wc.debugger.commands[0].method, 'Fetch.enable');
    assert.deepEqual(wc.debugger.commands[0].params.patterns[0],
        { urlPattern: 'https://claude.ai/epitaxy*', resourceType: 'Document', requestStage: 'Response' });
    assert.deepEqual(wc.debugger.commands[0].params.patterns[1],
        { urlPattern: 'https://claude.ai/*bootstrap*', requestStage: 'Response' });
    assert.deepEqual(wc.debugger.commands[0].params.patterns[2],
        { urlPattern: ASSET_ROOT + '*', requestStage: 'Request' });
    assert.equal(wc.debugger.commands.some((call) => call.method === 'Target.setAutoAttach'), false);

    const live = ASSET_ROOT + 'index-New123.js';
    const release = await beginRelease(h, wc, live);
    assert.equal(release.method, 'Fetch.fulfillRequest');
    assert.equal(release.params.responseCode, 200);
    const body = fulfilledBody(release);
    assert.match(body, new RegExp('<script type="module" crossorigin src="' + PINNED + '"'));
    assert.match(body, /data-build-id="live0build" data-build-timestamp="1790646492"/);
    for (const href of Object.values(PINNED_CSS)) assert.match(body, new RegExp('rel="stylesheet" crossorigin href="' + href + '"'));
    assert.doesNotMatch(body, /Current\.css/);
    assert.doesNotMatch(body, /c6a992d55-Utility\.css/);
    assert.match(body, new RegExp(PINNED_CSS.utility));
    assert.ok(body.indexOf(PINNED_CSS.app) > body.indexOf(PINNED_CSS.shared));
    // Inline scripts may be CSP-hashed; their bytes must survive untouched.
    assert.match(body, new RegExp('window.inline="' + live + '"'));
    assert.match(body, /transcript-Live\.css/);
    assert.match(body, /shared-10-Live\.js/);
    const headers = Object.fromEntries(release.params.responseHeaders.map((item) => [item.name, item.value]));
    assert.equal(headers['Content-Encoding'], undefined);
    assert.equal(headers['Set-Cookie'], 'a=1');
    assert.equal(headers.Link, '<' + PINNED + '>; rel=modulepreload, <' + PINNED_CSS.frame + '>; rel=preload; as=style, <'
        + ASSET_ROOT + 'vendor-zod-Live.js>; rel=modulepreload');

    const begin = await h.methods.get('beginCanary')({}, { sender: wc });
    assert.equal(begin.ready, true);
    assert.equal(begin.passed, false);
    const canary = await pause(h, wc, 'canary', begin.url);
    assert.equal(canary.method, 'Fetch.fulfillRequest');
    const finish = h.methods.get('finishCanary')({ token: begin.token, ok: true }, { sender: wc });
    assert.deepEqual(finish, { ok: true, failed: false });

    const status = h.methods.get('status')({}, { sender: wc });
    assert.equal(status.ready, true);
    assert.equal(status.canaryPassed, true);
    assert.deepEqual(status.pinnedStylesheets, PINNED_CSS);
    assert.equal(status.redirects.length, 1);
    assert.equal(status.redirects[0].stylesheets.length, 3);
    assert.equal(status.redirects[0].injectedApp, true);
    wc.mainFrame = { id: 'frame-2-next' };
    wc.emit('did-finish-load');
    assert.equal(h.methods.get('healthy')({ ready: true, timeOrigin: 1000 },
        { sender: wc, senderFrame: wc.mainFrame }), true);

    h.dispose();
    await h.settle();
    assert.equal(wc.debugger.isAttached(), false);
    assert.equal(wc.listenerCount('did-start-navigation'), 0);
    assert.equal(wc.debugger.listenerCount('message'), 0);
});

test('serves the approved entry from the checkout without a CDN response', async () => {
    const wc = new FakeWebContents(2, 'https://claude.ai/epitaxy/local_offline');
    const h = harness([wc]);
    await h.settle();
    await beginRelease(h, wc);
    const call = await pause(h, wc, 'offline-entry', PINNED);
    assert.equal(call.method, 'Fetch.fulfillRequest');
    assert.equal(call.params.responseCode, 200);
    assert.ok(Buffer.from(call.params.body, 'base64').length > 0);
    assert.equal(wc.debugger.commands.some((item) => item.method === 'Fetch.continueRequest'
        && item.params.requestId === 'offline-entry'), false);
    h.dispose();
});

test('every approved asset is fulfilled locally with its exact manifest bytes', async () => {
    const { readRelease, sha256 } = require('../lib/frontend-assets');
    const release = readRelease();
    const wc = new FakeWebContents(20, 'https://claude.ai/epitaxy/local_graph');
    const h = harness([wc]);
    await h.settle();
    await beginRelease(h, wc);
    for (const [name, asset] of Object.entries(release.assets)) {
        const call = await pause(h, wc, 'graph-asset', ASSET_ROOT + name + '?cold=1');
        assert.equal(call.method, 'Fetch.fulfillRequest', name);
        const bytes = Buffer.from(call.params.body, 'base64');
        assert.equal(bytes.length, asset.bytes, name);
        assert.equal(sha256(bytes), asset.sha256, name);
        assert.equal(call.params.responseHeaders.find((header) => header.name === 'Content-Type').value, asset.mediaType);
        wc.debugger.commands.length = 0;
    }
    assert.equal(h.methods.get('status')({}, { sender: wc }).localAssets, Object.keys(release.assets).length);
    h.dispose();
});

test('the owning page serves worker Wasm without attaching or pausing workers', async () => {
    const { readRelease } = require('../lib/frontend-assets');
    const name = Object.keys(readRelease().assets).find((name) => name.endsWith('.wasm'));
    const wc = new FakeWebContents(21, 'https://claude.ai/epitaxy/local_worker');
    const h = harness([wc]);
    await h.settle();
    await beginRelease(h, wc);
    const call = await pause(h, wc, 'worker-asset', ASSET_ROOT + name);
    assert.equal(call.method, 'Fetch.fulfillRequest');
    assert.equal(call.sessionId, undefined);
    assert.equal(call.params.responseHeaders.find((header) => header.name === 'Content-Type').value, 'application/wasm');
    assert.equal(wc.debugger.commands.some((call) => call.method === 'Target.setAutoAttach'), false);
    h.dispose();
});

test('missing local bytes abort the asset and expose a failure instead of using the CDN', async () => {
    const fs = require('node:fs');
    const wc = new FakeWebContents(22, 'https://claude.ai/epitaxy/local_missing');
    const h = harness([wc]);
    await h.settle();
    await beginRelease(h, wc);
    const read = fs.promises.readFile;
    fs.promises.readFile = async () => { throw new Error('bundled entry is missing'); };
    try {
        const call = await pause(h, wc, 'missing-asset', PINNED);
        assert.equal(call.method, 'Fetch.failRequest');
        assert.match(h.methods.get('status')({}, { sender: wc }).failed, /bundled entry is missing/);
        assert.equal(wc.reloads, 1);
        assert.equal(wc.debugger.commands.some((call) => call.method === 'Fetch.continueRequest'
            && call.params.requestId === 'missing-asset'), false);
    } finally {
        fs.promises.readFile = read;
        h.dispose();
    }
});

test('arms a newly created Code view before its document finishes', async () => {
    const contents = [];
    const h = harness(contents);
    const wc = new FakeWebContents(4, 'about:blank');
    contents.push(wc);
    h.app.emit('web-contents-created', {}, wc);
    wc.url = 'https://claude.ai/epitaxy/local_new';
    wc.emit('did-start-navigation', {}, wc.url, false, true);
    await h.settle();

    assert.equal(wc.debugger.attachCalls, 1);
    assert.equal(wc.debugger.commands[0].method, 'Fetch.enable');
    h.dispose();
    await h.settle();
});

test('does not open a release transaction for in-page navigation', async () => {
    const wc = new FakeWebContents(5, 'https://claude.ai/epitaxy/local_route');
    const h = harness([wc]);
    await h.settle();

    wc.emit('did-start-navigation', {}, 'https://claude.ai/epitaxy/local_other', true, true);
    wc.emit('did-finish-load');
    await h.settle();

    assert.equal(wc.debugger.isAttached(), true);
    assert.equal(wc.reloads, 0);
    assert.equal(h.methods.get('status')({}, { sender: wc }).failed, null);
    h.dispose();
});

test('gives live chunks the pinned shared and app sheets only on a rewritten page', async () => {
    const wc = new FakeWebContents(3, 'https://claude.ai/epitaxy/local_twin');
    const h = harness([wc]);
    await h.settle();

    const before = await pause(h, wc, 'live-doc', ASSET_ROOT + 'shared-frame-Live.css');
    assert.deepEqual(before, { method: 'Fetch.continueRequest', params: { requestId: 'live-doc' } });

    await beginRelease(h, wc);
    const frame = await pause(h, wc, 'frame', ASSET_ROOT + 'shared-frame-Live.css');
    assert.equal(frame.method, 'Fetch.fulfillRequest');
    const shared = await pause(h, wc, 'shared', ASSET_ROOT + 'shared-styles-Live.css');
    assert.equal(shared.method, 'Fetch.fulfillRequest');
    const app = await pause(h, wc, 'app', ASSET_ROOT + 'cf1a02a1a-Live.css');
    assert.equal(app.method, 'Fetch.fulfillRequest');
    const utility = await pause(h, wc, 'utility', ASSET_ROOT + 'c6a992d55-Live.css');
    assert.equal(utility.method, 'Fetch.fulfillRequest');
    const own = await pause(h, wc, 'own', PINNED_CSS.frame);
    assert.equal(own.method, 'Fetch.fulfillRequest');
    const chunk = await pause(h, wc, 'chunk', ASSET_ROOT + 'c0ffee000-Live.js');
    assert.deepEqual(chunk.params, { requestId: 'chunk' });

    wc.emit('did-start-navigation', {}, wc.url, false, true);
    await h.settle();
    const next = await pause(h, wc, 'next-doc', ASSET_ROOT + 'shared-frame-Live.css');
    assert.deepEqual(next.params, { requestId: 'next-doc' });
    h.dispose();
});

test('holds the working-row flag off in bootstrap responses only on a pinned page', async () => {
    const wc = new FakeWebContents(11, 'https://claude.ai/epitaxy/local_flags');
    const h = harness([wc]);
    await h.settle();
    const payload = {
        account: { uuid: 'a' },
        growthbook: { features: { 2846116625: { defaultValue: true, rules: [{ force: true }] }, 55060375: { defaultValue: true } } },
        org_growthbook: { features: { 2846116625: { defaultValue: true } } },
        gated_imports_build_id: 'live0build',
    };
    const url = 'https://claude.ai/edge-api/bootstrap/org-1/app_start?statsig_hashing_algorithm=djb2';
    const boot = async (requestId) => {
        wc.debugger.documentBody = JSON.stringify(payload);
        wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
            requestId, resourceType: 'Fetch', responseStatusCode: 200, request: { url },
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Content-Encoding', value: 'br' }],
        });
        await h.settle();
        return wc.debugger.commands.find((item) => item.params?.requestId === requestId && item.method !== 'Fetch.getResponseBody');
    };

    const live = await boot('boot-live');
    assert.deepEqual(live, { method: 'Fetch.continueRequest', params: { requestId: 'boot-live' } });

    await beginRelease(h, wc);
    const pinned = await boot('boot-pinned');
    assert.equal(pinned.method, 'Fetch.fulfillRequest');
    const out = JSON.parse(Buffer.from(pinned.params.body, 'base64').toString('utf8'));
    assert.deepEqual(out.growthbook.features[2846116625], { defaultValue: false });
    assert.deepEqual(out.growthbook.features[3413676205], { defaultValue: false });
    assert.deepEqual(out.org_growthbook.features[3413676205], { defaultValue: false });
    assert.deepEqual(out.org_growthbook.features[2846116625], { defaultValue: false });
    assert.deepEqual(out.growthbook.features[55060375], { defaultValue: true });
    assert.equal(out.gated_imports_build_id, 'live0build');
    assert.deepEqual(pinned.params.responseHeaders, [{ name: 'Content-Type', value: 'application/json' }]);
    h.dispose();
});

test('a new generation adopts an already-open pinned page for bootstrap refetches', async () => {
    const pinnedView = new FakeWebContents(12, 'https://claude.ai/epitaxy/local_adopt');
    pinnedView.pinnedPage = true;
    const liveView = new FakeWebContents(13, 'https://claude.ai/epitaxy/local_live_open');
    const h = harness([pinnedView, liveView]);
    await h.settle();
    await h.settle();
    const payload = JSON.stringify({ org_growthbook: { features: { 3413676205: { defaultValue: true } } } });
    const boot = async (wc, requestId) => {
        wc.debugger.documentBody = payload;
        wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
            requestId, resourceType: 'XHR', responseStatusCode: 200, responseHeaders: [],
            request: { url: 'https://claude.ai/edge-api/bootstrap/org-1/app_start?x=1' },
        });
        await h.settle();
        return wc.debugger.commands.find((item) => item.params?.requestId === requestId && item.method !== 'Fetch.getResponseBody');
    };
    const adopted = await boot(pinnedView, 'adopted');
    assert.equal(adopted.method, 'Fetch.fulfillRequest');
    const out = JSON.parse(Buffer.from(adopted.params.body, 'base64').toString('utf8'));
    assert.deepEqual(out.org_growthbook.features[3413676205], { defaultValue: false });
    const untouched = await boot(liveView, 'untouched');
    assert.deepEqual(untouched, { method: 'Fetch.continueRequest', params: { requestId: 'untouched' } });
    h.dispose();
});

test('leaves the document live without a reload when it lacks a release sheet', async () => {
    const wc = new FakeWebContents(5, 'https://claude.ai/epitaxy/local_css_drift');
    const h = harness([wc]);
    await h.settle();

    const release = await beginRelease(h, wc, ASSET_ROOT + 'index-Future.js', [
        ASSET_ROOT + 'shared-frame-Future.css',
        ASSET_ROOT + 'c6a992d55-Future.css',
    ]);
    await h.settle();

    assert.deepEqual(release, { method: 'Fetch.continueRequest', params: { requestId: 'release' } });
    assert.equal(wc.debugger.isAttached(), false);
    assert.equal(wc.reloads, 0);
    assert.match(h.methods.get('status')({}, { sender: wc }).failed, /left the document live: .*shared-frame or shared-styles/);
    h.dispose();
});

test('reloads once with the gate armed, then fails open, when navigations finish without their document response', async () => {
    const wc = new FakeWebContents(5, 'https://claude.ai/epitaxy/local_cached');
    const h = harness([wc]);
    await h.settle();

    wc.emit('did-start-navigation', {}, wc.url, false, true);
    await h.settle();
    wc.emit('did-finish-load');
    await h.settle();

    assert.equal(wc.reloads, 1);
    assert.equal(wc.debugger.isAttached(), true);
    assert.equal(h.methods.get('status')({}, { sender: wc }).failed, null);

    wc.emit('did-start-navigation', {}, wc.url, false, true);
    await h.settle();
    wc.emit('did-finish-load');
    await h.settle();

    assert.equal(wc.reloads, 1);
    assert.equal(wc.debugger.isAttached(), false);
    assert.match(h.methods.get('status')({}, { sender: wc }).failed, /did not see the document response/);
    h.dispose();
});

// 2026-10-02: a boot-time file read fired the src watcher, the host reloaded
// during a 13 s cold-launch document load, and the new generation let the live
// release through without logging anything.
test('a generation that attaches mid-load reloads the document it could not see', async () => {
    const wc = new FakeWebContents(9, 'https://claude.ai/epitaxy?coldLaunch=1');
    wc.loading = true;
    const h = harness([wc]);
    await h.settle();

    wc.loading = false;
    wc.emit('did-finish-load');
    await h.settle();

    assert.equal(wc.reloads, 1);
    assert.equal(wc.debugger.isAttached(), true);
    h.dispose();
});

test('a generation that attaches mid-load adopts a page an earlier generation pinned', async () => {
    const wc = new FakeWebContents(10, 'https://claude.ai/epitaxy?coldLaunch=1');
    wc.loading = true;
    wc.pinnedPage = true;
    const h = harness([wc]);
    await h.settle();

    wc.loading = false;
    wc.emit('did-finish-load');
    await h.settle();

    assert.equal(wc.reloads, 0);
    assert.equal(wc.debugger.isAttached(), true);
    h.dispose();
});

test('fails open when the redirect canary is not observed', async () => {
    const wc = new FakeWebContents(5, 'https://claude.ai/epitaxy/local_canary');
    const h = harness([wc]);
    await h.settle();

    const begin = await h.methods.get('beginCanary')({}, { sender: wc });
    const finish = h.methods.get('finishCanary')({ token: begin.token, ok: true }, { sender: wc });
    assert.deepEqual(finish, { ok: false, failed: true });
    await h.settle();
    assert.equal(wc.debugger.isAttached(), false);
    assert.match(h.methods.get('status')({}, { sender: wc }).failed, /canary failed/);
    h.dispose();
});

test('rejects health sent by the document being replaced', async () => {
    const wc = new FakeWebContents(6, 'https://claude.ai/epitaxy/local_generation');
    const h = harness([wc]);
    await h.settle();
    const oldFrame = wc.mainFrame;

    await beginRelease(h, wc);
    assert.equal(h.methods.get('healthy')({ ready: true, timeOrigin: 1000 },
        { sender: wc, senderFrame: oldFrame }), false);
    assert.equal(h.methods.get('status')({}, { sender: wc }).awaitingLoadFinish, true);

    wc.mainFrame = { id: 'frame-6-next' };
    wc.emit('did-finish-load');
    assert.equal(h.methods.get('healthy')({ ready: true, timeOrigin: 1000 },
        { sender: wc, senderFrame: oldFrame }), false);
    assert.equal(h.methods.get('status')({}, { sender: wc }).awaitingHealth, true);
    assert.equal(h.methods.get('healthy')({ ready: true, timeOrigin: 2000 },
        { sender: wc, senderFrame: wc.mainFrame }), true);
    assert.equal(h.methods.get('status')({}, { sender: wc }).awaitingHealth, false);
    h.dispose();
});

test('reloads once without the gate when a pinned page misses health', async () => {
    const wc = new FakeWebContents(6, 'https://claude.ai/epitaxy/local_health');
    const h = harness([wc]);
    await h.settle();
    await beginRelease(h, wc, ASSET_ROOT + 'index-Future.js');

    const realNow = Date.now;
    Date.now = () => realNow() + 31000;
    try { for (const interval of h.intervals) interval(); }
    finally { Date.now = realNow; }
    await h.settle();

    assert.equal(wc.debugger.isAttached(), false);
    assert.equal(wc.reloads, 1);
    assert.match(h.methods.get('status')({}, { sender: wc }).failed, /did not mount/);
    h.dispose();
});

test('stays attached and rewrites a document that redirects into Code', async () => {
    const wc = new FakeWebContents(9, 'https://claude.ai/epitaxy/local_bounce');
    const h = harness([wc]);
    await h.settle();

    wc.emit('did-start-navigation', {}, 'https://claude.ai/code', false, true);
    await h.settle();
    assert.equal(wc.debugger.isAttached(), true);
    wc.debugger.documentBody = releaseDocument(ASSET_ROOT + 'index-Bounce.js', [
        ASSET_ROOT + 'shared-frame-Bounce.css', ASSET_ROOT + 'shared-styles-Bounce.css', ASSET_ROOT + 'c6a992d55-Bounce.css',
    ]);
    wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
        requestId: 'bounced', resourceType: 'Document', responseStatusCode: 200,
        request: { url: 'https://claude.ai/epitaxy/local_bounce' }, responseHeaders: [],
    });
    await h.settle();
    const call = wc.debugger.commands.find((item) => item.params?.requestId === 'bounced' && item.method !== 'Fetch.getResponseBody');
    assert.equal(call.method, 'Fetch.fulfillRequest');
    wc.emit('did-finish-load');
    await h.settle();
    assert.equal(h.methods.get('status')({}, { sender: wc }).failed, null);
    h.dispose();
});

test('a finished non-Code navigation is not a missed document', async () => {
    const wc = new FakeWebContents(10, 'https://claude.ai/epitaxy/local_leave');
    const h = harness([wc]);
    await h.settle();
    wc.emit('did-start-navigation', {}, 'https://claude.ai/settings', false, true);
    wc.url = 'https://claude.ai/settings';
    wc.emit('did-finish-load');
    await h.settle();
    assert.equal(h.methods.get('status')({}, { sender: wc }).failed, null);
    assert.equal(wc.reloads, 0);
    h.dispose();
});

test('does not redirect an entry requested while leaving Code', async () => {
    const wc = new FakeWebContents(7, 'https://claude.ai/epitaxy/local_leaving');
    const h = harness([wc]);
    await h.settle();

    wc.emit('did-start-navigation', {}, 'https://claude.ai/settings', false, true);
    wc.debugger.emit('message', {}, 'Fetch.requestPaused', {
        requestId: 'leaving',
        request: { url: 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-Settings.js' },
    });
    await h.settle();

    const call = wc.debugger.commands.find((item) => item.params?.requestId === 'leaving');
    assert.deepEqual(call, { method: 'Fetch.continueRequest', params: { requestId: 'leaving' } });
    h.dispose();
});

test('hands the debugger directly to a hot successor generation', async () => {
    const wc = new FakeWebContents(8, 'https://claude.ai/epitaxy/local_handoff');
    const app = new EventEmitter();
    const first = harness([wc], { app });
    await first.settle();
    assert.equal(wc.debugger.attachCalls, 1);

    const second = harness([wc], { app });
    await second.settle();
    first.dispose();
    await second.settle();

    assert.equal(wc.debugger.attachCalls, 2);
    assert.equal(wc.debugger.isAttached(), true);
    second.dispose();
    await second.settle();
    assert.equal(wc.debugger.isAttached(), false);
});

test('does not detach a debugger client that wins the attach race', async () => {
    const wc = new FakeWebContents(7, 'https://claude.ai/epitaxy/local_race', false, true);
    const h = harness([wc]);
    await h.settle();

    assert.equal(wc.debugger.isAttached(), true);
    assert.equal(wc.debugger.detachCalls, 0);
    assert.match(h.methods.get('status')({}, { sender: wc }).lastError, /debugger|race/);
    h.dispose();
    await h.settle();
    assert.equal(wc.debugger.isAttached(), true);
});

test('leaves a view with another debugger client completely untouched', async () => {
    const wc = new FakeWebContents(6, 'https://claude.ai/epitaxy/local_external', true);
    const h = harness([wc]);
    await h.settle();

    const status = h.methods.get('status')({}, { sender: wc });
    assert.equal(status.ready, false);
    assert.match(status.lastError, /already has a debugger client/);
    assert.equal(wc.debugger.detachCalls, 0);
    assert.equal(wc.debugger.listenerCount('detach'), 1);
    wc.emit('did-start-navigation', {}, 'https://claude.ai/settings', false, true);
    assert.equal(wc.debugger.listenerCount('detach'), 0);
    h.dispose();
    await h.settle();
    assert.equal(wc.debugger.isAttached(), true);
});
