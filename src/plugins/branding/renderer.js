/* claude-ui-mod :: branding (renderer)
 *
 * Replaces Claude Spark marks without taking ownership of their React nodes.
 * Both SVGs have one key-green accent; turning them into data images after
 * recolouring that key makes one live setting feed every copy.
 */
'use strict';

const DEFAULTS = { enabled: true, accent: '#D97757' };
const BRAND_ATTR = 'data-cuimod-branding';
const SCENE_ID = 'cuimod-new-session-firefight';
const STATIC_ACCENT = '<path data-accent="" fill="#00FF66" d="M4 9h3v1H4z"/>';
const ANIMATED_ACCENT = `<style>
@keyframes cuimod-visor-scan {
    0%, 9% { transform: translateX(0); }
    10%, 19%, 90%, 99% { transform: translateX(1px); }
    20%, 29%, 80%, 89% { transform: translateX(2px); }
    30%, 39%, 70%, 79% { transform: translateX(3px); }
    40%, 49%, 60%, 69% { transform: translateX(4px); }
    50%, 59% { transform: translateX(5px); }
    100% { transform: translateX(0); }
}
.cuimod-visor-scan {
    animation: cuimod-visor-scan 1.35s steps(1, end) infinite;
    transform-box: fill-box;
}
@media (prefers-reduced-motion: reduce) {
    .cuimod-visor-scan { animation: none; }
}
</style>
<g clip-path="url(#visor-clip)">
    <rect class="cuimod-visor-scan" data-accent="" fill="#00FF66" x="4" y="9" width="2" height="1"/>
</g>`;

let settings = DEFAULTS;
let helmetSource = null;
let sceneSource = null;
let keyColor = '#00FF66';
let sceneHost = null;
let disposed = false;
let loadGeneration = 0;
let brandingPath = location.pathname;
let stillUri = '', movingUri = '', artUri = '';
function rebuildUris() {
    stillUri = helmetSource ? dataUri(helmetSource) : '';
    movingUri = helmetSource ? dataUri(helmetSource.replace(STATIC_ACCENT, ANIMATED_ACCENT)) : '';
    artUri = dataUri(sceneSource);
}
const touched = new Set();
const favicons = new Map();

const style = document.createElement('style');
style.id = 'cuimod-branding-style';
(document.head || document.documentElement).appendChild(style);
ctx.onDispose(() => { try { style.remove(); } catch (_) {} });

function cleanColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
        ? value.trim().toUpperCase() : DEFAULTS.accent;
}

function recolor(source, accent) {
    return source.split(keyColor).join(accent);
}

function dataUri(source) {
    return source ? 'data:image/svg+xml,' + encodeURIComponent(recolor(source, cleanColor(settings.accent))) : '';
}

function svgUri(animated) {
    return animated ? movingUri : stillUri;
}

function sceneUri() {
    return artUri;
}

function paintStyle() {
    if (!settings.enabled || !helmetSource) {
        style.textContent = '';
        return;
    }
    const still = svgUri(false);
    const moving = svgUri(true);
    const scene = sceneUri() || still;
    style.textContent = `
[${BRAND_ATTR}="spark-static"],
[${BRAND_ATTR}="spark-animated"] {
    color: transparent !important;
    opacity: .8 !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-size: contain !important;
}
[${BRAND_ATTR}="spark-static"] { background-image: url("${still}") !important; }
[${BRAND_ATTR}="spark-animated"] { background-image: url("${moving}") !important; }
[${BRAND_ATTR}^="spark-"] > * { visibility: hidden !important; }
#${SCENE_ID} {
    box-sizing: border-box !important;
    position: fixed !important;
    width: 124px !important;
    height: 34px !important;
    z-index: 50 !important;
    pointer-events: none !important;
    background: var(--cds-page-bg, hsl(var(--bg-100))) !important;
}
#${SCENE_ID}::after {
    content: '';
    position: absolute;
    inset: 0;
    opacity: .8;
    background: center / contain no-repeat url("${scene}");
}
`;
}

function restoreMarks() {
    for (const node of touched) {
        try { node.removeAttribute(BRAND_ATTR); } catch (_) {}
    }
    touched.clear();
}

function restoreFavicons() {
    for (const [link, record] of favicons) {
        try {
            if (link.href === record.applied) link.href = record.original;
        } catch (_) {}
    }
    favicons.clear();
}

function mark(node, value) {
    if (!node || node.getAttribute(BRAND_ATTR) === value) return;
    node.setAttribute(BRAND_ATTR, value);
    touched.add(node);
}

function reconcileFavicons() {
    const applied = svgUri(false);
    if (!applied) return;
    for (const link of (document.head || document).querySelectorAll('link[rel~="icon"]')) {
        let record = favicons.get(link);
        if (!record) {
            record = { original: link.href, applied: null };
            favicons.set(link, record);
        }
        if (link.href !== applied) link.href = applied;
        record.applied = applied;
    }
}

function removeScene() {
    if (!sceneHost) return;
    try { sceneHost.remove(); } catch (_) {}
    sceneHost = null;
}

function ensureScene() {
    if (sceneHost && !sceneHost.isConnected) sceneHost = null;
    if (sceneHost) return sceneHost;
    for (const node of document.querySelectorAll('#' + SCENE_ID)) node.remove();
    sceneHost = document.createElement('div');
    sceneHost.id = SCENE_ID;
    sceneHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sceneHost);
    return sceneHost;
}

function mainComposer(snapshot) {
    let best = null;
    let bestRect = null;
    for (const prompt of (snapshot ? snapshot.queryAll('.epitaxy-prompt') : document.querySelectorAll('.epitaxy-prompt'))) {
        const rect = snapshot ? snapshot.rect(prompt) : prompt.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (prompt.closest?.('.epitaxy-composer-width')) return prompt;
        if (rect.width < 120) continue;
        if (!bestRect || rect.width > bestRect.width + 8 ||
            (Math.abs(rect.width - bestRect.width) <= 8 && rect.bottom > bestRect.bottom)) {
            best = prompt;
            bestRect = rect;
        }
    }
    return best;
}

function measureScene(snapshot) {
    if (!settings.enabled || location.pathname !== '/epitaxy' || !sceneSource) return null;
    const composer = mainComposer(snapshot);
    if (!composer) return null;
    const box = snapshot ? snapshot.rect(composer) : composer.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { left: Math.round(box.right - 124) + 'px', top: Math.round(box.top - 34) + 'px' } : false;
}
function paintScene(box) {
    if (box === null) { removeScene(); return; }
    if (!box) return;
    const host = ensureScene();
    if (host.style.left !== box.left) host.style.left = box.left;
    if (host.style.top !== box.top) host.style.top = box.top;
}
function reconcileScene() { paintScene(measureScene()); }
const sceneLayout = typeof ctx.layout === 'function' ? ctx.layout(measureScene, paintScene) : null;
function scheduleScene() { if (sceneLayout) sceneLayout(); else reconcileScene(); }

function reconcile() {
    if (disposed) return;
    if (!settings.enabled || !helmetSource) {
        restoreMarks();
        restoreFavicons();
        removeScene();
        return;
    }

    for (const node of document.querySelectorAll('[data-cds="Spark"]')) {
        mark(node, node.tagName === 'SPAN' ? 'spark-animated' : 'spark-static');
    }
    reconcileFavicons();
    reconcileScene();
}

async function loadHelmet() {
    const generation = ++loadGeneration;
    try {
        const value = await cuimod.rpc('branding.helmet');
        if (disposed || generation !== loadGeneration) return;
        if (typeof value?.source !== 'string' || typeof value?.keyColor !== 'string') return;
        helmetSource = value.source;
        sceneSource = typeof value.sceneSource === 'string' ? value.sceneSource : null;
        keyColor = value.keyColor;
        rebuildUris();
        paintStyle();
        reconcile();
    } catch (_) {
        // A renderer generation can disappear while its asset request is in flight.
    }
}

function discoverMarks(root) {
    if (!settings.enabled || !helmetSource || root?.nodeType !== 1) return;
    if (root.matches('[data-cds="Spark"]')) mark(root, root.tagName === 'SPAN' ? 'spark-animated' : 'spark-static');
    // Streamed text and ordinary tokens have no element subtree to inspect.
    if (root.childElementCount) for (const node of root.querySelectorAll('[data-cds="Spark"]'))
        mark(node, node.tagName === 'SPAN' ? 'spark-animated' : 'spark-static');
}
ctx.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-cds'] }, records => {
    if (disposed) return;
    let shell = false;
    for (const record of records) {
        if (record.type === 'attributes') {
            if (record.target.matches('[data-cds="Spark"]')) discoverMarks(record.target);
            else if (touched.delete(record.target)) record.target.removeAttribute(BRAND_ATTR);
        } else {
            for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.id === SCENE_ID && node !== sceneHost) node.remove();
                else discoverMarks(node);
            }
            if ([...record.removedNodes].some(node => node.nodeType === 1))
                for (const node of touched) if (!node.isConnected) touched.delete(node);
        }
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!element?.closest?.('[data-testid="epitaxy-virtual-transcript"], #' + SCENE_ID)) shell = true;
    }
    if (shell) scheduleScene();
});
ctx.observe(document.head || document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['href', 'rel'] }, records => {
    if (!disposed && settings.enabled && records.some(record => record.type === 'attributes'
        ? record.target.tagName === 'LINK'
        : [...record.addedNodes].some(node => node.nodeType === 1 && (node.tagName === 'LINK' || node.querySelector?.('link[rel~="icon"]'))))) reconcileFavicons();
});
ctx.every(500, () => {
    if (brandingPath !== location.pathname) { brandingPath = location.pathname; scheduleScene(); }
    else if (!sceneLayout && location.pathname === '/epitaxy') reconcileScene();
});
ctx.track(window, 'resize', scheduleScene, { passive: true });
ctx.track(document, 'visibilitychange', scheduleScene);
ctx.onDispose(() => {
    disposed = true;
    loadGeneration++;
    removeScene();
    restoreMarks();
    restoreFavicons();
});

const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'branding',
    title: 'Blockshooter branding',
    description: 'Replaces Claude’s Spark marks and the new-session composer crab with Blockshooter art.',
    defaults: DEFAULTS,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Replace Claude branding', group: 'Identity' },
        { key: 'accent', type: 'color', label: 'Helmet accent', group: 'Identity',
          hint: 'Recolours the key-green helmet and weapon accents everywhere in real time.' },
    ],
    apply(values) {
        settings = { ...DEFAULTS, ...values, accent: cleanColor(values?.accent) };
        rebuildUris();
        paintStyle();
        reconcile();
    },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
});
if (!REG.subs.size) spec.apply(DEFAULTS);

loadHelmet();
