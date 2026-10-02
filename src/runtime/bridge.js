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
