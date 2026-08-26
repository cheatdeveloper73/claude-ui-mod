#!/usr/bin/env node
'use strict';
/* claude-ui-mod :: live injector
 *
 *   node live-inject.js selftest    exercise the whole mechanism on a throwaway
 *                                   node process — touches nothing else
 *   node live-inject.js probe       attach read-only, report what is there
 *   node live-inject.js apply       inject the task rail into the running app
 *   node live-inject.js stop        remove it again, live
 *
 * Mechanism: process._debugProcess(pid) signals the target's Node inspector to
 * start listening on 127.0.0.1:9229 (an event-object handshake on Windows — it
 * does not inject a thread or pause execution). We attach over CDP, evaluate the
 * driver in the main process, and then ask the target to close the inspector
 * again so the port does not stay open.
 *
 * The main process is the parent of every running Claude Code CLI child, so
 * everything evaluated in the target is wrapped: nothing here throws into the
 * app's event loop.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const MOD_DIR = __dirname;
const PORT = Number(process.env.CUIMOD_INSPECT_PORT || 9229);

// ---------------------------------------------------------------- discovery

function mainPid() {
    const ps = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
            "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    let rows = JSON.parse(ps || 'null');
    if (!rows) throw new Error('Claude is not running');
    if (!Array.isArray(rows)) rows = [rows];
    const roots = rows.filter((r) => {
        const c = r.CommandLine || '';
        if (/--type=/.test(c)) return false;                       // chromium child
        if (/claude-code[\\/]/.test(c)) return false;              // CLI child
        return /AnthropicClaude[\\/]app-/.test(c);
    });
    if (!roots.length) throw new Error('could not identify the Electron main process among ' + rows.length + ' claude.exe');
    if (roots.length > 1) throw new Error('multiple candidate main processes: ' + roots.map((r) => r.ProcessId).join(', '));
    return roots[0].ProcessId;
}

// ---------------------------------------------------------------- cdp

function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let b = '';
            res.on('data', (d) => (b += d));
            res.on('end', () => {
                try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(port, ms) {
    const deadline = Date.now() + ms;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const list = await getJson('http://127.0.0.1:' + port + '/json/list');
            const t = (list || []).find((x) => x.webSocketDebuggerUrl);
            if (t) return t;
        } catch (e) { lastErr = e; }
        await sleep(200);
    }
    throw new Error('inspector did not come up on 127.0.0.1:' + port + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.addEventListener('message', (ev) => {
            let m;
            try { m = JSON.parse(ev.data); } catch (_) { return; }
            if (m.id != null && this.pending.has(m.id)) {
                const { resolve, reject } = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
                else resolve(m.result);
            }
        });
    }
    send(method, params) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(method + ' timed out'));
                }
            }, 20000);
        });
    }
    async evaluate(expression, opts) {
        const r = await this.send('Runtime.evaluate', Object.assign({
            expression,
            returnByValue: true,
            awaitPromise: true,
            includeCommandLineAPI: false,
            replMode: false,
        }, opts || {}));
        if (r.exceptionDetails) {
            const e = r.exceptionDetails;
            throw new Error('target threw: ' + (e.exception && (e.exception.description || e.exception.value) || e.text));
        }
        return r.result && r.result.value;
    }
    close() { try { this.ws.close(); } catch (_) {} }
}

async function connect(port) {
    const t = await waitForTarget(port, 8000);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
        setTimeout(() => reject(new Error('websocket connect timed out')), 8000);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    return cdp;
}

function openInspector(pid) {
    if (typeof process._debugProcess !== 'function') {
        throw new Error('this node build has no process._debugProcess');
    }
    try {
        process._debugProcess(pid);
    } catch (err) {
        if (err && (err.code === 'ENOENT' || /cannot find the file/i.test(err.message))) {
            throw new Error(
                'cannot arm the inspector on pid ' + pid + ' (ENOENT).\n' +
                '  This is Electron\'s main process; in a packaged build it never starts the\n' +
                '  Windows debug-signal handler thread, so the "node-debug-handler-' + pid + '"\n' +
                '  event does not exist to signal. Post-hoc attach is therefore impossible.\n' +
                '  Live injection only works against a Claude started with --inspect. Otherwise\n' +
                '  use patch.js (persistent) and relaunch at a quiet moment.'
            );
        }
        throw err;
    }
}

// ---------------------------------------------------------------- payloads

// Resolves a `require` inside the target's main context, where module scope is
// not reachable from Runtime.evaluate.
const REQ = `(await (async function(){
  if (typeof require === 'function') return { req: require, via: 'global' };
  if (process.mainModule && typeof process.mainModule.require === 'function')
    return { req: process.mainModule.require.bind(process.mainModule), via: 'mainModule' };
  // Dynamic import is not module-scoped, so it works even when nothing else does.
  var mod = await import('node:module');
  var createRequire = mod.createRequire || (mod.default && mod.default.createRequire);
  if (createRequire) return { req: createRequire(process.execPath), via: 'createRequire' };
  throw new Error('no require available in target main context');
})())`;

const PROBE = `(async function(){
  var out = { ok: false };
  try {
    var r = ${REQ};
    out.requireVia = r.via;
    out.electronVersion = process.versions.electron;
    out.nodeVersion = process.versions.node;
    var e = r.req('electron');
    out.appPath = e.app.getAppPath();
    out.appVersion = e.app.getVersion();
    out.alreadyInstalled = !!globalThis.__cuimod_live;
    out.views = e.webContents.getAllWebContents().map(function (w) {
      var u = '';
      try { u = w.getURL() || ''; } catch (_) {}
      return { id: w.id, type: (function(){ try { return w.getType(); } catch(_) { return '?'; } })(), url: u.slice(0, 90) };
    }).filter(function (v) { return /^https:\\/\\/(claude\\.ai|claude\\.com|preview\\.claude\\.ai)\\//.test(v.url); });
    out.ok = true;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  return out;
})()`;

function applyExpression() {
    const driver = fs.readFileSync(path.join(MOD_DIR, 'src', 'live-driver.js'), 'utf8');
    return `(async function(){
  var out = { ok: false };
  try {
    var r = ${REQ};
    ${driver}
    out.result = cuimodLiveDriver(r.req('electron'), r.req, ${JSON.stringify(MOD_DIR)});
    out.ok = true;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  return out;
})()`;
}

const STOP = `(function(){
  try {
    if (globalThis.__cuimod_live) { globalThis.__cuimod_live.stop(); return { ok: true, stopped: true }; }
    return { ok: true, stopped: false };
  } catch (err) { return { ok: false, error: String(err) }; }
})()`;

// inspector.close() blocks until there are no active sessions, so it must run
// after we disconnect — schedule it in the target and leave.
const CLOSE_LATER = `(async function(){
  try {
    var r = ${REQ};
    setTimeout(function(){ try { r.req('inspector').close(); } catch (e) {} }, 1500);
    return true;
  } catch (e) { return false; }
})()`;

// ---------------------------------------------------------------- commands

async function withTarget(pid, fn, keepInspector) {
    openInspector(pid);
    const cdp = await connect(PORT);
    try {
        return await fn(cdp);
    } finally {
        if (!keepInspector) {
            try { await cdp.evaluate(CLOSE_LATER); } catch (_) {}
        }
        cdp.close();
    }
}

function show(label, v) {
    console.log(label + ' ' + JSON.stringify(v, null, 2));
}

async function cmdProbe(keep) {
    const pid = mainPid();
    console.log('main pid ' + pid);
    const out = await withTarget(pid, (cdp) => cdp.evaluate(PROBE), keep);
    show('probe', out);
    if (!out || !out.ok) process.exitCode = 1;
}

async function cmdApply(keep) {
    const pid = mainPid();
    console.log('main pid ' + pid);
    const out = await withTarget(pid, async (cdp) => {
        const p = await cdp.evaluate(PROBE);
        if (!p || !p.ok) throw new Error('probe failed: ' + (p && p.error));
        console.log('claude-ai views: ' + p.views.length + '  electron ' + p.electronVersion);
        return cdp.evaluate(applyExpression());
    }, keep);
    show('apply', out);
    if (!out || !out.ok) process.exitCode = 1;
}

async function cmdStop(keep) {
    const pid = mainPid();
    const out = await withTarget(pid, (cdp) => cdp.evaluate(STOP), keep);
    show('stop', out);
}

// Exercises _debugProcess -> CDP -> evaluate -> inspector.close on a disposable
// child so the risky parts are proven before they are pointed at Claude.
async function cmdSelftest() {
    const script =
        'let n=0; const t=setInterval(()=>{ n++; if(n>600) { clearInterval(t); } },100);' +
        'process.stdout.write("ready\\n");';
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((res) => child.stdout.once('data', res));
    console.log('child pid ' + child.pid);

    let ok = true;
    try {
        openInspector(child.pid);
        const cdp = await connect(PORT);
        console.log('attached');
        const v = await cdp.evaluate('({ pid: process.pid, sum: 1 + 1, hasMainModule: !!process.mainModule })');
        console.log('evaluate ->', JSON.stringify(v));
        if (v.pid !== child.pid) { ok = false; console.log('FAIL wrong process'); }
        await cdp.evaluate(CLOSE_LATER);
        cdp.close();
        await sleep(3000);

        let stillOpen = true;
        try { await getJson('http://127.0.0.1:' + PORT + '/json/list'); } catch (_) { stillOpen = false; }
        console.log('inspector closed:', !stillOpen);
        if (stillOpen) ok = false;
        console.log('child alive:', child.exitCode === null);
        if (child.exitCode !== null) ok = false;
    } catch (err) {
        ok = false;
        console.log('FAIL ' + err.message);
    } finally {
        try { child.kill(); } catch (_) {}
    }
    console.log(ok ? 'selftest PASS' : 'selftest FAIL');
    if (!ok) process.exitCode = 1;
}

const args = process.argv.slice(2);
const cmd = args[0] || 'probe';
const keep = args.includes('--keep-inspector');
(async () => {
    try {
        if (cmd === 'probe') await cmdProbe(keep);
        else if (cmd === 'apply') await cmdApply(keep);
        else if (cmd === 'stop') await cmdStop(keep);
        else if (cmd === 'selftest') await cmdSelftest();
        else { console.error('usage: node live-inject.js selftest|probe|apply|stop [--keep-inspector]'); process.exitCode = 2; }
    } catch (err) {
        console.error('error: ' + (err && err.message ? err.message : err));
        process.exitCode = 1;
    }
})();
