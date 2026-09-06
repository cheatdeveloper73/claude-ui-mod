/* claude-ui-mod :: auto-compact (renderer)
 *
 * Two truths stay separate:
 *
 *   Policy     what CUIMOD injects when Desktop starts the next worker.
 *   Observed   what the displayed worker itself returns through
 *              LocalSessions.getContextUsage.
 *
 * Policy never fills an absent observation. A worker started before an edit can
 * legitimately stay on a different window, and showing the new policy as its
 * state is the failure this panel exists to prevent.
 */
'use strict';

const DEF = {
    enabled: false,
    defaultWindow: 0,
    perModel: {},
    sessionOverrides: {},
    precompute: 'default',
};

const PRESETS = [
    { value: 0, label: 'Auto' },
    { value: 200000, label: '200k' },
    { value: 300000, label: '300k' },
    { value: 400000, label: '400k' },
    { value: 500000, label: '500k' },
    { value: 1000000, label: '1M' },
];

const CTX_CHANNEL = cuimod.eipc('claude.web', 'LocalSessions', 'getContextUsage');
let V = { ...DEF };
let models = [];
let observed = null;
let reading = false;
let observationGeneration = 0;
let tableNode = null;
let tableBody = null;
let stateNode = null;
let stateBody = null;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function n(value) { return Number(value || 0).toLocaleString(); }
function short(value) {
    if (!value) return 'Auto';
    if (value % 1000000 === 0) return (value / 1000000) + 'M';
    if (value % 1000 === 0) return (value / 1000) + 'k';
    return n(value);
}

function bare(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/\[[^\]]*\]$/, '')
        .replace(/:(low|medium|high|xhigh|max)$/, '')
        .replace(/^claude-/, '');
}

function desktopSessionId() {
    const match = (location.pathname + location.search)
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? 'local_' + match[0].toLowerCase() : null;
}

function sessionOverride() {
    const id = cuimod.sessionId;
    const value = id && V.sessionOverrides && V.sessionOverrides[id];
    return value && typeof value === 'object' ? value : null;
}

function policyWindow(model) {
    const override = sessionOverride();
    if (override && Object.hasOwn(override, 'window')) return Number(override.window || 0) || 0;
    const perModel = V.perModel || {};
    return Number(perModel[bare(model)] || V.defaultWindow || 0) || 0;
}

function policyEnabled() {
    return sessionOverride()?.enabled ?? V.enabled;
}

function card(title, sub) {
    const node = el('div', 'ac-card');
    const style = document.createElement('style');
    style.textContent = CSS;
    const top = el('div', 'ac-top');
    top.append(el('span', null, title));
    if (sub) top.append(el('span', 'sub', sub));
    node.append(style, top);
    return node;
}

const CSS = `
.ac-card { border-radius:10px; padding:12px 13px; background:color-mix(in srgb,hsl(var(--text-100)) 5%,transparent);
    border:1px solid color-mix(in srgb,hsl(var(--text-100)) 9%,transparent); color:hsl(var(--text-200)); }
.ac-top { display:flex; align-items:baseline; gap:8px; font-size:12px; font-weight:600; }
.ac-top .sub { font-size:11px; font-weight:400; color:hsl(var(--text-500)); }
.ac-head,.ac-row { display:grid; grid-template-columns:minmax(120px,1fr) max-content; gap:12px; align-items:center; }
.ac-head { margin-top:12px; padding:0 6px 6px; border-bottom:1px solid color-mix(in srgb,hsl(var(--text-100)) 8%,transparent);
    color:hsl(var(--text-500)); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; }
.ac-head .r { text-align:right; }
.ac-group { margin-top:11px; padding:0 6px 4px; color:hsl(var(--text-400)); font-size:10px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; }
.ac-row { padding:5px 6px; border-radius:7px; }
.ac-row.active { background:color-mix(in srgb,#7cbd8b 8%,transparent); }
.ac-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:7px; font-size:11.5px; }
.ac-badge { flex:none; border-radius:999px; padding:2px 6px; border:1px solid color-mix(in srgb,#7cbd8b 34%,transparent);
    background:color-mix(in srgb,#7cbd8b 14%,transparent); color:#7cbd8b; font-size:9px; letter-spacing:.05em; text-transform:uppercase; }
.ac-seg { display:flex; gap:2px; padding:2px; border-radius:7px; background:color-mix(in srgb,hsl(var(--text-100)) 6%,transparent); }
.ac-seg button { appearance:none; border:0; cursor:pointer; font:inherit; font-size:10.5px; line-height:1; padding:5px 9px;
    border-radius:5px; background:transparent; color:hsl(var(--text-500)); }
.ac-seg button:hover { color:hsl(var(--text-200)); }
.ac-seg button.on { background:color-mix(in srgb,hsl(var(--text-100)) 14%,transparent); color:hsl(var(--text-100)); }
.ac-empty { margin-top:9px; line-height:1.45; color:hsl(var(--text-500)); font-size:11px; }
.ac-grid { display:grid; grid-template-columns:max-content 1fr; gap:5px 12px; margin-top:11px; font-size:11px; }
.ac-grid .k { color:hsl(var(--text-500)); }
.ac-grid .v { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:hsl(var(--text-300)); }
.ac-warn { margin-top:10px; border-radius:8px; padding:8px 10px; border:1px solid color-mix(in srgb,#f3cb8a 32%,transparent);
    background:color-mix(in srgb,#f3cb8a 12%,transparent); color:hsl(var(--text-200)); font-size:11px; line-height:1.5; }
`;

// --------------------------------------------------------------- policy ----

function tableCard() {
    if (tableNode) return tableNode;
    tableNode = card('Policy for new workers', 'the launch flag CUIMOD owns');
    tableBody = el('div', 'ac-empty', 'Loading the model catalogue…');
    tableNode.append(tableBody);
    loadModels();
    return tableNode;
}

async function loadModels() {
    if (models.length) return;
    let configured = [];
    try {
        const rows = await cuimod.rpc('auto-compact.models');
        if (Array.isArray(rows)) configured = rows;
    } catch (_) {}

    // provider-picker's page-world adapter is the only source for the native
    // model rows the selector received from Desktop. Its snapshot is read-only.
    // The fallback list from auto-compact.models keeps the panel useful before
    // that cache has appeared on a just-opened page.
    let native = [];
    try {
        const state = await cuimod.rpc('provider-picker.nativeSync');
        if (Array.isArray(state?.nativeModels)) native = state.nativeModels;
    } catch (_) {}

    const rows = [];
    const byId = new Map();
    const add = row => {
        const id = String(row?.id || '').trim().toLowerCase();
        if (!id) return;
        const next = { id, name: String(row?.name || id), provider: row?.provider || 'claude',
            providerLabel: row?.providerLabel || (row?.provider === 'claude' || !row?.provider ? 'Claude' : row.provider) };
        const old = byId.get(id);
        if (old) { Object.assign(old, next); return; }
        byId.set(id, next); rows.push(next);
    };
    for (const row of configured) add(row);
    for (const row of native) add({ ...row, provider: 'claude', providerLabel: 'Claude' });

    const order = [];
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.provider)) { grouped.set(row.provider, []); order.push(row.provider); }
        grouped.get(row.provider).push(row);
    }
    models = order.flatMap(provider => grouped.get(provider));
    paintTable();
}

function setWindow(model, value) {
    const perModel = { ...(V.perModel || {}) };
    if (value) perModel[bare(model)] = value;
    else delete perModel[bare(model)];
    const registry = globalThis.__cuimodReg;
    if (registry && typeof registry.set === 'function') registry.set('auto-compact', 'perModel', perModel);
    V = { ...V, perModel };
    paintTable();
}

function paintTable() {
    if (!tableBody) return;
    if (!models.length) {
        tableBody.textContent = 'No picker catalogue is available yet.';
        return;
    }
    const wrap = el('div');
    const head = el('div', 'ac-head');
    head.append(el('div', null, 'Model'), el('div', 'r', 'Configured window'));
    wrap.append(head);

    let provider = null;
    const active = observed?.model ? bare(observed.model) : null;
    for (const model of models) {
        if (model.providerLabel !== provider) {
            provider = model.providerLabel;
            wrap.append(el('div', 'ac-group', provider));
        }
        const configured = policyWindow(model.id);
        const row = el('div', 'ac-row' + (active === bare(model.id) ? ' active' : ''));
        const name = el('div', 'ac-name');
        name.append(el('span', null, model.name || model.id));
        if (active === bare(model.id)) name.append(el('span', 'ac-badge', 'active worker'));
        row.append(name);
        const segment = el('div', 'ac-seg');
        for (const preset of PRESETS) {
            const button = el('button', configured === preset.value ? 'on' : null, preset.label);
            button.type = 'button';
            button.addEventListener('click', () => setWindow(model.id, preset.value));
            segment.append(button);
        }
        row.append(segment);
        wrap.append(row);
    }
    tableBody.replaceWith(wrap);
    tableBody = wrap;
}

// ------------------------------------------------------------- observed ----

function stateCard() {
    if (stateNode) return stateNode;
    stateNode = card('Observed worker', 'read from the displayed CLI session');
    stateBody = el('div', 'ac-empty', 'Open this panel to query the worker. Policy values never substitute for this result.');
    stateNode.append(stateBody);
    refreshObserved();
    return stateNode;
}

function validUsage(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.isAutoCompactEnabled !== 'boolean') return null;
    if (!Number.isFinite(value.autoCompactThreshold) || value.autoCompactThreshold <= 0) return null;
    if (!Number.isFinite(value.rawMaxTokens) || value.rawMaxTokens <= 0) return null;
    if (typeof value.autocompactSource !== 'string') return null;
    if (typeof value.model !== 'string' || !value.model) return null;
    return value;
}

async function refreshObserved() {
    if (reading || !stateNode?.isConnected) return;
    const desktopId = desktopSessionId();
    if (!desktopId) { observed = null; paintObserved('Open a Code session to observe its worker.'); return; }
    reading = true;
    const generation = ++observationGeneration;
    try {
        const value = await cuimod.appInvoke(CTX_CHANNEL, desktopId);
        // Navigation is asynchronous. Never paint an old session's answer into
        // the panel after the URL moved to a different session.
        if (generation !== observationGeneration || desktopSessionId() !== desktopId) return;
        observed = validUsage(value);
        paintObserved(observed ? null : 'This worker has not reported a model state yet.');
        paintTable();
    } catch (_) {
        if (generation === observationGeneration) {
            observed = null;
            paintObserved('The worker state is not available yet.');
        }
    } finally { reading = false; }
}

function add(grid, key, value) { grid.append(el('div', 'k', key), el('div', 'v', value)); }

function paintObserved(empty) {
    if (!stateBody) return;
    let body;
    if (empty || !observed) {
        body = el('div', 'ac-empty', empty || 'This worker has not reported a model state yet.');
    } else {
        body = el('div', 'ac-grid');
        add(body, 'Model', observed.model);
        add(body, 'Enabled', observed.isAutoCompactEnabled ? 'yes' : 'no');
        add(body, 'Worker window', n(observed.rawMaxTokens) + ' tokens');
        add(body, 'Trigger', n(observed.autoCompactThreshold) + ' tokens');
        add(body, 'Source', observed.autocompactSource);
        add(body, 'Enforced', 'not exposed by LocalSessions.getContextUsage');
        const desired = policyWindow(observed.model);
        add(body, 'CUIMOD policy', policyEnabled() ? short(desired) + ' for this session' : 'off for this session');
    }
    stateBody.replaceWith(body);
    stateBody = body;
}

const spec = {
    plugin: 'auto-compact',
    title: 'Auto-compact',
    description: 'CUIMOD launch policy beside the displayed worker’s own reported state.',
    defaults: DEF,
    immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Auto-compact for new workers', group: 'Launch policy',
          hint: 'Off injects DISABLE_AUTO_COMPACT. Existing workers retain their own state.' },
        { key: 'precompute', type: 'combo', label: 'Precompute summaries', group: 'Launch policy', options: [
            { value: 'default', label: 'Claude Code default' },
            { value: 'on', label: 'On for new workers' },
            { value: 'off', label: 'Off for new workers' },
        ], hint: 'Requested at launch. Claude Code does not expose its resolved precompute state through LocalSessions.' },
        { key: 'defaultWindow', type: 'slider', label: 'Fallback window', min: 0, max: 1000000, step: 50000,
          unit: ' tokens', group: 'Launch policy',
          hint: '0 passes auto to Claude Code. A model row overrides this fallback.' },
        { key: 'perModel', type: 'custom', label: 'Model windows', group: 'Launch policy', wide: true, node: tableCard },
        { key: 'observed', type: 'custom', label: 'This worker', group: 'Observed', wide: true, node: stateCard },
    ],
    apply(values) {
        V = { ...DEF, ...(values || {}) };
        paintTable();
        paintObserved();
    },
};

const registry = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
registry.specs.set(spec.plugin, spec);
registry.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    observationGeneration++;
    registry.specs.delete(spec.plugin);
    registry.subs.forEach(fn => { try { fn(); } catch (_) {} });
});

cuimod.onSessionChange(() => {
    observationGeneration++;
    observed = null;
    paintObserved('The displayed session changed. Waiting for its worker state.');
    if (stateNode?.isConnected) refreshObserved();
});
// The panel is the opt-in observer. This timer does nothing while it is closed,
// so reloading the hot renderer cannot query or alter an existing session.
ctx.every(4000, () => { if (stateNode?.isConnected) refreshObserved(); });
