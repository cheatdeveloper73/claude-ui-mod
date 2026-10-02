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
    { value: 256000, label: '256k' },
    { value: 300000, label: '300k' },
    { value: 400000, label: '400k' },
    { value: 500000, label: '500k' },
    { value: 900000, label: '900k' },
    { value: 950000, label: '950k' },
    { value: 1000000, label: '1M' },
];

// No Auto here. Clearing the override back to the launch value is a different
// operation from replacing it, and only replacement is measured, so the control
// offers the windows it can prove and nothing else.
const LIVE_PRESETS = PRESETS.filter(preset => preset.value > 0);

const CTX_CHANNEL = cuimod.eipc('claude.web', 'LocalSessions', 'getContextUsage');
let V = { ...DEF };
let models = [];
let modelsLoading = false;
let observed = null;
let observationGeneration = 0;
let observationFlight = null;
let observationQueued = false;
let observedDesktopId = desktopSessionId();
let observedCliSessionId = cuimod.sessionId || null;
let rendererDisposed = false;
let tableNode = null;
let tableBody = null;
let listNode = null;
const rows = new Map();      // model id -> { row, badge, buttons }
let revealedModel = null;
let stateNode = null;
let stateEmpty = null;
let stateBody = null;
let obs = null;              // in-place handles for the observed card
let liveBusy = false;
let liveApplyOwner = null;
let liveWant = null;
let enabledWant = null;
let liveNote = null;
let chaseUntil = 0;

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
        .replace(/\[1m\]/g, '')
        .replace(/:(none|minimal|low|medium|high|xhigh|max|ultra|pro)$/, '')
        .replace(/^(?:claude-)+/, '');
}

// A declared provider's measured ceiling, which caps the session window.
function windowRow(model) {
    const row = models.find(row => bare(row.id) === bare(model));
    return row?.registered && Number.isFinite(row.context) ? row : null;
}

function providerWindow(model) {
    return windowRow(model)?.context ?? null;
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

// What the per-model table paints and writes. The session override is
// deliberately not consulted here: it is one value for the whole session, so
// folding it in made every row of a per-model table show that one number. A
// click then wrote perModel correctly, the repaint read the override straight
// back, and the highlight never moved — which is indistinguishable from the
// control being dead.
function modelWindow(model) {
    const perModel = V.perModel || {};
    const requested = Number(perModel[bare(model)] || V.defaultWindow || 0) || 0;
    const cap = providerWindow(model);
    return cap === null ? requested : Math.min(requested || cap, cap);
}

// What the next worker for *this* session would actually launch on. Only a
// positive override counts: the enablement toggle used to record `window: 0`
// beside every on/off, and nothing offers "pin this session to auto", so a zero
// is a leftover sentinel rather than a choice.
function sessionLaunchWindow(model) {
    const chosen = Number(sessionOverride()?.window || 0);
    const requested = chosen > 0 ? chosen : modelWindow(model);
    const cap = providerWindow(model);
    return cap === null ? requested : Math.min(requested || cap, cap);
}

function policyEnabled() {
    return sessionOverride()?.enabled ?? V.enabled;
}

// The dashboard row already carries a title and a hint for each of these
// controls, so a card with its own heading printed the same thing twice inside a
// second border — a box in a box in a box. The plugin node is now just content,
// and the row it sits in is its frame.
function section() {
    const node = el('div', 'ac-sect');
    const style = document.createElement('style');
    style.textContent = CSS;
    node.append(style);
    return node;
}

const CSS = `
.ac-sect { color:hsl(var(--text-200)); }

/* Header and rows are the same flex shape with the same two flex bases, so the
 * column head sits over the control it names whatever the panel width is. The
 * old grid gave the head a max-content track sized by its own label and the rows
 * a track sized by six buttons, which is why "Configured window" was printed
 * over the 400k button. */
.ac-head { display:flex; align-items:center; gap:12px; padding:0 8px 7px;
    border-bottom:1px solid color-mix(in srgb,hsl(var(--text-100)) 8%,transparent);
    color:hsl(var(--text-500)); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; }
.ac-head .m { flex:1 1 0; min-width:0; }
.ac-head .r { flex:0 1 250px; text-align:center; }

/* Twenty models is more than the panel can show beside anything else, so the
 * list is a scroll region of its own and the observed card stays reachable. */
/* No overscroll containment: running off the end of the list and carrying on
 * down the settings page is what the dashboard's other inner blocks do. */
.ac-list { max-height:340px; overflow-y:auto; padding:2px 0; }
.ac-group { margin:11px 0 3px; padding:0 8px; color:hsl(var(--text-400));
    font-size:9.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.ac-group:first-child { margin-top:4px; }
.ac-row { display:flex; align-items:center; gap:12px; padding:4px 8px; border-radius:8px;
    transition:background 110ms cubic-bezier(.2,.85,.3,1); }
.ac-row:hover { background:color-mix(in srgb,hsl(var(--text-100)) 4%,transparent); }
.ac-row.active { background:color-mix(in srgb,#7cbd8b 9%,transparent); }

/* text-overflow only acts on the box that holds the text. It was set on the flex
 * container, so a long model name was cut off square and the badge beside it was
 * sliced through the middle of its own word. The name span clips; the badge
 * never shrinks. */
/* flex-basis 0, not auto: on auto the name claims its content width first, so
 * the one long model name in the list stole space from its own segment and that
 * row's buttons sat a few pixels left of every other row's. */
.ac-name { flex:1 1 0; min-width:0; display:flex; align-items:center; gap:7px;
    font-size:11.5px; color:hsl(var(--text-200)); }
.ac-name .t { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ac-badge { flex:none; border-radius:999px; padding:1.5px 6px;
    border:1px solid color-mix(in srgb,#7cbd8b 34%,transparent);
    background:color-mix(in srgb,#7cbd8b 14%,transparent); color:#7cbd8b;
    font-size:8.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; }

/* One always-on track per row stacked twenty pills down the panel. The track is
 * a hover affordance now; the chosen value keeps its fill either way, so nothing
 * that carries state depends on the pointer being there. */
.ac-seg { flex:0 1 250px; display:flex; gap:2px; padding:2px; border-radius:7px;
    background:transparent; transition:background 110ms cubic-bezier(.2,.85,.3,1); }
.ac-row:hover .ac-seg, .ac-row.active .ac-seg, .ac-seg.solid {
    background:color-mix(in srgb,hsl(var(--text-100)) 6%,transparent); }
.ac-seg button { flex:1 1 0; min-width:0; appearance:none; border:0; cursor:pointer; font:inherit;
    font-size:10.5px; line-height:1; padding:5px 4px; border-radius:5px;
    background:transparent; color:hsl(var(--text-500));
    transition:background 110ms cubic-bezier(.2,.85,.3,1), color 110ms cubic-bezier(.2,.85,.3,1); }
.ac-seg button:hover:not(:disabled) { color:hsl(var(--text-100));
    background:color-mix(in srgb,hsl(var(--text-100)) 8%,transparent); }
.ac-seg button.on { background:color-mix(in srgb,hsl(var(--text-100)) 15%,transparent); color:hsl(var(--text-100)); }
.ac-row.active .ac-seg button.on { background:color-mix(in srgb,#7cbd8b 26%,transparent); color:#e8f4eb; }
.ac-seg button:disabled { opacity:.4; cursor:default; }
.ac-seg button.pending { color:hsl(var(--text-200));
    box-shadow:inset 0 0 0 1px color-mix(in srgb,hsl(var(--text-100)) 20%,transparent); }

.ac-empty { padding:4px 2px; line-height:1.45; color:hsl(var(--text-500)); font-size:11px; }
.ac-grid { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 14px;
    padding:1px 2px; font-size:11px; }
.ac-grid .k { color:hsl(var(--text-500)); }
.ac-grid .v { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    color:hsl(var(--text-300)); font-variant-numeric:tabular-nums; }
.ac-grid .v.dim { color:hsl(var(--text-500)); }

/* Both live controls under one rule. Two rows each carrying their own divider
 * drew a second line eleven pixels below the first for no reason. */
.ac-live-block { display:flex; flex-direction:column; gap:9px; margin-top:12px; padding-top:11px;
    border-top:1px solid color-mix(in srgb,hsl(var(--text-100)) 8%,transparent); }
.ac-live { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.ac-live .ac-seg { flex:0 0 auto; }
.ac-live .ac-seg button { padding:5px 10px; }
.ac-live-label { color:hsl(var(--text-500)); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; }
.ac-note { margin-top:10px; color:hsl(var(--text-500)); font-size:11px; line-height:1.45; }
`;

// --------------------------------------------------------------- policy ----

function policySection() {
    if (tableNode) return tableNode;
    tableNode = section();
    tableBody = el('div', 'ac-empty', 'Loading the model catalogue…');
    tableNode.append(tableBody);
    loadModels();
    return tableNode;
}

async function loadModels() {
    if (modelsLoading || rendererDisposed) return;
    modelsLoading = true;
    try {
        let configured = [];
        try {
            const rows = await observeWithin(cuimod.rpc('auto-compact.models'));
            if (Array.isArray(rows)) configured = rows;
        } catch (_) { return; }

        // The picker supplies the native rows; the policy RPC adds the same
        // dynamic web catalogue it uses for launch and live settings.
        let native = [];
        try {
            const state = await observeWithin(cuimod.rpc('provider-picker.nativeSync'));
            if (Array.isArray(state?.nativeModels)) native = state.nativeModels;
        } catch (_) {}

        const rows = [];
        const byId = new Map();
        const add = row => {
            const id = String(row?.id || '').trim().toLowerCase();
            if (!id) return;
            const next = { id, name: String(row?.name || id), provider: row?.provider || 'claude',
                ...(Number.isFinite(row?.context) ? { context: row.context } : {}),
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
        const next = order.flatMap(provider => grouped.get(provider));
        if (rendererDisposed || JSON.stringify(next) === JSON.stringify(models)) return;
        models = next;
        // Only a catalogue change rebuilds rows. Policy edits and worker polls
        // keep existing nodes; discovery replacement preserves the scroll.
        const scrollTop = listNode?.scrollTop || 0;
        if (listNode) { listNode = null; buildTable(); listNode.scrollTop = scrollTop; }
        paintTable();
        paintObserved();
    } finally { modelsLoading = false; }
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

// The list is stable between catalogue revisions. A replaced scroll container starts
// at scrollTop 0, and this one was replaced whenever anything in it differed:
// every click on a preset, every drag of the fallback slider (apply() runs per
// input event), and every poll where the worker state briefly went absent and
// came back. Scrolled halfway down the catalogue, all three read as the list
// throwing you back to the top at random.
function buildTable() {
    const wrap = el('div');
    const head = el('div', 'ac-head');
    head.append(el('div', 'm', 'Model'), el('div', 'r', 'Configured window'));
    listNode = el('div', 'ac-list cui-scroll');
    wrap.append(head, listNode);

    rows.clear();
    let provider = null;
    for (const model of models) {
        if (model.providerLabel !== provider) {
            provider = model.providerLabel;
            listNode.append(el('div', 'ac-group', provider));
        }
        const row = el('div', 'ac-row');
        const name = el('div', 'ac-name');
        // Present on every row and hidden, rather than inserted and removed.
        // Adding a node to the active row is a layout change in the middle of a
        // list somebody may be scrolling.
        const badge = el('span', 'ac-badge', 'active');
        badge.hidden = true;
        name.append(el('span', 't', model.name || model.id), badge);
        row.append(name);
        const segment = el('div', 'ac-seg');
        const buttons = PRESETS.map(preset => {
            const button = el('button', null, preset.label);
            button.type = 'button';
            button.addEventListener('click', () => setWindow(model.id, preset.value));
            segment.append(button);
            return button;
        });
        row.append(segment);
        listNode.append(row);
        rows.set(model.id, { row, badge, buttons });
    }
    tableBody.replaceWith(wrap);
    tableBody = wrap;
}

function paintTable() {
    if (!tableBody) return;
    if (!models.length) {
        if (!listNode) tableBody.textContent = 'No picker catalogue is available yet.';
        return;
    }
    if (!listNode) buildTable();

    const active = observed?.model ? bare(observed.model) : null;
    let activeRow = null;
    for (const [id, entry] of rows) {
        const configured = modelWindow(id);
        const cap = providerWindow(id);
        entry.buttons.forEach((button, i) => {
            button.classList.toggle('on', PRESETS[i].value === configured);
            button.disabled = cap !== null && PRESETS[i].value > cap;
        });
        const isActive = active === bare(id);
        entry.row.classList.toggle('active', isActive);
        entry.badge.hidden = !isActive;
        if (isActive) activeRow = entry.row;
    }

    // Bring the running model into the capped list, and only when it is not
    // already in view — scrollTop rather than scrollIntoView, which would also
    // drag the settings page the list is nested inside.
    //
    // revealedModel is never cleared on an absent reading. A failed poll makes
    // `active` null for one beat, and clearing it there meant the next good poll
    // counted the same unchanged model as newly arrived and scrolled to it.
    if (!activeRow || active === revealedModel) return;
    revealedModel = active;
    const top = activeRow.offsetTop;
    const above = top < listNode.scrollTop;
    const below = top + activeRow.offsetHeight > listNode.scrollTop + listNode.clientHeight;
    if (above || below) {
        listNode.scrollTop = Math.max(0, top - Math.round(listNode.clientHeight / 2));
    }
}

// ------------------------------------------------------------- observed ----

function observedSection() {
    if (stateNode) return stateNode;
    stateNode = section();
    stateEmpty = el('div', 'ac-empty',
        'Open this panel to query the worker. Policy values never substitute for this result.');
    stateNode.append(stateEmpty, buildObserved());
    stateBody.hidden = true;
    refreshObserved();
    return stateNode;
}

function validUsage(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.isAutoCompactEnabled !== 'boolean') return null;
    // A disabled worker reports no threshold at all — measured on a live
    // session: enabled false, window 1000000, source "auto", autoCompactThreshold
    // absent. Requiring it here rejected the whole payload, so `observed` went
    // null and the card fell back to "has not reported a model state yet" on
    // precisely the sessions that need turning on. Demand it only when the
    // worker says auto-compact is on.
    if (value.isAutoCompactEnabled
        && (!Number.isFinite(value.autoCompactThreshold) || value.autoCompactThreshold <= 0)) return null;
    if (!Number.isFinite(value.rawMaxTokens) || value.rawMaxTokens <= 0) return null;
    if (typeof value.autocompactSource !== 'string') return null;
    if (typeof value.model !== 'string' || !value.model) return null;
    return value;
}

const OBSERVATION_TIMEOUT_MS = 5000;

function observedOwned(owner) {
    return !rendererDisposed && owner.generation === observationGeneration
        && owner.desktopId === observedDesktopId && owner.desktopId === desktopSessionId();
}

function observeWithin(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('worker observation timed out')), OBSERVATION_TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function invalidateObserved(nextDesktopId = desktopSessionId(), nextCliSessionId = cuimod.sessionId || null) {
    observationGeneration++;
    observationFlight = null;
    observationQueued = false;
    observedDesktopId = nextDesktopId;
    observedCliSessionId = nextCliSessionId;
    observed = null;
    liveApplyOwner = null;
    liveBusy = false;
    liveWant = null;
    enabledWant = null;
    liveNote = null;
    chaseUntil = 0;
    revealedModel = null;
    paintObserved(nextDesktopId
        ? 'The displayed session changed. Waiting for its worker state.'
        : 'Open a Code session to observe its worker.');
    paintTable();
}

function syncObservedIdentity() {
    const desktopId = desktopSessionId();
    if (desktopId === observedDesktopId) return false;
    invalidateObserved(desktopId, cuimod.sessionId || null);
    return true;
}

async function refreshObserved() {
    syncObservedIdentity();
    if (!stateNode?.isConnected) return false;
    const desktopId = observedDesktopId;
    if (!desktopId) { observed = null; paintObserved('Open a Code session to observe its worker.'); return false; }
    const generation = observationGeneration;
    if (observationFlight?.generation === generation) {
        observationQueued = true;
        return observationFlight.promise;
    }

    const owner = { generation, desktopId, promise: null };
    const run = Promise.resolve().then(async () => {
        try {
            const value = await observeWithin(cuimod.appInvoke(CTX_CHANNEL, desktopId));
            if (!observedOwned(owner)) return false;
            observed = validUsage(value);
            settleLive();
            paintObserved(observed ? null : 'This worker has not reported a model state yet.');
            paintTable();
            return true;
        } catch (_) {
            if (!observedOwned(owner)) return false;
            observed = null;
            paintObserved('The worker state is not available yet.');
            return false;
        } finally {
            if (observationFlight !== owner) return;
            observationFlight = null;
            if (observationQueued && observedOwned(owner)) {
                observationQueued = false;
                queueMicrotask(refreshObserved);
            }
        }
    });
    owner.promise = run;
    observationFlight = owner;
    return run;
}

// ----------------------------------------------------------- live window ----

// The window a running worker resolves comes from `Cb()`, whose first branch is
// `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` and which returns from there
// before it looks at the appState value the launch flag wrote. A flag-settings
// patch carrying `settings.env` is applied into the worker's own process env on
// the way through its settings-change handler, so the next resolution — the
// reported window and the compaction gate's threshold alike — reads the new
// number. That is why this control exists beside a table that cannot.
function saveSessionOverride(cliSessionId, enabled, window) {
    if (!cliSessionId) return;
    const registry = globalThis.__cuimodReg;
    if (!registry?.specs?.has('auto-compact') || typeof registry.set !== 'function') return;
    // A resume launches a fresh worker, which starts from the flag again. Record
    // the number so the reopened session is not silently back on its old window
    // while the panel still shows the choice — but only a real number. Writing a
    // zero here is what masked the per-model table for every session the
    // enablement toggle had ever touched.
    const stored = (registry.get?.('auto-compact')?.sessionOverrides) || {};
    const held = stored[cliSessionId];
    const kept = Number(window) > 0 ? Math.round(Number(window)) : Number(held?.window || 0);
    registry.set('auto-compact', 'sessionOverrides', {
        ...stored,
        [cliSessionId]: kept > 0 ? { enabled, window: kept } : { enabled },
    });
}

// An acknowledgement is not a state. A button only moves once the worker's own
// getContextUsage reports the change back.
function settleLive() {
    if (liveWant == null && enabledWant == null) return;
    const windowLanded = liveWant == null
        || (observed && observed.rawMaxTokens === liveWant && observed.autocompactSource === 'env');
    const enabledLanded = enabledWant == null
        || (observed && observed.isAutoCompactEnabled === enabledWant);
    if (windowLanded && enabledLanded) {
        const said = [];
        if (enabledWant != null) said.push('auto-compact ' + (enabledWant ? 'on' : 'off'));
        if (liveWant != null) said.push(short(liveWant) + ' at source env');
        liveNote = 'This worker reports ' + said.join(', ') + '.';
        liveWant = null;
        enabledWant = null;
        chaseUntil = 0;
        return;
    }
    if (Date.now() > chaseUntil) {
        const missed = [];
        if (!enabledLanded) missed.push('auto-compact ' + (enabledWant ? 'on' : 'off'));
        if (!windowLanded) missed.push(short(liveWant));
        liveNote = 'The worker never reported ' + missed.join(' or ') + '. It reports '
            + (observed
                ? (observed.isAutoCompactEnabled ? 'on' : 'off') + ', ' + short(observed.rawMaxTokens)
                    + ' at source ' + observed.autocompactSource
                : 'nothing') + '.';
        liveWant = null;
        enabledWant = null;
    }
}

// One send for both controls. `enabled` always rides along because the patch is
// a whole flag-settings shape, so changing the window has to restate the
// enablement the worker is already in rather than silently flipping it.
async function send(enabled, window, note) {
    syncObservedIdentity();
    const desktopId = observedDesktopId;
    if (liveBusy || !desktopId || !observed) return;
    const owner = { generation: observationGeneration, desktopId, cliSessionId: observedCliSessionId };
    liveApplyOwner = owner;
    liveBusy = true;
    if (window != null) liveWant = window;
    if (enabled !== observed.isAutoCompactEnabled) enabledWant = enabled;
    liveNote = note + '…';
    paintObserved();
    try {
        const result = await observeWithin(cuimod.rpc('auto-compact.apply', { sessionId: desktopId, enabled, window }));
        if (!result?.applied) throw new Error(result?.reason || 'worker unavailable');
        // The named result may be persisted for the worker that accepted it after
        // navigation. A missing id may only fall back to the captured current
        // session; using cuimod.sessionId here wrote old events into the new view.
        const target = result.cliSessionId || (observedOwned(owner) ? owner.cliSessionId : null);
        const accepted = result.windowSent ? result.window : window;
        if (target) saveSessionOverride(target, enabled, accepted == null ? liveWindowNow() : accepted);
        if (!observedOwned(owner)) return;
        if (result.windowSent) liveWant = result.window;
        liveNote = 'Waiting for the worker to confirm…';
        chaseUntil = Date.now() + 12000;
    } catch (error) {
        if (!observedOwned(owner)) return;
        liveWant = null;
        enabledWant = null;
        chaseUntil = 0;
        liveNote = 'Could not apply: ' + ((error && error.message) || error);
    } finally {
        if (liveApplyOwner !== owner) return;
        liveApplyOwner = null;
        liveBusy = false;
        paintObserved();
        refreshObserved();
    }
}

// Only an env-sourced window is a live override this panel set. Anything else is
// the launch value, and persisting that as a session override would pin a number
// the user never chose.
function liveWindowNow() {
    return observed?.autocompactSource === 'env' ? observed.rawMaxTokens : 0;
}

// The observed card is built once and patched. It used to be thrown away and
// rebuilt on every four-second poll, which meant the two segmented controls were
// replaced under the pointer while a click was being aimed at them — and a
// pending button lost its own hover the moment the state it was waiting for
// arrived.
//
// Nothing in this panel carries a `title`. The tooltip it produces is drawn by
// the OS, so it arrives as a bare grey box in the middle of a styled overlay
// that has no other native chrome in it, and no CSS in the shadow root can
// touch it. What the controls do is said in the dashboard row's own hint.
function segmentRow(label, choices) {
    const row = el('div', 'ac-live');
    row.append(el('span', 'ac-live-label', label));
    const segment = el('div', 'ac-seg solid');
    const buttons = [];
    for (const choice of choices) {
        const button = el('button', null, choice.label);
        button.type = 'button';
        button.addEventListener('click', () => choice.run());
        segment.append(button);
        buttons.push(button);
    }
    row.append(segment);
    return { row, buttons };
}

function buildObserved() {
    stateBody = el('div');
    const grid = el('div', 'ac-grid');
    const value = {};
    const add = (key, label, dim) => {
        grid.append(el('div', 'k', label));
        const node = el('div', 'v' + (dim ? ' dim' : ''));
        grid.append(node);
        value[key] = node;
    };
    add('model', 'Model');
    add('enabled', 'Enabled');
    add('window', 'Worker window');
    add('trigger', 'Trigger');
    add('source', 'Source');
    add('enforced', 'Enforced', true);
    add('next', 'Next launch');
    value.enforced.textContent = 'not exposed by LocalSessions.getContextUsage';

    const enabled = segmentRow('Auto-compact', [true, false].map(want => ({
        label: want ? 'On' : 'Off',
        run: () => send(want, null, 'Turning auto-compact ' + (want ? 'on' : 'off')),
    })));
    const live = segmentRow('Live window', LIVE_PRESETS.map(preset => ({
        label: preset.label,
        run: () => observed && send(observed.isAutoCompactEnabled, preset.value,
            'Sending ' + short(preset.value) + ' to this worker'),
    })));
    const block = el('div', 'ac-live-block');
    block.append(enabled.row, live.row);

    const note = el('div', 'ac-note');
    stateBody.append(grid, block, note);
    obs = { value, enabled: enabled.buttons, live: live.buttons, note };
    return stateBody;
}

function updateObserved() {
    if (!obs || !observed) return;
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    set(obs.value.model, observed.model);
    set(obs.value.enabled, observed.isAutoCompactEnabled ? 'yes' : 'no');
    set(obs.value.window, n(observed.rawMaxTokens) + ' tokens');
    set(obs.value.trigger, observed.isAutoCompactEnabled
        ? n(observed.autoCompactThreshold) + ' tokens'
        : 'none while auto-compact is off');
    set(obs.value.source, observed.autocompactSource);
    // The one place a session override belongs: it describes this session's
    // next launch. Name the policy layer instead of making a fallback or native
    // Auto value look like an explicit model row.
    const pinned = Number(sessionOverride()?.window || 0);
    const perModel = Number(V.perModel?.[bare(observed.model)] || 0);
    const fallback = Number(V.defaultWindow || 0);
    const desired = sessionLaunchWindow(observed.model);
    const source = pinned > 0 ? 'session policy'
        : perModel > 0 ? 'model policy'
        : fallback > 0 ? 'fallback policy'
        : windowRow(observed.model) ? (windowRow(observed.model).providerLabel || 'provider') + ' estimate' : 'Claude Code default';
    set(obs.value.next, policyEnabled()
        ? short(desired) + ' (' + source + ')'
        : 'off for this session');

    const busy = liveBusy || !desktopSessionId();
    obs.enabled.forEach((button, i) => {
        const want = i === 0;
        button.classList.toggle('on', observed.isAutoCompactEnabled === want);
        button.classList.toggle('pending', enabledWant === want);
        button.disabled = busy;
    });
    obs.live.forEach((button, i) => {
        const preset = LIVE_PRESETS[i];
        button.classList.toggle('on',
            observed.autocompactSource === 'env' && observed.rawMaxTokens === preset.value);
        button.classList.toggle('pending', liveWant === preset.value);
        const cap = providerWindow(observed.model);
        button.disabled = busy || (cap !== null && preset.value > cap);
    });

    obs.note.textContent = liveNote || '';
    obs.note.hidden = !liveNote;
}

function paintObserved(empty) {
    if (!stateEmpty || !stateBody) return;
    const message = empty || (observed ? null : 'This worker has not reported a model state yet.');
    if (message) stateEmpty.textContent = message;
    stateEmpty.hidden = !message;
    stateBody.hidden = !!message;
    if (!message) updateObserved();
}

const spec = {
    plugin: 'auto-compact',
    title: 'Auto-compact',
    description: 'CUIMOD launch policy beside the displayed worker’s own reported state.',
    defaults: DEF,
    immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Auto-compact for new workers', group: 'Launch policy',
          hint: 'Sets the launch auto-compact policy. Existing workers retain their own state.' },
        { key: 'precompute', type: 'combo', label: 'Precompute summaries', group: 'Launch policy', options: [
            { value: 'default', label: 'Claude Code default' },
            { value: 'on', label: 'On for new workers' },
            { value: 'off', label: 'Off for new workers' },
        ], hint: 'Requested at launch. Claude Code does not expose its resolved precompute state through LocalSessions.' },
        { key: 'defaultWindow', type: 'slider', label: 'Fallback window', min: 0, max: 1000000, step: 50000,
          unit: ' tokens', group: 'Launch policy',
          hint: '0 passes auto to Claude Code. A model row overrides this fallback.' },
        { key: 'perModel', type: 'custom', label: 'Model windows', group: 'Launch policy', wide: true,
          hint: 'The launch flag CUIMOD owns. A running worker keeps the window it started on.',
          node: policySection },
        { key: 'observed', type: 'custom', label: 'This worker', group: 'Observed', wide: true,
          hint: 'Read from the displayed CLI session; policy values never substitute for it. '
              + 'Both controls reach the running worker without restarting it.',
          node: observedSection },
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
    rendererDisposed = true;
    observationGeneration++;
    observationFlight = null;
    observationQueued = false;
    liveApplyOwner = null;
    liveBusy = false;
    registry.specs.delete(spec.plugin);
    registry.subs.forEach(fn => { try { fn(); } catch (_) {} });
});

cuimod.onSessionChange((cliSessionId) => {
    const desktopId = desktopSessionId();
    const nextCli = cliSessionId || null;
    if (desktopId !== observedDesktopId || nextCli !== observedCliSessionId)
        invalidateObserved(desktopId, nextCli);
    if (stateNode?.isConnected) refreshObserved();
});
// The panel is the opt-in observer. These timers do nothing while it is closed,
// so reloading the hot renderer cannot query or alter an existing session.
ctx.every(4000, () => {
    if (tableNode?.isConnected || stateNode?.isConnected) loadModels();
    if (stateNode?.isConnected) refreshObserved();
});
// A sent patch is applied on the worker's own settings-change path, so the
// readback lands a beat later. Poll faster for the bounded window after one.
// This tick also observes URL ownership before the bridge's asynchronous CLI-id
// resolution callback arrives, so foreign worker state clears immediately.
ctx.every(1000, () => {
    const changed = syncObservedIdentity();
    if (!changed && Date.now() > chaseUntil) return;
    if (stateNode?.isConnected) refreshObserved();
});
