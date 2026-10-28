/* claude-ui-mod :: hide-usage-band (renderer)
 *
 * Removes or collapses the weekly limit, session limit, and usage warning bands
 * that appear above the composer input.
 *
 * Because React controls className on these nodes, styling is applied via
 * data-attributes tagged by text matching and enforced via a dedicated <style>
 * sheet in document.head.
 *
 * WHERE THE BANDS ARE (re-established 2026-09-06 against app-1.46388.4)
 *
 * `.epitaxy-composer-aux-view` and `.epitaxy-composer-band` are gone — zero
 * matches in the live DOM and the strings no longer appear anywhere in the
 * claude.ai bundle the page loads. Scoping to them made scanBands() iterate an
 * empty NodeList, so nothing was ever tagged and the sheet had nothing to act
 * on. That is the whole of the breakage.
 *
 * Two anchors replace them, and the union is deliberate:
 *
 *   .epitaxy-band-enter   the band component's own class. Read out of the
 *                         bundle: the band root renders as
 *                         div{role=status, aria-live=polite,
 *                         class=`${bg} ${pad} text-body epitaxy-band-enter`}.
 *                         role/aria-live alone are useless as a selector —
 *                         four sr-only live regions match them per window.
 *   composer rows         every row box stacked above `.epitaxy-prompt` inside
 *                         its own parent, including the children of the
 *                         `<nav>` that now holds the branch/PR row. Geometry,
 *                         not class, so a row claude.ai renames or adds
 *                         tomorrow is still found.
 *
 * Both are then gated by the same text match, which is what actually decides.
 * Scoping is not decoration: session titles in the sidebar match the limit
 * wording often enough that an unscoped text sweep hides the wrong things —
 * measured, two false hits in one probe.
 *
 * The empty container is hidden outright rather than zero-heighted: the
 * composer stack is `flex flex-col gap-1.5`, so a collapsed-but-present nav
 * still contributes its gap.
 */
'use strict';

const STYLE_ID = 'cuimod-hide-usage-band';
const ATTR_BAND = 'data-cuimod-hide-band';
const ATTR_BTN = 'data-cuimod-hide-band-btn';
const ATTR_CONTAINER = 'data-cuimod-hide-container';

const style = document.createElement('style');
style.id = STYLE_ID;
(document.head || document.documentElement).appendChild(style);

function cleanupDom() {
    try { style.remove(); } catch (_) {}
    for (const e of document.querySelectorAll('[' + ATTR_BAND + ']')) e.removeAttribute(ATTR_BAND);
    for (const e of document.querySelectorAll('[' + ATTR_BTN + ']')) e.removeAttribute(ATTR_BTN);
    for (const e of document.querySelectorAll('[' + ATTR_CONTAINER + ']')) e.removeAttribute(ATTR_CONTAINER);
}
ctx.onDispose(cleanupDom);

let cfg = null;
const taggedBands = new Set();
const taggedButtons = new Set();
const taggedContainers = new Set();
let scanTimer = null;
let bandDisposed = false;
let bandPath = location.pathname;
function setTag(node, attribute, active, held) {
    if (active) {
        if (node.getAttribute(attribute) !== '1') node.setAttribute(attribute, '1');
        held.add(node);
    } else {
        if (node.hasAttribute(attribute)) node.removeAttribute(attribute);
        held.delete(node);
    }
}
function clearHeld(held, attribute, keep = new Set()) {
    for (const node of held) if (!keep.has(node)) setTag(node, attribute, false, held);
}

const DEFAULTS = {
    enabled: false,
    mode: 'hide',
    hideWeekly: true,
    hideSession: true,
    hideOtherLimits: true,
    hideButton: true,
    collapseEmptyContainer: true,
    dimOpacity: 0.2,
    customKeywords: '',
};

// Wordings read out of the claude.ai bundle (index-BhceMCtx.js, 2026-09-06),
// not invented: the band's message and detail strings are defined there as one
// table per severity. Each group is what its own filter toggle owns.
const RE_WEEKLY = [
    /weekly\s+limit\s+reached/i,
    /approaching\s+weekly\s+usage\s+limit/i,
    /weekly\s+limit\s+resets/i,
    /your\s+weekly\s+limit/i,
];
const RE_SESSION = [
    /session\s+limit\s+reached/i,
    /approaching\s+session\s+usage\s+limit/i,
    /session\s+limit\s+resets/i,
    /(?:5[\s-]hour|hourly)\s+limit/i,
];
const RE_OTHER = [
    /usage\s+limit\s+reached/i,
    /limit\s+reached/i,                                  // "{model} limit reached"
    /approaching\s+(?:usage|extra\s+usage|usage\s+credit)\s+limit/i,
    /you.?ve\s+used\s+\d+%?\s+of\s+your\b.*\blimit/i,
    /get\s+more\s+usage\s+to\s+keep\s+working/i,
    /turn\s+on\s+usage\s+credits\s+to\s+keep\s+(?:working|going)/i,
    /now\s+using\s+(?:usage\s+credits|extra\s+usage)/i,
    /out\s+of\s+(?:usage|extra\s+usage|usage\s+credits)\b/i,
    /(?:monthly\s+|org\s+)?spend\s+limit\s+reached/i,
    /you\s+hit\s+your\s+spend\s+limit/i,
    /runs\s+on\s+usage\s+credits/i,
    /switch\s+models\s+to\s+keep\s+working/i,
];

function anyMatch(list, t) {
    for (const re of list) if (re.test(t)) return true;
    return false;
}

function shouldHideBand(text, v) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;

    if (v.hideWeekly && anyMatch(RE_WEEKLY, t)) return true;
    if (v.hideSession && anyMatch(RE_SESSION, t)) return true;
    if (v.hideOtherLimits && anyMatch(RE_OTHER, t)) return true;

    if (v.customKeywords && typeof v.customKeywords === 'string') {
        const words = v.customKeywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
        const lower = t.toLowerCase();
        for (const w of words) {
            if (lower.includes(w)) return true;
        }
    }

    return false;
}

// Every row box stacked above the prompt, plus the rows inside the <nav> that
// holds the branch/PR row. The nav itself is never a candidate — tagging it
// would take the branch row down with the band it contains.
function composerRows(out) {
    const prompt = document.querySelector('.epitaxy-prompt');
    if (!prompt) return;
    const container = prompt.parentElement;
    if (!container) return;
    const promptTop = prompt.getBoundingClientRect().top;

    for (const child of container.children) {
        if (child === prompt || child.contains(prompt)) continue;
        const rows = child.tagName === 'NAV' ? Array.from(child.children) : [child];
        for (const row of rows) {
            const r = row.getBoundingClientRect();
            // Our hidden rows have no geometry. Keep them candidates while
            // they still precede the prompt so a second pass cannot unhide them.
            if (taggedBands.has(row) && (child.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                out.add(row);
                continue;
            }
            if (r.width <= 0 || r.height <= 0) continue;
            if (r.top >= promptTop) continue;   // footer row, popovers, menus
            out.add(row);
        }
    }
}

function clearTags() {
    clearHeld(taggedBands, ATTR_BAND);
    clearHeld(taggedButtons, ATTR_BTN);
    clearHeld(taggedContainers, ATTR_CONTAINER);
}

function scanBands() {
    if (!cfg || !cfg.enabled) { clearTags(); return; }
    const v = cfg;
    const bands = new Set(document.querySelectorAll('.epitaxy-band-enter'));
    composerRows(bands);
    const tagged = new Set();
    const buttons = new Set();
    const containers = new Set();
    const hiddenContainers = new Set();
    for (const band of bands) {
        if (shouldHideBand(band.textContent || '', v)) {
            setTag(band, ATTR_BAND, true, taggedBands);
            tagged.add(band);
            if (v.hideButton || v.mode === 'button_only') {
                for (const button of band.querySelectorAll('button, a[role="button"]')) {
                    if (/get\s+more|upgrade|usage|buy\s+credits|keep\s+working|switch\s+models|turn\s+on|request/i.test(button.textContent || '')) {
                        setTag(button, ATTR_BTN, true, taggedButtons);
                        buttons.add(button);
                    }
                }
            }
        }
        const parent = band.parentElement;
        if (parent && parent.tagName === 'NAV') containers.add(parent);
    }
    clearHeld(taggedBands, ATTR_BAND, tagged);
    clearHeld(taggedButtons, ATTR_BTN, buttons);
    for (const container of containers) {
        const children = Array.from(container.children).filter((child) => {
            if (child.hasAttribute(ATTR_BAND)) return true;
            const cs = window.getComputedStyle(child);
            return cs && cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        if (v.collapseEmptyContainer && children.length > 0 && children.every(child => child.hasAttribute(ATTR_BAND))) {
            setTag(container, ATTR_CONTAINER, true, taggedContainers);
            hiddenContainers.add(container);
        }
    }
    clearHeld(taggedContainers, ATTR_CONTAINER, hiddenContainers);
}

function queueBands(records) {
    if (!cfg?.enabled || bandDisposed) return;
    if (records && !records.some(record => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest?.('[data-testid="epitaxy-virtual-transcript"]')
            && !(record.type === 'attributes' && target.matches?.('[data-testid="epitaxy-virtual-transcript"]'))) return false;
        if (target?.closest?.('#cuimod-hide-usage-band, [data-cuimod-provider-limits]')) return false;
        if (record.type === 'attributes' && record.oldValue === target.getAttribute(record.attributeName)) return false;
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => {
            const el = node.nodeType === 1 ? node : node.parentElement;
            return el?.closest?.('[id^="cuimod-"], [class*="cuimod-"]');
        })) return false;
        return true;
    })) return;
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => { scanTimer = null; if (!bandDisposed) scanBands(); }, 0);
}

function generateCss(v) {
    if (!v || !v.enabled) return '';

    let bandRules = '';
    if (v.mode === 'hide') {
        bandRules = `
[${ATTR_BAND}="1"] {
    display: none !important;
}
`;
    } else if (v.mode === 'collapse') {
        bandRules = `
[${ATTR_BAND}="1"] {
    max-height: 0 !important;
    opacity: 0 !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    margin-top: 0 !important;
    margin-bottom: 0 !important;
    overflow: hidden !important;
    pointer-events: none !important;
    border: none !important;
    transition: max-height 200ms ease, opacity 200ms ease, padding 200ms ease, margin 200ms ease !important;
}
`;
    } else if (v.mode === 'dim') {
        const op = Math.max(0.05, Math.min(1, v.dimOpacity || 0.2));
        bandRules = `
[${ATTR_BAND}="1"] {
    opacity: ${op} !important;
    filter: grayscale(80%) !important;
    transition: opacity 160ms ease, filter 160ms ease !important;
}
[${ATTR_BAND}="1"]:hover {
    opacity: 1 !important;
    filter: none !important;
}
`;
    } else if (v.mode === 'button_only') {
        bandRules = `
[${ATTR_BTN}="1"],
[${ATTR_BAND}="1"] button {
    display: none !important;
}
`;
    }

    let btnRules = '';
    if (v.hideButton && v.mode !== 'button_only' && v.mode !== 'hide') {
        btnRules = `
[${ATTR_BTN}="1"],
[${ATTR_BAND}="1"] button {
    display: none !important;
}
`;
    }

    // The composer stack is `flex flex-col gap-1.5`, so a zero-height container
    // still contributes its gap above the prompt. Take it out of layout.
    let containerRules = '';
    if (v.collapseEmptyContainer) {
        containerRules = `
[${ATTR_CONTAINER}="1"] {
    display: none !important;
}
`;
    }

    return bandRules + btnRules + containerRules;
}

function apply(v) {
    // Stored settings only carry keys the panel has written, so a filter the
    // user never touched arrives undefined and would read as off.
    cfg = Object.assign({}, DEFAULTS, v);
    const css = generateCss(cfg);
    if (style.textContent !== css) style.textContent = css;
    scanBands();
}

// Observers and hooks
ctx.observe(document.documentElement, { childList: true, characterData: true, subtree: true,
    attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden'] }, queueBands);
ctx.track(window, 'resize', () => queueBands(), { passive: true });
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) queueBands(); });
ctx.every(800, () => {
    if (bandPath === location.pathname) return;
    bandPath = location.pathname;
    queueBands();
});
ctx.onDispose(cuimod.onSessionChange(() => queueBands()));
ctx.onDispose(() => { bandDisposed = true; clearTimeout(scanTimer); clearTags(); });

// ------------------------------------------------------------------ panel & preview
const spec = {
    plugin: 'hide-usage-band',
    title: 'Usage band cleaner',
    description: 'Hides or collapses weekly limit reached and quota warning bands above the composer.',
    defaults: DEFAULTS,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled',
          hint: 'Turn off to restore stock composer warning bands.', group: 'Behavior' },
        { key: 'mode', type: 'combo', label: 'Display mode', group: 'Behavior',
          options: [
              { value: 'hide', label: 'Hide completely' },
              { value: 'collapse', label: 'Collapse (smooth)' },
              { value: 'dim', label: 'Dim / Subtle (hover to view)' },
              { value: 'button_only', label: 'Hide button only' },
          ] },
        { key: 'dimOpacity', type: 'slider', label: 'Dimmed opacity', min: 0.05, max: 0.7, step: 0.05,
          hint: 'Applied when mode is set to Dim / Subtle.', group: 'Behavior' },
        { key: 'collapseEmptyContainer', type: 'toggle', label: 'Collapse empty aux row',
          hint: 'Removes vertical space above prompt box when all bands in the row are hidden.', group: 'Behavior' },

        { key: 'hideWeekly', type: 'toggle', label: 'Hide weekly limits',
          hint: 'Matches "Weekly limit reached" and reset date messages.', group: 'Filters' },
        { key: 'hideSession', type: 'toggle', label: 'Hide session & 5h limits',
          hint: 'Matches 5-hour, hourly, and session quota alerts.', group: 'Filters' },
        { key: 'hideOtherLimits', type: 'toggle', label: 'Hide general usage banners',
          hint: 'Matches approaching limit and generic limit warnings.', group: 'Filters' },
        { key: 'hideButton', type: 'toggle', label: 'Hide action button',
          hint: 'Strips the "Get more usage" promotional action button.', group: 'Filters' },
        { key: 'customKeywords', type: 'text', label: 'Custom keywords',
          hint: 'Comma-separated substrings to match and hide.', group: 'Filters' },
    ],
    apply,
    preview: {
        title: 'Preview — composer band',
        beforeLabel: 'stock warning banner',
        afterLabel: 'with plugin applied',
        layout: 'col',
        node() {
            const root = document.createElement('div');
            root.className = 'pv-comp-wrap';

            // Git/branch row
            const gitRow = document.createElement('div');
            gitRow.className = 'pv-band pv-git';
            gitRow.innerHTML = '<span class="pv-branch">claude-ui-mod main</span> <span class="pv-diff"><span class="pv-add">+15,089</span> <span class="pv-del">-58</span></span> <button class="pv-commit-btn" type="button">Commit changes</button>';

            // Usage warning band
            const usageBand = document.createElement('div');
            usageBand.className = 'pv-band pv-usage-warn';
            usageBand.innerHTML = '<div class="pv-warn-left"><span class="pv-warn-icon">⏱</span> <span class="pv-warn-title">Weekly limit reached</span> <span class="pv-warn-sub">Get more usage to keep working · Resets Mon, Aug 31, 9:00 AM</span></div> <button class="pv-warn-btn" type="button">Get more usage</button>';

            // Mock prompt input box
            const promptBox = document.createElement('div');
            promptBox.className = 'pv-prompt-box';
            promptBox.innerHTML = '<span class="pv-placeholder">Type / for commands</span>';

            root.append(gitRow, usageBand, promptBox);
            return root;
        },
        css(v, sel, which) {
            const isStock = which === 'before';
            const hideBand = !isStock && v.enabled && (v.mode === 'hide' || (v.mode === 'collapse'));
            const dimBand = !isStock && v.enabled && v.mode === 'dim';
            const hideBtn = !isStock && v.enabled && (v.hideButton || v.mode === 'button_only');
            const dimOp = v.dimOpacity || 0.2;

            return `
${sel} .pv-comp-wrap {
    display: flex; flex-direction: column; gap: 6px;
    width: 100%; max-width: 520px; padding: 12px 14px;
    background: hsl(var(--bg-100, 0 0% 8%));
    border-radius: 10px;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 12px; line-height: 1.4;
    color: hsl(var(--text-100, 60 14% 97%));
}
${sel} .pv-band {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; border-radius: 8px; font-size: 11.5px;
    background: hsl(var(--bg-200, 0 0% 12%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
}
${sel} .pv-git {
    color: hsl(var(--text-300, 48 5% 70%));
}
${sel} .pv-branch { font-weight: 500; }
${sel} .pv-diff { margin-left: 8px; font-family: ui-monospace, monospace; font-size: 10.5px; }
${sel} .pv-add { color: #4ade80; }
${sel} .pv-del { color: #f87171; }
${sel} .pv-commit-btn {
    font-size: 11px; padding: 3px 8px; border-radius: 6px;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 8%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    color: hsl(var(--text-200, 60 14% 85%));
    cursor: default;
}
${sel} .pv-usage-warn {
    background: rgba(239, 68, 68, 0.08);
    border-color: rgba(239, 68, 68, 0.22);
    color: #fca5a5;
    ${hideBand ? 'display: none !important;' : ''}
    ${dimBand ? `opacity: ${dimOp} !important; filter: grayscale(80%) !important;` : ''}
}
${sel} .pv-warn-left {
    display: flex; align-items: center; gap: 7px; min-width: 0;
}
${sel} .pv-warn-icon { font-size: 13px; opacity: .85; }
${sel} .pv-warn-title { font-weight: 600; color: #f87171; }
${sel} .pv-warn-sub { color: hsl(var(--text-400, 48 5% 60%)); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
${sel} .pv-warn-btn {
    font-size: 11px; font-weight: 500; padding: 4px 9px; border-radius: 6px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #fecaca;
    white-space: nowrap; cursor: default;
    ${hideBtn ? 'display: none !important;' : ''}
}
${sel} .pv-prompt-box {
    padding: 10px 12px; border-radius: 9px;
    background: hsl(var(--bg-200, 0 0% 10%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    color: hsl(var(--text-500, 48 5% 45%));
    font-size: 12.5px;
}
`;
        },
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});

if (REG.subs.size === 0) apply(spec.defaults);
