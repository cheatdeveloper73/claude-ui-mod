'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { EventEmitter } = require('node:events');
const { createBackend } = require(path.join(PLUGIN_DIR, 'native-backend.js'));

function fixture(options = {}) {
    const events = [], debuggerApi = new EventEmitter();
    let epoch = 1, denied = false;
    const wc = { debugger: debuggerApi, isDestroyed: () => false, getURL: () => 'http://localhost:9999/',
        loadURL: async url => { events.push(['loadURL', url]); } };
    const cdp = {
        webContents: wc, isAttached: () => true,
        evaluate: async () => { throw Error('unexpected page evaluation'); },
        dispatchMouseAt: async () => { throw Error('unexpected native click'); },
        typeText: async () => { throw Error('unexpected native typing'); },
        pressKey: async () => { throw Error('unexpected native key'); },
        hoverAt: async () => {}, scrollAt: async () => {},
        runMousePressGuard: async () => { events.push('subframe-guard'); },
        sendCommand: async (method, params) => {
            events.push(['cdp', method, params]);
            if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'owned-target', type: 'page', url: wc.getURL() } };
            if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: wc.getURL() } } };
            return { result: { value: 7 } };
        },
    };
    debuggerApi.sendCommand = (...args) => cdp.sendCommand(...args);
    const tab = { view: { webContents: wc }, cdpTools: cdp, gate: { toolAccess: 'allowed' } };
    const preview = {
        getPreviewTabs: () => ({ tabs: [{ tabId: 'seed', title: 'fixture' }], activeTabId: 'seed' }),
        getPreviewUrlForTab: () => wc.getURL(),
        getNavCommitEpoch: () => epoch,
        getPreviewTabToolAccessEpoch: () => 1,
        getOwnedTab: (_id, id) => id === 'seed' ? tab : undefined,
    };
    const invoke = async (name, input) => {
        events.push(['native', name, input]);
        if (denied) return { isError: true, content: [{ type: 'text', text: 'user declined' }] };
        if (name === 'navigate') await wc.loadURL(input.url);
        if (name === 'javascript_tool') await cdp.evaluate('{' + input.text + '\n}');
        if (name === 'computer') {
            if (input.action === 'type') await cdp.typeText(input.text);
            else if (input.action === 'key') await cdp.pressKey({ key: input.text });
            else if (input.action === 'scroll') await cdp.scrollAt(...input.coordinate);
            else if (input.action === 'hover') await cdp.hoverAt(...input.coordinate);
            else await cdp.dispatchMouseAt(...input.coordinate);
        }
        return { content: [{ type: 'text', text: 'ok' }] };
    };
    const backend = createBackend({ sessionId: 'local_fixture', codexSessionId: 'codex_fixture', preview, invoke,
        createBlank: () => 'seed', validate() {}, onDispose() {}, ...options });
    const request = (method, params = {}) => backend.invoke(method, { ...params, session_id: 'codex_fixture', turn_id: 'turn' });
    return { backend, request, events, tab, deny: () => { denied = true; }, navigate: () => { epoch++; } };
}

test('screenshots use the native capture path instead of a hidden-surface CDP wait', async () => {
    const captures = [], f = fixture({ captureScreenshot: async (...args) => { captures.push(args); return { data: 'native-png' }; } });
    await f.request('getTabs'); f.events.length = 0;
    const result = await f.request('executeCdp', { target: { tabId: 1 }, method: 'Page.captureScreenshot', commandParams: { format: 'png' } });
    assert.equal(result.data, 'native-png'); assert.deepEqual(captures, [['seed', { format: 'png' }]]);
    assert.deepEqual(f.events, []); await f.backend.close();
});

test('official clipboard instrumentation is tracked and removed on shutdown', async () => {
    const f = fixture({ allowScript: (source, bindings) => source === 'official-helper' && bindings.has('clipboard') ? 'clipboard' : null });
    await f.request('getTabs');
    const command = (method, commandParams) => f.request('executeCdp', { target: { tabId: 1 }, method, commandParams });
    await command('Runtime.addBinding', { name: 'clipboard' });
    await assert.rejects(command('Page.addScriptToEvaluateOnNewDocument', { runImmediately: true, source: 'arbitrary script' }), /persistent/);
    await command('Page.addScriptToEvaluateOnNewDocument', { runImmediately: true, source: 'official-helper' });
    await f.backend.close();
    assert.ok(f.events.some(row => row[0] === 'cdp' && row[1] === 'Page.removeScriptToEvaluateOnNewDocument' && row[2].identifier === 'owned-script'));
    assert.ok(f.events.some(row => row[0] === 'cdp' && row[1] === 'Runtime.removeBinding' && row[2].name === 'clipboard'));
});

test('inventory maps only owned native tabs to positive Codex IDs', async () => {
    const { request, backend } = fixture();
    assert.equal((await request('getInfo')).type, 'iab');
    const tabs = await request('getTabs');
    assert.equal(tabs.length, 1); assert.equal(tabs[0].id, 1);
    assert.equal(tabs[0].providerTabId, 'seed');
    backend.close();
});

test('wrong session, unknown tab, foreign target and browser-global CDP fail before native access', async () => {
    const { backend, request, events } = fixture();
    await assert.rejects(backend.invoke('getTabs', { session_id: 'other', turn_id: 'turn' }), /session/i);
    await request('getTabs'); events.length = 0;
    await assert.rejects(request('executeCdp', { target: { tabId: 99 }, method: 'Runtime.evaluate', commandParams: {} }), /tab/i);
    await assert.rejects(request('executeCdp', { target: { tabId: 1, targetId: 'foreign' }, method: 'Runtime.evaluate', commandParams: {} }), /target|frame/i);
    await assert.rejects(request('executeCdp', { target: { tabId: 1 }, method: 'Network.getAllCookies', commandParams: {} }), /unsupported/i);
    assert.deepEqual(events, []); backend.close();
});

test('actual JavaScript request is visible to native gate and executes once inside it', async () => {
    const { backend, request, events } = fixture(); await request('getTabs'); events.length = 0;
    const value = await request('executeCdp', { target: { tabId: 1 }, method: 'Runtime.evaluate', commandParams: { expression: '6 + 1', returnByValue: true } });
    assert.equal(value.result.value, 7);
    assert.equal(events[0][0], 'native'); assert.match(events[0][2].text, /6 \+ 1/);
    assert.equal(events.filter(row => row[0] === 'cdp' && row[1] === 'Runtime.evaluate').length, 1);
    backend.close();
});

test('native denial dispatches no raw JavaScript or input', async () => {
    const { backend, request, events, deny } = fixture(); await request('getTabs'); events.length = 0; deny();
    await assert.rejects(request('executeCdp', { target: { tabId: 1 }, method: 'Runtime.evaluate', commandParams: { expression: 'location.href' } }), /declined/);
    await assert.rejects(request('executeCdp', { target: { tabId: 1 }, method: 'Input.insertText', commandParams: { text: 'hello' } }), /declined/);
    assert.ok(events.every(row => row[0] === 'native')); backend.close();
});

test('input uses native attribution envelope and mouse subframe guard', async () => {
    const { backend, request, events } = fixture(); await request('getTabs'); events.length = 0;
    await request('executeCdp', { target: { tabId: 1 }, method: 'Input.dispatchMouseEvent', commandParams: { type: 'mousePressed', button: 'left', x: 10, y: 20 } });
    assert.equal(events[0][0], 'native'); assert.equal(events[0][1], 'computer');
    assert.ok(events.includes('subframe-guard'));
    assert.equal(events.filter(row => row[0] === 'cdp' && row[1] === 'Input.dispatchMouseEvent').length, 1);
    backend.close();
});

test('input approvals preserve wheel direction and modifiers; unsupported mouse buttons fail closed', async () => {
    const f = fixture(); await f.request('getTabs'); f.events.length = 0;
    const command = commandParams => f.request('executeCdp', { target: { tabId: 1 }, method: 'Input.dispatchMouseEvent', commandParams });
    await command({ type: 'mouseWheel', x: 10, y: 20, deltaY: -800, deltaX: 0 });
    assert.equal(f.events[0][2].scroll_direction, 'up'); assert.equal(f.events[0][2].scroll_amount, 8);
    f.events.length = 0;
    await command({ type: 'mousePressed', button: 'left', x: 10, y: 20, clickCount: 2, modifiers: 10 });
    assert.equal(f.events[0][2].action, 'double_click'); assert.equal(f.events[0][2].modifiers, 'ctrl+shift');
    f.events.length = 0;
    await assert.rejects(command({ type: 'mousePressed', button: 'middle', x: 10, y: 20 }), /unsupported/i);
    assert.deepEqual(f.events, []); f.backend.close();
});

test('a fresh native view with an empty committed URL supports blank-document bootstrap', async () => {
    const f = fixture(); f.tab.view.webContents.getURL = () => '';
    await f.request('getTabs'); f.deny(); f.events.length = 0;
    assert.equal(await f.request('getCommittedTabUrl', { tabId: 1 }), 'about:blank');
    await f.request('executeCdp', { target: { tabId: 1 }, method: 'Page.enable', commandParams: {} });
    assert.ok(!f.events.some(row => row[0] === 'native'));
    await f.backend.close();
});

test('cancel during blank-tab attachment dispatches no later bootstrap command', async () => {
    const f = fixture();
    f.tab.view.webContents.getURL = () => 'about:blank';
    await f.request('getTabs');
    let release;
    f.tab.cdpTools.isAttached = () => false;
    f.tab.cdpTools.attach = () => new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const pending = f.backend.invoke('executeCdp', { session_id: 'codex_fixture', turn_id: 'turn', target: { tabId: 1 }, method: 'Runtime.enable' }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release();
    await assert.rejects(pending, /cancelled/);
    assert.ok(!f.events.some(row => row[0] === 'cdp' && row[1] === 'Runtime.enable'));
    f.backend.close();
});

test('failed frame initialization can be retried without losing debugger events', async () => {
    const f = fixture(); await f.request('getTabs');
    const original = f.tab.cdpTools.sendCommand; let first = true;
    f.tab.cdpTools.sendCommand = (...args) => { if (first) { first = false; return Promise.reject(Error('frame temporarily absent')); } return original(...args); };
    await assert.rejects(f.request('attach', { tabId: 1 }), /temporarily/);
    await f.request('attach', { tabId: 1 });
    assert.equal(f.tab.view.webContents.debugger.listenerCount('message'), 1);
    f.backend.close();
});

test('Codex tab closure sees only its own target and rejects a foreign close', async () => {
    const f = fixture(); await f.request('getTabs');
    const command = (method, commandParams) => f.request('executeCdp', { target: { tabId: 1 }, method, commandParams });
    const targets = await command('Target.getTargets', {});
    assert.deepEqual(targets.targetInfos.map(row => [row.targetId, row.tabId]), [['owned-target', 1]]);
    await assert.rejects(command('Target.closeTarget', { targetId: 'foreign' }), /target/);
    assert.ok(!f.events.some(row => row[0] === 'native' && row[1] === 'tabs_close'));
    await command('Target.closeTarget', { targetId: 'owned-target' });
    assert.ok(f.events.some(row => row[0] === 'native' && row[1] === 'tabs_close' && row[2].tabId === 'seed'));
    await f.backend.close();
});

test('native navigation retains real completion events while the blank-document gate changes', async () => {
    const f = fixture(), notifications = [], wc = f.tab.view.webContents;
    await f.request('getTabs'); await f.request('attach', { tabId: 1 });
    f.backend.setNotify((name, params) => notifications.push({ name, ...params }));
    wc.loadURL = async url => {
        f.tab.gate.toolAccess = 'needs-grant';
        wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'root', url } });
        f.tab.gate.toolAccess = 'allowed';
        wc.getURL = () => url;
        wc.debugger.emit('message', {}, 'Page.domContentEventFired', { timestamp: 1 });
    };
    await f.request('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: 'https://fixture.test/' } });
    assert.deepEqual(notifications.map(row => row.method), ['Page.frameNavigated', 'Page.domContentEventFired']);
    await f.backend.close();
});

test('navigation uses native URL approval path and never raw Page.navigate', async () => {
    const { backend, request, events } = fixture(); await request('getTabs'); events.length = 0;
    await request('executeCdp', { target: { tabId: 1 }, method: 'Page.navigate', commandParams: { url: 'https://example.test/path' } });
    const admission = events.findIndex(row => row[0] === 'native' && row[1] === 'navigate');
    assert.ok(admission >= 0 && admission < events.findIndex(row => row[0] === 'loadURL'));
    assert.ok(!events.some(row => row[0] === 'cdp' && row[1] === 'Page.navigate')); backend.close();
});
