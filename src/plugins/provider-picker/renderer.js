/* Native item data owns selection and shortcuts; this only decorates the popup. */
'use strict';
let disposed = false;
let syncing = false;
let installed = false;
let dirty = true;
let providers = [{ id: 'claude', label: 'Claude' }];
let lastTab = null;
// wireId -> provider for the entries we add. A row this map does not name is a
// native one, which is the Claude tab -- the same rule page.js applies. The
// current generic Menu popup no longer exposes data-model-id, so the sync also
// carries display names and we recover the native value from the row label.
let owners = new Map();
let knownModelIds = new Set();
let modelLabels = [];
const MENU = '[role="menu"][data-cds="ModelSelector"],[role="menu"][data-cds="Menu"]';
const ROW = '[role="menuitemradio"]';
// Provider tabs wrap at this many per row, and both rows are stretched to the
// same width even when the last one holds fewer tabs. Seven providers land 4/3.
const TAB_COLUMNS = 4;
const TAB_GAP = 4;
const normalizeModelLabel = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
function refreshModelLabels(custom, nativeModels) {
    const labels = [];
    const seen = new Set();
    knownModelIds = new Set();
    for (const model of [...custom, ...nativeModels]) {
        const id = typeof model?.id === 'string' ? model.id : '';
        if (!id || seen.has(id)) continue;
        seen.add(id); knownModelIds.add(id);
        const label = normalizeModelLabel(model.name);
        if (label) labels.push({ id, label });
    }
    modelLabels = labels.sort((a, b) => b.label.length - a.label.length);
}
function modelIdFromText(value) {
    const text = normalizeModelLabel(value);
    if (!text) return null;
    return modelLabels.find(model => text === model.label || text.includes(model.label))?.id || null;
}
function rowModelId(row) {
    const direct = row?.dataset?.modelId || row?.getAttribute?.('data-value');
    if (direct && knownModelIds.has(direct)) return direct;
    const cached = row?.dataset?.cuimodModelId;
    if (cached && knownModelIds.has(cached)) return cached;
    const id = modelIdFromText(row?.getAttribute?.('aria-label')) || modelIdFromText(row?.textContent);
    if (id && row?.dataset) row.dataset.cuimodModelId = id;
    return id;
}
const ownerOf = (id) => owners.size && id != null ? owners.get(id) || 'claude' : null;
const decorated = new Map();
const DEFAULTS = {
    reasoningEnabled: true, reasoningSummary: 'auto', showReasoningText: false, logUpstreamIdentity: true, animateTabs: true,
    promptPolicies: [], promptPolicyVersions: [], promptPolicySessionBindings: {},
    activePromptPolicyId: 'preserve', activePromptPolicyIds: {},
    autoSwitchAccounts: true, autoSwitchWeeklyThreshold: 98,
};
let preferences = { ...DEFAULTS };
let accountState = { active: null, accounts: [], authError: null, login: { phase: 'idle', message: null } };
let accountPanel = null;
let accountBusy = false;
let accountRemoving = null;
let accountUsageBusy = false;
let accountUsageQueued = false;
let accountResetConfirm = null;
let accountResetBusy = null;
let poolPinState = { supported: null, accounts: [], mode: 'auto', targetAccountId: null, appliedAccountId: null, applied: false, error: null };
let poolPinBusy = false;
let poolPinFlight = null;
const poolPinViews = new Set();

const poolAccountName = account => account?.name || (Number.isSafeInteger(account?.id) ? `Account ${account.id}` : 'Account');

function mergePoolPin(value) {
    if (!value || typeof value !== 'object') return;
    poolPinState = {
        ...poolPinState,
        ...value,
        accounts: Array.isArray(value.accounts) ? value.accounts : poolPinState.accounts,
    };
    for (const paint of poolPinViews) paint();
}

async function refreshPoolPin() {
    if (poolPinFlight) return poolPinFlight;
    poolPinFlight = cuimod.rpc('provider-picker.poolPinStatus').then(value => {
        mergePoolPin(value);
        return value;
    }).catch(error => {
        mergePoolPin({ supported: true, error: error?.message || 'Account pool status unavailable' });
        return null;
    }).finally(() => { poolPinFlight = null; });
    return poolPinFlight;
}

async function setPoolPin(action, id = null) {
    if (poolPinBusy) return;
    poolPinBusy = true;
    for (const paint of poolPinViews) paint();
    try {
        mergePoolPin(await cuimod.rpc('provider-picker.poolPinSet', action === 'pin' ? { action, id } : { action }));
    } catch (error) {
        mergePoolPin({ supported: true, error: error?.message || 'Account pool change failed' });
    } finally {
        poolPinBusy = false;
        for (const paint of poolPinViews) paint();
    }
}

const accountName = account => account?.email || account?.name || 'OpenAI account';
const accountTier = account => account?.plan ? account.plan.toUpperCase() : 'ChatGPT';
const usageById = () => new Map((accountState.accounts || []).map(account => [account.id, account.usage]));

function mergeAccountState(value) {
    if (!value || !Array.isArray(value.accounts)) return;
    const usage = usageById();
    accountState = { ...value, accounts: value.accounts.map(account => ({
        ...account,
        ...(account.usage ? {} : usage.has(account.id) ? { usage: usage.get(account.id) } : {}),
    })) };
    if (accountResetConfirm && !accountState.accounts.some(account => account.id === accountResetConfirm.id))
        accountResetConfirm = null;
}

function mergeAccountUsage(value) {
    if (!value || !Array.isArray(value.accounts)) return;
    const usage = new Map(value.accounts.map(account => [account.id, account.usage]));
    const base = accountState.accounts?.length ? accountState.accounts : value.accounts;
    accountState = { ...accountState, accounts: base.map(account => ({
        ...account,
        ...(usage.has(account.id) ? { usage: usage.get(account.id) } : {}),
    })) };
    if (accountResetConfirm) {
        const current = accountState.accounts.find(account => account.id === accountResetConfirm.id);
        if (!current || current.usage?.observedAt !== accountResetConfirm.observedAt
            || current.usage?.resetCredits !== accountResetConfirm.credits) accountResetConfirm = null;
    }
}

function markAccountUsageError(id, message) {
    accountResetConfirm = null;
    accountState = { ...accountState, accounts: (accountState.accounts || []).map(account => account.id === id
        ? { ...account, usage: { error: message } } : account) };
}

function resetDate(value) {
    if (!Number.isFinite(value)) return 'reset unavailable';
    return 'resets ' + new Date(value * 1000).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

async function refreshAccountUsage(force = false) {
    if (!accountPanel || accountResetBusy !== null) return;
    if (accountUsageBusy) { accountUsageQueued = true; return; }
    accountUsageBusy = true;
    try {
        mergeAccountUsage(await cuimod.rpc('provider-picker.accountUsage', { force }));
    } catch (_) { /* Keep the last per-account observation. */ }
    finally {
        accountUsageBusy = false;
        paintAccountPanel();
        if (accountUsageQueued) {
            accountUsageQueued = false;
            queueMicrotask(() => refreshAccountUsage());
        }
    }
}

function accountButton(text, disabled, danger) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.disabled = disabled;
    button.style.cssText = 'flex:0 0 auto;border-radius:7px;padding:5px 9px;font:inherit;font-size:10.5px;cursor:pointer;background:color-mix(in srgb,hsl(var(--text-100)) 7%,transparent);border:1px solid color-mix(in srgb,hsl(var(--text-100)) 11%,transparent);color:hsl(var(--text-200));outline:none';
    if (danger) {
        button.style.color = 'hsl(var(--danger-100))';
        button.style.borderColor = 'color-mix(in srgb,hsl(var(--danger-100)) 35%,transparent)';
    }
    return button;
}

function accountAction(text, disabled, run, danger = false) {
    const button = accountButton(text, disabled, danger);
    button.addEventListener('click', async () => {
        if (button.disabled || accountBusy) return;
        accountBusy = true; paintAccountPanel();
        try {
            const next = await run();
            mergeAccountState(next);
            if (next?.login?.phase !== 'waiting') queueMicrotask(() => refreshAccountUsage());
        } catch (err) {
            accountState = { ...accountState, login: { phase: 'error', message: err?.message || 'OpenAI account action failed' } };
        } finally { accountBusy = false; paintAccountPanel(); }
    });
    return button;
}

function accountResetButton(account, disabled, armed) {
    const credits = account.usage?.resetCredits;
    const label = Number.isFinite(credits) ? `${credits.toLocaleString()} reset${credits === 1 ? '' : 's'}` : '—';
    const button = accountButton(accountResetBusy === account.id ? 'Applying' : label, disabled, armed);
    button.style.cssText += ';position:relative;padding:0 0 0 18px;border:0;background:transparent;font-size:9px;font-weight:600;line-height:14px;letter-spacing:.06em;text-transform:uppercase;font-variant-numeric:tabular-nums;color:'
        + (armed ? 'hsl(var(--danger-100))' : Number.isFinite(credits) && credits > 0 ? 'hsl(var(--cui-accent,14 62% 60%))' : 'hsl(var(--text-500))');
    const icon = document.createElement('span');
    icon.style.cssText = 'position:absolute;left:0;top:50%;transform:translateY(-50%);width:14px;height:14px;pointer-events:none';
    icon.innerHTML = '<svg width="14" height="14" viewBox="2 2 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.64 6.36M3 4v7h7"/></svg>';
    button.append(icon);
    button.title = Number.isFinite(credits) ? 'Double-click to spend one reset credit for ' + accountName(account) : 'Reset-credit count unavailable';
    button.setAttribute('aria-label', Number.isFinite(credits) ? `${credits} reset credits for ${accountName(account)}; double-click to confirm` : 'Reset-credit count unavailable');
    button.addEventListener('click', event => {
        if (event.detail !== 1 || button.disabled || accountBusy || accountUsageBusy || accountResetBusy !== null) return;
        const current = accountState.accounts.find(value => value.id === account.id);
        if (!Number.isFinite(current?.usage?.resetCredits) || current.usage.resetCredits < 1) return;
        accountResetConfirm = { id: account.id, observedAt: current.usage.observedAt, credits: current.usage.resetCredits };
        // Keep this node alive for the native double-click event. Replacing it
        // after the first click breaks the browser's click-count sequence.
        button.textContent = 'Confirm';
        button.append(icon);
        button.style.color = 'hsl(var(--danger-100))';
    });
    button.addEventListener('dblclick', async () => {
        if (button.disabled || disposed || accountBusy || accountUsageBusy || accountResetBusy !== null) return;
        const current = accountState.accounts.find(value => value.id === account.id);
        if (!current || accountResetConfirm?.id !== account.id
            || current.usage?.observedAt !== accountResetConfirm.observedAt
            || current.usage?.resetCredits !== accountResetConfirm.credits) {
            accountResetConfirm = null;
            paintAccountPanel();
            return;
        }
        accountResetConfirm = null;
        accountResetBusy = account.id;
        paintAccountPanel();
        try {
            const result = await cuimod.rpc('provider-picker.accountResetCredit', { id: account.id });
            mergeAccountUsage({ accounts: [{ id: account.id, usage: result?.usage }] });
        } catch (error) {
            markAccountUsageError(account.id, error?.message || 'Reset-credit usage unavailable');
        } finally {
            accountResetBusy = null;
            paintAccountPanel();
        }
    });
    return button;
}

function paintAccountPanel() {
    if (!accountPanel) return;
    accountPanel.textContent = '';
    const accounts = Array.isArray(accountState.accounts) ? accountState.accounts : [];
    const login = accountState.login || { phase: 'idle' };
    for (const account of accounts) {
        const row = document.createElement('div');
        row.style.cssText = 'position:relative;display:flex;align-items:center;gap:10px;min-height:42px;padding:7px 9px 7px 20px;border-radius:9px;background:color-mix(in srgb,hsl(var(--text-100)) 4%,transparent)';
        const copy = document.createElement('div');
        copy.style.cssText = 'flex:1 1 auto;min-width:0';
        const name = document.createElement('div');
        name.textContent = accountName(account);
        name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:hsl(var(--text-200))';
        const tier = document.createElement('div');
        tier.textContent = accountTier(account);
        tier.style.cssText = 'margin-top:2px;font-size:9.5px;letter-spacing:.05em;color:hsl(var(--text-500))';
        copy.append(name, tier);
        const weekly = account.usage?.weekly;
        const usage = document.createElement('div');
        usage.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:5px;font-size:9.5px;color:hsl(var(--text-500));font-variant-numeric:tabular-nums';
        if (Number.isFinite(weekly?.usedPercent)) {
            const percent = Math.max(0, Math.min(100, weekly.usedPercent));
            const label = document.createElement('span');
            label.textContent = `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% weekly`;
            label.style.cssText = 'flex:0 0 auto';
            const track = document.createElement('span');
            track.setAttribute('role', 'progressbar');
            track.setAttribute('aria-label', 'Main models weekly usage');
            track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
            track.setAttribute('aria-valuenow', String(percent));
            track.style.cssText = 'display:block;flex:1 1 auto;min-width:28px;height:3px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,hsl(var(--text-100)) 11%,transparent)';
            const fill = document.createElement('i');
            fill.style.cssText = `display:block;width:${percent}%;height:100%;border-radius:2px;background:hsl(var(--cui-accent,14 62% 60%))`;
            track.append(fill);
            const reset = document.createElement('span');
            reset.textContent = resetDate(weekly.resetAt);
            reset.style.cssText = 'flex:0 0 auto';
            usage.append(label, track, reset);
        } else {
            usage.textContent = account.usage?.error || (accountUsageBusy ? 'Reading weekly usage…' : 'Weekly usage unavailable');
        }
        const resetCredits = account.usage?.resetCredits;
        const locked = accountBusy || accountResetBusy !== null || accountUsageBusy || login.phase === 'waiting';
        const armed = accountRemoving === account.id;
        const creditLine = accountResetButton(account,
            locked || armed || !Number.isFinite(resetCredits) || resetCredits < 1, accountResetConfirm?.id === account.id);
        copy.append(usage);
        const actions = document.createElement('div');
        actions.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:54px';
        actions.append(creditLine);
        // The x only arms removal; the destructive click is the red button that
        // replaces Switch, so a stray double-click on the x cannot delete.
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.disabled = locked;
        remove.title = armed ? 'Keep account' : 'Remove account';
        remove.setAttribute('aria-label', `${armed ? 'Keep' : 'Remove'} ${accountName(account)}`);
        remove.style.cssText = 'position:absolute;top:2px;left:2px;display:grid;place-items:center;width:14px;height:14px;padding:0;border:0;border-radius:4px;background:transparent;font:inherit;font-size:12px;line-height:1;cursor:pointer;outline:none;transition:opacity 120ms,color 120ms;'
            + (armed ? 'opacity:1;color:hsl(var(--danger-100))' : 'opacity:.45;color:hsl(var(--text-500))');
        if (!armed) {
            remove.addEventListener('mouseenter', () => { remove.style.opacity = '1'; remove.style.color = 'hsl(var(--danger-100))'; });
            remove.addEventListener('mouseleave', () => { remove.style.opacity = '.45'; remove.style.color = 'hsl(var(--text-500))'; });
        }
        remove.addEventListener('click', () => {
            if (remove.disabled) return;
            accountRemoving = armed ? null : account.id;
            paintAccountPanel();
        });
        row.append(remove, copy);
        if (armed) {
            actions.append(accountAction('Remove', locked, async () => {
                try { return await cuimod.rpc('provider-picker.accountRemove', { id: account.id }); }
                finally { accountRemoving = null; }
            }, true));
        } else {
            actions.append(accountAction(account.active ? 'Active' : 'Switch', locked || account.active,
                () => cuimod.rpc('provider-picker.accountSwitch', { id: account.id })));
        }
        row.append(actions);
        accountPanel.append(row);
    }
    if (!accounts.length) {
        const empty = document.createElement('div');
        empty.textContent = accountState.authError || 'No OpenAI account is signed in.';
        empty.style.cssText = 'padding:7px 2px;font-size:11px;color:hsl(var(--text-500))';
        accountPanel.append(empty);
    }
    accountPanel.append(accountAction(login.phase === 'waiting' ? 'Finish sign-in in your browser…' : 'Sign in to another OpenAI account',
        accountBusy || accountResetBusy !== null || login.phase === 'waiting', () => cuimod.rpc('provider-picker.accountLogin')));
    if (login.phase === 'error' && login.message) {
        const error = document.createElement('div');
        error.textContent = login.message;
        error.style.cssText = 'font-size:10px;line-height:1.35;color:hsl(var(--danger-100))';
        accountPanel.append(error);
    }
    const note = document.createElement('div');
    note.textContent = 'Account changes, including automatic switching, apply to the next GPT request. Current turns are unchanged.';
    note.style.cssText = 'font-size:10px;line-height:1.4;color:hsl(var(--text-500))';
    accountPanel.append(note);
}

function accountControl() {
    if (!accountPanel) {
        accountPanel = document.createElement('div');
        accountPanel.style.cssText = 'display:flex;flex-direction:column;gap:7px';
        cuimod.rpc('provider-picker.accountStatus').then(value => {
            mergeAccountState(value);
            paintAccountPanel();
            refreshAccountUsage();
        }).catch(() => {});
    }
    paintAccountPanel();
    return accountPanel;
}

async function sync() {
    if (syncing || disposed) return;
    syncing = true;
    try {
        const result = await cuimod.rpc('provider-picker.nativeSync');
        installed = !!result?.installed;
        if (Array.isArray(result?.providers) && result.providers.length) providers = result.providers;
        lastTab = result?.scopes?.find(scope => scope.tab)?.tab || lastTab;
        if (Array.isArray(result?.models)) {
            owners = new Map(result.models.map(m => [m.id, m.provider]));
            refreshModelLabels(result.models, Array.isArray(result.nativeModels) ? result.nativeModels : []);
        }
        if (result?.accounts && Array.isArray(result.accounts.accounts)) {
            const before = (accountState.accounts || []).map(account => account.id).join(',');
            mergeAccountState(result.accounts);
            paintAccountPanel();
            if (accountPanel && before !== result.accounts.map(account => account.id).join(',')) refreshAccountUsage();
        }
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
    const rows = [...menu.querySelectorAll(ROW)].filter(row => rowModelId(row));
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
    // The 2026-09-19 frontend moved the root back onto the generic CDS Menu
    // primitive and stopped emitting data-model-id on its radio rows. Accept
    // both generations, but require the trigger itself to be the composer model
    // control so nested "More models" and unrelated radio menus stay native.
    const parts = anchors(menu);
    if (!trigger || !trigger.closest?.('.epitaxy-prompt') || !modelIdFromText(trigger.textContent)
        || !parts || menu.hasAttribute('data-nested')) return;
    const originalWidth = menu.style.minWidth, originalSelect = menu.style.userSelect;
    const originalOverflow = menu.style.overflow, originalHeight = menu.style.height;
    const originalScroll = parts.scroll.style.overflowY, originalHeading = parts.heading?.style.display;
    const strip = document.createElement('div');
    strip.dataset.cuimodTabs = 'native';
    strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Model provider');
    // Explicit rows of inline tabs. A single grid with a fixed column count left
    // the short row physically narrower than the long one -- 4/3 measured 423px
    // against 316px -- which reads as a ragged edge. Each row here stretches to
    // the strip's width and its tabs grow to fill it, so a four-tab row and a
    // three-tab row end on the same edge instead of the second stopping short.
    strip.style.cssText = `display:flex;flex-direction:column;row-gap:${TAB_GAP}px;padding:5px 6px 7px;max-width:calc(100vw - 24px);overflow-x:auto;scrollbar-width:none;user-select:none`;
    const poolStrip = document.createElement('div');
    poolStrip.dataset.cuimodPoolPin = 'native';
    poolStrip.setAttribute('role', 'group'); poolStrip.setAttribute('aria-label', 'Gemini account pool');
    poolStrip.style.cssText = 'display:none;flex-direction:column;gap:5px;padding:0 6px 7px;user-select:none';
    menu.style.userSelect = 'none';
    // The popup's first paint is the union of every provider's models: a list
    // several times taller than any one tab, which then collapses once the
    // filter lands a roundtrip later. That roundtrip cannot be made synchronous
    // -- the catalogue lives in the page world and this runs in the isolated one
    // -- so the rows that do not belong are hidden here instead, in the same
    // pre-paint callback that discovered the menu. The checked row names the
    // provider the session is on without asking anybody.
    const checked = parts.rows.find(row => row.getAttribute('aria-checked') === 'true');
    const opening = ownerOf(checked ? rowModelId(checked) : null)
        || (owners.size && providers.some(p => p.id === lastTab) ? lastTab : null);
    let active = opening || 'claude';
    let hidden = new Set(opening
        ? parts.rows.map(row => rowModelId(row)).filter(id => id && ownerOf(id) !== opening)
        : []);
    let scroll = parts.scroll;
    let animation = null;
    let revision = 0;
    let alive = true;
    let flowing = false;
    const paintPoolPin = () => {
        if (!alive) return;
        const show = active === 'gemini' && poolPinState.supported !== false;
        poolStrip.style.display = show ? 'flex' : 'none';
        poolStrip.textContent = '';
        if (!show) return;
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:14px;font-size:9.5px;color:hsl(var(--text-500))';
        const label = document.createElement('span');
        label.textContent = 'Account';
        const status = document.createElement('span');
        status.style.cssText = 'margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        if (poolPinBusy) status.textContent = 'Applying…';
        else if (poolPinState.error) status.textContent = String(poolPinState.error).slice(0, 90);
        else if (poolPinState.supported === null) status.textContent = 'Loading…';
        else if (poolPinState.mode === 'auto') status.textContent = 'Auto';
        else {
            const target = (poolPinState.accounts || []).find(account => account.id === poolPinState.targetAccountId);
            status.textContent = poolPinState.applied ? poolAccountName(target) : `${poolAccountName(target)} · pending`;
        }
        head.append(label, status);
        const choices = document.createElement('div');
        choices.style.cssText = 'display:flex;gap:4px;overflow-x:auto;scrollbar-width:none';
        const addChoice = (text, action, id, selected, pending) => {
            const choice = document.createElement('span');
            choice.setAttribute('role', 'radio'); choice.setAttribute('aria-checked', String(selected));
            choice.tabIndex = -1;
            choice.dataset.poolAction = action;
            if (id !== null) choice.dataset.accountId = String(id);
            choice.textContent = text;
            choice.style.cssText = 'flex:0 0 auto;border-radius:7px;padding:4px 7px;font-size:10.5px;line-height:1.2;cursor:pointer;border:1px solid color-mix(in srgb,hsl(var(--text-100)) 11%,transparent);color:hsl(var(--text-300));background:transparent';
            if (selected) {
                choice.style.background = 'color-mix(in srgb,hsl(var(--cui-accent,14 62% 60%)) 18%,transparent)';
                choice.style.color = 'hsl(var(--text-100))';
                choice.style.borderColor = 'color-mix(in srgb,hsl(var(--cui-accent,14 62% 60%)) 45%,transparent)';
            } else if (pending) choice.style.borderStyle = 'dashed';
            if (poolPinBusy) choice.style.opacity = '.55';
            choice.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
            choice.addEventListener('click', event => {
                event.preventDefault(); event.stopPropagation();
                if (!poolPinBusy && !selected) setPoolPin(action, id);
            });
            choices.append(choice);
        };
        addChoice('Auto', 'auto', null, poolPinState.mode === 'auto', false);
        for (const account of poolPinState.accounts || []) {
            const target = poolPinState.mode === 'pin' && poolPinState.targetAccountId === account.id;
            addChoice(poolAccountName(account), 'pin', account.id, target && poolPinState.appliedAccountId === account.id && poolPinState.applied,
                target && (!poolPinState.applied || poolPinState.appliedAccountId !== account.id));
        }
        poolStrip.append(head, choices);
    };
    poolPinViews.add(paintPoolPin);
    const restoreFlow = () => {
        flowing = false;
        menu.style.overflow = originalOverflow; menu.style.height = originalHeight;
        scroll.style.overflowY = originalScroll;
    };
    function paint() {
        for (const button of strip.querySelectorAll('button[data-provider]')) {
            const on = button.dataset.provider === active;
            button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1;
            button.style.background = on ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent';
            button.style.color = on ? 'hsl(var(--text-100))' : 'hsl(var(--text-400))';
        }
        paintPoolPin();
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
        if (poolStrip.parentElement !== now.group || poolStrip.previousSibling !== strip) strip.after(poolStrip);
        for (const row of now.rows) {
            const id = rowModelId(row);
            if (hidden.has(id)) row.style.display = 'none';
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
            if (active === 'gemini') refreshPoolPin();
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
    // Tabs are grouped into rows of at most TAB_COLUMNS. Each row is a flex line
    // stretched to the widest one, while each tab keeps its content width as the
    // flex basis. A 4/3 split therefore stays flush-edged without starving the
    // longer labels in the three-tab row.
    const tabRows = [];
    for (let i = 0; i < providers.length; i += TAB_COLUMNS) {
        const line = document.createElement('div');
        line.style.cssText = `display:flex;gap:${TAB_GAP}px;width:100%`;
        tabRows.push(line);
        strip.appendChild(line);
    }
    const allTabs = [];
    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.provider = provider.id; button.textContent = provider.label; button.setAttribute('role', 'tab');
        button.style.cssText = 'flex:1 1 auto;min-width:max-content;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis;border:0;border-radius:7px;padding:5px 6px;font:inherit;font-size:12px;cursor:pointer;user-select:none;transition:background 130ms,color 130ms';
        button.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
        button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); select(provider.id, true); });
        button.addEventListener('keydown', e => {
            if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
            e.preventDefault(); e.stopPropagation();
            const index = allTabs.indexOf(button);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? allTabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + allTabs.length) % allTabs.length;
            allTabs[next].focus(); select(allTabs[next].dataset.provider, true);
        });
        tabRows[Math.floor(i / TAB_COLUMNS)].appendChild(button);
        allTabs.push(button);
    }
    reconcile();
    // The last row holds fewer tabs, so left alone it ends short of the full row.
    // Measure each row at its own intrinsic width first, then pin the strip to the
    // widest and let every row fill it. Keep each tab's content width as its flex
    // basis so long provider labels are not squeezed down to the width of
    // short ones.
    for (const line of tabRows) line.style.width = 'max-content';
    for (const button of allTabs) button.style.flex = '0 0 auto';
    const widest = Math.max(0, ...tabRows.map(line => line.getBoundingClientRect().width));
    for (const button of allTabs) button.style.flex = '1 1 auto';
    for (const line of tabRows) line.style.width = '100%';
    if (widest) strip.style.width = Math.ceil(widest + 12) + 'px';
    const maxMenuWidth = Math.max(180, window.innerWidth - 24);
    const menuChrome = Math.max(0, menu.offsetWidth - strip.clientWidth);
    menu.style.minWidth = Math.min(Math.max(260, strip.scrollWidth + menuChrome), maxMenuWidth) + 'px';
    paint();
    decorated.set(menu, { strip, reconcile, clean() {
        alive = false; revision++; animation?.cancel();
        poolPinViews.delete(paintPoolPin);
        hidden = new Set(); reconcile();
        poolStrip.remove(); strip.remove(); restoreFlow();
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
ctx.every(5 * 60 * 1000, () => refreshAccountUsage());
sync().then(() => { dirty = true; });
ctx.onDispose(() => { disposed = true; for (const view of decorated.values()) view.clean(); decorated.clear(); });

const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'provider-picker', title: 'Providers & agents',
    description: 'Provider transport and reasoning for main sessions and custom subagents. Request settings apply to the next model call; current turns and saved transcripts stay unchanged.',
    defaults: DEFAULTS, immediateSave: true,
    controls: [
        { key: 'openAIAccounts', type: 'custom', label: 'ChatGPT OAuth accounts', group: 'OpenAI account', wide: true,
          hint: 'Double-click an account’s reset-credit count to confirm spending one credit. Its weekly usage and remaining credits update from the API automatically. The × arms login removal; removing the active account selects another, and removing the last signs Codex out.', node: accountControl },
        { key: 'autoSwitchAccounts', type: 'toggle', label: 'Automatically switch accounts', group: 'OpenAI account',
          hint: 'When the active account reaches the weekly threshold, select the eligible account with the lowest main-model weekly usage.' },
        { key: 'autoSwitchWeeklyThreshold', type: 'number', label: 'Weekly switch threshold', min: 1, max: 100, group: 'OpenAI account',
          hint: 'Percentage of the active account’s main-model weekly limit that enables automatic switching.' },
        { key: 'reasoningEnabled', type: 'toggle', label: 'Reasoning', group: 'Reasoning',
          hint: 'OpenAI and Gemini only. Off asks the provider to skip reasoning on the next model call. On keeps each model’s selected effort tier.' },
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
          text: 'The same reasoning controls apply to OpenAI and Gemini subagents.', hint: 'Agent models and effort stay in their native definitions. Rail layout and transcript visibility remain in the Subagents dashboard panel.' },
    ],
    apply(values) { preferences = { ...DEFAULTS, ...values }; },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => { REG.specs.delete(spec.plugin); REG.subs.forEach(fn => { try { fn(); } catch (_) {} }); });
if (!REG.subs.size) spec.apply(DEFAULTS);
