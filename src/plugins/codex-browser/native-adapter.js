'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const dispatch = globalThis[Symbol.for('cuimod.codex-browser-dispatch')] ||= { scope: new AsyncLocalStorage(), hooks: new WeakMap() };
const { scope, hooks } = dispatch;

function original(object, slot) { return hooks.get(object)?.get(slot)?.original || object[slot]; }
async function intercepted(entries, route, invoke, signal) {
    const acquired = [], allowed = new Set();
    let transferred = false;
    const release = () => {
        for (const { object, slot, hook, slots } of acquired.reverse()) {
            if (--hook.users) continue;
            if (object[slot] === hook.wrapper) { if (hook.own) object[slot] = hook.original; else delete object[slot]; }
            slots.delete(slot);
        }
    };
    if (signal?.aborted) throw Error('native browser operation cancelled');
    try {
        for (const entry of entries) {
            const { object, slot } = entry;
            let slots = hooks.get(object);
            if (!slots) { slots = new Map(); hooks.set(object, slots); }
            let hook = slots.get(slot);
            if (hook && object[slot] !== hook.wrapper) throw Error('native dispatch hook changed');
            if (!hook) {
                hook = { original: object[slot], own: Object.hasOwn(object, slot), users: 0 };
                if (typeof hook.original !== 'function') throw Error('native dispatch method unavailable');
                hook.wrapper = function (...args) {
                    const active = scope.getStore();
                    const selected = active?.entries?.find(item => item.object === object && item.slot === slot);
                    if (selected && active.signal?.aborted) throw Error('native browser operation cancelled before dispatch');
                    return selected ? active.route(selected, args) : Reflect.apply(hook.original, this, args);
                };
                object[slot] = hook.wrapper; slots.set(slot, hook);
            }
            hook.users++; acquired.push({ object, slot, hook, slots }); allowed.add(entry);
        }
        const operation = Promise.resolve(scope.run({ entries: [...allowed], route, signal }, invoke));
        // A cancelled native handler may resume after its permission await. Keep
        // its scoped tombstone until it settles so it cannot fall through into
        // the original page action after the caller has stopped waiting.
        operation.then(release, release); transferred = true;
        if (!signal) return await operation;
        let abort;
        try {
            return await Promise.race([operation, new Promise((_, reject) => {
                abort = () => reject(Error('native browser operation cancelled; completion may be uncertain, do not replay'));
                if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            })]);
        } finally { signal.removeEventListener('abort', abort); }
    } finally { if (!transferred) release(); }
}

function jsonResult(result) {
    if (result?.isError) throw Error(result.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') || 'native browser refused');
    const text = result?.content?.find(row => row.type === 'text')?.text;
    if (!text?.startsWith('{')) throw Error('native browser result contract changed');
    const end = text.indexOf('\n}');
    return JSON.parse(end < 0 ? text : text.slice(0, end + 2));
}
function createNativeAdapter({ sessionId, cwd, preview: native, launch, invoke: invokeNative, electron, onDispose }) {
    const previewId = 'preview-' + sessionId, tabs = new Map(), pointerFrames = new Map();
    let inventory = { tabs: [], activeTabId: null }, closed = false;
    const ensureOpen = () => { if (closed) throw Error('native browser adapter closed'); };
    function owned(nativeId) {
        ensureOpen();
        const url = native.getPreviewUrlForTab(previewId, nativeId);
        if (url === null || url === undefined) return undefined;
        let item = tabs.get(nativeId);
        if (item?.wc?.isDestroyed()) { tabs.delete(nativeId); item = null; }
        if (item) return item.facade;
        item = { nativeId, wc: null };
        function wc() {
            ensureOpen();
            if (!item.wc || item.wc.isDestroyed()) throw Error('native tab capability has not been admitted');
            return item.wc;
        }
        const history = { goToIndex(...args) { const target = wc().navigationHistory; return Reflect.apply(original(target, 'goToIndex'), target, args); } };
        const webContents = {
            isDestroyed: () => closed || native.getPreviewUrlForTab(previewId, nativeId) == null || !!item.wc?.isDestroyed(),
            getURL: () => native.getPreviewUrlForTab(previewId, nativeId),
            getTitle: () => item.wc?.getTitle() || 'Claude browser tab',
            get debugger() { return wc().debugger; }, navigationHistory: history,
            loadURL(...args) { const target = wc(); return Reflect.apply(original(target, 'loadURL'), target, args); },
        };
        const unavailable = () => { throw Error('native operation must execute inside its admitted dispatch'); };
        const cdpTools = {
            nativeInputGuarded: true,
            isAttached: () => !!item.wc && !item.wc.isDestroyed() && item.wc.debugger.isAttached(),
            async attach() {
                if (!item.wc) await invoke('javascript_tool', { tabId: nativeId, action: 'javascript_exec', text: 'void 0 /* native capability ' + randomUUID() + ' */' }, true);
                const target = wc().debugger;
                if (!target.isAttached()) target.attach('1.3');
            },
            sendCommand(method, params) { const target = wc().debugger; return Reflect.apply(original(target, 'sendCommand'), target, [method, params]); },
            evaluate: unavailable, typeText: unavailable, pressKey: unavailable,
            dispatchMouseAt: unavailable, hoverAt: unavailable, scrollAt: unavailable,
        };
        item.facade = { view: { webContents }, cdpTools,
            gate: { get toolAccess() { return native.checkToolAccessGate(previewId, nativeId)?.state || 'allowed'; } } };
        tabs.set(nativeId, item);
        return item.facade;
    }
    function bind(item, wc) {
        if (item.wc && item.wc !== wc) throw Error('native browser target identity changed; no action was replayed');
        if (wc.isDestroyed()) throw Error('native browser target closed');
        item.wc = wc;
    }
    async function pointerInput(input) {
        const viewport = async () => jsonResult(await invokeNative('javascript_tool', { tabId: input.tabId,
            action: 'javascript_exec', text: '({w: window.innerWidth, h: window.innerHeight})' }));
        const epoch = native.getNavCommitEpoch(previewId, input.tabId);
        let size = await viewport(), frame = pointerFrames.get(input.tabId);
        if (!frame || frame.epoch !== epoch || frame.w !== size.w || frame.h !== size.h) {
            const shot = await invokeNative('computer', { tabId: input.tabId, action: 'screenshot', scale: 1 });
            if (shot?.isError) throw Error(shot.content?.find(row => row.type === 'text')?.text || 'native pointer frame unavailable');
            const dimensions = shot.content?.filter(row => row.type === 'text').map(row => row.text).join('\n').match(/Screenshot size: (\d+)x(\d+)/);
            if (!dimensions) throw Error('native screenshot dimensions unavailable');
            size = await viewport();
            frame = { epoch, w: size.w, h: size.h, width: Number(dimensions[1]), height: Number(dimensions[2]) };
            pointerFrames.set(input.tabId, frame);
        }
        return { ...input, coordinate: [input.coordinate[0] * frame.width / (frame.w || 1280),
            input.coordinate[1] * frame.height / (frame.h || 800)] };
    }
    async function invoke(name, input, metadata = {}) {
        ensureOpen();
        const captureOnly = metadata === true, expected = metadata?.expected;
        if (name === 'computer' && input.coordinate) input = await pointerInput(input);
        if (!['javascript_tool', 'computer', 'navigate'].includes(name)) return invokeNative(name, input);
        const facade = owned(input.tabId), item = tabs.get(input.tabId);
        if (!facade || !item) throw Error('native browser tab no longer exists');
        if (item.pending) throw Error('previous native browser invocation is draining; do not replay');
        const entries = [];
        for (const wc of electron.webContents.getAllWebContents()) {
            if (wc.isDestroyed()) continue;
            if (name === 'navigate') {
                entries.push({ object: wc, slot: 'loadURL', kind: 'navigate', wc });
                if (wc.navigationHistory?.goToIndex) entries.push({ object: wc.navigationHistory, slot: 'goToIndex', kind: 'history', wc });
            } else if (wc.debugger) entries.push({ object: wc.debugger, slot: 'sendCommand', kind: 'cdp', wc });
        }
        let dispatched = false;
        const expressions = new Set(['{' + input.text + '\n}', '(async()=>{\n' + input.text + '\n})()']);
        const action = input.action;
        const slot = action === 'type' ? 'typeText' : action === 'key' ? 'pressKey' : action === 'hover' ? 'hoverAt'
            : action === 'scroll' ? 'scrollAt' : 'dispatchMouseAt';
        const method = action === 'type' ? 'Input.insertText' : action === 'key' ? 'Input.dispatchKeyEvent' : 'Input.dispatchMouseEvent';
        return intercepted(entries, (entry, args) => {
            if (entry.kind === 'navigate' || entry.kind === 'history') {
                bind(item, entry.wc);
                return entry.kind === 'navigate' ? facade.view.webContents.loadURL(...args) : facade.view.webContents.navigationHistory.goToIndex(...args);
            }
            if (name === 'javascript_tool' && args[0] === 'Runtime.evaluate' && expressions.has(args[1]?.expression)) {
                bind(item, entry.wc);
                return (async () => {
                    if (!captureOnly) await facade.cdpTools.evaluate(args[1].expression);
                    return { result: { type: 'undefined' } };
                })();
            }
            if (name === 'computer' && args[0] === method) {
                bind(item, entry.wc);
                // Native input has already passed its frame guard. Suppress the
                // helper's paired events; Codex owns the exact low-level event.
                if (dispatched) return Promise.resolve({});
                if (expected?.method === 'Input.dispatchMouseEvent') {
                    const actual = args[1], requested = expected.params;
                    if (actual.x !== requested.x || actual.y !== requested.y)
                        throw Error('native pointer frame differs from Codex coordinates; use original browser tools');
                }
                dispatched = true;
                return Promise.resolve(facade.cdpTools[slot](...args.slice(1))).then(() => ({}));
            }
            return Reflect.apply(original(entry.object, entry.slot), entry.object, args);
        }, () => {
            const pending = Promise.resolve(invokeNative(name, input));
            item.pending = pending;
            const settled = () => { if (item.pending === pending) item.pending = null; };
            pending.then(settled, settled);
            return pending;
        }, metadata?.signal);
    }
    async function refresh() {
        ensureOpen();
        const result = jsonResult(await invokeNative('tabs_context', {}));
        inventory = { tabs: result.tabs || [], activeTabId: result.tabs?.find(row => row.isActive)?.tabId || null };
    }
    async function createBlank() {
        ensureOpen();
        const token = {}, created = [];
        const listener = (_event, wc) => { created.push(wc); };
        const remove = () => electron.app.removeListener('web-contents-created', listener);
        onDispose(remove); electron.app.on('web-contents-created', listener);
        let nativeId;
        try {
            await scope.run(token, async () => {
                if (!native.hasPreviewContext(previewId)) {
                    if (launch.loadBrowserPreview(cwd, sessionId) !== previewId) throw Error('native preview creation contract changed');
                    nativeId = launch.getBrowserPreviewForSession(sessionId)?.tabId;
                } else nativeId = jsonResult(await invokeNative('tabs_create', { foreground: false })).tabId;
            });
            await refresh();
            if (!nativeId || !owned(nativeId) || created.length !== 1 || !['', 'about:blank'].includes(created[0].getURL()))
                throw Error('native blank-tab ownership was not observed; a tab may have been created, do not replay');
            bind(tabs.get(nativeId), created[0]);
            return nativeId;
        } finally { remove(); }
    }
    async function captureScreenshot(nativeId, params) {
        const result = await invokeNative('computer', { tabId: nativeId, action: 'screenshot', scale: 1 });
        if (result?.isError) throw Error(result.content?.find(row => row.type === 'text')?.text || 'native screenshot failed');
        const image = result.content?.find(row => row.type === 'image');
        if (!image) throw Error('native screenshot did not return an image');
        let bitmap = electron.nativeImage.createFromDataURL('data:' + image.mimeType + ';base64,' + image.data);
        if (params.clip) {
            const viewport = jsonResult(await invokeNative('javascript_tool', { tabId: nativeId, action: 'javascript_exec',
                text: '({w: window.innerWidth, h: window.innerHeight})' }));
            const clip = params.clip, dimensions = bitmap.getSize(), width = viewport.w || 1280, height = viewport.h || 800;
            if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.x < 0 || clip.y < 0
                || clip.x + clip.width > width || clip.y + clip.height > height) throw Error('native view cannot capture beyond its viewport');
            bitmap = bitmap.crop({ x: Math.round(clip.x * dimensions.width / width), y: Math.round(clip.y * dimensions.height / height),
                width: Math.round(clip.width * dimensions.width / width), height: Math.round(clip.height * dimensions.height / height) });
            if (clip.scale && clip.scale !== 1) { const size = bitmap.getSize(); bitmap = bitmap.resize({ width: Math.round(size.width * clip.scale), height: Math.round(size.height * clip.scale) }); }
        }
        if (params.format && !['png', 'jpeg'].includes(params.format)) throw Error('unsupported native screenshot format');
        return { data: (params.format === 'jpeg' ? bitmap.toJPEG(params.quality ?? 80) : bitmap.toPNG()).toString('base64') };
    }
    onDispose(() => { closed = true; tabs.clear(); });
    return { invoke, createBlank, captureScreenshot, preview: {
        ...native, getOwnedTab: (_previewId, id) => owned(id), refresh,
        getPreviewUrlForTab: (_previewId, id) => {
            const url = native.getPreviewUrlForTab(previewId, id);
            if (url == null) return url;
            return native.describeOriginlessPreviewTab?.(previewId, id) === 'blank' ? 'about:blank' : url;
        },
        getPreviewTabs: () => inventory,
    } };
}
module.exports = { createNativeAdapter };
