import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const {
    CompactionStore,
    anthropicSummaryResponse,
    buildFallbackPayload,
    collectRemoteCompaction,
    collectResponseText,
    isClaudeCompactionRequest,
    restoreCheckpointInput,
    retainCompactionHistory,
    stripCheckpointMarkers,
    summaryText,
} = await import(pathToFileURL(path.join(root, 'compaction.mjs')));

const prompt = 'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests and your previous actions.';
const wrapper = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;
const compactItem = { type: 'compaction', id: 'cmp_test', encrypted_content: 'opaque-test-state' };
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };

check('only a final dedicated user prompt is recognized as Claude compaction', () => {
    assert.equal(isClaudeCompactionRequest({ messages: [{ role: 'user', content: prompt }] })?.kind, 'full');
    assert.equal(isClaudeCompactionRequest({ messages: [{ role: 'user', content: wrapper + prompt }] })?.kind, 'full');
    assert.equal(isClaudeCompactionRequest({ messages: [{ role: 'user', content: 'I quoted this: ' + prompt }] }), null);
    assert.equal(isClaudeCompactionRequest({ messages: [{ role: 'user', content: 'CRITICAL: Respond with TEXT ONLY.\n' + prompt }] }), null);
    assert.equal(isClaudeCompactionRequest({ messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: 'later' }] }), null);
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-compaction-test-'));
try {
    const store = new CompactionStore(temp);
    const windowCut = { userMessages: 7, digest: 'cut-digest' };
    const record = store.save({ sessionId: 'session-a', sourceModel: 'gpt-test', history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] }, compactItem], fallback: 'portable', windowCut });
    const marker = summaryText(record.id, 'portable');
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prefix\n' + marker }] }];

    check('a checkpoint restores only for its bound session', () => {
        const restored = restoreCheckpointInput(input, 'session-a', store);
        assert.equal(restored.restored, 1);
        assert.deepEqual(restored.input, record.history);
        assert.deepEqual(restored.windowCuts, [windowCut]);
        const wrong = restoreCheckpointInput(input, 'session-b', store);
        assert.equal(wrong.restored, 0);
        assert.equal(wrong.degraded, 1);
        assert.equal(JSON.stringify(wrong.input).includes('cuimod:codex-compact'), false);
        assert.equal(JSON.stringify(wrong.input).includes('portable'), true);
    });

    check('status returns metadata and never checkpoint content', () => {
        const status = store.status('session-a');
        assert.equal(status.count, 1);
        assert.equal(status.latest.sourceModel, 'gpt-test');
        assert.equal(JSON.stringify(status).includes('opaque-test-state'), false);
    });

    check('invalid checkpoint state is rejected before it can replace usable history', () => {
        assert.throws(() => store.save({ sessionId: 'session-a', sourceModel: 'gpt-test',
            history: [{ type: 'compaction', encrypted_content: '   ' }], fallback: 'portable' }), /valid compaction item/);
        assert.throws(() => store.save({ sessionId: 'session-a', sourceModel: 'gpt-test',
            history: [compactItem, { ...compactItem, id: 'duplicate' }], fallback: 'portable' }), /valid compaction item/);

        const file = path.join(temp, 'compactions-v1', record.id + '.json');
        const valid = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, JSON.stringify({ ...record, history: [{ type: 'compaction', encrypted_content: '' }] }));
        assert.equal(store.load(record.id, 'session-a'), null);
        fs.writeFileSync(file, valid);
    });

    check('non-OpenAI bodies lose only the private marker', () => {
        const body = { messages: [{ role: 'user', content: marker }] };
        const stripped = stripCheckpointMarkers(body);
        assert.equal(stripped.messages[0].content, 'portable');
    });

    fs.writeFileSync(path.join(temp, 'compactions-v1', record.id + '.json'), '{broken');
    check('a corrupt checkpoint degrades to its embedded fallback', () => {
        const degraded = restoreCheckpointInput(input, 'session-a', store);
        assert.equal(degraded.degraded, 1);
        assert.equal(JSON.stringify(degraded.input).includes('portable'), true);
    });
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}

const msg = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const retained = await retainCompactionHistory([msg('old'), msg('middle'), msg('new')], 'gpt-test', async payload => payload.input[0].content[0].text.length, 9);
check('retention spends its budget newest-first', () => assert.deepEqual(retained.map(item => item.content[0].text), ['middle', 'new']));

const retainedWithTools = await retainCompactionHistory([
    msg('old'), { type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'result' }, msg('new'), compactItem,
], 'gpt-test', async () => 1, 64);
check('Codex retention keeps recent user messages while the opaque item owns old tool traffic', () => {
    assert.deepEqual(retainedWithTools, [msg('old'), msg('new')]);
});

check('remote collection rejects ambiguous checkpoint streams', () => {
    const terminal = { type: 'response.completed', response: { id: 'resp' } };
    assert.throws(() => collectRemoteCompaction([terminal]), /valid encrypted item/);
    assert.throws(() => collectRemoteCompaction([{ type: 'response.output_item.done', item: compactItem }, { type: 'response.output_item.done', item: compactItem }, terminal]), /valid encrypted item/);
    assert.throws(() => collectRemoteCompaction([
        { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: '   ' } }, terminal,
    ]), /valid encrypted item/);
    assert.throws(() => collectRemoteCompaction([
        { type: 'response.output_item.done', item: compactItem }, terminal,
        { type: 'response.output_text.delta', delta: 'late output' },
    ]), /after terminal/);
    assert.equal(collectRemoteCompaction([{ type: 'response.output_item.done', item: compactItem }, terminal]).item, compactItem);
});

check('portable summaries are owned by the first terminal event', () => {
    const terminal = { type: 'response.completed', response: { id: 'resp' } };
    assert.throws(() => collectResponseText([
        { type: 'response.output_text.delta', delta: 'usable' }, terminal,
        { type: 'response.output_text.delta', delta: 'late' },
    ]), /after terminal/);
    assert.throws(() => collectResponseText([
        { type: 'response.output_text.delta', delta: '   ' }, terminal,
    ]), /no text/);
});

check('portable fallback has no arbitrary length ceiling', () => {
    const payload = buildFallbackPayload('gpt-test', compactItem, 'cache-key');
    assert.ok(payload.instructions.includes('as much space as the handoff requires'));
    assert.equal(/\b4,?000\b/.test(payload.instructions), false);
    const off = buildFallbackPayload('gpt-test', compactItem, 'cache-key', { reasoningEnabled: false });
    assert.deepEqual(off.reasoning, { effort: 'none' });
    assert.equal(off.include, undefined);
});

check('synthetic streaming summary has a complete Anthropic lifecycle', () => {
    const wire = anthropicSummaryResponse('claude-gpt-test', 'summary', { input_tokens: 3, output_tokens: 2 }, true);
    for (const type of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) assert.ok(wire.includes('event: ' + type));
});

console.log(passed + ' compaction checks passed');
