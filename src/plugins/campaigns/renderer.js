'use strict';
const REG = globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() });
const root = document.createElement('div');
root.id = 'cuimod-campaign-workspace';
const shadow = root.attachShadow({ mode: 'open' });
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
:host { display:block; width:100%; color:hsl(var(--text-100)); font:12px/1.5 ui-sans-serif,"Segoe UI",sans-serif; }
* { box-sizing:border-box; } h3,h4,p { margin:0; } h3 { font-size:15px; font-weight:600; } h4 { font-size:12px; }
.stack { display:flex;flex-direction:column;gap:12px; } .row { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
.grow { flex:1;min-width:0; } .muted { color:hsl(var(--text-400));font-size:11px; } .small { font-size:10px; }
button { font:inherit; cursor:pointer; border:1px solid color-mix(in srgb,hsl(var(--text-100)) 14%,transparent); border-radius:7px; background:hsl(var(--bg-200)); color:inherit; padding:6px 10px; }
button:hover { background:hsl(var(--bg-300)); } button:disabled { opacity:.45;cursor:default; }
button.primary { color:hsl(var(--oncolor-100,0 0% 100%));background:hsl(var(--accent-100));border-color:transparent; }
button.danger { color:hsl(var(--danger-100)); } button:focus-visible,a:focus-visible { outline:2px solid hsl(var(--accent-100));outline-offset:2px; }
input,textarea,select { font:inherit;width:100%;color:inherit;background:hsl(var(--bg-100));border:1px solid color-mix(in srgb,hsl(var(--text-100)) 18%,transparent);border-radius:7px;padding:7px 8px;outline:none; }
input:focus,textarea:focus,select:focus { border-color:hsl(var(--accent-100)); } textarea { min-height:90px;resize:vertical;line-height:1.5; }
label { display:flex;flex-direction:column;gap:4px;font-size:11px; } .check { flex-direction:row;align-items:flex-start;gap:7px; } .check input { width:auto;margin-top:3px; }
.card { border:1px solid color-mix(in srgb,hsl(var(--text-100)) 12%,transparent);border-radius:9px;padding:11px;background:hsl(var(--bg-200)); }
.card.selected { border-color:color-mix(in srgb,hsl(var(--accent-100)) 60%,transparent); } .card p { white-space:pre-wrap;overflow-wrap:anywhere; }
.tag { font-size:10px;border-radius:4px;padding:1px 5px;background:color-mix(in srgb,hsl(var(--text-100)) 8%,transparent); }
.tag.accepted,.tag.completed { color:hsl(var(--success-100)); } .tag.rejected,.tag.blocked,.tag.interrupted,.tag.stopped { color:hsl(var(--danger-100)); }
.tag.legacy { color:hsl(var(--text-400)); } .tag.running,.tag.submitted,.tag.starting { color:hsl(var(--accent-100)); }
.grid { display:grid;grid-template-columns:1fr 1fr;gap:8px; }
.error { white-space:pre-wrap;overflow-wrap:anywhere;color:hsl(var(--danger-100)); } .notice { padding:9px;border-left:2px solid hsl(var(--accent-100));background:color-mix(in srgb,hsl(var(--accent-100)) 6%,transparent); }
a { color:hsl(var(--accent-100));text-decoration:none; } a:hover { text-decoration:underline; }
details summary { cursor:pointer;color:hsl(var(--text-300)); } details[open] summary { margin-bottom:8px; }
[hidden] { display:none!important; } .subtle { border:0;padding:0;background:none;color:hsl(var(--accent-100)); }
`);
shadow.adoptedStyleSheets = [sheet];
const el = (tag, cls, value) => { const node = document.createElement(tag); if (cls) node.className = cls; if (value !== undefined) node.textContent = value; return node; };
const actions = new WeakMap();
const button = (label, action, cls) => { const node = el('button', cls, label); node.type = 'button'; actions.set(node, action); return node; };
ctx.track(shadow, 'click', event => { const node = event.composedPath().find(node => actions.has(node)); if (node) actions.get(node)(event); });
const label = (name, control) => { const node = el('label', null, name); node.append(control); return node; };
const field = (type, value = '') => { const node = document.createElement(type === 'textarea' ? type : 'input'); if (type !== 'textarea') node.type = type; node.value = value; return node; };
const select = choices => { const node = document.createElement('select'); for (const [value, title] of choices) { const option = el('option', null, title); option.value = value; node.append(option); } return node; };
const lines = value => value.split('\n').map(value => value.trim()).filter(Boolean);
const short = value => typeof value === 'string' ? value.slice(0, 8) : '';
const stamp = value => value ? new Date(value).toLocaleString() : '';
const pathLabel = path => String(path || '').split(/[\\/]/).slice(-2).join('/');
// Native terminal assignment phases. A finished worker has not accepted its
// package; only an owner review against the candidate's source revision does.
const TERMINAL = new Set(['finished', 'failed', 'cancelled']);
const PROFILE_ROLES = ['worker', 'designer', 'integrator', 'investigator', 'coordinator', 'reviewer'];
let selected = null;
let context = null;
let sessionId = null;
let busy = false;
let refreshing = false;
let lastDetail = '';
let lastList = '';
const status = el('p', 'muted');
const error = el('div', 'error');
const notice = el('div', 'notice muted');
notice.hidden = true;
const list = el('div', 'stack');
const detail = el('div', 'stack');
const form = el('div', 'stack card');
form.hidden = true;
const header = el('div', 'row');
header.append(el('h3', 'grow', 'Campaigns'), button('New campaign', () => { form.hidden = !form.hidden; }, 'primary'));
const intro = el('p', 'muted', 'Start from an objective. This chat becomes the campaign root and performs bounded native work; evidence-bound review, not native completion, accepts a package. Pause and stop are owner controls.');
const frame = el('div', 'stack');
frame.append(header, intro, status, notice, error, form, list, detail);
shadow.append(frame);

function say(message) { notice.textContent = message || ''; notice.hidden = !message; }
async function run(fn) {
    if (busy) return;
    busy = true;
    error.textContent = '';
    say('');
    try { const result = await fn(); lastList = ''; lastDetail = ''; await refresh(); return result; }
    catch (err) { error.textContent = err.message || String(err); }
    finally { busy = false; }
}
const titleInput = field('text');
const intentInput = field('textarea');
intentInput.placeholder = 'What should be accomplished? Include the method, important boundaries and what passing evidence looks like. Corrections change this verbatim; a summary cannot change authority, scope or permissions.';
const cwdInput = field('text');
const workflowInput = select([['investigation', 'Investigate → verify'], ['implementation', 'Design → implement → review wave'], ['solo', 'Solo task → owner review']]);
const refInput = field('textarea');
refInput.placeholder = 'Optional absolute file paths, one per line. These are governing references the root must read.';
const workspaceInput = field('textarea');
workspaceInput.placeholder = 'Optional additional owner-approved workspace directories, one per line.';
const writeInput = field('checkbox');
const shellInput = field('checkbox');
const concurrencyInput = field('number', '3');
concurrencyInput.min = '1'; concurrencyInput.max = '128';
const attemptsInput = field('number', '20');
attemptsInput.min = '1'; attemptsInput.max = '10000';
const profilePanel = el('div', 'stack');
const profileFields = new Map();
const profileDetails = document.createElement('details');
profileDetails.append(el('summary', null, 'Native agent profiles, permissions and limits'), profilePanel);
// Profile bindings name installed native subagent profiles. There are no model
// or effort overrides: the root model stays whatever this chat is running.
function profileRoles() {
    const declared = context?.templates?.[workflowInput.value]?.roles || [];
    const chosen = new Set(['worker', 'reviewer']);
    for (const role of declared) if (PROFILE_ROLES.includes(role)) chosen.add(role);
    return PROFILE_ROLES.filter(role => chosen.has(role));
}
function drawProfiles() {
    profilePanel.replaceChildren();
    for (const role of profileRoles()) {
        let node = profileFields.get(role);
        if (!node) { node = field('text', context?.defaultProfile || 'general-purpose'); profileFields.set(role, node); }
        profilePanel.append(label(role + ' profile', node));
    }
    const limits = el('div', 'grid');
    limits.append(label('Concurrent native agents', concurrencyInput), label('Attempts per package', attemptsInput));
    profilePanel.append(label('Additional approved workspaces', workspaceInput), limits,
        label('Allow source writes by native workers', writeInput), label('Allow native shell tools', shellInput),
        el('p', 'muted', 'Profiles default to ' + (context?.defaultProfile || 'general-purpose') + ' and read-only. A profile name is not a readiness or billing guarantee. Shell access is broader than file-tool guards and is not a sandbox. No commit, merge, push or deployment is authorized by a campaign.'));
    for (const control of [writeInput, shellInput]) control.parentElement.classList.add('check');
}
ctx.track(workflowInput, 'change', drawProfiles);
const workspaceRow = el('div', 'row'); cwdInput.className = 'grow';
workspaceRow.append(cwdInput, button('Choose…', () => run(async () => { const chosen = await cuimod.rpc('campaigns.pickDirectory'); if (chosen) cwdInput.value = chosen; })));
form.append(label('Campaign name', titleInput), label('Owner objective and boundaries', intentInput), label('Workspace', workspaceRow), label('Workflow', workflowInput), label('Governing reference files', refInput), profileDetails,
    el('p', 'notice muted', 'Create saves a draft. Attach waits for this chat to become idle, refreshes its CLI with the same transcript, and starts the native campaign. Other chats are untouched. Nothing commits, merges or deploys automatically.'),
    button('Create draft', () => run(async () => {
        const profiles = {};
        for (const role of profileRoles()) profiles[role] = profileFields.get(role).value;
        const result = await cuimod.rpc('campaigns.create', { title: titleInput.value, intent: intentInput.value,
            cwd: cwdInput.value, workspaces: lines(workspaceInput.value), references: lines(refInput.value), template: workflowInput.value,
            profiles, maxConcurrent: Number(concurrencyInput.value), maxAttempts: Number(attemptsInput.value),
            allowWrites: writeInput.checked, allowShell: shellInput.checked });
        selected = result?.id || selected; form.hidden = true; titleInput.value = ''; intentInput.value = '';
    }), 'primary'));
drawProfiles();

function signatureOf(c) {
    if (c.schema === 2 && c.execution === 'native-agents') return [c.id, c.mode, c.epoch, c.revision, c.planSealed, c.updatedAt, c.root?.desktopSessionId,
        (c.tasks || []).map(t => [t.id, t.status, t.requirementsVersion, t.latest, t.accepted, (t.reviews || []).length, t.nextAction]),
        (c.claims || []).map(x => [x.id, x.agentId, x.phase, x.kind, x.profile, x.ownershipReleased, x.checkpoint?.note, x.reason, x.finishedAt]),
        Object.values(c.checkpoints || {}).map(x => [x.id, x.requirementsVersion, (x.unrun || []).length]),
        Object.values(c.checks || {}).map(x => [x.id, x.kind, x.status]), (c.corrections || []).length, c.queue, c.policy];
    return [c.id, c.mode, c.epoch, c.revision, (c.tasks || []).map(t => [t.id, t.status, t.requirementsVersion, t.latest?.id, t.retained?.id, (t.reviews || []).length]), (c.corrections || []).length];
}
function renderDetail(c) {
    if (!c || typeof c !== 'object') return;
    const signature = JSON.stringify(signatureOf(c));
    if (signature === lastDetail) return;
    if (detail.contains(shadow.activeElement) && shadow.activeElement?.matches('input,textarea')) return;
    lastDetail = signature;
    const previousCorrection = detail.querySelector('[data-correction]')?.value || '';
    const previousReasons = new Map([...detail.querySelectorAll('[data-review-task]')].map(node => [node.dataset.reviewTask, node.value]));
    detail.replaceChildren();
    if (c.schema === 2 && c.execution === 'native-agents') renderNative(c, previousCorrection, previousReasons);
    else renderLegacy(c);
}

function evidenceButton(campaignId, ref) {
    return button(pathLabel(ref.path), () => run(() => cuimod.rpc('campaigns.openEvidence', { id: campaignId, path: ref.path })), 'subtle');
}
function renderNative(c, previousCorrection, previousReasons) {
    const heading = el('div', 'row');
    heading.append(el('h3', 'grow', c.title), el('span', 'tag ' + c.mode, c.mode));
    const accepted = (c.tasks || []).filter(task => task.status === 'accepted').length;
    const active = (c.claims || []).filter(claim => !TERMINAL.has(claim.phase)).length;
    detail.append(heading, el('p', 'muted', c.cwd || ''),
        el('p', 'muted', accepted + ' accepted / ' + (c.tasks || []).length + ' packages · ' + active + ' active assignments'));

    const rootRow = el('div', 'row');
    if (c.root) {
        const link = el('a', null, 'Root chat ' + short(c.root.desktopSessionId));
        link.href = '/epitaxy/' + c.root.desktopSessionId;
        link.title = 'Open the native chat that owns this campaign';
        rootRow.append(link, el('span', 'muted', c.root.desktopSessionId === sessionId ? 'this chat' : 'another chat'));
    } else rootRow.append(el('span', 'muted', 'No root chat attached.'));
    detail.append(rootRow);

    const modes = el('div', 'row');
    const control = (action, data = {}) => run(() => cuimod.rpc('campaigns.control', { id: c.id, action, ...data }));
    if (!c.root && ['draft', 'paused', 'active'].includes(c.mode)) {
        const attach = button('Attach this chat', () => run(async () => {
            if (!sessionId) { error.textContent = 'Open a Desktop chat before attaching a campaign root.'; return; }
            const result = await cuimod.rpc('campaigns.attach', { id: c.id, sessionId });
            if (result?.pending) say(result.note || 'Attachment is pending host confirmation; the tools and hooks are not installed yet.');
            else say('This chat is now the campaign root.');
        }), 'primary');
        if (!sessionId) { attach.disabled = true; attach.title = 'Open a Desktop chat first'; }
        modes.append(attach);
    }
    if (c.mode === 'active') modes.append(button('Pause', () => control('pause')));
    if (c.mode === 'paused') modes.append(button('Resume', () => control('resume'), 'primary'));
    if (c.mode !== 'stopped') {
        let armed = false;
        const stop = button('Stop campaign', () => { if (!armed) { armed = true; stop.textContent = 'Confirm stop'; return; } control('stop'); }, 'danger');
        modes.append(stop);
    }
    if (modes.childElementCount) detail.append(modes);

    const queue = c.queue || {};
    detail.append(el('p', 'muted', 'Queue — ready ' + (queue.ready || []).length + ' · awaiting review ' + (queue.review || []).length
        + ' · unfinished ' + (queue.unfinished || []).length + ' · active claims ' + (queue.active || []).length));
    detail.append(el('p', 'muted', 'Source writes: ' + (c.policy?.allowWrites ? 'allowed' : 'denied')
        + ' · Shell tools: ' + (c.policy?.allowShell ? 'allowed' : 'denied')
        + ' · Concurrent agents: ' + c.policy?.maxConcurrent + ' · Attempts per package: ' + c.policy?.maxAttempts));
    if (c.rootError) detail.append(el('p', 'error', c.rootError));

    const brief = document.createElement('details');
    brief.append(el('summary', null, 'Owner intent, profiles and corrections'), el('p', 'muted', 'Original intent (verbatim)'), el('p', null, c.intentText || ''));
    brief.append(el('p', 'muted', 'Profiles: ' + Object.entries(c.profiles || {}).map(([role, profile]) => role + ' = ' + profile).join('; ')));
    if ((c.references || []).length) {
        brief.append(el('p', 'muted', 'Governing references'));
        for (const ref of c.references) brief.append(evidenceButton(c.id, ref));
    }
    if ((c.corrections || []).length) {
        brief.append(el('p', 'muted', 'Corrections, in order (verbatim)'));
        c.corrections.forEach((correction, index) => {
            brief.append(el('p', null, (index + 1) + '. ' + String(correction.text || '').trim()));
            brief.append(el('p', 'small muted', 'packages: ' + (correction.taskIds || []).join(', ') + ' · ' + stamp(correction.at)));
        });
    }
    detail.append(brief);
    detail.append(button('Use this configuration for a new campaign', () => {
        workflowInput.value = c.template; cwdInput.value = c.cwd || ''; titleInput.value = ''; intentInput.value = '';
        workspaceInput.value = (c.workspaces || []).filter(value => value !== c.cwd).join('\n');
        refInput.value = (c.references || []).map(ref => ref.path).join('\n');
        concurrencyInput.value = String(c.policy?.maxConcurrent ?? 3); attemptsInput.value = String(c.policy?.maxAttempts ?? 20);
        writeInput.checked = c.policy?.allowWrites === true; shellInput.checked = c.policy?.allowShell === true;
        drawProfiles();
        for (const [role, profile] of Object.entries(c.profiles || {})) { const node = profileFields.get(role); if (node) node.value = profile; }
        form.hidden = false; titleInput.focus();
    }));
    if (c.mode !== 'stopped') {
        const correction = field('textarea', previousCorrection); correction.dataset.correction = '1';
        correction.placeholder = 'A correction changes the instructions verbatim and invalidates affected acceptance. Use Pause or Stop to halt execution.';
        detail.append(label('Owner correction', correction), button('Record correction', () => run(() => {
            if (!correction.value.trim()) { error.textContent = 'A correction needs its original text.'; return; }
            return cuimod.rpc('campaigns.control', { id: c.id, action: 'correct', text: correction.value });
        })));
    }

    for (const task of c.tasks || []) detail.append(taskCard(c, task, previousReasons));
    const orphaned = (c.claims || []).filter(claim => !(c.tasks || []).some(task => task.id === claim.taskId));
    if (orphaned.length) {
        const box = document.createElement('details');
        box.append(el('summary', null, 'Assignments without a package'));
        for (const claim of orphaned) box.append(el('p', 'muted', claim.kind + ' · ' + claim.phase + ' · ' + claim.profile + ' · ' + (claim.agentId || 'unbound')));
        detail.append(box);
    }
}

function taskCard(c, task, previousReasons) {
    const card = el('div', 'card stack');
    const row = el('div', 'row');
    row.append(el('h4', 'grow', task.title), el('span', 'tag ' + task.status, task.status));
    card.append(row);
    card.append(el('p', 'muted', task.id + ' · ' + task.role + ' · requirements v' + task.requirementsVersion + ' · ' + (task.attempts || []).length + ' attempts'));
    card.append(el('p', 'muted', 'Implementation dependencies: ' + ((task.dependsOn || []).join(', ') || 'none') + ' (' + (task.ready ? 'met' : 'open') + ')'
        + ' · Acceptance dependencies: ' + ((task.acceptanceDependsOn || []).join(', ') || 'none') + ' (' + (task.acceptanceReady ? 'met' : 'open') + ')'));
    card.append(el('p', 'muted', 'Source roots: ' + ((task.sourceRoots || []).join(', ') || 'none')));
    card.append(el('p', 'muted', 'Write roots: ' + ((task.writeRoots || []).length ? task.writeRoots.join(', ') : 'none (read-only)')));
    const scope = document.createElement('details');
    scope.append(el('summary', null, 'Requirement and acceptance criteria'), el('p', null, task.brief), el('p', null, task.criteria));
    card.append(scope);
    if ((task.requiredChecks || []).length) {
        const checks = task.requiredChecks.map(kind => {
            const passed = Object.values(c.checks || {}).filter(check => check.checkpointId === task.latest && check.kind === kind).at(-1)?.status === 'passed';
            return kind + ' ' + (passed ? 'passed' : 'pending');
        });
        card.append(el('p', 'muted', 'Required verification: ' + checks.join(' · ')));
    }
    if (task.latest && c.checkpoints?.[task.latest]) {
        const checkpoint = c.checkpoints[task.latest];
        const box = document.createElement('details'); box.open = task.status === 'submitted';
        box.append(el('summary', null, 'Latest candidate · checkpoint ' + short(checkpoint.id)));
        box.append(el('p', 'muted', 'Source revision ' + short(checkpoint.source?.id) + ' · requirements v' + checkpoint.requirementsVersion + ' · ' + stamp(checkpoint.at)));
        box.append(el('p', null, checkpoint.summary || ''));
        if ((checkpoint.unrun || []).length) box.append(el('p', 'notice', 'Unrun required work: ' + checkpoint.unrun.join('; ')));
        for (const ref of [checkpoint.report, ...(checkpoint.evidence || [])]) if (ref?.path) box.append(evidenceButton(c.id, ref));
        card.append(box);
    }
    if (task.accepted && c.checkpoints?.[task.accepted]) {
        const checkpoint = c.checkpoints[task.accepted];
        card.append(el('p', 'notice', 'Accepted at checkpoint ' + short(checkpoint.id) + ' · source revision ' + short(checkpoint.source?.id) + ' · requirements v' + checkpoint.requirementsVersion));
    }
    for (const review of task.reviews || []) {
        card.append(el('p', 'notice', review.decision + ' · ' + (review.actor === 'owner' ? 'owner' : 'assignment ' + short(review.actor))
            + ' · checkpoint ' + short(review.checkpointId) + (review.checkpointId === task.latest ? ' (current candidate)' : ' (earlier candidate)') + ': ' + review.reason));
    }
    const checkId = task.latest || task.accepted;
    const checks = Object.values(c.checks || {}).filter(check => check.checkpointId === checkId);
    if (checks.length) {
        const box = document.createElement('details');
        box.append(el('summary', null, 'Recorded verification (' + checks.length + ')'));
        for (const check of checks) {
            box.append(el('p', 'muted', check.kind + ' · ' + check.status + ' · exit ' + (check.receipt?.exitCode ?? '?') + (check.receipt?.terminal ? ' · terminal' : ' · incomplete')));
            if (check.productionPath) box.append(el('p', 'small muted', 'Production path: ' + check.productionPath));
            for (const ref of check.evidence || []) if (ref?.path) box.append(evidenceButton(c.id, ref));
        }
        card.append(box);
    }
    if (task.nextAction) card.append(el('p', 'muted', 'Next action: ' + task.nextAction));
    const claims = (c.claims || []).filter(claim => claim.taskId === task.id);
    for (const claim of claims) {
        const box = el('div', 'stack');
        box.append(el('p', 'muted', (claim.kind === 'review' ? 'Reviewer' : claim.kind === 'coordinator' ? 'Coordinator' : 'Worker')
            + ' · ' + claim.phase + ' · ' + claim.profile + (claim.ownershipReleased ? ' · source released' : ' · holds source roots')));
        box.append(el('p', 'small muted', 'assignment ' + short(claim.id) + ' · agent ' + (claim.agentId || 'not yet bound') + ' · ' + (claim.agentName || '')));
        if (claim.checkpoint?.note) box.append(el('p', 'muted', 'Saved next action: ' + claim.checkpoint.note));
        if (claim.reason) box.append(el('p', 'muted', 'Terminal reason: ' + claim.reason));
        if (TERMINAL.has(claim.phase) && !claim.ownershipReleased && claim.kind !== 'review' && ['interrupted', 'blocked'].includes(task.status)) {
            const reason = field('textarea');
            reason.placeholder = 'What you reconciled. Confirm no original job still needs recovery before another writer is authorized.';
            box.append(reason, button('Record reconciliation; allow retry', () => run(() => {
                if (!reason.value.trim()) { error.textContent = 'Reconciliation needs its reason and next action.'; return; }
                return cuimod.rpc('campaigns.control', { id: c.id, action: 'reconcile', claim_id: claim.id, reason: reason.value });
            })));
        }
        card.append(box);
    }
    if (claims.some(claim => claim.kind !== 'review' && TERMINAL.has(claim.phase) && !claim.ownershipReleased) && task.status !== 'accepted') {
        card.append(el('p', 'muted', 'A native worker finished without an accepted package. Native completion is not acceptance; reconcile and review before authorizing another writer.'));
    }
    if (task.status === 'submitted' && c.mode === 'active' && task.latest) {
        const reason = field('textarea', previousReasons.get(task.id) || ''); reason.dataset.reviewTask = task.id;
        reason.placeholder = 'Your acceptance or rejection reason. Owner acceptance is separate from any independent agent review.';
        card.append(reason);
        const decisions = el('div', 'row');
        for (const decision of ['accept', 'reject']) decisions.append(button(decision === 'accept' ? 'Accept as owner' : 'Reject with correction', () => run(() => {
            if (!reason.value.trim()) { error.textContent = 'A review needs a reason and next action.'; return; }
            return cuimod.rpc('campaigns.review', { id: c.id, task_id: task.id, checkpoint_id: task.latest, decision, reason: reason.value });
        }), decision === 'reject' ? 'danger' : ''));
        card.append(decisions);
    }
    return card;
}

function renderLegacy(c) {
    const heading = el('div', 'row');
    heading.append(el('h3', 'grow', c.title || c.id), el('span', 'tag ' + (c.mode || ''), c.mode || 'unknown'), el('span', 'tag legacy', 'legacy'));
    detail.append(heading, el('p', 'notice muted', 'Retired Desktop-session campaign. This record is read-only: it cannot be started, resumed or controlled from here. Its preserved evidence is shown below.'));
    if (c.cwd) detail.append(el('p', 'muted', c.cwd));
    for (const task of c.tasks || []) {
        const card = el('div', 'card stack');
        const row = el('div', 'row');
        row.append(el('h4', 'grow', task.title || task.id), el('span', 'tag ' + (task.status || ''), task.status || 'unknown'));
        card.append(row, el('p', 'muted', (task.id || '') + ' · ' + (task.role || '')));
        if (task.criteria) {
            const scope = document.createElement('details');
            scope.append(el('summary', null, 'Requirement'), el('p', null, task.criteria));
            card.append(scope);
        }
        const result = task.reviewCandidate || task.latest || task.accepted || task.retained;
        if (result) {
            const box = document.createElement('details');
            box.append(el('summary', null, 'Result and evidence'));
            if (result.summary) box.append(el('p', null, result.summary));
            for (const ref of [result.report, ...(result.evidence || [])]) if (ref?.path) box.append(evidenceButton(c.id, ref));
            card.append(box);
        }
        const review = (task.reviews || []).at(-1);
        if (review) card.append(el('p', 'notice', review.decision + ': ' + review.reason));
        detail.append(card);
    }
}

async function refresh() {
    if (refreshing || (!root.isConnected && !busy)) return;
    refreshing = true;
    try {
        if (!context) {
            const match = location.pathname.match(/local_[a-f0-9-]{36}/i);
            sessionId = match?.[0] || null;
            context = await cuimod.rpc('campaigns.context', { sessionId });
            const hooks = context.hookStatus ? ' Hooks: ' + (typeof context.hookStatus === 'string' ? context.hookStatus : JSON.stringify(context.hookStatus)) : '';
            status.textContent = context.ready ? 'Native campaign bridge ready. Attaching this chat installs the campaign tools and hooks.' + hooks
                : 'Native session bridge is not ready.' + hooks;
            if (!cwdInput.value) cwdInput.value = context.cwd || '';
            drawProfiles();
        }
        const campaigns = await cuimod.rpc('campaigns.list');
        const signature = JSON.stringify(campaigns.map(c => [c.id, c.title, c.mode, c.schema, c.accepted, c.total]));
        if (signature !== lastList) {
            lastList = signature;
            list.replaceChildren();
            for (const campaign of campaigns.slice().reverse()) {
                const row = el('div', 'card row' + (selected === campaign.id ? ' selected' : ''));
                const open = button(campaign.title, () => { selected = campaign.id; lastList = ''; lastDetail = ''; refresh(); }, 'grow');
                row.append(open, el('span', 'tag ' + campaign.mode, campaign.mode));
                if (campaign.schema !== 2 || campaign.execution !== 'native-agents') row.append(el('span', 'tag legacy', 'legacy'));
                row.append(el('span', 'muted', (campaign.accepted || 0) + '/' + (campaign.total || 0)));
                list.append(row);
            }
            if (!campaigns.length) list.append(el('p', 'muted', 'No campaigns yet. Create a draft from your objective and governing references.'));
        }
        if (selected) renderDetail(await cuimod.rpc('campaigns.get', { id: selected }));
    } catch (err) { error.textContent = err.message || String(err); }
    finally { refreshing = false; }
}
cuimod.onSessionChange(() => {
    const previous = context?.cwd;
    context = null;
    sessionId = null;
    if (cwdInput.value === previous) cwdInput.value = '';
    refresh();
});
ctx.every(1500, refresh);
const spec = { plugin: 'campaigns', title: 'Campaigns', description: 'Owner-rooted native campaigns with durable checkpoints, source-bound candidates and evidence-bound review.', defaults: {},
    controls: [{ key: 'workspace', type: 'custom', label: 'Campaign workspace', wide: true, node: () => { refresh(); return root; } }], apply() {} };
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => fn());
ctx.onDispose(() => { REG.specs.delete(spec.plugin); REG.subs.forEach(fn => fn()); root.remove(); });
