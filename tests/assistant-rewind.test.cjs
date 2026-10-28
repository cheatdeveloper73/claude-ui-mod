'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const page = require('../src/plugins/assistant-rewind/page');
const { rewindAfter, resolveTextTarget, insertBoundary } = require('../src/plugins/assistant-rewind/core');

const SID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLI = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const U = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const NEXT = '55555555-5555-4555-8555-555555555555';
const text = (uuid, parentUuid, id, value) => ({ type: 'assistant', uuid, parentUuid,
    message: { id, content: [{ type: 'text', text: value }] } });

// Desktop's contract: a user target supplies prefill, its assistant parent is
// kept, and pendingRewindTo drives --resume-session-at on the next send.
async function nativeRewind(sessionId, target) {
    const session = this.sessions.get(sessionId);
    if (!session?.cliSessionId || this.refuseHistoryRewriteIfBound(sessionId)) return null;
    const messages = await this.diskTranscript.loadTranscriptFromDisk(session);
    const chain = await this.diskTranscript.loadRawChainEntries(session);
    const user = messages.find(m => m.type === 'user' && m.uuid === target);
    const entry = chain.find(m => m.uuid === target);
    const parent = chain.find(m => m.uuid === entry?.parentUuid);
    if (!user?.message.content.trim() || parent?.type !== 'assistant') return null;
    // A sibling with a later descendant must not become resumable by inserting
    // the virtual target at the end of the chain.
    const active = new Set();
    let current = chain.at(-1);
    while (current && !active.has(current.uuid)) {
        active.add(current.uuid);
        current = chain.find(m => m.uuid === current.parentUuid);
    }
    if (!active.has(parent.uuid)) return null;
    this.withdrawHeldTurn(session, 'rewind');
    await this.stopSession(sessionId, 'rewind');
    session.pendingRewindTo = parent.uuid;
    session.pendingCutKeepsEveryMessage = false;
    session.pendingRewind = { forkPoint: parent.uuid, cliSessionId: session.cliSessionId,
        leafBefore: session.cliChainLeafUuid, prefill: user.message.content };
    session.cliChainLeafUuid = parent.uuid;
    session.messageBuffer = [];
    this.emitSessionUpdated(session);
    return { prefill: user.message.content, assistantUuid: parent.uuid };
}

function fixture() {
    const messages = [{ type: 'user', uuid: U, parentUuid: null, message: { content: 'start' } },
        text(A, U, 'msg_first', 'Keep this reply'), text(B, A, 'msg_second', 'Discard this reply')];
    const session = { sessionId: SID, cliSessionId: CLI, sendsSeen: 1, cliChainLeafUuid: B,
        messageBuffer: [], model: 'test' };
    const calls = [];
    const manager = {
        sessions: new Map([[SID, session]]), rewindSession: nativeRewind,
        diskTranscript: {
            async loadTranscriptFromDisk() { return messages; },
            async loadRawChainEntries() { return messages; },
        },
        refuseHistoryRewriteIfBound: () => false,
        withdrawHeldTurn: () => calls.push('withdraw'),
        async stopSession(id, why) { calls.push(['stop', id, why]); },
        emitSessionUpdated(s) { calls.push(['updated', s.pendingRewind.prefill]); },
    };
    return { manager, session, messages, calls };
}

const options = { cliSessionId: CLI, mintId: () => V };

test('base native rewind rejects an assistant UUID; adapter keeps that exact reply in place', async () => {
    const f = fixture();
    assert.equal(await f.manager.rewindSession(SID, A), null);
    assert.deepEqual(f.calls, []);
    const result = await rewindAfter(f.manager, SID, A, options);
    assert.equal(result.assistantUuid, A);
    assert.equal(result.prefill, '');
    assert.equal(f.session.pendingRewindTo, A);
    assert.equal(f.session.cliChainLeafUuid, A);
    assert.equal(f.session.pendingCutKeepsEveryMessage, false);
    assert.equal(f.session.pendingRewind.leafBefore, B);
    assert.equal(f.session.pendingRewind.prefill, '');
    assert.deepEqual(f.calls, ['withdraw', ['stop', SID, 'rewind'], ['updated', '']]);
    assert.deepEqual([...f.manager.sessions.keys()], [SID]);
    assert.deepEqual(f.messages.map(m => m.uuid), [U, A, B]);
    assert.ok(!JSON.stringify(f.session).includes(V));
    assert.equal(f.manager.diskTranscript.loadRawChainEntries.name, 'loadRawChainEntries');
});

test('boundary is adjacent to the selected record, never a new active-chain leaf', () => {
    const f = fixture();
    const result = insertBoundary(f.messages, A, V);
    assert.deepEqual(result.map(m => m.uuid), [U, A, V, B]);
    assert.equal(result[2].parentUuid, A);
    assert.equal(result[2].timestamp, undefined);
    assert.deepEqual(f.messages.map(m => m.uuid), [U, A, B]);
    assert.throws(() => insertBoundary(f.messages, NEXT, V), /checkpoint/);
});

test('raw tool blocks sharing an API message ID do not move the text checkpoint forward', () => {
    const messages = [text(A, U, 'msg_shared', 'Keep this reply'), {
        type: 'assistant', uuid: B, parentUuid: A,
        message: { id: 'msg_shared', content: [{ type: 'tool_use', id: 'tool_1' }] },
    }];
    assert.equal(resolveTextTarget(messages, 'msg_shared-t0', 'Keep this reply'), A);
    assert.equal(resolveTextTarget(messages, 'msg_shared-t0', 'edited text'), null);
    assert.equal(resolveTextTarget([...messages, { ...messages[0], uuid: NEXT }], 'msg_shared-t0', 'Keep this reply'), null);
    assert.equal(resolveTextTarget([{ ...messages[0], parent_tool_use_id: 'child' }], 'msg_shared-t0', 'Keep this reply'), null);
});

test('a rendered status backed by a thinking block keeps that exact checkpoint', async () => {
    const f = fixture();
    f.messages[1].message.content = [{ type: 'thinking', thinking: 'Keep this status' }];
    assert.equal(resolveTextTarget(f.messages, 'msg_first-th0', 'Keep this status'), A);
    const result = await rewindAfter(f.manager, SID, A, options);
    assert.equal(result.assistantUuid, A);
    assert.equal(f.session.pendingRewindTo, A);
});

test('dead branch, user, child assistant, missing and stale CLI targets stop nothing', async () => {
    for (const kind of ['dead', 'user', 'child', 'missing', 'stale']) {
        const f = fixture();
        let target = A;
        if (kind === 'dead') f.messages.push(text(NEXT, U, 'msg_other', 'other branch'));
        if (kind === 'user') target = U;
        if (kind === 'child') f.messages[1].parent_tool_use_id = 'tool_1';
        if (kind === 'missing') target = NEXT;
        if (kind === 'stale') f.session.cliSessionId = NEXT;
        await assert.rejects(rewindAfter(f.manager, SID, target, options));
        assert.deepEqual(f.calls, [], kind);
        assert.equal(f.session.pendingRewindTo, undefined, kind);
    }
});

test('native guards and exceptions survive the scoped read adapter', async () => {
    const f = fixture();
    f.manager.refuseHistoryRewriteIfBound = () => true;
    await assert.rejects(rewindAfter(f.manager, SID, A, options));
    assert.deepEqual(f.calls, []);
    f.manager.refuseHistoryRewriteIfBound = () => false;
    const original = f.manager.diskTranscript.loadRawChainEntries;
    f.manager.stopSession = async () => { throw Error('stop failed'); };
    await assert.rejects(rewindAfter(f.manager, SID, A, options), /stop failed/);
    assert.equal(f.manager.diskTranscript.loadRawChainEntries, original);
    assert.equal(f.session.pendingRewindTo, undefined);
});

function pageHarness(messages = []) {
    let snapshot = messages;
    const state = {
        buckets: { [SID]: { messages: { getSnapshot: () => snapshot } } },
        truncateAfterMessage(id, uuid) {
            assert.equal(id, SID);
            snapshot = snapshot.slice(0, snapshot.findIndex(m => m.uuid === uuid) + 1);
        },
    };
    const cleanupCalls = [];
    const context = {
        location: { pathname: '/epitaxy/' + SID },
        document: { querySelector: () => null },
        fakeImport: async () => ({ q: { getState: () => state }, unrelated: () => {},
            jo: { clearReviewFindings: (id, keep) => cleanupCalls.push(['review', id, keep]) },
            ed: { getState: () => ({ clearSession: id => cleanupCalls.push(['diffs', id]) }) },
            mn: id => cleanupCalls.push(['panes', id]),
        }),
    };
    const source = page.toString().replace(/import\('[^']+'\)/g, 'fakeImport()');
    const run = vm.runInNewContext('(' + source + ')', context);
    return { run, context, cleanupCalls, snapshot: () => snapshot };
}

test('page store update keeps the selected assistant and removes subsequent tool/user/assistant rows', async () => {
    const messages = [text(A, U, 'msg_first', 'keep'),
        { type: 'user', uuid: NEXT, message: { content: [{ type: 'tool_result' }] } },
        text(B, NEXT, 'msg_later', 'drop')];
    const h = pageHarness(messages);
    assert.equal(await h.run('verify', { sessionId: SID, uuid: A }), true);
    assert.equal(h.snapshot().length, 3);
    const result = await h.run('apply', { sessionId: SID, uuid: A });
    assert.equal(result.kept, A);
    assert.equal(h.snapshot().length, 1);
    assert.equal(h.snapshot()[0].uuid, A);
    assert.deepEqual(h.cleanupCalls, [['review', SID, false], ['diffs', SID], ['panes', SID]]);
});

test('page-world descriptor reads the individual text item rather than the merged turn UUID', async () => {
    const h = pageHarness();
    const node = { __reactFiber$test: { memoizedProps: {
        item: { id: 'msg_first-t0', kind: 'text', text: 'keep' },
        entry: { author: 'assistant', sourceUuid: B },
        sessionRef: { type: 'local', id: SID },
    } } };
    h.context.document.querySelector = () => ({
        getAttribute: () => 'assistant_text', querySelector: () => null, querySelectorAll: () => [node],
    });
    const result = await h.run('describe', { sessionId: SID, index: 7 });
    assert.equal(result.itemId, 'msg_first-t0');
    assert.equal(result.text, 'keep');
    node.__reactFiber$test.memoizedProps.sessionRef.id = 'local_' + NEXT;
    await assert.rejects(h.run('describe', { sessionId: SID, index: 7 }), /local Desktop/);
});

function groupedTextRow() {
    const row = { getAttribute: key => key === 'data-perf-row' ? 'assistant' : null };
    function prose(id, kind = 'text') {
        const attrs = new Map([['data-cds', 'Prose']]);
        const props = { item: { id, kind, text: 'Status ' + id }, sessionRef: { type: 'local', id: SID } };
        let fiber = { memoizedProps: props, return: null };
        for (let i = 0; i < 20; i++) fiber = { memoizedProps: {}, return: fiber };
        const anchor = { __reactFiber$test: fiber, closest: () => row,
            getAttribute: key => attrs.get(key) ?? null,
            setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
        anchor.prose = { __reactFiber$test: fiber, closest: () => row, parentElement: anchor };
        return anchor;
    }
    const first = prose('msg_first-t0');
    const second = prose('msg_second-t0');
    const tool = prose('tool_1', 'tools');
    row.querySelector = () => null;
    row.querySelectorAll = () => [first, second, tool];
    return { row, first, second, tool };
}

test('grouped status updates get distinct text anchors and descriptor targets', async () => {
    const h = pageHarness();
    const { row, first, second, tool } = groupedTextRow();
    h.context.document.querySelector = () => row;
    h.context.document.querySelectorAll = selector => {
        if (selector === '[data-cds="Prose"]') return [first.prose, second.prose, tool.prose];
        if (selector === '[data-testid="transcript-row"][data-perf-row="assistant_thinking"]') return [];
        return [first, second, tool];
    };
    await h.run('discover', { sessionId: SID });
    assert.equal(first.getAttribute('data-cuimod-rewind-text'), 'msg_first-t0');
    assert.equal(second.getAttribute('data-cuimod-rewind-text'), 'msg_second-t0');
    assert.equal(tool.getAttribute('data-cuimod-rewind-text'), null);
    const result = await h.run('describe', { sessionId: SID, index: 18, textItemId: 'msg_second-t0' });
    assert.equal(result.itemId, 'msg_second-t0');
    assert.equal(result.text, 'Status msg_second-t0');
    await assert.rejects(h.run('describe', { sessionId: SID, index: 18, textItemId: 'msg_missing-t0' }), /moved|unsupported/);
});

test('thinking rows expose their -th item as an exact descriptor target', async () => {
    const h = pageHarness();
    const rowAttrs = new Map([['data-perf-row', 'assistant_thinking'], ['data-index', '19']]);
    const anchorAttrs = new Map();
    const props = { item: { id: 'msg_thinking-th0', kind: 'thinking', text: 'Keep this status' },
        entry: { author: 'assistant', sourceUuid: A }, sessionRef: { type: 'local', id: SID } };
    const anchor = { __reactFiber$test: { memoizedProps: props, return: null },
        classList: { contains: value => value === 'group/thinking' },
        getAttribute: key => anchorAttrs.get(key) ?? null,
        setAttribute: (key, value) => anchorAttrs.set(key, value), removeAttribute: key => anchorAttrs.delete(key) };
    const row = { getAttribute: key => rowAttrs.get(key) ?? null, querySelector: () => null,
        querySelectorAll: selector => selector === '*' || (selector === '[data-cuimod-rewind-text]'
            && anchorAttrs.has('data-cuimod-rewind-text')) ? [anchor] : [] };
    h.context.document.querySelector = () => row;
    h.context.document.querySelectorAll = selector => {
        if (selector === '[data-testid="transcript-row"][data-perf-row="assistant_thinking"]') return [row];
        if (selector === '[data-cuimod-rewind-text]') return anchorAttrs.has('data-cuimod-rewind-text') ? [anchor] : [];
        return [];
    };
    const discovered = await h.run('discover', { sessionId: SID });
    assert.equal(discovered.tagged, 1);
    assert.equal(anchor.getAttribute('data-cuimod-rewind-text'), 'msg_thinking-th0');
    const result = await h.run('describe', { sessionId: SID, index: 19, textItemId: 'msg_thinking-th0' });
    assert.equal(result.itemId, 'msg_thinking-th0');
    assert.equal(result.text, 'Keep this status');
});

test('page verification fails before native mutation for navigation, stale UUID or missing store', async () => {
    const h = pageHarness([text(A, U, 'msg_first', 'keep')]);
    await assert.rejects(h.run('verify', { sessionId: 'local_' + NEXT, uuid: A }), /visible session/);
    await assert.rejects(h.run('verify', { sessionId: SID, uuid: B }), /displayed transcript/);
    h.context.fakeImport = async () => ({});
    await assert.rejects(h.run('verify', { sessionId: SID, uuid: A }), /displayed transcript/);
    assert.equal(h.snapshot().length, 1);
});

test('a concurrent send invalidates the checkpoint before native stop', async () => {
    const f = fixture();
    const read = f.manager.diskTranscript.loadRawChainEntries;
    f.manager.diskTranscript.loadRawChainEntries = async () => {
        const result = await read();
        f.session.sendsSeen++;
        return result;
    };
    await assert.rejects(rewindAfter(f.manager, SID, A, options), /changed/);
    assert.deepEqual(f.calls, []);
});
