/* Runs in the page world. Extend the catalog consumed by the native controls;
 * model choice, draft ownership, effort, and submission remain the app's. */
'use strict';
const slot = '__cuimod_provider_native';
const previous = window[slot];
if (previous && previous.version === version) return previous.snapshot();
if (previous) previous.dispose(false);

// App 1.44121.4 moved the Desktop Code surface onto the "ccd" catalogue
// section; "code" is still served but nothing in this window renders it.
const SURFACES = new Set(['ccd', 'code']);
const ids = new Set(models.map(m => m.wireId));
const byId = new Map(models.map(m => [m.wireId, m]));
const normalizeModelId = (id) => {
    const text = String(id ?? '');
    const cleaned = text.replace(/(\[1m\]|:\w+)$/i, '');
    const deduped = cleaned.replace(/^claude-(?=claude-)/i, '');
    return /^claude-/i.test(deduped) ? deduped : `claude-${deduped}`;
};
const resolveModel = (id) => {
    const normalized = normalizeModelId(id);
    return byId.get(normalized) || byId.get(id);
};
const providerOf = (id) => resolveModel(id)?.provider || 'claude';
const ours = id => byId.has(id);
const providerIds = new Set(providers.map(provider => provider.id));
const entries = models.map(m => ({
    id: m.wireId, name: m.name, short_name: m.name, section: 'main',
    ...(Number.isFinite(m.context) ? { context_window: m.context, supports_1m_context: m.context >= 1000000 } : {}),
    ...(m.contextNote ? { tooltip: { content: m.contextNote } } : {}),
    ...(m.efforts.length ? { thinking: {
        type: 'effort',
        description: 'Higher effort gives the model more time to reason.',
        effort_options: m.efforts.map(e => ({
            id: e, name: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }[e],
            recommended: e === m.defaultEffort,
        })),
    } } : {}),
}));
const queryClients = new Map();
const scopes = new Map();
// The 1.44121.4 model selector renders from the catalogue section it is handed,
// not from footer.modelItems, so the provider tab has to filter the catalogue
// itself. Server payloads are the only moment the untouched native list is
// visible, so cache it per section and rebuild every write from that cache
// rather than from whatever we wrote last.
const natives = new Map();
// null means nobody is browsing: publish the whole union, which is what every
// other consumer of the catalogue expects to find. A provider id is only set
// while the popup is open, and the popup restores null when it closes.
let tab = null;
let disposed = false;

function visit() {
    const found = [];
    for (const el of document.querySelectorAll('.epitaxy-prompt')) {
        let fiber = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))];
        let scope = null;
        for (let depth = 0; fiber && depth < 170; depth++, fiber = fiber.return) {
            const props = fiber.memoizedProps;
            if (!scope && props?.scopeStore?.getState) scope = props.scopeStore;
            const contextSeen = new Set();
            for (let dep = fiber.dependencies?.firstContext; dep && !contextSeen.has(dep); dep = dep.next) {
                contextSeen.add(dep);
                const client = dep.memoizedValue;
                if (typeof client?.getQueryCache === 'function' && !queryClients.has(client)) {
                    queryClients.set(client, client.getQueryCache().subscribe(event => {
                        if (!disposed && event.query) extend(client, event.query);
                    }));
                }
            }
        }
        if (scope) found.push(scope);
    }
    return found;
}

function selected() {
    for (const state of scopes.values()) if (state.model) return state.model;
    return null;
}

function projectSection(section) {
    const base = natives.get(section.id) || section.models.filter(m => !ours(m.id));
    // Catalogue entries keep their own provider, and one of them deliberately
    // shadows a native id, so the Claude tab is the native list plus our
    // claude-provider entries -- not the native list alone.
    const mine = tab === null ? entries.slice() : entries.filter(e => byId.get(e.id).provider === tab);
    const list = tab === null || tab === 'claude' ? base.concat(mine) : mine;
    // The selector resolves its trigger label and effort stops out of this list,
    // so whatever the session is actually on has to stay in it, tab or no tab.
    const current = selected();
    if (current && !list.some(m => m.id === current)) {
        const model = base.find(m => m.id === current) || entries.find(e => e.id === current);
        if (model) list.push(model);
    }
    return list;
}

function extend(client, query) {
    const data = query.state.data;
    const configs = data?.model_selector_config;
    if (!Array.isArray(configs)) return;
    const targets = configs.filter(s => SURFACES.has(s.id) && Array.isArray(s.models));
    if (!targets.length) return;
    for (const s of targets) if (s.__cuimodProviderVersion !== version) natives.set(s.id, s.models.filter(m => !ours(m.id)));
    const next = new Map(targets.map(s => [s, projectSection(s)]));
    // React Query preserves structurally equal objects; identity comparisons
    // would keep rewriting the cache from its own update notification.
    if (targets.every(s => s.__cuimodProviderVersion === version && s.__cuimodProviderTab === tab
        && s.models.length === next.get(s).length && s.models.every((m, i) => m.id === next.get(s)[i].id))) return;
    client.setQueryData(query.queryKey, {
        ...data,
        model_selector_config: configs.map(s => !targets.includes(s) ? s : {
            ...s, __cuimodProviderVersion: version, __cuimodProviderTab: tab, models: next.get(s),
        }),
    });
}

function repaint() {
    for (const [client] of queryClients) for (const query of client.getQueryCache().getAll()) extend(client, query);
}

// Read the footer, never rewrite it. Its model items and effort sections are the
// pre-1.44121.4 data path that the live selector ignores, and a footer write
// re-renders the composer, which closes the popup the tabs live in.
function projectFooter(scope) {
    const state = scopes.get(scope);
    const footer = scope.getState().footer;
    if (!footer || !state) return;
    const resolved = resolveModel(footer.modelId);
    const resolvedModelId = resolved ? resolved.wireId : footer.modelId;
    state.original = footer;
    if (state.model === resolvedModelId) return;
    state.model = resolvedModelId;
    state.tab = providerOf(resolvedModelId);
    repaint();
    if (resolved && resolvedModelId !== footer.modelId) queueMicrotask(() => {
        if (!disposed && scope.getState().footer?.modelId === footer.modelId) scope.setState({ footer: { ...footer, modelId: resolvedModelId } });
    });
}

// projectSection has to keep the session's own model in the list on every tab,
// because the selector resolves the trigger label and the effort stops out of
// the list it is handed. That entry is data the native controls need, not a row
// the user asked to see -- an Opus session browsing the OpenAI tab was being
// shown Opus among the GPT models. Name it here so the strip can hide the row
// while the list keeps it.
function foreignIds() {
    const current = selected();
    if (tab === null || !current) return [];
    const model = byId.get(current);
    const provider = model ? model.provider : 'claude';
    return provider === tab ? [] : [current];
}

function selectTab(provider, triggerId, browsing) {
    const trigger = document.getElementById(triggerId);
    let fiber = trigger?.[Object.keys(trigger).find(k => k.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 170; depth++, fiber = fiber.return) {
        const scope = fiber.memoizedProps?.scopeStore;
        const state = scopes.get(scope);
        if (!state) continue;
        state.tab = providerIds.has(provider) ? provider : providerOf(state.model);
        tab = browsing === false ? null : state.tab;
        repaint();
        return { tab: state.tab, hidden: foreignIds() };
    }
    return null;
}

function snapshot() {
    const found = visit();
    for (const scope of found) {
        if (!scopes.has(scope)) {
            const state = { original: null, model: null, tab: 'claude' };
            scopes.set(scope, state);
            state.unsub = scope.subscribe(() => { if (!disposed) projectFooter(scope); });
        }
        projectFooter(scope);
    }
    for (const [scope, state] of scopes) if (!found.includes(scope)) { state.unsub(); scopes.delete(scope); }
    repaint();
    // The selector's untouched native catalogue is otherwise private to this
    // page-world adapter. Return only row identity and display metadata so
    // another dashboard panel can offer the exact same set without learning a
    // provider route or mutating the selector.
    const nativeModels = [];
    const nativeIds = new Set();
    for (const values of natives.values()) for (const model of values) {
        const id = String(model?.id || '');
        if (!id || nativeIds.has(id)) continue;
        nativeIds.add(id);
        nativeModels.push({ id, name: String(model?.name || model?.display_name || id) });
    }
    return {
        installed: queryClients.size > 0,
        hidden: foreignIds(),
        nativeModels,
        scopes: found.map(scope => {
            const s = scope.getState();
            const f = s.footer;
            return { session: s.sessionRef ? { id: s.sessionRef.id, type: s.sessionRef.type } : null,
                phase: s.phase, model: f?.modelId, label: typeof f?.modelLabel === 'string' ? f.modelLabel : null, provider: providerOf(f?.modelId), tab: scopes.get(scope)?.tab,
                efforts: f?.modelExtraSections?.find(x => x.key === 'effort')?.items.map(i => ({ value: i.value, label: typeof i.label === 'string' ? i.label : null, checked: i.checked })) };
        }),
    };
}

function dispose(restoreCatalog = true) {
    disposed = true;
    for (const unsub of queryClients.values()) unsub();
    for (const [scope, state] of scopes) state.unsub();
    if (restoreCatalog) for (const [client] of queryClients) for (const q of client.getQueryCache().getAll()) {
        const data = q.state.data;
        if (!Array.isArray(data?.model_selector_config)) continue;
        client.setQueryData(q.queryKey, { ...data, model_selector_config: data.model_selector_config.map(s => {
            if (!SURFACES.has(s.id) || !Array.isArray(s.models)) return s;
            const { __cuimodProviderVersion, __cuimodProviderTab, ...rest } = s;
            return { ...rest, models: natives.get(s.id) || s.models.filter(m => !ours(m.id)) };
        }) });
    }
    queryClients.clear(); scopes.clear(); natives.clear(); tab = null;
    if (window[slot]?.version === version) delete window[slot];
}
window[slot] = { version, snapshot, selectTab, dispose };
return snapshot();
