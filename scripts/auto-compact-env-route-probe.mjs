/* Proves the one route that moves a *running* worker's auto-compact window.
 *
 *   apply_flag_settings { settings: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW } } }
 *
 * `Cb()` tests that variable in its first branch and returns before it consults
 * the appState value `--autocompact` wrote, and a patch's env reaches Bun's own
 * process.env through the settings-change handler. So one PID launched at 400000
 * moves to 1000000 and back, at source "env", with no restart.
 *
 * The stub answers with a real tool_use for its first rounds, so the transition
 * is measured while an actual tool loop is in flight rather than only between
 * turns. Same discipline as the sibling probes and deliberately opt-in: one
 * disposable no-persistence worker in a fresh temp tree, pointed at an
 * in-process loopback stub. No Desktop session is created, inspected, attached
 * to, stopped, or modified.
 *
 * Usage:
 *   CUIMOD_WORKER_PROBE=1 node scripts/auto-compact-env-route-probe.mjs
 */
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
if (!fs.existsSync(worker)) throw new Error('binary not found: ' + worker);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-env-route-'));
for (const dir of ['home', 'appdata', 'localappdata', 'config']) fs.mkdirSync(path.join(root, dir));
const paths = [];
let inferences = 0;

const upstream = http.createServer((req, res) => {
    paths.push(req.url || '');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/messages') {
        inferences++;
        const useTool = inferences <= 8;
        const message = { id: 'msg_cuimod_probe', type: 'message', role: 'assistant', model: 'claude-opus-5',
            content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } };
        const events = [
            ['message_start', { type: 'message_start', message }],
            ...(useTool ? [
              ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_probe' + inferences, name: 'Glob', input: {} } }],
              ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ pattern: '*' }) } }],
              ['content_block_stop', { type: 'content_block_stop', index: 0 }],
              ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
            ] : [
              ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
              ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
              ['content_block_stop', { type: 'content_block_stop', index: 0 }],
              ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
            ]),
            ['message_stop', { type: 'message_stop' }],
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const payload = (events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
        setTimeout(() => res.end(payload), 1500);
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
    '--model', 'claude-opus-5', '--autocompact', '400000',
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
        CLAUDE_CONFIG_DIR: path.join(root, 'config'),
        PATH: process.env.PATH || '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let stderr = '';
const pendingControl = new Map();
let resolveReady = null;
let rejectReady = null;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
ready.catch(() => {});

child.stderr.on('data', chunk => { stderr += chunk; });
child.on('exit', () => {
    rejectReady(new Error('worker exited before init'));
    for (const settle of pendingControl.values()) settle(null);
    pendingControl.clear();
});
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
        if (frame.type === 'system' && frame.subtype === 'init') resolveReady(frame);
        if (frame.type === 'control_response') {
            const id = frame.response?.request_id;
            const settle = pendingControl.get(id);
            if (settle) { pendingControl.delete(id); settle(frame.response); }
        }
    }
});

let seq = 0;
// Bounded: every control request either answers or reports a timeout.
function control(request, ms = 20000) {
    const id = 'p' + (++seq);
    return new Promise(resolve => {
        let done = false;
        const settle = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { pendingControl.delete(id); settle({ subtype: 'timeout' }); }, ms);
        pendingControl.set(id, settle);
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    });
}

const usage = async label => {
    const answer = await control({ subtype: 'get_context_usage' });
    const u = answer?.response || null;
    return {
        step: label,
        rawMaxTokens: u?.rawMaxTokens ?? null,
        threshold: u?.autoCompactThreshold ?? null,
        source: u?.autocompactSource ?? null,
        enabled: u?.isAutoCompactEnabled ?? null,
        model: u?.model ?? null,
        error: answer?.subtype === 'success' ? null : (answer?.error || answer?.subtype || 'no-answer'),
    };
};

const envPatch = value => ({
    subtype: 'apply_flag_settings',
    settings: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: value } },
});

const report = { worker: path.basename(worker), pid: child.pid, steps: [], acks: [] };
try {
    // The worker initialises on its first input frame, not on spawn.
    child.stdin.write(JSON.stringify({ type: 'user',
        message: { role: 'user', content: 'reply with exactly ok' } }) + '\n');
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('init timeout')), 60000))]);

    report.steps.push(await usage('launch --autocompact 400000'));

    // A real ongoing tool loop: the stub answers with tool_use until round 4.
    report.loop = [];
    child.stdin.write(JSON.stringify({ type: 'user',
        message: { role: 'user', content: 'list files, keep going' } }) + String.fromCharCode(10));
    let flipped = false;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 600));
        if (!flipped && inferences >= 3) {
            flipped = true;
            const mid = await control(envPatch('1000000'));
            report.loop.push({ at: 'inference ' + inferences, sent: 'env=1000000', ack: mid?.subtype ?? null });
        }
        const u = await usage('loop inference ' + inferences);
        report.loop.push({ inferences, window: u.rawMaxTokens, threshold: u.threshold, source: u.source });
        if (flipped && inferences > 8) break;
    }
    await control(envPatch('400000'));
    report.steps.push(await usage('loop end, env=400000'));

    const up = await control(envPatch('1000000'));
    report.acks.push({ patch: '1000000', subtype: up?.subtype ?? null, error: up?.error ?? null });
    report.steps.push(await usage('after env=1000000'));

    const down = await control(envPatch('400000'));
    report.acks.push({ patch: '400000', subtype: down?.subtype ?? null, error: down?.error ?? null });
    report.steps.push(await usage('after env=400000'));

    report.samePid = child.pid;
    const at = label => report.steps.find(step => step.step === label);
    const launch = at('launch --autocompact 400000');
    const raised = at('after env=1000000');
    const back = at('after env=400000');
    const sampled = report.loop.filter(row => row.source);
    report.pass = launch?.rawMaxTokens === 400000 && launch?.source === 'settings'
        && raised?.rawMaxTokens === 1000000 && raised?.source === 'env'
        && back?.rawMaxTokens === 400000 && back?.source === 'env'
        // and the transition was visible while the tool loop was still running
        && sampled.some(row => row.source === 'settings')
        && sampled.some(row => row.source === 'env' && row.window === 1000000);
} catch (error) {
    report.error = String(error?.message || error);
} finally {
    try { child.stdin.end(); } catch (_) {}
    await new Promise(resolve => { const t = setTimeout(resolve, 8000); child.on('exit', () => { clearTimeout(t); resolve(); }); });
    try { child.kill(); } catch (_) {}
    await new Promise(resolve => upstream.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
report.stderrTail = stderr.split('\n').filter(Boolean).slice(-4);
console.log(JSON.stringify(report, null, 2));
