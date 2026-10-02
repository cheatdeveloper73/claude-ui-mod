'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, TEMPLATES, ensure, text, directory, inside, reference, verify, hash } = require('./core');
const { fingerprint, captureRevision, verifyRevision, verifyEvidence } = require('./revision');

const copy = value => JSON.parse(JSON.stringify(value));
const token = () => crypto.randomBytes(16).toString('hex');
const ACTIVE = new Set(['reserved', 'starting', 'running', 'resuming', 'finishing', 'stopping', 'unknown']);
const TERMINAL = new Set(['finished', 'failed', 'cancelled']);
const ROLES = new Set(['designer', 'worker', 'integrator', 'investigator', 'coordinator']);
const CHECKS = new Set(['build', 'test', 'inspection', 'integration', 'performance']);
const event = (c, kind, data = {}) => c.events.push({ at: new Date().toISOString(), kind, ...data });
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const deps = task => [...new Set([...task.dependsOn, ...(task.acceptanceDependsOn || [])])];
const workReady = (c, task) => task.dependsOn.every(id => c.tasks.find(t => t.id === id)?.status === 'accepted');
const acceptReady = (c, task) => deps(task).every(id => c.tasks.find(t => t.id === id)?.status === 'accepted');
const leased = claim => !claim.ownershipReleased && claim.kind !== 'review';

function immutable(file, body) {
    if (fs.existsSync(file)) ensure(fs.readFileSync(file, 'utf8') === body, 'immutable campaign record changed');
    else fs.writeFileSync(file, body, { flag: 'wx' });
    return reference(file);
}
function boundedInteger(value, fallback, name, max) {
    const result = value === undefined ? fallback : value;
    ensure(Number.isInteger(result) && result > 0 && result <= max, 'invalid ' + name);
    return result;
}
function list(value, name) {
    ensure(Array.isArray(value) && value.every(item => typeof item === 'string'), name + ' must be an array of strings');
    return [...new Set(value)];
}
function permittedPath(c, file, existing = true) {
    const real = existing ? fs.realpathSync(file) : path.resolve(file);
    ensure(c.workspaces.some(root => inside(real, root)) || inside(real, c.directory)
        || c.references.some(ref => ref.path === real), 'path is outside the approved campaign inputs');
    return real;
}

class NativeStore extends Store {
    createNative(input) {
        ensure(TEMPLATES[input.template || 'implementation'], 'unknown workflow');
        const cwd = directory(input.cwd);
        const id = crypto.randomBytes(8).toString('hex');
        const dir = path.join(this.root, id);
        const workspaces = [...new Set([cwd, ...list(input.workspaces || [], 'workspaces').map(directory)])];
        const profiles = input.profiles || { worker: 'general-purpose', reviewer: 'general-purpose' };
        ensure(profiles && typeof profiles === 'object' && !Array.isArray(profiles), 'profile bindings are required');
        for (const [role, profile] of Object.entries(profiles)) {
            ensure(ROLES.has(role) || role === 'reviewer', 'unknown campaign role');
            text(profile, 'native agent profile', 120);
        }
        const refs = list(input.references || [], 'references').map(file => reference(file));
        fs.mkdirSync(dir, { recursive: true });
        text(input.intent, 'owner objective', 100000);
        const intent = immutable(path.join(dir, 'owner-intent.md'), input.intent);
        const referenceDir = path.join(dir, 'references'); fs.mkdirSync(referenceDir, { recursive: true });
        for (const ref of refs) {
            const target = path.join(referenceDir, ref.sha256 + path.extname(ref.path));
            if (!fs.existsSync(target)) fs.copyFileSync(ref.path, target, fs.constants.COPYFILE_EXCL);
            ref.snapshot = reference(target);
            ensure(ref.snapshot.sha256 === ref.sha256, 'governing reference changed during capture');
        }
        const c = { schema: 2, execution: 'native-agents', id, directory: dir,
            title: text(input.title, 'campaign title', 160), cwd, workspaces, template: input.template || 'implementation',
            profiles: copy(profiles), intent, references: refs, corrections: [], tasks: [], claims: [], checkpoints: {}, checks: {},
            commands: {}, events: [], checkRequests: {}, root: null, mode: 'draft', epoch: 0, revision: 0, planSealed: false,
            policy: { maxConcurrent: boundedInteger(input.maxConcurrent, 3, 'concurrency', 128),
                maxAttempts: boundedInteger(input.maxAttempts, 20, 'attempt limit', 10000),
                allowWrites: input.allowWrites === true, allowShell: input.allowShell === true },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        event(c, 'created', { source: 'owner-ui' });
        return this.write(c);
    }
    native(id) {
        const c = this.get(id);
        ensure(c.schema === 2 && c.execution === 'native-agents', 'legacy campaign is preserved read-only; create a native campaign');
        return c;
    }
    actor(c, identity) {
        if (identity === 'root') {
            ensure(c.root, 'campaign has no attached root');
            return { kind: 'root', id: 'root' };
        }
        const claim = c.claims.find(value => value.id === identity);
        ensure(claim, 'unknown native assignment');
        return claim;
    }
    checked(c, identity, epoch) {
        ensure(c.mode === 'active', 'campaign is ' + c.mode);
        ensure(epoch === c.epoch, 'campaign control changed; read campaign.get');
        const actor = this.actor(c, identity);
        if (actor.kind !== 'root') ensure(ACTIVE.has(actor.phase), 'native assignment is not active');
        return actor;
    }
    coordinator(c, identity, epoch) {
        const actor = this.checked(c, identity, epoch);
        ensure(actor.kind === 'root' || actor.kind === 'coordinator', 'only an assigned coordinator may delegate');
        return actor;
    }
    attach(id, desktopSessionId, cliSessionId) {
        this.native(id);
        return this.change(id, c => {
            ensure(['draft', 'paused', 'active'].includes(c.mode), 'campaign cannot be attached in its current state');
            ensure(!c.root || c.root.desktopSessionId === desktopSessionId, 'campaign already belongs to another root; reconcile before rebinding');
            c.root = { desktopSessionId: text(desktopSessionId, 'Desktop session id', 120), cliSessionId: cliSessionId || c.root?.cliSessionId || null };
            if (c.mode === 'draft') { c.mode = 'active'; c.epoch++; }
            event(c, 'root-attached', { desktopSessionId });
            return copy(c.root);
        });
    }
    planNative(id, identity, input) {
        this.native(id);
        return this.change(id, c => {
            const actor = this.coordinator(c, identity, input.epoch);
            return this.once(c, input.operation_id, { actor: identity, ...input }, () => {
                ensure(!c.planSealed, 'plan is sealed; amend explicit packets instead of silently replacing it');
                ensure(Array.isArray(input.tasks) && input.tasks.length > 0, 'provide work packets');
                const proposed = input.tasks.map(value => {
                    ensure(ROLES.has(value.role || 'worker'), 'invalid package role');
                    const sourceRoots = list(value.source_roots || [value.cwd || c.cwd], 'source_roots').map(directory);
                    ensure(sourceRoots.length > 0, 'package needs its actual source roots');
                    const writeRoots = list(value.write_roots || [], 'write_roots').map(directory);
                    for (const root of [...sourceRoots, ...writeRoots]) ensure(c.workspaces.some(allowed => inside(root, allowed)), 'package root was not owner-approved');
                    ensure(!writeRoots.length || c.policy.allowWrites, 'campaign has no source-write permission');
                    const role = value.role || 'worker';
                    ensure(role !== 'coordinator' || writeRoots.length === 0, 'coordinators delegate source work');
                    const requiredChecks = list(value.required_checks || (writeRoots.length ? ['test'] : ['inspection']), 'required_checks');
                    ensure(requiredChecks.length > 0 && requiredChecks.every(kind => CHECKS.has(kind)), 'unknown or empty verification requirement');
                    return { id: text(value.id, 'package id', 60), title: text(value.title, 'package title', 180),
                        brief: text(value.brief, 'package brief', 50000), criteria: text(value.criteria, 'acceptance criteria', 30000),
                        role, cwd: directory(value.cwd || sourceRoots[0]), sourceRoots, writeRoots,
                        inputPaths: list(value.input_paths || [], 'input_paths').map(file => permittedPath(c, file)),
                        dependsOn: list(value.depends_on || [], 'depends_on'),
                        acceptanceDependsOn: list(value.acceptance_depends_on || [], 'acceptance_depends_on'),
                        requiredChecks, parentTaskId: actor.taskId || null, status: 'pending', requirementsVersion: 0,
                        attempts: [], latest: null, accepted: null, reviews: [], nextAction: 'Implement the production path and provide the required verification.',
                        nativeTaskId: value.native_task_id || null };
                });
                const all = [...c.tasks, ...proposed];
                ensure(new Set(all.map(t => t.id)).size === all.length, 'duplicate package id');
                for (const task of all) {
                    ensure(deps(task).every(id => all.some(t => t.id === id)), 'unknown dependency');
                    const walk = (id, stack) => {
                        ensure(!stack.includes(id), 'dependency cycle');
                        for (const dep of deps(all.find(t => t.id === id))) walk(dep, [...stack, id]);
                    };
                    walk(task.id, []);
                }
                if (input.seal && c.template === 'implementation') ensure(all.some(t => t.role === 'integrator'), 'the implementation plan needs an integrated-wave package');
                c.tasks = all;
                if (input.seal) c.planSealed = true;
                event(c, 'planned', { actor: identity, tasks: proposed.map(t => t.id) });
                return { tasks: proposed.map(t => t.id), sealed: c.planSealed };
            });
        });
    }
    verifyAccepted(c, ids) {
        for (const id of ids) {
            const task = c.tasks.find(t => t.id === id);
            ensure(task?.status === 'accepted' && task.accepted, 'dependency is not accepted: ' + id);
            const checkpoint = c.checkpoints[task.accepted];
            ensure(checkpoint?.requirementsVersion === task.requirementsVersion, 'dependency requirements changed: ' + id);
            verifyRevision(checkpoint.source);
            for (const ref of checkpoint.evidence) verifyEvidence(ref);
        }
    }
    claimNative(id, identity, input) {
        this.native(id);
        return this.change(id, c => {
            const parent = this.coordinator(c, identity, input.epoch);
            return this.once(c, input.operation_id, { actor: identity, ...input }, () => {
                const task = c.tasks.find(t => t.id === input.task_id);
                ensure(task, 'unknown package');
                ensure(parent.kind === 'root' || task.parentTaskId === parent.taskId, 'package belongs to another coordinator');
                const kind = input.kind === 'review' ? 'review' : task.role === 'coordinator' ? 'coordinator' : 'work';
                ensure(c.claims.filter(value => ACTIVE.has(value.phase)).length < c.policy.maxConcurrent, 'active native-agent capacity reached');
                ensure(!c.claims.some(value => value.taskId === task.id && ACTIVE.has(value.phase)), 'package already has an active assignment');
                if (kind === 'review') {
                    ensure(task.status === 'submitted' && task.latest, 'package has no candidate to review');
                    ensure(!c.claims.some(value => value.taskId === task.id && value.kind !== 'review' && leased(value)), 'writer must finish and release its source before review');
                } else {
                    ensure(['pending', 'rejected'].includes(task.status), 'package needs reconciliation before another writer');
                    ensure(task.attempts.length < c.policy.maxAttempts, 'package attempt budget exhausted');
                    this.verifyAccepted(c, task.dependsOn);
                    for (const other of c.claims.filter(leased)) ensure(!task.writeRoots.some(root => other.writeRoots.some(held => overlaps(root, held))), 'another assignment owns an overlapping source root');
                }
                const profile = c.profiles[kind === 'review' ? 'reviewer' : task.role] || c.profiles.worker;
                ensure(profile, 'no native profile configured for this role');
                const claim = { id: token(), taskId: task.id, parent: identity, kind, profile,
                    agentId: null, agentName: 'campaign-' + c.id.slice(0, 6) + '-' + token().slice(0, 10),
                    phase: 'reserved', writeRoots: kind === 'review' ? [] : task.writeRoots,
                    ownershipReleased: kind === 'review', requirementsVersion: task.requirementsVersion,
                    resultId: kind === 'review' ? task.latest : null, seenEpoch: null, createdAt: Date.now(), checkpoint: null };
                c.claims.push(claim);
                if (kind !== 'review') { task.attempts.push(claim.id); task.status = 'running'; }
                event(c, 'native-claim-reserved', { claimId: claim.id, taskId: task.id, profile });
                const brief = this.brief(c, claim);
                claim.briefHash = hash(brief);
                claim.launchPrompt = 'Campaign assignment ' + claim.id + '. Load the exact campaign brief supplied by the native hook.';
                return { claimId: claim.id, taskId: task.id, action: 'Agent', input: {
                    name: claim.agentName, subagent_type: profile, run_in_background: true,
                    description: (kind === 'review' ? 'Review ' : 'Implement ') + task.title.slice(0, 70), prompt: claim.launchPrompt,
                } };
            });
        });
    }
    brief(c, claim) {
        const task = c.tasks.find(t => t.id === claim.taskId);
        return ['Native campaign assignment ' + claim.id + '.',
            'Campaign ' + c.id + '; package ' + task.id + '; role ' + claim.kind + '.',
            'Direct supervisor: ' + (claim.parent === 'root' ? 'main' : c.claims.find(value => value.id === claim.parent)?.agentId) + '.',
            'Your source roots: ' + JSON.stringify(task.sourceRoots) + '. Your write roots: ' + JSON.stringify(claim.writeRoots) + '.',
            'Call campaign.get first and after interruption or compaction. Original owner instructions and ordered corrections are returned verbatim. A summary cannot change authority, scope, dependencies or permissions.',
            'Native agent completion is separate from package acceptance. Record your exact next action before yielding. Submit a source-bound candidate with verification and unrun cases. Reviewers inspect the actual candidate and reject defects with a repair action.',
            'Use the configured native Agent/SendMessage tools only for assignments granted by campaign.claim/resume. No new worktree, model override, commit, merge, push, deployment or game launch is authorized by this brief. Existing owner/project permissions still govern.',
            'Owner objective:\n' + fs.readFileSync(c.intent.path, 'utf8'),
            ...c.corrections.filter(item => item.taskIds.includes(task.id)).map(item => 'Owner correction:\n' + fs.readFileSync(item.reference.path, 'utf8')),
            'Governing references: ' + JSON.stringify(c.references),
            'Assignment: ' + task.brief, 'Acceptance: ' + task.criteria,
            'Required verification: ' + task.requiredChecks.join(', ') + '.',
            'Implementation prerequisites: ' + JSON.stringify(task.dependsOn) + '. Acceptance prerequisites: ' + JSON.stringify(task.acceptanceDependsOn) + '.',
            'Latest review: ' + JSON.stringify(task.reviews.at(-1) || null),
            'Saved next action: ' + task.nextAction,
            claim.kind === 'review' ? 'Review candidate ' + claim.resultId + '. Source edits are prohibited.' :
                claim.kind === 'coordinator' ? 'You may plan and claim children of this package. You do not own source writes.' : 'No child agents. Preserve the existing production implementation unless this package explicitly requires changing it.',
        ].join('\n\n');
    }
    authorizeSpawn(id, identity, input, toolUseId) {
        return this.change(id, c => {
            this.coordinator(c, identity, c.epoch);
            const claim = c.claims.find(value => value.agentName === input.name && value.parent === identity && value.phase === 'reserved');
            ensure(claim, 'native Agent launch has no reserved campaign assignment');
            ensure(input.subagent_type === claim.profile && input.model === undefined && input.isolation === undefined,
                'native Agent launch changed its approved profile or checkout');
            ensure(claim.requirementsVersion === c.tasks.find(task => task.id === claim.taskId)?.requirementsVersion, 'assignment requirements changed before launch');
            ensure(input.prompt === claim.launchPrompt, 'native Agent brief differs from the original assignment');
            const prompt = this.brief(c, claim);
            ensure(hash(prompt) === claim.briefHash, 'recorded assignment changed before native launch');
            claim.phase = 'starting'; claim.toolUseId = toolUseId; claim.activeToolUseId = toolUseId; claim.activeSince = Date.now();
            event(c, 'native-launch-starting', { claimId: claim.id, toolUseId });
            return { ...copy(claim), prompt };
        });
    }
    bindAgent(id, claimId, agentId) {
        return this.change(id, c => {
            const claim = c.claims.find(value => value.id === claimId);
            ensure(claim, 'native receipt has no current claim');
            if (claim.agentId === agentId) return copy(claim);
            ensure(['reserved', 'starting', 'resuming', 'running', 'finishing', 'stopping', 'unknown'].includes(claim.phase), 'native receipt has no current claim');
            ensure(!claim.agentId, 'native claim already belongs to another agent');
            ensure(!c.claims.some(value => value.id !== claimId && value.agentId === agentId && ACTIVE.has(value.phase)), 'native agent already owns another active claim');
            claim.agentId = text(agentId, 'native agent id', 160); claim.phase = 'running';
            event(c, 'native-agent-bound', { claimId, agentId });
            return copy(claim);
        });
    }
    finishAgent(id, agentId, phase = 'finished', reason = '') {
        ensure(TERMINAL.has(phase), 'invalid native terminal state');
        return this.change(id, c => {
            const claim = c.claims.findLast(value => value.agentId === agentId && ACTIVE.has(value.phase));
            if (!claim) return { duplicate: true };
            claim.phase = phase; claim.finishedAt = Date.now(); claim.reason = reason;
            const task = c.tasks.find(t => t.id === claim.taskId);
            if (claim.kind !== 'review') {
                if (task.status === 'submitted') claim.ownershipReleased = true;
                else if (!['accepted', 'rejected'].includes(task.status)) {
                    task.status = 'interrupted';
                    task.nextAction = claim.checkpoint?.note || 'Reconcile this native assignment and resume it; no replacement writer is authorized.';
                }
            }
            event(c, 'native-agent-' + phase, { claimId: claim.id, agentId, taskId: task.id });
            return copy(claim);
        });
    }
    resumeNative(id, identity, input) {
        return this.change(id, c => {
            this.coordinator(c, identity, input.epoch);
            return this.once(c, input.operation_id, { actor: identity, ...input }, () => {
                const claim = c.claims.find(value => value.id === input.claim_id);
                ensure(claim?.agentId && TERMINAL.has(claim.phase), 'assignment has no confirmed stopped native agent');
                const task = c.tasks.find(t => t.id === claim.taskId);
                ensure(['interrupted', 'blocked'].includes(task.status), 'resume is for an unfinished assignment');
                ensure(c.claims.filter(value => ACTIVE.has(value.phase)).length < c.policy.maxConcurrent, 'active native-agent capacity reached');
                claim.requirementsVersion = task.requirementsVersion;
                claim.phase = 'resuming'; claim.seenEpoch = null; claim.activeSince = Date.now();
                claim.resumePrompt = 'Resume campaign assignment ' + claim.id + '. Recover the original instructions and saved checkpoint.';
                task.status = 'running';
                event(c, 'native-resume-reserved', { claimId: claim.id, agentId: claim.agentId });
                return { claimId: claim.id, action: 'SendMessage', input: { to: claim.agentId, message: claim.resumePrompt } };
            });
        });
    }
    authorizeResume(id, identity, input, toolUseId) {
        return this.change(id, c => {
            const parent = this.coordinator(c, identity, c.epoch);
            const claim = c.claims.find(value => value.agentId === input.to && value.phase === 'resuming');
            ensure(claim && (parent.kind === 'root' || claim.parent === identity), 'resumption belongs to another coordinator');
            ensure(input.message === claim.resumePrompt, 'native resume message differs from the reserved assignment');
            claim.activeToolUseId = toolUseId;
            return 'Resume the SAME native campaign assignment. Reconcile existing source and running jobs before repeating work.\n\n' + this.brief(c, claim);
        });
    }
    checkpointNative(id, identity, input) {
        return this.change(id, c => {
            const claim = this.actor(c, identity);
            if (claim.kind === 'root') {
                c.root.checkpoint = { note: text(input.note, 'next action', 20000), at: Date.now(), jobs: copy(input.jobs || []) };
                event(c, 'root-checkpoint', { note: c.root.checkpoint.note });
                return { saved: true, packageAccepted: false, next: 'Yield to native completion or owner control; packages retain their individual states.' };
            }
            claim.checkpoint = { note: text(input.note, 'next action', 20000), at: Date.now(), jobs: copy(input.jobs || []) };
            const task = c.tasks.find(t => t.id === claim.taskId);
            task.nextAction = claim.checkpoint.note;
            if (input.blocked && claim.kind !== 'review') task.status = 'blocked';
            event(c, 'checkpoint', { claimId: claim.id, taskId: task.id });
            return { saved: true, packageAccepted: task.status === 'accepted', next: 'Yield when waiting; native completion does not accept the package.' };
        });
    }
    submitNative(id, identity, input) {
        this.native(id);
        const current = this.get(id);
        const claim = this.actor(current, identity);
        ensure(['work', 'coordinator'].includes(claim.kind), 'only the assigned producer submits a candidate');
        const task = current.tasks.find(t => t.id === claim.taskId);
        ensure(claim.requirementsVersion === task.requirementsVersion, 'assignment requirements changed; reconcile before submission');
        ensure(!['accepted', 'rejected'].includes(task.status), 'this attempt is already settled');
        const source = captureRevision(task.sourceRoots, task.inputPaths);
        const evidence = list(input.evidence_paths || [], 'evidence_paths').map(file => fingerprint(permittedPath(current, file)));
        const summary = text(input.summary, 'candidate summary', 50000);
        const unmet = list(input.unrun || [], 'unrun');
        const identityHash = hash(JSON.stringify({ source: source.id, evidence, summary, unmet, claimId: claim.id }));
        return this.change(id, c => {
            const live = this.actor(c, identity);
            const owned = c.tasks.find(t => t.id === live.taskId);
            ensure(live.requirementsVersion === owned.requirementsVersion, 'requirements changed during source capture');
            if (owned.latest && c.checkpoints[owned.latest]?.fingerprint === identityHash) return { checkpointId: owned.latest, repeated: true };
            const checkpointId = token();
            const dir = path.join(c.directory, 'checkpoints'); fs.mkdirSync(dir, { recursive: true });
            const report = immutable(path.join(dir, checkpointId + '.md'), summary + '\n');
            const checkpoint = { id: checkpointId, taskId: task.id, claimId: claim.id, source, evidence, report,
                fingerprint: identityHash, summary, unrun: unmet, requirementsVersion: owned.requirementsVersion, at: Date.now() };
            c.checkpoints[checkpointId] = checkpoint;
            owned.latest = checkpointId; owned.status = 'submitted'; owned.nextAction = 'Await revision-specific verification and independent review.';
            if (TERMINAL.has(live.phase)) live.ownershipReleased = true;
            event(c, 'candidate-submitted', { taskId: task.id, checkpointId, sourceRevision: source.id, late: c.mode !== 'active' });
            return { checkpointId, sourceRevision: source.id, packageAccepted: false };
        });
    }
    prepareCheck(id, identity, input, runnerPath) {
        const current = this.native(id);
        const actor = this.checked(current, identity, input.epoch);
        const checkpoint = current.checkpoints[input.checkpoint_id];
        const task = current.tasks.find(value => value.id === checkpoint?.taskId);
        ensure(task && task.latest === checkpoint.id, 'check targets an obsolete candidate');
        ensure(checkpoint.requirementsVersion === task.requirementsVersion, 'candidate requirements changed; submit a current candidate before verification');
        ensure(actor.kind === 'root' || actor.taskId === task.id, 'check belongs to another package');
        ensure(CHECKS.has(input.kind), 'unknown verification kind');
        verifyRevision(checkpoint.source);
        const inspection = input.kind === 'inspection' && input.read_path;
        ensure(inspection || current.policy.allowShell, 'shell verification needs owner shell authorization');
        const productionPath = text(input.production_path, 'actual production path exercised', 4000);
        const markers = list(input.success_markers || [], 'completion markers');
        ensure(inspection || (markers.length > 0 && markers.every(value => value.length > 0 && value.length <= 2048)), 'an executable check needs its real terminal completion markers');
        return this.change(id, c => this.once(c, input.operation_id, { actor: identity, ...input }, () => {
            const checkId = token();
            const dir = path.join(c.directory, 'checks', checkId); fs.mkdirSync(dir, { recursive: true });
            let action;
            let request;
            if (inspection) {
                action = { tool: 'Read', input: { file_path: permittedPath(c, input.read_path) } };
            } else {
                const cwd = directory(input.cwd || task.cwd);
                ensure(c.workspaces.some(root => inside(cwd, root)), 'check cwd is outside approved workspaces');
                const body = { version: 1, id: checkId, sourceRevision: checkpoint.source.id, cwd,
                    executable: text(input.executable, 'check executable', 4096), args: (() => {
                        ensure(Array.isArray(input.args || []) && (input.args || []).every(value => typeof value === 'string'), 'check arguments must be strings');
                        return [...(input.args || [])];
                    })(),
                    successMarkers: markers, artifacts: list(input.artifacts || [], 'check artifacts').map(file => permittedPath(c, file, false)),
                    completionFiles: list(input.completion_files || [], 'completion files').map(file => {
                        const real = permittedPath(c, file, fs.existsSync(file));
                        return fs.existsSync(real) ? fingerprint(real) : { path: real, sha256: null };
                    }) };
                request = immutable(path.join(dir, 'request.json'), JSON.stringify(body, null, 2));
                const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
                action = { tool: 'Bash', input: { command: 'node ' + quote(runnerPath) + ' ' + quote(request.path),
                    run_in_background: input.background === true, timeout: input.timeout || 120000,
                    description: 'Run campaign ' + input.kind + ' verification' } };
            }
            const item = { id: checkId, claimId: identity, taskId: task.id, checkpointId: checkpoint.id, kind: input.kind,
                productionPath, directory: dir, sourceRevision: checkpoint.source.id, action, request: request || null,
                runner: inspection ? null : fingerprint(runnerPath), state: 'armed', at: Date.now() };
            c.checkRequests ||= {}; c.checkRequests[checkId] = item;
            event(c, 'check-prepared', { checkId, taskId: task.id, kind: input.kind });
            return { checkId, ...action };
        }));
    }
    observeCheckStart(id, identity, input) {
        return this.change(id, c => {
            const request = Object.values(c.checkRequests || {}).find(value => value.claimId === identity && value.state === 'armed'
                && value.action.tool === input.tool_name && (input.tool_name === 'Bash'
                    ? value.action.input.command === input.tool_input?.command
                    : value.action.input.file_path === input.tool_input?.file_path));
            if (!request) return null;
            const checkpoint = c.checkpoints[request.checkpointId];
            verifyRevision(checkpoint.source);
            if (request.request) verify(request.request);
            if (request.runner) verifyEvidence(request.runner);
            request.state = 'running'; request.toolUseId = input.tool_use_id;
            request.nativeCwd = input.cwd; request.startedAt = Date.now();
            event(c, 'check-native-start', { checkId: request.id, toolUseId: request.toolUseId });
            return copy(request);
        });
    }
    verifyCheck(id, identity, checkId) {
        const c = this.native(id);
        const actor = this.actor(c, identity);
        const request = c.checkRequests?.[checkId];
        ensure(request && (actor.kind === 'root' || request.taskId === actor.taskId), 'check belongs to another package');
        ensure(request.toolUseId, 'check has no observed native invocation');
        if (request.checkId) return c.checks[request.checkId];
        const resultFile = path.join(request.directory, 'result.json');
        ensure(fs.existsSync(resultFile), 'check has not published a terminal result');
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        ensure(result.id === request.id && result.sourceRevision === request.sourceRevision, 'check result identity mismatch');
        if (request.request) {
            verify(request.request);
            ensure(result.requestSha256 === request.request.sha256, 'check request changed');
        }
        ensure(result.status !== 'running', 'check is still running');
        const evidence = [resultFile, ...['stdout.log', 'stderr.log'].map(name => path.join(request.directory, name)).filter(file => fs.existsSync(file))];
        for (const ref of result.artifacts || []) { verifyEvidence(ref); evidence.push(permittedPath(c, ref.path)); }
        try {
            const check = this.recordCheck(id, identity, { task_id: request.taskId, checkpoint_id: request.checkpointId,
                kind: request.kind, production_path: request.productionPath, evidence_paths: evidence },
            { observed: true, toolUseId: request.toolUseId, requestId: request.id, sourceRevision: request.sourceRevision,
                terminal: result.terminal, exitCode: result.exitCode, success: result.status === 'passed',
                command: request.action.input.command || null, cwd: request.nativeCwd, detail: result });
            this.change(id, value => { value.checkRequests[checkId].state = check.status; value.checkRequests[checkId].checkId = check.id; });
            return check;
        } catch (error) {
            this.change(id, value => { value.checkRequests[checkId].state = 'unverified'; value.checkRequests[checkId].verificationError = error.message; });
            throw error;
        }
    }
    recordCheck(id, identity, input, receipt) {
        const current = this.native(id);
        const actor = this.actor(current, identity);
        const task = current.tasks.find(t => t.id === input.task_id);
        ensure(task && (actor.kind === 'root' || actor.taskId === task.id), 'check belongs to another package');
        const checkpoint = current.checkpoints[input.checkpoint_id];
        ensure(checkpoint?.taskId === task.id && checkpoint.id === task.latest, 'verification targets an obsolete candidate');
        ensure(checkpoint.requirementsVersion === task.requirementsVersion, 'candidate requirements changed; verification cannot cover the new requirements');
        ensure(CHECKS.has(input.kind), 'unknown verification kind');
        ensure(receipt?.observed === true && receipt.toolUseId, 'verification needs an observed native tool receipt');
        ensure(receipt.sourceRevision === checkpoint.source.id, 'check ran against another source revision');
        verifyRevision(checkpoint.source);
        const evidence = list(input.evidence_paths || [], 'check evidence').map(file => fingerprint(permittedPath(current, file)));
        ensure(evidence.length > 0, 'verification needs its actual output artifact');
        return this.change(id, c => {
            const check = { id: token(), checkpointId: checkpoint.id, taskId: task.id, kind: input.kind,
                productionPath: text(input.production_path, 'exercised production path', 4000),
                status: receipt.exitCode === 0 && receipt.terminal === true && receipt.success === true ? 'passed'
                    : receipt.terminal && receipt.exitCode !== 0 ? 'failed' : 'incomplete',
                receipt: copy(receipt), evidence, at: Date.now() };
            c.checks[check.id] = check;
            event(c, 'verification-recorded', { taskId: task.id, checkId: check.id, status: check.status });
            return copy(check);
        });
    }
    reviewNative(id, identity, input, owner = false) {
        const current = this.native(id);
        const task = current.tasks.find(t => t.id === input.task_id);
        ensure(task?.latest === input.checkpoint_id, 'review targets an obsolete candidate');
        const checkpoint = current.checkpoints[task.latest];
        if (input.decision === 'accept') {
            verifyRevision(checkpoint.source);
            for (const ref of [checkpoint.report, ...checkpoint.evidence]) verifyEvidence(ref);
        }
        return this.change(id, c => {
            ensure(c.mode === 'active', 'campaign is not active');
            const item = c.tasks.find(t => t.id === input.task_id);
            ensure(item.status === 'submitted' && item.latest === input.checkpoint_id, 'candidate changed before review');
            const actor = owner ? null : this.checked(c, identity, input.epoch);
            ensure(owner || (actor.kind === 'review' && actor.taskId === item.id && actor.resultId === item.latest), 'an assigned independent reviewer is required');
            ensure(owner || checkpoint.claimId !== actor.id, 'a producer cannot accept its own work');
            ensure(checkpoint.requirementsVersion === item.requirementsVersion, 'review uses obsolete requirements');
            ensure(['accept', 'reject'].includes(input.decision), 'review decision must be accept or reject');
            const reason = text(input.reason, 'review reason and next action', 20000);
            if (input.decision === 'accept') {
                this.verifyAccepted(c, deps(item));
                ensure(checkpoint.unrun.length === 0, 'candidate still declares unrun required work');
                ensure(!Object.values(c.checkRequests || {}).some(check => check.checkpointId === checkpoint.id && ['armed', 'running'].includes(check.state)), 'candidate still has outstanding verification');
                for (const kind of item.requiredChecks) {
                    const checks = Object.values(c.checks).filter(check => check.checkpointId === item.latest && check.kind === kind);
                    ensure(checks.at(-1)?.status === 'passed', 'missing passed ' + kind + ' verification for this source revision');
                    for (const ref of checks.at(-1).evidence) verifyEvidence(ref);
                }
            }
            item.reviews.push({ checkpointId: item.latest, actor: owner ? 'owner' : identity, decision: input.decision, reason, at: Date.now() });
            item.status = input.decision === 'accept' ? 'accepted' : 'rejected';
            item.accepted = input.decision === 'accept' ? item.latest : null;
            item.nextAction = input.decision === 'accept' ? 'Accepted at source revision ' + checkpoint.source.id : reason;
            event(c, 'review-' + input.decision, { taskId: item.id, checkpointId: item.latest, actor: owner ? 'owner' : identity });
            if (c.planSealed && c.tasks.length && c.tasks.every(value => value.status === 'accepted')) c.mode = 'completed';
            return { status: item.status, checkpointId: item.latest };
        });
    }
    controlNative(id, action, input = {}) {
        this.native(id);
        return this.change(id, c => {
            ensure(c.mode !== 'stopped', 'stopped campaign is immutable');
            if (action === 'pause') { ensure(c.mode === 'active', 'campaign is not active'); c.mode = 'paused'; }
            else if (action === 'resume') { ensure(c.mode === 'paused', 'campaign is not paused'); c.mode = 'active'; }
            else if (action === 'stop') c.mode = 'stopped';
            else if (action === 'correct') {
                const body = text(input.text, 'original owner correction', 100000);
                const affected = new Set(input.task_ids?.length ? list(input.task_ids, 'task_ids') : c.tasks.map(task => task.id));
                ensure([...affected].every(id => c.tasks.some(task => task.id === id)), 'unknown correction target');
                for (let changed = true; changed;) {
                    changed = false;
                    for (const task of c.tasks) if (!affected.has(task.id) && deps(task).some(id => affected.has(id))) { affected.add(task.id); changed = true; }
                }
                const ref = immutable(path.join(c.directory, 'correction-' + token() + '.md'), input.text);
                c.corrections.push({ reference: ref, taskIds: [...affected], at: Date.now(), source: 'owner-ui' });
                for (const task of c.tasks.filter(value => affected.has(value.id))) {
                    task.requirementsVersion++; task.accepted = null;
                    if (!['running', 'interrupted', 'blocked'].includes(task.status)) task.status = 'pending';
                    task.nextAction = 'Read the original correction and reconcile this package against requirements revision ' + task.requirementsVersion + '.';
                }
                if (c.mode === 'completed') c.mode = 'paused';
            } else if (action === 'reconcile') {
                const claim = c.claims.find(value => value.id === input.claim_id);
                ensure(claim && TERMINAL.has(claim.phase), 'confirm native termination before releasing ownership');
                const task = c.tasks.find(value => value.id === claim.taskId);
                ensure(['interrupted', 'blocked'].includes(task.status), 'package is not awaiting reconciliation');
                task.nextAction = text(input.reason, 'reconciliation and next action', 20000);
                claim.ownershipReleased = true; task.status = 'pending';
            } else throw new Error('unknown campaign control');
            c.epoch++;
            event(c, 'owner-' + action, { source: 'owner-ui' });
            return { mode: c.mode, epoch: c.epoch };
        });
    }
    viewNative(id, identity = null) {
        let c = this.native(id);
        verify(c.intent);
        for (const ref of c.references) if (ref.snapshot) verify(ref.snapshot);
        for (const correction of c.corrections) verify(correction.reference);
        let actor = identity ? this.actor(c, identity) : null;
        if (actor && actor.kind !== 'root' && actor.seenEpoch !== c.epoch) {
            this.change(id, value => {
                const current = this.actor(value, identity);
                current.seenEpoch = value.epoch;
                event(value, 'instructions-read', { claimId: current.id, epoch: value.epoch, intentSha256: value.intent.sha256 });
                const task = value.tasks.find(item => item.id === current.taskId);
                if (current.kind !== 'review' && ACTIVE.has(current.phase) && current.requirementsVersion !== task.requirementsVersion) {
                    current.requirementsVersion = task.requirementsVersion;
                    task.status = 'running';
                    event(value, 'requirements-read', { claimId: current.id, requirementsVersion: task.requirementsVersion });
                }
            });
            c = this.get(id);
            actor = this.actor(c, identity);
        }
        const tasks = c.tasks.map(task => ({ ...task, ready: workReady(c, task), acceptanceReady: acceptReady(c, task) }));
        return { ...c, tasks, actor, intentText: fs.readFileSync(c.intent.path, 'utf8'),
            corrections: c.corrections.filter(value => !actor?.taskId || value.taskIds.includes(actor.taskId)).map(value => ({ ...value, text: fs.readFileSync(value.reference.path, 'utf8') })),
            queue: {
                ready: tasks.filter(task => ['pending', 'rejected'].includes(task.status) && task.ready).map(task => task.id),
                review: tasks.filter(task => task.status === 'submitted').map(task => task.id),
                unfinished: tasks.filter(task => ['interrupted', 'blocked'].includes(task.status)).map(task => task.id),
                active: c.claims.filter(claim => ACTIVE.has(claim.phase)).map(claim => claim.id),
            } };
    }
}

module.exports = { NativeStore, ACTIVE, TERMINAL, workReady, acceptReady, overlaps };
