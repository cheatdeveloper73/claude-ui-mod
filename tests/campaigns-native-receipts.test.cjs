'use strict';
// Staged tests for the native transcript receipt parser. These read/write real
// JSONL files under a throwaway directory; no app, no native session, no model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { terminalReceipt, readReceipts } = require(path.resolve(__dirname, '../src/plugins/campaigns/native-receipts'));

function dir(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
const notification = (agentId, toolUseId, status = 'completed') =>
    '<task-notification><task-id>' + agentId + '</task-id><tool-use-id>' + toolUseId + '</tool-use-id><status>' + status + '</status></task-notification>';
const attachment = (agentId, toolUseId, prompt = notification(agentId, toolUseId)) => JSON.stringify({
    type: 'attachment', uuid: 'uuid-' + agentId + '-' + toolUseId,
    attachment: { type: 'queued_command', commandMode: 'task-notification', prompt, timestamp: '2026-09-19T00:00:00Z' },
});

test('a trusted task-notification attachment is a terminal receipt', t => {
    const root = dir(t);
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, attachment('agent-a', 'toolu-a') + '\n');
    const read = readReceipts(file, 0);
    assert.deepEqual(read.receipts, [{ agentId: 'agent-a', toolUseId: 'toolu-a', status: 'completed',
        at: Date.parse('2026-09-19T00:00:00Z'), id: 'uuid-agent-a-toolu-a' }]);
});

test('quoted notifications in user text or tool output are ignored', t => {
    const root = dir(t);
    const file = path.join(root, 'transcript.jsonl');
    const userQuoted = JSON.stringify({ type: 'user', message: { role: 'user', content: notification('fake-user', 'toolu-user') } });
    const toolQuoted = attachment('fake-tool', 'toolu-tool', '"' + notification('fake-tool', 'toolu-tool') + '"');
    fs.writeFileSync(file, [userQuoted, toolQuoted].join('\n') + '\n');
    assert.deepEqual(readReceipts(file, 0).receipts, []);
    assert.equal(terminalReceipt({ type: 'user', attachment: { commandMode: 'task-notification', prompt: notification('x', 'y') } }), null);
});

test('only complete JSONL rows advance the durable cursor', t => {
    const root = dir(t);
    const file = path.join(root, 'transcript.jsonl');
    const first = attachment('agent-1', 'toolu-1') + '\n';
    fs.writeFileSync(file, first + attachment('agent-2', 'toolu-2').slice(0, 30));
    const pass1 = readReceipts(file, 0);
    assert.deepEqual(pass1.receipts.map(r => r.agentId), ['agent-1']);
    assert.equal(pass1.offset, first.length, 'the cursor stops at the last complete newline');
    fs.appendFileSync(file, attachment('agent-2', 'toolu-2').slice(30) + '\n');
    const pass2 = readReceipts(file, pass1.offset);
    assert.deepEqual(pass2.receipts.map(r => r.agentId), ['agent-2'], 'the continuation is read from the saved offset');
    assert.equal(pass2.offset, fs.statSync(file).size);
});

test('a row with no trailing newline yields no receipt and keeps the cursor', t => {
    const root = dir(t);
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, attachment('agent-1', 'toolu-1').slice(0, 20));
    const read = readReceipts(file, 0);
    assert.deepEqual(read.receipts, []);
    assert.equal(read.needsMore, true);
    assert.equal(read.offset, 0);
});

test('a truncated transcript is refused', t => {
    const root = dir(t);
    const file = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(file, attachment('agent-1', 'toolu-1') + '\n');
    assert.throws(() => readReceipts(file, 999999), /truncated/);
});

test('the live idle-root user/origin task-notification shape is a receipt', t => {
    // The actual completion record when the root is idle: a type:'user' record
    // with origin.kind 'task-notification', promptSource 'sdk', the tag in
    // message.content, and isSidechain false -- not an attachment.commandMode.
    const record = { type: 'user', uuid: 'live-1', origin: { kind: 'task-notification' }, promptSource: 'sdk',
        isSidechain: false, message: { content: notification('agent-live', 'toolu-live') }, timestamp: '2026-09-19T00:00:00Z' };
    const receipt = terminalReceipt(record);
    assert.equal(receipt.agentId, 'agent-live');
    assert.equal(receipt.toolUseId, 'toolu-live');
    assert.equal(receipt.status, 'completed');
    // A text-block content array is accepted the same way.
    assert.equal(terminalReceipt({ ...record, message: { content: [{ type: 'text', text: notification('agent-live', 'toolu-live') }] } }).agentId, 'agent-live');
});

test('a human origin is never a trusted receipt', t => {
    const human = { type: 'user', uuid: 'human-1', origin: { kind: 'human' }, isSidechain: false,
        message: { content: notification('fake-human', 'toolu-human') }, timestamp: '2026-09-19T00:00:00Z' };
    assert.equal(terminalReceipt(human), null);
    // A user record with no trusted origin at all is also ignored.
    assert.equal(terminalReceipt({ type: 'user', message: { content: notification('fake', 'toolu') }, timestamp: '2026-09-19T00:00:00Z' }), null);
});

test('an incomplete or unknown-status notification is not a receipt', t => {
    assert.equal(terminalReceipt(JSON.parse(attachment('a', 'b', '<task-notification><task-id>a</task-id></task-notification>'))), null);
    assert.equal(terminalReceipt(JSON.parse(attachment('a', 'b', notification('a', 'b', 'running')))), null);
    assert.equal(terminalReceipt({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'other', prompt: notification('a', 'b') } }), null);
});
