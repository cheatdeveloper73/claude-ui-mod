/* Proves what actually changes a *running* worker's auto-compact window.
 *
 * Same shape as auto-compact-worker-probe.mjs and the same rules: opt-in, one
 * disposable no-persistence worker in a fresh temp tree, pointed at an
 * in-process loopback stub that serves one inert reply. It does not create,
 * inspect, attach to, stop, or modify a Desktop session or any existing
 * claude.exe process.
 *
 * What it establishes, in order:
 *
 *   1. a worker launched with `--autocompact auto` adopts the window from the
 *      bootstrap response's auto_compact_windows (source "clientdata"),
 *   2. which exact model key that lookup uses, by serving every candidate
 *      spelling a *different* window and reading back which one landed,
 *   3. whether the same PID moves to a new window without a respawn, and by
 *      which lever.
 *
 * Usage:
 *   CUIMOD_WORKER_PROBE=1 node scripts/auto-compact-window-probe.mjs [--model <id>]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (process.env.CUIMOD_WORKER_PROBE !== '1') {
    throw new Error('refusing to launch a worker: set CUIMOD_WORKER_PROBE=1');
}

const argv = process.argv.slice(2);
const argOf = name => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1] ?? null;
};

const worker = process.env.CUIMOD_WORKER_PROBE_BIN
    || path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.260', 'claude.exe');
if (!fs.existsSync(worker)) throw new Error('Desktop Claude Code 2.1.260 binary not found: ' + worker);

const model = argOf('--model') || 'claude-opus-5';

// Every spelling the router might have to serve, each with its own window, so
// the reported rawMaxTokens names the key the CLI actually looked up. The
// values are distinct and inside the CLI's own 100k..1M validator.
const bare = model.replace(/\[[^\]]*\]$/, '').replace(/:(low|medium|high|xhigh|max)$/, '');
const CANDIDATES = [
    [model, 210000],
    [bare, 220000],
    [bare.replace(/^claude-/, ''), 230000],
    [`claude-${bare.replace(/^claude-/, '')}`, 240000],
];
const firstMap = {};
for (const [key, value] of CANDIDATES) if (!(key in firstMap)) firstMap[key] = value;
const SECOND_WINDOW = 1000000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-autocompact-live-'));
for (const dir of ['home', 'appdata', 'localappdata', 'config']) fs.mkdirSync(path.join(root, dir));
const configDir = path.join(root, 'config');
const SEED_FILES = [path.join(configDir, '.claude.json'), path.join(root, 'home', '.claude.json')];
function seed(map) {
    for (const file of SEED_FILES) {
        let parsed = {};
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { parsed = {}; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
        parsed.autoCompactWindowsCache = map;
        fs.writeFileSync(file, JSON.stringify(parsed));
    }
}

let servedWindows = firstMap;
seed(firstMap);
const seen = [];
let bootstrapFetches = 0;

const upstream = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seen.push(url.pathname);

    if (url.pathname === '/api/claude_cli/bootstrap') {
        bootstrapFetches++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ auto_compact_windows: servedWindows }));
        return;
    }
    if (url.pathname === '/v1/messages') {
        const message = { id: 'msg_cuimod_probe', type: 'message', role: 'assistant', model,
            content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } };
        const events = [
            ['message_start', { type: 'message_start', message }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
            ['message_stop', { type: 'message_stop' }],
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
        return;
    }
    if (url.pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 4 }));
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;

const child = spawn(worker, [
    '--bare', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, '--autocompact', 'auto',
    '--settings', JSON.stringify({ autoCompactEnabled: true }),
    '--no-session-persistence', '--permission-mode', 'dontAsk',
], {
    cwd: root,
    windowsHide: true,
    env: {
        ANTHROPIC_BASE_URL: endpoint,
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
        ANTHROPIC_API_KEY: 'cuimod-owned-loopback-probe',
        CLAUDE_CODE_DONT_INHERIT_ENV: '1',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
        APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
        CLAUDE_CONFIG_DIR: configDir,
        PATH: process.env.PATH || '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map();
let buffer = '';
let stderr = '';
let ready = null;
let readyFailed = null;
// The worker emits `system/init` only after it has an input frame to work on,
// so the wait for it has to be able to give up rather than hang the probe.
const readyPromise = new Promise((resolve, reject) => {
    ready = resolve;
    readyFailed = reject;
});
readyPromise.catch(() => {});

child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
        const at = buffer.indexOf('\n');
        if (at === -1) break;
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'system' && frame.subtype === 'init') ready(frame);
        if (frame.type === 'control_response') {
            const id = frame.response?.request_id;
            const settle = pending.get(id);
            if (settle) { pending.delete(id); settle(frame.response); }
        }
    }
});

let requestSeq = 0;
function control(request) {
    const id = `probe-${++requestSeq}`;
    const done = new Promise(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    return done;
}
const usage = async () => {
    const answer = await Promise.race([control({ subtype: 'get_context_usage' }), wait(20000).then(() => null)]);
    return answer?.response || null;
};


function configFiles() {
    const out = [];
    const walk = dir => {
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, name.name);
            if (name.isDirectory()) walk(full);
            else if (name.name.endsWith('.json')) out.push(full);
        }
    };
    try { walk(configDir); } catch (_) {}
    return out;
}

// Rewrite the CLI's own persisted cache in place. If the window is re-read from
// the config store rather than from a startup snapshot, this alone moves a
// running worker and no server round trip is needed.
function rewriteCache(value) {
    const touched = [];
    for (const file of configFiles()) {
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
        catch (_) { continue; }
        if (!parsed || typeof parsed !== 'object' || !('autoCompactWindowsCache' in parsed)) continue;
        const next = {};
        for (const key of Object.keys(parsed.autoCompactWindowsCache || {})) next[key] = value;
        if (Object.keys(next).length === 0) for (const [key] of CANDIDATES) next[key] = value;
        parsed.autoCompactWindowsCache = next;
        fs.writeFileSync(file, JSON.stringify(parsed));
        touched.push({ file: path.basename(file), keys: Object.keys(next) });
    }
    return touched;
}

const report = { worker: path.basename(worker), model, pid: child.pid, steps: [] };

try {
    const timeout = setTimeout(() => {
        readyFailed(new Error('worker never reported system/init'));
        for (const settle of pending.values()) settle(null);
        pending.clear();
        try { child.kill(); } catch (_) {}
    }, 90000);
    child.on('exit', () => {
        readyFailed(new Error('worker exited before reporting system/init'));
        for (const settle of pending.values()) settle(null);
        pending.clear();
    });

    // The worker initialises on its first input frame, not on spawn. Its only
    // inference route is the stub above, and that reply is fixed, local, and one
    // token long.
    child.stdin.write(JSON.stringify({ type: 'user',
        message: { role: 'user', content: 'reply with exactly ok' } }) + '\n');
    await readyPromise;

    const first = await usage();
    report.steps.push({ step: 'launch', bootstrapFetches, rawMaxTokens: first?.rawMaxTokens ?? null,
        threshold: first?.autoCompactThreshold ?? null, source: first?.autocompactSource ?? null,
        enabled: first?.isAutoCompactEnabled ?? null, model: first?.model ?? null });

    // Which candidate key answered decides what the router has to serve.
    const matched = CANDIDATES.find(([, value]) => value === first?.rawMaxTokens);
    report.lookupKey = matched ? matched[0] : null;
    report.cacheFiles = configFiles().filter(file => {
        try { return 'autoCompactWindowsCache' in JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
        catch (_) { return false; }
    }).map(file => path.basename(file));

    servedWindows = Object.fromEntries(CANDIDATES.map(([key]) => [key, SECOND_WINDOW]));

    const rewritten = rewriteCache(SECOND_WINDOW);
    seed(Object.fromEntries(CANDIDATES.map(([key]) => [key, SECOND_WINDOW])));
    await wait(600);
    const afterWrite = await usage();
    report.steps.push({ step: 'config-rewrite', rewritten, bootstrapFetches,
        rawMaxTokens: afterWrite?.rawMaxTokens ?? null, source: afterWrite?.autocompactSource ?? null });

    // One real turn, in case anything re-reads or refetches on a turn boundary.
    child.stdin.write(JSON.stringify({ type: 'user',
        message: { role: 'user', content: 'reply with exactly ok' } }) + '\n');
    await wait(6000);
    const afterTurn = await usage();
    report.steps.push({ step: 'after-turn', bootstrapFetches,
        rawMaxTokens: afterTurn?.rawMaxTokens ?? null, source: afterTurn?.autocompactSource ?? null });

    report.samePid = child.pid;
    report.transitioned = first?.rawMaxTokens !== afterTurn?.rawMaxTokens && afterTurn?.rawMaxTokens === SECOND_WINDOW;
    clearTimeout(timeout);
} finally {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => upstream.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

report.loopbackPaths = [...new Set(seen)];
if (stderr.trim()) report.stderr = stderr.trim().split('\n').slice(-6);
console.log(JSON.stringify(report, null, 2));
