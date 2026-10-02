'use strict';

const state = { data: null, provider: 'all', horizon: 60, range: 'all', loading: false, compact: false, accountQuery: '',
    poolPin: null, poolPinBusy: false, poolPinError: null };
// Visual identity is independent of provider discovery. New providers still
// appear from the payload without a client registration or a guessed brand hue.
const colours = { claude: 'var(--claude)', openai: 'var(--openai)', gemini: 'var(--gemini)',
    meta: 'var(--meta)', nanogpt: 'var(--nanogpt)' };
const colourOf = provider => colours[provider] || 'var(--ink-2)';
const providerNames = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', nanogpt: 'NanoGPT', meta: 'Meta' };
const providerLabel = provider => state.data?.sources?.[provider]?.label || providerNames[provider]
    || (provider ? provider[0].toUpperCase() + provider.slice(1) : 'Unknown provider');
let horizons = [];
const REFRESH_MS = 60000;
let requestGeneration = 0;
let requestController = null;
const ranges = [
    { value: 'today', label: 'Today' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
    { value: 'all', label: 'All time' },
];
const $ = selector => document.querySelector(selector);
const tooltip = $('#tooltip');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionDisabled = () => reduced() || document.hidden;
const copyTimers = new WeakMap();
let toastGeneration = 0;
let tipAnimation = null;
let popup = null;
let toastTimer = null;

function el(tag, cls, text)
{
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function money(value)
{
    if (!Number.isFinite(value)) return '\u2014';
    if (value === 0) return '$0.00';
    // A hundredth of a cent still reads as spend; rounding it to $0.00 would
    // make a live model look free.
    if (value < 0.005) return '<$0.01';
    return '$' + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function costOf(row) { return Number.isFinite(row?.cost?.total) ? row.cost.total : 0; }

function displayCost(row)
{
    if (!row?.cost || row.cost.unpricedResponses >= row.responses && row.responses > 0) return 'Unpriced';
    return money(row.cost.total) + (row.cost.unpricedResponses > 0 ? ' + unpriced' : '');
}

function emptyRow(columns, text)
{
    const row = el('tr');
    const cell = el('td', 'empty', text);
    cell.colSpan = columns;
    row.append(cell);
    return row;
}

// Rates are USD per million tokens and can be a fraction of a cent ($0.075);
// spend formatting would collapse that to <$0.01 and misread the table.
function rate(value)
{
    if (!Number.isFinite(value)) return '—';
    return '$' + value.toLocaleString(undefined, { maximumSignificantDigits: 12 });
}

function spendRows()
{
    return (state.data?.usage?.models || [])
        .filter(row => state.provider === 'all' || row.provider === state.provider)
        .slice()
        .sort((a, b) => costOf(b) - costOf(a));
}

function number(value, digits = 0)
{
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
}

function percent(value, digits = 2)
{
    return Number.isFinite(value) ? number(value, digits) + '%' : '—';
}

function meterWidth(value)
{
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function tokens(value)
{
    if (!Number.isFinite(value)) return '—';
    if (value >= 1e9) return (value / 1e9).toFixed(value >= 1e10 ? 1 : 2).replace(/\.0+$/, '') + 'B';
    if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 1 : 2).replace(/\.0+$/, '') + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e4 ? 0 : 1).replace(/\.0+$/, '') + 'k';
    return number(value);
}

function age(value)
{
    const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
    if (!Number.isFinite(seconds)) return 'unknown';
    if (seconds < 60) return Math.round(seconds) + 's ago';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
    return Math.round(seconds / 86400) + 'd ago';
}

function duration(minutes)
{
    if (!Number.isFinite(minutes)) return '—';
    if (minutes <= 0) return 'now';
    if (minutes < 1) return '<1m';
    const rounded = Math.round(minutes);
    if (rounded < 60) return rounded + 'm';
    if (rounded < 1440) return Math.floor(rounded / 60) + 'h ' + rounded % 60 + 'm';
    const hours = Math.round(rounded / 60);
    return Math.floor(hours / 24) + 'd ' + hours % 24 + 'h';
}

function providerDot(provider)
{
    const dot = el('i', 'provider-dot');
    dot.style.color = colourOf(provider);
    dot.setAttribute('aria-hidden', 'true');
    return dot;
}

function selectedMeters(all = false)
{
    const rows = (state.data?.meters || []).filter(row => state.provider === 'all' || row.provider === state.provider);
    if (all) return rows;
    const aggregateProviders = new Set(rows.filter(row => row.aggregate).map(row => row.provider));
    const featured = rows.filter(row => row.aggregate || !aggregateProviders.has(row.provider));
    const trackedProviders = new Set(featured.filter(row => row.track === true).map(row => row.provider));
    return featured.filter(row => !trackedProviders.has(row.provider) || row.track !== false);
}

function on(node, type, handler)
{
    (node.atlasHandlers ||= new Map()).set(type, handler);
    node.addEventListener(type, handler);
}

function animationFrames()
{
    return [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }];
}

function enterNode(node, index)
{
    if (motionDisabled()) return;
    const frames = node.tagName === 'TR' ? [{ opacity: 0 }, { opacity: 1 }] : animationFrames();
    const animation = node.animate(frames,
        { duration: 230, delay: Math.min(index * 22, 150), easing: 'cubic-bezier(.2,.85,.3,1)' });
    const timer = setTimeout(() => animation.cancel(), 450);
    animation.finished.then(() => clearTimeout(timer), () => clearTimeout(timer));
}

function patchNode(node, next)
{
    if (node.nodeType === 3)
    {
        if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
        return;
    }
    for (const attribute of [...node.attributes])
        if (attribute.name !== 'style' && !next.hasAttribute(attribute.name) && !(node.tagName === 'DETAILS' && attribute.name === 'open'))
            node.removeAttribute(attribute.name);
    for (const attribute of next.attributes)
        if (attribute.name !== 'style' && node.getAttribute(attribute.name) !== attribute.value)
            node.setAttribute(attribute.name, attribute.value);
    // style-src 'self' permits CSSOM updates, but blocks setAttribute('style').
    // Keep that boundary intact when a poll changes a bar's width or colour.
    for (const name of [...node.style])
        if (!next.style.getPropertyValue(name)) node.style.removeProperty(name);
    for (const name of next.style)
        if (node.style.getPropertyValue(name) !== next.style.getPropertyValue(name)
            || node.style.getPropertyPriority(name) !== next.style.getPropertyPriority(name))
            node.style.setProperty(name, next.style.getPropertyValue(name), next.style.getPropertyPriority(name));
    for (const [type, handler] of node.atlasHandlers || []) node.removeEventListener(type, handler);
    node.atlasHandlers = new Map();
    for (const [type, handler] of next.atlasHandlers || []) on(node, type, handler);
    swapChildren(node, [...next.childNodes]);
}

function swapChildren(root, nodes)
{
    // Identity belongs to the record, not its current rank. Patch in place so
    // polls preserve focus, expanded history and scroll positions. Handlers are
    // refreshed too: identical visible values can carry newer copy/hover data.
    const old = [...root.childNodes];
    const key = node => node.nodeType === 1 ? node.dataset.key || node.dataset.provider : null;
    const keyed = new Map(old.filter(key).map(node => [key(node), node]));
    const used = new Set();
    nodes.forEach((next, index) => {
        const id = key(next);
        let node = id ? keyed.get(id) : old[index];
        if (!node || used.has(node) || key(node) !== id || node.nodeType !== next.nodeType || node.nodeName !== next.nodeName)
            node = next;
        else patchNode(node, next);
        used.add(node);
        if (root.childNodes[index] !== node)
        {
            const focused = document.activeElement;
            if (root.moveBefore && node.isConnected && root.isConnected) root.moveBefore(node, root.childNodes[index] || null);
            else root.insertBefore(node, root.childNodes[index] || null);
            if (focused && node.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
        }
        if (node === next && root.classList?.contains('motion-region')) enterNode(node, index);
    });
    old.forEach(node => { if (!used.has(node)) node.remove(); });
}

function showTip(event, text)
{
    tipAnimation?.cancel();
    tooltip.textContent = text;
    tooltip.hidden = false;
    const x = Math.max(8, Math.min(innerWidth - tooltip.offsetWidth - 12, event.clientX + 13));
    const y = Math.max(10, event.clientY - tooltip.offsetHeight - 12);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    if (!motionDisabled()) tipAnimation = tooltip.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
        { duration: 110, easing: 'cubic-bezier(.2,.85,.3,1)' });
}

function hideTip()
{
    tipAnimation?.cancel();
    tooltip.hidden = true;
}

function showToast(message)
{
    const toast = $('#toast');
    const generation = ++toastGeneration;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toast.className = 'toast showing';
    toastTimer = setTimeout(() => {
        toast.className = 'toast hiding';
        const done = () => { if (generation === toastGeneration) { toast.hidden = true; toast.className = 'toast'; } };
        if (motionDisabled()) done();
        else { toast.getAnimations().at(-1)?.finished.then(done, done); setTimeout(done, 300); }
    }, 1500);
}

async function copyText(text, message, button = null)
{
    let copied = false;
    try
    {
        await navigator.clipboard.writeText(text);
        copied = true;
    }
    catch (_)
    {
        const field = document.createElement('textarea');
        field.value = text;
        field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;';
        document.body.append(field);
        const focused = document.activeElement;
        field.select();
        try { copied = document.execCommand('copy'); } catch (_) {}
        field.remove();
        focused?.focus({ preventScroll: true });
    }
    showToast(copied ? message : 'Clipboard access was denied');
    if (button && copied)
    {
        const previous = copyTimers.get(button);
        clearTimeout(previous?.timer);
        const original = previous?.original ?? button.textContent;
        button.classList.add('copied');
        button.textContent = button.classList.contains('text-button') ? 'Copied' : '✓';
        const timer = setTimeout(() => {
            button.classList.remove('copied');
            button.textContent = original;
            copyTimers.delete(button);
        }, 1100);
        copyTimers.set(button, { original, timer });
    }
}

function closePopup(restoreFocus = false)
{
    if (!popup) return;
    const current = popup;
    popup = null;
    current.owner.setAttribute('aria-expanded', 'false');
    current.node.classList.add('closing');
    current.node.inert = true;
    current.owner.removeAttribute('aria-controls');
    if (restoreFocus) current.owner.focus({ preventScroll: true });
    const remove = () => current.node.remove();
    if (motionDisabled()) remove();
    else { current.node.getAnimations().at(-1)?.finished.then(remove, remove); setTimeout(remove, 250); }
}

function placePopup(node, owner)
{
    const rect = owner.getBoundingClientRect();
    node.style.visibility = 'hidden';
    $('#popups').append(node);
    const pad = 8;
    const viewport = window.visualViewport || { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0 };
    const viewportLeft = viewport.offsetLeft || 0;
    const viewportTop = viewport.offsetTop || 0;
    const width = Math.min(Math.max(rect.width, node.offsetWidth), viewport.width - pad * 2);
    node.style.width = width + 'px';
    let left = Math.min(rect.left, viewportLeft + viewport.width - width - pad);
    let top = rect.bottom + 5;
    if (top + node.offsetHeight + pad > viewportTop + viewport.height)
        top = Math.max(viewportTop + pad, rect.top - node.offsetHeight - 5);
    left = Math.max(viewportLeft + pad, left);
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
    node.style.visibility = '';
}

function comboLabel(id, options, value)
{
    const option = options.find(item => item.value === value) || options[0];
    $(id + ' .combo-label').textContent = option?.label || 'Unavailable';
}

function renderHorizonLabel()
{
    const values = new Set(selectedMeters().flatMap(meter => (meter.forecast?.projected || [])
        .map(row => row.minutes).filter(value => Number.isFinite(value) && value > 0)));
    horizons = [...values].sort((a, b) => a - b).map(value => ({ value, label: duration(value) }));
    const owner = $('#horizon-combo');
    owner.disabled = !horizons.length;
    if (!horizons.length) { $('#horizon-combo .combo-label').textContent = 'Unavailable'; return; }
    if (!values.has(state.horizon)) state.horizon = horizons[0].value;
    comboLabel('#horizon-combo', horizons, state.horizon);
}
function renderRangeLabel() { comboLabel('#range-combo', ranges, state.range); }

function openCombo(owner, options, current, onPick)
{
    if (!options.length) return;
    if (popup?.owner === owner) { closePopup(); return; }
    closePopup();
    const list = el('div', 'popup-list');
    list.tabIndex = -1;
    list.id = owner.id + '-list';
    owner.setAttribute('aria-controls', list.id);
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', owner.getAttribute('aria-label') || 'Options');
    let cursor = Math.max(0, options.findIndex(item => item.value === current));
    const nodes = options.map((item, index) => {
        const option = el('div', 'popup-option' + (item.value === current ? ' selected' : ''));
        option.id = owner.id + '-option-' + String(item.value).replace(/[^a-z0-9]/gi, '');
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(item.value === current));
        option.append(el('span', 'tick', '\u2713'), el('span', null, item.label));
        on(option, 'pointerenter', () => setCursor(index));
        on(option, 'click', event => {
            event.stopPropagation();
            closePopup(true);
            onPick(item.value);
        });
        list.append(option);
        return option;
    });
    function setCursor(index)
    {
        cursor = Math.max(0, Math.min(nodes.length - 1, index));
        nodes.forEach((node, position) => node.classList.toggle('cursor', position === cursor));
        list.setAttribute('aria-activedescendant', nodes[cursor].id);
        nodes[cursor].scrollIntoView({ block: 'nearest' });
    }
    on(list, 'keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(cursor + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(cursor - 1); }
        else if (event.key === 'Home') { event.preventDefault(); setCursor(0); }
        else if (event.key === 'End') { event.preventDefault(); setCursor(nodes.length - 1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nodes[cursor].click(); }
        else if (event.key === 'Escape') { event.preventDefault(); closePopup(true); }
        else if (event.key === 'Tab') { closePopup(); owner.focus({ preventScroll: true }); }
    });
    popup = { node: list, owner };
    owner.setAttribute('aria-expanded', 'true');
    placePopup(list, owner);
    setCursor(cursor);
    list.focus();
}

function openHorizonPopup()
{
    openCombo($('#horizon-combo'), horizons, state.horizon, value => {
        state.horizon = value;
        renderHorizonLabel();
        render();
    });
}

function openRangePopup()
{
    openCombo($('#range-combo'), ranges, state.range, value => {
        state.range = value;
        renderRangeLabel();
        load(false);
    });
}

function renderSpark(container, meter)
{
    const history = (meter.history || []).filter(row => Number.isFinite(row.usedPercent) && Number.isFinite(Date.parse(row.observedAt)))
        .slice().sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    if (history.length < 2)
    {
        container.append(el('div', 'empty mono', history.length ? 'Collecting another sample' : 'No history yet'));
        return;
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 240 76');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${meter.label} utilization history`);
    const times = history.map(row => Date.parse(row.observedAt));
    const lo = Math.min(...times), hi = Math.max(...times);
    const points = history.map((row, index) => ({
        x: hi === lo ? index / Math.max(1, history.length - 1) * 240 : (times[index] - lo) / (hi - lo) * 240,
        y: 72 - Math.max(0, Math.min(100, row.usedPercent)) / 100 * 67,
        row,
    }));
    const lineD = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('class', 'area');
    area.setAttribute('d', `${lineD} L240,76 L0,76 Z`);
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', lineD);
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${history.length} samples; ${number(history[0].usedPercent, 2)}% to ${number(history.at(-1).usedPercent, 2)}%`;
    line.append(title);
    const cross = document.createElementNS(ns, 'line');
    cross.setAttribute('class', 'cross');
    cross.setAttribute('y1', '0'); cross.setAttribute('y2', '76');
    const hit = document.createElementNS(ns, 'rect');
    hit.setAttribute('width', '240'); hit.setAttribute('height', '76'); hit.setAttribute('fill', 'transparent');
    on(hit, 'pointermove', event => {
        const liveSvg = event.currentTarget.ownerSVGElement;
        const liveCross = liveSvg.querySelector('.cross');
        const rect = liveSvg.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width * 240;
        const point = points.reduce((best, item) => Math.abs(item.x - x) < Math.abs(best.x - x) ? item : best);
        liveCross.setAttribute('x1', point.x); liveCross.setAttribute('x2', point.x);
        showTip(event, `${new Date(point.row.observedAt).toLocaleString()} · ${number(point.row.usedPercent, 2)}% used`);
    });
    on(hit, 'pointerleave', hideTip);
    svg.append(area, line, cross, hit);
    container.append(svg);
}

function kpi(label, value, sub, accent)
{
    const card = el('article', 'kpi');
    card.style.setProperty('--accent', accent || 'var(--claude)');
    card.append(el('p', 'eyebrow', label), el('div', 'value selectable', value), el('div', 'sub', sub));
    return card;
}

function totalUsage(model) { return (model.contextInputTokens || 0) + (model.outputTokens || 0); }

function renderKpis()
{
    const root = $('#kpis');
    const meters = selectedMeters();
    const models = (state.data?.usage?.models || []).filter(row => state.provider === 'all' || row.provider === state.provider);
    const providers = new Set([...meters, ...models].map(row => row.provider));
    const responses = models.reduce((sum, row) => sum + (row.responses || 0), 0);
    const exactTokens = models.reduce((sum, row) => sum + totalUsage(row), 0);
    const etas = meters.filter(row => row.forecast?.exhaustsBeforeReset && Number.isFinite(row.forecast.etaMinutes))
        .sort((a, b) => a.forecast.etaMinutes - b.forecast.etaMinutes);
    const cachedTokens = models.reduce((sum, row) => sum + (row.cacheReadInputTokens || 0), 0);
    // Filtering to one provider has to re-price from that provider's rows; the
    // whole-window total the router sends covers every provider at once.
    const spend = state.provider === 'all'
        ? (state.data?.usage?.cost || {})
        : models.reduce((sum, row) => ({
            total: (sum.total || 0) + costOf(row),
            cacheRead: (sum.cacheRead || 0) + (row.cost?.cacheRead || 0),
            unpricedResponses: (sum.unpricedResponses || 0) + (row.cost?.unpricedResponses || 0),
        }), {});
    const spendSub = spend.unpricedResponses
        ? `${number(spend.unpricedResponses)} responses have no recorded rate`
        : `${money(spend.cacheRead)} of it is cached input · ${rangeLabel().toLowerCase()}`;
    const nodes = [
        kpi('PROVIDERS WITH DATA', String(providers.size), `${meters.length} featured quota windows`, 'var(--gemini)'),
        kpi('EXACT TOKENS', tokens(exactTokens), `${number(responses)} responses \u00b7 ${rangeLabel().toLowerCase()}`, 'var(--claude)'),
        kpi('NEXT EXHAUSTION', etas.length ? duration(etas[0].forecast.etaMinutes) : 'Not forecast', etas.length ? `${etas[0].accountName} · ${etas[0].label}${Number.isFinite(etas[0].forecast.resetMinutes) ? '' : ' · reset unknown'}` : 'No measured exhaustion forecast available', 'var(--critical)'),
        kpi('CACHE READ TOKENS', tokens(cachedTokens), 'Included in exact input-context totals', 'var(--openai)'),
        kpi(spend.unpricedResponses ? 'API-EQUIVALENT SUBTOTAL' : 'API-EQUIVALENT SPEND', money(spend.total), spendSub, 'var(--warning)'),
    ];
    swapChildren(root, nodes, 'card');
}

function meterCard(meter)
{
    const card = el('article', 'meter-card');
    card.dataset.provider = meter.provider;
    card.dataset.key = meter.key || JSON.stringify([meter.provider, meter.accountId, meter.quotaId, meter.label]);
    card.style.setProperty('--provider', colourOf(meter.provider));
    const top = el('div', 'meter-top');
    const title = el('div', 'meter-title');
    title.append(el('p', 'eyebrow', `${meter.provider} · ${meter.accountName}`), el('strong', null, meter.label));
    top.append(title, el('div', 'meter-percent selectable', percent(meter.usedPercent, meter.usedPercent % 1 ? 2 : 0)));
    const track = el('div', 'track');
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
    if (Number.isFinite(meter.usedPercent)) track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, meter.usedPercent)))); track.setAttribute('aria-label', meter.label);
    const fill = el('i'); fill.style.width = meterWidth(meter.usedPercent) + '%'; track.append(fill);
    const grid = el('div', 'meter-grid');
    const spark = el('div', 'spark'); renderSpark(spark, meter);
    spark.append(el('p', 'chart-caption', meter.history?.some(row => row.samples)
        ? 'Historical summaries · last observation per bucket · 0–100%'
        : 'Recorded utilization · 0–100%'));
    if (meter.history?.length)
    {
        const details = el('details', 'chart-data');
        details.append(el('summary', null, 'History values'));
        const history = el('div', 'history-values');
        for (const sample of meter.history) history.append(el('p', null, `${new Date(sample.observedAt).toLocaleString()} · ${number(sample.usedPercent, 2)}%${sample.samples ? ` · ${number(sample.samples)} observations · range ${number(sample.minPercent, 2)}–${number(sample.maxPercent, 2)}%` : ''}`));
        details.append(history); spark.append(details);
    }
    const copy = el('div', 'forecast-copy');
    const projected = meter.forecast?.projected?.find(row => row.minutes === state.horizon);
    const rows = [
        ['Burn rate', !meter.forecast || meter.forecast.confidence === 'insufficient' ? 'Learning' : meter.forecast.ratePerMinute > 0 ? number(meter.forecast.ratePerMinute, 3) + ' pp/min' : 'No movement'],
        [`In ${duration(state.horizon)}`, meter.forecast?.confidence === 'insufficient' ? 'Learning' : Number.isFinite(meter.forecast?.resetMinutes) && meter.forecast.resetMinutes <= state.horizon ? 'Reset occurs first' : Number.isFinite(projected?.usedPercent) ? number(projected.usedPercent, 1) + '%' : '—'],
        ['Outlook', etaText(meter)],
        ['Confidence', meter.forecast?.confidence || 'insufficient'],
        ['Sample', `${number(meter.forecast?.sampleCount)} observations`],
        ['Updated', age(meter.observedAt)],
    ];
    for (const [label, value] of rows) { const row = el('div', 'metric-line'); row.append(el('span', null, label), el('strong', 'selectable', value)); copy.append(row); }
    grid.append(spark, copy);
    const calibration = el('div', 'callout');
    if (meter.calibration)
    {
        const b = el('b', 'selectable', `1% ≈ ${tokens(meter.calibration.tokensPerPercent)} tokens`);
        calibration.append(b, document.createTextNode(` · observed across ${meter.calibration.responseCount} exact responses and ${number(meter.calibration.observedPercent, 2)} percentage points.`));
    }
    else calibration.textContent = 'Token conversion is waiting for both a quota delta and exact terminal token records in the same interval.';
    card.append(top, track, grid, calibration);
    return card;
}

function renderForecasts()
{
    const root = $('#forecast-grid');
    const rows = selectedMeters().sort((a, b) => a.provider.localeCompare(b.provider) || b.usedPercent - a.usedPercent);
    swapChildren(root, rows.map(meterCard), 'card');
    $('#forecast-empty').hidden = rows.length !== 0;
}

function renderModels()
{
    const root = $('#model-bars');
    const rows = (state.data?.usage?.models || []).filter(row => state.provider === 'all' || row.provider === state.provider)
        .sort((a, b) => totalUsage(b) - totalUsage(a));
    const max = Math.max(1, ...rows.map(totalUsage));
    const total = rows.reduce((sum, row) => sum + totalUsage(row), 0);
    $('#token-total').textContent = tokens(total);
    const nodes = [];
    if (!rows.length) nodes.push(el('p', 'empty', 'Exact token records will appear after the next completed provider response.'));
    for (const row of rows)
    {
        const line = el('div', 'model-row'); line.style.setProperty('--provider', colourOf(row.provider));
        line.dataset.key = JSON.stringify([row.provider, row.model]);
        const label = el('div', 'model-label', row.model || 'Unknown model'); label.title = row.model || 'Unknown model';
        label.append(el('span', null, `${providerLabel(row.provider)} · ${number(row.responses)} responses · ${displayCost(row)}`));
        const track = el('div', 'model-track'); const fill = el('i'); fill.style.width = totalUsage(row) / max * 100 + '%';
        track.title = `${number(row.contextInputTokens)} input-context tokens + ${number(row.outputTokens)} output tokens`;
        track.append(fill);
        line.append(label, track, el('div', 'model-value selectable', tokens(totalUsage(row))));
        nodes.push(line);
    }
    swapChildren(root, nodes, 'item');
}

function rangeLabel()
{
    return (ranges.find(item => item.value === (state.data?.range?.key || state.range)) || ranges.at(-1)).label;
}

function renderRangeNote()
{
    const note = $('#range-note');
    const storage = state.data?.storage;
    const window = state.data?.range;
    const parts = [`Totals cover ${rangeLabel().toLowerCase()}${window?.start && window?.end ? `: ${new Date(window.start).toLocaleString()} to ${new Date(window.end).toLocaleString()}` : ''}.`,
        'Utilization, resets and burn rate stay current provider evidence rather than a historical average.'];
    if (storage && storage.migrationComplete === false) parts.push('Earlier records are still importing.');
    if (storage?.error) parts.push('Accounting error: ' + storage.error);
    if (storage?.backup?.sameVolume === true)
        parts.push('Backups share the store volume, so they cover corruption and overwrite, not disk loss.');
    note.textContent = parts.join(' ');
}

function renderTimeline()
{
    const root = $('#daily-timeline');
    const rows = (state.data?.usage?.dailyTimeline || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const dailyRows = rows.map(row => {
        const tr = el('tr');
        tr.dataset.key = row.date;
        tr.append(el('td', null, row.date), el('td', 'mono', number(row.responses)),
            el('td', 'mono', number(row.contextInputTokens)), el('td', 'mono', number(row.outputTokens)),
            el('td', 'mono', number(totalUsage(row))));
        return tr;
    });
    swapChildren($('#daily-table tbody'), dailyRows.length ? dailyRows : [emptyRow(5, 'No daily records in this range.')]);
    if (!rows.length)
    {
        swapChildren(root, [el('div', 'empty-line', 'Daily totals appear once a completed response is recorded.')], 'item');
        return;
    }
    const max = Math.max(1, ...rows.map(totalUsage));
    const nodes = rows.map(row => {
        const total = totalUsage(row);
        const column = el('div', 'day-column');
        column.dataset.key = row.date;
        const bar = el('button', 'bar');
        bar.type = 'button';
        bar.style.height = total / max * 100 + '%';
        bar.title = `${row.date} \u00b7 ${number(total)} tokens \u00b7 ${number(row.responses)} responses \u00b7 ${money(row.cost?.total)}`;
        bar.setAttribute('aria-label', bar.title);
        on(bar, 'pointerenter', event => showTip(event, bar.title));
        on(bar, 'pointerleave', hideTip);
        on(bar, 'focus', event => { const rect = event.currentTarget.getBoundingClientRect(); showTip({ clientX: rect.left, clientY: rect.top }, event.currentTarget.title); });
        on(bar, 'blur', hideTip);
        const plot = el('div', 'day-plot'); plot.append(bar);
        column.append(el('span', 'day-value', tokens(total)), plot, el('span', 'day-label', row.date.slice(5)));
        return column;
    });
    swapChildren(root, nodes, 'item');
}

function spendRowText(row)
{
    const cost = row.cost || {};
    return [row.provider, row.model, row.responses, cost.input, cost.cacheRead,
        cost.cacheWrite, cost.output, cost.total, cost.unpricedResponses ?? 0]
        .map(value => String(value ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');
}

function renderSpend()
{
    const rows = spendRows();
    const priced = rows.filter(row => row.cost && !row.cost.unpricedResponses);
    const byProvider = new Map();
    for (const row of rows)
        byProvider.set(row.provider, (byProvider.get(row.provider) || 0) + costOf(row));
    const providerRows = [...byProvider.entries()].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1e-9, ...providerRows.map(entry => entry[1]));

    const bars = providerRows.map(([provider, total]) => {
        const line = el('div', 'model-row'); line.style.setProperty('--provider', colourOf(provider));
        line.dataset.key = provider;
        const label = el('div', 'model-label', providerLabel(provider));
        const models = rows.filter(row => row.provider === provider).length;
        label.append(el('span', null, `${models} model${models === 1 ? '' : 's'}`));
        const track = el('div', 'model-track'); const fill = el('i');
        fill.style.width = total / max * 100 + '%';
        track.append(fill);
        const unpriced = rows.filter(row => row.provider === provider).reduce((sum, row) => sum + (row.cost?.unpricedResponses || 0), 0);
        line.append(label, track, el('div', 'model-value selectable', money(total) + (unpriced ? ' + unpriced' : '')));
        return line;
    });
    if (!bars.length) bars.push(el('p', 'empty', 'Spend appears once a priced provider response is recorded.'));
    swapChildren($('#spend-providers'), bars, 'item');

    const body = $('#spend-table tbody');
    const cells = rows.map(row => {
        const cost = row.cost || {};
        const tr = document.createElement('tr');
        tr.dataset.key = JSON.stringify([row.provider, row.model]);
        tr.style.setProperty('--provider', colourOf(row.provider));
        const provider = el('td', 'provider-cell');
        provider.append(providerDot(row.provider), document.createTextNode(providerLabel(row.provider)));
        const model = el('td', 'cell-stack'); model.append(el('span', 'primary-text', row.model || 'Unknown model'));
        if (cost.unpricedResponses) model.append(el('span', 'sub-text', `${number(cost.unpricedResponses)} unpriced responses`));
        tr.append(provider, model,
            el('td', 'mono', number(row.responses)),
            el('td', 'mono', money(cost.input)),
            el('td', 'mono', money(cost.cacheRead)),
            el('td', 'mono', money(cost.cacheWrite)),
            el('td', 'mono', money(cost.output)),
            el('td', 'mono selectable', displayCost(row)));
        return tr;
    });
    swapChildren(body, cells.length ? cells : [emptyRow(8, 'No responses for this provider in this range.')]);

    const pricing = state.data?.usage?.pricing;
    const unpriced = rows.reduce((sum, row) => sum + (row.cost?.unpricedResponses || 0), 0);
    const unpricedModels = [...new Set(rows.filter(row => row.cost?.unpricedResponses).map(row => row.model || 'Unknown model'))];
    const note = ['API-equivalent estimates use the accounting rate table on each record date. These are token-based base-rate estimates, not subscription charges or invoices; request-level pricing tiers and non-token fees may differ.'];
    note.push(`${priced.length} of ${rows.length} models are priced.`);
    if (unpriced) note.push(`${number(unpriced)} responses ran on ${unpricedModels.length} model${unpricedModels.length === 1 ? '' : 's'} with no matching accounting rate and are excluded from the priced subtotal: ${unpricedModels.slice(0, 4).join(', ')}${unpricedModels.length > 4 ? ', …' : ''}.`);
    if (pricing?.fingerprint) note.push(`Price table ${pricing.fingerprint}.`);
    $('#spend-note').textContent = note.join(' ');
}

// One row per rate period, not per model: a model whose price changes on a
// published date renders both windows, which is the point of the card.
const compareProviders = (a, b) => providerLabel(a).localeCompare(providerLabel(b));

function periodText(period)
{
    if (period.from && period.to) return `${period.from} → ${period.to}`;
    if (period.from) return `from ${period.from}`;
    if (period.to) return `before ${period.to}`;
    return 'All recorded dates';
}

function renderRates()
{
    const pricing = state.data?.usage?.pricing || {};
    const rates = pricing.rates || {};
    const rows = Object.entries(rates).filter(([key, periods]) => key.includes('/') && Array.isArray(periods)).map(([key, periods]) => {
        const split = key.indexOf('/');
        return { provider: key.slice(0, split), model: key.slice(split + 1), periods };
    }).filter(row => state.provider === 'all' || row.provider === state.provider)
        .sort((a, b) => compareProviders(a.provider, b.provider) || a.model.localeCompare(b.model));

    const nodes = [];
    for (const { provider, model, periods } of rows)
        for (const period of periods)
        {
            const tr = document.createElement('tr');
            tr.dataset.key = JSON.stringify([provider, model, period.from, period.to]);
            tr.style.setProperty('--provider', colourOf(provider));
            const providerCell = el('td', 'provider-cell');
            providerCell.append(providerDot(provider), document.createTextNode(providerLabel(provider)));
            const modelCell = el('td', 'cell-stack');
            modelCell.append(el('span', 'primary-text selectable', model));
            tr.append(providerCell, modelCell,
                el('td', 'mono selectable', rate(period.input)),
                el('td', 'mono selectable', rate(period.cacheRead)),
                el('td', 'mono selectable', rate(period.cacheWrite5m)),
                el('td', 'mono selectable', rate(period.cacheWrite1h)),
                el('td', 'mono selectable', rate(period.output)),
                el('td', 'mono selectable', periodText(period)));
            nodes.push(tr);
        }
    if (!nodes.length)
    {
        const tr = document.createElement('tr');
        tr.append(el('td', 'empty', 'No published rates recorded.'));
        tr.firstChild.colSpan = 8;
        nodes.push(tr);
    }
    swapChildren($('#rate-table tbody'), nodes, 'row');
    $('#rate-fingerprint').textContent = pricing.fingerprint ? `Table ${pricing.fingerprint}` : '—';
    $('#rate-note').textContent = 'A row prices every response observed while its window was in force, on the record date. '
        + 'These are the base rates supplied by the accounting API. Conditional pricing tiers are not included in this table. An end date is exclusive.';
}

// Optional panel. A provider adapter whose backend reports its own upstream
// billing can decorate the payload with it -- see docs/provider-adapters.md.
// Nothing in the router itself produces this, so with no such adapter loaded
// the section stays hidden rather than rendering an empty table.
function renderGateway()
{
    const wrap = $('#gateway-wrap');
    const ledger = state.data?.gateway || null;
    const accounts = ledger?.accounts || [];
    const provider = ledger?.provider || null;
    const visible = accounts.length && (state.provider === 'all' || state.provider === provider);
    wrap.hidden = !visible;
    if (!visible) return;

    $('#gateway-title').textContent = ledger.label || `${provider || 'Upstream'} attempts`;

    let total = 0;
    const rows = [];
    for (const account of accounts.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))))
        for (const model of (account.models || []).slice().sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)))
        {
            total += model.costUsd || 0;
            rows.push({ account, model });
        }

    $('#gateway-total').textContent = money(total);
    const nodes = rows.map(({ account, model }) => {
        const tr = document.createElement('tr');
        tr.style.setProperty('--provider', colourOf(provider));
        tr.append(el('td', null, account.name || ('Account ' + account.id)),
            el('td', 'primary-text', model.model),
            el('td', 'mono', number(model.requests)),
            el('td', 'mono', tokens(model.inputTokens)),
            el('td', 'mono', tokens(model.cacheReadTokens)),
            el('td', 'mono', tokens(model.outputTokens)),
            el('td', 'mono selectable', money(model.costUsd)));
        return tr;
    });
    swapChildren($('#gateway-table tbody'), nodes, 'row');

    const updated = ledger.updatedAt;
    $('#gateway-note').textContent = 'Counted by the provider itself, not by us: every attempt sent upstream, '
        + 'including retries and cancelled requests. This upstream snapshot has no reporting window and is not filtered by the selected range. '
        + (updated ? `Last read ${age(updated)}.` : 'Not yet read.');
}

function poolPinAccountName(id)
{
    const account = state.poolPin?.accounts?.find(row => row.id === id);
    return account?.name || (Number.isSafeInteger(id) ? `Account ${id}` : 'Unknown account');
}

function renderPoolPin()
{
    const root = $('#pool-pin');
    const pool = state.poolPin;
    const visible = !!pool || !!state.poolPinError;
    root.hidden = !visible;
    if (!visible) { swapChildren(root, []); return; }

    const head = el('div', 'pool-pin-head');
    const copy = el('div');
    copy.append(el('p', 'eyebrow', 'ACCOUNT POOL CONTROL'));
    copy.append(el('h3', null, pool?.label || 'Account pool'));
    let status = 'Control unavailable';
    if (state.poolPinBusy) status = 'Applying…';
    else if (pool?.mode === 'auto') status = pool.applied ? 'Mode: Auto' : 'Auto requested · not verified';
    else if (pool?.mode === 'pinned') status = pool.applied
        ? `Pinned: ${pool.appliedAccountName || poolPinAccountName(pool.appliedAccountId)}`
        : `Target: ${pool.targetAccountName || poolPinAccountName(pool.targetAccountId)} · not verified`;
    head.append(copy, el('span', 'pool-pin-state', status));

    const controls = el('div', 'segmented pool-pin-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', pool?.label || 'Account pool');
    const auto = el('button', null, 'Auto');
    auto.type = 'button';
    auto.dataset.poolPinAction = 'auto';
    auto.disabled = state.poolPinBusy;
    auto.setAttribute('aria-pressed', String(pool?.mode === 'auto' && pool?.applied === true));
    if (pool?.mode === 'auto' && pool?.applied === false) auto.classList.add('target');
    controls.append(auto);

    for (const account of pool?.accounts || [])
    {
        const button = el('button', null, account.name || `Account ${account.id}`);
        button.type = 'button';
        button.dataset.poolPinAction = 'pin';
        button.dataset.accountId = String(account.id);
        button.disabled = state.poolPinBusy;
        const active = pool.applied === true && pool.appliedAccountId === account.id;
        button.setAttribute('aria-pressed', String(active));
        if (!active && pool.targetAccountId === account.id) button.classList.add('target');
        button.title = `${account.schedulable ? 'Schedulable' : 'Paused'}${account.status ? ` · ${account.status}` : ''}`;
        controls.append(button);
    }

    const nodes = [head, controls];
    const message = pool?.error?.message || state.poolPinError;
    if (message)
    {
        let prefix = 'Pool control failed';
        if (pool?.mode === 'pinned' && pool?.applied !== true) prefix = 'Pin failed — pool was not verified';
        else if (pool?.mode === 'auto' && pool?.applied !== true) prefix = 'Auto restore failed — original pool state was not verified';
        nodes.push(el('p', 'pool-pin-error', `${prefix}. ${message}`));
    }
    swapChildren(root, nodes);
}

async function fetchPoolPin()
{
    try
    {
        const response = await fetch('/poolpinz', { cache: 'no-store' });
        if (response.status === 501)
        {
            state.poolPin = null;
            state.poolPinError = null;
            renderPoolPin();
            return null;
        }
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new Error(value?.error?.message || `Pool control returned ${response.status}`);
        if (!value || !Array.isArray(value.accounts)) throw new Error('Invalid pool control status');
        state.poolPin = value;
        state.poolPinError = null;
    }
    catch (error)
    {
        state.poolPinError = String(error?.message || error);
    }
    renderPoolPin();
    return state.poolPin;
}

async function setPoolPin(action, id = null)
{
    if (state.poolPinBusy) return;
    state.poolPinBusy = true;
    state.poolPinError = null;
    renderPoolPin();
    let postError = null;
    try
    {
        const body = action === 'pin' ? { action, id } : { action: 'auto' };
        const response = await fetch('/poolpinz', {
            method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new Error(value?.error?.message || `Pool control returned ${response.status}`);
        if (value && Array.isArray(value.accounts)) state.poolPin = value;
    }
    catch (error)
    {
        postError = String(error?.message || error);
        state.poolPinError = postError;
    }

    await fetchPoolPin();
    if (postError && !state.poolPin?.error) state.poolPinError = postError;
    state.poolPinBusy = false;
    renderPoolPin();
}

function renderSources()
{
    const nodes = [];
    for (const provider of providersPresent().filter(provider => state.provider === 'all' || provider === state.provider))
    {
        const source = state.data?.sources?.[provider] || {};
        const row = el('div', 'source' + (source.error ? ' error' : !source.observedAt ? ' unknown' : ''));
        row.dataset.key = provider;
        row.append(el('i'));
        const text = el('div');
        text.append(el('strong', null, providerLabel(provider)),
            el('span', 'selectable', source.error || `${source.source || 'No quota source reported'} · ${source.observedAt ? age(source.observedAt) : 'no snapshot'}`));
        row.append(text); nodes.push(row);
    }
    swapChildren($('#sources'), nodes.length ? nodes : [el('p', 'empty', 'No data sources reported.')]);
}

function etaText(meter)
{
    const forecast = meter.forecast || {};
    if (Number.isFinite(meter.usedPercent) && meter.usedPercent >= 100) return 'Quota exhausted';
    if (forecast.exhaustsBeforeReset && Number.isFinite(forecast.etaMinutes))
        return 'Exhausts in ' + duration(forecast.etaMinutes) + (Number.isFinite(forecast.resetMinutes) ? '' : ' · reset unknown');
    if (Number.isFinite(forecast.resetMinutes)) return 'Resets ' + (forecast.resetMinutes > 0 ? 'in ' : '') + duration(forecast.resetMinutes);
    if (!meter.forecast || forecast.confidence === 'insufficient') return 'Learning · reset unknown';
    return 'No movement · reset unknown';
}

function meterRowText(meter)
{
    return [
        meter.provider,
        meter.accountName,
        meter.schedulable ? (meter.aggregate ? 'Aggregate' : (meter.tier || 'Active')) : 'Not schedulable',
        meter.label,
        meter.model || '',
        meter.usedPercent ?? '',
        meter.forecast?.ratePerMinute ?? '',
        etaText(meter),
        meter.calibration?.tokensPerPercent || '',
        meter.resetAt || '',
        meter.observedAt || '',
    ].map(value => String(value).replace(/[\t\r\n]+/g, ' ')).join('\t');
}

function accountRows()
{
    const query = state.accountQuery.trim().toLocaleLowerCase();
    return selectedMeters(true).filter(row => !query || [providerLabel(row.provider), row.accountName, row.label, row.model, row.tier]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
        .sort((a, b) => compareProviders(a.provider, b.provider) || String(a.accountName || '').localeCompare(String(b.accountName || ''))
            || Number(b.aggregate) - Number(a.aggregate) || String(a.label || '').localeCompare(String(b.label || '')));
}

function renderMetersTable()
{
    const body = $('#meters-table tbody');
    body.classList.toggle('compact', state.compact);
    const rows = accountRows();
    $('#account-count').textContent = `${number(rows.length)} of ${number(selectedMeters(true).length)} windows`;
    const nodes = rows.map(meter => {
        const tr = document.createElement('tr'); tr.style.setProperty('--provider', colourOf(meter.provider));
        tr.dataset.key = meter.key || JSON.stringify([meter.provider, meter.accountId, meter.quotaId, meter.label]);
        const provider = el('td'); const pc = el('span', 'provider-cell'); pc.append(providerDot(meter.provider), document.createTextNode(providerLabel(meter.provider))); provider.append(pc);

        const account = el('td');
        const accountStack = el('div', 'cell-stack');
        const accountName = el('div', 'primary-text selectable', meter.accountName); accountName.title = meter.accountName;
        let badgeClass = 'status-badge';
        let badgeText = meter.tier || 'Active';
        if (!meter.schedulable) { badgeClass += ' off'; badgeText = 'Not schedulable'; }
        else if (meter.aggregate) { badgeClass += ' aggregate'; badgeText = 'Aggregate'; }
        accountStack.append(accountName, el('div', badgeClass, badgeText)); account.append(accountStack);

        const window = el('td');
        const windowStack = el('div', 'cell-stack');
        const windowName = el('div', 'primary-text selectable', meter.label); windowName.title = meter.label; windowStack.append(windowName);
        if (meter.model && meter.label !== meter.model) { const model = el('div', 'sub-text selectable', meter.model); model.title = meter.model; windowStack.append(model); }
        window.append(windowStack);

        const used = el('td', 'percent-cell');
        const usedHead = el('div', 'used-head');
        usedHead.append(el('span', 'used-value selectable', percent(meter.usedPercent)),
            el('span', 'left-value selectable', percent(Number.isFinite(meter.remainingFraction) ? Math.max(0, Math.min(1, meter.remainingFraction)) * 100 : Number.isFinite(meter.usedPercent) ? 100 - meterWidth(meter.usedPercent) : null) + ' left'));
        const mini = el('span', 'mini-track'); const fill = el('i'); fill.style.width = meterWidth(meter.usedPercent) + '%'; mini.append(fill); used.append(usedHead, mini);

        const rateCell = el('td', 'mono selectable', meter.forecast?.ratePerMinute > 0 ? number(meter.forecast.ratePerMinute, 4) + ' pp/min' : '—');
        const eta = el('td'); const etaStack = el('div', 'cell-stack'); etaStack.append(el('div', 'primary-text', etaText(meter)));
        if (meter.resetAt)
        {
            const reset = new Date(meter.resetAt);
            etaStack.append(el('div', 'sub-text selectable', `${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${reset.toLocaleDateString()}`));
        }
        eta.append(etaStack);
        const calibration = el('td', 'mono selectable', meter.calibration ? '≈' + tokens(meter.calibration.tokensPerPercent) + ' tokens' : 'Learning');
        const fresh = el('td', 'mono selectable', age(meter.observedAt));
        const action = el('td');
        const copy = el('button', 'row-copy-btn', '⧉'); copy.type = 'button'; copy.title = 'Copy row';
        copy.setAttribute('aria-label', `Copy ${meter.accountName} ${meter.label}`);
        on(copy, 'click', event => {
            event.stopPropagation();
            copyText(meterRowText(meter), `Copied ${meter.accountName}`, event.currentTarget);
        });
        action.append(copy);
        tr.append(provider, account, window, used, rateCell, eta, calibration, fresh, action);
        return tr;
    });
    swapChildren(body, nodes.length ? nodes : [emptyRow(9, 'No quota windows reported for this provider.')]);
}

function renderEvents()
{
    const rows = [...(state.data?.usage?.recent || [])].filter(row => state.provider === 'all' || row.provider === state.provider).reverse();
    $('#event-count').textContent = `${rows.length} recent records`;
    const nodes = rows.map(event => {
        const tr = document.createElement('tr');
        tr.dataset.key = JSON.stringify([event.provider, event.responseId, event.observedAt, event.sessionId]);
        const session = event.sessionId || '—';
        tr.append(
            el('td', 'mono selectable', new Date(event.observedAt).toLocaleString()),
            el('td', null, event.provider), el('td', 'selectable', event.servedModel), el('td', 'mono selectable', session),
            el('td', 'mono selectable', number(event.tokens?.contextInputTokens)), el('td', 'mono selectable', number(event.tokens?.outputTokens)),
            el('td', 'mono selectable', event.tokens?.reasoningOutputTokens === null ? 'not detailed' : number(event.tokens?.reasoningOutputTokens)),
            el('td', 'mono selectable', event.source)
        );
        return tr;
    });
    swapChildren($('#events-table tbody'), nodes.length ? nodes : [emptyRow(8, 'No recent responses for this provider in this range.')]);
}

// Discover live and historical providers from the payload. Presentation names
// and colours never decide whether a provider gets a filter.
function providersPresent()
{
    const seen = new Set();
    for (const row of state.data?.meters || []) if (row.provider) seen.add(row.provider);
    for (const row of state.data?.usage?.models || []) if (row.provider) seen.add(row.provider);
    for (const row of state.data?.usage?.recent || []) if (row.provider) seen.add(row.provider);
    for (const provider of Object.keys(state.data?.sources || {})) seen.add(provider);
    if (state.data?.gateway?.provider) seen.add(state.data.gateway.provider);
    for (const key of Object.keys(state.data?.usage?.pricing?.rates || {})) if (key.includes('/')) seen.add(key.slice(0, key.indexOf('/')));
    return [...seen].sort((a, b) => compareProviders(a, b));
}

function renderProviderFilter()
{
    const present = providersPresent();
    // A selection whose provider stopped appearing would filter everything to
    // nothing with no way back except a reload.
    if (state.provider !== 'all' && !present.includes(state.provider)) state.provider = 'all';

    const nodes = [];
    const all = el('button', null, 'All');
    all.type = 'button';
    all.dataset.provider = 'all';
    all.setAttribute('aria-pressed', String(state.provider === 'all'));
    nodes.push(all);

    for (const provider of present)
    {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.provider = provider;
        button.setAttribute('aria-pressed', String(state.provider === provider));
        button.append(providerDot(provider), document.createTextNode(providerLabel(provider)));
        nodes.push(button);
    }
    swapChildren($('#provider-filter'), nodes, 'tab');
}

function renderLegend()
{
    const providers = [...new Set(selectedMeters().map(row => row.provider).filter(Boolean))]
        .sort((a, b) => compareProviders(a, b));
    const nodes = providers.map(provider => {
        const span = document.createElement('span');
        span.dataset.key = provider;
        span.append(providerDot(provider), document.createTextNode(providerLabel(provider)));
        return span;
    });
    swapChildren($('#forecast-legend'), nodes, 'legend');
}

function render()
{
    if (!state.data) return;
    renderProviderFilter(); renderLegend(); renderHorizonLabel();
    renderKpis(); renderForecasts(); renderModels(); renderTimeline();
    renderSpend(); renderGateway(); renderRates(); renderPoolPin();
    renderSources(); renderMetersTable(); renderEvents();
    renderRangeNote();
    $('#generated').textContent = 'Generated ' + new Date(state.data.generatedAt).toLocaleString();
}

async function load(force = false)
{
    if (force && state.loading) return;
    void fetchPoolPin();
    const generation = ++requestGeneration;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    state.loading = true;
    const status = $('#status');
    status.className = 'status';
    status.lastChild.textContent = force ? 'Refreshing upstream' : 'Loading snapshot';
    $('#refresh').disabled = true;
    $('#refresh').classList.add('loading');
    $('#main').setAttribute('aria-busy', 'true');
    try
    {
        const query = new URLSearchParams({ range: state.range, tz_offset: String(new Date().getTimezoneOffset()) });
        if (force) query.set('force', '1');
        const response = await fetch('/usage/api?' + query.toString(), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Router returned ' + response.status);
        const data = await response.json();
        if (generation !== requestGeneration) return;
        if (!data || !Array.isArray(data.meters) || !Array.isArray(data.usage?.models)) throw new Error('Invalid usage snapshot');
        state.data = data;
        state.range = data.range?.key || state.range;
        renderRangeLabel();
        status.className = 'status live';
        status.lastChild.textContent = 'Snapshot loaded · auto ' + REFRESH_MS / 1000 + 's';
        status.title = 'Snapshot fetched successfully. Individual source freshness is shown below.';
        $('#load-error').hidden = true;
        document.querySelectorAll('.copy-action').forEach(button => { button.disabled = false; });
        render();
    }
    catch (error)
    {
        if (generation !== requestGeneration) return;
        status.className = 'status error';
        status.lastChild.textContent = state.data ? 'Stale snapshot' : 'Unavailable';
        const notice = $('#load-error');
        notice.textContent = (controller.signal.aborted ? 'Snapshot request timed out.' : error.message)
            + (state.data ? ' Showing the last successful snapshot.' : ' Retry with Refresh.');
        notice.hidden = false;
        if (state.data) { state.range = state.data.range?.key || state.range; renderRangeLabel(); }
    }
    finally
    {
        clearTimeout(timeout);
        if (generation === requestGeneration)
        {
            state.loading = false;
            $('#refresh').disabled = false;
            $('#refresh').classList.remove('loading');
            $('#main').setAttribute('aria-busy', 'false');
        }
    }
}

function copyMeters(format, button)
{
    const rows = accountRows();
    if (format === 'json') copyText(JSON.stringify(rows, null, 2), 'Copied account data as JSON', button);
    else
    {
        const header = ['Provider','Account','Status','Window','Model','Used %','Rate pp/min','ETA','Tokens per 1%','Reset at','Observed at'].join('\t');
        copyText([header, ...rows.map(meterRowText)].join('\n'), 'Copied account data as TSV', button);
    }
}

function copySpend(format, button)
{
    const rows = spendRows();
    if (format === 'json') return copyText(JSON.stringify(rows, null, 2), 'Copied spend as JSON', button);
    const header = ['Provider', 'Model', 'Responses', 'Input USD', 'Cache read USD', 'Cache write USD', 'Output USD', 'Priced subtotal USD', 'Unpriced responses'].join('\t');
    return copyText([header, ...rows.map(spendRowText)].join('\n'), 'Copied spend as TSV', button);
}

function toggleTheme()
{
    const dark = document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const apply = () => {
        document.documentElement.dataset.theme = dark ? 'light' : 'dark';
        try { localStorage.setItem('usage-atlas-theme', document.documentElement.dataset.theme); } catch (_) {}
    };
    if (!motionDisabled() && document.startViewTransition) document.startViewTransition(apply);
    else apply();
}

let auditMotion = null;
function toggleAudit(event)
{
    event.preventDefault();
    const details = $('#audit-details');
    const content = details.querySelector('.raw-content');
    const open = !(auditMotion ? auditMotion.open : details.open);
    const height = details.open ? content.getBoundingClientRect().height : 0;
    if (auditMotion) { clearTimeout(auditMotion.timer); auditMotion.animation.cancel(); auditMotion = null; }
    if (motionDisabled()) { details.open = open; return; }
    details.open = true;
    const animation = content.animate([
        { height: height + 'px', opacity: open ? 0 : 1, transform: 'translateY(0)' },
        { height: (open ? content.scrollHeight : 0) + 'px', opacity: open ? 1 : 0, transform: open ? 'none' : 'translateY(-6px)' },
    ], { duration: open ? 230 : 170, easing: 'cubic-bezier(.2,.85,.3,1)', fill: 'both' });
    const motion = { animation, open, timer: null };
    auditMotion = motion;
    const finish = () => {
        if (auditMotion !== motion) return;
        clearTimeout(motion.timer);
        details.open = open;
        auditMotion = null;
        animation.cancel();
    };
    animation.finished.then(finish, () => {});
    motion.timer = setTimeout(finish, 350);
}

$('#provider-filter').addEventListener('click', event => {
    const button = event.target.closest('button[data-provider]');
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    state.provider = button.dataset.provider;
    render();
});
$('#horizon-combo').addEventListener('click', event => { event.stopPropagation(); openHorizonPopup(); });
$('#horizon-combo').addEventListener('keydown', event => {
    if (['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); openHorizonPopup(); }
});
$('#range-combo').addEventListener('click', event => { event.stopPropagation(); openRangePopup(); });
$('#range-combo').addEventListener('keydown', event => {
    if (['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); openRangePopup(); }
});
$('#refresh').addEventListener('click', () => load(true));
$('#account-search').addEventListener('input', event => {
    state.accountQuery = event.target.value;
    renderMetersTable();
});
$('#density').addEventListener('click', event => {
    state.compact = !state.compact;
    event.currentTarget.textContent = state.compact ? 'Comfortable rows' : 'Compact rows';
    renderMetersTable();
});
$('#pool-pin').addEventListener('click', event => {
    let button = event.target;
    while (button && button !== event.currentTarget && button.tagName !== 'BUTTON') button = button.parentElement;
    if (!button || button === event.currentTarget || state.poolPinBusy) return;
    const action = button.dataset.poolPinAction;
    if (action === 'auto') void setPoolPin('auto');
    else if (action === 'pin')
    {
        const id = Number(button.dataset.accountId);
        if (Number.isSafeInteger(id) && id > 0) void setPoolPin('pin', id);
    }
});
$('#theme').addEventListener('click', toggleTheme);
$('#copy-snapshot').addEventListener('click', event => copyText(JSON.stringify(state.data, null, 2), 'Copied dashboard snapshot', event.currentTarget));
$('#copy-meters-tsv').addEventListener('click', event => copyMeters('tsv', event.currentTarget));
$('#copy-meters-json').addEventListener('click', event => copyMeters('json', event.currentTarget));
$('#copy-spend-tsv').addEventListener('click', event => copySpend('tsv', event.currentTarget));
$('#copy-spend-json').addEventListener('click', event => copySpend('json', event.currentTarget));
$('#copy-events-json').addEventListener('click', event => {
    copyText(JSON.stringify((state.data?.usage?.recent || []).filter(row => state.provider === 'all' || row.provider === state.provider).slice().reverse(), null, 2), 'Copied audit trail as JSON', event.currentTarget);
});
$('#audit-details summary').addEventListener('click', toggleAudit);

document.addEventListener('pointerdown', event => {
    if (!popup) return;
    const path = event.composedPath();
    if (!path.includes(popup.node) && !path.includes(popup.owner)) closePopup();
}, true);
document.addEventListener('keydown', event => {
    const editable = event.target.closest?.('input,textarea,[contenteditable="true"],.selectable');
    if (event.key === 'Escape' && popup) { event.preventDefault(); closePopup(true); return; }
    if (event.key.toLowerCase() === 'r' && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !editable) load(true);
});
window.addEventListener('resize', () => closePopup(), { passive: true });
window.addEventListener('scroll', event => { hideTip(); if (popup && !popup.node.contains(event.target)) closePopup(); }, { passive: true, capture: true });
window.addEventListener('pageshow', () => document.body.classList.remove('page-exit'));
let savedTheme;
try { savedTheme = localStorage.getItem('usage-atlas-theme'); } catch (_) {}
if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
renderHorizonLabel();
renderRangeLabel();
const armPageEntry = () => { if (!document.hidden) document.body.classList.add('ready'); };
armPageEntry();
document.addEventListener('visibilitychange', armPageEntry);
document.querySelectorAll('.copy-action').forEach(button => { button.disabled = true; });
document.querySelector('a[href="#audit-details"]').addEventListener('click', () => { $('#audit-details').open = true; });
load();
setInterval(() => { if (!document.hidden && !state.loading) load(false); }, REFRESH_MS);
