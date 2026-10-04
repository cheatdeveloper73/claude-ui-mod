#!/usr/bin/env node
// Talk to the ChatGPT desktop app's dot from code: send messages, read replies, wait for turns.
//
// Transport: the app's own renderer bridge. Its main window page exposes
// electronBridge.sendMessageFromView, and an { type: 'mcp-request', hostId, request }
// envelope is forwarded verbatim to that host's app-server connection; the answer comes
// back to the page as a window 'message' of type 'mcp-response'. Dots are served by the
// 'durable' host (threadSource 'aeon'), and turn/addUserMessage is the same admission
// request the app uses for dot messages and scheduled automations. Posting to the
// ChatGPT messaging room directly is not used: that endpoint requires the app's
// sentinel/attestation tokens.
//
// Requires the app to have been launched with --remote-debugging-port (DOT_CDP_PORT,
// default 9333). Nothing here clicks or types into the window.
//
//   node scripts/dot.mjs threads
//   node scripts/dot.mjs status
//   node scripts/dot.mjs read [--turns 5]
//   node scripts/dot.mjs send "text" [--wait] [--timeout 900]
//   node scripts/dot.mjs wait --after <unixSeconds> [--timeout 900]
// Every command takes --thread <id> (or DOT_THREAD); the default is the most recently
// updated dot. --json prints machine-readable output.

import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.DOT_CDP_PORT || 9333);
const HOST = 'durable';
const REPLY_TOOL = 'user_message.send_message';

function fail(message) {
    process.stderr.write('dot: ' + message + '\n');
    process.exit(1);
}

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { args._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next == null || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
    }
    return args;
}

class Page {
    static async open() {
        let targets;
        try {
            targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        } catch (_) {
            fail(`ChatGPT is not listening for CDP on 127.0.0.1:${PORT}. It must be launched with --remote-debugging-port=${PORT}; see docs/internals.md "Driving dot from code".`);
        }
        const target = targets.find(t => t.type === 'page' && t.url.startsWith('app://-/index.html'));
        if (target == null) fail('ChatGPT main window page not found among CDP targets');
        const page = new Page(new WebSocket(target.webSocketDebuggerUrl));
        await new Promise((resolve, reject) => {
            page.ws.onopen = resolve;
            page.ws.onerror = () => reject(Error('CDP websocket failed to open'));
        });
        return page;
    }

    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        ws.onmessage = e => {
            const m = JSON.parse(e.data);
            const p = this.pending.get(m.id);
            if (p == null) return;
            this.pending.delete(m.id);
            if (m.error) p.reject(Error(m.error.message));
            else if (m.result.exceptionDetails) p.reject(Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
            else p.resolve(m.result.result.value);
        };
    }

    evaluate(expression) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
        });
    }

    // Responses above the app's chunking threshold arrive as codex-host-chunked-message-v1
    // fragments that only the app's receiver reassembles, so callers keep pages small.
    async rpc(method, params, timeoutMs = 30000) {
        const expression = `new Promise(resolve => {
            const id = 'cuimod-dot:' + crypto.randomUUID();
            const done = value => { clearTimeout(timer); window.removeEventListener('message', onMessage, true); resolve(value); };
            const onMessage = e => {
                const d = e.data;
                if (d && d.type === 'mcp-response' && d.message && d.message.id === id) done(JSON.stringify(d.message));
            };
            const timer = setTimeout(() => done(JSON.stringify({ error: { message: 'no response within ${timeoutMs} ms' } })), ${timeoutMs});
            window.addEventListener('message', onMessage, true);
            window.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId: ${JSON.stringify(HOST)},
                request: { id, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} } })
                .catch(err => done(JSON.stringify({ error: { message: String(err) } })));
        })`;
        const message = JSON.parse(await this.evaluate(expression));
        if (message.error) throw Error(`${method}: ${message.error.message}`);
        return message.result;
    }

    close() { this.ws.close(); }
}

async function dots(page) {
    const list = await page.rpc('thread/list', { limit: 100 });
    return list.data.filter(t => t.threadSource === 'aeon').sort((a, b) => b.updatedAt - a.updatedAt);
}

async function resolveThread(page, args) {
    const id = args.thread || process.env.DOT_THREAD;
    if (id) return id;
    const all = await dots(page);
    if (all.length === 0) fail('no dot threads on the durable host');
    return all[0].id;
}

async function turns(page, threadId, limit) {
    const res = await page.rpc('thread/turns/list', { threadId, limit, itemsView: 'notLoaded', sortDirection: 'desc' });
    return res.data.reverse();
}

async function items(page, threadId, turnId) {
    const out = [];
    let cursor = null;
    for (;;) {
        const res = await page.rpc('thread/items/list', { threadId, turnId, cursor, limit: 50, sortDirection: 'asc' });
        for (const row of res.data) out.push(row.item);
        if (res.nextCursor == null || res.nextCursor === cursor || res.data.length === 0) return out;
        cursor = res.nextCursor;
    }
}

// What a person would see in the dot chat: user text (minus the routing preamble) and
// whatever dot posted back through its reply tool.
function events(turn, turnItems) {
    const out = [];
    for (const item of turnItems) {
        if (item.type === 'userMessage') {
            const text = (item.content || []).filter(c => c.type === 'text' && !c.text.startsWith('<delivery_context>'))
                .map(c => c.text).join('\n').trim();
            if (text) out.push({ turnId: turn.id, role: 'user', clientId: item.clientId, text });
        } else if (item.type === 'mcpToolCall' && item.tool === REPLY_TOOL && item.arguments?.text) {
            out.push({ turnId: turn.id, role: 'dot', text: item.arguments.text });
        } else if (item.type === 'agentMessage' && item.text) {
            out.push({ turnId: turn.id, role: 'dot-final', text: item.text });
        }
    }
    return out;
}

function stamp(seconds) {
    return seconds == null ? '' : new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function printEvents(rows, json) {
    if (json) { process.stdout.write(JSON.stringify(rows, null, 1) + '\n'); return; }
    let lastTurn = null;
    for (const r of rows) {
        if (r.turnId !== lastTurn) {
            process.stdout.write(`\n-- turn ${r.turnId} ${r.turnStatus} ${stamp(r.startedAt)}\n`);
            lastTurn = r.turnId;
        }
        process.stdout.write(`${r.role}> ${r.text}\n`);
    }
}

async function collect(page, threadId, turnList) {
    const rows = [];
    for (const t of turnList) {
        for (const e of events(t, await items(page, threadId, t.id))) rows.push({ ...e, turnStatus: t.status, startedAt: t.startedAt });
    }
    return rows;
}

// Waits until every turn started at or after `after` has finished and the thread is idle,
// then returns what those turns produced. Dot routinely sleeps inside a turn while it
// watches tasks, so this is bounded by --timeout rather than by a quiet period.
async function waitFor(page, threadId, after, timeoutS, clientUserMessageId) {
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
        const recent = (await turns(page, threadId, 10)).filter(t => t.startedAt == null || t.startedAt >= after);
        const thread = (await page.rpc('thread/read', { threadId, includeTurns: false })).thread;
        let admitted = clientUserMessageId == null;
        if (!admitted) {
            for (const t of recent) {
                if ((await items(page, threadId, t.id)).some(i => i.type === 'userMessage' && i.clientId === clientUserMessageId)) { admitted = true; break; }
            }
        }
        const running = recent.some(t => t.status === 'inProgress') || thread.status.type === 'active';
        if (admitted && recent.length > 0 && !running) return { timedOut: false, rows: await collect(page, threadId, recent) };
        if (Date.now() > deadline) return { timedOut: true, admitted, rows: await collect(page, threadId, recent) };
        await new Promise(r => setTimeout(r, 5000));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (!['threads', 'status', 'read', 'send', 'wait'].includes(cmd)) {
        fail('usage: dot.mjs threads | status | read [--turns N] | send "text" [--wait] [--timeout S] | wait --after <unixSeconds> [--timeout S]  (all take --thread ID, --json)');
    }
    const page = await Page.open();
    try {
        if (cmd === 'threads') {
            const all = await dots(page);
            if (args.json) process.stdout.write(JSON.stringify(all.map(t => ({ id: t.id, name: t.name, status: t.status.type, updatedAt: t.updatedAt })), null, 1) + '\n');
            else for (const t of all) process.stdout.write(`${t.id}  ${t.status.type.padEnd(8)} ${stamp(t.updatedAt)}  ${t.name ?? ''}\n`);
            return;
        }
        const threadId = await resolveThread(page, args);
        if (cmd === 'status') {
            const thread = (await page.rpc('thread/read', { threadId, includeTurns: false })).thread;
            const last = (await turns(page, threadId, 1))[0];
            const out = { threadId, status: thread.status.type, model: thread.model, lastTurn: last && { id: last.id, status: last.status, startedAt: last.startedAt, completedAt: last.completedAt } };
            process.stdout.write(JSON.stringify(out, null, 1) + '\n');
            return;
        }
        if (cmd === 'read') {
            const n = Math.min(Math.max(Number(args.turns) || 5, 1), 50);
            printEvents(await collect(page, threadId, await turns(page, threadId, n)), args.json);
            return;
        }
        if (cmd === 'wait') {
            const after = Number(args.after);
            if (!Number.isFinite(after)) fail('wait needs --after <unixSeconds> (send prints it)');
            const res = await waitFor(page, threadId, after, Number(args.timeout) || 900, null);
            printEvents(res.rows, args.json);
            if (res.timedOut) fail('timed out with dot still working');
            return;
        }
        // send
        const text = args._.slice(1).join(' ').trim();
        if (!text) fail('send needs message text');
        // A send into a running turn is steered into it. On 2026-10-03 that left a turn
        // wedged in inProgress after a mid-turn compaction, swallowing the owner's next
        // chat message until the turn was interrupted. Only send to an idle dot.
        const current = (await page.rpc('thread/read', { threadId, includeTurns: false })).thread;
        if (current.status.type === 'active' && !args.force) fail('dot is mid-turn; not sending (pass --force to steer into the running turn)');
        const clientUserMessageId = randomUUID();
        const after = Math.floor(Date.now() / 1000) - 1;
        const result = await page.rpc('turn/addUserMessage', {
            threadId,
            input: [{ type: 'text', text, text_elements: [] }],
            clientUserMessageId,
            messageThreadId: randomUUID(),
        });
        process.stderr.write(`sent to ${threadId} clientUserMessageId=${clientUserMessageId} after=${after} admission=${result?.admissionOutcome ?? 'n/a'} turn=${result?.turn?.id ?? 'n/a'}\n`);
        if (!args.wait) return;
        const res = await waitFor(page, threadId, after, Number(args.timeout) || 900, clientUserMessageId);
        printEvents(res.rows, args.json);
        if (res.timedOut) fail(res.admitted ? 'timed out with dot still working' : 'message was not seen in the thread before the timeout');
    } finally {
        page.close();
    }
}

main().catch(err => fail(err.message));
