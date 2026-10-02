import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const {
    AGENT_ISOLATION_VERSION,
    BASELINE_FINGERPRINT,
    CLAUDE_AUTO_COMPACT_RESERVE,
    DISCLOSURE,
    FALLBACK_TOKEN_BUDGET,
    ModelMessages,
    NEW_CONTEXT_TOOL,
    NOTES_ROUTES,
    ROUTE_BY_CALL,
    WindowStore,
    applyWindowCut,
    codexBase,
    contextBudgetLimits,
    contextBudgetStatus,
    contextResetSummary,
    contextTools,
    contextWindowMessage,
    driftReport,
    guidanceMessage,
    isContextCall,
    reminderMessage,
    restoreContextResetInput,
    stripConcealment,
    stripContextResetMarkers,
    tokenBudgetFor,
    toolOutputContent,
    turnMetadata,
    windowCutsMatch,
} = await import(pathToFileURL(path.join(root, 'context-management.mjs')));
const { ResponsesToAnthropic, codexIdentityHeaders, responsesHeaders, sseParser } = await import(pathToFileURL(path.join(root, 'openai.mjs')));
const { readAutoCompactBudget } = await import(pathToFileURL(path.join(root, 'settings.mjs')));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-context-'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name); };
const checkAsync = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };

// The upstream text, verbatim, so a reworded strip pass fails here rather than
// shipping the concealment instruction to the model.
const UPSTREAM_NOTES_DESCRIPTION = 'Read and maintain private notes that survive context-window transitions within this rollout. Paths are virtual, not filesystem paths. This is private model-only state. Use it silently to continue the task. Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents (including by quoting or summarizing them) to the user.';
const UPSTREAM_GUIDANCE = 'For tasks that may span context windows, use `notes` to maintain a concise checkpoint.\n\nTreat notes and history as internal bookkeeping. Do not mention them in user-facing messages.\n';

check('explicit session identity overrides a colliding prompt-cache key everywhere', () => {
    const key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const session = '12345678-1234-4123-8123-123456789abc';
    const identity = codexIdentityHeaders(key, session);
    const responses = responsesHeaders({ access_token: 'token', account_id: 'account' }, key, session);
    assert.equal(identity['session-id'], session);
    assert.equal(identity['thread-id'], session);
    assert.equal(responses['session-id'], session);
    assert.equal(responses['thread-id'], session);
    assert.notEqual(codexIdentityHeaders(key)['session-id'], session);
});

check('concealment is stripped and the functional half survives', () => {
    const stripped = stripConcealment(UPSTREAM_NOTES_DESCRIPTION);
    assert.ok(stripped.removed >= 1);
    assert.ok(stripped.text.includes('Paths are virtual, not filesystem paths.'));
    assert.ok(!/private model-only state/i.test(stripped.text));
    assert.ok(!/never disclose/i.test(stripped.text));
    assert.ok(!/use it silently/i.test(stripped.text));
});

check('guidance loses the bookkeeping instruction and gains the permission', () => {
    const { message, removed } = guidanceMessage(UPSTREAM_GUIDANCE);
    assert.equal(removed, 1);
    const text = message.content[0].text;
    assert.ok(text.startsWith('<context_window_guidance>'));
    assert.ok(text.includes('maintain a concise checkpoint'));
    assert.ok(!/internal bookkeeping/i.test(text));
    // The reserved tool descriptions cannot be edited, so the guidance is the
    // only place this mod gets to contradict them.
    assert.ok(text.includes(DISCLOSURE));
});

check('the permission survives even when upstream sends no guidance', () => {
    const { message } = guidanceMessage('');
    assert.ok(message.content[0].text.includes(DISCLOSURE));
});

// Reserved names are validated against the backend's own schema, and a mismatch
// rejects the whole tool list. gpt-5.6-luna accepted an edited copy and
// gpt-6-astra refused it, so parity is asserted against the captured wire form
// rather than against whether one model happened to tolerate it.
check('the namespace specs are byte-identical to the captured Codex wire form', () => {
    const captured = JSON.parse(fs.readFileSync(
        fileURLToPath(new URL('./fixtures/codex-context-tools.json', import.meta.url)), 'utf8'));
    const shipped = contextTools().filter(tool => tool.type === 'namespace');
    assert.equal(JSON.stringify(shipped), JSON.stringify(captured));
});

check('no schema keyword the wire form omits is reintroduced', () => {
    // `minimum` survives in the Rust json! macro and is dropped before the wire.
    // Adding it back is what made gpt-6-astra reject the request.
    const serialized = JSON.stringify(contextTools());
    assert.ok(!serialized.includes('"minimum"'));
    assert.ok(!serialized.includes('"output_schema"'));
    assert.ok(!serialized.includes('"defer_loading"'));
});

check('every upstream route is reachable through exactly one tool', () => {
    const routes = [...ROUTE_BY_CALL.values()].sort();
    assert.deepEqual(routes, [...NOTES_ROUTES].sort());
    assert.equal(ROUTE_BY_CALL.size, NOTES_ROUTES.length);
});

check('the tool set is exactly what the Codex client sends', () => {
    const tools = contextTools();
    // get_context_remaining is registered in spec_plan.rs but absent from the
    // captured request, so it is not shipped either.
    assert.deepEqual(tools.map(tool => tool.name), ['history', 'notes', NEW_CONTEXT_TOOL]);
    assert.deepEqual(tools[0].tools.map(tool => tool.name), ['list_items', 'list_windows', 'read_item', 'search_contents']);
    assert.deepEqual(tools[1].tools.map(tool => tool.name), ['append_to_file', 'list_files_by_prefix', 'read_file', 'search_contents', 'write_file']);
    assert.equal(tools[0].type, 'namespace');
    assert.equal(tools[2].type, 'function');
});

check('model-only calls are recognized and client tools are not', () => {
    assert.ok(isContextCall({ type: 'function_call', namespace: 'notes', name: 'write_file' }));
    assert.ok(isContextCall({ type: 'function_call', namespace: 'history', name: 'read_item' }));
    assert.ok(isContextCall({ type: 'function_call', name: NEW_CONTEXT_TOOL }));
    assert.ok(!isContextCall({ type: 'function_call', name: 'get_context_remaining' }));
    assert.ok(!isContextCall({ type: 'function_call', name: 'Read' }));
    assert.ok(!isContextCall({ type: 'function_call', namespace: 'notes', name: 'delete_file' }));
    assert.ok(!isContextCall({ type: 'message', name: NEW_CONTEXT_TOOL }));
});

check('an encrypted result is replayed as an encrypted content item', () => {
    assert.deepEqual(toolOutputContent({ encrypted_output: 'gAAAAAB-opaque' }),
        [{ type: 'encrypted_content', encrypted_content: 'gAAAAAB-opaque' }]);
    const plain = toolOutputContent({ text: 'listing' });
    assert.equal(plain[0].type, 'input_text');
    assert.ok(plain[0].text.includes('listing'));
    const withImage = toolOutputContent({ encrypted_output: 'gAAAAAB', images: [{ data: 'AAAA', mime_type: 'image/png' }] });
    assert.equal(withImage.length, 2);
    assert.equal(withImage[1].image_url, 'data:image/png;base64,AAAA');
});

check('the notes base is derived from the responses url', () => {
    assert.equal(codexBase('https://chatgpt.com/backend-api/codex/responses'), 'https://chatgpt.com/backend-api/codex/');
    assert.equal(codexBase('https://example.test/v1/codex/responses'), 'https://example.test/v1/codex/');
});

check('the context window message reports a reset only after one happened', () => {
    const first = contextWindowMessage({ agentName: '/root', firstWindowId: 'w1', previousWindowId: null, windowId: 'w1' }).content[0].text;
    assert.ok(first.includes('First context window id: w1'));
    assert.ok(!first.includes('Previous context window id'));
    const later = contextWindowMessage({ agentName: '/root', firstWindowId: 'w1', previousWindowId: 'w1', windowId: 'w2', threadHint: 'Recent notes: none' }).content[0].text;
    assert.ok(later.includes('Previous context window id: w1'));
    assert.ok(later.includes('Recent notes: none'));
});

check('the reminder substitutes the remaining budget', () => {
    const { message } = reminderMessage(FALLBACK_TOKEN_BUDGET.reminder_message_template, 4096);
    assert.ok(message.content[0].text.includes('4096'));
    assert.ok(!message.content[0].text.includes('{n_remaining}'));
});

const userMessage = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

check('a window cut drops the prefix it recorded', () => {
    const input = [userMessage('one'), { type: 'function_call', name: 'Read' }, userMessage('two'), userMessage('three')];
    const cut = { userMessages: 2, digest: null };
    // The digest has to match, so take it from a real rotation instead.
    const store = new WindowStore(path.join(temp, 'cut'));
    const state = store.ensure('11111111-2222-3333-4444-555555555555');
    assert.equal(state.previousWindowId, null);
    const rotated = store.rotate('11111111-2222-3333-4444-555555555555', input.slice(0, 3));
    assert.equal(rotated.previousWindowId, state.windowId);
    assert.equal(rotated.cut.userMessages, 2);
    const applied = applyWindowCut(input, rotated.cut);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.input, [userMessage('three')]);
    void cut;
});

check('a cut follows its unique anchor when earlier history shifts', () => {
    const store = new WindowStore(path.join(temp, 'shifted-cut'));
    const session = '12121212-3434-5656-7878-909090909090';
    store.ensure(session);
    const rotated = store.rotate(session, [userMessage('one'), userMessage('two')]);
    const applied = applyWindowCut([userMessage('inserted'), userMessage('one'), userMessage('two'), userMessage('three')], rotated.cut);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.input, [userMessage('three')]);
});

check('a cut identifies image-bearing user messages by their complete content', () => {
    const store = new WindowStore(path.join(temp, 'image-cut'));
    const session = '13131313-3434-5656-7878-909090909090';
    const image = data => ({ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'inspect this' },
        { type: 'input_image', image_url: 'data:image/png;base64,' + data },
    ] });
    store.ensure(session);
    const rotated = store.rotate(session, [image('AAAA')]);
    const changed = applyWindowCut([image('BBBB'), userMessage('next')], rotated.cut);
    assert.equal(changed.applied, false);
    assert.match(changed.degraded, /changed/);
    const exact = applyWindowCut([image('AAAA'), userMessage('next')], rotated.cut);
    assert.equal(exact.applied, true);
    assert.deepEqual(exact.input, [userMessage('next')]);
});

check('a cut is abandoned when the history it anchored to changed', () => {
    const store = new WindowStore(path.join(temp, 'cut2'));
    const session = '22222222-3333-4444-5555-666666666666';
    store.ensure(session);
    const rotated = store.rotate(session, [userMessage('alpha'), userMessage('bravo')]);
    const rewritten = applyWindowCut([userMessage('alpha'), userMessage('rewritten'), userMessage('charlie')], rotated.cut);
    assert.equal(rewritten.applied, false);
    assert.match(rewritten.degraded, /changed/);
    const short = applyWindowCut([userMessage('alpha')], rotated.cut);
    assert.equal(short.applied, false);
    assert.match(short.degraded, /shorter/);
});

check('a cut that would empty the window is refused', () => {
    const store = new WindowStore(path.join(temp, 'cut3'));
    const session = '33333333-4444-5555-6666-777777777777';
    store.ensure(session);
    const input = [userMessage('only')];
    const rotated = store.rotate(session, input);
    const applied = applyWindowCut(input, rotated.cut);
    assert.equal(applied.applied, false);
    assert.match(applied.degraded, /every user message/);
});

check('window identity is stable across reads and unique per session', () => {
    const store = new WindowStore(path.join(temp, 'ids'));
    const a = store.ensure('44444444-5555-6666-7777-888888888888');
    const again = store.ensure('44444444-5555-6666-7777-888888888888');
    assert.equal(a.storeId, again.storeId);
    assert.equal(a.firstWindowId, again.windowId);
    const b = store.ensure('55555555-6666-7777-8888-999999999999');
    assert.notEqual(a.storeId, b.storeId);
    assert.throws(() => store.ensure('not a session id'), /invalid session id/);
});

check('a pre-isolation store is quarantined instead of reusing mixed-agent state', () => {
    const root = path.join(temp, 'agent-isolation-migration');
    const session = '45454545-5656-6767-8989-909090909090';
    const store = new WindowStore(root);
    const current = store.ensure(session);
    const oldStoreId = current.storeId;
    const oldCreatedAt = current.createdAt;
    store.write({
        ...current,
        agentIsolationVersion: undefined,
        windows: 4,
        previousWindowId: crypto.randomUUID(),
        cut: { userMessages: 2, digest: 'mixed-agent-cut' },
        threadHint: 'mixed-agent hint',
        activity: { ...current.activity, turns: 9, noteCalls: 3 },
    });

    const migratedStore = new WindowStore(root);
    assert.equal(migratedStore.quarantineLegacy('46464646-5757-6868-8989-010101010101'), null);
    const isolated = migratedStore.quarantineLegacy(session);
    assert.equal(isolated.agentIsolationVersion, AGENT_ISOLATION_VERSION);
    assert.notEqual(isolated.storeId, oldStoreId);
    assert.equal(isolated.quarantinedStoreId, oldStoreId);
    assert.equal(isolated.createdAt, oldCreatedAt);
    assert.equal(isolated.windows, 1);
    assert.equal(isolated.previousWindowId, null);
    assert.equal(isolated.cut, null);
    assert.equal(isolated.threadHint, null);
    assert.equal(isolated.activity.turns, 0);
    assert.equal(isolated.activity.noteCalls, 0);
    assert.ok(isolated.quarantinedAt);

    const status = store.status(session);
    assert.equal(status.agentIsolationVersion, AGENT_ISOLATION_VERSION);
    assert.equal(status.quarantinedPriorNamespace, true);
    assert.equal(status.quarantinedAt, isolated.quarantinedAt);
});

check('a compacted cut is cleared only when its identity matches', () => {
    const store = new WindowStore(path.join(temp, 'clear-cut'));
    const session = '56565656-7878-9090-abab-cdcdcdcdcdcd';
    store.ensure(session);
    const rotated = store.rotate(session, [userMessage('anchor')]);
    assert.equal(windowCutsMatch(rotated.cut, { ...rotated.cut }), true);
    assert.ok(store.clearCut(session, { userMessages: 1, digest: 'wrong' }).cut);
    assert.equal(store.clearCut(session, rotated.cut).cut, null);
});

check('the reminder is claimed once per window', () => {
    const store = new WindowStore(path.join(temp, 'reminder'));
    const session = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    store.ensure(session);
    assert.equal(store.claimReminder(session), true);
    assert.equal(store.claimReminder(session), false);
    store.rotate(session, [userMessage('go')]);
    assert.equal(store.claimReminder(session), true);
});

check('the status view exposes window bookkeeping and no note content', () => {
    const store = new WindowStore(path.join(temp, 'status'));
    const session = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    store.ensure(session);
    store.rotate(session, [userMessage('go')]);
    const status = store.status(session);
    assert.equal(status.windows, 2);
    assert.equal(status.cutUserMessages, 1);
    assert.equal(store.status('88888888-9999-aaaa-bbbb-cccccccccccc'), null);
    assert.ok(!Object.keys(status).some(key => /note|text|content/i.test(key)));
});

check('activity and every reset cause survive a new store instance', () => {
    const root = path.join(temp, 'durable-activity');
    const session = '78787878-9090-abab-cdcd-efefefefefef';
    const store = new WindowStore(root);
    store.recordTurn(session, { hint: true, budget: { remaining: 6144, forceRemaining: 22528 }, threadHint: 'Recent notes:\n- /root/notes/checkpoint.md' });
    store.recordModelCall(session, { namespace: 'notes', name: 'write_file' });
    store.recordModelCall(session, { name: NEW_CONTEXT_TOOL });
    store.rotate(session, [userMessage('one'), userMessage('two')], { cause: 'model' });
    store.rotate(session, [userMessage('three'), userMessage('four')], { cause: 'forced', beforeLastUser: true });
    const status = new WindowStore(root).status(session);
    const activity = status.activity;
    assert.equal(status.threadHint, 'Recent notes:\n- /root/notes/checkpoint.md');
    assert.equal(activity.turns, 1);
    assert.equal(activity.hintCalls, 1);
    assert.equal(activity.modelCalls, 2);
    assert.equal(activity.noteCalls, 1);
    assert.equal(activity.resets, 2);
    assert.equal(activity.modelResets, 1);
    assert.equal(activity.forcedResets, 1);
    assert.equal(activity.compactionResets, 0);
    assert.equal(activity.lastResetCause, 'forced');
    assert.match(activity.lastResetAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(activity.budget, null);
});

check('pre-activity window files retain their earlier reset count', () => {
    const root = path.join(temp, 'activity-migration');
    const session = '79707070-9090-abab-cdcd-efefefefefef';
    const store = new WindowStore(root);
    const state = store.ensure(session);
    store.write({ ...state, windows: 3, activity: undefined });
    const activity = new WindowStore(root).status(session).activity;
    assert.equal(activity.resets, 2);
    assert.equal(activity.unattributedResets, 2);
});

check('a forced reset preserves the latest user turn', () => {
    const store = new WindowStore(path.join(temp, 'forced-cut'));
    const session = '79797979-9090-abab-cdcd-efefefefefef';
    const input = [userMessage('old'), userMessage('current')];
    const state = store.rotate(session, input, { cause: 'forced', beforeLastUser: true });
    const applied = applyWindowCut(input, state.cut);
    assert.deepEqual(applied.input, [userMessage('current')]);
});

check('a forced cut retains complete outstanding tool sequences after its anchor', () => {
    const store = new WindowStore(path.join(temp, 'forced-tool-cut'));
    const session = '79898989-9090-abab-cdcd-efefefefefef';
    const call = { type: 'function_call', call_id: 'call-1', name: 'Read', arguments: '{}' };
    const result = { type: 'function_call_output', call_id: 'call-1', output: 'result' };
    const current = userMessage('current');
    const input = [userMessage('old'), call, result, current];
    const state = store.rotate(session, input, { cause: 'forced', beforeLastUser: true });
    const applied = applyWindowCut(input, state.cut);
    assert.deepEqual(applied.input, [call, result, current]);
});

check('client compaction resets are idempotent and their marker remains retry-safe', () => {
    const store = new WindowStore(path.join(temp, 'client-reset'));
    const session = '80808080-9090-abab-cdcd-efefefefefef';
    const input = [userMessage('one'), userMessage('two')];
    const first = store.beginClientReset(session, input);
    const retry = store.beginClientReset(session, input);
    assert.equal(retry.id, first.id);
    assert.equal(retry.reused, true);
    assert.equal(store.status(session).activity.compactionResets, 1);
    const marker = contextResetSummary(first.id);
    const restored = restoreContextResetInput([
        userMessage('This session continues after compaction.\n' + marker),
        userMessage('next'),
    ], store.read(session));
    assert.deepEqual(restored.input, [userMessage('next')]);
    assert.deepEqual(restored.resetIds, [first.id]);
    store.acknowledgeClientReset(session, restored.resetIds);
    assert.equal(store.status(session).pendingClientReset, false);
    assert.equal(store.status(session).cutUserMessages, null);
    const retryAfterAck = restoreContextResetInput([
        userMessage('This session continues after compaction.\n' + marker),
        userMessage('retry'),
    ], store.read(session));
    assert.deepEqual(retryAfterAck.input, [userMessage('retry')]);
    assert.deepEqual(retryAfterAck.resetIds, [first.id]);
});

check('context reset markers never leak to another provider', () => {
    const marker = contextResetSummary('81818181-9191-abab-cdcd-efefefefefef');
    const body = { messages: [{ role: 'user', content: 'Summary:\n' + marker }, { role: 'user', content: 'continue' }] };
    assert.deepEqual(stripContextResetMarkers(body).messages, [{ role: 'user', content: 'continue' }]);
});

check('drift is quiet on the shape this arm was written against', () => {
    const budget = { ...FALLBACK_TOKEN_BUDGET };
    const report = driftReport(budget, { total: 3 });
    assert.equal(report.ok, true);
    assert.equal(report.fingerprint, BASELINE_FINGERPRINT);
});

check('drift fires on a changed shape, a silent strip pass, or an upstream launch', () => {
    const renamed = driftReport({ ...FALLBACK_TOKEN_BUDGET, reminder_threshold_tokens: undefined, reminder_threshold: 6144 }, { total: 2 });
    assert.equal(renamed.ok, false);
    assert.match(renamed.notes.join(' '), /changed the token_budget fields/);

    const unstripped = driftReport({ ...FALLBACK_TOKEN_BUDGET }, { total: 0 });
    assert.equal(unstripped.ok, false);
    assert.match(unstripped.notes.join(' '), /reworded its concealment/);

    const launched = driftReport({ ...FALLBACK_TOKEN_BUDGET, enabled: true }, { total: 3 });
    assert.equal(launched.ok, false);
    assert.equal(launched.upstreamEnabled, true);
    assert.match(launched.notes.join(' '), /shipped it/);

    const missing = driftReport(null, { total: 0 });
    assert.equal(missing.ok, false);
    assert.match(missing.notes.join(' '), /no token_budget block/);
});

check('the budget is read off the served model', () => {
    const models = { models: [
        { slug: 'gpt-5.5' },
        { slug: 'gpt-5.6-luna', model_messages: { token_budget: { ...FALLBACK_TOKEN_BUDGET, reminder_threshold_tokens: 999 } } },
    ] };
    assert.equal(tokenBudgetFor(models, 'gpt-5.6-luna').reminder_threshold_tokens, 999);
    // A model with no block of its own still gets the shape from a sibling
    // rather than silently losing the guidance.
    assert.equal(tokenBudgetFor(models, 'gpt-5.5').reminder_threshold_tokens, 999);
    assert.equal(tokenBudgetFor({ models: [{ slug: 'x' }] }, 'x'), null);
});

await checkAsync('the models list is cached and a failed refresh keeps the last good payload', async () => {
    let calls = 0;
    let fail = false;
    const payload = { models: [{ slug: 'gpt-5.6-luna', model_messages: { token_budget: FALLBACK_TOKEN_BUDGET } }] };
    const messages = new ModelMessages({
        base: 'https://example.test/codex/', clientVersion: '9.9.9', ttlMs: 50,
        fetchImpl: async (url) => {
            calls++;
            assert.match(url, /models\?client_version=9\.9\.9$/);
            if (fail) return { ok: false, status: 500 };
            return { ok: true, json: async () => payload };
        },
    });
    const tokens = { access_token: 'x', account_id: 'y' };
    assert.equal((await messages.load(tokens, {})).models.length, 1);
    assert.equal((await messages.load(tokens, {})).models.length, 1);
    assert.equal(calls, 1, 'a cached payload should not be refetched');

    await new Promise(resolve => setTimeout(resolve, 60));
    fail = true;
    const stale = await messages.load(tokens, {});
    assert.equal(stale.models.length, 1, 'a failed refresh must keep the last good payload');
    assert.match(messages.lastError, /models 500/);
});

await checkAsync('a first load with no cache surfaces the failure instead of inventing one', async () => {
    const messages = new ModelMessages({ base: 'https://example.test/codex/', clientVersion: '1',
        fetchImpl: async () => ({ ok: false, status: 403 }) });
    await assert.rejects(() => messages.load({ access_token: 'x', account_id: 'y' }, {}), /models 403/);
});

check('ingest metadata carries the exact key set the backend requires', () => {
    const meta = turnMetadata({ installationId: 'inst', sessionId: 'sess', windowId: 'sess:0',
        windowNumber: 0, contextWindowId: 'ctx', agentName: '/root' });

    // Measured: the flat siblings are load-bearing. `client_metadata` carrying
    // only the nested blob ingests nothing.
    assert.deepEqual(Object.keys(meta.clientMetadata).sort(),
        ['root_turn_id', 'session_id', 'thread_id', 'turn_id', 'x-codex-installation-id', 'x-codex-turn-metadata', 'x-codex-window-id']);
    assert.equal(meta.clientMetadata.session_id, 'sess');
    assert.equal(meta.clientMetadata['x-codex-window-id'], 'sess:0');
    assert.equal(meta.clientMetadata.turn_id, meta.clientMetadata.root_turn_id);

    const blob = JSON.parse(meta.clientMetadata['x-codex-turn-metadata']);
    assert.equal(blob.history_ingest_requested, true);
    assert.equal(blob.request_kind, 'turn');
    // The compound form is what the index is keyed by; context_window_id stays
    // the uuid the developer message reports.
    assert.equal(blob.window_id, 'sess:0');
    assert.equal(blob.context_window_id, 'ctx');
    assert.equal(blob.turn_id, meta.clientMetadata.turn_id);

    // Codex projects the same blob onto headers as well.
    assert.equal(meta.headers['x-codex-turn-metadata'], meta.clientMetadata['x-codex-turn-metadata']);
    assert.equal(meta.headers['x-codex-window-id'], 'sess:0');
});

check('the compound window id advances with each reset', () => {
    const store = new WindowStore(path.join(temp, 'compound'));
    const session = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const state = store.ensure(session);
    assert.equal(WindowStore.compoundWindowId(state), `${state.storeId}:0`);
    const rotated = store.rotate(session, [userMessage('go')]);
    assert.equal(WindowStore.compoundWindowId(rotated), `${state.storeId}:1`);
    // The store identity is stable across resets, which is what keeps notes and
    // history attached to the same conversation.
    assert.equal(rotated.storeId, state.storeId);
    assert.equal(rotated.installationId, state.installationId);
});

check('the budget uses the earlier client trigger and leaves Codex fallback room', () => {
    const usable = Math.floor(872000 * 95 / 100);
    assert.equal(usable, 828400);
    const limits = contextBudgetLimits(usable,
        { enabled: true, window: 500000, source: 'session' }, FALLBACK_TOKEN_BUDGET, true);
    assert.equal(CLAUDE_AUTO_COMPACT_RESERVE, 33000);
    assert.deepEqual(limits, {
        modelLimit: 828400,
        baseLimit: 450616,
        forceLimit: 467000,
        fallbackBuffer: 16384,
        autoCompactWindow: 500000,
        autoCompactSource: 'session',
    });
    assert.equal(contextBudgetStatus(444472, limits).remaining, 6144);
    assert.equal(contextBudgetStatus(450616, limits).forceRemaining, 16384);
});

check('the full model window keeps fallback room when client compaction is off', () => {
    const limits = contextBudgetLimits(828400,
        { enabled: false, window: 500000, source: 'session' }, FALLBACK_TOKEN_BUDGET, true);
    assert.equal(limits.baseLimit, 812016);
    assert.equal(limits.forceLimit, 828400);
    assert.equal(limits.fallbackBuffer, 16384);
    const withoutPrompts = contextBudgetLimits(828400,
        { enabled: true, window: 500000, source: 'session' }, FALLBACK_TOKEN_BUDGET, false);
    assert.equal(withoutPrompts.baseLimit, 467000);
    assert.equal(withoutPrompts.forceLimit, 467000);
});

check('the router resolves the same per-session auto-compact policy as the launcher', () => {
    const file = path.join(temp, 'budget-settings.json');
    fs.writeFileSync(file, JSON.stringify({ 'auto-compact': {
        enabled: true,
        defaultWindow: 300000,
        perModel: { 'gpt-5.6-sol': 400000 },
        sessionOverrides: {
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { enabled: true, window: 500000 },
            'ffffffff-1111-2222-3333-444444444444': { enabled: false },
        },
    } }));
    const old = process.env.MODEL_ROUTER_SETTINGS_FILE;
    process.env.MODEL_ROUTER_SETTINGS_FILE = file;
    try
    {
        assert.deepEqual(readAutoCompactBudget('gpt-5.6-sol', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
            { enabled: true, window: 500000, source: 'session' });
        assert.deepEqual(readAutoCompactBudget('claude-gpt-5.6-sol[1m]', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'),
            { enabled: true, window: 400000, source: 'model' });
        assert.deepEqual(readAutoCompactBudget('gpt-5.6-sol', 'ffffffff-1111-2222-3333-444444444444'),
            { enabled: false, window: 400000, source: 'model' });
    }
    finally
    {
        if (old === undefined) delete process.env.MODEL_ROUTER_SETTINGS_FILE;
        else process.env.MODEL_ROUTER_SETTINGS_FILE = old;
    }
});

// ------------------------------------------------- translator behaviour ---

const parseFrames = frames => {
    const events = [];
    const parse = sseParser(event => events.push(event));
    for (const frame of frames) parse(frame);
    return events;
};

check('a model-only call never reaches the client as a tool_use', () => {
    const frames = [];
    const out = new ResponsesToAnthropic('claude-gpt-5.6-luna[1m]', frame => frames.push(frame),
        { suppressCall: isContextCall, deferFinish: true });
    out.handle({ type: 'response.created', response: { usage: { input_tokens: 10, output_tokens: 0 } } });
    out.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'write_file' } });
    out.handle({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a.md",' });
    out.handle({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '"text":"secret"}' });
    out.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'write_file', arguments: '{"path":"a.md","text":"secret"}' } });
    out.handle({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } });

    const events = parseFrames(frames);
    assert.ok(!events.some(event => event.content_block?.type === 'tool_use'), 'a model-only call leaked to the client');
    assert.ok(!frames.join('').includes('secret'), 'model-only arguments leaked to the client');
    assert.ok(!events.some(event => event.type === 'message_stop'), 'the turn ended while a model-only call was outstanding');
    assert.equal(out.closed, false);

    const calls = out.takePendingCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { type: 'function_call', call_id: 'c1', name: 'write_file', namespace: 'notes', arguments: '{"path":"a.md","text":"secret"}' });
    assert.deepEqual(out.takePendingCalls(), []);
});

check('one Anthropic message spans the rounds a model-only call creates', () => {
    const frames = [];
    const out = new ResponsesToAnthropic('claude-gpt-5.6-luna[1m]', frame => frames.push(frame),
        { suppressCall: isContextCall, deferFinish: true });
    out.handle({ type: 'response.created', response: { usage: { input_tokens: 10, output_tokens: 0 } } });
    out.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'read_file' } });
    out.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'read_file', arguments: '{}' } });
    out.handle({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } });

    assert.equal(out.takePendingCalls().length, 1);
    out.nextResponse();

    // Second upstream response reuses output_index 0; the Anthropic block index
    // must not collide with the first round's.
    out.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } });
    out.handle({ type: 'response.output_text.delta', output_index: 0, delta: 'done' });
    out.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'message' } });
    out.handle({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c2', name: 'Read' } });
    out.handle({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file_path":"x"}' });
    out.handle({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c2', name: 'Read' } });
    out.handle({ type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 6 } } });

    const events = parseFrames(frames);
    assert.equal(events.filter(event => event.type === 'message_start').length, 1);
    assert.equal(events.filter(event => event.type === 'message_stop').length, 1);
    assert.ok(!events.some(event => event.type === 'error'));

    const opened = events.filter(event => event.type === 'content_block_start').map(event => event.index);
    const closed = events.filter(event => event.type === 'content_block_stop').map(event => event.index);
    assert.deepEqual(opened, [...new Set(opened)], 'block indices collided across rounds');
    assert.deepEqual(opened, closed);

    const client = events.filter(event => event.content_block?.type === 'tool_use').map(event => event.content_block.name);
    assert.deepEqual(client, ['Read'], 'only the client tool should reach Claude Code');

    const delta = events.findLast(event => event.type === 'message_delta');
    assert.equal(delta.delta.stop_reason, 'tool_use');
    // Claude Code reads this as the current context snapshot. Each upstream
    // response is still recorded separately in the router's accounting ledger.
    assert.equal(delta.usage.input_tokens, 20);
    assert.equal(delta.usage.output_tokens, 6);
});

check('an ordinary turn is unchanged when context management is off', () => {
    const frames = [];
    const out = new ResponsesToAnthropic('claude-gpt-5.6-luna[1m]', frame => frames.push(frame));
    out.handle({ type: 'response.created', response: { usage: { input_tokens: 3, output_tokens: 0 } } });
    out.handle({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'read_file' } });
    out.handle({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', namespace: 'notes', name: 'read_file' } });
    out.handle({ type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } });
    const events = parseFrames(frames);
    // Without the suppressor every call is the client's, including one that
    // happens to be named like a model-only tool.
    assert.ok(events.some(event => event.content_block?.type === 'tool_use'));
    assert.equal(events.at(-1).type, 'message_stop');
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n${passed} context-management checks passed`);
