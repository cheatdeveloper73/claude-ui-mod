/* Native item data owns selection and shortcuts; this only decorates the popup. */
'use strict';
let disposed = false;
let syncing = false;
let installed = false;
let dirty = true;
let providers = [{ id: 'claude', label: 'Claude' }];
let lastTab = null;
// wireId -> provider for the entries we add. A row this map does not name is a
// native one, which is the Claude tab -- the same rule page.js applies. Empty
// until the first sync lands, and an empty map means "classify nothing".
let owners = new Map();
const MENU = '[role="menu"][data-cds="ModelSelector"]';
const ROW = '[role="menuitemradio"][data-model-id]';
const ownerOf = (id) => owners.size && id != null ? owners.get(id) || 'claude' : null;
const decorated = new Map();
const DEFAULTS = {
    reasoningSummary: 'auto', showReasoningText: false, logUpstreamIdentity: true, animateTabs: true,
    promptPolicies: [], promptPolicyVersions: [], promptPolicySessionBindings: {},
    activePromptPolicyId: 'preserve', activePromptPolicyIds: {},
};
let preferences = { ...DEFAULTS };

async function sync() {
    if (syncing || disposed) return;
    syncing = true;
    try {
        const result = await cuimod.rpc('provider-picker.nativeSync');
        installed = !!result?.installed;
        if (Array.isArray(result?.providers) && result.providers.length) providers = result.providers;
        lastTab = result?.scopes?.find(scope => scope.tab)?.tab || lastTab;
        if (Array.isArray(result?.models)) owners = new Map(result.models.map(m => [m.id, m.provider]));
        dirty = true;
    }
    catch (err) { cuimod.log('native catalog: ' + err.message); }
    finally { syncing = false; }
}

// The row list is React state rebuilt from the query cache on every tab switch,
// and the container the rows live in can be replaced wholesale -- taking the
// strip with it. Re-anchor from the mutation callback so the strip is back
// before the frame paints. The previous shape let the 100ms poll notice the
// missing strip, tear the decoration down and build a new one, which is the
// blink the user sees when swapping tabs.
function anchors(menu) {
    const rows = [...menu.querySelectorAll('[role="menuitemradio"][data-model-id]')];
    if (!rows.length) return null;
    const group = rows[0].parentElement;
    return { rows, group,
        scroll: menu.querySelector('[data-cds-sheet-scroll]') || group.parentElement,
        heading: menu.querySelector('[role="group"] > [role="presentation"]') };
}

function decorate(menu) {
    if (decorated.has(menu) || !installed) return;
    const triggerId = menu.getAttribute('aria-labelledby');
    const trigger = document.getElementById(triggerId);
    // App 1.44121.4 renamed the root popup to data-cds="ModelSelector", dropped
    // its "Models" heading, and moved the overflow into a nested data-cds="Menu"
    // submenu -- which is what the old heading gate was written against. Match
    // the root by its own attribute plus model-carrying rows, and require the
    // absence of data-nested so the "More models" submenu and effort popups keep
    // their native layout instead of acquiring a second tab strip.
    const parts = anchors(menu);
    if (!trigger || !parts || menu.hasAttribute('data-nested')) return;
    const originalWidth = menu.style.minWidth, originalSelect = menu.style.userSelect;
    const originalOverflow = menu.style.overflow, originalHeight = menu.style.height;
    const originalScroll = parts.scroll.style.overflowY, originalHeading = parts.heading?.style.display;
    const strip = document.createElement('div');
    strip.dataset.cuimodTabs = 'native';
    strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Model provider');
    strip.style.cssText = 'display:flex;gap:3px;padding:5px 6px 7px;user-select:none';
    menu.style.minWidth = providers.length > 3 ? '320px' : '260px'; menu.style.userSelect = 'none';
    // The popup's first paint is the union of every provider's models: a list
    // several times taller than any one tab, which then collapses once the
    // filter lands a roundtrip later. That roundtrip cannot be made synchronous
    // -- the catalogue lives in the page world and this runs in the isolated one
    // -- so the rows that do not belong are hidden here instead, in the same
    // pre-paint callback that discovered the menu. The checked row names the
    // provider the session is on without asking anybody.
    const checked = parts.rows.find(row => row.getAttribute('aria-checked') === 'true');
    const opening = ownerOf(checked?.dataset.modelId)
        || (owners.size && providers.some(p => p.id === lastTab) ? lastTab : null);
    let active = opening || 'claude';
    let hidden = new Set(opening
        ? parts.rows.filter(row => ownerOf(row.dataset.modelId) !== opening).map(row => row.dataset.modelId)
        : []);
    let scroll = parts.scroll;
    let animation = null;
    let revision = 0;
    let alive = true;
    let flowing = false;
    const restoreFlow = () => {
        flowing = false;
        menu.style.overflow = originalOverflow; menu.style.height = originalHeight;
        scroll.style.overflowY = originalScroll;
    };
    function paint() {
        for (const button of strip.children) {
            const on = button.dataset.provider === active;
            button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
            button.style.background = on ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent';
            button.style.color = on ? 'hsl(var(--text-100))' : 'hsl(var(--text-400))';
        }
    }
    // The session's own model has to stay in the catalogue section on every tab,
    // because the selector reads the trigger label and the effort stops out of
    // it. Nothing says it has to stay *visible*: an Opus session browsing the
    // OpenAI tab was being shown Opus among the GPT models.
    function reconcile() {
        if (!menu.isConnected) return false;
        const now = anchors(menu);
        if (!now) return true;
        scroll = now.scroll;
        if (flowing) scroll.style.overflowY = 'hidden';
        if (now.heading) now.heading.style.display = 'none';
        if (strip.parentElement !== now.group) now.group.prepend(strip);
        for (const row of now.rows) {
            if (hidden.has(row.dataset.modelId)) row.style.display = 'none';
            else if (row.style.display === 'none') row.style.display = '';
        }
        return true;
    }
    async function select(provider, animate) {
        const rev = ++revision;
        const from = menu.getBoundingClientRect().height;
        animation?.cancel();
        const motion = animate && preferences.animateTabs && !matchMedia('(prefers-reduced-motion: reduce)').matches;
        flowing = true;
        menu.style.overflow = 'hidden'; scroll.style.overflowY = 'hidden';
        if (motion) menu.style.height = from + 'px';
        if (provider) { active = provider; paint(); }
        try {
            const result = await cuimod.rpc('provider-picker.tab', { provider, triggerId, open: true });
            if (!alive || rev !== revision) return;
            if (!result) throw new Error('native model menu scope not found');
            active = result.tab; hidden = new Set(result.hidden || []); paint(); reconcile();
            if (!motion) return;
            // The new rows are not in the DOM when the RPC resolves -- React has
            // only just been handed the new list. Measuring here measures the
            // OLD height, which is what made the old animation run to the wrong
            // target and leave the real resize to land as a jump afterwards.
            await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
            if (!alive || rev !== revision) return;
            reconcile();
            menu.style.height = originalHeight;
            const to = menu.getBoundingClientRect().height;
            if (Math.abs(to - from) < 1) return;
            // End on the measured height, not on `from`: an animation that fills
            // nothing snaps back to the inline value for a frame when it ends.
            menu.style.height = to + 'px';
            animation = menu.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 170, easing: 'cubic-bezier(.22,.8,.28,1)' });
            await animation.finished.catch(() => {});
        } catch (err) { cuimod.log('provider tab: ' + err.message); }
        finally { if (alive && rev === revision) restoreFlow(); }
    }
    for (const provider of providers) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.provider = provider.id; button.textContent = provider.label; button.setAttribute('role', 'tab');
        button.style.cssText = 'flex:1;min-width:0;border:0;border-radius:7px;padding:5px 8px;font:inherit;font-size:12px;cursor:pointer;user-select:none;transition:background 130ms,color 130ms';
        button.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
        button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); select(provider.id, true); });
        button.addEventListener('keydown', e => {
            if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
            e.preventDefault(); e.stopPropagation();
            const tabs = [...strip.children], index = tabs.indexOf(button);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].focus(); select(tabs[next].dataset.provider, true);
        });
        strip.appendChild(button);
    }
    reconcile(); paint();
    decorated.set(menu, { strip, reconcile, clean() {
        alive = false; revision++; animation?.cancel();
        hidden = new Set(); reconcile();
        strip.remove(); restoreFlow();
        menu.style.minWidth = originalWidth; menu.style.userSelect = originalSelect;
        const heading = menu.querySelector('[role="group"] > [role="presentation"]');
        if (heading) heading.style.display = originalHeading;
        if (!menu.isConnected) cuimod.rpc('provider-picker.tab', { provider: null, triggerId, open: false }).catch(() => {});
    } });
    select(null, false);
}

function reanchor() {
    for (const [menu, view] of decorated) if (!view.reconcile()) { view.clean(); decorated.delete(menu); }
}

function scan() {
    dirty = false;
    for (const menu of document.querySelectorAll(MENU)) decorate(menu);
}

// Decorating from the 100ms poll meant up to a tenth of a second of undecorated
// native popup on every open. Scoped to the nodes a batch actually added, the
// same check runs in the mutation callback and the menu is never painted
// undecorated at all.
// Rows as well as the menu itself: the popup shell and its list are not
// guaranteed to arrive in one commit, and a menu discovered before it has rows
// is a menu decorate() declines and the poll picks up a tenth of a second late.
function mounted(records) {
    for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(MENU) || node.matches?.(ROW)) return true;
        if (node.querySelector?.(MENU) || node.querySelector?.(ROW)) return true;
    }
    return false;
}

ctx.track(document, 'keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
    if (e.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    if ([...decorated.keys()].some(menu => menu.isConnected)) { e.preventDefault(); e.stopPropagation(); }
}, true);
// Mutation callbacks run before paint, so a strip React just detached is back
// in the same frame. The poll below only discovers new menus and reaps dead ones.
ctx.observe(document.body, { childList: true, subtree: true }, records => {
    reanchor();
    dirty = true;
    if (mounted(records)) scan();
});
// The poll is the safety net: a menu that opened before the first sync reported
// `installed`, and any menu a mutation batch did not name.
ctx.every(100, () => { reanchor(); if (dirty) scan(); });
ctx.every(1000, sync);
sync().then(() => { dirty = true; });
ctx.onDispose(() => { disposed = true; for (const view of decorated.values()) view.clean(); decorated.clear(); });

const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'provider-picker', title: 'Providers & agents',
    description: 'Provider transport and reasoning for main sessions and custom subagents. Request settings apply to the next model call; current turns and saved transcripts stay unchanged.',
    defaults: DEFAULTS, immediateSave: true,
    controls: [
        { key: 'reasoningSummary', type: 'combo', label: 'GPT reasoning summary', group: 'OpenAI reasoning',
          hint: 'Auto already requests the most detailed summary the model supports. This does not change reasoning effort.',
          options: [{ value: 'auto', label: 'Auto · most detailed available' }, { value: 'detailed', label: 'Detailed · explicit request' }, { value: 'off', label: 'Do not request summaries' }] },
        { key: 'showReasoningText', type: 'toggle', label: 'Additional provider reasoning text', group: 'OpenAI reasoning',
          hint: 'Show reasoning_text if OpenAI supplies it, separately labeled when the reasoning item completes. This cannot unlock hidden reasoning and may add no text.' },
        { key: 'rawReasoning', type: 'info', label: 'Raw internal reasoning', group: 'OpenAI reasoning',
          text: 'Not exposed by the documented GPT API.', hint: 'Encrypted reasoning is opaque state for replay, not readable text. Existing GPT thinking blocks are provider summaries.' },
        { key: 'animateTabs', type: 'toggle', label: 'Animate provider tabs', group: 'Model picker',
          hint: 'Controls the menu resize animation. Native model selection, shortcuts, and effort stops are unchanged.' },
        { key: 'logUpstreamIdentity', type: 'toggle', label: 'Log OpenAI response identity', group: 'Diagnostics',
          hint: 'Record requested and response-reported model/effort in bridge.log. No prompt text or credentials; this never controls model selection.' },
        { key: 'metaTransport', type: 'info', label: 'Meta transport', group: 'Meta',
          text: 'Direct Anthropic Messages against api.meta.ai. Standard and Contributor are separate model variants; thinking is always on and its budget is not adjustable from this endpoint.',
          hint: 'The API key is read from the ignored .state/provider-secrets.json file for every request. Catalogue and credential changes do not require a router restart.' },
        { key: 'agentScope', type: 'info', label: 'Custom subagent scope', group: 'Subagents',
          text: 'The same GPT reasoning settings apply to GPT subagents.', hint: 'Agent models and effort stay in their native definitions. Rail layout and transcript visibility remain in the Subagents dashboard panel.' },
    ],
    apply(values) { preferences = { ...DEFAULTS, ...values }; },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => { REG.specs.delete(spec.plugin); REG.subs.forEach(fn => { try { fn(); } catch (_) {} }); });
if (!REG.subs.size) spec.apply(DEFAULTS);
