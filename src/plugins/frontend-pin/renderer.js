/* claude-ui-mod :: frontend-pin (renderer)
 *
 * Runs a non-executing module-preload canary through the main-process release
 * gate and reports when the pinned composer has mounted. The dashboard control is an
 * immediate kill switch; disabling it leaves the current page alone and permits
 * the server-selected frontend on the next document load.
 */
'use strict';

const DEFAULTS = { enabled: true };
const ASSET_ROOT = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/';
let pinnedEntry = null;
let pinnedStylesheets = {};
const SHEET_FAMILIES = [
    [/^shared-frame-[A-Za-z0-9_-]+\.css$/, 'frame'],
    [/^shared-styles-[A-Za-z0-9_-]+\.css$/, 'shared'],
    [/^cf1a02a1a-[A-Za-z0-9_-]+\.css$/, 'app'],
    [/^c6a992d55-[A-Za-z0-9_-]+\.css$/, 'utility'],
];
let enabled = DEFAULTS.enabled;
let settingsApplied = false;
let statusBusy = false;
let statusFailures = 0;
let statusTick = 0;
let warningHost = null;
let warningText = null;
let standaloneSettings = false;
let canaryBusy = false;
let canaryDone = false;
let canaryNode = null;
let canaryDeadline = 0;
let canaryToken = null;
let healthSent = false;
let disposed = false;

function removeCanary() {
    if (canaryNode) {
        try { canaryNode.remove(); } catch (_) {}
    }
    canaryNode = null;
    canaryDeadline = 0;
    canaryToken = null;
}

async function finishCanary(ok) {
    const token = canaryToken;
    removeCanary();
    if (!token || disposed) return;
    try {
        const result = await cuimod.rpc('frontend-pin.finishCanary', { token, ok });
        canaryDone = result?.ok === true || result?.failed === true;
    } catch (_) {
        canaryDone = false;
    } finally {
        canaryBusy = false;
    }
}

async function startCanary() {
    if (disposed || !settingsApplied || !enabled || canaryBusy || canaryDone) return;
    canaryBusy = true;
    try {
        const result = await cuimod.rpc('frontend-pin.beginCanary');
        if (disposed || !enabled) return;
        if (!result?.ready) {
            if (result?.failed) canaryDone = true;
            return;
        }
        if (result.passed) {
            canaryDone = true;
            return;
        }
        if (typeof result.url !== 'string' || typeof result.token !== 'string') return;
        const link = document.createElement('link');
        link.rel = 'modulepreload';
        link.crossOrigin = 'anonymous';
        link.href = result.url;
        canaryNode = link;
        canaryToken = result.token;
        canaryDeadline = Date.now() + 30000;
        (document.head || document.documentElement).appendChild(link);
    } catch (_) {
        // Host generations overlap briefly; the next interval retries.
    } finally {
        if (!canaryNode) canaryBusy = false;
    }
}

function showWarning(message) {
    if (!message || !enabled || !/^\/epitaxy(?:\/|$)/.test(location.pathname)) {
        if (warningHost) warningHost.remove();
        warningHost = null;
        warningText = null;
        return;
    }
    if (warningHost && !warningHost.isConnected) { warningHost = null; warningText = null; }
    if (!warningHost) {
        document.getElementById('cuimod-frontend-warning')?.remove();
        warningHost = document.createElement('div');
        warningHost.id = 'cuimod-frontend-warning';
        const shadow = warningHost.attachShadow({ mode: 'open' });
        const css = ':host{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;width:max-content;max-width:min(640px,calc(100vw - 32px));overflow-wrap:anywhere;font:13px/1.4 system-ui;color:hsl(var(--text-100));}div{padding:10px 14px;border-radius:8px;background:hsl(var(--bg-100));border:1px solid color-mix(in srgb,hsl(var(--text-100)) 25%,transparent);box-shadow:0 4px 20px #0004;}';
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            shadow.adoptedStyleSheets = [sheet];
        } catch (_) {
            const style = document.createElement('style');
            style.textContent = css;
            shadow.appendChild(style);
        }
        warningText = document.createElement('div');
        warningText.setAttribute('role', 'alert');
        shadow.appendChild(warningText);
        (document.body || document.documentElement).appendChild(warningHost);
    }
    warningText.textContent = message;
}

async function refreshStatus() {
    if (statusBusy || disposed) return;
    statusBusy = true;
    try {
        const status = await cuimod.rpc('frontend-pin.status');
        if (disposed || typeof status?.enabled !== 'boolean') return;
        statusFailures = 0;
        pinnedEntry = status.pinnedEntry;
        pinnedStylesheets = status.pinnedStylesheets || {};
        if (standaloneSettings && !settingsApplied) {
            enabled = status.enabled;
            settingsApplied = true;
        }
        const error = status.failed || (!status.ready && status.lastError);
        const livePage = document.readyState === 'complete' && document.querySelector('.epitaxy-prompt') && !pinnedPage();
        showWarning(error ? 'Unsupported Code frontend: ' + error
            : livePage ? 'Frontend pin is armed. This page is still on the live release; reload Code when convenient to use the bundled frontend.' : null);
        const release = spec.controls.find((control) => control.key === 'release');
        const label = pinnedEntry ? pinnedEntry.slice(pinnedEntry.lastIndexOf('/') + 1) + ' · ' + status.bundledAssets + ' bundled assets' : 'Bundle unavailable';
        if (release.text !== label) {
            release.text = label;
            REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
        }
        pinStylesheets();
        if (enabled) void startCanary();
    } catch (_) {
        if (!disposed && ++statusFailures >= 3) showWarning('Frontend pin status is unavailable. Code frontend compatibility is unverified.');
    } finally {
        statusBusy = false;
    }
}

function reportHealth() {
    if (disposed || healthSent || !document.querySelector('.epitaxy-prompt')) return;
    healthSent = true;
    cuimod.rpc('frontend-pin.healthy', { ready: true, timeOrigin: performance.timeOrigin })
        .then((accepted) => { if (!accepted) healthSent = false; })
        .catch(() => { healthSent = false; });
}

// Vite's loader used to skip these sheets because the document already linked
// their live URLs; the rewritten document links the pinned URLs instead, so a
// live chunk's copy is pointed back at the pinned file here.
function pinnedPage() {
    return !!pinnedEntry && !!document.querySelector('script[src="' + pinnedEntry + '"]');
}

function pinStylesheets() {
    if (disposed || !enabled || !pinnedPage()) return;
    for (const node of document.querySelectorAll('link[rel="stylesheet"][href]')) {
        const href = String(node.href || '');
        if (!href.startsWith(ASSET_ROOT)) continue;
        const name = href.slice(ASSET_ROOT.length).replace(/[?#].*$/, '');
        for (const [pattern, key] of SHEET_FAMILIES) {
            const twin = pinnedStylesheets[key];
            if (twin && pattern.test(name) && href !== twin) { node.href = twin; break; }
        }
    }
}

ctx.observe(document.documentElement, { childList: true, subtree: true }, reportHealth);
ctx.observe(document.head || document.documentElement, { childList: true }, pinStylesheets);
ctx.track(document, 'load', (event) => {
    if (event.target === canaryNode) void finishCanary(true);
}, true);
ctx.track(document, 'error', (event) => {
    if (event.target === canaryNode) void finishCanary(false);
}, true);
ctx.every(500, () => {
    reportHealth();
    pinStylesheets();
    if (++statusTick % 4 === 0) void refreshStatus();
    if (canaryNode && canaryDeadline && Date.now() > canaryDeadline) void finishCanary(false);
    else void startCanary();
});
ctx.onDispose(() => {
    disposed = true;
    removeCanary();
    showWarning(null);
});
reportHealth();
pinStylesheets();

const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'frontend-pin',
    title: 'Frontend release gate',
    description: 'Loads the supported Code frontend from the bundled, integrity-checked asset graph. Authentication and APIs remain live.',
    defaults: DEFAULTS,
    immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Hold approved frontend', group: 'Release gate',
          hint: 'Off detaches the gate immediately. The already-loaded page stays intact; the server-selected release loads on the next full reload.' },
        { key: 'release', type: 'info', label: 'Approved release', group: 'Release gate',
          text: 'Loading bundle status', hint: 'The release manifest names the entry, stylesheets, flag overrides and SHA-256 of every bundled asset.' },
        { key: 'boundary', type: 'info', label: 'What stays live', group: 'Safety',
          text: 'Sign-in, account state, sessions, Claude Code processes, bootstrap data, and API requests are not pinned.' },
        { key: 'rollback', type: 'info', label: 'Failure behavior', group: 'Safety',
          text: 'Failures display an unsupported-frontend warning. If a pinned page cannot mount, the view reloads once without the gate.' },
    ],
    apply(values) {
        const next = { ...DEFAULTS, ...values }.enabled !== false;
        const changed = enabled !== next;
        enabled = next;
        settingsApplied = true;
        if (!enabled) {
            canaryDone = false;
            canaryBusy = false;
            removeCanary();
            showWarning(null);
        } else if (changed) {
            canaryDone = false;
        }
        cuimod.rpc('frontend-pin.settings', { enabled }).then(() => {
            if (enabled) void startCanary();
        }).catch(() => {});
    },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
});
standaloneSettings = !REG.subs.size;
void refreshStatus();
