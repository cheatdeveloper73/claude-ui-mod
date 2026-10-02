'use strict';
const fs = require('fs');

function terminalReceipt(record) {
    const attachment = record?.attachment;
    let value;
    if (record?.type === 'attachment' && attachment?.type === 'queued_command' && attachment.commandMode === 'task-notification') value = attachment.prompt;
    else if (record?.type === 'user' && record.origin?.kind === 'task-notification') {
        const content = record.message?.content;
        value = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : null;
    }
    if (typeof value !== 'string' || !value.startsWith('<task-notification>')) return null;
    const field = name => new RegExp('<' + name + '>([^<]+)</' + name + '>').exec(value)?.[1];
    const agentId = field('task-id'), toolUseId = field('tool-use-id'), status = field('status');
    const at = Date.parse(attachment?.timestamp || record.timestamp);
    if (!agentId || !toolUseId || !['completed', 'failed', 'killed'].includes(status) || !Number.isFinite(at)) return null;
    return { agentId, toolUseId, status, at, id: record.uuid || agentId + ':' + toolUseId + ':' + at };
}

// Only complete JSONL rows advance the durable cursor. Quoted notifications in
// user text, tool output or an agent's report are never lifecycle authority.
function readReceipts(file, offset = 0, maxBytes = 1024 * 1024) {
    const stat = fs.statSync(file);
    if (offset > stat.size) throw Error('native transcript was truncated; reconcile its ownership before restarting');
    if (offset === stat.size) return { offset, receipts: [] };
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
    let count;
    try { count = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
    const bytes = buffer.subarray(0, count);
    const end = bytes.lastIndexOf(10);
    if (end < 0) return { offset, receipts: [], needsMore: true };
    const receipts = [];
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('task-notification')) continue;
        let record;
        try { record = JSON.parse(line); } catch (_) { continue; }
        const receipt = terminalReceipt(record);
        if (receipt) receipts.push(receipt);
    }
    return { offset: offset + end + 1, receipts };
}

module.exports = { terminalReceipt, readReceipts };
