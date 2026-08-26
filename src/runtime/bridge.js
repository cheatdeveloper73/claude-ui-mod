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

function urlCandidates() {
    const out = [];
    let m;
    UUID_ANY.lastIndex = 0;
    const s = location.pathname + location.search;
    while ((m = UUID_ANY.exec(s)) !== null) out.push(m[0]);
    return out;
}

let resolveTimer = null;
let resolving = false;
function scheduleResolve() {
    if (resolveTimer) return;
    resolveTimer = setTimeout(() => { resolveTimer = null; doResolve(); }, 200);
}
onDispose(() => clearTimeout(resolveTimer));

async function doResolve() {
    if (resolving || disposed) return;
    resolving = true;
    try {
        // The URL is the only source of truth for which session is on screen.
        // A view with no id in its address — the new-session view — genuinely
        // has no session, and must resolve to null rather than to whatever was
        // focused a moment ago. `seen` stays a trigger, never an answer.
        const id = await boot.rpc('tasks.resolve', { candidates: urlCandidates() });
        if (id !== sessionId) {
            // null is a real answer — a fresh chat has no session yet, and the
            // rail must empty rather than keep showing the previous one.
            sessionId = id || null;
            await refreshTasks();
            for (const fn of sessionSubs) { try { fn(sessionId); } catch (_) {} }
        }
    } catch (_) {} finally {
        resolving = false;
    }
}

async function refreshTasks() {
    if (!sessionId) { tasks = []; return; }
    try { tasks = await boot.rpc('tasks.list', { sessionId }); } catch (_) { tasks = []; }
}

// ---------------------------------------------------------------- plugin api
const api = {
    get sessionId() { return sessionId; },
    onSessionChange(fn) { sessionSubs.add(fn); if (sessionId) { try { fn(sessionId); } catch (_) {} } },
    onTasksChange(fn) { taskSubs.add(fn); },
    async getTasks() { return tasks; },
    openTasksDir(id) { return boot.rpc('tasks.openDir', { sessionId: id || sessionId }); },
    refresh: doResolve,

    // runtime dev surface
    rpc: boot.rpc,
    appInvoke: boot.appInvoke,
    appOn: boot.appOn,
    eipc: boot.eipc,
    tap: boot.tap,
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
let lastLoc = location.pathname + location.search;
every(500, () => {
    const now = location.pathname + location.search;
    if (now === lastLoc) return;
    lastLoc = now;
    scheduleResolve();
});

// A fresh chat is addressable before its desktop json exists, so resolution can
// legitimately fail for a beat. Keep asking until it lands.
every(1000, () => { if (!sessionId) scheduleResolve(); });
track(window, 'popstate', scheduleResolve);

boot.log('bridge ready, plugins=[' + active.join(', ') + ']');
doResolve();

return {
    onEvent(payload) {
        if (!payload) return;
        if (payload.type === 'tasks-changed') {
            if (!sessionId || (payload.sessionIds || []).indexOf(sessionId) !== -1) {
                refreshTasks().then(() => {
                    for (const fn of taskSubs) { try { fn(); } catch (_) {} }
                });
            }
        }
    },
    dispose() {
        disposed = true;
        for (let i = disposers.length - 1; i >= 0; i--) {
            try { disposers[i](); } catch (_) {}
        }
        disposers.length = 0;
        sessionSubs.clear();
        taskSubs.clear();
    },
};
