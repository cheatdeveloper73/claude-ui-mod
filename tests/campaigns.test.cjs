'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const EventEmitter = require('node:events');
const SOURCE = process.env.CUIMOD_CAMPAIGN_SOURCE || path.resolve(__dirname, '../src/plugins/campaigns');
const { Store, TEMPLATES, reference, verify, participant, active } = require(path.join(SOURCE, 'core'));
const { sdkServer } = require(path.join(SOURCE, 'sdk-server'));

function fixture(t, template = 'investigation', policy = {}) {
    const parent = process.env.CUIMOD_TEST_TMP || os.tmpdir();
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'campaign-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const evidence = path.join(cwd, 'evidence.txt'); fs.writeFileSync(evidence, 'fixture source and negative controls\n');
    const store = new Store(path.join(root, '.state/campaigns'));
    const c = store.create({ title: 'Offline fixture', intent: 'Test only the named fixture and verify the negative control.', cwd, template,
        references: [evidence], maxDispatches: 30, ...policy });
    store.control(c.id, 'start');
    const controller = store.reserve(c.id, null, { kind: 'controller', operation_id: 'start' });
    store.markSession(c.id, controller.id, 'running');
    return { store, id: c.id, controller, cwd, root, evidence };
}
function plan(f, tasks, seal = true) {
    return f.store.plan(f.id, f.controller.id, { epoch: f.store.get(f.id).epoch, operation_id: 'plan-' + tasks[0].id, seal,
        tasks: tasks.map(t => ({ title: t.id, brief: 'Read the exact fixture and return source-grounded evidence.', criteria: 'Required property and negative control pass.', ...t })) });
}
function dispatch(f, task, kind = 'work', key) {
    return f.store.reserve(f.id, f.controller.id, { epoch: f.store.get(f.id).epoch, operation_id: key || task + '-' + kind + '-' + f.store.get(f.id).dispatches,
        task_id: task, kind });
}
function submit(f, worker, summary = 'Fixture result; evidence attached.') {
    const result = f.store.submit(f.id, worker.id, { summary, evidence_paths: [f.evidence], native_task_id: '1' });
    f.store.markSession(f.id, worker.id, 'idle');
    return result;
}
function review(f, taskId, actor, decision = 'accept', owner = false) {
    const c = f.store.get(f.id); const task = c.tasks.find(t => t.id === taskId);
    return f.store.review(f.id, actor, { epoch: c.epoch, task_id: taskId, result_id: (task.reviewCandidate || task.latest).id,
        requirements_version: task.requirementsVersion, decision, reason: decision === 'reject' ? 'Negative control fails; correct the specific defect.' : 'Actual fixture evidence and negative controls inspected.' }, owner);
}

test('two different workflow templates use the same evidence/recovery transitions', t => {
    for (const template of ['investigation', 'implementation']) {
        const f = fixture(t, template);
        plan(f, [{ id: 'entry', role: template === 'investigation' ? 'investigator' : 'integrator' }]);
        const worker = dispatch(f, 'entry');
        submit(f, worker);
        const reviewer = dispatch(f, 'entry', 'review');
        review(f, 'entry', reviewer.id, 'reject');
        f.store.markSession(f.id, reviewer.id, 'idle');
        const second = dispatch(f, 'entry');
        submit(f, second, 'Corrected result with passing negative control.');
        const secondReviewer = dispatch(f, 'entry', 'review');
        review(f, 'entry', secondReviewer.id);
        const c = f.store.get(f.id);
        assert.equal(c.mode, 'completed');
        assert.deepEqual(c.tasks[0].reviews.map(r => r.decision), ['reject', 'accept']);
        assert.equal(c.tasks[0].nativeTaskId, '1');
    }
});

test('component approval cannot accept an unreviewed integrated wave', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'code', role: 'worker' }, { id: 'wave', role: 'integrator', depends_on: ['code'] }]);
    assert.throws(() => dispatch(f, 'wave'), /dependencies/);
    submit(f, dispatch(f, 'code'));
    review(f, 'code', f.controller.id);
    assert.equal(f.store.get(f.id).mode, 'active');
    const worker = dispatch(f, 'wave'); submit(f, worker);
    assert.throws(() => review(f, 'wave', f.controller.id), /independent reviewer/);
    const reviewer = dispatch(f, 'wave', 'review'); review(f, 'wave', reviewer.id);
    assert.equal(f.store.get(f.id).mode, 'completed');
});

test('implementation plan cannot seal without integrated-wave acceptance', t => {
    const f = fixture(t, 'implementation');
    assert.throws(() => plan(f, [{ id: 'code', role: 'worker' }]), /integrated wave/);
    assert.equal(f.store.get(f.id).tasks.length, 0);
});

test('unsealed design plan dispatches/reviews existing work before adding more', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'design', role: 'designer' }], false);
    assert.equal(f.store.view(f.id, f.controller.id).next, 'dispatch-ready-work');
    const worker = dispatch(f, 'design');
    assert.equal(f.store.view(f.id, f.controller.id).next, 'checkpoint-and-yield');
    submit(f, worker);
    assert.equal(f.store.view(f.id, f.controller.id).next, 'review-or-dispatch-review');
    review(f, 'design', f.controller.id);
    assert.equal(f.store.view(f.id, f.controller.id).next, 'plan-ready-work');
});

test('disk recovery and duplicate dispatch retain the original attempt identity', t => {
    const f = fixture(t); plan(f, [{ id: 'entry', role: 'investigator' }]);
    const worker = dispatch(f, 'entry', 'work', 'stable-command');
    const recovered = new Store(f.store.root);
    const same = recovered.reserve(f.id, f.controller.id, { epoch: recovered.get(f.id).epoch, operation_id: 'stable-command', task_id: 'entry', kind: 'work' });
    assert.equal(same.id, worker.id);
    assert.equal(recovered.get(f.id).tasks[0].attempts.length, 1);
    assert.equal(recovered.get(f.id).tasks[0].attempts[0].state, 'submission_unknown');
    assert.throws(() => dispatch(f, 'entry'), /already owned/);
    submit(f, worker);
    const previous = recovered.get(f.id).tasks[0].latest;
    assert.equal(recovered.submit(f.id, worker.id, { summary: 'Fixture result; evidence attached.', evidence_paths: [f.evidence] }).id, previous.id);
});

test('operation ids cannot be repurposed', t => {
    const f = fixture(t); plan(f, [{ id: 'entry', role: 'investigator' }]);
    dispatch(f, 'entry', 'work', 'stable-command');
    assert.throws(() => f.store.reserve(f.id, f.controller.id, { epoch: 1, operation_id: 'stable-command', task_id: 'entry', kind: 'review' }), /different inputs/);
});

test('pause preserves late results but blocks dispatch and acceptance', t => {
    const f = fixture(t); plan(f, [{ id: 'entry', role: 'investigator' }]);
    const worker = dispatch(f, 'entry');
    f.store.control(f.id, 'pause');
    submit(f, worker);
    assert.equal(f.store.get(f.id).tasks[0].status, 'submitted');
    assert.throws(() => dispatch(f, 'entry', 'review'), /paused/);
    assert.throws(() => review(f, 'entry', null, 'accept', true), /not active/);
    f.store.control(f.id, 'resume');
    assert.throws(() => f.store.reserve(f.id, f.controller.id, { epoch: 1, operation_id: 'stale', task_id: 'entry', kind: 'review' }), /control changed/);
    const reviewer = dispatch(f, 'entry', 'review'); review(f, 'entry', reviewer.id);
});

test('stop remains terminal and cannot restart through a stale wake', t => {
    const f = fixture(t); f.store.control(f.id, 'stop');
    assert.throws(() => f.store.control(f.id, 'resume'), /only paused/);
    assert.throws(() => f.store.reserve(f.id, null, { kind: 'controller', operation_id: 'other' }), /not active/);
});

test('owner correction preserves chronology and invalidates dependent acceptance', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'code', role: 'worker' }, { id: 'wave', role: 'integrator', depends_on: ['code'] }]);
    submit(f, dispatch(f, 'code')); review(f, 'code', f.controller.id);
    const original = f.store.get(f.id).intent;
    f.store.control(f.id, 'correct', { text: 'Preserve the original method; correct only the required control.', task_ids: ['code'] });
    f.store.control(f.id, 'correct', { text: 'The second correction supplements the first.', task_ids: ['code'] });
    const c = f.store.get(f.id);
    assert.deepEqual(c.intent, original);
    assert.equal(c.corrections.length, 2);
    assert.equal(c.mode, 'active');
    assert.equal(c.tasks[0].accepted, null);
    assert.ok(c.tasks[0].retained);
    assert.equal(c.tasks[1].requirementsVersion, 2);
});

test('changed evidence cannot inherit a previous visual/test verdict', t => {
    const f = fixture(t); plan(f, [{ id: 'entry', role: 'investigator' }]);
    submit(f, dispatch(f, 'entry')); const reviewer = dispatch(f, 'entry', 'review');
    fs.appendFileSync(f.evidence, 'changed bytes\n');
    assert.throws(() => review(f, 'entry', reviewer.id), /referenced bytes changed/);
    assert.equal(f.store.get(f.id).tasks[0].status, 'submitted');
});

test('final acceptance dependencies do not serialize independently ready implementation', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'actor', role: 'worker' },
        { id: 'network', role: 'worker', acceptance_depends_on: ['actor'] },
        { id: 'wave', role: 'integrator', depends_on: ['network'] }]);
    const network = dispatch(f, 'network');
    submit(f, network);
    const before = f.store.view(f.id, f.controller.id);
    const packet = before.tasks.find(task => task.id === 'network');
    assert.deepEqual(packet.dependsOn, []);
    assert.deepEqual(packet.acceptanceDependsOn, ['actor']);
    assert.equal(packet.ready, true);
    assert.equal(packet.acceptanceReady, false);
    assert.equal(before.next, 'dispatch-ready-work');
    assert.throws(() => review(f, 'network', f.controller.id), /acceptance dependencies/);
    assert.equal(f.store.get(f.id).tasks.find(task => task.id === 'network').status, 'submitted');
    submit(f, dispatch(f, 'actor'));
    review(f, 'actor', f.controller.id);
    assert.equal(f.store.view(f.id, f.controller.id).tasks.find(task => task.id === 'network').acceptanceReady, true);
    review(f, 'network', f.controller.id);
    assert.ok(dispatch(f, 'wave'));
});

test('unknown acceptance dependencies and mixed dependency cycles fail atomically', t => {
    const f = fixture(t, 'implementation');
    assert.throws(() => plan(f, [{ id: 'bad', role: 'worker', acceptance_depends_on: ['missing'] }], false), /unknown dependency/);
    assert.throws(() => plan(f, [{ id: 'a', role: 'worker', depends_on: ['b'] },
        { id: 'b', role: 'worker', acceptance_depends_on: ['a'] }], false), /dependency cycle/);
    assert.throws(() => plan(f, [{ id: 'bad', role: 'worker', acceptance_depends_on: 'not-an-array' }], false), /dependencies must be arrays/);
    assert.equal(f.store.get(f.id).tasks.length, 0);
});

test('corrections invalidate final acceptance dependants without changing implementation readiness', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'life', role: 'worker' },
        { id: 'network', role: 'worker', acceptance_depends_on: ['life'] },
        { id: 'wave', role: 'integrator', depends_on: ['network'] }]);
    submit(f, dispatch(f, 'life')); review(f, 'life', f.controller.id);
    submit(f, dispatch(f, 'network')); review(f, 'network', f.controller.id);
    f.store.control(f.id, 'correct', { text: 'Correct the retained life binding.', task_ids: ['life'] });
    const c = new Store(f.store.root).view(f.id, f.controller.id);
    const network = c.tasks.find(task => task.id === 'network');
    assert.equal(network.requirementsVersion, 1);
    assert.equal(network.accepted, null);
    assert.equal(network.ready, true);
    assert.equal(network.acceptanceReady, false);
    assert.equal(c.tasks.find(task => task.id === 'wave').requirementsVersion, 1);
    assert.deepEqual(c.corrections[0].taskIds, ['life', 'network', 'wave']);
});

test('an interrupted package remains visible without hiding independently ready work', t => {
    const f = fixture(t);
    plan(f, [{ id: 'interrupted', role: 'investigator' }, { id: 'ready', role: 'investigator' }]);
    const first = dispatch(f, 'interrupted');
    f.store.markSession(f.id, first.id, 'unavailable', 'Native execution needs reconciliation.');
    const recovered = new Store(f.store.root).view(f.id, f.controller.id);
    assert.equal(recovered.tasks.find(task => task.id === 'interrupted').status, 'interrupted');
    assert.equal(recovered.next, 'dispatch-ready-work');
    assert.ok(dispatch(f, 'ready'));
    assert.throws(() => dispatch(f, 'interrupted'), /already owned or needs reconciliation/);
});

test('a broken candidate can be rejected before dependencies or evidence are repaired', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'upstream', role: 'worker' },
        { id: 'code', role: 'worker', acceptance_depends_on: ['upstream'] }], false);
    submit(f, dispatch(f, 'code'));
    fs.appendFileSync(f.evidence, 'Source changed after the claimed verification.\n');
    assert.throws(() => review(f, 'code', f.controller.id), /acceptance dependencies|referenced bytes changed/);
    review(f, 'code', f.controller.id, 'reject');
    assert.equal(f.store.get(f.id).tasks.find(task => task.id === 'code').status, 'rejected');
    assert.ok(dispatch(f, 'code'));
});

test('legacy packets without acceptance dependencies retain their existing semantics', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'code', role: 'worker' }, { id: 'wave', role: 'integrator', depends_on: ['code'] }]);
    f.store.change(f.id, c => { for (const task of c.tasks) delete task.acceptanceDependsOn; });
    assert.throws(() => dispatch(f, 'wave'), /dependencies/);
    submit(f, dispatch(f, 'code')); review(f, 'code', f.controller.id);
    const restored = new Store(f.store.root).view(f.id, f.controller.id);
    assert.equal(restored.tasks.find(task => task.id === 'wave').acceptanceReady, true);
    assert.ok(dispatch(f, 'wave'));
});

test('budget/capacity checks cannot become request-volume targets', t => {
    const f = fixture(t, 'investigation', { maxDispatches: 2 }); plan(f, [{ id: 'entry', role: 'investigator' }]);
    submit(f, dispatch(f, 'entry'));
    assert.throws(() => dispatch(f, 'entry', 'review'), /budget exhausted/);
    f.store.control(f.id, 'limits', { max_dispatches: 4 });
    assert.ok(dispatch(f, 'entry', 'review'));
});

test('single-session capacity queues one dispatch until the controller yields', t => {
    const f = fixture(t, 'investigation', { maxConcurrent: 1 }); plan(f, [{ id: 'entry', role: 'investigator' }]);
    const worker = dispatch(f, 'entry');
    assert.equal(worker.phase, 'queued');
    assert.equal(f.store.get(f.id).sessions.filter(active).length, 1);
    f.store.markSession(f.id, f.controller.id, 'idle');
    f.store.markSession(f.id, worker.id, 'starting');
    assert.equal(f.store.get(f.id).sessions.filter(active).length, 1);
});

test('retained candidate is independent of the latest rejected output', t => {
    const f = fixture(t); plan(f, [{ id: 'entry', role: 'investigator' }]);
    submit(f, dispatch(f, 'entry'), 'Useful retained candidate.');
    f.store.control(f.id, 'retain', { task_id: 'entry' });
    const retained = f.store.get(f.id).tasks[0].retained;
    const reviewer = dispatch(f, 'entry', 'review'); review(f, 'entry', reviewer.id, 'reject'); f.store.markSession(f.id, reviewer.id, 'idle');
    submit(f, dispatch(f, 'entry'), 'A worse new candidate.');
    const task = f.store.get(f.id).tasks[0];
    assert.equal(task.retained.id, retained.id);
    assert.notEqual(task.latest.id, retained.id);
    verify(retained.report);
});

test('solo workflow is usable without delegation or a reviewer model', t => {
    const f = fixture(t, 'solo');
    assert.equal(f.store.get(f.id).tasks.length, 1);
    assert.throws(() => plan(f, [{ id: 'extra', role: 'investigator' }]), /solo work/);
    submit(f, f.controller);
    assert.throws(() => review(f, 'solo', f.controller.id), /owner review/);
    review(f, 'solo', null, 'accept', true);
    assert.equal(f.store.get(f.id).mode, 'completed');
});

test('SDK server uses the supplied transport and returns tool failures as failures', async () => {
    const sent = [];
    const transport = { async start() {}, async send(value) { sent.push(value); }, async close() {} };
    const server = sdkServer('campaign', [{ name: 'get', description: 'Read state', inputSchema: { type: 'object', properties: {} } }], async () => { throw Error('paused'); });
    await server.instance.connect(transport);
    await transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    await transport.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await transport.onmessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get', arguments: {} } });
    assert.equal(sent[0].result.protocolVersion, '2025-03-26');
    assert.equal(sent[1].result.tools[0]._meta['anthropic/alwaysLoad'], true);
    assert.equal(sent[2].result.isError, true);
    assert.equal(sent[2].result.content[0].text, 'paused');
    await server.instance.close();
});

test('live adapter scopes guards and MCP tools only to campaign-owned native sessions', async t => {
    const f = fixture(t);
    const globalKey = Symbol.for('cuimod.campaigns'); delete globalThis[globalKey];
    class Manager extends EventEmitter {
        constructor() { super(); this.sessions = new Map(); this.stops = []; }
        async buildStartSdkOptions() { return { sdkOptions: { hooks: { PreToolUse: [] }, mcpServers: {} }, allMcpServers: {} }; }
        async stopSession(sid) { this.stops.push(sid); }
        async interruptSession(sid) { this.stops.push(sid); }
        isCliProvablyIdle(session) { return !session.isRunning; }
    }
    const manager = new Manager();
    const cached = path.join(f.root, 'manager-fixture.js');
    require.cache[cached] = { id: cached, filename: cached, loaded: true, exports: { claudeCodeSessionManager: manager } };
    const contexts = [];
    const makeContext = () => {
        const methods = new Map(), disposers = [], ticks = [];
        const ctx = { boot: { MOD_DIR: f.root }, electron: {}, dir: SOURCE, log() {}, broadcast() {},
            method(name, handler) { methods.set(name, handler); }, every(_ms, fn) { ticks.push(fn); }, onDispose(fn) { disposers.push(fn); },
            methods, ticks, dispose() { disposers.reverse().forEach(fn => fn()); } };
        contexts.push(ctx); return ctx;
    };
    const factory = require(path.join(SOURCE, 'main'));
    const first = makeContext(); factory(first);
    const second = makeContext(); factory(second); first.dispose();
    try {
        const untouched = await manager.buildStartSdkOptions({ sessionId: 'local_unrelated' });
        assert.deepEqual(untouched.sdkOptions.mcpServers, {});
        const options = await manager.buildStartSdkOptions({ sessionId: f.controller.id });
        assert.ok(options.sdkOptions.mcpServers.campaign);
        const replies = [];
        const transport = { async start() {}, async send(reply) { replies.push(reply); }, async close() {} };
        const server = options.sdkOptions.mcpServers.campaign.instance;
        await server.connect(transport);
        t.after(() => server.close());
        const guard = options.sdkOptions.hooks.PreToolUse.at(-1).hooks[0];
        let answer = guard({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f.evidence } });
        assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
        await transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get', arguments: {} } });
        assert.notEqual(replies.at(-1).result.isError, true);
        const initial = JSON.parse(replies.at(-1).result.content[0].text);
        assert.equal(initial.intentText, fs.readFileSync(f.store.get(f.id).intent.path, 'utf8'));
        f.store.control(f.id, 'correct', { text: 'This is a local correction, not a permanent ban.' });
        await transport.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get', arguments: {} } });
        const corrected = JSON.parse(replies.at(-1).result.content[0].text);
        assert.equal(corrected.intentText, initial.intentText);
        assert.equal(corrected.corrections[0].text, 'This is a local correction, not a permanent ban.\n');
        assert.equal(corrected.actor.seenEpoch, corrected.epoch);
        answer = guard({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f.evidence } });
        assert.deepEqual(answer, {});
        for (const tool of ['Agent', 'Workflow', 'Bash', 'CronCreate', 'Write']) {
            answer = guard({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: f.evidence } });
            assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny', tool);
        }
        await manager.stopSession(f.controller.id, 'user');
        assert.equal(f.store.get(f.id).mode, 'paused');
        assert.deepEqual(manager.stops, [f.controller.id]);
        assert.equal(manager.listenerCount('event'), 1);
    } finally {
        second.dispose(); delete require.cache[cached]; delete globalThis[globalKey];
    }
    assert.equal(manager.listenerCount('event'), 0);
});

// App 2.9939.4 moved isCliProvablyIdle off the manager into a module-local
// function; hasAgentRunInProgress(sessionId) is the surviving public wrapper.
test('attach waits on a manager without isCliProvablyIdle instead of throwing', async t => {
    const f = fixture(t);
    const globalKey = Symbol.for('cuimod.campaigns'); delete globalThis[globalKey];
    const SID = 'local_11111111-2222-3333-4444-555555555555';
    const session = { sessionId: SID, query: {}, cliSessionId: 'cli', cliLastTurnMessageWasResult: true, busy: true };
    const manager = Object.assign(new EventEmitter(), { sessions: new Map([[SID, session]]),
        async buildStartSdkOptions() { return { sdkOptions: { hooks: {}, mcpServers: {} }, allMcpServers: {} }; },
        hasAgentRunInProgress(sid) { return this.sessions.get(sid).busy; } });
    const cached = path.join(f.root, 'manager-fixture-idle.js');
    require.cache[cached] = { id: cached, filename: cached, loaded: true, exports: { claudeCodeSessionManager: manager } };
    const methods = new Map(), disposers = [];
    require(path.join(SOURCE, 'main'))({ boot: { MOD_DIR: f.root }, electron: {}, dir: SOURCE, log() {}, broadcast() {},
        method(name, handler) { methods.set(name, handler); }, every() {}, onDispose(fn) { disposers.push(fn); } });
    try {
        const c = methods.get('create')({ title: 'Idle fixture', intent: 'Exercise only the idle gate.', cwd: f.cwd,
            template: 'implementation', workspaces: [], references: [] });
        assert.equal((await methods.get('attach')({ id: c.id, sessionId: SID })).pending, true, 'busy turn');
        session.busy = false; session.cliLastTurnMessageWasResult = false;
        assert.equal((await methods.get('attach')({ id: c.id, sessionId: SID })).pending, true, 'no turn result yet');
    } finally {
        disposers.reverse().forEach(fn => fn()); delete require.cache[cached]; delete globalThis[globalKey];
    }
});

// Evidence files come from workers that may have been prompt-injected. A click
// on one must never execute it.
test('evidence opens only inert file types; executables are revealed instead', () => {
    const { opensDirectly } = require('../src/plugins/campaigns/main');
    for (const file of ['C:/w/run.bat', 'C:/w/x.cmd', 'C:/w/x.exe', 'C:/w/x.lnk', 'C:/w/x.ps1', 'C:/w/x.js', 'C:/w/x.html', 'C:/w/noext'])
        assert.equal(opensDirectly(file), false, file);
    for (const file of ['C:/w/out.log', 'C:/w/shot.PNG', 'C:/w/report.md', 'C:/w/data.jsonl'])
        assert.equal(opensDirectly(file), true, file);
});
