'use strict';

const REGION = '[data-epitaxy-transcript-region]';
const TIME = 'time[data-cds="RelativeTime"]';
const ROW = '[data-testid="transcript-row"]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60]];
const narrowStyles = new Map();
let minusPattern;

// Port of fv in the pinned shared-4-DKPmNySq.js RelativeTime module.
function nativeStyle(locale, style) {
    if (style !== 'narrow') return style;
    let value = narrowStyles.get(locale);
    if (value === undefined) {
        const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
        minusPattern ||= /^[+−\p{Pd}]/u;
        value = UNITS.some(([unit]) => minusPattern.test(format.format(-5, unit).trim())) ? 'short' : 'narrow';
        narrowStyles.set(locale, value);
    }
    return value;
}

function formatRelativeTime(date, now, locale, justNowLabel, style, numeric) {
    const resolvedStyle = nativeStyle(locale, style);
    const seconds = Math.round((date.getTime() - now) / 1000);
    const distance = Math.abs(seconds);
    if (distance < 60) {
        if (justNowLabel !== undefined) return justNowLabel;
        const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: resolvedStyle });
        return resolvedStyle === 'long' && format.resolvedOptions().locale.toLowerCase().startsWith('en')
            ? 'just now' : format.format(0, 'second');
    }
    const format = new Intl.RelativeTimeFormat(locale, { numeric, style: resolvedStyle });
    let unit = 'minute', divisor = 60;
    for (const [candidate, threshold] of UNITS) {
        if (distance >= threshold) { unit = candidate; divisor = threshold; break; }
    }
    return format.format(Math.round(seconds / divisor), unit);
}

const regions = new Map();
let states = new WeakMap();
const touched = new Set();
let screenPath = location.pathname;
const sessionByPath = new Map();
if (cuimod.sessionId) sessionByPath.set(screenPath, cuimod.sessionId);
let epoch = 0;
let dirtyAt = 0;
let resolving = false;
let disposed = false;
let lastReport = '';

function currentSession() {
    if (!/\/epitaxy\/local_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/|$)/i.test(location.pathname)) return null;
    return sessionByPath.get(location.pathname) === cuimod.sessionId ? cuimod.sessionId : null;
}

function times() {
    const nodes = [];
    for (const region of document.querySelectorAll(REGION)) {
        for (const node of region.querySelectorAll(TIME)) {
            if (node.closest(ROW)) nodes.push(node);
        }
    }
    return nodes;
}

function schedule() { if (!dirtyAt) dirtyAt = Date.now() + 250; }

function attachRegions() {
    for (const [region, observer] of regions) {
        if (region.isConnected) continue;
        observer.disconnect();
        regions.delete(region);
    }
    for (const region of document.querySelectorAll(REGION)) {
        if (regions.has(region)) continue;
        regions.set(region, ctx.observe(region, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['datetime', 'data-cuimod-msg'],
        }, schedule));
        schedule();
    }
}

function resetScreen() {
    if (screenPath === location.pathname) return;
    screenPath = location.pathname;
    epoch += 1;
    states = new WeakMap();
    touched.clear();
    lastReport = '';
    schedule();
    cuimod.rpc('message-time.report', { sessionId: null, rows: [] }).catch(() => {});
}

function stateFor(node) {
    const uuid = node.getAttribute('data-cuimod-msg');
    const datetime = node.getAttribute('datetime');
    let state = states.get(node);
    if (!state || state.uuid !== uuid) {
        state = { uuid, nativeIso: datetime, iso: null, appliedIso: null,
            text: null, reactTextTicks: 0, lastReactTextAt: null, retryAt: 0 };
        states.set(node, state);
        return { state, lookup: true };
    }
    if (datetime !== state.appliedIso && datetime !== state.nativeIso) {
        state.nativeIso = datetime;
        state.iso = null;
        return { state, lookup: true };
    }
    if (state.appliedIso && datetime === state.nativeIso && datetime !== state.appliedIso) {
        return { state, lookup: true };
    }
    return { state, lookup: !state.iso && Date.now() >= state.retryAt };
}

function apply(node, state) {
    if (!state.iso || !node.isConnected || node.getAttribute('data-cuimod-msg') !== state.uuid) return;
    const current = node.getAttribute('datetime');
    if (current !== state.iso) node.setAttribute('datetime', state.iso);
    const locale = document.documentElement.lang || navigator.language || 'en-US';
    const label = formatRelativeTime(new Date(state.iso), Date.now(), locale, undefined, 'long', 'auto');
    if (node.textContent !== label) {
        if (state.text !== null && node.textContent !== state.text) {
            state.reactTextTicks += 1;
            state.lastReactTextAt = new Date().toISOString();
        }
        node.textContent = label;
    }
    state.text = label;
    state.appliedIso = state.iso;
    if (state.nativeIso !== state.iso) touched.add(node);
}

function report(nodes, sessionId) {
    const rows = [];
    for (const node of nodes) {
        const state = states.get(node);
        const uuid = node.getAttribute('data-cuimod-msg');
        if (!state || !UUID.test(uuid || '')) continue;
        rows.push({ uuid, nativeIso: state.nativeIso, jsonlIso: state.iso,
            datetime: node.getAttribute('datetime'),
            applied: !!state.iso && state.nativeIso !== state.iso && node.getAttribute('datetime') === state.iso,
            reactTextTicks: state.reactTextTicks, lastReactTextAt: state.lastReactTextAt });
    }
    const key = JSON.stringify({ screenPath, sessionId, rows });
    if (key === lastReport) return;
    lastReport = key;
    cuimod.rpc('message-time.report', { sessionId, rows }).catch(() => { lastReport = ''; });
}

async function resolve(nodes, sessionId) {
    if (resolving) return;
    resolving = true;
    const ownedEpoch = epoch;
    try {
        const values = await cuimod.rpc('message-time.resolve', { sessionId });
        if (disposed || epoch !== ownedEpoch || sessionId !== currentSession() || !Array.isArray(values)) return;
        const byUuid = new Map(values.filter((row) => UUID.test(row?.uuid || '')
            && typeof row.iso === 'string' && !Number.isNaN(Date.parse(row.iso)))
            .map((row) => [row.uuid, row.iso]));
        for (const node of times()) {
            const { state } = stateFor(node);
            const iso = byUuid.get(state.uuid);
            if (!iso) { state.retryAt = Date.now() + 3000; continue; }
            state.iso = iso;
            apply(node, state);
        }
        report(times(), sessionId);
    } catch (_) { /* A missing session file or page-world transition leaves native UI intact. */ }
    finally { resolving = false; }
}

function scan() {
    resetScreen();
    const sessionId = currentSession();
    if (!sessionId) return;
    const nodes = times();
    if (!nodes.length) return;
    let needsResolve = false;
    for (const node of nodes) {
        const { state, lookup } = stateFor(node);
        if (lookup) needsResolve = true;
        else apply(node, state);
    }
    if (needsResolve) resolve(nodes, sessionId);
    else report(nodes, sessionId);
}

ctx.every(125, () => {
    if (!dirtyAt || Date.now() < dirtyAt) return;
    dirtyAt = 0;
    scan();
});
ctx.every(1000, () => {
    resetScreen();
    attachRegions();
    if (currentSession()) schedule();
});
ctx.every(30000, () => {
    if (currentSession()) scan();
});
const unsubscribe = cuimod.onSessionChange((sessionId) => {
    resetScreen();
    if (sessionId) sessionByPath.set(screenPath, sessionId);
    else sessionByPath.delete(screenPath);
    epoch += 1;
    states = new WeakMap();
    touched.clear();
    lastReport = '';
    schedule();
});
ctx.onDispose(() => {
    disposed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
    for (const node of touched) {
        const state = states.get(node);
        if (!state || !node.isConnected || node.getAttribute('data-cuimod-msg') !== state.uuid) continue;
        if (node.getAttribute('datetime') === state.appliedIso && state.nativeIso !== null)
            node.setAttribute('datetime', state.nativeIso);
    }
    touched.clear();
});
attachRegions();
schedule();
