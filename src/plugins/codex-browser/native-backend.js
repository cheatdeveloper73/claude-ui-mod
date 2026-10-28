'use strict';
const { nativeCall, guardedNativeAction } = require('./native-call');

const COMMANDS = new Set([
    'Runtime.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.getProperties',
    'Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Runtime.addBinding', 'Runtime.removeBinding',
    'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.getNavigationHistory',
    'Page.setLifecycleEventsEnabled', 'Page.createIsolatedWorld', 'Page.captureScreenshot',
    'Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument',
    'Accessibility.enable', 'Accessibility.getFullAXTree',
    'DOM.enable', 'DOM.describeNode', 'DOM.getDocument', 'DOM.getBoxModel', 'DOM.getContentQuads',
    'DOM.getFrameOwner', 'DOM.getNodeForLocation', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded',
    'DOMSnapshot.captureSnapshot', 'Emulation.setFocusEmulationEnabled',
    'Target.getTargetInfo', 'Target.setAutoAttach',
    'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);
const BOOTSTRAP = new Set(['Runtime.enable', 'Page.enable', 'Page.disable', 'Page.getFrameTree',
    'Page.setLifecycleEventsEnabled', 'Emulation.setFocusEmulationEnabled', 'Target.getTargetInfo', 'Target.setAutoAttach']);
const EVENTS = new Set(['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed',
    'Runtime.executionContextsCleared', 'Runtime.bindingCalled', 'Page.frameNavigated', 'Page.frameAttached',
    'Page.frameDetached', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.navigatedWithinDocument',
    'Page.loadEventFired', 'Page.domContentEventFired', 'Page.lifecycleEvent']);
const textOf = result => result?.content?.filter(row => row.type === 'text').map(row => row.text).join('\n');
function origin(url) { try { return new URL(url).origin; } catch (_) { return null; } }
function fallback(message) { return Error(message + ' Use the original Claude Browser tools for this operation; do not replay an uncertain action.'); }

function createBackend({ sessionId, codexSessionId, preview, invoke, createBlank, validate, onDispose, allowScript = () => null, captureScreenshot }) {
    const previewId = 'preview-' + sessionId;
    const ids = new Map(), records = new Map(), queues = new Map(), detach = new Set();
    let nextId = 1, closed = false, notify = () => {};
    function check(params) {
        if (closed) throw Error('Codex browser backend is closed');
        validate();
        if (params.session_id !== codexSessionId || typeof params.turn_id !== 'string') throw Error('browser session mismatch');
    }
    function nativeTab(nativeId) { return preview.getOwnedTab(previewId, nativeId); }
    function record(nativeId) {
        const tab = nativeTab(nativeId);
        if (!tab || tab.view.webContents.isDestroyed()) throw Error('native browser tab closed');
        let id = ids.get(nativeId);
        if (id && records.get(id).tab !== tab) { ids.delete(nativeId); id = null; }
        if (!id) {
            id = nextId++; ids.set(nativeId, id);
            records.set(id, { id, nativeId, tab, contexts: new Set(), frameId: null, bindings: new Set(), scripts: new Map() });
        }
        const value = records.get(id);
        if (value.tab !== tab) throw Error('native browser tab identity changed');
        return value;
    }
    function target(value) {
        if (!value || !Number.isInteger(value.tabId) || value.targetId || value.sessionId)
            throw fallback('A foreign frame/target was requested.');
        const result = records.get(value.tabId);
        if (!result || nativeTab(result.nativeId) !== result.tab) throw Error('browser tab not owned by this session');
        return result;
    }
    function identity(item) {
        return preview.getNavCommitEpoch(previewId, item.nativeId);
    }
    async function native(name, input) {
        validate();
        const result = await invoke(name, input);
        if (result?.isError) throw Error(textOf(result) || 'native browser request refused');
        return result;
    }
    function serialize(item, work) {
        const previous = queues.get(item.id) || Promise.resolve();
        const current = previous.catch(() => {}).then(work);
        queues.set(item.id, current);
        current.finally(() => { if (queues.get(item.id) === current) queues.delete(item.id); }).catch(() => {});
        return current;
    }
    function list() {
        return preview.getPreviewTabs(previewId).tabs.map(row => {
            const item = record(row.tabId), allowed = item.tab.gate.toolAccess === 'allowed';
            const url = preview.getPreviewUrlForTab(previewId, row.tabId) || 'about:blank';
            return { id: item.id, providerTabId: row.tabId, title: allowed ? row.title : 'Claude browser tab',
                url: allowed || url === 'about:blank' ? url : origin(url) || 'about:blank',
                active: preview.getPreviewTabs(previewId).activeTabId === row.tabId };
        });
    }
    function active(signal) { if (closed || signal?.aborted) throw Error('browser operation cancelled'); }
    async function attach(item, signal) {
        active(signal);
        if (item.listening) return;
        if (item.attaching) return item.attaching;
        item.attaching = initialize(item, signal);
        try { return await item.attaching; } finally { item.attaching = null; }
    }
    async function initialize(item, signal) {
        const { cdpTools: cdp, view } = item.tab;
        if (!cdp.isAttached()) await cdp.attach(view.webContents);
        active(signal);
        const tree = await cdp.sendCommand('Page.getFrameTree', {});
        active(signal);
        item.frameId = tree.frameTree.frame.id;
        const listener = (_event, method, params, childSession) => {
            if (closed || childSession || !EVENTS.has(method)) return;
            try { validate(); } catch (_) { return; }
            if (nativeTab(item.nativeId) !== item.tab) return;
            if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
                item.frameId = params.frame.id; item.contexts.clear();
            }
            if (method === 'Runtime.executionContextCreated') {
                if (params.context?.auxData?.frameId !== item.frameId) return;
                item.contexts.add(params.context.id);
            } else if (method === 'Runtime.executionContextsCleared') item.contexts.clear();
            else if (method === 'Runtime.executionContextDestroyed') item.contexts.delete(params.executionContextId);
            if (item.navigation && method.startsWith('Page.')) {
                if (item.navigation.length >= 256) item.navigationOverflow = true;
                else item.navigation.push({ method, params });
                return;
            }
            if (item.tab.gate.toolAccess !== 'allowed') return;
            notify('onCDPEvent', { source: { tabId: item.id }, method, params });
        };
        const debuggerApi = view.webContents.debugger;
        item.debugger = debuggerApi;
        const remove = () => { debuggerApi.removeListener('message', listener); detach.delete(remove); item.listening = false; };
        item.removeListener = remove;
        detach.add(remove);
        view.webContents.debugger.on('message', listener);
        item.listening = true;
    }
    async function navigation(item, operation, signal) {
        await attach(item, signal);
        item.navigation = []; item.navigationOverflow = false;
        try {
            await operation();
            active(signal); validate();
            if (nativeTab(item.nativeId) !== item.tab || item.tab.gate.toolAccess !== 'allowed')
                throw fallback('Native navigation has no admitted final document.');
            if (item.navigationOverflow) throw fallback('Native navigation event buffer overflowed.');
            const url = preview.getPreviewUrlForTab(previewId, item.nativeId), events = item.navigation;
            const start = events.findLastIndex(event => event.method === 'Page.frameNavigated'
                && !event.params.frame?.parentId && event.params.frame?.url === url
                || event.method === 'Page.navigatedWithinDocument' && event.params.url === url);
            // The native gate still describes about:blank during frameNavigated.
            // Release observed events only after native navigation admits its final
            // document; do not fabricate load events or expose redirect documents.
            if (start >= 0) for (const event of events.slice(start)) {
                if (event.params.frame && (event.params.frame.parentId || event.params.frame.id !== item.frameId)
                    || event.params.frameId && event.params.frameId !== item.frameId) continue;
                notify('onCDPEvent', { source: { tabId: item.id }, ...event });
            }
        } finally { item.navigation = null; }
    }
    function inputPlan(method, params, nativeId) {
        const input = { tabId: nativeId, action_summary: 'Codex browser ' + method + ' ' + JSON.stringify(params) };
        const mask = params.modifiers || 0;
        if (!Number.isInteger(mask) || mask < 0 || mask > 15) throw fallback('Unsupported input modifiers.');
        const modifiers = [[1, 'alt'], [2, 'ctrl'], [4, 'meta'], [8, 'shift']].filter(([bit]) => mask & bit).map(([, name]) => name).join('+');
        if (method === 'Input.insertText') return { tool: 'computer', slot: 'typeText', input: { ...input, action: 'type', text: params.text } };
        if (method === 'Input.dispatchKeyEvent') {
            const key = params.key === ' ' ? 'Space' : String(params.key || '');
            if (!key || /\s/.test(key) || params.commands?.length || /^(copy|cut|paste)$/i.test(key)
                || (mask & 6) && /^(c|x|v|insert)$/i.test(key)
                || (mask & 8) && /^(insert|delete)$/i.test(key)) throw fallback('Clipboard/system key dispatch is unsupported.');
            return { tool: 'computer', slot: 'pressKey', input: { ...input, action: 'key', text: (modifiers ? modifiers + '+' : '') + key } };
        }
        if (method === 'Input.dispatchMouseEvent') {
            if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) throw Error('invalid pointer coordinates');
            if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(params.type)) throw fallback('Unsupported pointer event.');
            if (params.button && !['none', 'left', 'right'].includes(params.button)) throw fallback('Unsupported mouse button.');
            const count = params.clickCount || 1;
            if (![1, 2, 3].includes(count) || params.button === 'right' && count !== 1) throw fallback('Unsupported mouse click count.');
            const slot = params.type === 'mouseMoved' ? 'hoverAt' : params.type === 'mouseWheel' ? 'scrollAt' : 'dispatchMouseAt';
            const action = params.type === 'mouseMoved' ? 'hover' : params.type === 'mouseWheel' ? 'scroll' : params.button === 'right' ? 'right_click'
                : count === 2 ? 'double_click' : count === 3 ? 'triple_click' : 'left_click';
            const plan = { ...input, action, coordinate: [params.x, params.y], modifiers };
            if (params.type === 'mouseWheel') {
                const dx = params.deltaX || 0, dy = params.deltaY || 0, delta = dx || dy;
                if (dx && dy || !Number.isFinite(delta) || Math.abs(delta) < 100 || Math.abs(delta) > 1000)
                    throw fallback('Unsupported native wheel range or diagonal scroll.');
                plan.scroll_direction = dx ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down';
                plan.scroll_amount = Math.abs(delta) / 100;
            }
            return { tool: 'computer', slot, input: plan };
        }
        return null;
    }
    async function execute(item, method, params, signal) {
        if (!COMMANDS.has(method)) throw fallback('Unsupported CDP command: ' + method + '.');
        const scriptBinding = method === 'Page.addScriptToEvaluateOnNewDocument' ? allowScript(params.source, item.bindings) : null;
        if (method === 'Page.addScriptToEvaluateOnNewDocument' && (!scriptBinding || params.runImmediately !== true
            || Object.keys(params).some(key => !['source', 'runImmediately'].includes(key)))) throw fallback('Unsupported persistent page script.');
        if (method === 'Page.removeScriptToEvaluateOnNewDocument' && !item.scripts.has(params.identifier)
            || method === 'Runtime.removeBinding' && !item.bindings.has(params.name)) throw fallback('Browser instrumentation is not owned by this runtime.');
        if (params.targetId || params.sessionId || params.grantUniveralAccess || params.grantUniversalAccess)
            throw fallback('Unscoped CDP target or universal-access request.');
        if (method === 'Target.setAutoAttach' && params.waitForDebuggerOnStart)
            throw fallback('Pausing descendant targets is unsupported.');
        if (method === 'Input.dispatchMouseEvent') params = { ...params, x: Math.round(params.x), y: Math.round(params.y) };
        const plan = inputPlan(method, params, item.nativeId);
        if (plan) plan.expected = { method, params };
        const url = preview.getPreviewUrlForTab(previewId, item.nativeId);
        // Instrumentation on the native blank document reads no external page.
        if ((url === '' || url === 'about:blank') && BOOTSTRAP.has(method)) {
            if (signal?.aborted) throw Error('browser operation cancelled');
            await attach(item, signal);
            return item.tab.cdpTools.sendCommand(method, params);
        }
        return nativeCall({ tabId: item.nativeId, getTab: () => nativeTab(item.nativeId), identity: () => identity(item),
            validate, invoke, signal, plan,
            code: method === 'Runtime.evaluate' ? params.expression : undefined,
            before: !item.tab.cdpTools.nativeInputGuarded && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed'
                ? cdp => cdp.runMousePressGuard([{ x: params.x, y: params.y }]) : undefined,
        }, method + ' ' + JSON.stringify(params), async (cdp, _tab, ensureCurrent) => {
            await attach(item, signal);
            if (params.contextId !== undefined && !item.contexts.has(params.contextId)
                || params.executionContextId !== undefined && !item.contexts.has(params.executionContextId))
                throw fallback('Unapproved execution context.');
            if (params.frameId && params.frameId !== item.frameId) throw fallback('Unapproved frame.');
            if (method === 'DOMSnapshot.captureSnapshot' || method === 'DOM.getDocument' && (params.depth < 0 || params.pierce)) {
                const tree = (await cdp.sendCommand('Page.getFrameTree', {})).frameTree;
                const expected = origin(url), foreign = frame => origin(frame.frame.url) !== expected
                    || (frame.childFrames || []).some(foreign);
                if ((tree.childFrames || []).some(foreign)) throw fallback('A cross-origin frame requires the native browser path.');
            }
            ensureCurrent();
            const result = await cdp.sendCommand(method, method === 'Accessibility.getFullAXTree' ? { ...params, frameId: item.frameId } : params);
            if (method === 'Runtime.addBinding') item.bindings.add(params.name);
            if (method === 'Runtime.removeBinding') item.bindings.delete(params.name);
            if (method === 'Page.addScriptToEvaluateOnNewDocument') item.scripts.set(result.identifier, scriptBinding);
            if (method === 'Page.removeScriptToEvaluateOnNewDocument') item.scripts.delete(params.identifier);
            if (closed && scriptBinding) await cleanup(item);
            return result;
        });
    }
    async function rpc(method, params, { signal } = {}) {
        if (method === 'ping') { if (closed) throw Error('browser backend closed'); validate(); return {}; }
        check(params);
        if (signal?.aborted) throw Error('browser operation cancelled');
        if (method === 'getInfo') return { name: 'Claude browser', type: 'iab', discoveryScope: 'session',
            metadata: { codexSessionId, codexAppBuildFlavor: 'prod' }, capabilities: {}, apiSupportOverrides: { 'Tab.ax': false } };
        if (method === 'getTabs') { await preview.refresh?.(); return list(); }
        if (method === 'ping') return {};
        if (method === 'turnEnded') return {};
        if (method === 'createTab') return serialize({ id: 0 }, async () => {
            check(params);
            if (signal?.aborted) throw Error('browser operation cancelled');
            const nativeId = await createBlank();
            active(signal); await preview.refresh?.();
            return list().find(row => row.providerTabId === nativeId) || (() => { throw Error('native tab creation was not observed'); })();
        });
        if (method === 'attach' || method === 'detach' || method === 'markTab' || method === 'getCommittedTabUrl') {
            const item = target({ tabId: params.tabId });
            if (method === 'attach') { await attach(item, signal); return {}; }
            if (method === 'getCommittedTabUrl') {
                const url = preview.getPreviewUrlForTab(previewId, item.nativeId);
                if (url === '' || url === 'about:blank') return 'about:blank';
                return serialize(item, () => nativeCall({ tabId: item.nativeId, getTab: () => nativeTab(item.nativeId), identity: () => identity(item), validate, invoke, signal,
                    code: 'location.href' }, 'getCommittedTabUrl', async () => preview.getPreviewUrlForTab(previewId, item.nativeId)));
            }
            return {};
        }
        if (method !== 'executeCdp') throw Error('No handler registered for method: ' + method);
        const item = target(params.target), command = params.method, input = params.commandParams || {};
        return serialize(item, async () => {
            check(params);
            if (signal?.aborted) throw Error('browser operation cancelled');
            if (command === 'Page.captureScreenshot' && captureScreenshot) {
                const result = await captureScreenshot(item.nativeId, input);
                active(signal); return result;
            }
            if (command === 'Page.navigate' || command === 'Page.reload') {
                await navigation(item, () => guardedNativeAction({ object: item.tab.view.webContents, slot: 'loadURL', validate,
                    getTab: () => nativeTab(item.nativeId), signal,
                    invoke: () => native('navigate', { tabId: item.nativeId, url: command === 'Page.reload'
                        ? preview.getPreviewUrlForTab(previewId, item.nativeId) : input.url }) }), signal);
                await attach(item, signal);
                const tree = await item.tab.cdpTools.sendCommand('Page.getFrameTree', {});
                item.frameId = tree.frameTree.frame.id;
                return { frameId: item.frameId };
            }
            if (command === 'Target.getTargets') {
                const { targetInfo } = await execute(item, 'Target.getTargetInfo', {}, signal);
                return { targetInfos: [{ ...targetInfo, tabId: item.id }] };
            }
            if (command === 'Target.closeTarget' || command === 'Page.close') {
                if (command === 'Target.closeTarget') {
                    const { targetInfo } = await execute(item, 'Target.getTargetInfo', {}, signal);
                    if (!input.targetId || input.targetId !== targetInfo.targetId) throw fallback('Browser target is not owned by this tab.');
                }
                await native('tabs_close', { tabId: item.nativeId });
                item.removeListener?.(); ids.delete(item.nativeId); records.delete(item.id);
                return command === 'Target.closeTarget' ? { success: true } : {};
            }
            if (command === 'Page.navigateToHistoryEntry') {
                const history = await execute(item, 'Page.getNavigationHistory', {}, signal);
                const index = history.entries.findIndex(entry => entry.id === input.entryId), delta = index - history.currentIndex;
                if (Math.abs(delta) !== 1) throw fallback('Only adjacent native history navigation is supported.');
                await navigation(item, () => guardedNativeAction({ object: item.tab.view.webContents.navigationHistory, slot: 'goToIndex', validate,
                    getTab: () => nativeTab(item.nativeId), signal,
                    invoke: () => native('navigate', { tabId: item.nativeId, url: delta < 0 ? 'back' : 'forward' }) }), signal); return {};
            }
            return execute(item, command, input, signal);
        });
    }
    async function cleanup(item) {
        const debuggerApi = item.debugger;
        if (!debuggerApi || !item.bindings.size && !item.scripts.size) return;
        const names = [...new Set([...item.bindings, ...item.scripts.values()])];
        const send = async (method, params) => { try { await debuggerApi.sendCommand(method, params); } catch (_) {} };
        for (const identifier of item.scripts.keys()) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
        await send('Runtime.evaluate', { expression: '(() => { const bridge = globalThis.__browserUseClipboardBridge; if (bridge && '
            + JSON.stringify(names) + '.includes(bridge.bindingName)) bridge.cleanup(); })()', returnByValue: true });
        for (const name of item.bindings) await send('Runtime.removeBinding', { name });
        item.bindings.clear(); item.scripts.clear();
    }
    function close() {
        if (closed) return;
        closed = true;
        for (const remove of [...detach]) remove();
        return Promise.all([...records.values()].map(cleanup));
    }
    onDispose(close);
    return { invoke: rpc, close, setNotify: fn => { notify = fn; } };
}

module.exports = { createBackend };
