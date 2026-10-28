'use strict';
const path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { createNativeAdapter } = require(path.join(PLUGIN_DIR, 'native-adapter.js'));
const { AsyncResource } = require('node:async_hooks');
const { nativeCall, guardedNativeAction } = require(path.join(PLUGIN_DIR, 'native-call.js'));
function fixture() {
    const calls = [], tabs = new Map(), app = new EventEmitter(), disposers = [], nativeEvents = new AsyncResource('native-electron-events');
    let denied = false, epoch = 0, held, release, nativeBlank = false;
    function make(id, url = 'http://fixture.test/') {
        const debuggerObject = new EventEmitter();
        debuggerObject.isAttached = () => true;
        debuggerObject.sendCommand = async (method, params) => {
            calls.push([id, method, params]);
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root-' + id, url } } };
            return { result: { type: 'string', value: 'native-original' } };
        };
        const wc = { id, debugger: debuggerObject, isDestroyed: () => false, getURL: () => url,
            getTitle: () => 'Fixture', loadURL(next) { url = next; epoch++; return Promise.resolve(); },
            navigationHistory: { goToIndex(index) { calls.push([id, 'history', index]); } } };
        return wc;
    }
    tabs.set('seed', make(1));
    const other = make(99), contents = () => [...tabs.values(), other];
    const preview = { getPreviewUrlForTab: (_sid, id) => tabs.get(id)?.getURL() ?? null,
        getNavCommitEpoch: () => epoch, checkToolAccessGate: () => denied ? { state: 'needs-grant' } : null,
        hasPreviewContext: () => true, describeOriginlessPreviewTab: () => nativeBlank ? 'blank' : 'other' };
    const invoke = async (name, input) => {
        if (held) await held;
        if (name === 'tabs_context') return { content: [{ type: 'text', text: JSON.stringify({ browserOpen: true,
            tabs: [...tabs.keys()].map(tabId => ({ tabId, origin: 'http://fixture.test', isActive: tabId === 'seed' })) }, null, 2) + '\nVisible pane' }] };
        if (name === 'tabs_create') {
            const id = 'new-' + tabs.size, wc = make(tabs.size + 1, 'about:blank'); tabs.set(id, wc);
            nativeEvents.runInAsyncScope(() => app.emit('web-contents-created', {}, wc));
            return { content: [{ type: 'text', text: JSON.stringify({ tabId: id }, null, 2) + '\nCreated' }] };
        }
        if (denied) return { isError: true, content: [{ type: 'text', text: 'native refusal' }] };
        const wc = tabs.get(input.tabId);
        if (!wc) return { isError: true, content: [{ type: 'text', text: 'tab gone' }] };
        if (name === 'javascript_tool' && input.text.includes('window.innerWidth')) return { content: [{ type: 'text', text: '{"w":100,"h":100}' }] };
        if (name === 'computer' && input.action === 'screenshot') return { content: [{ type: 'text', text: 'Screenshot size: 200x200' }] };
        if (name === 'computer' && input.action === 'hover') {
            calls.push(['native-input', input.coordinate]);
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: input.coordinate[0] / 2, y: input.coordinate[1] / 2 });
            return { content: [] };
        }
        if (name === 'javascript_tool') {
            const result = await wc.debugger.sendCommand('Runtime.evaluate', { expression: '{' + input.text + '\n}' });
            calls.push(['postcheck']);
            return { content: [{ type: 'text', text: String(result.result.value) }] };
        }
        if (name === 'navigate') {
            if (input.url === 'back') assert.equal(wc.navigationHistory.goToIndex(0), undefined);
            else await wc.loadURL(input.url);
            return { content: [{ type: 'text', text: 'navigated' }] };
        }
        throw Error('unexpected native tool ' + name);
    };
    const adapter = createNativeAdapter({ sessionId: 'session', preview, launch: {}, invoke,
        electron: { app, webContents: { getAllWebContents: contents } }, onDispose: fn => disposers.push(fn) });
    const tab = () => adapter.preview.getOwnedTab('preview-session', 'seed');
    const admitted = (operation, signal) => nativeCall({ tabId: 'seed', getTab: tab, identity: () => epoch, validate() {},
        invoke: adapter.invoke, code: 'document.title', signal }, 'test', operation);
    return { adapter, tabs, other, calls, tab, admitted, disposers, deny: () => { denied = true; },
        holdNative() { held = new Promise(resolve => { release = resolve; }); },
        releaseNative() { held = null; release(); }, markNativeBlank() { nativeBlank = true; } };
}
test('capture actual dispatch after native admission and preserve the native postcheck', async () => {
    const f = fixture(), original = f.tabs.get('seed').debugger.sendCommand;
    const result = await f.admitted(cdp => cdp.sendCommand('DOM.getDocument', {}));
    assert.equal(result.result.value, 'native-original');
    assert.deepEqual(f.calls.map(row => row[1] || row[0]), ['DOM.getDocument', 'postcheck']);
    assert.equal(f.tabs.get('seed').debugger.sendCommand, original);
});
test('CSS pointer coordinates are converted to the native screenshot frame before its guard', async () => {
    const f = fixture(), params = { type: 'mouseMoved', x: 10, y: 20 };
    await nativeCall({ tabId: 'seed', getTab: f.tab, identity: () => 0, validate() {}, invoke: f.adapter.invoke,
        plan: { tool: 'computer', slot: 'hoverAt', input: { tabId: 'seed', action: 'hover', coordinate: [10, 20] },
            expected: { method: 'Input.dispatchMouseEvent', params } } }, 'pointer', cdp => cdp.sendCommand('Input.dispatchMouseEvent', params));
    assert.ok(f.calls.some(row => row[0] === 'native-input' && row[1][0] === 20 && row[1][1] === 40));
    assert.ok(f.calls.some(row => row[1] === 'Input.dispatchMouseEvent' && row[2].x === 10 && row[2].y === 20));
});

test('native denial dispatches no raw command and restores all temporary hooks', async () => {
    const f = fixture(), original = f.tabs.get('seed').debugger.sendCommand; f.deny();
    await assert.rejects(f.admitted(cdp => cdp.sendCommand('DOM.getDocument', {})), /native refusal/);
    assert.equal(f.calls.length, 0); assert.equal(f.tabs.get('seed').debugger.sendCommand, original);
});
test('cancellation before native dispatch cannot become a late original page action', async () => {
    const f = fixture(), controller = new AbortController(), original = f.tabs.get('seed').debugger.sendCommand;
    f.holdNative();
    const pending = f.admitted(cdp => cdp.sendCommand('DOM.getDocument', {}), controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, /cancelled/);
    f.releaseNative(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0);
    assert.equal(f.tabs.get('seed').debugger.sendCommand, original);
});

test('cancelled native dispatch drains before the next invocation and then restores hooks', async () => {
    const f = fixture(), controller = new AbortController(), original = f.tabs.get('seed').debugger.sendCommand;
    let release;
    const pending = f.admitted(() => new Promise(resolve => { release = resolve; }), controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, /cancelled/);
    await assert.rejects(f.admitted(() => undefined), /draining/);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.tabs.get('seed').debugger.sendCommand, original);
});

test('only the native blank-page classification normalizes its internal document URL', async () => {
    const f = fixture(), url = 'data:text/html,<h1>native placeholder</h1>';
    await f.tabs.get('seed').loadURL(url);
    assert.equal(f.adapter.preview.getPreviewUrlForTab('preview-session', 'seed'), url);
    f.markNativeBlank();
    assert.equal(f.adapter.preview.getPreviewUrlForTab('preview-session', 'seed'), 'about:blank');
    assert.equal(f.adapter.preview.getPreviewUrlForTab('preview-session', 'foreign'), null);
});

test('inventory uses the actual native tabs tool without private test exports', async () => {
    const f = fixture(); await f.adapter.preview.refresh();
    assert.deepEqual(f.adapter.preview.getPreviewTabs().tabs.map(row => row.tabId), ['seed']);
    assert.equal(f.adapter.preview.getPreviewTabs().activeTabId, 'seed');
});
test('a newly created blank tab is owned by its scoped native creation event', async () => {
    const f = fixture(), id = await f.adapter.createBlank();
    const tab = f.adapter.preview.getOwnedTab('preview-session', id);
    assert.equal(tab.view.webContents.getURL(), 'about:blank'); assert.equal(tab.cdpTools.isAttached(), true);
    assert.equal(f.adapter.preview.getOwnedTab('preview-session', 'foreign'), undefined);
});
test('navigation delegates through native admission and preserves synchronous history', async () => {
    const f = fixture(), item = f.tab();
    await guardedNativeAction({ object: item.view.webContents, slot: 'loadURL', getTab: f.tab, validate() {},
        invoke: () => f.adapter.invoke('navigate', { tabId: 'seed', url: 'http://fixture.test/next' }) });
    assert.equal(item.view.webContents.getURL(), 'http://fixture.test/next');
    await guardedNativeAction({ object: item.view.webContents.navigationHistory, slot: 'goToIndex', getTab: f.tab, validate() {},
        invoke: () => f.adapter.invoke('navigate', { tabId: 'seed', url: 'back' }) });
    assert.deepEqual(f.calls, [[1, 'history', 0]]);
});
