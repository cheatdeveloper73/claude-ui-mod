'use strict';
// Staged tests for the real check-runner subprocess and the NativeStore check
// lifecycle. These spawn a real `node` child running check-runner.js against a
// throwaway request directory; no model, no app, no probe, no native agent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '../src/plugins/campaigns');
const { NativeStore } = require(path.join(SOURCE, 'native-core'));
const RUNNER = path.join(SOURCE, 'check-runner.js');

function ready(t, policy = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const project = path.join(base, 'project'); fs.mkdirSync(project);
    const store = new NativeStore(path.join(base, 'state'));
    const c = store.createNative({ title: 'Check fixture', intent: 'Exercise the named check only.', cwd: project,
        template: 'implementation', profiles: { worker: 'fixture-worker', reviewer: 'fixture-reviewer' },
        allowWrites: true, allowShell: true, ...policy });
    store.attach(c.id, 'desktop-root-fixture', 'cli-root-fixture');
    store.planNative(c.id, 'root', { epoch: store.get(c.id).epoch, operation_id: 'plan', seal: false,
        tasks: [{ id: 'pkg', title: 'Package', brief: 'Fixture brief.', criteria: 'Check passes.',
            role: 'worker', write_roots: [project], required_checks: ['test'] }] });
    const claim = store.claimNative(c.id, 'root', { epoch: store.get(c.id).epoch, operation_id: 'claim', task_id: 'pkg' });
    store.bindAgent(c.id, claim.claimId, 'agent-fixture-w');
    const evidence = path.join(project, 'evidence.txt'); fs.writeFileSync(evidence, 'candidate output\n');
    store.submitNative(c.id, claim.claimId, { summary: 'Candidate.', evidence_paths: [evidence], unrun: [] });
    store.finishAgent(c.id, 'agent-fixture-w', 'finished');
    const checkpoint = store.get(c.id).tasks.find(task => task.id === 'pkg').latest;
    return { base, project, store, id: c.id, checkpoint };
}
// Prepare a check, observe its native start, run the real runner, then verify.
function execute(f, { markers = ['CHECK_OK'], script = "console.log('CHECK_OK')", operation = 'pc' } = {}) {
    const epoch = f.store.get(f.id).epoch;
    const prepared = f.store.prepareCheck(f.id, 'root', { epoch, operation_id: operation, checkpoint_id: f.checkpoint,
        kind: 'test', production_path: 'node -e fixture', success_markers: markers,
        executable: process.execPath, args: ['-e', script] }, RUNNER);
    f.store.observeCheckStart(f.id, 'root', { tool_name: 'Bash', tool_input: { command: prepared.input.command },
        tool_use_id: 'toolu_' + operation, cwd: f.project });
    const request = f.store.get(f.id).checkRequests[prepared.checkId].request.path;
    const run = spawnSync(process.execPath, [RUNNER, request], { encoding: 'utf8' });
    return { prepared, request, run, check: () => f.store.verifyCheck(f.id, 'root', prepared.checkId) };
}
function result(f, prepared) {
    return JSON.parse(fs.readFileSync(path.join(f.store.get(f.id).checkRequests[prepared.checkId].directory, 'result.json'), 'utf8'));
}

test('a passing check publishes a terminal result and verifies as passed', t => {
    const f = ready(t);
    const { prepared, run, check } = execute(f);
    assert.equal(run.status, 0, 'runner exits 0 on a passing check');
    const published = result(f, prepared);
    assert.equal(published.terminal, true);
    assert.equal(published.exitCode, 0);
    assert.equal(published.status, 'passed');
    assert.deepEqual(published.missingMarkers, []);
    assert.equal(check().status, 'passed');
});

test('a non-zero exit with its marker present is a failed check', t => {
    const f = ready(t);
    const { run, check } = execute(f, { script: "console.log('CHECK_OK'); process.exit(7)" });
    assert.notEqual(run.status, 0);
    const c = check();
    assert.equal(c.status, 'failed');
    assert.equal(c.receipt.exitCode, 7);
});

test('exit 0 without the completion marker stays incomplete', t => {
    const f = ready(t);
    const { prepared, check } = execute(f, { markers: ['NEVER_PRINTED'], script: "console.log('finished, no marker')" });
    assert.deepEqual(result(f, prepared).missingMarkers, ['NEVER_PRINTED']);
    const c = check();
    assert.equal(c.status, 'incomplete');
    assert.equal(c.receipt.success, false);
});

test('the exact repeated arguments are preserved in the request and result', t => {
    const f = ready(t);
    const args = ['-e', "console.log('CHECK_OK')", '--flag', 'a b', 'x=1'];
    const epoch = f.store.get(f.id).epoch;
    const prepared = f.store.prepareCheck(f.id, 'root', { epoch, operation_id: 'args', checkpoint_id: f.checkpoint,
        kind: 'test', production_path: 'node', success_markers: ['CHECK_OK'], executable: process.execPath, args }, RUNNER);
    const request = JSON.parse(fs.readFileSync(f.store.get(f.id).checkRequests[prepared.checkId].request.path, 'utf8'));
    assert.deepEqual(request.args, args);
    f.store.observeCheckStart(f.id, 'root', { tool_name: 'Bash', tool_input: { command: prepared.input.command },
        tool_use_id: 'toolu_args', cwd: f.project });
    spawnSync(process.execPath, [RUNNER, f.store.get(f.id).checkRequests[prepared.checkId].request.path], { encoding: 'utf8' });
    assert.deepEqual(result(f, prepared).args, args);
});

test('a source change before verification rejects the check', t => {
    const f = ready(t);
    const epoch = f.store.get(f.id).epoch;
    const prepared = f.store.prepareCheck(f.id, 'root', { epoch, operation_id: 'stale', checkpoint_id: f.checkpoint,
        kind: 'test', production_path: 'node', success_markers: ['CHECK_OK'], executable: process.execPath, args: ['-e', "console.log('CHECK_OK')"] }, RUNNER);
    f.store.observeCheckStart(f.id, 'root', { tool_name: 'Bash', tool_input: { command: prepared.input.command },
        tool_use_id: 'toolu_stale', cwd: f.project });
    spawnSync(process.execPath, [RUNNER, f.store.get(f.id).checkRequests[prepared.checkId].request.path], { encoding: 'utf8' });
    fs.writeFileSync(path.join(f.project, 'moved.txt'), 'source changed\n');
    assert.throws(() => f.store.verifyCheck(f.id, 'root', prepared.checkId), /source revision changed/);
});

test('verification without an observed native invocation is rejected', t => {
    const f = ready(t);
    const epoch = f.store.get(f.id).epoch;
    const prepared = f.store.prepareCheck(f.id, 'root', { epoch, operation_id: 'unobserved', checkpoint_id: f.checkpoint,
        kind: 'test', production_path: 'node', success_markers: ['CHECK_OK'], executable: process.execPath, args: ['-e', "console.log('CHECK_OK')"] }, RUNNER);
    assert.throws(() => f.store.verifyCheck(f.id, 'root', prepared.checkId), /no observed native invocation/);
});

test('recordCheck needs receipt.success true to pass and never trusts exit 0 alone', t => {
    const f = ready(t);
    const evidence = path.join(f.project, 'evidence.txt');
    const base = { observed: true, toolUseId: 'toolu_direct', sourceRevision: f.store.get(f.id).checkpoints[f.checkpoint].source.id };
    const input = { task_id: 'pkg', checkpoint_id: f.checkpoint, kind: 'test', production_path: 'node', evidence_paths: [evidence] };
    assert.equal(f.store.recordCheck(f.id, 'root', { ...input }, { ...base, terminal: true, exitCode: 0 }).status, 'incomplete',
        'exit 0 without receipt.success is not a pass');
    assert.equal(f.store.recordCheck(f.id, 'root', { ...input }, { ...base, terminal: true, exitCode: 0, success: true }).status, 'passed');
});

test('the last check for a required kind gates acceptance, not an older pass', t => {
    const f = ready(t);
    const first = execute(f, { operation: 'first', script: "console.log('CHECK_OK')" });
    const second = execute(f, { operation: 'second', script: 'process.exit(3)' });
    assert.equal(first.check().status, 'passed');
    assert.equal(second.check().status, 'failed');
    const review = f.store.claimNative(f.id, 'root', { epoch: f.store.get(f.id).epoch, operation_id: 'review', task_id: 'pkg', kind: 'review' });
    f.store.bindAgent(f.id, review.claimId, 'agent-fixture-r');
    assert.throws(() => f.store.reviewNative(f.id, review.claimId, { epoch: f.store.get(f.id).epoch, task_id: 'pkg',
        checkpoint_id: f.checkpoint, decision: 'accept', reason: 'Accept.' }), /missing passed test verification/);
});
