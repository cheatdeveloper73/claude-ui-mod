/* claude-ui-mod :: HOT renderer runtime
 *
 * Evaluated by the baked preload as: new Function('boot','plugins', <this>)
 * Runs in the preload's isolated world — full DOM access, no page JS access,
 * not reachable from claude.ai's own scripts.
 *
 * Reloads without touching the page: the old instance is disposed and a new one
 * built, so the React app underneath never reloads and no session is disturbed.
 */
'use strict';

const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const disposers = [];
let disposed = false;
const onDispose = (fn) => disposers.push(fn);

// Ring buffer of swallowed callback errors, readable as cuimod.errors. Without
// it a loop that throws every tick looks exactly like a loop that stopped.
const errors = [];
function note(where, e) {
    errors.push({ t: Date.now(), where, msg: String((e && e.stack) || e).slice(0, 400) });
    if (errors.length > 20) errors.shift();
}
function guard(where, fn) {
    return function () {
        try { return fn.apply(this, arguments); } catch (e) { note(where, e); }
    };
}

function track(target, type, fn, opts) {
    const wrapped = guard('listener:' + type, fn);
    target.addEventListener(type, wrapped, opts);
    onDispose(() => { try { target.removeEventListener(type, wrapped, opts); } catch (_) {} });
}
function every(ms, fn) {
    const g = guard('interval:' + ms, fn);
    const t = setInterval(() => { if (!disposed) g(); }, ms);
    onDispose(() => clearInterval(t));
    return t;
}
function observe(node, opts, fn) {
    const mo = new MutationObserver(guard('observer', fn));
    mo.observe(node, opts);
    onDispose(() => { try { mo.disconnect(); } catch (_) {} });
    return mo;
}

// Opt-in placement work shares one invalidation source, discovery cache and read
// phase. Legacy observe() callbacks retain their synchronous delivery semantics.
const layoutClients = new Set();
let layoutFrame = 0;
let layoutTimer = null;
let layoutDirty = true;
let layoutDiscovery = new Map();
let layoutRects = new Map();
let layoutValues = new Map();
let layoutResize = null;
let layoutMutation = null;
let layoutReading = null;
let layoutFlushing = false;
const layoutTransitions = new Set();
const TRANSCRIPT_LAYOUT = '[data-testid="epitaxy-virtual-transcript"]';

function inTranscript(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    // The feed is size/layout contained. Its internal mutations and scrolling
    // cannot move the shell's composer or sidebar; the feed's own box can.
    return !!el?.closest?.(TRANSCRIPT_LAYOUT);
}
function ownLayoutHost(node) {
    return !!node?.closest?.('[id^="cuimod-"]');
}
function queueLayout() {
    if (disposed || layoutFrame || layoutTimer !== null || !layoutClients.size) return;
    if (document.hidden) {
        layoutTimer = setTimeout(() => { layoutTimer = null; flushLayout(); }, 0);
    } else {
        layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; flushLayout(); });
    }
}
function invalidateLayout(discovery = false) {
    if (discovery) layoutDiscovery = new Map();
    layoutDirty = true;
    for (const client of layoutClients) client.pending = true;
    queueLayout();
}
function watchLayout(node) {
    if (!node || !layoutReading || node.nodeType !== 1) return;
    layoutReading.nodes.add(node);
}
function layoutQueryAll(selector, root = document) {
    let cache = layoutDiscovery.get(root);
    if (!cache) layoutDiscovery.set(root, cache = new Map());
    if (!cache.has(selector)) cache.set(selector, [...root.querySelectorAll(selector)]);
    return cache.get(selector);
}
function layoutRect(node) {
    if (!node) return null;
    watchLayout(node);
    if (!layoutRects.has(node)) layoutRects.set(node, node.getBoundingClientRect());
    return layoutRects.get(node);
}
function layoutValue(key, compute) {
    if (!layoutValues.has(key)) layoutValues.set(key, compute());
    const value = layoutValues.get(key);
    // Cached discoveries still enroll their anchors in this client's RO set.
    if (value?.nodeType === 1) watchLayout(value);
    return value;
}
const layoutSnapshot = {
    rect: layoutRect,
    queryAll: layoutQueryAll,
    query(selector, root = document) { return layoutQueryAll(selector, root)[0] || null; },
    mainComposer() {
        return layoutValue('mainComposer', () => {
            let best = null, bestRect = null;
            for (const p of layoutQueryAll('.epitaxy-prompt')) {
                const r = layoutRect(p);
                if (r.width < 120 || r.height <= 0) continue;
                if (p.closest('.epitaxy-composer-width')) return p;
                if (!bestRect || r.width > bestRect.width + 8 ||
                    (Math.abs(r.width - bestRect.width) <= 8 && r.bottom > bestRect.bottom)) {
                    best = p; bestRect = r;
                }
            }
            return best;
        });
    },
    railComposer() {
        return layoutValue('railComposer', () => {
            let editor = null, base = null;
            for (const el of layoutQueryAll('[contenteditable="true"]')) {
                const r = layoutRect(el);
                if (r.width <= 40 || r.height <= 20 || r.bottom <= 0 || r.top >= innerHeight) continue;
                if (!base || r.bottom > base.bottom) { editor = el; base = r; }
            }
            if (!editor) return null;
            let node = editor;
            for (let i = 0, p = editor.parentElement; i < 6 && p; i++, p = p.parentElement) {
                const r = layoutRect(p);
                if (r.width > base.width * 1.8 || r.height > base.height + 240) break;
                if (parseFloat(getComputedStyle(p).borderTopLeftRadius) >= 8) node = p;
            }
            return node;
        });
    },
    sidebarRight() {
        return layoutValue('sidebarRight', () => {
            for (const el of layoutQueryAll('.dframe-sidebar, aside, nav')) {
                const r = layoutRect(el);
                if (r.left > 2 || r.width < 100 || r.width > innerWidth * 0.5) continue;
                if (r.height < innerHeight * 0.5) continue;
                return r.right;
            }
            return 0;
        });
    },
};
function flushLayout() {
    if (disposed || layoutFlushing) return;
    if (layoutFrame) { cancelAnimationFrame(layoutFrame); layoutFrame = 0; }
    if (layoutTimer !== null) { clearTimeout(layoutTimer); layoutTimer = null; }
    layoutFlushing = true;
    if (layoutDirty) {
        layoutRects = new Map(); layoutValues = new Map(); layoutDirty = false;
        for (const client of layoutClients) client.nodes.clear();
    }
    const writes = [];
    try {
        for (const client of layoutClients) {
            if (!client.pending) continue;
            client.pending = false;
            layoutReading = client;
            try { writes.push([client, client.read(layoutSnapshot)]); }
            catch (e) { note('layout:read', e); }
            finally { layoutReading = null; }
        }
        // Observe only current dependencies, not every anchor ever encountered.
        if (layoutResize) {
            const nodes = new Set();
            for (const client of layoutClients) for (const node of client.nodes) nodes.add(node);
            for (const node of layoutObserved) if (!nodes.has(node)) {
                layoutResize.unobserve(node); layoutObserved.delete(node);
            }
            for (const node of nodes) if (!layoutObserved.has(node)) {
                layoutResize.observe(node); layoutObserved.add(node);
            }
        }
        for (const [client, value] of writes) {
            if (!layoutClients.has(client)) continue;
            try { client.write(value); } catch (e) { note('layout:write', e); }
        }
    } finally {
        layoutFlushing = false;
        for (const node of layoutTransitions) if (!node.isConnected) layoutTransitions.delete(node);
        if (layoutTransitions.size && !document.hidden) invalidateLayout();
    }
}
const layoutObserved = new Set();
function startLayout() {
    if (layoutMutation) return;
    layoutMutation = observe(document.documentElement,
        { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'contenteditable', 'aria-hidden', 'aria-label', 'id', 'data-testid'] },
        (records) => {
            for (const record of records) {
                // Attributes on the feed itself can change its box; only its
                // descendants and contained child-list updates are irrelevant.
                if (inTranscript(record.target) && !(record.type === 'attributes' && record.target.matches?.(TRANSCRIPT_LAYOUT))) continue;
                if (record.type === 'attributes' && record.oldValue === record.target.getAttribute(record.attributeName)) continue;
                // Queue is an external placement dependency: its host may be
                // mounted late or move without resizing the rail inside it.
                if (ownLayoutHost(record.target) && !record.target.closest('#cuimod-queue')) continue;
                if (record.type === 'childList') {
                    const changed = [...record.addedNodes, ...record.removedNodes];
                    if (changed.length && changed.every(n => n.nodeType === 1 && n.id?.startsWith('cuimod-') && n.id !== 'cuimod-queue' && n.id !== 'cuimod-host')) continue;
                }
                invalidateLayout(true);
                return;
            }
        });
    layoutResize = new ResizeObserver(guard('layout:resize', () => invalidateLayout()));
    onDispose(() => { layoutResize.disconnect(); layoutObserved.clear(); });
    track(window, 'resize', () => invalidateLayout(true), { passive: true });
    track(window, 'scroll', event => {
        if (!inTranscript(event.target) && !ownLayoutHost(event.target)) invalidateLayout();
    }, { passive: true, capture: true });
    track(document, 'visibilitychange', () => {
        // A frame queued while visible will never run after occlusion. Transfer
        // it to the hidden timeout path rather than stranding pending work.
        if (layoutFrame) { cancelAnimationFrame(layoutFrame); layoutFrame = 0; }
        invalidateLayout(true);
    });
    // Input may resize the editor before React publishes a shell mutation.
    track(document, 'input', event => { if (!inTranscript(event.target) && !ownLayoutHost(event.target)) invalidateLayout(); }, true);
    // Transforms move anchors without resizing them. Follow only while a real
    // shell transform transition runs, never as a permanent frame/poll loop.
    track(document, 'transitionrun', event => {
        if (event.propertyName !== 'transform' || inTranscript(event.target) || ownLayoutHost(event.target)) return;
        layoutTransitions.add(event.target); invalidateLayout();
    }, true);
    const endTransition = event => {
        if (event.propertyName !== 'transform' || !layoutTransitions.delete(event.target)) return;
        invalidateLayout();
    };
    track(document, 'transitionend', endTransition, true);
    track(document, 'transitioncancel', endTransition, true);
    onDispose(() => {
        if (layoutFrame) cancelAnimationFrame(layoutFrame);
        if (layoutTimer !== null) clearTimeout(layoutTimer);
        layoutFrame = 0; layoutTimer = null; layoutClients.clear();
        layoutDiscovery.clear(); layoutRects.clear(); layoutValues.clear(); layoutTransitions.clear();
    });
}
function subscribeLayout(read, write, dispose) {
    startLayout();
    const client = { read, write, pending: true, nodes: new Set() };
    layoutClients.add(client);
    const invalidate = () => { client.pending = true; queueLayout(); };
    invalidate.flush = () => { client.pending = true; flushLayout(); };
    // Use for position changes inside another shadow root, which the document
    // observer cannot see and a size-only ResizeObserver cannot establish.
    invalidate.measure = () => invalidateLayout();
    dispose(() => { layoutClients.delete(client); });
    queueLayout();
    return invalidate;
}

// ---------------------------------------------------------------- session id
const seen = [];
let sessionId = null;
let sessionGeneration = 0;
const sessionSubs = new Set();
const taskSubs = new Set();
let tasks = [];

function noteSession(raw) {
    // The desktop hands its own ids around as "local_<uuid>", so an anchored
    // match on the whole string drops every id the app actually emits.
    if (typeof raw !== 'string') return;
    UUID_ANY.lastIndex = 0;
    const m = UUID_ANY.exec(raw);
    if (!m) return;
    const id = m[0].toLowerCase();
    const i = seen.indexOf(id);
    if (i !== -1) seen.splice(i, 1);
    seen.unshift(id);
    if (seen.length > 8) seen.length = 8;
    scheduleResolve();
}

function harvest(v, depth) {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') return noteSession(v);
    if (typeof v !== 'object') return;
    if (typeof v.sessionId === 'string') noteSession(v.sessionId);
    if (Array.isArray(v)) for (const x of v.slice(0, 8)) harvest(x, depth + 1);
}

onDispose(boot.observeInvoke((channel, args) => {
    if (typeof channel === 'string' && channel.indexOf('_$_setFocusedSession') !== -1) harvest(args[0], 0);
}));

const onEventChannel = boot.eipc('claude.web', 'LocalSessions', 'onEvent');
// Fires for background sessions as well as the focused one, so it is only a
// hint that something moved — never a source of "which session is on screen".
onDispose(boot.appOn(onEventChannel, () => { scheduleResolve(); }));

function locationKey() { return location.pathname + location.search; }

function urlCandidates(value = locationKey()) {
    const out = [];
    let m;
    UUID_ANY.lastIndex = 0;
    while ((m = UUID_ANY.exec(value)) !== null) out.push(m[0]);
    return out;
}

const deadlines = new Set();
function within(promise, ms = 5000) {
    let entry;
    const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('renderer request timed out')), ms);
        entry = { timer, reject };
        deadlines.add(entry);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        clearTimeout(entry.timer);
        deadlines.delete(entry);
    });
}
onDispose(() => {
    for (const entry of deadlines) {
        clearTimeout(entry.timer);
        entry.reject(new Error('renderer disposed'));
    }
    deadlines.clear();
});

let resolveTimer = null;
let resolveGeneration = 0;
let resolveFlight = null;
let resolveQueued = false;
function scheduleResolve(wait = 200) {
    if (resolveTimer) return;
    resolveTimer = setTimeout(() => { resolveTimer = null; doResolve(); }, wait);
}
onDispose(() => clearTimeout(resolveTimer));

function publishSession(value) {
    const next = value || null;
    if (next === sessionId) return;
    sessionId = next;
    sessionGeneration++;
    tasks = [];
    for (const fn of sessionSubs) { try { fn(sessionId); } catch (_) {} }
    if (sessionId) refreshTasks();
}

function resolveOwned(owner) {
    return !disposed && owner.generation === resolveGeneration && owner.url === locationKey();
}

async function doResolve() {
    if (disposed) return false;
    const generation = resolveGeneration;
    if (resolveFlight?.generation === generation) {
        resolveQueued = true;
        return resolveFlight.promise;
    }

    // The URL plus generation owns this answer. The generation is required for
    // A -> B -> A navigation: matching the final URL would make the first A look
    // current again even though its request belongs to a retired visit.
    const owner = { generation, url: locationKey(), promise: null };
    resolveFlight = owner;
    const run = (async () => {
        try {
            const id = await within(boot.rpc('tasks.resolve', { candidates: urlCandidates(owner.url) }));
            if (!resolveOwned(owner)) return false;
            publishSession(id);
            return true;
        } catch (_) { return false; }
        finally {
            // A retired request must not clear or reschedule the current visit's
            // bookkeeping when it eventually resolves, rejects or times out.
            if (resolveFlight !== owner) return;
            resolveFlight = null;
            if (resolveQueued && resolveOwned(owner)) {
                resolveQueued = false;
                scheduleResolve(0);
            }
        }
    })();
    owner.promise = run;
    return run;
}

let taskFlight = null;
let taskQueued = false;
async function refreshTasks() {
    const owner = { sessionId, generation: sessionGeneration, promise: null };
    if (!owner.sessionId) { tasks = []; return false; }
    if (taskFlight?.generation === owner.generation) {
        taskQueued = true;
        return taskFlight.promise;
    }
    taskFlight = owner;
    const run = (async () => {
        try {
            const value = await within(boot.rpc('tasks.list', { sessionId: owner.sessionId }));
            if (disposed || owner.generation !== sessionGeneration || owner.sessionId !== sessionId) return false;
            tasks = Array.isArray(value) ? value : [];
            for (const fn of taskSubs) { try { fn(); } catch (_) {} }
            return true;
        } catch (_) {
            if (!disposed && owner.generation === sessionGeneration && owner.sessionId === sessionId) {
                tasks = [];
                for (const fn of taskSubs) { try { fn(); } catch (_) {} }
            }
            return false;
        } finally {
            if (taskFlight !== owner) return;
            taskFlight = null;
            if (taskQueued && !disposed && owner.generation === sessionGeneration) {
                taskQueued = false;
                queueMicrotask(refreshTasks);
            }
        }
    })();
    owner.promise = run;
    return run;
}

// ---------------------------------------------------------------- plugin api
const api = {
    get sessionId() { return sessionId; },
    onSessionChange(fn) {
        if (typeof fn !== 'function') return () => {};
        sessionSubs.add(fn);
        if (sessionId) { try { fn(sessionId); } catch (_) {} }
        return () => sessionSubs.delete(fn);
    },
    onTasksChange(fn) { taskSubs.add(fn); },
    async getTasks() { return tasks; },
    openTasksDir(id) { return boot.rpc('tasks.openDir', { sessionId: id || sessionId }); },
    refresh: doResolve,

    // runtime dev surface
    rpc: boot.rpc,
    appInvoke: boot.appInvoke,
    contextCountInfo(usage) {
        const u = usage?.apiUsage;
        const counts = u ? [u.input_tokens, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0] : [];
        const reported = counts.length && counts.every(n => Number.isFinite(n) && n >= 0)
            ? counts.reduce((sum, n) => sum + n, 0) : 0;
        const exact = reported > 0 && reported === usage?.totalTokens;
        return { exact, description: exact
            ? 'Provider-reported input for the latest model call, including cached input. Category breakdown is estimated.'
            : 'Estimated context before provider usage is available.' };
    },
    appOn: boot.appOn,
    eipc: boot.eipc,
    tap: boot.tap,
    // The tap is a 300-entry ring, so a plugin that must not MISS a call cannot
    // poll it — a burst of app IPC evicts the entry before the next tick. This
    // is the same hook the session resolver uses, exposed so a plugin can react
    // to one of the app's own outgoing calls at the moment it is made.
    observeInvoke: boot.observeInvoke,
    errors,
    log: boot.log,
    reload: () => boot.reload('manual'),
};

// ---------------------------------------------------------------- plugins
const active = [];
for (const p of plugins) {
    const pluginDisposers = [];
    const ctx = {
        name: p.name,
        onDispose: (fn) => pluginDisposers.push(fn),
        every,
        track,
        observe,
        layout: (read, write) => subscribeLayout(read, write, ctx.onDispose),
    };
    try {
        const factory = new Function('cuimod', 'ctx', p.source);
        const ret = factory(api, ctx);
        if (ret && typeof ret.dispose === 'function') pluginDisposers.push(ret.dispose);
        active.push(p.name);
        onDispose(() => {
            for (let i = pluginDisposers.length - 1; i >= 0; i--) {
                try { pluginDisposers[i](); } catch (_) {}
            }
        });
    } catch (err) {
        boot.log('renderer plugin "' + p.name + '" failed:', (err && err.message) || err);
    }
}

// The URL is the authoritative session marker, and the app navigates with
// pushState, which fires no event — so it has to be polled.
let lastLoc = locationKey();
function observeLocation() {
    const now = locationKey();
    if (now === lastLoc) return;
    lastLoc = now;
    if (layoutClients.size) invalidateLayout(true);
    resolveGeneration++;
    resolveFlight = null;
    resolveQueued = false;
    // Foreign session data disappears as soon as navigation is observed. The
    // replacement id arrives later through the generation-owned resolver.
    publishSession(null);
    scheduleResolve(0);
}
every(500, observeLocation);

// A fresh chat is addressable before its desktop json exists, so resolution can
// legitimately fail for a beat. Keep asking until it lands.
every(1000, () => { if (!sessionId) scheduleResolve(); });
track(window, 'popstate', observeLocation);

boot.log('bridge ready, plugins=[' + active.join(', ') + ']');
doResolve();

return {
    onEvent(payload) {
        if (!payload) return;
        if (payload.type === 'tasks-changed') {
            if (!sessionId || (payload.sessionIds || []).indexOf(sessionId) !== -1) refreshTasks();
        }
    },
    dispose() {
        disposed = true;
        resolveGeneration++;
        sessionGeneration++;
        resolveFlight = null;
        taskFlight = null;
        resolveQueued = false;
        taskQueued = false;
        for (let i = disposers.length - 1; i >= 0; i--) {
            try { disposers[i](); } catch (_) {}
        }
        disposers.length = 0;
        sessionSubs.clear();
        taskSubs.clear();
    },
};
