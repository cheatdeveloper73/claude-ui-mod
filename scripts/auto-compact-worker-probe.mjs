/* Proves the actual Desktop Claude Code binary resolves a launch-time window.
 *
 * This is deliberately opt-in. It creates one no-persistence worker in a fresh
 * temp tree and points it at an in-process loopback stub. The stub serves the
 * single inert reply needed to initialise the worker and never forwards a
 * request. It does not create, inspect, attach to, stop, or modify a Desktop
 * session or any existing claude.exe process.
 *
 * Usage:
 *   CUIMOD_WORKER_PROBE=1 node scripts/auto-compact-worker-probe.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (process.env.CUIMOD_WORKER_PROBE !== '1') {
    throw new Error('refusing to launch a worker: set CUIMOD_WORKER_PROBE=1');
}

const worker = process.env.CUIMOD_WORKER_PROBE_BIN
    || path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.260', 'claude.exe');
const hardDisabled = process.env.CUIMOD_WORKER_PROBE_DISABLED === '1';
const disabled = hardDisabled || process.env.CUIMOD_WORKER_PROBE_SESSION_OFF === '1';
assert.ok(fs.existsSync(worker), 'Desktop Claude Code 2.1.260 binary not found: ' + worker);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-autocompact-worker-'));
for (const dir of ['home', 'appdata', 'localappdata', 'config']) fs.mkdirSync(path.join(root, dir));
const paths = [];

const upstream = http.createServer((req, res) => {
    paths.push(req.url || '');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/messages') {
        const message = { id: 'msg_cuimod_probe', type: 'message', role: 'assistant', model: 'claude-opus-5',
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
    // Startup metadata may use /api/hello. It stays on this loopback listener.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;

const child = spawn(worker, [
    '--bare', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', 'claude-opus-5', '--autocompact', '400k',
    '--settings', JSON.stringify({ autoCompactEnabled: !disabled }),
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
        CLAUDE_CONFIG_DIR: path.join(root, 'config'),
        PATH: process.env.PATH || '',
        ...(hardDisabled ? { DISABLE_AUTO_COMPACT: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

let pending = '';
let stderr = '';
let queried = false;
let observed = null;
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
    pending += chunk;
    for (;;) {
        const at = pending.indexOf('\n');
        if (at === -1) break;
        const line = pending.slice(0, at).trim();
        pending = pending.slice(at + 1);
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'system' && frame.subtype === 'init' && !queried) {
            queried = true;
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'state',
                request: { subtype: 'get_context_usage' } }) + '\n');
        }
        if (frame.type === 'control_response' && frame.response?.request_id === 'state') {
            observed = frame.response.response || null;
            child.stdin.end();
        }
    }
});
// The worker needs one SDK input frame to initialise. Its only inference route
// above is the stub, and the response is fixed, local, and one token long.
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'reply with exactly ok' } }) + '\n');

const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('owned worker timed out')); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
});
await new Promise(resolve => upstream.close(resolve));
try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}

assert.equal(exit, 0, stderr || 'owned worker failed');
assert.ok(paths.some(value => new URL(value, endpoint).pathname === '/v1/messages'), 'stub received no worker inference');
assert.equal(observed?.isAutoCompactEnabled, !disabled, 'worker did not report the requested enablement');
if (!disabled) {
    assert.equal(observed?.rawMaxTokens, 400000, 'worker did not adopt the 400k launch window');
    assert.equal(observed?.autocompactSource, 'settings', 'worker did not attribute the window to its launch setting');
    assert.equal(observed?.autoCompactThreshold, 367000, 'worker did not resolve the 400k window to 367k');
}
console.log(JSON.stringify({
    worker: path.basename(worker),
    enabled: observed.isAutoCompactEnabled,
    effectiveWindow: observed.rawMaxTokens,
    threshold: observed.autoCompactThreshold ?? null,
    source: observed.autocompactSource,
    loopbackPaths: [...new Set(paths)],
}, null, 2));
