'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLE_MODEL = { model: 'claude-opus-5-5', effort: 'medium' };
const TEMPLATES = {
    investigation: { title: 'Investigate → verify', roles: ['orchestrator', 'investigator', 'reviewer'],
        workerRoles: ['investigator'], independent: 'all',
        instructions: 'Investigate a bounded question from source. State what would refute the hypothesis, gather discriminating evidence and negative controls, and obtain independent verification. A rejected conclusion returns to investigation. Do not turn this into a general audit.' },
    implementation: { title: 'Design → implement → review wave', roles: ['orchestrator', 'designer', 'worker', 'integrator', 'reviewer'],
        workerRoles: ['designer', 'worker', 'integrator'], independent: 'wave',
        instructions: 'Reuse applicable approved designs, or assign a designer to resolve the contract. Plan complete implementation packets with explicit dependencies. An integrator must compose the resulting wave against exact baselines. Independent review of each integrated wave is required. Component completion is not wave acceptance. No merge, deployment or scope expansion is implied by acceptance.' },
    solo: { title: 'Solo task → owner review', roles: ['orchestrator'], workerRoles: [], independent: 'owner',
        instructions: 'Work in this session only. Use the owner-selected project method and retain the original requirements and corrections. Submit a result with evidence for owner review. No delegated sessions.' },
};

function ensure(value, message) { if (!value) throw new Error(message); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, name, max = 12000) {
    ensure(typeof value === 'string' && value.trim() && value.length <= max, name + ' is required (max ' + max + ' characters)');
    return value.trim();
}
function inside(file, root) {
    const relative = path.relative(root, file);
    return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function directory(value) {
    ensure(typeof value === 'string' && path.isAbsolute(value), 'absolute workspace path required');
    const real = fs.realpathSync(value);
    ensure(fs.statSync(real).isDirectory(), 'workspace is not a directory');
    return real;
}
function reference(file, campaign) {
    const real = fs.realpathSync(file);
    if (campaign) ensure(campaign.workspaces.some(root => inside(real, root)) || inside(real, campaign.directory)
        || campaign.references.some(ref => ref.path === real), 'evidence is outside the approved workspace/references');
    const stat = fs.statSync(real);
    ensure(stat.isFile() && stat.size <= 32 * 1024 * 1024, 'reference must be a file of at most 32 MB');
    return { path: real, sha256: hash(fs.readFileSync(real)), bytes: stat.size };
}
function verify(ref) { ensure(reference(ref.path).sha256 === ref.sha256, 'referenced bytes changed: ' + ref.path); }
function writeImmutable(file, value) {
    if (fs.existsSync(file)) ensure(fs.readFileSync(file, 'utf8') === value, 'immutable evidence path already contains different bytes');
    else fs.writeFileSync(file, value, { flag: 'wx' });
}
function candidate(task) { return task.reviewCandidate || task.latest; }
function ready(campaign, task) { return task.dependsOn.every(id => campaign.tasks.find(t => t.id === id)?.status === 'accepted'); }
// Final acceptance is a second, narrower gate than implementation readiness: a
// packet may be built and reviewed while a task it defers to is still open. An
// absent field keeps legacy (schema 1) packets behaving exactly as before.
function acceptanceReady(campaign, task) {
    return (task.acceptanceDependsOn || []).every(id => campaign.tasks.find(t => t.id === id)?.status === 'accepted');
}
function active(session) { return ['starting', 'running', 'waiting'].includes(session.phase); }
// A queued or reserved session is not running yet (active() excludes 'queued'),
// but it already holds its attempt and workspace. Counting only active sessions
// let a queued worker be joined by a second writer in the same tree.
function writers(campaign) {
    return campaign.sessions.filter(session => session.kind === 'work' && (active(session) || session.phase === 'queued'));
}
function overlaps(root, cwd) { return inside(root, cwd) || inside(cwd, root); }
function writeConflict(campaign, cwd) { return writers(campaign).some(session => overlaps(session.cwd, cwd)); }
function participant(campaign, sid) { return campaign.sessions.find(session => session.id === sid); }
function independent(campaign, task) {
    return TEMPLATES[campaign.template].independent === 'all' || task.role === 'integrator';
}
function audit(campaign, kind, data) { campaign.events.push({ at: new Date().toISOString(), kind, ...data }); }

const fileVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

class Store {
    constructor(root) { this.root = root; this.cached = new Map(); this.directoryVersion = null; this.ids = []; }
    filename(id) { ensure(/^[a-f0-9]{16}$/.test(id), 'invalid campaign id'); return path.join(this.root, id, 'campaign.json'); }
    get(id) {
        const file = this.filename(id);
        // Stat on every access: external edits and atomic replacements are owner
        // controls, not data we may hide behind a polling TTL or last-good value.
        const version = fileVersion(fs.statSync(file, { bigint: true }));
        let cached = this.cached.get(id);
        if (!cached || cached.version !== version) {
            this.cached.delete(id);
            cached = { version, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
            this.cached.set(id, cached);
        }
        // Callers mutate their snapshot before write/change; they must never
        // mutate the cached persisted state through a borrowed nested object.
        return structuredClone(cached.value);
    }
    list() {
        let version;
        try { version = fileVersion(fs.statSync(this.root, { bigint: true })); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.directoryVersion = null; this.ids = []; this.cached.clear();
            return [];
        }
        if (version !== this.directoryVersion) {
            const ids = fs.readdirSync(this.root).filter(id => /^[a-f0-9]{16}$/.test(id));
            const present = new Set(ids);
            for (const id of this.cached.keys()) if (!present.has(id)) this.cached.delete(id);
            this.ids = ids; this.directoryVersion = version;
        }
        return this.ids.map(id => {
            try { return this.get(id); } catch (error) { return { id, title: id, mode: 'unreadable', error: error.message }; }
        });
    }
    write(campaign) {
        const file = this.filename(campaign.id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.new', JSON.stringify(campaign, null, 2));
        fs.renameSync(file + '.new', file);
        this.cached.delete(campaign.id);
        return campaign;
    }
    change(id, fn) {
        const campaign = this.get(id);
        const result = fn(campaign);
        campaign.revision++;
        campaign.updatedAt = new Date().toISOString();
        this.write(campaign);
        return result;
    }
    create(input) {
        ensure(TEMPLATES[input.template], 'unknown workflow');
        const root = directory(input.cwd);
        const id = crypto.randomBytes(8).toString('hex');
        const dir = path.join(this.root, id);
        const roles = {};
        for (const role of TEMPLATES[input.template].roles) {
            const binding = input.roles?.[role] || ROLE_MODEL;
            roles[role] = { model: text(binding.model, 'model', 120), effort: binding.effort || 'medium' };
            ensure(['low', 'medium', 'high', 'xhigh', 'max'].includes(roles[role].effort), 'invalid effort');
        }
        const workspaces = [...new Set([root, ...(input.workspaces || []).map(directory)])];
        const references = (input.references || []).map(file => reference(file));
        const policy = { maxConcurrent: Number(input.maxConcurrent || 2), maxDispatches: Number(input.maxDispatches || 16),
            maxAttempts: Number(input.maxAttempts || 3), maxTurns: Number(input.maxTurns || 12),
            allowWrites: input.allowWrites === true, allowShell: input.allowShell === true,
            autoContinue: input.autoContinue !== false };
        ensure(Number.isInteger(policy.maxConcurrent) && policy.maxConcurrent >= 1 && policy.maxConcurrent <= 2, 'concurrency must be 1 or 2');
        ensure(Number.isInteger(policy.maxDispatches) && policy.maxDispatches >= 1 && policy.maxDispatches <= 100, 'dispatch limit must be 1–100');
        ensure(Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= 10, 'attempt limit must be 1–10');
        ensure(Number.isInteger(policy.maxTurns) && policy.maxTurns >= 1 && policy.maxTurns <= 30, 'turn limit must be 1–30');
        const intent = text(input.intent, 'owner objective', 30000);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'owner-intent.md'), intent + '\n', { flag: 'wx' });
        const campaign = { schema: 1, id, directory: dir, title: text(input.title, 'campaign title', 160),
            cwd: root, workspaces, references, template: input.template, roles, policy,
            intent: reference(path.join(dir, 'owner-intent.md')), corrections: [],
            mode: 'draft', epoch: 0, revision: 0, dispatches: 0, planSealed: false,
            tasks: [], sessions: [], messages: [], commands: {}, events: [], pendingWake: false,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (input.template === 'solo') {
            campaign.tasks.push({ id: 'solo', title: campaign.title, brief: intent,
                criteria: input.criteria || intent, role: 'orchestrator', cwd: root, dependsOn: [], status: 'pending',
                requirementsVersion: 0, attempts: [], latest: null, retained: null, accepted: null, reviews: [], nativeTaskId: null });
            campaign.planSealed = true;
        }
        audit(campaign, 'created', { source: 'owner-ui' });
        return this.write(campaign);
    }
    bySession(sid) { return this.list().find(c => c.sessions?.some(s => s.id === sid)); }
    checked(campaign, sid, epoch) {
        const session = participant(campaign, sid);
        ensure(session, 'session is not assigned to this campaign');
        ensure(campaign.mode === 'active', 'campaign is ' + campaign.mode + '; checkpoint and finish the turn');
        ensure(epoch === campaign.epoch, 'owner control changed; call get before doing more work');
        return session;
    }
    once(campaign, key, payload, fn) {
        text(key, 'operation id', 160);
        const fingerprint = hash(JSON.stringify(payload));
        if (campaign.commands[key]) {
            ensure(campaign.commands[key].fingerprint === fingerprint, 'operation id reused with different inputs');
            return campaign.commands[key].result;
        }
        const result = fn();
        campaign.commands[key] = { fingerprint, result };
        return result;
    }
    plan(id, sid, input) {
        return this.change(id, c => {
            const actor = this.checked(c, sid, input.epoch);
            ensure(actor.kind === 'controller', 'only the campaign controller plans work');
            ensure(c.template !== 'solo', 'solo work does not dispatch task sessions');
            return this.once(c, input.operation_id, input, () => {
                ensure(!c.planSealed, 'plan is sealed');
                ensure(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 30, 'provide 1–30 complete work packets');
                const proposed = input.tasks.map(value => ({ id: text(value.id, 'task id', 60),
                    title: text(value.title, 'task title', 180), brief: text(value.brief, 'task brief', 16000),
                    criteria: text(value.criteria, 'acceptance criteria', 12000),
                    role: value.role, cwd: directory(value.cwd || c.cwd), dependsOn: value.depends_on || [],
                    status: 'pending', requirementsVersion: 0, attempts: [], latest: null, retained: null,
                    accepted: null, reviews: [], nativeTaskId: value.native_task_id || null,
                    // Written only when the plan actually declares a final-acceptance
                    // gate, so a legacy packet keeps the exact schema-1 shape.
                    ...(value.acceptance_depends_on !== undefined ? { acceptanceDependsOn: value.acceptance_depends_on } : {}) }));
                const all = [...c.tasks, ...proposed];
                ensure(new Set(all.map(t => t.id)).size === all.length, 'duplicate task id');
                for (const task of all) {
                    ensure(TEMPLATES[c.template].workerRoles.includes(task.role), 'role is not allowed by this workflow');
                    ensure(c.workspaces.includes(task.cwd), 'task workspace was not approved by the owner');
                    ensure(Array.isArray(task.dependsOn) && task.dependsOn.every(id => all.some(t => t.id === id)), 'unknown dependency');
                    ensure(task.acceptanceDependsOn === undefined || Array.isArray(task.acceptanceDependsOn), 'dependencies must be arrays');
                    ensure((task.acceptanceDependsOn || []).every(id => all.some(t => t.id === id)), 'unknown dependency');
                    const walk = (id, parents) => {
                        ensure(!parents.includes(id), 'dependency cycle');
                        const task = all.find(t => t.id === id);
                        for (const dep of [...task.dependsOn, ...(task.acceptanceDependsOn || [])]) walk(dep, [...parents, id]);
                    };
                    walk(task.id, []);
                }
                if (input.seal && c.template === 'implementation') ensure(all.some(t => t.role === 'integrator'), 'an implementation campaign requires an independently reviewed integrated wave');
                c.tasks = all;
                c.planSealed = input.seal === true;
                audit(c, 'planned', { sessionId: sid, tasks: proposed.map(t => t.id), sealed: c.planSealed });
                return { tasks: proposed.map(t => t.id), sealed: c.planSealed };
            });
        });
    }
    reserve(id, sid, input) {
        return this.change(id, c => {
            if (sid) ensure(this.checked(c, sid, input.epoch).kind === 'controller', 'delegation is restricted to the controller');
            else ensure(c.mode === 'active', 'campaign is not active');
            return this.once(c, input.operation_id, { ...input, actor: sid }, () => {
                ensure(c.dispatches < c.policy.maxDispatches, 'dispatch budget exhausted; owner action required');
                const defer = c.sessions.filter(active).length >= c.policy.maxConcurrent;
                ensure(!defer || (sid && active(participant(c, sid)) && !c.sessions.some(s => s.phase === 'queued')),
                    'capacity reached; checkpoint and yield');
                let task = null;
                const kind = input.kind || 'work';
                ensure(['controller', 'work', 'review'].includes(kind), 'invalid session role');
                let role = 'orchestrator';
                if (kind === 'controller') {
                    ensure(!c.sessions.some(s => s.kind === 'controller'), 'controller already exists; resume its session');
                    if (c.template === 'solo') task = c.tasks[0];
                }
                else {
                    task = c.tasks.find(t => t.id === input.task_id);
                    ensure(task, 'unknown task');
                    ensure(ready(c, task), 'dependencies have not been accepted');
                    if (kind === 'review') {
                        ensure(task.status === 'submitted', 'no submitted result to review');
                        ensure(!c.sessions.some(s => s.taskId === task.id && s.kind === 'work' && active(s)), 'worker has not finished its turn');
                        ensure(independent(c, task), 'controller can review this intermediate result directly');
                        role = 'reviewer';
                        ensure(!c.sessions.some(s => s.taskId === task.id && s.kind === 'review' && active(s)), 'review is already running');
                    } else {
                        ensure(['pending', 'rejected'].includes(task.status), 'task is already owned or needs reconciliation');
                        ensure(task.attempts.length < c.policy.maxAttempts, 'task attempt budget exhausted');
                        role = task.role;
                        // A queued/reserved writer already owns its attempt, and a
                        // nested source root is still the same tree, so both count.
                        if (c.policy.allowWrites) ensure(!writeConflict(c, task.cwd), 'another writer owns this workspace or an overlapping one');
                    }
                }
                const session = { id: 'local_' + crypto.randomUUID(), role, kind, taskId: task?.id || null,
                    cwd: task?.cwd || c.cwd, phase: defer ? 'queued' : 'starting', epoch: c.epoch, seenEpoch: null,
                    launchAt: Date.now(), model: c.roles[role].model, effort: c.roles[role].effort,
                    resultId: kind === 'review' ? candidate(task).id : null,
                    requirementsVersion: task?.requirementsVersion || 0, reported: false };
                if (task && (kind === 'work' || c.template === 'solo')) {
                    const attempt = { id: crypto.randomUUID(), sessionId: session.id, epoch: c.epoch,
                        requirementsVersion: task.requirementsVersion, state: 'submission_unknown', createdAt: Date.now() };
                    task.attempts.push(attempt);
                    task.status = 'running';
                    session.attemptId = attempt.id;
                }
                c.sessions.push(session);
                c.dispatches++;
                audit(c, 'dispatch-reserved', { sessionId: session.id, role, taskId: session.taskId });
                return clone(session);
            });
        });
    }
    markSession(id, sid, phase, reason) {
        return this.change(id, c => {
            const session = participant(c, sid);
            ensure(session, 'unknown session');
            session.phase = phase;
            session.lastEventAt = Date.now();
            if (reason) session.reason = reason;
            if (phase === 'running' && session.attemptId) {
                const task = c.tasks.find(t => t.id === session.taskId);
                const attempt = task.attempts.find(a => a.id === session.attemptId);
                if (attempt.state === 'submission_unknown') attempt.state = 'running';
            }
            if (['idle', 'unavailable'].includes(phase) && session.taskId) {
                const task = c.tasks.find(t => t.id === session.taskId);
                if (task?.status === 'running') {
                    if (phase === 'idle' && session.checkpoint && !session.checkpoint.blocked) session.phase = 'waiting';
                    else task.status = 'interrupted';
                }
                c.pendingWake = session.phase !== 'waiting' && c.template !== 'solo';
            }
            audit(c, 'session-' + phase, { sessionId: sid, reason });
            return clone(session);
        });
    }
    submit(id, sid, input) {
        return this.change(id, c => {
            const session = participant(c, sid);
            ensure(session && (session.kind === 'work' || c.template === 'solo'), 'only the assigned worker submits this result');
            const task = c.tasks.find(t => t.id === session.taskId);
            const body = text(input.summary, 'result and verification', 50000);
            const evidence = (input.evidence_paths || []).map(file => reference(file, c));
            ensure(evidence.length > 0, 'attach actual source/test/evidence files');
            const fingerprint = hash(JSON.stringify({ body, evidence }));
            const prior = task.attempts.find(a => a.id === session.attemptId);
            if (prior.result) { ensure(prior.result.fingerprint === fingerprint, 'attempt already has a different result'); return prior.result; }
            const dir = path.join(c.directory, 'results');
            fs.mkdirSync(dir, { recursive: true });
            const output = path.join(dir, session.attemptId + '.md');
            writeImmutable(output, body + '\n');
            const result = { id: session.attemptId, fingerprint, summary: body, report: reference(output), evidence,
                sessionId: sid, requirementsVersion: session.requirementsVersion, at: Date.now() };
            prior.result = result;
            prior.state = 'result_received';
            task.latest = result;
            task.reviewCandidate = result;
            task.status = 'submitted';
            session.reported = true;
            if (input.native_task_id) task.nativeTaskId = input.native_task_id;
            audit(c, 'result-submitted', { sessionId: sid, taskId: task.id, resultId: result.id, late: c.mode !== 'active' });
            return { resultId: result.id, next: 'End this turn. Acceptance is still pending review.' };
        });
    }
    review(id, sid, input, owner = false) {
        return this.change(id, c => {
            ensure(c.mode === 'active', 'campaign is not active');
            const task = c.tasks.find(t => t.id === input.task_id);
            ensure(task?.latest, 'task has no submitted result');
            const target = candidate(task);
            if (!owner) {
                ensure(c.template !== 'solo', 'solo output requires owner review');
                const session = this.checked(c, sid, input.epoch);
                if (independent(c, task)) ensure(session.kind === 'review' && session.taskId === task.id && session.resultId === input.result_id, 'this task requires its independent reviewer');
                else ensure(session.kind === 'controller' || session.kind === 'review', 'review role required');
                ensure(target.sessionId !== sid, 'producer cannot approve its own result');
            }
            ensure(input.result_id === target.id, 'review targets an obsolete result');
            ensure(input.requirements_version === task.requirementsVersion, 'review targets obsolete requirements');
            ensure(['accept', 'reject'].includes(input.decision), 'review decision must be accept or reject');
            const reason = text(input.reason, 'review reasoning', 16000);
            const prior = task.reviews.find(r => r.resultId === input.result_id && r.requirementsVersion === input.requirements_version);
            if (prior) { ensure(prior.decision === input.decision && prior.reason === reason, 'this result already has a review decision'); return prior; }
            ensure(task.status === 'submitted', 'result is not ready for acceptance');
            // Acceptance carries the full gate: implementation dependencies must be
            // met, the declared final-acceptance dependency must be met, and the
            // exact evidenced bytes must still be present. A rejection is cheaper
            // on purpose: a broken candidate whose dependencies or evidence are
            // themselves the defect must still be sendable back for repair.
            if (input.decision === 'accept') {
                ensure(ready(c, task), 'dependencies have not been accepted');
                ensure(acceptanceReady(c, task), 'final acceptance dependencies have not been accepted');
                verify(target.report);
                for (const ref of target.evidence) verify(ref);
            }
            const decision = { reviewer: owner ? 'owner' : sid, resultId: target.id, requirementsVersion: task.requirementsVersion,
                decision: input.decision, reason, evidence: target.evidence, at: Date.now() };
            task.reviews.push(decision);
            task.status = input.decision === 'accept' ? 'accepted' : 'rejected';
            if (input.decision === 'accept') { task.accepted = target; if (!task.retained) task.retained = target; }
            if (sid) participant(c, sid).reported = true;
            c.pendingWake = c.template !== 'solo';
            audit(c, 'review-' + input.decision, { sessionId: sid || 'owner', taskId: task.id, resultId: target.id, reason });
            if (c.planSealed && c.tasks.length && c.tasks.every(t => t.status === 'accepted')) { c.mode = 'completed'; c.pendingWake = false; }
            return decision;
        });
    }
    control(id, action, input = {}) {
        return this.change(id, c => {
            ensure(['start', 'pause', 'resume', 'stop', 'correct', 'retry', 'retain', 'select', 'limits'].includes(action), 'invalid owner action');
            if (action === 'start') { ensure(c.mode === 'draft', 'campaign already started'); c.mode = 'active'; }
            if (action === 'pause') { ensure(c.mode === 'active', 'campaign is not active'); c.mode = 'paused'; }
            if (action === 'resume') { ensure(c.mode === 'paused', 'only paused campaigns resume'); c.mode = 'active'; }
            if (action === 'stop') { ensure(c.mode !== 'stopped', 'campaign already stopped'); c.mode = 'stopped'; }
            if (action === 'correct') {
                ensure(c.mode !== 'stopped', 'stopped campaign is immutable');
                const body = text(input.text, 'owner correction', 30000);
                const file = path.join(c.directory, 'correction-' + hash(body).slice(0, 20) + '.md');
                writeImmutable(file, body + '\n');
                const affected = new Set(input.task_ids?.length ? input.task_ids : c.tasks.map(t => t.id));
                ensure([...affected].every(id => c.tasks.some(t => t.id === id)), 'unknown correction target');
                for (let changed = true; changed;) {
                    changed = false;
                    for (const task of c.tasks) if (!affected.has(task.id)
                        && [...task.dependsOn, ...(task.acceptanceDependsOn || [])].some(id => affected.has(id))) { affected.add(task.id); changed = true; }
                }
                c.corrections.push({ reference: reference(file), taskIds: [...affected], at: Date.now() });
                for (const task of c.tasks) if (affected.has(task.id)) {
                    task.requirementsVersion++;
                    task.accepted = null;
                    if (task.latest) task.status = 'submitted';
                }
                if (c.mode === 'completed') c.mode = 'paused';
                c.pendingWake = c.mode === 'active';
            }
            if (action === 'retry') {
                const task = c.tasks.find(t => t.id === input.task_id);
                ensure(task && ['interrupted', 'blocked'].includes(task.status), 'only unresolved tasks require owner reconciliation');
                ensure(!c.sessions.some(s => s.taskId === task.id && active(s)), 'session is still active');
                task.reconciliation = text(input.reason, 'reconciliation evidence/reason', 16000);
                task.status = 'pending';
                c.pendingWake = true;
            }
            if (action === 'retain') {
                const task = c.tasks.find(t => t.id === input.task_id);
                ensure(task?.latest, 'no result to retain');
                task.retained = task.latest;
            }
            if (action === 'select') {
                const task = c.tasks.find(t => t.id === input.task_id);
                ensure(task && task.status !== 'accepted', 'accepted work requires an owner correction before reopening');
                ensure(!c.sessions.some(s => s.taskId === task.id && active(s)), 'task still has an active session');
                const result = task.attempts.map(a => a.result).find(r => r?.id === input.result_id);
                ensure(result, 'unknown retained result');
                verify(result.report);
                for (const ref of result.evidence) verify(ref);
                task.reviewCandidate = result;
                task.status = 'submitted';
                c.pendingWake = c.template !== 'solo';
            }
            if (action === 'limits') {
                ensure(Number.isInteger(input.max_dispatches) && input.max_dispatches >= c.dispatches && input.max_dispatches <= 100, 'invalid dispatch budget');
                c.policy.maxDispatches = input.max_dispatches;
            }
            c.epoch++;
            audit(c, 'owner-' + action, { source: 'owner-ui', taskId: input.task_id || null });
            return clone(c);
        });
    }
    view(id, sid) {
        let c = this.get(id);
        verify(c.intent);
        for (const correction of c.corrections) verify(correction.reference);
        if (sid) {
            this.change(id, value => {
                const s = participant(value, sid); ensure(s, 'session is not assigned'); s.seenEpoch = value.epoch;
                if (s.phase === 'starting') s.phase = 'running';
                if (s.taskId) s.requirementsVersion = value.tasks.find(t => t.id === s.taskId).requirementsVersion;
            });
            c = this.get(id);
        }
        const actor = sid ? participant(c, sid) : null;
        const tasks = c.tasks.map(t => ({ ...t, ready: ready(c, t), acceptanceReady: acceptanceReady(c, t), independentReview: independent(c, t) }));
        return { ...c, tasks, actor, workflow: TEMPLATES[c.template],
            next: this.next(c, actor), remainingDispatches: c.policy.maxDispatches - c.dispatches };
    }
    next(c, actor) {
        if (c.mode !== 'active') return c.mode;
        if (!actor) return 'owner-controls';
        if (c.template === 'solo') return actor.reported ? 'await-owner-review' : 'work-and-submit';
        if (actor.kind !== 'controller') return actor.reported ? 'finish-turn' : (actor.kind === 'review' ? 'review-result' : 'work-and-submit');
        if (c.tasks.some(t => t.status === 'submitted' && ready(c, t) && acceptanceReady(c, t))) return 'review-or-dispatch-review';
        if (c.tasks.some(t => ['pending', 'rejected'].includes(t.status) && ready(c, t))) return 'dispatch-ready-work';
        if (c.tasks.some(t => ['interrupted', 'blocked'].includes(t.status))) return 'reconcile-existing-assignment-or-report-blocker';
        if (c.tasks.some(t => t.status === 'running')) return 'checkpoint-and-yield';
        if (!c.planSealed) return 'plan-ready-work';
        return 'checkpoint-and-yield';
    }
}

module.exports = { Store, TEMPLATES, ROLE_MODEL, inside, directory, reference, verify, ready, acceptanceReady, active, participant, ensure, text, hash };
