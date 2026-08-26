/* claude-ui-mod :: live driver
 *
 * Evaluated inside the running Claude main process by live-inject.js. Unlike the
 * asar patch, there is no preload to piggyback on here, so the panel is injected
 * into claude.ai's own world via webContents.executeJavaScript and driven
 * entirely by push from this side: no renderer -> main channel is needed.
 *
 * Exposed as a function of (electron, req, MOD_DIR) so the injector can hand in
 * module references it resolved itself.
 */
function cuimodLiveDriver(electron, req, MOD_DIR) {
    'use strict';

    const fs = req('fs');
    const path = req('path');
    const os = req('os');
    const { webContents, shell } = electron;
    const TASKS_ROOT = path.join(os.homedir(), '.claude', 'tasks');

    const g = globalThis;
    if (g.__cuimod_live) {
        g.__cuimod_live.stop();
    }

    const state = { timer: null, watcher: null, wired: new WeakSet(), lastPush: new Map() };
    const log = (...a) => { try { console.log('[cuimod]', ...a); } catch (_) {} };

    // ---------------------------------------------------------------- tasks
    function readTasks(sessionId) {
        if (typeof sessionId !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return [];
        let names;
        try { names = fs.readdirSync(path.join(TASKS_ROOT, sessionId)); } catch (_) { return []; }
        const out = [];
        for (const n of names) {
            if (!n.endsWith('.json')) continue;
            try {
                const t = JSON.parse(fs.readFileSync(path.join(TASKS_ROOT, sessionId, n), 'utf8'));
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

    function resolveSession(candidates) {
        for (const c of candidates) {
            try { if (fs.statSync(path.join(TASKS_ROOT, c)).isDirectory()) return c; } catch (_) {}
        }
        let best = null, bestM = 0;
        try {
            for (const n of fs.readdirSync(TASKS_ROOT)) {
                try {
                    const st = fs.statSync(path.join(TASKS_ROOT, n));
                    if (st.isDirectory() && st.mtimeMs > bestM) { bestM = st.mtimeMs; best = n; }
                } catch (_) {}
            }
        } catch (_) {}
        return best;
    }

    // ---------------------------------------------------------------- views
    function targets() {
        const out = [];
        for (const wc of webContents.getAllWebContents()) {
            try {
                if (wc.isDestroyed() || wc.isCrashed()) continue;
                const u = wc.getURL() || '';
                if (/^https:\/\/(claude\.ai|claude\.com|preview\.claude\.ai)\//.test(u)) out.push(wc);
            } catch (_) {}
        }
        return out;
    }

    const SHIM = `(function(){
  if (window.__cuimod) return;
  var s = { sessionId: null, tasks: [] }, onS = null, onT = null;
  window.__cuimod = {
    get sessionId() { return s.sessionId; },
    onSessionChange: function (f) { onS = f; if (s.sessionId) { try { f(s.sessionId); } catch (e) {} } },
    onTasksChange: function (f) { onT = f; },
    getTasks: function () { return Promise.resolve(s.tasks); },
    openTasksDir: function (id) { try { console.log('cuimod:open:' + id); } catch (e) {} return Promise.resolve(true); },
    refresh: function () {},
    _push: function (n) {
      var changed = n.sessionId !== s.sessionId;
      s.sessionId = n.sessionId; s.tasks = n.tasks || [];
      try { if (changed && onS) onS(s.sessionId); } catch (e) {}
      try { if (onT) onT(); } catch (e) {}
    }
  };
})();`;

    function panelSource() {
        return fs.readFileSync(path.join(MOD_DIR, 'src', 'panel.js'), 'utf8');
    }

    async function ensure(wc) {
        let has = false;
        try {
            has = await wc.executeJavaScript('!!(window.__cuimod && document.getElementById("cuimod-host"))', true);
        } catch (_) { return false; }
        if (has) return true;

        const js =
            'try{' + SHIM + '\n(function(cuimod){\n' + panelSource() + '\n})(window.__cuimod);' +
            '}catch(e){console.error("[cuimod] inject failed",e);}true;';
        try {
            await wc.executeJavaScript(js, true);
            log('injected into', wc.id, wc.getURL().slice(0, 60));
            return true;
        } catch (err) {
            log('inject failed', wc.id, err && err.message);
            return false;
        }
    }

    function wire(wc) {
        if (state.wired.has(wc)) return;
        state.wired.add(wc);
        const kick = () => { setTimeout(() => tickOne(wc).catch(() => {}), 400); };
        try {
            wc.on('did-finish-load', kick);
            wc.on('did-navigate-in-page', kick);
            wc.on('dom-ready', kick);
            wc.on('console-message', function () {
                // Electron changed this signature across versions; accept both.
                const a = arguments[0];
                const msg = (a && typeof a === 'object' && 'message' in a) ? a.message : arguments[1];
                if (typeof msg !== 'string') return;
                const m = msg.match(/^cuimod:open:([0-9a-fA-F-]{8,64})$/);
                if (m) { try { shell.openPath(path.join(TASKS_ROOT, m[1])); } catch (_) {} }
            });
        } catch (_) {}
    }

    async function tickOne(wc) {
        if (wc.isDestroyed()) return;
        wire(wc);
        if (!(await ensure(wc))) return;

        let href = '';
        try { href = await wc.executeJavaScript('location.pathname + location.search', true); } catch (_) { return; }
        const cands = String(href).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        const sid = resolveSession(cands);
        const tasks = sid ? readTasks(sid) : [];

        const payload = JSON.stringify({ sessionId: sid, tasks });
        if (state.lastPush.get(wc.id) === payload) return;
        state.lastPush.set(wc.id, payload);
        try {
            await wc.executeJavaScript('window.__cuimod && window.__cuimod._push(' + payload + '), true;', true);
        } catch (_) {}
    }

    async function tick() {
        for (const wc of targets()) {
            try { await tickOne(wc); } catch (_) {}
        }
    }

    function startWatch() {
        try {
            fs.mkdirSync(TASKS_ROOT, { recursive: true });
            state.watcher = fs.watch(TASKS_ROOT, { recursive: true }, () => {
                clearTimeout(state.debounce);
                state.debounce = setTimeout(() => tick().catch(() => {}), 150);
            });
            state.watcher.on('error', () => {});
        } catch (err) {
            log('watch failed', err && err.message);
        }
    }

    state.timer = setInterval(() => tick().catch(() => {}), 1500);
    startWatch();

    g.__cuimod_live = {
        tick,
        stop() {
            try { clearInterval(state.timer); } catch (_) {}
            try { state.watcher && state.watcher.close(); } catch (_) {}
            for (const wc of targets()) {
                try { wc.executeJavaScript('(function(){var h=document.getElementById("cuimod-host");if(h)h.remove();delete window.__cuimod;})(),true;', true); } catch (_) {}
            }
            g.__cuimod_live = null;
            log('stopped');
        },
    };

    tick().catch(() => {});
    return { views: targets().length, tasksRoot: TASKS_ROOT };
}
