'use strict';
const fs = require('fs');

const CHUNK = 256 * 1024;
const TASK_ID = /<task-id>([0-9a-z]+)<\/task-id>/i;
const RESULT = /<result>([\s\S]*?)<\/result>/i;
const STATUS = /<status>([a-z_]+)<\/status>/i;

function receiptOf(value) {
    if (Array.isArray(value)) return value.map(receiptOf).find(Boolean) || null;
    if (value && typeof value === 'object') {
        if (typeof value.success === 'boolean') return value;
        return receiptOf(value.content || value.text);
    }
    if (typeof value !== 'string') return null;
    try { return receiptOf(JSON.parse(value)); } catch (_) { return null; }
}

module.exports = function conversationReader() {
    const cache = new Map();

    function record(entry, line) {
        if (!line.includes('"name":"SendMessage"')
            && !line.includes('"type":"queued_command"')
            && !line.includes('"tool_use_id"')) return;
        let d;
        try { d = JSON.parse(line); } catch (_) { return; }
        const at = d.timestamp || null;
        if (d.type === 'assistant' && Array.isArray(d.message && d.message.content)) {
            for (const p of d.message.content) {
                if (!p || p.type !== 'tool_use' || p.name !== 'SendMessage') continue;
                const i = p.input || {};
                const body = i.message || i.content;
                if (!p.id || typeof body !== 'string' || !body.trim()) continue;
                const item = {
                    id: p.id, kind: 'message', at, to: i.to || i.recipient || null,
                    text: body, summary: i.summary || null, status: 'pending', pin: null,
                };
                entry.sent.push(item);
                entry.pending.set(p.id, item);
            }
        } else if (d.type === 'user' && entry.pending.size && Array.isArray(d.message && d.message.content)) {
            for (const p of d.message.content) {
                if (!p || p.type !== 'tool_result') continue;
                const item = entry.pending.get(p.tool_use_id);
                if (!item) continue;
                const receipt = receiptOf(p.content);
                item.status = p.is_error || (receipt && receipt.success === false) ? 'failed'
                    : receipt && receipt.success === true ? 'sent' : 'unknown';
                item.pin = receipt && receipt.pin && receipt.pin.id || null;
                entry.pending.delete(p.tool_use_id);
            }
        } else if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command') {
            const a = d.attachment;
            const origin = a.origin || {};
            if (origin.kind === 'peer' && origin.senderTaskId) {
                const body = origin.body || a.prompt;
                if (typeof body === 'string') entry.received.push({
                    id: d.uuid || 'received-' + entry.received.length,
                    sender: origin.senderTaskId, text: body, at,
                });
            } else if (origin.kind === 'coordinator' && typeof a.prompt === 'string') {
                entry.coordinator.push({ text: a.prompt, at });
            } else if (typeof a.prompt === 'string' && a.prompt.includes('<task-notification>')) {
                const id = TASK_ID.exec(a.prompt);
                const result = RESULT.exec(a.prompt);
                if (id && result) entry.reports.push({
                    id: d.uuid || 'report-' + entry.reports.length,
                    agentId: id[1], text: result[1].trim(),
                    status: (STATUS.exec(a.prompt) || [null, 'completed'])[1], at,
                });
            }
        }
    }

    function read(file) {
        let st;
        try { st = fs.statSync(file); } catch (_) { return null; }
        let entry = cache.get(file);
        if (entry && entry.size === st.size && entry.mtime === st.mtimeMs) return entry;
        if (!entry || st.size <= entry.size || st.ino !== entry.ino) {
            entry = {
                size: 0, mtime: 0, ino: st.ino, carry: Buffer.alloc(0),
                sent: [], pending: new Map(), received: [], coordinator: [], reports: [],
            };
        }
        let fd;
        try {
            fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(CHUNK);
            let at = entry.size;
            while (at < st.size) {
                const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - at), at);
                if (!n) break;
                at += n;
                const bytes = entry.carry.length ? Buffer.concat([entry.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
                let from = 0, end;
                while ((end = bytes.indexOf(10, from)) !== -1) {
                    const line = bytes.subarray(from, end).toString('utf8');
                    record(entry, line);
                    from = end + 1;
                }
                entry.carry = Buffer.from(bytes.subarray(from));
            }
            entry.size = at;
            entry.mtime = st.mtimeMs;
            cache.set(file, entry);
            return entry;
        } catch (_) { return null; }
        finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
    }

    function thread({ parentFile, childFile, childId, parentId, childName, parentName, brief, spawnedAt, aliases, limit, beforeId }) {
        const parent = read(parentFile);
        const child = read(childFile);
        if (!child) return { ok: false, reason: 'no agent transcript' };
        const aliasIsUnique = (name) => !!name && aliases.get(name) === 1;
        const targets = (item, id, name, main) => {
            if (item.status === 'failed') return false;
            if (item.pin) return item.pin === id;
            return item.to === id || (main && item.to === 'main')
                || (item.to === name && aliasIsUnique(name));
        };
        const messages = [];
        if (brief) messages.push({
            id: 'brief-' + childId, kind: 'brief', dir: 'parent',
            text: brief, at: spawnedAt || null, status: 'sent',
        });
        const outgoing = [];
        if (parent) for (const item of parent.sent) {
            if (targets(item, childId, childName, false)) outgoing.push(Object.assign({ dir: 'parent' }, item));
        }
        for (const item of child.sent) {
            if (targets(item, parentId, parentName, !parentId)) outgoing.push(Object.assign({ dir: 'child' }, item));
        }
        const deliveries = [];
        if (parent) for (const r of parent.received) {
            if (r.sender === childId) deliveries.push(Object.assign({ dir: 'child' }, r));
        }
        if (parentId) for (const r of child.received) {
            if (r.sender === parentId) deliveries.push(Object.assign({ dir: 'parent' }, r));
        }
        const consumed = new Set();
        const coordinatorUsed = new Set();
        for (const item of outgoing) {
            const match = deliveries.find((r) => !consumed.has(r.id) && r.dir === item.dir && r.text === item.text);
            if (match) { consumed.add(match.id); item.status = 'delivered'; }
            if (item.dir === 'parent' && !parentId) {
                const index = child.coordinator.findIndex((r, i) => !coordinatorUsed.has(i) && r.text === item.text);
                if (index >= 0) { coordinatorUsed.add(index); item.status = 'delivered'; }
            }
            messages.push(item);
        }
        for (const r of deliveries) if (!consumed.has(r.id)) messages.push({
            id: r.id, kind: 'message', dir: r.dir, text: r.text, at: r.at, status: 'delivered',
        });
        if (parent) for (const r of parent.reports) if (r.agentId === childId && r.text) messages.push({
            id: r.id, kind: 'report', dir: 'child', text: r.text, at: r.at, status: r.status,
        });
        messages.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
        const total = messages.length;
        const count = Math.min(100, Math.max(1, Number(limit) || 60));
        const anchor = beforeId ? messages.findIndex((m) => m.id === beforeId) : -1;
        const end = anchor >= 0 ? anchor : total;
        const start = Math.max(0, end - count);
        return { ok: true, messages: messages.slice(start, end), total, earlier: start };
    }

    return { thread, clear: () => cache.clear() };
};
