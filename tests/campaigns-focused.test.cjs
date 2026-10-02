'use strict';
// Staged focused tests for the new core surface: final-acceptance dependencies,
// overlapping source-root write ownership, and legacy-packet compatibility.
// Runs against the staged core only; it drives no app, session or child process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const SOURCE = path.resolve(__dirname, '../src/plugins/campaigns');
const { Store } = require(path.join(SOURCE, 'core'));

function fixture(t, template = 'implementation', policy = {}) {
    const parent = os.tmpdir();
    const root = fs.mkdtempSync(path.join(parent, 'campaign-focus-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const nested = path.join(cwd, 'server'); fs.mkdirSync(nested);
    const sibling = path.join(root, 'sibling'); fs.mkdirSync(sibling);
    const evidence = path.join(cwd, 'evidence.txt'); fs.writeFileSync(evidence, 'focused fixture\n');
    const store = new Store(path.join(root, '.state/campaigns'));
    const c = store.create({ title: 'Focused', intent: 'Exercise the named gate only.', cwd, template,
        workspaces: [nested, sibling], references: [evidence], maxDispatches: 30, ...policy });
    store.control(c.id, 'start');
    const controller = store.reserve(c.id, null, { kind: 'controller', operation_id: 'start' });
    store.markSession(c.id, controller.id, 'running');
    return { store, id: c.id, controller, cwd, nested, sibling, root, evidence };
}
function plan(f, tasks, seal = true) {
    return f.store.plan(f.id, f.controller.id, { epoch: f.store.get(f.id).epoch, operation_id: 'plan-' + tasks[0].id, seal,
        tasks: tasks.map(t => ({ title: t.id, brief: 'Read the exact fixture and return source-grounded evidence.',
            criteria: 'Required property and negative control pass.', ...t })) });
}
function dispatch(f, task, kind = 'work', key) {
    return f.store.reserve(f.id, f.controller.id, { epoch: f.store.get(f.id).epoch,
        operation_id: key || task + '-' + kind + '-' + f.store.get(f.id).dispatches, task_id: task, kind });
}
function submit(f, worker, summary = 'Fixture result; evidence attached.') {
    const result = f.store.submit(f.id, worker.id, { summary, evidence_paths: [f.evidence], native_task_id: '1' });
    f.store.markSession(f.id, worker.id, 'idle');
    return result;
}
function review(f, taskId, actor, decision = 'accept', owner = false) {
    const c = f.store.get(f.id); const task = c.tasks.find(t => t.id === taskId);
    return f.store.review(f.id, actor, { epoch: c.epoch, task_id: taskId, result_id: (task.reviewCandidate || task.latest).id,
        requirements_version: task.requirementsVersion, decision, reason: decision === 'reject' ? 'Negative control fails; correct the specific defect.' : 'Fixture evidence and controls inspected.' }, owner);
}

test('a nested source root is the same tree: concurrent nested write is denied', t => {
    const f = fixture(t, 'implementation', { allowWrites: true });
    plan(f, [{ id: 'client', role: 'worker' }, { id: 'native', role: 'worker', cwd: f.nested }], false);
    dispatch(f, 'client');
    assert.throws(() => dispatch(f, 'native'), /overlapping/);
});

test('a queued reserved writer still owns its workspace against a duplicate', t => {
    const f = fixture(t, 'implementation', { allowWrites: true, maxConcurrent: 1 });
    plan(f, [{ id: 'one', role: 'worker' }, { id: 'other', role: 'worker' }], false);
    const queued = dispatch(f, 'one');
    assert.equal(queued.phase, 'queued');
    // Free the controller's slot so the next dispatch is not capacity-blocked;
    // the queued writer must still be the thing that refuses a second writer in
    // the same source root.
    f.store.markSession(f.id, f.controller.id, 'idle');
    assert.throws(() => dispatch(f, 'other'), /overlapping/);
    assert.equal(f.store.get(f.id).sessions.filter(s => s.phase === 'queued').length, 1);
});

test('acceptance gate blocks accept but still allows rejecting a broken candidate', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'upstream', role: 'worker' },
        { id: 'code', role: 'worker', acceptance_depends_on: ['upstream'] }], false);
    submit(f, dispatch(f, 'code'));
    const c = f.store.get(f.id); const task = c.tasks.find(t => t.id === 'code');
    assert.throws(() => f.store.review(f.id, f.controller.id, { epoch: c.epoch, task_id: 'code', result_id: task.latest.id,
        requirements_version: task.requirementsVersion, decision: 'accept', reason: 'attempted premature acceptance' }), /acceptance dependencies/);
    assert.equal(f.store.get(f.id).tasks.find(t => t.id === 'code').status, 'submitted');
    review(f, 'code', f.controller.id, 'reject');
    assert.equal(f.store.get(f.id).tasks.find(t => t.id === 'code').status, 'rejected');
});

test('acceptance dependency is exposed in the task view alongside implementation readiness', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'a', role: 'worker' }, { id: 'b', role: 'worker', acceptance_depends_on: ['a'] }], false);
    const packet = f.store.view(f.id, f.controller.id).tasks.find(x => x.id === 'b');
    assert.deepEqual(packet.acceptanceDependsOn, ['a']);
    assert.equal(packet.acceptanceReady, false);
    assert.equal(packet.ready, true);
});

test('legacy packet without acceptance field reports acceptanceReady without the key', t => {
    const f = fixture(t, 'implementation');
    plan(f, [{ id: 'code', role: 'worker' }, { id: 'wave', role: 'integrator', depends_on: ['code'] }]);
    f.store.change(f.id, c => { for (const task of c.tasks) delete task.acceptanceDependsOn; });
    const packet = f.store.view(f.id, f.controller.id).tasks.find(x => x.id === 'wave');
    assert.equal('acceptanceDependsOn' in packet, false);
    assert.equal(packet.acceptanceReady, true);
});
