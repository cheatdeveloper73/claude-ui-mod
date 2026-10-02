'use strict';
// Staged unit tests for the native-agent campaign core (NativeStore) and the
// source-revision capture it binds candidates to. Unit-level only: no app, no
// live native session, no probe, no paid model. Fixtures use fake profile names
// and real git commands against throwaway repositories under this scratch tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '../src/plugins/campaigns');
const { NativeStore } = require(path.join(SOURCE, 'native-core'));
const { captureRevision, verifyRevision } = require(path.join(SOURCE, 'revision'));

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function repo(t) {
    const dir = tmp('nrepo-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
            GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    run('init', '-q');
    const write = (name, body) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
    const commit = message => { run('add', '-A'); run('commit', '-q', '-m', message); };
    return { dir, run, write, commit };
}

function native(t, options = {}) {
    const project = tmp('nproj-');
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const state = tmp('nstate-');
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const store = new NativeStore(state);
    const profiles = { worker: 'fixture-worker', reviewer: 'fixture-reviewer', integrator: 'fixture-integrator',
        designer: 'fixture-designer', investigator: 'fixture-investigator', coordinator: 'fixture-coordinator' };
    const c = store.createNative({ title: 'Native fixture', intent: 'Exercise only the named gate.', cwd: project,
        template: options.template || 'implementation', workspaces: options.workspaces || [], references: options.references || [],
        profiles: options.profiles || profiles, allowWrites: options.allowWrites === true,
        allowShell: options.allowShell === true,
        maxConcurrent: options.maxConcurrent, maxAttempts: options.maxAttempts });
    store.attach(c.id, 'desktop-root-fixture', 'cli-root-fixture');
    return { store, id: c.id, project, state };
}
const plan = (f, tasks, seal = true, identity = 'root') => f.store.planNative(f.id, identity,
    { epoch: f.store.get(f.id).epoch, operation_id: 'plan-' + tasks[0].id, seal,
        tasks: tasks.map(t => ({ title: t.id, brief: 'Fixture brief for ' + t.id + '.',
            criteria: 'Required property and negative control pass.', ...t })) });
const claim = (f, taskId, kind = 'work', identity = 'root', key) => f.store.claimNative(f.id, identity,
    { epoch: f.store.get(f.id).epoch, operation_id: key || taskId + '-' + kind + '-' + f.store.get(f.id).claims.length, task_id: taskId, kind });
const packet = (f, id) => f.store.get(f.id).tasks.find(t => t.id === id);

test('captureRevision binds a real git working tree and detects change', t => {
    const r = repo(t);
    r.write('src/a.txt', 'one\n');
    r.commit('init');
    const first = captureRevision([r.dir], []);
    assert.equal(first.roots[0].kind, 'git');
    assert.ok(first.roots[0].head, 'a git root records its HEAD');
    assert.equal(captureRevision([r.dir], []).id, first.id, 'an unchanged tree is deterministic');
    r.write('src/a.txt', 'two\n');
    const changed = captureRevision([r.dir], []);
    assert.notEqual(changed.id, first.id, 'a working-tree edit moves the revision id');
    assert.throws(() => verifyRevision(first), /source revision changed/);
    verifyRevision(changed);
});

test('captureRevision walks a non-git root as a file tree', t => {
    const dir = tmp('nplain-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    const rev = captureRevision([dir], []);
    assert.equal(rev.roots[0].kind, 'directory');
    assert.equal(rev.roots[0].files.length, 1);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'y\n');
    assert.notEqual(captureRevision([dir], []).id, rev.id);
});

test('captureRevision includes input fingerprints in the identity', t => {
    const dir = tmp('nplain-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, 'input.txt');
    fs.writeFileSync(input, 'seed\n');
    const first = captureRevision([dir], [input]);
    fs.writeFileSync(input, 'seed changed\n');
    assert.notEqual(captureRevision([dir], [input]).id, first.id);
});

test('an unborn git root captures and moves as files and commits land', t => {
    const dir = tmp('nempty-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
            GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    });
    run('init', '-q');
    // No commit yet: HEAD is unborn, so headRef returns null and the cached /
    // working / untracked state still carries the identity.
    const unborn = captureRevision([dir], []);
    assert.equal(unborn.roots[0].kind, 'git');
    assert.equal(unborn.roots[0].head, null, 'an unborn root records a null HEAD');
    verifyRevision(unborn);
    const staged = path.join(dir, 'a.txt');
    fs.writeFileSync(staged, 'staged\n');
    run('add', 'a.txt');
    const afterStage = captureRevision([dir], []);
    assert.notEqual(afterStage.id, unborn.id, 'a staged file moves the revision id');
    const untracked = path.join(dir, 'b.txt');
    fs.writeFileSync(untracked, 'loose\n');
    const afterUntracked = captureRevision([dir], []);
    assert.notEqual(afterUntracked.id, afterStage.id, 'an unstaged file moves the revision id');
    run('add', '-A'); run('commit', '-q', '-m', 'first');
    const committed = captureRevision([dir], []);
    assert.ok(committed.roots[0].head, 'the first commit records a real HEAD');
    assert.notEqual(committed.id, afterUntracked.id, 'the first commit moves the revision id');
    assert.throws(() => verifyRevision(unborn), /source revision changed/);
    verifyRevision(committed);
});

test('attach binds the root once and refuses a different root', t => {
    const f = native(t);
    const c = f.store.get(f.id);
    assert.equal(c.mode, 'active');
    assert.equal(c.root.desktopSessionId, 'desktop-root-fixture');
    assert.throws(() => f.store.attach(f.id, 'a-different-root'), /another root/);
});

test('a schema-1 campaign is preserved read-only', t => {
    const f = native(t);
    const legacy = '0123456789abcdef';
    const dir = path.join(f.state, legacy);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ schema: 1, id: legacy, mode: 'paused', tasks: [] }));
    assert.throws(() => f.store.native(legacy), /legacy campaign is preserved read-only/);
});

test('only the root or the owning coordinator may plan or claim', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const worker = claim(f, 'pkg');
    assert.throws(() => f.store.planNative(f.id, worker.claimId, { epoch: f.store.get(f.id).epoch, operation_id: 'x',
        tasks: [{ id: 'z', title: 'z', brief: 'b', criteria: 'c', role: 'worker' }] }), /only an assigned coordinator/);
    assert.throws(() => f.store.claimNative(f.id, worker.claimId, { epoch: f.store.get(f.id).epoch, operation_id: 'x2', task_id: 'pkg' }),
        /only an assigned coordinator/);
});

test('a native launch matches the short marker and returns the canonical prompt', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    assert.equal(reserved.input.subagent_type, 'fixture-worker');
    // The model receives only a short marker, never the authority-bearing brief.
    assert.ok(reserved.input.prompt.includes(reserved.claimId), 'the marker names its claim');
    assert.ok(!reserved.input.prompt.includes('Owner objective:'), 'the marker carries no full instructions');
    assert.throws(() => f.store.authorizeSpawn(f.id, 'root', { name: 'unreserved-name', subagent_type: reserved.input.subagent_type, prompt: reserved.input.prompt }, 'toolu_other'),
        /no reserved campaign assignment/);
    assert.throws(() => f.store.authorizeSpawn(f.id, 'root', { name: reserved.input.name, subagent_type: reserved.input.subagent_type, model: 'opus', prompt: reserved.input.prompt }, 'toolu_model'),
        /changed its approved profile/);
    assert.throws(() => f.store.authorizeSpawn(f.id, 'root', { name: reserved.input.name, subagent_type: 'a-different-profile', prompt: reserved.input.prompt }, 'toolu_profile'),
        /changed its approved profile/);
    // A paraphrased or forged prompt is not the reserved marker.
    assert.throws(() => f.store.authorizeSpawn(f.id, 'root', { name: reserved.input.name, subagent_type: reserved.input.subagent_type,
        prompt: 'Forged prompt restating full authority.' }, 'toolu_forged'), /differs from the original assignment/);
    const spawned = f.store.authorizeSpawn(f.id, 'root', { name: reserved.input.name, subagent_type: reserved.input.subagent_type,
        prompt: reserved.input.prompt }, 'toolu_fixture');
    // The canonical prompt is the real child input, injected by the hook.
    assert.ok(spawned.prompt.includes('Owner objective:'), 'authorizeSpawn returns the full canonical brief');
    assert.ok(spawned.prompt.includes('Exercise only the named gate.'), 'the canonical prompt carries the exact owner intent');
    assert.equal(f.store.get(f.id).claims.find(x => x.id === reserved.claimId).phase, 'starting');
});

test('a native receipt binds one agent to one claim', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const c = claim(f, 'pkg');
    f.store.bindAgent(f.id, c.claimId, 'agent-fixture-1');
    assert.equal(f.store.get(f.id).claims.find(x => x.id === c.claimId).phase, 'running');
    assert.throws(() => f.store.bindAgent(f.id, c.claimId, 'agent-fixture-2'), /another agent/);
});

test('acceptance-only dependencies gate acceptance, not work', t => {
    const f = native(t, { allowWrites: true });
    plan(f, [{ id: 'actor', role: 'worker', write_roots: [f.project] },
        { id: 'network', role: 'worker', write_roots: [f.project], acceptance_depends_on: ['actor'] }], false);
    const n = claim(f, 'network');
    assert.ok(n.claimId, 'a package with an open acceptance dependency can still be worked');
    const view = f.store.viewNative(f.id, 'root');
    const p = view.tasks.find(x => x.id === 'network');
    assert.equal(p.ready, true);
    assert.equal(p.acceptanceReady, false);
});

test('two active writers cannot own overlapping source roots', t => {
    const f = native(t, { allowWrites: true, maxConcurrent: 3 });
    const nested = path.join(f.project, 'server');
    fs.mkdirSync(nested);
    plan(f, [{ id: 'a', role: 'worker', write_roots: [f.project] },
        { id: 'b', role: 'worker', write_roots: [nested] }], false);
    claim(f, 'a');
    assert.throws(() => claim(f, 'b'), /overlapping source root/);
});

test('an interrupted assignment resumes the same claim and attempt', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const c = claim(f, 'pkg');
    f.store.bindAgent(f.id, c.claimId, 'agent-fixture-1');
    f.store.finishAgent(f.id, 'agent-fixture-1', 'failed', 'native session dropped');
    assert.equal(packet(f, 'pkg').status, 'interrupted');
    const resumed = f.store.resumeNative(f.id, 'root', { epoch: f.store.get(f.id).epoch, operation_id: 'r1', claim_id: c.claimId });
    assert.equal(resumed.action, 'SendMessage');
    assert.equal(resumed.input.to, 'agent-fixture-1');
    assert.equal(packet(f, 'pkg').status, 'running');
    assert.deepEqual(packet(f, 'pkg').attempts, [c.claimId], 'resume keeps the same attempt identity');
    assert.equal(f.store.get(f.id).claims.find(x => x.id === c.claimId).phase, 'resuming');
});

test('a stopped worker leaves the package interrupted, never accepted', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const c = claim(f, 'pkg');
    f.store.bindAgent(f.id, c.claimId, 'agent-fixture-1');
    f.store.finishAgent(f.id, 'agent-fixture-1', 'finished');
    const p = packet(f, 'pkg');
    assert.equal(p.status, 'interrupted');
    assert.equal(p.accepted, null);
});

test('a checkpoint records the next action without accepting the package', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const c = claim(f, 'pkg');
    f.store.bindAgent(f.id, c.claimId, 'agent-fixture-1');
    const result = f.store.checkpointNative(f.id, c.claimId, { note: 'Resume after the fixture job.', jobs: [{ id: 'job-1' }] });
    assert.equal(result.packageAccepted, false);
    assert.equal(packet(f, 'pkg').nextAction, 'Resume after the fixture job.');
    assert.equal(packet(f, 'pkg').status, 'running');
});

test('a rejection authorizes a new writer claim for the same package', t => {
    const r = repo(t);
    r.write('a.txt', 'one\n');
    r.commit('init');
    const f = native(t, { workspaces: [r.dir], allowWrites: true });
    plan(f, [{ id: 'pkg', role: 'worker', source_roots: [r.dir], write_roots: [r.dir] }], false);
    const first = claim(f, 'pkg');
    f.store.bindAgent(f.id, first.claimId, 'agent-fixture-1');
    const evidence = path.join(f.project, 'e.txt');
    fs.writeFileSync(evidence, 'out\n');
    f.store.submitNative(f.id, first.claimId, { summary: 'candidate', evidence_paths: [evidence], unrun: [] });
    f.store.finishAgent(f.id, 'agent-fixture-1', 'finished');
    const reviewer = claim(f, 'pkg', 'review');
    f.store.bindAgent(f.id, reviewer.claimId, 'agent-fixture-r');
    f.store.reviewNative(f.id, reviewer.claimId, { epoch: f.store.get(f.id).epoch, task_id: 'pkg',
        checkpoint_id: packet(f, 'pkg').latest, decision: 'reject', reason: 'Negative control fails; repair the defect.' });
    f.store.finishAgent(f.id, 'agent-fixture-r', 'finished');
    assert.equal(packet(f, 'pkg').status, 'rejected');
    const second = claim(f, 'pkg');
    assert.notEqual(second.claimId, first.claimId);
    assert.equal(packet(f, 'pkg').attempts.length, 2);
});

test('a candidate is bound to its source revision and evidence bytes', t => {
    const r = repo(t);
    r.write('src/a.txt', 'one\n');
    r.commit('init');
    const f = native(t, { workspaces: [r.dir], allowWrites: true });
    plan(f, [{ id: 'pkg', role: 'worker', source_roots: [r.dir], write_roots: [r.dir] }], false);
    const c = claim(f, 'pkg');
    f.store.bindAgent(f.id, c.claimId, 'agent-fixture-1');
    const evidence = path.join(f.project, 'e.txt');
    fs.writeFileSync(evidence, 'out\n');
    f.store.submitNative(f.id, c.claimId, { summary: 'candidate', evidence_paths: [evidence], unrun: [] });
    f.store.finishAgent(f.id, 'agent-fixture-1', 'finished');
    const review = () => f.store.reviewNative(f.id, null, { task_id: 'pkg', checkpoint_id: packet(f, 'pkg').latest,
        decision: 'accept', reason: 'Fixture evidence inspected.' }, true);
    r.write('src/a.txt', 'two\n');
    assert.throws(review, /source revision changed/);
    r.write('src/a.txt', 'one\n');
    fs.writeFileSync(evidence, 'different\n');
    assert.throws(review, /evidence changed/);
});

test('an owner correction reaches its task and both dependency edges', t => {
    const f = native(t);
    plan(f, [{ id: 'a', role: 'worker' }, { id: 'b', role: 'worker', depends_on: ['a'] },
        { id: 'c', role: 'worker', acceptance_depends_on: ['a'] }, { id: 'd', role: 'worker' }], false);
    f.store.controlNative(f.id, 'correct', { text: 'Original correction text.', task_ids: ['a'] });
    const c = f.store.get(f.id);
    const version = id => c.tasks.find(x => x.id === id).requirementsVersion;
    assert.equal(version('a'), 1);
    assert.equal(version('b'), 1, 'implementation dependant invalidated');
    assert.equal(version('c'), 1, 'acceptance-only dependant invalidated');
    assert.equal(version('d'), 0, 'unrelated package untouched');
    const view = f.store.viewNative(f.id, 'root');
    assert.equal(view.intentText, fs.readFileSync(c.intent.path, 'utf8'));
    // Owner bytes are exact: no trim, no appended newline.
    assert.equal(view.corrections.at(-1).text, 'Original correction text.');
});

test('the brief carries original intent and denies new scope', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    f.store.controlNative(f.id, 'correct', { text: 'Scope stays bounded.', task_ids: ['pkg'] });
    const reserved = claim(f, 'pkg');
    const stored = f.store.get(f.id).claims.find(x => x.id === reserved.claimId);
    const brief = f.store.brief(f.store.get(f.id), stored);
    assert.match(brief, /Owner objective:/);
    assert.match(brief, /Scope stays bounded\./);
    assert.match(brief, /No new worktree, model override, commit, merge, push, deployment or game launch/);
    assert.match(brief, /No child agents/);
});

test('owner intent and correction bytes are preserved exactly', t => {
    const exact = '  leading and trailing preserved  \nsecond line\n';
    const project = tmp('nexact-');
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const state = tmp('nexactstate-');
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const store = new NativeStore(state);
    const c = store.createNative({ title: 'Exact', intent: exact, cwd: project, template: 'implementation',
        profiles: { worker: 'fixture-worker' } });
    store.attach(c.id, 'root-fixture', 'cli-fixture');
    assert.equal(store.viewNative(c.id).intentText, exact, 'owner intent is stored without trim or newline');
    store.planNative(c.id, 'root', { epoch: store.get(c.id).epoch, operation_id: 'plan', seal: false,
        tasks: [{ id: 'pkg', title: 't', brief: 'b', criteria: 'c', role: 'worker' }] });
    store.controlNative(c.id, 'correct', { text: exact, task_ids: ['pkg'] });
    assert.equal(store.viewNative(c.id).corrections.at(-1).text, exact, 'correction bytes are exact');
});

test('a governing reference is snapshotted and survives an external edit', t => {
    const project = tmp('nref-');
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    const state = tmp('nrefstate-');
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const ref = path.join(project, 'REFERENCE.md'); fs.writeFileSync(ref, 'governing v1\n');
    const store = new NativeStore(state);
    const c = store.createNative({ title: 'Ref', intent: 'i', cwd: project, template: 'implementation',
        profiles: { worker: 'fixture-worker' }, references: [ref] });
    store.attach(c.id, 'root-fixture', 'cli-fixture');
    const before = store.viewNative(c.id).references[0];
    assert.equal(before.snapshot.sha256, before.sha256, 'the snapshot matches the captured reference');
    fs.writeFileSync(ref, 'governing v2 EXTERNALLY CHANGED\n');
    // The immutable snapshot is what view verifies, so the edit does not break the campaign.
    const after = store.viewNative(c.id).references[0];
    assert.equal(after.snapshot.sha256, before.sha256, 'the snapshot keeps the original bytes');
});

test('an unfinished claim resumes with the current requirements and a canonical fresh message', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    f.store.finishAgent(f.id, 'agent-fixture-1', 'failed', 'native session dropped');
    f.store.controlNative(f.id, 'correct', { text: 'EXACT FRESH CORRECTION BYTES', task_ids: ['pkg'] });
    const resumed = f.store.resumeNative(f.id, 'root', { epoch: f.store.get(f.id).epoch, operation_id: 'resume', claim_id: reserved.claimId });
    assert.equal(resumed.action, 'SendMessage');
    assert.equal(resumed.input.to, 'agent-fixture-1');
    // The model receives only a short resume marker; authorizeResume returns the
    // canonical fresh message that the hook injects as the actual child input.
    assert.ok(resumed.input.message.includes('Resume campaign assignment'), 'resume returns the short marker');
    assert.ok(!resumed.input.message.includes('Owner objective:'), 'the marker carries no full instructions');
    const canonical = f.store.authorizeResume(f.id, 'root', { to: 'agent-fixture-1', message: resumed.input.message }, 'toolu_resume');
    assert.ok(canonical.includes('EXACT FRESH CORRECTION BYTES'), 'the canonical message carries the fresh correction verbatim');
    assert.ok(canonical.includes('Owner objective:'), 'the canonical message carries the full brief');
    assert.throws(() => f.store.authorizeResume(f.id, 'root', { to: 'agent-fixture-1', message: 'Forged resume.' }, 'toolu_forged'),
        /resume message differs/);
    assert.equal(f.store.get(f.id).claims.find(x => x.id === reserved.claimId).requirementsVersion,
        packet(f, 'pkg').requirementsVersion, 'resume adopts the current requirements version');
});

test('a late native receipt preserves an existing terminal phase', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    f.store.finishAgent(f.id, 'agent-fixture-1', 'failed', 'native session dropped');
    // A late duplicate receipt for the same agent is idempotent and must not
    // resurrect the terminal phase.
    const late = f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    assert.equal(late.phase, 'failed', 'the terminal phase is preserved');
});

test('a native get refreshes the actor seen epoch', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    assert.equal(f.store.get(f.id).claims.find(x => x.id === reserved.claimId).seenEpoch, null);
    const view = f.store.viewNative(f.id, reserved.claimId);
    assert.equal(view.actor.seenEpoch, view.epoch, 'get records the seen epoch');
});

test('the root may checkpoint without accepting any package', t => {
    const f = native(t);
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const result = f.store.checkpointNative(f.id, 'root', { note: 'Root next action here.' });
    assert.equal(result.saved, true);
    assert.equal(result.packageAccepted, false);
    assert.equal(f.store.get(f.id).root.checkpoint.note, 'Root next action here.', 'the note is saved on the root');
    assert.equal(packet(f, 'pkg').status, 'pending', 'no package is accepted by a root checkpoint');
});

test('prepareCheck and recordCheck both reject a stale-requirements candidate', t => {
    const f = native(t, { allowShell: true });
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    const evidence = path.join(f.project, 'e.txt'); fs.writeFileSync(evidence, 'out\n');
    f.store.submitNative(f.id, reserved.claimId, { summary: 'candidate', evidence_paths: [evidence], unrun: [] });
    f.store.finishAgent(f.id, 'agent-fixture-1', 'finished');
    const checkpoint = packet(f, 'pkg').latest;
    const sourceRevision = f.store.get(f.id).checkpoints[checkpoint].source.id;
    f.store.controlNative(f.id, 'correct', { text: 'Fresh correction.', task_ids: ['pkg'] });
    const epoch = f.store.get(f.id).epoch;
    assert.throws(() => f.store.prepareCheck(f.id, 'root', { epoch, operation_id: 'pc', checkpoint_id: checkpoint,
        kind: 'test', production_path: 'node', success_markers: ['OK'], executable: process.execPath, args: ['-e', "console.log('OK')"] },
    path.join(SOURCE, 'check-runner.js')), /candidate requirements changed/);
    assert.throws(() => f.store.recordCheck(f.id, 'root', { task_id: 'pkg', checkpoint_id: checkpoint, kind: 'test',
        production_path: 'node', evidence_paths: [evidence] },
    { observed: true, toolUseId: 'toolu_stale', sourceRevision, terminal: true, exitCode: 0, success: true }), /candidate requirements changed/);
});

test('verifyCheck marks an armed check unverified when a correction lands before verification', t => {
    const f = native(t, { allowShell: true });
    plan(f, [{ id: 'pkg', role: 'worker' }], false);
    const reserved = claim(f, 'pkg');
    f.store.bindAgent(f.id, reserved.claimId, 'agent-fixture-1');
    const evidence = path.join(f.project, 'e.txt'); fs.writeFileSync(evidence, 'out\n');
    f.store.submitNative(f.id, reserved.claimId, { summary: 'candidate', evidence_paths: [evidence], unrun: [] });
    f.store.finishAgent(f.id, 'agent-fixture-1', 'finished');
    const checkpoint = packet(f, 'pkg').latest;
    const epoch = f.store.get(f.id).epoch;
    const prepared = f.store.prepareCheck(f.id, 'root', { epoch, operation_id: 'pc', checkpoint_id: checkpoint,
        kind: 'test', production_path: 'node', success_markers: ['CHECK_OK'], executable: process.execPath,
        args: ['-e', "console.log('CHECK_OK')"] }, path.join(SOURCE, 'check-runner.js'));
    f.store.observeCheckStart(f.id, 'root', { tool_name: 'Bash', tool_input: { command: prepared.input.command },
        tool_use_id: 'toolu_armed', cwd: f.project });
    const request = f.store.get(f.id).checkRequests[prepared.checkId];
    // The check completes on disk before the owner correction lands.
    const { spawnSync } = require('node:child_process');
    spawnSync(process.execPath, [path.join(SOURCE, 'check-runner.js'), request.request.path], { encoding: 'utf8' });
    assert.equal(f.store.get(f.id).checkRequests[prepared.checkId].state, 'running');
    f.store.controlNative(f.id, 'correct', { text: 'Owner correction supersedes the candidate.', task_ids: ['pkg'] });
    assert.throws(() => f.store.verifyCheck(f.id, 'root', prepared.checkId), /candidate requirements changed/);
    const after = f.store.get(f.id).checkRequests[prepared.checkId];
    assert.equal(after.state, 'unverified', 'the request is marked unverified, not left running');
    assert.match(after.verificationError, /candidate requirements changed/, 'the failure reason is preserved');
    assert.ok(fs.existsSync(path.join(after.directory, 'result.json')), 'the completed result file is preserved');
});
