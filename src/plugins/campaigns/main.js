'use strict';
const fs = require('fs');
const path = require('path');
const { Store, TEMPLATES, inside, ensure, text, reference, hash } = require('./core');
const { NativeStore, ACTIVE, TERMINAL } = require('./native-core');
const { verifyRevision, fingerprint } = require('./revision');
const { sdkServer } = require('./sdk-server');
const { addHooks, installQuery, serversOf } = require('./native-hooks');
const { readReceipts } = require('./native-receipts');

const KEY = Symbol.for('cuimod.campaigns');
const SERVER = 'campaign';
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' }, number = { type: 'integer' }, boolean = { type: 'boolean' };
const strings = { type: 'array', items: string };
const packet = object({ id: string, title: string, brief: string, criteria: string, role: string, cwd: string,
    source_roots: strings, write_roots: strings, input_paths: strings, depends_on: strings,
    acceptance_depends_on: strings, required_checks: strings, native_task_id: string }, ['id', 'title', 'brief', 'criteria']);
const TOOLS = [
    { name: 'get', description: 'Read the attached campaign, verbatim original owner instructions and corrections, native ownership, unfinished work and independently ready queues. Call first after attachment, interruption or compaction. A native worker finishing does not accept its package.', inputSchema: object({}) },
    { name: 'plan', description: 'Record complete packages without launching agents. depends_on gates implementation; acceptance_depends_on gates only final acceptance. Keep independent work ready. Seal when all required packages, including integration, are represented.', inputSchema: object({ epoch: number, operation_id: string, seal: boolean, tasks: { type: 'array', items: packet } }, ['epoch', 'operation_id', 'tasks']) },
    { name: 'claim', description: 'Atomically reserve one ready package and its source roots. Returns the exact native Agent call to make next. This is a reservation, not a spawned agent. Concurrency counts active native agents, never lifetime launches. kind=review reserves an independent reviewer.', inputSchema: object({ epoch: number, operation_id: string, task_id: string, kind: { type: 'string', enum: ['work', 'review'] } }, ['epoch', 'operation_id', 'task_id']) },
    { name: 'resume', description: 'Reconcile and resume an unfinished assignment in the SAME native agent and attempt. Returns a native SendMessage call. Unknown or still-running writers cannot be replaced. Root owner controls are separate from peer requests.', inputSchema: object({ epoch: number, operation_id: string, claim_id: string }, ['epoch', 'operation_id', 'claim_id']) },
    { name: 'checkpoint', description: 'Preserve the exact next action, blocker and external job identities before yielding. This never accepts a package. An interrupted assignment retains its ownership until reconciliation.', inputSchema: object({ note: string, blocked: boolean, jobs: { type: 'array', items: object({ id: string, state: string, description: string }, ['id', 'state']) } }, ['note']) },
    { name: 'submit', description: 'Freeze a candidate against its actual Git/working-tree/source-input revision, report and evidence. List all unrun required work. Remain read-only after submitting; independent review and observed verification are still required.', inputSchema: object({ summary: string, evidence_paths: strings, unrun: strings }, ['summary', 'evidence_paths']) },
    { name: 'prepare_check', description: 'Prepare revision-specific verification through the native Bash or Read tool. Returns the exact tool call. Executable checks retain native exit, stdout/stderr and required terminal markers; a missing tail is incomplete. Use the project sanctioned build command. An unaccepted candidate may be checked. Inspection uses read_path and proves only that read, never runtime behavior.', inputSchema: object({ epoch: number, operation_id: string, checkpoint_id: string, kind: { type: 'string', enum: ['build', 'test', 'inspection', 'integration', 'performance'] }, production_path: string,
        executable: string, args: strings, cwd: string, read_path: string, success_markers: strings, completion_files: strings, artifacts: strings, timeout: number, background: boolean }, ['epoch', 'operation_id', 'checkpoint_id', 'kind', 'production_path']) },
    { name: 'verify', description: 'Collect an observed native check receipt for a prepared check. Rehash its source and output evidence. Running/missing/changed results cannot pass. This records verification; it does not accept the package.', inputSchema: object({ check_id: string }, ['check_id']) },
    { name: 'review', description: 'Assigned independent reviewer: inspect the actual candidate, requirements, production path and exact verification scope. Accept only this revision with required proof; reject with a concrete repair action. Rejection does not wait for dependencies or passing checks. Acceptance never authorizes commit, merge or deployment.', inputSchema: object({ epoch: number, task_id: string, checkpoint_id: string, decision: { type: 'string', enum: ['accept', 'reject'] }, reason: string }, ['epoch', 'task_id', 'checkpoint_id', 'decision', 'reason']) },
];
const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const READBACK = new Set(['get', 'checkpoint', 'submit', 'verify']);
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
function realTarget(file) {
    const missing = [];
    let ancestor = file;
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        ensure(parent !== ancestor, 'target has no existing ancestor');
        missing.unshift(path.basename(ancestor)); ancestor = parent;
    }
    return path.join(fs.realpathSync(ancestor), ...missing);
}

// Workers write the evidence, and a prompt-injected worker can write a .bat
// or .lnk as easily as a log. Only inert types open on click; anything else
// is revealed in Explorer for the user to judge.
const INERT = new Set(['.txt', '.md', '.log', '.json', '.jsonl', '.csv', '.tsv', '.png', '.jpg', '.jpeg',
    '.gif', '.webp', '.bmp', '.pdf', '.mp4', '.webm', '.wav', '.mp3']);
const opensDirectly = file => INERT.has(path.extname(String(file || '')).toLowerCase());

module.exports = function (ctx) {
    const ownerToken = {};
    const old = globalThis[KEY];
    if (old && old.version !== 2) {
        // Retire only the old campaign wrappers. Other plugins retain their own
        // hooks, provider routing and session-manager integrations.
        if (old.manager && String(old.manager.buildStartSdkOptions).includes('refusing unmanaged campaign spawn')) {
            old.manager.buildStartSdkOptions = old.originalBuild;
            if (String(old.manager.stopSession).includes('state.stopping.has')) old.manager.stopSession = old.originalStop;
            if (String(old.manager.interruptSession).includes('state.stopping.has')) old.manager.interruptSession = old.originalInterrupt;
        }
        old.owner = ownerToken; old.api = null;
    }
    const state = old?.version === 2 ? old : { version: 2, bindings: new Map(), calls: new Map(), hooks: new Map(),
        servers: new Map(), installed: new WeakSet(), pending: new Map(), attaching: new Map(), refreshing: new Set(), manager: null,
        originalBuild: null, originalStop: null, originalInterrupt: null, originalSend: null, listener: null };
    globalThis[KEY] = state;
    state.owner = ownerToken;
    const store = new NativeStore(path.join(ctx.boot.MOD_DIR, '.state', 'campaigns'));
    const legacy = new Store(store.root);
    const runnerPath = path.join(ctx.dir, 'check-runner.js');
    let disposed = false;

    function manager() {
        if (state.manager?.sessions) return state.manager;
        for (const item of Object.values(require.cache)) {
            const candidate = item.exports?.claudeCodeSessionManager;
            if (candidate?.sessions && typeof candidate.buildStartSdkOptions === 'function') return state.manager = candidate;
        }
        return null;
    }
    function changed(id) { ctx.broadcast({ type: 'campaigns-changed', campaignId: id }); }
    function binding(sid) {
        const known = state.bindings.get(sid);
        if (known) return known;
        const found = store.list().find(c => c.root?.desktopSessionId === sid || (c.schema === 1 && c.sessions?.some(s => s.id === sid)));
        if (found) { state.bindings.set(sid, found.id); return found.id; }
        return null;
    }
    for (const c of store.list()) {
        if (c.root?.desktopSessionId) state.bindings.set(c.root.desktopSessionId, c.id);
        else if (c.schema === 1) for (const session of c.sessions || []) state.bindings.set(session.id, c.id);
    }
    function metaFor(input, agentId) {
        ensure(/^[A-Za-z0-9_-]+$/.test(agentId), 'invalid native agent identity');
        ensure(typeof input.transcript_path === 'string' && typeof input.session_id === 'string', 'native transcript identity missing');
        const base = path.dirname(input.transcript_path);
        const directory = path.basename(base) === 'subagents' ? base : path.join(base, input.session_id, 'subagents');
        return { ...JSON.parse(fs.readFileSync(path.join(directory, 'agent-' + agentId + '.meta.json'), 'utf8')),
            transcriptPath: path.join(directory, 'agent-' + agentId + '.jsonl') };
    }
    function identity(sid, input) {
        const id = binding(sid);
        if (!id) return null;
        const c = store.get(id);
        if (c.schema === 1) return { id, actor: sid, legacy: true };
        if (c.root.cliSessionId && input.session_id && c.root.cliSessionId !== input.session_id) throw Error('campaign root CLI identity changed; pause and reconcile the original agents');
        if (!input.agent_id) {
            if (input.transcript_path && c.root.transcriptPath !== input.transcript_path) store.change(id, value => {
                value.root.transcriptPath = input.transcript_path;
                value.root.receiptOffset = fs.existsSync(input.transcript_path) ? fs.statSync(input.transcript_path).size : 0;
                value.root.receiptVersion = 2;
            });
            return { id, actor: 'root', legacy: false };
        }
        let claim = c.claims.findLast(value => value.agentId === input.agent_id && (ACTIVE.has(value.phase) || !value.ownershipReleased));
        if (!claim) {
            const meta = metaFor(input, input.agent_id);
            claim = c.claims.find(value => value.toolUseId === meta.toolUseId && value.agentName === meta.name && value.profile === meta.agentType);
            ensure(claim, 'native agent has no matching campaign launch receipt');
            store.bindAgent(id, claim.id, input.agent_id);
            store.change(id, value => { value.claims.find(item => item.id === claim.id).transcriptPath = meta.transcriptPath; });
            claim.transcriptPath = meta.transcriptPath;
        }
        if (!claim.transcriptPath) {
            const meta = metaFor(input, input.agent_id);
            store.change(id, value => { value.claims.find(item => item.id === claim.id).transcriptPath = meta.transcriptPath; });
        }
        if (claim.phase === 'finishing') store.change(id, value => { value.claims.find(item => item.id === claim.id).phase = 'running'; });
        return { id, actor: claim.id, legacy: false };
    }
    function legacyView(id, sid) {
        const c = legacy.view(id, sid);
        return { ...c, intentText: fs.readFileSync(c.intent.path, 'utf8'),
            corrections: c.corrections.map(value => ({ ...value, text: fs.readFileSync(value.reference.path, 'utf8') })) };
    }
    function legacyGuard(id, sid, input) {
        const c = legacy.get(id), actor = c.sessions.find(s => s.id === sid);
        if (input.tool_name === 'mcp__campaign__get') return {};
        if (c.mode !== 'active' || actor?.seenEpoch !== c.epoch) return deny('Read campaign.get before further work. This legacy campaign is preserved for inspection.');
        if (['Read', 'Grep', 'Glob'].includes(input.tool_name)) return {};
        return deny('Legacy campaign execution is retired. Create a native-agent campaign to continue work.');
    }
    function guard(sid, input) {
        if (input.hook_event_name !== 'PreToolUse') return {};
        if (!binding(sid)) return {};
        try {
            const who = identity(sid, input);
            if (who.legacy) return legacyGuard(who.id, sid, input);
            const c = store.get(who.id), actor = store.actor(c, who.actor);
            const tool = input.tool_name, args = input.tool_input || {};
            const ownTool = tool.startsWith('mcp__campaign__') ? tool.slice('mcp__campaign__'.length) : null;
            if (input.tool_use_id) state.calls.set(sid + ':' + input.tool_use_id, { ...who, nativeAgentId: input.agent_id || null,
                tool, fingerprint: hash(JSON.stringify(args)), at: Date.now() });
            if (ownTool && READBACK.has(ownTool)) return {};
            if (actor.kind === 'root' && c.mode === 'completed') return {};
            if (c.mode !== 'active') return deny('Campaign is ' + c.mode + '. Preserve a checkpoint; only owner control can resume it.');
            const seen = actor.kind === 'root' ? c.root.seenEpoch : actor.seenEpoch;
            if (seen !== c.epoch) return deny('Read campaign.get to recover the exact current owner instructions before acting.');
            if (ownTool) return {};
            if (tool === 'Agent') {
                const launch = store.authorizeSpawn(who.id, who.actor, args, input.tool_use_id);
                return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, prompt: launch.prompt } } };
            }
            if (tool === 'SendMessage') {
                if (args.to === 'main' && actor.kind !== 'root') return {};
                const target = c.claims.findLast(value => value.agentId === args.to || value.agentName === args.to);
                ensure(target, 'recipient is outside the campaign native tree');
                ensure(ACTIVE.has(target.phase), 'recipient is terminal; use campaign.resume for unfinished work instead of waking it with an acknowledgement');
                if (target.phase === 'resuming') {
                    const message = store.authorizeResume(who.id, who.actor, args, input.tool_use_id);
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...args, message } } };
                }
                return {};
            }
            if (['Workflow', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'EnterWorktree', 'ExitWorktree'].includes(tool)
                || tool.startsWith('mcp__ccd_directory__')) return deny('Use the campaign native assignments and the approved existing workspaces.');
            if (tool === 'TaskStop') {
                const target = c.claims.find(value => value.agentId === (args.task_id || args.shell_id));
                ensure(actor.kind === 'root' || actor.kind === 'coordinator', 'only the coordinator controls native tasks');
                ensure(target, 'task is outside the campaign');
                return {};
            }
            if (FILE_TOOLS.has(tool)) {
                const raw = args.file_path || args.path || input.cwd;
                const file = path.resolve(input.cwd || c.cwd, raw);
                const real = realTarget(file);
                if (WRITE_TOOLS.has(tool)) {
                    ensure(actor.kind === 'work' && c.policy.allowWrites, 'this role has no source-write assignment');
                    const task = c.tasks.find(value => value.id === actor.taskId);
                    ensure(task.status === 'running', 'candidate is frozen; repair requires a new reviewed assignment');
                    ensure(actor.writeRoots.some(root => inside(real, root)), 'write is outside the claimed source roots');
                    ensure(!inside(real, c.directory) && !real.split(path.sep).some(part => ['.git', '.claude'].includes(part.toLowerCase())), 'campaign and repository control records are not worker output');
                    ensure(!Object.values(c.checkRequests || {}).some(check => check.state === 'running' && check.taskId === actor.taskId), 'this source revision is being checked; finish or reconcile that check before editing');
                } else {
                    ensure(c.workspaces.some(root => inside(real, root)) || inside(real, c.directory)
                        || c.references.some(ref => ref.path === real), 'read is outside the approved workspace and reference set');
                }
            }
            if (tool === 'Bash') {
                ensure(c.policy.allowShell, 'owner has not authorized shell work for this campaign');
                const prepared = Object.values(c.checkRequests || {}).find(check => check.claimId === who.actor
                    && check.state === 'armed' && check.action.input.command === args.command);
                ensure(actor.kind === 'work' || prepared || actor.kind === 'root', 'review/coordinator shell work must be a prepared verification');
                if (actor.kind === 'work') {
                    const task = c.tasks.find(value => value.id === actor.taskId);
                    ensure(task.status === 'running' || prepared, 'candidate is frozen; only its prepared verification may run');
                }
            }
            if (tool === 'Bash' || tool === 'Read') store.observeCheckStart(who.id, who.actor, input);
            return {};
        } catch (error) { return deny(error.message); }
    }
    function onPost(sid, input) {
        const id = binding(sid);
        if (!id || store.get(id).schema !== 2) return {};
        try {
            const c = store.get(id);
            if (input.tool_name === 'Agent') {
                const claim = c.claims.find(value => value.toolUseId === input.tool_use_id);
                const result = input.tool_response;
                const agentId = result?.agentId || result?.agent_id;
                if (claim && agentId) store.bindAgent(id, claim.id, agentId);
            }
            const request = Object.values(c.checkRequests || {}).find(check => check.toolUseId === input.tool_use_id && check.state === 'running');
            if (request && input.tool_name === 'Read') {
                const output = path.join(request.directory, 'result.json');
                fs.writeFileSync(output, JSON.stringify({ version: 1, id: request.id, sourceRevision: request.sourceRevision,
                    terminal: true, exitCode: 0, status: 'passed', tool: 'Read', input: input.tool_input,
                    scope: 'Native file read only; no runtime behavior claimed.', at: Date.now() }, null, 2));
            }
            changed(id);
        } catch (error) { ctx.log('campaign native receipt: ' + error.message); }
        return {};
    }
    function onFailure(sid, input) {
        const id = binding(sid);
        if (!id || store.get(id).schema !== 2) return {};
        const c = store.get(id);
        const claim = c.claims.find(value => value.toolUseId === input.tool_use_id);
        if (claim && input.tool_name === 'Agent') store.change(id, value => {
            const pending = value.claims.find(item => item.id === claim.id);
            pending.phase = 'unknown'; pending.reason = 'Native launch failed without a reconciled terminal receipt: ' + String(input.error || 'unknown');
        });
        changed(id);
        return {};
    }
    function onStart(sid, input) {
        try { if (input.agent_id && binding(sid)) identity(sid, input); }
        catch (error) { ctx.log('campaign start awaiting native metadata: ' + error.message); }
        return {};
    }
    function onStop(sid, input) {
        const id = binding(sid);
        if (!id || store.get(id).schema !== 2 || !input.agent_id) return {};
        if (Array.isArray(input.background_tasks) && input.background_tasks.length) return {};
        store.change(id, c => {
            const claim = c.claims.findLast(value => value.agentId === input.agent_id && ACTIVE.has(value.phase));
            if (!claim) return;
            claim.phase = 'finishing';
            if (claim.kind === 'coordinator' && input.agent_transcript_path) {
                claim.transcriptPath = input.agent_transcript_path;
                claim.receiptOffset ||= 0;
            }
        });
        changed(id);
        return {};
    }
    function drainReceipts(id) {
        const c = store.get(id);
        if (c.schema !== 2) return;
        const sources = [c.root, ...c.claims.filter(claim => claim.kind === 'coordinator')].filter(source => source?.transcriptPath);
        for (const source of sources) {
            if (!fs.existsSync(source.transcriptPath)) continue;
            const offset = source.receiptVersion === 2 ? (source.receiptOffset || 0) : 0;
            let read = readReceipts(source.transcriptPath, offset);
            if (read.needsMore) read = readReceipts(source.transcriptPath, offset, 16 * 1024 * 1024);
            for (const receipt of read.receipts) {
                const current = store.get(id);
                const claim = current.claims.findLast(value => (value.agentId === receipt.agentId || (!value.agentId && value.activeToolUseId === receipt.toolUseId)) && ACTIVE.has(value.phase));
                if (!claim || receipt.toolUseId !== claim.activeToolUseId || receipt.at < (claim.activeSince || 0) || claim.lastReceiptId === receipt.id) continue;
                if (!claim.agentId) store.bindAgent(id, claim.id, receipt.agentId);
                store.finishAgent(id, receipt.agentId, receipt.status === 'completed' ? 'finished' : receipt.status === 'killed' ? 'cancelled' : 'failed', receipt.status);
                store.change(id, value => { value.claims.find(item => item.id === claim.id).lastReceiptId = receipt.id; });
                changed(id);
            }
            if (read.offset !== (source.receiptOffset || 0) || source.receiptVersion !== 2) store.change(id, value => {
                const current = source === c.root ? value.root : value.claims.find(claim => claim.id === source.id);
                current.receiptOffset = read.offset; current.receiptVersion = 2;
            });
        }
    }
    function onCompact(sid, input) {
        const id = binding(sid);
        if (!id || store.get(id).schema !== 2) return {};
        store.change(id, c => {
            if (input.agent_id) {
                const claim = c.claims.findLast(value => value.agentId === input.agent_id);
                if (claim) claim.seenEpoch = null;
            } else c.root.seenEpoch = null;
            c.events.push({ at: new Date().toISOString(), kind: 'native-compaction', agentId: input.agent_id || null,
                event: input.hook_event_name, source: 'native-hook' });
        });
        changed(id);
        return {};
    }
    function hooksFor(sid) {
        if (!state.hooks.has(sid)) {
            const relay = name => input => state.api ? state.api[name](sid, input) : deny('Campaign plugin is unavailable.');
            state.hooks.set(sid, { PreToolUse: [{ matcher: '.*', hooks: [relay('guard')] }],
                PostToolUse: [{ matcher: '.*', hooks: [relay('onPost')] }],
                PostToolUseFailure: [{ matcher: '.*', hooks: [relay('onFailure')] }],
                SubagentStart: [{ hooks: [relay('onStart')] }], SubagentStop: [{ hooks: [relay('onStop')] }],
                PreCompact: [{ hooks: [relay('onCompact')] }], PostCompact: [{ hooks: [relay('onCompact')] }] });
        }
        return state.hooks.get(sid);
    }
    function agentView(id, actor) {
        const c = store.viewNative(id, actor);
        if (actor === 'root' && c.root.seenEpoch !== c.epoch) store.change(id, value => {
            value.root.seenEpoch = value.epoch;
            value.events.push({ at: new Date().toISOString(), kind: 'instructions-read', actor: 'root', epoch: value.epoch, intentSha256: value.intent.sha256 });
        });
        const taskId = c.actor?.taskId;
        const selected = taskId ? c.tasks.find(task => task.id === taskId) : null;
        const visibleCheckpoints = Object.fromEntries(Object.entries(c.checkpoints).filter(([, value]) => !taskId || value.taskId === taskId));
        const visibleChecks = Object.fromEntries(Object.entries(c.checks).filter(([, value]) => !taskId || value.taskId === taskId));
        return { id: c.id, title: c.title, mode: c.mode, epoch: c.epoch, execution: c.execution,
            actor: c.actor, root: c.root, intentText: c.intentText, intent: c.intent, corrections: c.corrections,
            references: c.references, policy: c.policy, profiles: c.profiles, assignedTask: selected,
            tasks: c.tasks, claims: c.claims.map(({ briefHash, ...claim }) => claim), checkpoints: visibleCheckpoints,
            checks: visibleChecks, checkRequests: Object.values(c.checkRequests || {}).filter(value => !taskId || value.taskId === taskId)
                .map(value => ({ id: value.id, kind: value.kind, state: value.state, checkpointId: value.checkpointId, action: value.action })),
            queue: c.queue, planSealed: c.planSealed,
            instruction: 'Native Agent/SendMessage execute claimed work. A completed worker is not an accepted package. Independent ready work does not wait for unrelated blockers.' };
    }
    async function invoke(sid, name, input, meta = {}) {
        const id = binding(sid);
        ensure(id, 'No campaign is attached to this chat. Use Campaigns → Attach to this chat.');
        if (store.get(id).schema === 1) {
            ensure(name === 'get', 'legacy campaign is read-only');
            return legacyView(id, sid);
        }
        drainReceipts(id);
        const toolUseId = meta['claudecode/toolUseId'];
        const call = state.calls.get(sid + ':' + toolUseId);
        ensure(call && call.id === id && call.tool === 'mcp__campaign__' + name, 'campaign tool has no native hook attribution');
        ensure(call.fingerprint === hash(JSON.stringify(input)), 'campaign tool input changed after its native attribution');
        let result;
        if (name === 'get') result = agentView(id, call.actor);
        else if (name === 'plan') result = store.planNative(id, call.actor, input);
        else if (name === 'claim') result = store.claimNative(id, call.actor, input);
        else if (name === 'resume') result = store.resumeNative(id, call.actor, input);
        else if (name === 'checkpoint') result = store.checkpointNative(id, call.actor, input);
        else if (name === 'submit') result = store.submitNative(id, call.actor, input);
        else if (name === 'prepare_check') result = store.prepareCheck(id, call.actor, input, runnerPath);
        else if (name === 'verify') result = store.verifyCheck(id, call.actor, input.check_id);
        else if (name === 'review') result = store.reviewNative(id, call.actor, input);
        else throw Error('unknown campaign tool');
        changed(id);
        return result;
    }
    function serverFor(sid) {
        if (!state.servers.has(sid)) state.servers.set(sid, sdkServer(SERVER, () => state.api?.tools || TOOLS,
            (name, input, meta) => { ensure(state.api, 'campaign plugin unavailable'); return state.api.invoke(sid, name, input, meta); }));
        return state.servers.get(sid);
    }
    // App 2.9939.4 made isCliProvablyIdle module-local; hasAgentRunInProgress
    // plus the turn-result flag is the public equivalent (docs/internals.md).
    function cliIdle(m, session) {
        if (typeof m?.isCliProvablyIdle === 'function') return m.isCliProvablyIdle(session) === true;
        if (typeof m?.hasAgentRunInProgress !== 'function' || !session.sessionId) return false;
        return session.cliLastTurnMessageWasResult === true && !m.hasAgentRunInProgress(session.sessionId);
    }
    function idle(session) {
        if (!session?.query || !cliIdle(manager(), session)) return false;
        const tasks = session.activeBackgroundTasks;
        if (Array.isArray(tasks) && tasks.some(value => !['completed', 'failed', 'killed'].includes(value.status))) return false;
        if (tasks instanceof Map && tasks.size) return false;
        const pending = session.hostRequestsInFlight;
        return !(typeof pending === 'number' ? pending > 0 : pending?.size > 0);
    }
    async function attachPending(id, sid) {
        const m = manager(), session = m?.sessions.get(sid);
        ensure(session, 'selected Desktop chat is unavailable');
        if (!idle(session)) return { pending: true, note: 'Waiting for this chat and its existing background work to reach a safe hook-installation boundary.' };
        if (state.attaching.has(sid)) return { pending: true, note: 'Installing native campaign hooks.' };
        let release;
        const barrier = new Promise(resolve => { release = resolve; });
        state.attaching.set(sid, barrier);
        try {
            const query = session.query;
            if (!store.get(id).root && typeof m.teardownQuery === 'function') {
                // Agent definitions are cached by the CLI session. Refresh only this
                // idle process so newly admitted MCP tools reach restricted profiles.
                // The Desktop chat and its transcript identity remain unchanged.
                store.attach(id, sid, session.cliSessionId);
                state.bindings.set(sid, id); state.refreshing.add(sid); state.pending.delete(id);
                m.teardownQuery(session, 'exited', { keepUndeliveredInput: true });
                changed(id);
                return { attached: true, native: true, refreshed: true, sessionId: sid };
            }
            const servers = { ...serversOf(session), [SERVER]: serverFor(sid) };
            const installed = state.installed.has(query) ? { ok: true, hooks_applied: true }
                : await installQuery({ query, hooks: hooksFor(sid), servers, isIdle: () => idle(session) });
            if (installed.pending) return { pending: true, note: installed.error };
            ensure(installed.ok && installed.hooks_applied === true, installed.error || 'native hooks were not installed');
            ensure(session.query === query, 'Desktop query changed during attachment');
            session.activeMcpServers = servers;
            state.installed.add(query);
            store.attach(id, sid, session.cliSessionId);
            state.bindings.set(sid, id); state.pending.delete(id);
            changed(id);
            return { attached: true, native: true, sessionId: sid };
        } finally { state.attaching.delete(sid); release(); }
    }
    function configureOptions(sid, result) {
        if (!binding(sid)) return result;
        const options = addHooks(result.sdkOptions, hooksFor(sid));
        const c = store.get(binding(sid));
        if (c.schema === 2) options.additionalDirectories = [...new Set([...(options.additionalDirectories || []), ...c.workspaces, c.directory, ...c.references.map(ref => path.dirname(ref.path))])];
        options.allowedTools = [...(options.allowedTools || []), ...TOOLS.map(tool => 'mcp__campaign__' + tool.name)];
        options.mcpServers = { ...(options.mcpServers || {}), [SERVER]: serverFor(sid) };
        result.sdkOptions = options;
        result.allMcpServers = { ...(result.allMcpServers || {}), [SERVER]: serverFor(sid) };
        return result;
    }
    function installManager() {
        const m = manager();
        if (!m) return;
        if (state.originalBuild) {
            if (state.buildWrapperVersion !== 2 && m.buildStartSdkOptions === state.installedBuild) {
                state.installedBuild = async function (...args) {
                    const result = await Reflect.apply(state.originalBuild, this, args);
                    ensure(state.api || !binding(args[0].sessionId), 'campaign plugin unavailable');
                    return state.api ? state.api.configureOptions(args[0].sessionId, result) : result;
                };
                m.buildStartSdkOptions = state.installedBuild; state.buildWrapperVersion = 2;
            }
            return;
        }
        state.originalBuild = m.buildStartSdkOptions;
        state.originalStop = m.stopSession; state.originalInterrupt = m.interruptSession; state.originalSend = m.sendMessage;
        state.installedBuild = async function (...args) {
            const result = await Reflect.apply(state.originalBuild, this, args);
            return state.api ? state.api.configureOptions(args[0].sessionId, result) : result;
        };
        m.buildStartSdkOptions = state.installedBuild; state.buildWrapperVersion = 2;
        for (const [method, original] of [['stopSession', state.originalStop], ['interruptSession', state.originalInterrupt]]) {
            const wrapped = function (sid, trigger, ...rest) {
                const id = binding(sid);
                if (id && (trigger === undefined || trigger === 'user')) {
                    try {
                        const c = store.get(id);
                        if (c.mode === 'active') {
                            if (c.schema === 2) store.controlNative(id, 'pause'); else legacy.control(id, 'pause');
                            changed(id);
                        }
                    } catch (error) { ctx.log('campaign root pause: ' + error.message); }
                }
                return Reflect.apply(original, this, [sid, trigger, ...rest]);
            };
            state['installed' + (method === 'stopSession' ? 'Stop' : 'Interrupt')] = wrapped;
            m[method] = wrapped;
        }
        if (typeof state.originalSend === 'function') {
            state.installedSend = async function (sid, ...args) {
                const barrier = state.attaching.get(sid); if (barrier) await barrier;
                return Reflect.apply(state.originalSend, this, [sid, ...args]);
            };
            m.sendMessage = state.installedSend;
        }
        state.listener = event => state.api?.onEvent(event);
        m.on('event', state.listener);
    }
    function onEvent(event) {
        // Streaming deltas and successful results do not change campaign state.
        // Most sessions have no campaign: do not scan persisted campaigns, or
        // broadcast a renderer refresh, for every token in every native chat.
        if (event.type !== 'close' && !(event.type === 'message'
            && ((event.message?.type === 'system' && event.message.subtype === 'init')
                || (event.message?.type === 'result' && event.message.subtype !== 'success')))) return;
        const id = binding(event.sessionId);
        if (!id) return;
        const c = store.get(id);
        if (c.schema !== 2) return;
        if (event.type === 'message' && event.message?.type === 'system' && event.message.subtype === 'init') {
            state.refreshing.delete(event.sessionId);
            store.change(id, value => {
                const actual = event.message.session_id;
                if (value.root.cliSessionId && value.root.cliSessionId !== actual) {
                    value.mode = 'paused'; value.rootError = 'CLI identity changed. Reconcile the prior root before resuming.';
                } else value.root.cliSessionId = actual;
                value.root.seenEpoch = null;
            });
            const query = manager()?.sessions.get(event.sessionId)?.query;
            if (query?.hooks?.PreToolUse?.some(entry => entry.hooks?.includes(hooksFor(event.sessionId).PreToolUse[0].hooks[0]))) state.installed.add(query);
        }
        if (event.type === 'message' && event.message?.type === 'result' && event.message.subtype !== 'success') store.change(id, value => {
            if (value.mode === 'active') { value.mode = 'paused'; value.epoch++; }
            value.rootError = 'Native root ended with ' + event.message.subtype + '; its packages and ownership remain recorded.';
        });
        if (event.type === 'close' && !state.refreshing.has(event.sessionId)) store.change(id, value => {
            if (value.mode === 'active') { value.mode = 'paused'; value.epoch++; }
            for (const claim of value.claims.filter(claim => ACTIVE.has(claim.phase))) {
                claim.phase = 'unknown'; claim.reason = 'Root transport closed; reconcile native task receipts before replacement.';
                const task = value.tasks.find(task => task.id === claim.taskId);
                if (task.status === 'running') task.status = 'interrupted';
            }
        });
        changed(id);
    }
    async function control(p) {
        const c = store.native(p.id);
        const result = store.controlNative(p.id, p.action, p);
        if (['pause', 'stop'].includes(p.action)) {
            const query = manager()?.sessions.get(c.root?.desktopSessionId)?.query;
            for (const claim of c.claims.filter(value => ACTIVE.has(value.phase) && value.agentId)) {
                try {
                    ensure(query, 'root transport is unavailable; retain ownership for reconciliation');
                    store.change(p.id, value => { value.claims.find(item => item.id === claim.id).phase = 'stopping'; });
                    await query.stopTask(claim.agentId);
                } catch (error) { ctx.log('native task cancellation requires reconciliation: ' + error.message); }
            }
        }
        if (p.action === 'resume' && c.root) {
            await manager()?.sendMessage(c.root.desktopSessionId,
                'Owner resumed the native campaign. Read campaign.get, reconcile interrupted assignments, and keep independent ready work moving. Worker completion does not accept packages.', undefined, { initiator: 'user', priority: 'next' });
        }
        changed(p.id);
        return result;
    }

    state.api = { store, legacy, tools: TOOLS, guard, invoke, onPost, onFailure, onStart, onStop, onCompact, onEvent, attachPending, control, drainReceipts, configureOptions };
    ctx.method('context', p => {
        const session = manager()?.sessions.get(p.sessionId);
        return { cwd: session?.originCwd || session?.cwd || '', templates: TEMPLATES,
            defaultProfile: 'general-purpose', native: true, ready: !!manager(),
            hookStatus: session?.query ? (state.installed.has(session.query) ? 'installed' : 'Attach installs native hooks at an idle boundary.') : 'Open a local Code chat first.' };
    });
    ctx.method('list', () => store.list().map(c => ({ id: c.id, title: c.title, mode: c.mode, schema: c.schema,
        execution: c.execution, updatedAt: c.updatedAt, accepted: c.tasks?.filter(t => t.status === 'accepted').length || 0,
        total: c.tasks?.length || 0, error: c.error })));
    ctx.method('get', p => store.get(p.id).schema === 2 ? store.viewNative(p.id) : legacyView(p.id));
    ctx.method('create', p => { const c = store.createNative(p); changed(c.id); return c; });
    const announceAttachment = sid => manager().sendMessage(sid,
        'Native campaign tools are attached. Read campaign.get for the verbatim owner objective, current packages and ready queue. Use native Agent for claimed assignments; preserve unfinished work and obtain revision-specific verification and review.',
        undefined, { initiator: 'user', priority: 'next' });
    ctx.method('attach', async p => {
        store.native(p.id);
        ensure(typeof p.sessionId === 'string' && manager()?.sessions.has(p.sessionId), 'select an existing local Code chat');
        const already = binding(p.sessionId);
        if (already && already !== p.id) ensure(['completed', 'stopped'].includes(store.get(already).mode), 'this chat already owns an unfinished campaign');
        state.pending.set(p.id, p.sessionId);
        const result = await attachPending(p.id, p.sessionId);
        if (result.attached) await announceAttachment(p.sessionId);
        return result;
    });
    ctx.method('control', control);
    ctx.method('review', p => { const result = store.reviewNative(p.id, null, p, true); changed(p.id); return result; });
    ctx.method('pickDirectory', async (_p, event) => {
        const window = ctx.electron.BrowserWindow.fromWebContents(event.sender);
        const result = await ctx.electron.dialog.showOpenDialog(window, { title: 'Campaign workspace', properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
    ctx.method('openEvidence', async p => {
        const c = store.get(p.id); const ref = reference(p.path, c);
        if (opensDirectly(ref.path)) return ctx.electron.shell.openPath(ref.path);
        ctx.electron.shell.showItemInFolder(ref.path);
        return '';
    });
    installManager();
    ctx.every(500, () => {
        if (disposed) return;
        installManager();
        for (const campaign of store.list()) if (campaign.schema === 2 && campaign.claims.some(claim => ACTIVE.has(claim.phase))) {
            try { drainReceipts(campaign.id); } catch (error) { ctx.log('native receipt reconciliation: ' + error.message); }
        }
        for (const [id, sid] of state.pending) {
            if (!idle(manager()?.sessions.get(sid)) || state.attaching.has(sid)) continue;
            attachPending(id, sid).then(result => {
                if (result.attached) return announceAttachment(sid);
            }).catch(error => {
                state.pending.delete(id);
                store.change(id, c => { c.rootError = error.message; }); changed(id);
            });
        }
    });
    for (const server of state.servers.values()) server.instance.notifyToolsChanged?.();
    ctx.onDispose(() => {
        disposed = true;
        if (state.owner !== ownerToken) return;
        state.api = null;
        const m = state.manager;
        if (m && state.listener) m.removeListener('event', state.listener);
        for (const [method, installed, original] of [
            ['buildStartSdkOptions', 'installedBuild', 'originalBuild'], ['stopSession', 'installedStop', 'originalStop'],
            ['interruptSession', 'installedInterrupt', 'originalInterrupt'], ['sendMessage', 'installedSend', 'originalSend'],
        ]) if (m && m[method] === state[installed]) m[method] = state[original];
        state.originalBuild = state.originalStop = state.originalInterrupt = state.originalSend = null;
    });
};
module.exports.TOOLS = TOOLS;
module.exports.opensDirectly = opensDirectly;
