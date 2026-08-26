/* claude-ui-mod :: HOT main-process runtime
 *
 * Reloaded from disk on every save. Owns no IPC registration (the baked loader
 * does), so a reload is just: build new instance, dispose old.
 *
 * Every resource a plugin acquires goes through ctx helpers that record a
 * disposer, so reloads cannot leak intervals, watchers or listeners into a
 * long-running app.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TASKS_ROOT = path.join(os.homedir(), '.claude', 'tasks');
const SESSION_RE = /^[0-9a-fA-F-]{8,64}$/;

module.exports = function createHost(boot) {
    const { electron, MOD_DIR, log } = boot;
    const { webContents, shell } = electron;

    const disposers = [];
    const methods = new Map();
    let disposed = false;

    function onDispose(fn) { disposers.push(fn); }

    function every(ms, fn) {
        const t = setInterval(() => { if (!disposed) { try { fn(); } catch (e) { log('interval error: ' + (e && e.message)); } } }, ms);
        onDispose(() => clearInterval(t));
        return t;
    }

    function watch(target, opts, fn) {
        let w = null;
        const open = () => {
            try {
                w = fs.watch(target, opts, (ev, name) => { if (!disposed) { try { fn(ev, name); } catch (_) {} } });
                w.on('error', () => { try { w.close(); } catch (_) {} if (!disposed) setTimeout(open, 3000); });
            } catch (_) {
                if (!disposed) setTimeout(open, 3000);
            }
        };
        open();
        onDispose(() => { try { w && w.close(); } catch (_) {} });
    }

    function method(name, fn) {
        if (methods.has(name)) log('method override: ' + name);
        methods.set(name, fn);
        onDispose(() => { if (methods.get(name) === fn) methods.delete(name); });
    }

    function broadcast(payload) { boot.broadcast(payload); }

    // ---------------------------------------------------------------- tasks
    function readTasks(sessionId) {
        if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return [];
        const dir = path.join(TASKS_ROOT, sessionId);
        let names;
        try { names = fs.readdirSync(dir); } catch (_) { return []; }
        const out = [];
        for (const n of names) {
            if (!n.endsWith('.json')) continue;
            try {
                const t = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
                if (t && typeof t === 'object' && t.id != null) out.push(t);
            } catch (_) { /* mid-write */ }
        }
        out.sort((a, b) => {
            const na = Number(a.id), nb = Number(b.id);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a.id).localeCompare(String(b.id));
        });
        return out;
    }

    // The desktop addresses a session as local_<uuid> (that is what the URL
    // carries), but the task store is keyed by the CLI session id. The mapping
    // lives in the desktop's own session json:
    //   Roaming/Claude/claude-code-sessions/<acct>/<ws>/local_<uuid>.json
    //     -> { "sessionId": "local_…", "cliSessionId": "<task dir key>" }
    function cliSessionIdFor(uuid) {
        const root = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code-sessions');
        const file = 'local_' + uuid + '.json';
        let accts;
        try { accts = fs.readdirSync(root); } catch (_) { return null; }
        for (const a of accts) {
            let wss;
            try { wss = fs.readdirSync(path.join(root, a)); } catch (_) { continue; }
            for (const w of wss) {
                const p = path.join(root, a, w, file);
                try {
                    if (!fs.existsSync(p)) continue;
                    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (j && typeof j.cliSessionId === 'string' && SESSION_RE.test(j.cliSessionId)) return j.cliSessionId;
                } catch (_) {}
            }
        }
        return null;
    }

    function resolveSession(candidates) {
        const list = Array.isArray(candidates) ? candidates.filter((c) => typeof c === 'string' && SESSION_RE.test(c)) : [];
        for (const c of list) {
            try { if (fs.statSync(path.join(TASKS_ROOT, c)).isDirectory()) return c; } catch (_) {}
        }
        // Candidate may be a desktop session id; translate then retry.
        for (const c of list) {
            const cli = cliSessionIdFor(c);
            if (!cli) continue;
            try { if (fs.statSync(path.join(TASKS_ROOT, cli)).isDirectory()) return cli; } catch (_) {}
            return cli;
        }
        // Nothing resolved. Either the window is on a session whose desktop
        // json has not been written yet (a fresh chat, for its first moments)
        // or it is on a view with no session at all. Both mean "no tasks" —
        // guessing the most recently touched directory here would show an
        // unrelated session's work. The caller retries while this is null.
        return null;
    }

    // ---------------------------------------------------------------- builtins
    method('host.info', () => ({
        generation: boot.generation,
        modDir: MOD_DIR,
        tasksRoot: TASKS_ROOT,
        methods: [...methods.keys()].sort(),
        plugins: listPlugins(),
    }));

    method('host.reload', () => { setTimeout(() => boot.loadHost('rpc'), 0); return true; });
    method('host.rendererReload', () => { broadcast({ type: 'renderer-reload', reason: 'rpc' }); return true; });

    method('host.rendererBundle', () => {
        const bridge = fs.readFileSync(path.join(MOD_DIR, 'src', 'runtime', 'bridge.js'), 'utf8');
        const plugins = [];
        for (const name of listPlugins()) {
            const p = path.join(MOD_DIR, 'src', 'plugins', name, 'renderer.js');
            try {
                if (fs.existsSync(p)) plugins.push({ name, source: fs.readFileSync(p, 'utf8') });
            } catch (err) {
                log('renderer read failed for ' + name + ': ' + (err && err.message));
            }
        }
        return { bridge, plugins, generation: boot.generation };
    });

    method('tasks.list', (p) => readTasks(p && p.sessionId));
    method('tasks.resolve', (p) => resolveSession(p && p.candidates));
    method('tasks.openDir', async (p) => {
        const id = p && p.sessionId;
        if (typeof id !== 'string' || !SESSION_RE.test(id)) return { ok: false, error: 'bad session id' };
        // The CLI creates a session's task directory lazily, on the first task,
        // so a session with none has a valid id and no directory. openPath on a
        // missing path fails silently, which reads as a dead button.
        const dir = path.join(TASKS_ROOT, id);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { return { ok: false, error: String(err && err.message) }; }
        const err = await shell.openPath(dir);
        return err ? { ok: false, error: err } : { ok: true, dir };
    });

    // Read any file — the point of a runtime dev flow is not having to re-patch
    // to look at something. Local tool, local user.
    method('fs.read', (p) => {
        const f = p && p.path;
        if (typeof f !== 'string') throw new Error('path required');
        const max = Number(p.max) || 512 * 1024;
        const b = fs.readFileSync(f);
        return { size: b.length, truncated: b.length > max, text: b.subarray(0, max).toString('utf8') };
    });
    method('fs.list', (p) => {
        const d = (p && p.path) || TASKS_ROOT;
        return fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    });

    // Evaluate in the main process. Only reachable from our own preload world —
    // it is never contextBridged to claude.ai's page JS.
    method('dev.eval', async (p) => {
        const code = p && p.code;
        if (typeof code !== 'string') throw new Error('code required');
        const fn = new Function('electron', 'boot', 'require', 'host', '"use strict";return (async()=>{' + code + '})()');
        const v = await fn(electron, boot, require, api);
        try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch (_) { return String(v); }
    });

    method('dev.webContents', () => webContents.getAllWebContents().map((wc) => {
        let url = '', type = '';
        try { url = wc.getURL(); } catch (_) {}
        try { type = wc.getType(); } catch (_) {}
        return { id: wc.id, type, url: url.slice(0, 160), destroyed: wc.isDestroyed() };
    }));

    // ---------------------------------------------------------------- plugins
    function listPlugins() {
        try {
            return fs.readdirSync(path.join(MOD_DIR, 'src', 'plugins'), { withFileTypes: true })
                .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
                .map((e) => e.name)
                .sort();
        } catch (_) { return []; }
    }

    const loaded = [];
    for (const name of listPlugins()) {
        const mainFile = path.join(MOD_DIR, 'src', 'plugins', name, 'main.js');
        if (!fs.existsSync(mainFile)) continue;
        try {
            const factory = require(mainFile);
            if (typeof factory !== 'function') throw new Error('main.js must export a factory');
            factory({
                name,
                electron,
                boot,
                log: (...a) => log('[' + name + ']', ...a),
                method: (m, fn) => method(name + '.' + m, fn),
                rawMethod: method,
                onDispose,
                every,
                watch,
                broadcast,
                dir: path.join(MOD_DIR, 'src', 'plugins', name),
            });
            loaded.push(name);
        } catch (err) {
            // One bad plugin must not stop the others or the host.
            log('plugin "' + name + '" failed to load: ' + ((err && err.stack) || err));
        }
    }

    // ---------------------------------------------------------------- task watch
    let taskTimer = null;
    const dirty = new Set();
    try { fs.mkdirSync(TASKS_ROOT, { recursive: true }); } catch (_) {}
    watch(TASKS_ROOT, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const sid = String(name).split(/[\\/]/)[0];
        if (!sid) return;
        dirty.add(sid);
        clearTimeout(taskTimer);
        taskTimer = setTimeout(() => {
            const ids = [...dirty];
            dirty.clear();
            broadcast({ type: 'tasks-changed', sessionIds: ids });
        }, 120);
    });
    onDispose(() => clearTimeout(taskTimer));

    log('host ready: ' + methods.size + ' methods, plugins=[' + loaded.join(', ') + ']');

    const api = {
        async dispatch(name, params, event) {
            const fn = methods.get(name);
            if (!fn) throw new Error('unknown method: ' + name);
            return await fn(params || {}, event);
        },
        dispose() {
            disposed = true;
            for (let i = disposers.length - 1; i >= 0; i--) {
                try { disposers[i](); } catch (e) { log('dispose error: ' + (e && e.message)); }
            }
            disposers.length = 0;
            methods.clear();
        },
    };
    return api;
};
