/* Does auto-compact fire and recover, unattended, on a realistically shaped
 * conversation with a routed model?
 *
 * Earlier attempts fed the worker one enormous user message. Reactive
 * compaction bails on that ("fewer than 2 groups", "no assistant messages in
 * summarize set"), and three bails trip a session-lifetime breaker -- a probe
 * artifact. This builds several real exchanges first, then crosses the
 * threshold, then keeps a tool loop running.
 *
 * Every response comes from an in-process loopback stub. Nothing reaches
 * Anthropic, the router, or any real session.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

if (process.env.CUIMOD_WORKER_PROBE !== '1') throw new Error('set CUIMOD_WORKER_PROBE=1');

const worker = process.env.CUIMOD_WORKER_PROBE_BIN
    || path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code', '2.1.260', 'claude.exe');
if (!fs.existsSync(worker)) throw new Error('binary not found: ' + worker);

const MODEL = 'claude-gpt-6-astra[1m]';
const WINDOW = '100000';                 // threshold lands at 67000

const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
    + 'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud '
    + 'exercitation ullamco laboris nisi aliquip ex ea commodo consequat ').split(' ');
function bulk(chars) {
    let out = '';
    for (let i = 0; out.length < chars; i++) out += WORDS[i % WORDS.length] + ' ';
    return out;
}
const PROSE = ('Progress note. The batch was read and catalogued, entries were cross-checked '
    + 'against the index, and the remaining items were queued for the next pass. No errors so '
    + 'far. Continuing with the next section of the list. ').repeat(8);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-final-'));
for (const dir of ['home', 'appdata', 'localappdata', 'config']) fs.mkdirSync(path.join(root, dir));

let inferences = 0;
let toolRounds = 0;
let toolLoopArmed = false;
const upstream = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        const approx = Math.max(4, Math.ceil(raw.length / 4));
        if (url.pathname === '/v1/messages/count_tokens') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ input_tokens: approx }));
            return;
        }
        if (url.pathname !== '/v1/messages') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
            return;
        }
        inferences++;
        const isCompaction = raw.includes('summary') && raw.includes('conversation');
        const useTool = toolLoopArmed && !isCompaction && toolRounds < 40;
        if (useTool) toolRounds++;
        const message = { id: 'msg_' + inferences, type: 'message', role: 'assistant', model: MODEL,
            content: [], stop_reason: null, usage: { input_tokens: approx, output_tokens: 0 } };
        const text = PROSE;
        const blocks = useTool
            ? [
                ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_' + inferences, name: 'Glob', input: {} } }],
                ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ pattern: '*' }) } }],
                ['content_block_stop', { type: 'content_block_stop', index: 1 }],
                ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }],
            ]
            : [
                ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
                ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }],
            ];
        const events = [['message_start', { type: 'message_start', message }], ...blocks,
            ['message_stop', { type: 'message_stop' }]];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(events.map(([e, v]) => `event: ${e}\ndata: ${JSON.stringify(v)}\n\n`).join(''));
    });
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;

const child = spawn(worker, [
    '--bare', '--debug', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', MODEL, '--autocompact', 'auto',
    '--settings', JSON.stringify({ autoCompactEnabled: true }),
    '--no-session-persistence', '--permission-mode', 'dontAsk',
], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
        ANTHROPIC_BASE_URL: endpoint,
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
        ANTHROPIC_API_KEY: 'cuimod-owned-loopback-probe',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: WINDOW,
        CLAUDE_CODE_DONT_INHERIT_ENV: '1',
        ANTHROPIC_LOG: 'debug',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
        APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
        CLAUDE_CONFIG_DIR: path.join(root, 'config'),
        PATH: process.env.PATH || '',
    },
});

let buffer = '';
let stderr = '';
const pending = new Map();
const timeline = [];
const compactFrames = [];
let sent = 0;
let mark = 0;
let resolveReady = null;
let rejectReady = null;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
ready.catch(() => {});

child.stderr.on('data', c => { stderr += c; });
child.on('exit', () => {
    rejectReady(new Error('worker exited early'));
    for (const s of pending.values()) s(null);
    pending.clear();
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
        if (['assistant', 'user', 'result', 'system'].includes(frame.type)) {
            const label = frame.type === 'system' ? String(frame.subtype)
                : frame.type === 'result' ? 'result'
                : frame.type + ':' + (Array.isArray(frame.message?.content)
                    ? frame.message.content.map(b => b.type).join('+') : 'text');
            timeline.push({ n: ++mark, mark: label, userTurns: sent });
        }
        if (frame.type === 'system' && frame.subtype === 'init') resolveReady(frame);
        if (frame.type === 'system' && String(frame.subtype).includes('compact')) {
            compactFrames.push({ subtype: frame.subtype, userTurns: sent });
        }
        if (frame.type === 'control_response') {
            const s = pending.get(frame.response?.request_id);
            if (s) { pending.delete(frame.response.request_id); s(frame.response); }
        }
    }
});

let seq = 0;
const control = (request, ms = 25000) => new Promise(resolve => {
    const id = 'p' + (++seq);
    let done = false;
    const settle = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { pending.delete(id); settle({ subtype: 'timeout' }); }, ms);
    pending.set(id, settle);
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
});
const usage = async label => {
    const a = await control({ subtype: 'get_context_usage' });
    const u = a?.response || null;
    return { step: label, total: u?.totalTokens ?? null, threshold: u?.autoCompactThreshold ?? null,
        window: u?.rawMaxTokens ?? null, source: u?.autocompactSource ?? null,
        enabled: u?.isAutoCompactEnabled ?? null };
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const say = text => {
    sent++;
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
        + String.fromCharCode(10));
};

const report = { model: MODEL, pid: child.pid, steps: [] };
try {
    // Four real exchanges first, so the summarize set has groups and assistant
    // messages. Each is well under the threshold on its own.
    say('Batch one, catalogue it:\n' + bulk(58000));
    await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error('init timeout')), 90000))]);
    await wait(6000);
    for (const n of ['two', 'three', 'four']) {
        say('Batch ' + n + ', catalogue it:\n' + bulk(58000));
        await wait(6000);
    }
    report.steps.push(await usage('after four exchanges'));

    // Now a long working turn, which is where an unattended session lives.
    toolLoopArmed = true;
    say('Keep working through everything, do not stop.');
    for (let i = 0; i < 45 && compactFrames.length === 0; i++) await wait(2500);
    await wait(5000);
    report.steps.push(await usage('after the long working turn'));

    report.fired = compactFrames.length > 0;
    report.compactFrames = compactFrames;
    report.toolRounds = toolRounds;
    report.inferences = inferences;
    report.timeline = timeline;
} catch (error) {
    report.error = String(error?.message || error);
} finally {
    try { child.stdin.end(); } catch (_) {}
    await new Promise(r => { const t = setTimeout(r, 8000); child.on('exit', () => { clearTimeout(t); r(); }); });
    try { child.kill(); } catch (_) {}
    await new Promise(r => upstream.close(r));
    report.root = root;
}
console.log(JSON.stringify(report, null, 2));
