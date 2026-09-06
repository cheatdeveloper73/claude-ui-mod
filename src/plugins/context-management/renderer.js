/* claude-ui-mod :: context-management (renderer)
 *
 * Dashboard controls for Codex experimental context management on GPT sessions.
 *
 * The switches are split on purpose. Notes are additive: the model gains a
 * scratchpad and nothing else about the turn changes. Window reset changes what
 * this router sends upstream, and the transcript archive asks OpenAI to ingest
 * and index the thread. Those two are separate, deliberate yeses.
 */
'use strict';

const DEF = {
    enabled: false,
    notesTools: true,
    historyTools: false,
    reminders: true,
    windowReset: false,
    truncationBytes: 10000,
};
let V = { ...DEF };
let statusNode = null;
let statusBody = null;
let driftNode = null;
let statusBusy = false;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function statusCard() {
    if (statusNode) return statusNode;
    statusNode = el('div', 'cm-card');
    const style = document.createElement('style');
    style.textContent = `
.cm-card { border-radius:10px; padding:12px 13px; background:color-mix(in srgb,hsl(var(--text-100)) 5%,transparent);
    border:1px solid color-mix(in srgb,hsl(var(--text-100)) 9%,transparent); color:hsl(var(--text-200)); }
.cm-top { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; }
.cm-dot { width:7px; height:7px; border-radius:50%; background:#7cbd8b; box-shadow:0 0 0 3px color-mix(in srgb,#7cbd8b 18%,transparent); }
.cm-dot.off { background:hsl(var(--text-500)); box-shadow:none; }
.cm-dot.warn { background:#f3cb8a; box-shadow:0 0 0 3px color-mix(in srgb,#f3cb8a 18%,transparent); }
.cm-grid { display:grid; grid-template-columns:max-content 1fr; gap:5px 12px; margin-top:11px; font-size:11px; }
.cm-grid .k { color:hsl(var(--text-500)); }
.cm-grid .v { color:hsl(var(--text-300)); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cm-empty { margin-top:9px; font-size:11px; line-height:1.45; color:hsl(var(--text-500)); }
.cm-drift { margin-top:10px; font-size:11px; line-height:1.5; border-radius:8px; padding:8px 10px;
    background:color-mix(in srgb,#f3cb8a 12%,transparent); border:1px solid color-mix(in srgb,#f3cb8a 32%,transparent);
    color:hsl(var(--text-200)); }
.cm-drift b { display:block; margin-bottom:3px; }
`;
    const top = el('div', 'cm-top');
    top.append(el('span', 'cm-dot off'), el('span', null, 'Codex context channel'));
    statusBody = el('div', 'cm-empty', 'Reading router status…');
    driftNode = el('div', 'cm-drift');
    driftNode.style.display = 'none';
    statusNode.append(style, top, statusBody, driftNode);
    return statusNode;
}

function row(grid, key, value) {
    grid.append(el('div', 'k', key), el('div', 'v', value));
}

function renderDrift(drift) {
    if (!driftNode) return;
    if (!drift || drift.ok) { driftNode.style.display = 'none'; return; }
    driftNode.textContent = '';
    driftNode.style.display = '';
    driftNode.append(el('b', null, 'Codex updated — this lane may no longer match'));
    for (const note of drift.notes || []) driftNode.append(el('div', null, note));
}

async function refreshStatus() {
    if (statusBusy || !statusBody) return;
    statusBusy = true;
    try {
        const value = await cuimod.rpc('context-management.status', { sessionId: cuimod.sessionId });
        const dot = statusNode.querySelector('.cm-dot');
        const window = value?.window;
        const drift = value?.drift;
        dot.className = 'cm-dot' + (!value?.settings?.enabled ? ' off' : (drift && !drift.ok ? ' warn' : ''));
        statusBody.className = window ? 'cm-grid' : 'cm-empty';
        statusBody.textContent = '';
        if (!window) {
            statusBody.textContent = !value?.settings?.enabled
                ? 'Context management is off. GPT sessions use ordinary context handling.'
                : (cuimod.sessionId
                    ? 'No context window has been opened for this session yet. It appears on the first GPT turn.'
                    : 'Open a Code session to see its context window state.');
            renderDrift(drift);
            return;
        }
        const activity = value.activity || {};
        row(statusBody, 'Window', `${window.windowId.slice(0, 8)} (${window.windows} this session)`);
        row(statusBody, 'Previous', window.previousWindowId ? window.previousWindowId.slice(0, 8) : 'none — no reset yet');
        // Turns and hint calls prove the lane is running; tool calls only happen
        // when the model decides to write or read something, which is normal to
        // see at zero early in a session.
        row(statusBody, 'Turns routed', `${activity.turns || 0}${activity.lastTurnAt ? ` · last ${new Date(activity.lastTurnAt).toLocaleTimeString()}` : ''}`);
        row(statusBody, 'Notes lookups', String(activity.hintCalls || 0));
        row(statusBody, 'Model tool calls', activity.toolCalls
            ? `${activity.toolCalls} · last ${new Date(activity.lastToolCallAt).toLocaleTimeString()}`
            : 'none yet — the model writes when it needs to');
        row(statusBody, 'Budget left', Number.isFinite(activity.remaining)
            ? `${Number(activity.remaining).toLocaleString()} tokens` : 'unknown');
        if (activity.failures) row(statusBody, 'Failed calls', String(activity.failures));
        row(statusBody, 'Client version', value.clientVersion || 'unknown');
        if (value.lastError) row(statusBody, 'Last error', value.lastError);
        renderDrift(drift);
    } catch (_) {
        statusBody.className = 'cm-empty';
        statusBody.textContent = 'Router status is temporarily unavailable.';
    } finally { statusBusy = false; }
}

const spec = {
    plugin: 'context-management',
    title: 'Context management',
    description: 'Codex notes, history and window resets for GPT sessions, run from the router on your own ChatGPT plan.',
    defaults: DEF,
    immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled', group: 'Channel',
          hint: 'GPT sessions only. Everything else is untouched. Requires a ChatGPT Plus, Pro or Pro Lite plan.' },
        { key: 'notesTools', type: 'toggle', label: 'Notes tools', group: 'Channel',
          hint: 'Gives the model a server-side scratchpad that survives a window reset. Additive: nothing else about the turn changes.' },
        { key: 'reminders', type: 'toggle', label: 'Budget guidance', group: 'Channel',
          hint: 'Injects the model-owned guidance, and one reminder per window once the remaining budget crosses the threshold.' },
        { key: 'windowReset', type: 'toggle', label: 'Window reset', group: 'Continuity',
          hint: 'Lets the model call new_context. Later turns are sent from the cut point instead of the whole transcript, so continuity moves to its notes.' },
        { key: 'historyTools', type: 'toggle', label: 'Transcript archive', group: 'Continuity',
          hint: 'Asks OpenAI to ingest and index this thread, and gives the model four tools to search it. Notes are what the model chose to write; this is the whole transcript, kept on their servers. Off by default for that reason.' },
        { key: 'truncationBytes', type: 'slider', label: 'Tool output ceiling', min: 1000, max: 100000, step: 1000,
          unit: ' B', group: 'Continuity',
          hint: 'Applied by the backend before it encrypts, so it is the only way to bound a result.' },
        { key: 'contextStatus', type: 'custom', label: 'Current session', group: 'Window', wide: true,
          node: statusCard },
        { key: 'privacy', type: 'info', label: 'What you can see', group: 'Window',
          text: 'Tool results are encrypted by the backend and readable only inside inference, so note contents never reach this machine. The tool descriptions are reserved and cannot be edited, but the guidance this router injects tells the model you may be told about its notes — so ask it.' },
    ],
    apply(values) {
        V = { ...DEF, ...(values || {}) };
        refreshStatus();
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
});

cuimod.onSessionChange(refreshStatus);
ctx.every(4000, refreshStatus);
