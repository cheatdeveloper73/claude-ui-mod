/* claude-ui-mod :: usage-bar (renderer)
 *
 * Keeps the floating composer context meter. Account usage belongs on the
 * Desktop's own ring and in the popover opened by that ring, so the provider
 * quota never competes with the composer controls for width.
 */
'use strict';

const HOST_ID = 'cuimod-usage';
const STYLE_ID = 'cuimod-native-usage-style';
const BAR_H = 22;
const GAP = 14;
const MIN_W = 120;
const CTX_CHANNEL = cuimod.eipc('claude.web', 'LocalSessions', 'getContextUsage');

let cfg = null;
let data = { plan: null, openai: null, pool: null, analytics: null, ctx: null, native: null };
let resetsText = null;
let host = null, shadow = null, bar = null, sheet = null;
let timer = null;
let raf = 0;
let compactToggleBusy = false;
let compactToggleOwner = null;
let compactToggleWant = null;
let compactToggleUntil = 0;
let rendererDisposed = false;
const ringOriginal = new WeakMap();

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function short(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (value >= 1e3) return Math.round(value / 1e3) + 'k';
    return String(value);
}

function formatCountdown(value, includeMinuteWithDays = false) {
    if (value === null || value === undefined || value === '') return '';
    let seconds = 0;
    if (typeof value === 'number') {
        // OpenAI exposes reset_at as a Unix timestamp and reset_after_seconds
        // as a duration. Their magnitudes are unambiguous at the current epoch.
        if (value > 1e11) seconds = Math.max(0, Math.round((value - Date.now()) / 1000));
        else if (value > 1e8) seconds = Math.max(0, Math.round((value * 1000 - Date.now()) / 1000));
        else seconds = Math.max(0, Math.round(value));
    } else seconds = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 1000));
    if (!Number.isFinite(seconds) || seconds <= 0) return 'now';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return days + 'd ' + hours + 'h' + (includeMinuteWithDays ? ' ' + minutes + 'm' : '');
    if (hours) return hours + 'h ' + minutes + 'm';
    return Math.max(1, minutes) + 'm';
}

// The two compiled-in arms are recognised by name. Anything else is served by
// an adapter, and the router already told us which one in the limits reply --
// naming adapter providers here is what made this file need editing every time
// one was added.
function providerOfModel(model) {
    const value = String(model || '').toLowerCase();
    if (/gpt|codex|openai/.test(value)) return 'openai';
    // A session with no turns and no composer selection yet has no model. The
    // pool provider below belongs to whichever model the LAST snapshot asked
    // about, so inheriting it here bills a fresh session to a previous
    // session's adapter and the popover reports its account as unavailable.
    if (!value) return 'claude';
    if (data.provider && data.provider !== 'openai' && data.provider !== 'claude') return data.provider;
    return 'claude';
}

function modelName(model) {
    return String(model || 'Session').replace(/^claude-/i, '').replace(/\[1m\]/ig, '').replace(/:.+$/, '');
}

function providerName(provider, model) {
    if (provider === 'openai') return modelName(model).replace(/^gpt-/i, 'GPT ');
    if (provider !== 'claude') return modelName(model).replace(new RegExp('^' + provider + '-', 'i'),
        provider.replace(/^(.)/, (letter) => letter.toUpperCase()) + ' ');
    return modelName(model).replace(/^(.)/, (letter) => letter.toUpperCase());
}

function contextTitle(context) {
    const head = (context.model || 'session') + ' — ' + context.totalTokens.toLocaleString()
        + ' of ' + context.rawMaxTokens.toLocaleString()
        + (context.isAutoCompactEnabled && context.autoCompactThreshold
            ? '; compacts at ' + context.autoCompactThreshold.toLocaleString() : '');
    const lines = (context.categories || [])
        .filter((category) => category && category.tokens > 0 && category.name !== 'Free space')
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 6)
        .map((category) => category.name + ' ' + category.tokens.toLocaleString());
    return lines.length ? head + '\n' + lines.join('\n') : head;
}

function contextColour(fraction) {
    if (fraction >= cfg.danger) return cfg.ctxHot;
    if (fraction >= cfg.warn) return cfg.ctxWarn;
    return cfg.ctxCalm;
}

function barCss(prefix, value) {
    return `
${prefix}.bar {
    display: flex; align-items: center; gap: ${value.gap}px; max-width: 100%; overflow: hidden;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 10px; line-height: 1; color: hsl(var(--text-400, 48 5% 57%));
    opacity: ${value.idle}; transition: opacity 240ms cubic-bezier(.2,.85,.3,1);
    user-select: none; white-space: nowrap;
}
${prefix}.bar:hover { opacity: 1; }
${prefix}.meter { display: flex; align-items: center; gap: 6px; min-width: 0; }
${prefix}.label { flex: 0 0 auto; font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%)); }
${prefix}.track { position: relative; width: ${value.width}px; height: ${value.thickness}px; flex: 0 0 auto;
    overflow: hidden; border-radius: ${value.thickness}px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 11%, transparent); }
${prefix}.fill { position: absolute; inset: 0 auto 0 0; display: block; border-radius: inherit; background: var(--c);
    transition: width 420ms cubic-bezier(.2,.85,.3,1), background 600ms ease; }
${prefix}.compact { position: absolute; top: -1px; bottom: -1px; width: 1px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 40%, transparent);
    transition: left 420ms cubic-bezier(.2,.85,.3,1), opacity 300ms ease; }
${prefix}.value { min-width: 26px; color: hsl(var(--text-300, 55 9% 74%)); font-size: 10px;
    font-variant-numeric: tabular-nums; text-align: right; }
${prefix}.sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: hsl(var(--text-500, 48 5% 57%));
    font-size: 9.5px; }
${prefix}.compact-toggle { appearance:none; flex:0 0 auto; pointer-events:auto; border:1px solid color-mix(in srgb,hsl(var(--text-100)) 12%,transparent);
    border-radius:6px; width:20px; height:20px; padding:0; background:color-mix(in srgb,hsl(var(--text-100)) 5%,transparent);
    color:hsl(var(--text-500)); font:600 14px/1 system-ui; cursor:pointer; transition:color 160ms ease,background 160ms ease,border-color 160ms ease; }
${prefix}.compact-toggle:hover { color:hsl(var(--text-100)); background:color-mix(in srgb,hsl(var(--text-100)) 12%,transparent); }
${prefix}.compact-toggle.on { color:#7cbd8b; border-color:color-mix(in srgb,#7cbd8b 42%,transparent); background:color-mix(in srgb,#7cbd8b 14%,transparent); }
${prefix}.compact-toggle:disabled { opacity:.45; cursor:wait; }
`;
}

const HOST_CSS = (value) => `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
    position: fixed; z-index: 50; display: flex; align-items: center; justify-content: center;
    pointer-events: none; opacity: 0; transform: translateY(3px);
    /* This state is often set while the window is hidden, where transitions freeze. */
    transition: none;
}
.wrap.show { opacity: 1; transform: none; }
${barCss('', value)}
`;

function buildBar(root, value) {
    const meter = el('div', 'meter');
    meter.append(el('span', 'label', 'Context'));
    const track = el('span', 'track');
    track.append(el('i', 'fill'), el('b', 'compact'));
    meter.append(track, el('span', 'value', '—'), el('span', 'sub', ''));
    const toggle = el('button', 'compact-toggle', '⟳');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Toggle auto-compact for this session');
    toggle.addEventListener('click', toggleAutoCompact);
    const built = el('div', 'bar');
    built.append(meter, toggle);
    root.append(built);
    return built;
}

function paintComposer() {
    if (!bar || !cfg) return;
    const context = data.ctx;
    const meter = bar.querySelector('.meter');
    const have = !!(context && context.rawMaxTokens);
    const fraction = have ? clamp01(context.totalTokens / context.rawMaxTokens) : 0;
    const colour = contextColour(fraction);
    meter.style.setProperty('--c', colour);
    meter.querySelector('.fill').style.width = (fraction * 100).toFixed(2) + '%';

    const compactAt = have && context.isAutoCompactEnabled && context.autoCompactThreshold
        ? clamp01(context.autoCompactThreshold / context.rawMaxTokens) : null;
    const compact = meter.querySelector('.compact');
    compact.style.left = ((compactAt || 0) * 100).toFixed(2) + '%';
    compact.style.opacity = cfg.showCompaction && compactAt ? '1' : '0';

    const countInfo = cuimod.contextCountInfo(context);
    meter.querySelector('.value').textContent = have
        ? (countInfo.exact ? '' : '~') + Math.round(fraction * 100) + '%'
        : '—';
    const sub = meter.querySelector('.sub');
    sub.textContent = have ? short(context.totalTokens) + ' / ' + short(context.rawMaxTokens) : 'no session';
    sub.title = have ? countInfo.description + '\n' + contextTitle(context) : '';

    const toggle = bar.querySelector('.compact-toggle');
    const enabled = context?.isAutoCompactEnabled === true;
    if (compactToggleWant && context && compactToggleWant.sessionId === desktopSessionId()
        && context.isAutoCompactEnabled === compactToggleWant.enabled) {
        compactToggleWant = null;
        compactToggleUntil = 0;
    } else if (compactToggleWant && Date.now() > compactToggleUntil) {
        compactToggleWant = null;
        compactToggleUntil = 0;
    }
    toggle.classList.toggle('on', enabled);
    toggle.disabled = compactToggleBusy || !!compactToggleWant || !desktopSessionId();
    toggle.title = compactToggleWant
        ? 'Change accepted · waiting for this worker to report its effective state'
        : enabled
            ? 'Auto-compact is on for this session · click to turn it off'
            : 'Auto-compact is off for this session · click to turn it on at this model’s native window';
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

function saveSessionOverride(cliSessionId, enabled) {
    if (!cliSessionId) return;
    const registry = globalThis.__cuimodReg;
    const spec = registry?.specs?.get('auto-compact');
    if (!spec || typeof registry.set !== 'function') return;
    // Record the enablement and nothing else. Writing `window: 0` alongside it
    // read as a deliberate "auto" choice everywhere the override is consulted,
    // which masked the per-model table and the launch flag for every session
    // this button had ever touched. Any window already stored stays.
    const stored = (registry.get?.('auto-compact')?.sessionOverrides) || {};
    const held = Number(stored[cliSessionId]?.window || 0);
    registry.set('auto-compact', 'sessionOverrides', {
        ...stored,
        [cliSessionId]: held > 0 ? { enabled, window: held } : { enabled },
    });
}

async function toggleAutoCompact() {
    if (compactToggleBusy || compactToggleWant) return;
    const sessionId = desktopSessionId();
    const cliSessionId = cuimod.sessionId;
    const current = data.ctx;
    if (!sessionId || typeof current?.isAutoCompactEnabled !== 'boolean') return;
    const owner = { generation: refreshGeneration, sessionId };
    compactToggleOwner = owner;
    compactToggleBusy = true;
    paintComposer();
    try {
        const enabled = !current.isAutoCompactEnabled;
        const result = await within(cuimod.rpc('auto-compact.apply', { sessionId, enabled, window: null }));
        if (!result?.applied) throw new Error(result?.reason || 'worker unavailable');
        // A returned CLI id belongs to the worker that accepted the event even if
        // the view moved away. Without it, only the captured current owner is a
        // safe persistence key; the new view's cuimod.sessionId is unrelated.
        const target = result.cliSessionId || (refreshOwned(owner) ? cliSessionId : null);
        saveSessionOverride(target, enabled);
        if (!refreshOwned(owner)) return;
        compactToggleWant = { sessionId, enabled };
        compactToggleUntil = Date.now() + 12000;
        refresh(true);
    } catch (_) {
        if (!refreshOwned(owner)) return;
        const button = bar?.querySelector('.compact-toggle');
        if (button) button.title = 'Auto-compact change was not accepted by this worker';
    } finally {
        if (compactToggleOwner !== owner) return;
        compactToggleOwner = null;
        compactToggleBusy = false;
        paintComposer();
    }
}

function quotaFor(account, model) {
    const quotas = account?.quotas || {};
    const keys = Object.keys(quotas);
    if (!keys.length) return null;
    const wanted = modelName(model).toLowerCase().replace(/-tiered$/, '');
    const compact = wanted.replace(/[^a-z0-9]/g, '');
    const exact = keys.find((key) => key.toLowerCase().replace(/-tiered$/, '') === wanted)
        || keys.find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '').includes(compact));
    const family = /pro/.test(wanted) ? 'pro' : /flash/.test(wanted) ? 'flash' : null;
    const fallback = family && keys.find((key) => key.toLowerCase().includes(family)) || keys[0];
    const key = exact || fallback;
    return { key, value: quotas[key] };
}

function insightFor(key, provider, quotaId) {
    const meters = data.analytics?.meters || [];
    const meter = meters.find((row) => row.key === key)
        || meters.find((row) => row.provider === provider && row.quotaId === quotaId && row.aggregate);
    if (!meter) return null;
    const parts = [];
    if (meter.forecast?.ratePerMinute > 0) parts.push(meter.forecast.ratePerMinute.toFixed(3).replace(/\.?0+$/, '') + '%/min');
    if (meter.forecast?.exhaustsBeforeReset) parts.push('ETA ' + formatCountdown(meter.forecast.etaMinutes * 60));
    else if (Number.isFinite(meter.forecast?.resetMinutes)) parts.push('reset wins');
    if (meter.calibration?.tokensPerPercent) parts.push('1% \u2248 ' + short(meter.calibration.tokensPerPercent) + ' tokens');
    return { meter, text: parts.join(' \u00b7 ') || 'Learning burn rate and tokens per 1%' };
}

// The account's weekly windows are per-model. The app labels a scoped window
// by its own display name ("Fable"), so matching is on that name's family, the
// same test the app applies before it picks the ring's peak window.
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'design'];

function modelFamily(model) {
    const value = String(model || '').toLowerCase();
    return FAMILIES.find((family) => value.includes(family)) || null;
}

function scopedQuotaId(name) {
    const family = modelFamily(name);
    if (family === 'opus') return 'seven_day_opus';
    if (family === 'sonnet') return 'seven_day_sonnet';
    if (family === 'fable' || family === 'design') return 'seven_day_omelette';
    return null;
}

function liveClaudeRows(model) {
    const family = modelFamily(model);
    const rows = [];
    for (const [index, row] of (data.native?.limits || []).entries()) {
        // A window with no model scope covers every model and always applies.
        // A scoped one belongs to the selected model or to no visible row.
        if (row.model && family && !row.model.toLowerCase().includes(family)) continue;
        const label = row.kind === 'session' ? '5-hour limit'
            : row.kind === 'weekly_all' ? 'Weekly · all models'
            : row.model ? 'Weekly · ' + row.model
            : row.surface ? (row.group === 'weekly' ? 'Weekly · ' : '') + row.surface
            : row.group === 'weekly' ? 'Weekly · all models' : '5-hour limit';
        const quotaId = row.kind === 'session' ? 'five_hour'
            : row.kind === 'weekly_all' ? 'seven_day'
            : scopedQuotaId(row.model);
        rows.push({
            key: (row.kind || 'limit') + ':' + index,
            label,
            pct: row.percent,
            reset: row.resetsAt ? 'Resets in ' + formatCountdown(row.resetsAt) : '',
            insight: quotaId ? insightFor(null, 'claude', quotaId) : null,
        });
    }
    return rows;
}

function historyClaudeRows(model) {
    const plan = data.plan;
    const latest = plan?.latest || {};
    const reset = resetsText ? 'Resets in ' + resetsText.replace(/^in\s+/i, '') : '';
    const rows = [];
    const add = (key, label) => {
        if (typeof latest[key] !== 'number') return;
        const quotaId = data.plan?.buckets?.[key]?.id || key;
        rows.push({ key, label, pct: latest[key], reset, insight: insightFor(null, 'claude', quotaId) });
    };
    add('fh', '5-hour limit');
    add('sd', 'Weekly · all models');
    const family = modelFamily(model);
    if (family === 'opus') add('so', 'Weekly · Opus');
    if (family === 'sonnet') add('sn', 'Weekly · Sonnet');
    if (family === 'fable' || family === 'design') add('om', 'Weekly · ' + (family === 'fable' ? 'Fable' : 'Claude Design'));
    return rows;
}

function claudeRows(model) {
    const live = liveClaudeRows(model);
    return live.length ? live : historyClaudeRows(model);
}

function openAIRows() {
    const usage = data.openai;
    if (!usage?.rateLimit) return { rows: [], error: usage?.error || 'OpenAI usage is unavailable' };
    const rows = [];
    const add = (window, key, label) => {
        if (!window || typeof window.usedPercent !== 'number') return;
        const weekly = window.limitWindowSeconds > 21600;
        rows.push({
            key,
            label: label || (weekly ? 'Weekly · all models' : '5-hour limit'),
            pct: window.usedPercent,
            reset: window.resetAt ? 'Resets in ' + formatCountdown(window.resetAt)
                : window.resetAfterSeconds ? 'Resets in ' + formatCountdown(window.resetAfterSeconds) : '',
            insight: insightFor('openai:chatgpt:' + key, 'openai', key),
        });
    };
    add(usage.rateLimit.primary, 'primary', '');
    add(usage.rateLimit.secondary, 'secondary', '');
    for (const [index, extra] of (usage.additionalRateLimits || []).entries()) {
        const id = extra.feature || extra.name || index;
        const label = extra.name || extra.feature || 'Additional limit';
        add(extra.rateLimit?.primary, 'additional:' + id + ':primary', label);
        add(extra.rateLimit?.secondary, 'additional:' + id + ':secondary', label + ' · secondary');
    }
    return { rows, error: rows.length ? '' : 'OpenAI returned no rate-limit windows' };
}

// Some adapters report one subscription with shared rolling windows, rather
// than the per-account pool shape used by other providers.
function subscriptionRows() {
    const usage = data.pool;
    if (!usage || usage.error) return { rows: [], error: usage?.error || 'Subscription usage is unavailable' };
    const rows = [];
    const add = (window, key, label, includeMinuteWithDays = false) => {
        const used = window?.used;
        const cap = window?.cap;
        if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return;
        rows.push({
            key,
            label,
            pct: Math.max(0, Math.min(100, used / cap * 100)),
            reset: window.resetAt ? 'Resets in ' + formatCountdown(window.resetAt, includeMinuteWithDays) : '',
            insight: { text: '' },
        });
    };
    add(usage.windowLimits?.fiveHour, 'five-hour', '5-hour limit');
    add(usage.windowLimits?.weekly, 'weekly', 'Weekly · all models', true);
    return { rows, error: rows.length ? '' : 'Provider returned no rolling-window limits' };
}

// An adapter provider backed by several accounts. Each active account gets a
// row; the ring shows the one the scheduler would actually pick.
function poolRows(model, provider) {
    const usage = data.pool;
    if (!Array.isArray(usage?.accounts)) return { rows: [], error: usage?.error || 'Account usage is unavailable' };
    if (usage.poolMeter?.missingUsedPercent === 0) {
        const accounts = usage.accounts.filter(account => account?.status === 'active' && account.schedulable === true);
        if (!accounts.length) return { rows: [], error: 'No schedulable accounts' };
        const used = accounts.reduce((sum, account) => {
            const percent = quotaFor(account, model)?.value?.utilization;
            return sum + (Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0);
        }, 0) / accounts.length;
        return { rows: [{
            key: 'pool', label: `${usage.poolMeter.label} · ${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
            pct: used, percentLabel: used.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%',
            schedulable: true, insight: { text: '' },
        }], error: '' };
    }
    const rows = usage.accounts
        .filter((account) => account?.status === 'active')
        .map((account) => {
            const quota = quotaFor(account, model);
            if (!quota?.value || typeof quota.value.utilization !== 'number') return null;
            return {
                key: String(account.id),
                label: (account.name || 'Account ' + account.id) + (account.tier ? ' · ' + account.tier : '')
                    + (quota.value.windowSeconds >= 6 * 86400 ? ' · Weekly' : ''),
                pct: quota.value.utilization,
                reset: quota.value.resetTime ? 'Resets in ' + formatCountdown(quota.value.resetTime) : '',
                remaining: quota.value.remainingFraction,
                schedulable: account.schedulable,
                insight: insightFor(provider + ':' + account.id + ':' + quota.key, provider, quota.key),
            };
        })
        .filter(Boolean);
    const unmeasured = usage.accounts.filter(account => account?.status === 'active' && account.schedulable === true).length
        - rows.filter(row => row.schedulable === true).length;
    const notice = unmeasured > 0 && usage.quotaLabel
        ? `${unmeasured} schedulable account${unmeasured === 1 ? '' : 's'} ${unmeasured === 1 ? 'has' : 'have'} no ${usage.quotaLabel} reading` : '';
    return { rows, notice, error: rows.length || notice ? '' : 'No active account has a quota for ' + providerName(provider, model) };
}

function snapshot() {
    // The composer's selection is what the next request spends, and it is the
    // only model a session with no turns yet has. Context usage names the model
    // of the turns already taken, so it is the fallback, not the authority.
    const model = data.native?.model || data.ctx?.model;
    const provider = providerOfModel(model);
    let result;
    if (provider === 'openai') result = openAIRows();
    else if (data.pool?.windowLimits) result = subscriptionRows();
    else if (provider !== 'claude') result = poolRows(model, provider);
    else result = { rows: claudeRows(model), error: '' };

    const rows = result.rows || [];
    // The popover exposes every active account. A disabled scheduler slot
    // cannot serve the next request, so it cannot make the ring look healthier.
    // A single subscription has multiple windows instead; its ring shows the
    // most consumed window, as Claude and OpenAI do.
    const pooled = Array.isArray(data.pool?.accounts);
    const eligibleRows = pooled ? rows.filter((row) => row.schedulable !== false) : rows;
    const ringRows = eligibleRows.length ? eligibleRows : rows;
    const ringRow = pooled
        ? ringRows.slice().sort((a, b) => a.pct - b.pct)[0]
        : ringRows.slice().sort((a, b) => b.pct - a.pct)[0];
    return {
        provider,
        model,
        title: provider === 'openai' ? 'ChatGPT'
            : provider === 'claude' && data.native?.label ? data.native.label
            : providerName(provider, model),
        rows,
        ringRow,
        notice: result.notice || '',
        error: result.error || '',
    };
}

function ringButton() {
    return document.querySelector('[data-testid="chat-context-ring"]')
        || Array.from(document.querySelectorAll('button')).find((button) => /^Usage:/.test(button.getAttribute('aria-label') || ''))
        || null;
}

function ringColour(pct) {
    if (pct >= 85) return 'var(--cds-fill-danger, #e57070)';
    if (pct >= 60) return 'var(--cds-fill-warning, var(--cds-fill-accent))';
    return 'var(--cds-fill-accent, #d18c4d)';
}

function setAttribute(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setStyle(node, property, value) {
    if (node.style.getPropertyValue(property) !== value) node.style.setProperty(property, value);
}

function syncRing() {
    const button = ringButton();
    const picked = snapshot();
    const row = picked.ringRow;
    if (!button || !row || !cfg?.enabled) return;

    const circle = button.querySelectorAll('circle')[1];
    if (circle) {
        if (!ringOriginal.has(circle)) {
            ringOriginal.set(circle, { style: circle.getAttribute('style'), stroke: circle.getAttribute('stroke'),
                dasharray: circle.getAttribute('stroke-dasharray'), dashoffset: circle.getAttribute('stroke-dashoffset') });
        }
        const radius = Number(circle.getAttribute('r')) || 5;
        const circumference = 2 * Math.PI * radius;
        setStyle(circle, 'stroke', ringColour(row.pct));
        setStyle(circle, 'stroke-dasharray', String(circumference));
        setStyle(circle, 'stroke-dashoffset', (circumference * (1 - clamp01(row.pct / 100))).toFixed(3));
        setStyle(circle, 'transition', 'stroke-dashoffset 300ms ease, stroke 300ms ease');
    }

    if (!ringOriginal.has(button)) ringOriginal.set(button, { aria: button.getAttribute('aria-label') });
    const aria = ['Usage: ' + picked.title + ': ' + (row.percentLabel || Math.round(row.pct) + '%'), row.reset, picked.notice]
        .filter(Boolean).join(', ');
    setAttribute(button, 'aria-label', aria);
    setAttribute(button, 'data-cuimod-provider-usage', picked.provider);
}

function restoreRing() {
    for (const button of document.querySelectorAll('[data-cuimod-provider-usage]')) {
        const original = ringOriginal.get(button);
        if (original) {
            if (original.aria == null) button.removeAttribute('aria-label');
            else button.setAttribute('aria-label', original.aria);
        }
        button.removeAttribute('data-cuimod-provider-usage');
    }
    for (const circle of document.querySelectorAll('button svg circle')) {
        const original = ringOriginal.get(circle);
        if (!original) continue;
        if (original.style == null) circle.removeAttribute('style');
        else circle.setAttribute('style', original.style);
        for (const [attribute, value] of Object.entries({ stroke: original.stroke, 'stroke-dasharray': original.dasharray,
            'stroke-dashoffset': original.dashoffset })) {
            if (value == null) circle.removeAttribute(attribute);
            else circle.setAttribute(attribute, value);
        }
    }
}

function usagePopover(node) {
    return node && /Context window|(?:Plan|Your) usage limits/.test(node.textContent || '') ? node : null;
}

function restorePlan(popover, keepCustom = false) {
    const custom = popover.querySelector('[data-cuimod-provider-limits]');
    if (custom && !keepCustom) custom.remove();
    for (const node of popover.querySelectorAll('[data-cuimod-native-plan], [data-cuimod-native-rows]')) {
        node.removeAttribute('data-cuimod-native-plan');
        node.removeAttribute('data-cuimod-native-rows');
        node.style.removeProperty('display');
    }
}

// The app's plan block is not reliably the divider's next sibling: the popover
// body is a lazily loaded component, and a pass that lands before it renders
// would otherwise hide whatever footer element happens to be sitting there.
function planBlock(divider) {
    for (let node = divider.nextElementSibling; node; node = node.nextElementSibling) {
        if (node.hasAttribute('data-cuimod-provider-limits')) continue;
        if (node.hasAttribute('data-cuimod-native-plan')) return node;
        // The heading reads "Your usage limits" instead of "Plan usage limits"
        // on some plans (app 2.7032.0), so the testid is the primary anchor.
        if (node.getAttribute('data-testid') === 'usage-ring-plan') return node;
        if (/(?:Plan|Your) usage limits/.test(node.textContent || '')) return node;
    }
    return null;
}

function hideNode(node, attribute) {
    setAttribute(node, attribute, '1');
    setStyle(node, 'display', 'none');
}

function showNode(node, attribute) {
    if (!node.hasAttribute(attribute)) return;
    node.removeAttribute(attribute);
    node.style.removeProperty('display');
}

function restorePopover(popover) {
    restorePlan(popover);
    for (const node of popover.querySelectorAll('[data-cuimod-native-context]')) {
        node.removeAttribute('data-cuimod-native-context');
        node.style.removeProperty('display');
    }
}

function hideContext(popover, divider) {
    for (const node of [divider.previousElementSibling, divider]) {
        if (!node) continue;
        setAttribute(node, 'data-cuimod-native-context', '1');
        setStyle(node, 'display', 'none');
    }
}

function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
}

function paintLimitRows(container, rows, error, notice) {
    const live = new Map(Array.from(container.querySelectorAll('[data-cuimod-limit-row]'))
        .map((node) => [node.getAttribute('data-cuimod-limit-row'), node]));
    const used = new Set();

    for (const row of rows) {
        const key = String(row.key);
        used.add(key);
        let node = live.get(key);
        if (!node) {
            node = el('div', 'flex flex-col');
            node.setAttribute('data-cuimod-limit-row', key);
            const top = el('div', 'flex items-baseline justify-between gap-2');
            top.append(el('span', 'text-footnote text-primary truncate'), el('span', 'flex items-baseline gap-1.5 text-footnote text-muted tabular-nums shrink-0'));
            const track = el('div', 'mt-pad-xs h-[4px] rounded-full overflow-hidden');
            track.setAttribute('role', 'progressbar');
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', '100');
            track.style.backgroundColor = 'var(--cds-chart-reference-tint)';
            const fill = el('div');
            fill.style.cssText = 'height:100%;width:0;border-radius:inherit;transition:width 300ms ease,background-color 300ms ease;';
            track.append(fill);
            const insight = el('div', 'cuimod-limit-insight text-footnote text-muted');
            node.append(top, track, insight);
            container.append(node);
        }
        const [label, right] = node.querySelector('.flex.items-baseline').children;
        setText(label, row.label);
        const percentText = row.percentLabel || Math.round(row.pct) + '%';
        setText(right, [row.reset, percentText].filter(Boolean).join(' · '));
        const insight = node.querySelector('.cuimod-limit-insight');
        const insightText = row.insight?.text ?? 'Learning burn rate and tokens per 1%';
        setText(insight, insightText);
        insight.hidden = !insightText;
        const track = node.querySelector('[role="progressbar"]');
        setAttribute(track, 'aria-valuetext', percentText);
        const fill = track.firstElementChild;
        const width = (clamp01(row.pct / 100) * 100).toFixed(2) + '%';
        requestAnimationFrame(() => { setStyle(fill, 'width', width); });
        setStyle(fill, 'background-color', ringColour(row.pct));
    }

    for (const [key, node] of live) if (!used.has(key)) node.remove();
    let status = container.querySelector('[data-cuimod-limit-status]');
    const message = notice || (!rows.length ? error : '');
    if (message) {
        if (!status) {
            status = el('div', 'px-lg pb-xs text-footnote text-muted');
            status.setAttribute('data-cuimod-limit-status', '1');
            container.append(status);
        }
        setText(status, message);
    } else if (status) status.remove();
}

function transformPopover(popover) {
    const active = usagePopover(popover);
    if (!active) return;
    const picked = snapshot();
    if (!cfg?.enabled) {
        restorePopover(active);
        return;
    }

    const divider = Array.from(active.querySelectorAll('div')).find((node) => /\bh-px\b/.test(node.className));
    if (!divider) return;
    hideContext(active, divider);
    // The app's plan block is a tier header over its own bars. Its bars repeat
    // ours and are not scoped to the selected model; the header carries the
    // plan tier and the settings link, which exist nowhere else in the popover.
    // So for Claude only the bars go, and our section takes their place under
    // the header. Failing to build rows leaves the app's bars alone.
    const plan = planBlock(divider);
    // The window rows are flat siblings of the header, not one wrapper.
    const planRows = plan ? Array.from(plan.children).slice(1) : [];
    if (plan && picked.provider !== 'claude') hideNode(plan, 'data-cuimod-native-plan');
    else if (plan) {
        showNode(plan, 'data-cuimod-native-plan');
        for (const row of planRows) {
            if (picked.rows.length) hideNode(row, 'data-cuimod-native-rows');
            else showNode(row, 'data-cuimod-native-rows');
        }
    }
    const anchor = plan && picked.provider === 'claude' ? plan : divider;

    let custom = active.querySelector('[data-cuimod-provider-limits]');
    if (!custom) {
        custom = el('div', 'flex flex-col gap-xs');
        custom.setAttribute('data-cuimod-provider-limits', '1');
        const header = el('div', 'flex items-center justify-between gap-2 px-lg py-xs min-h-[20px]');
        const open = el('button', 'cuimod-usage-open text-footnote text-muted shrink-0', 'Open Usage Atlas ↗');
        open.type = 'button';
        open.addEventListener('click', (event) => {
            event.preventDefault(); event.stopPropagation();
            cuimod.rpc('usage-bar.openDashboard').catch(() => {});
        });
        header.append(el('span', 'text-footnote text-muted'), open);
        custom.append(header, el('div', 'flex flex-col gap-sm px-lg pb-xs'));
        // The selection can change while the popover is closed, and a stale
        // model would scope these rows to the wrong one until the next refresh.
        refresh(true);
    }
    if (custom.previousElementSibling !== anchor) anchor.after(custom);

    const header = custom.firstElementChild;
    setText(header.firstElementChild, 'Usage intelligence · ' + picked.title);
    paintLimitRows(custom.lastElementChild, picked.rows, picked.error, picked.notice);
}

function syncNativeUsage() {
    syncRing();
    for (const node of document.querySelectorAll('[role="dialog"], [data-cds="Popover"]')) transformPopover(node);
}

function scanBands() {
    let found = null;
    for (const band of document.querySelectorAll('.epitaxy-composer-band')) {
        const text = band.textContent || '';
        if (!/usage limit/i.test(text)) {
            band.removeAttribute('data-cuimod-usage');
            continue;
        }
        setAttribute(band, 'data-cuimod-usage', '1');
        const match = text.match(/Resets\s+(.+?)(?:Get more usage|$)/i);
        if (match) found = match[1].trim();
    }
    if (found !== resetsText) {
        resetsText = found;
        paintComposer();
        syncNativeUsage();
    }
}

function desktopSessionId() {
    const match = (location.pathname + location.search).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? 'local_' + match[0].toLowerCase() : null;
}

const REQUEST_TIMEOUT_MS = 5000;
let refreshGeneration = 0;
let refreshFlight = null;
let refreshQueued = false;
let refreshQueuedLimits = false;
let observedDesktopId = desktopSessionId();
let observedCliSessionId = cuimod.sessionId || null;
let lastLimitsAt = 0;
let lastLimitsProvider = null;
let lastLimitsModel = null;

function within(promise, ms = REQUEST_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('usage observation timed out')), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function refreshOwned(owner) {
    return !rendererDisposed && owner.generation === refreshGeneration
        && owner.sessionId === observedDesktopId && owner.sessionId === desktopSessionId();
}

function clearProviderObservation() {
    data.native = null;
    data.openai = null;
    data.pool = null;
    data.analytics = null;
    data.provider = null;
    lastLimitsAt = 0;
    lastLimitsProvider = null;
    lastLimitsModel = null;
}

function invalidateObservation(nextDesktopId = desktopSessionId(), nextCliSessionId = cuimod.sessionId || null) {
    refreshGeneration++;
    refreshFlight = null;
    refreshQueued = false;
    refreshQueuedLimits = false;
    observedDesktopId = nextDesktopId;
    observedCliSessionId = nextCliSessionId;
    data.ctx = null;
    clearProviderObservation();
    compactToggleOwner = null;
    compactToggleBusy = false;
    compactToggleWant = null;
    compactToggleUntil = 0;
    paintComposer();
    syncNativeUsage();
}

function syncObservationIdentity() {
    const id = desktopSessionId();
    if (id === observedDesktopId) return false;
    invalidateObservation(id, cuimod.sessionId || null);
    return true;
}

async function refresh(forceLimits = false) {
    syncObservationIdentity();
    const generation = refreshGeneration;
    if (refreshFlight?.generation === generation) {
        refreshQueued = true;
        refreshQueuedLimits = refreshQueuedLimits || forceLimits;
        return refreshFlight.promise;
    }

    const owner = { generation, sessionId: observedDesktopId, promise: null };
    const run = Promise.resolve().then(async () => {
        let context = null;
        try {
            context = owner.sessionId ? await within(cuimod.appInvoke(CTX_CHANNEL, owner.sessionId)) : null;
        } catch (_) {
            if (!refreshOwned(owner)) return false;
        }
        if (!refreshOwned(owner)) return false;
        data.ctx = context;
        paintComposer();

        let native = data.native;
        try { native = await within(cuimod.rpc('usage-bar.native')); }
        catch (_) { /* Page-world state is unreadable while the host reloads. */ }
        if (!refreshOwned(owner)) return false;
        const before = data.native?.model || null;
        data.native = native;
        const model = data.native?.model || data.ctx?.model || null;
        if (before !== model || (lastLimitsModel && lastLimitsModel !== model)) clearProviderObservation();
        data.native = native;

        const provider = providerOfModel(model);
        const due = forceLimits || provider !== lastLimitsProvider || model !== lastLimitsModel
            || Date.now() - lastLimitsAt >= 30000;
        if (due) {
            try {
                const limits = await within(cuimod.rpc('usage-bar.allLimits', { model }));
                if (!refreshOwned(owner)) return false;
                // The composer can switch models while the slower provider-limit
                // request is pending. Re-read its authoritative page-world state
                // before associating those limits with the selected model.
                const confirmedNative = await within(cuimod.rpc('usage-bar.native'));
                if (!refreshOwned(owner)) return false;
                const confirmedModel = confirmedNative?.model || data.ctx?.model || null;
                if (confirmedModel !== model) {
                    clearProviderObservation();
                    data.native = confirmedNative;
                    refreshQueued = true;
                    refreshQueuedLimits = true;
                    return false;
                }
                data.native = confirmedNative;
                if (limits?.plan) data.plan = limits.plan;
                if (limits?.openai) data.openai = limits.openai;
                if (limits?.pool) data.pool = limits.pool;
                if (limits?.provider) data.provider = limits.provider;
                if (limits?.analytics) data.analytics = limits.analytics;
                lastLimitsAt = Date.now();
                lastLimitsProvider = provider;
                lastLimitsModel = model;
            } catch (_) {
                if (!refreshOwned(owner)) return false;
                // The last same-model snapshot remains useful while its main
                // plugin reloads; a changed model cleared it above.
            }
        }

        paintComposer();
        syncNativeUsage();
        return true;
    }).finally(() => {
        // Retired completions cannot unlock, repaint or reschedule the current
        // visit. Only the owner installed in refreshFlight may do that.
        if (refreshFlight !== owner) return;
        refreshFlight = null;
        if (refreshQueued && refreshOwned(owner)) {
            const force = refreshQueuedLimits;
            refreshQueued = false;
            refreshQueuedLimits = false;
            queueMicrotask(() => refresh(force));
        }
    });
    owner.promise = run;
    refreshFlight = owner;
    return run;
}

const ROW_MAX_DEPTH = 8;
function rowFrom(group) {
    const row = group.parentElement;
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    if (rect.height < 12 || rect.height > 52 || rect.width < 220) return null;
    return { row, right: group, rowRect: rect, rightRect: group.getBoundingClientRect() };
}

function rowIn(scope) {
    for (const group of scope.querySelectorAll('[class*="ml-auto"], [class*="ms-auto"]')) {
        const found = rowFrom(group);
        if (found) return found;
    }
    return null;
}

function findRow() {
    for (const scope of document.querySelectorAll('.epitaxy-composer-width')) {
        const found = rowIn(scope);
        if (found) return found;
    }
    let node = document.querySelector('.epitaxy-prompt') || document.querySelector('.epitaxy-prompt-input');
    for (let depth = 0; node && depth < ROW_MAX_DEPTH; depth += 1, node = node.parentElement) {
        const found = rowIn(node);
        if (found) return found;
    }
    return null;
}

function place() {
    if (!host || !cfg) return;
    for (const node of document.querySelectorAll('#' + HOST_ID)) if (node !== host) node.remove();
    const wrap = shadow.querySelector('.wrap');
    if (!cfg.enabled || !cfg.composerContext) { wrap.classList.remove('show'); return; }
    const found = findRow();
    if (!found) { wrap.classList.remove('show'); return; }

    let leftEdge = found.rowRect.left;
    for (const child of found.row.children) {
        if (child === found.right) break;
        const rect = child.getBoundingClientRect();
        if (rect.width > 0) leftEdge = Math.max(leftEdge, rect.right);
    }
    const voiceHost = document.getElementById('cuimod-voice-agent');
    const voicePill = voiceHost?.shadowRoot?.querySelector('.pill.on');
    const voiceRect = voicePill?.getBoundingClientRect();
    if (voiceRect && voiceRect.width > 0
        && voiceRect.bottom > found.rowRect.top && voiceRect.top < found.rowRect.bottom
        && voiceRect.right > found.rowRect.left && voiceRect.left < found.rightRect.left) {
        leftEdge = Math.max(leftEdge + voiceRect.width + 8, voiceRect.right);
    }
    const left = Math.round(leftEdge + GAP);
    const width = Math.round(found.rightRect.left - GAP - left);
    if (width < MIN_W) { wrap.classList.remove('show'); return; }

    wrap.style.left = left + 'px';
    wrap.style.top = Math.round(found.rowRect.top + (found.rowRect.height - BAR_H) / 2) + 'px';
    wrap.style.width = width + 'px';
    wrap.style.height = BAR_H + 'px';
    wrap.classList.add('show');
}

function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(); });
}

function apply(value) {
    cfg = value;
    if (host && !host.isConnected) { host = null; shadow = null; bar = null; sheet = null; }
    for (const node of document.querySelectorAll('#' + HOST_ID)) if (node !== host) node.remove();

    if (!host) {
        host = el('div');
        host.id = HOST_ID;
        shadow = host.attachShadow({ mode: 'open' });
        sheet = new CSSStyleSheet();
        shadow.adoptedStyleSheets = [sheet];
        const wrap = el('div', 'wrap');
        shadow.append(wrap);
        bar = buildBar(wrap, value);
        document.documentElement.append(host);
    }
    sheet.replaceSync(HOST_CSS(value));
    nativeStyle.textContent = value.enabled ? `
[data-cuimod-native-plan], [data-cuimod-native-rows] { display: none !important; }
[data-cuimod-provider-limits] [data-cuimod-limit-row] { min-height: 20px; }
[data-cuimod-provider-limits] .cuimod-limit-insight { margin-top: 4px; font-size: 10px; line-height: 1.25; }
[data-cuimod-provider-limits] .cuimod-usage-open { appearance: none; border: 0; padding: 2px 0; background: transparent; cursor: pointer; }
[data-cuimod-provider-limits] .cuimod-usage-open:hover { color: hsl(var(--text-200)) !important; }
@media (prefers-reduced-motion: reduce) {
  [data-cuimod-provider-limits] [role="progressbar"] > div { transition-duration: 1ms !important; }
}` : '';
    docStyle.textContent = value.hideBanner ? '[data-cuimod-usage="1"] { display: none !important; }' : '';
    paintComposer();
    schedule();
    lastLimitsAt = 0;
    refresh(true);
}

const docStyle = document.createElement('style');
docStyle.id = 'cuimod-usage-banner';
(document.head || document.documentElement).append(docStyle);
const nativeStyle = document.createElement('style');
nativeStyle.id = STYLE_ID;
(document.head || document.documentElement).append(nativeStyle);

ctx.track(window, 'resize', schedule, { passive: true });
ctx.track(window, 'scroll', schedule, { passive: true, capture: true });
ctx.track(window, 'cuimod:voice-layout', place);
ctx.track(document, 'visibilitychange', schedule);
ctx.observe(document.documentElement, { childList: true, subtree: true }, () => {
    schedule();
    scanBands();
    syncNativeUsage();
});
ctx.every(1000, () => {
    if (syncObservationIdentity()) refresh(true);
    place();
    syncNativeUsage();
});
ctx.every(8000, () => { scanBands(); refresh(); });
cuimod.onSessionChange((cliSessionId) => {
    const desktopId = desktopSessionId();
    const nextCli = cliSessionId || null;
    if (desktopId !== observedDesktopId || nextCli !== observedCliSessionId)
        invalidateObservation(desktopId, nextCli);
    refresh(true);
});
ctx.onDispose(() => {
    rendererDisposed = true;
    refreshGeneration++;
    refreshFlight = null;
    refreshQueued = false;
    compactToggleOwner = null;
    compactToggleBusy = false;
    compactToggleWant = null;
    if (raf) cancelAnimationFrame(raf);
    clearInterval(timer);
    try { host?.remove(); } catch (_) {}
    try { docStyle.remove(); nativeStyle.remove(); } catch (_) {}
    for (const band of document.querySelectorAll('[data-cuimod-usage]')) band.removeAttribute('data-cuimod-usage');
    for (const popover of document.querySelectorAll('[role="dialog"], [data-cds="Popover"]')) restorePopover(popover);
    restoreRing();
});

const spec = {
    plugin: 'usage-bar',
    title: 'Native usage ring',
    description: 'Provider-aware account limits in Claude Desktop’s usage ring and popover. Context lives in the composer only.',
    defaults: {
        enabled: true,
        composerContext: true,
        hideBanner: false,
        showCompaction: true,
        width: 96,
        thickness: 4,
        gap: 12,
        idle: 0.55,
        warn: 0.6,
        danger: 0.85,
        ctxCalm: '#8ecae6',
        ctxWarn: '#a9a0f0',
        ctxHot: '#cf8ef5',
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Provider-aware native usage ring', group: 'Usage' },
        { key: 'composerContext', type: 'toggle', label: 'Keep composer context meter', group: 'Usage' },
        { key: 'hideBanner', type: 'toggle', label: 'Hide the app’s usage band', group: 'Usage' },
        { key: 'showCompaction', type: 'toggle', label: 'Compaction mark', group: 'Composer context' },
        { key: 'width', type: 'slider', label: 'Track length', min: 40, max: 240, step: 2, unit: 'px', group: 'Composer context' },
        { key: 'thickness', type: 'slider', label: 'Track thickness', min: 2, max: 12, step: 1, unit: 'px', group: 'Composer context' },
        { key: 'gap', type: 'slider', label: 'Spacing', min: 4, max: 30, step: 1, unit: 'px', group: 'Composer context' },
        { key: 'idle', type: 'slider', label: 'Idle opacity', min: 0.1, max: 1, step: 0.01, group: 'Composer context' },
        { key: 'warn', type: 'slider', label: 'Warn at', min: 0, max: 1, step: 0.01, group: 'Composer context' },
        { key: 'danger', type: 'slider', label: 'Danger at', min: 0, max: 1, step: 0.01, group: 'Composer context' },
        { key: 'ctxCalm', type: 'color', label: 'Context — calm', group: 'Composer context color' },
        { key: 'ctxWarn', type: 'color', label: 'Context — warn', group: 'Composer context color' },
        { key: 'ctxHot', type: 'color', label: 'Context — danger', group: 'Composer context color' },
    ],
    apply,
    preview: {
        title: 'Preview — composer context',
        node() {
            const box = el('div', 'pv-hold');
            const preview = buildBar(box, spec.defaults);
            preview.querySelector('.value').textContent = '35%';
            preview.querySelector('.sub').textContent = '347k / 1M';
            preview.querySelector('.fill').style.width = '35%';
            preview.querySelector('.meter').style.setProperty('--c', spec.defaults.ctxCalm);
            preview.querySelector('.compact').style.left = '92%';
            return box;
        },
        css(value, selector) { return selector + ' .pv-hold { width: 470px; }\n' + barCss(selector + ' ', value); },
    },
};

const REG = globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() });
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
});

if (REG.subs.size === 0) apply(spec.defaults);
