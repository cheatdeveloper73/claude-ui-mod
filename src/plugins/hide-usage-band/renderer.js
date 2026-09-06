/* claude-ui-mod :: hide-usage-band (renderer)
 *
 * Removes or collapses the weekly limit, session limit, and usage warning bands
 * that appear above the composer input.
 *
 * The desktop injects alert bands into .epitaxy-composer-aux-view /
 * .epitaxy-composer-band when reaching quota (e.g. "Weekly limit reached Get more
 * usage to keep working · Resets Mon, Aug 31, 9:00 AM"). Because React controls
 * className on these nodes, styling is applied via data-attributes tagged by text
 * matching and enforced via a dedicated <style> sheet in document.head.
 *
 * Empty aux container rows are collapsed when all child bands are hidden,
 * preventing orphaned blank margins above the prompt box while keeping git/PR
 * diff rows untouched when present.
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

function shouldHideBand(text, v) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;

    if (v.hideWeekly) {
        if (/weekly\s+limit|weekly\s+usage|limit\s+reached.*resets/i.test(t)) return true;
        if (/resets\s+(?:mon|tue|wed|thu|fri|sat|sun)/i.test(t)) return true;
    }

    if (v.hideSession) {
        if (/(?:5[\s-]hour|hourly|session)\s+limit/i.test(t)) return true;
    }

    if (v.hideOtherLimits) {
        if (/(?:usage|rate)\s+limit|approaching\s+limit|exceeded\s+limit/i.test(t)) return true;
        if (/get\s+more\s+usage\s+to\s+keep\s+working/i.test(t)) return true;
    }

    if (v.customKeywords && typeof v.customKeywords === 'string') {
        const words = v.customKeywords.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
        const lower = t.toLowerCase();
        for (const w of words) {
            if (lower.includes(w)) return true;
        }
    }

    return false;
}

function scanBands() {
    if (!cfg || !cfg.enabled) {
        for (const e of document.querySelectorAll('[' + ATTR_BAND + ']')) e.removeAttribute(ATTR_BAND);
        for (const e of document.querySelectorAll('[' + ATTR_BTN + ']')) e.removeAttribute(ATTR_BTN);
        for (const e of document.querySelectorAll('[' + ATTR_CONTAINER + ']')) e.removeAttribute(ATTR_CONTAINER);
        return;
    }

    const v = cfg;

    // Scan composer bands and any composer aux views
    const bands = document.querySelectorAll('.epitaxy-composer-band, .epitaxy-composer-aux-view > div, [class*="composer-band"]');
    const checkedContainers = new Set();

    for (const band of bands) {
        const text = band.textContent || '';
        const match = shouldHideBand(text, v);

        if (match) {
            band.setAttribute(ATTR_BAND, '1');

            // Find any "Get more usage" / action buttons inside
            if (v.hideButton || v.mode === 'button_only') {
                const btns = band.querySelectorAll('button, a[role="button"]');
                for (const b of btns) {
                    if (/get\s+more|upgrade|usage/i.test(b.textContent || '')) {
                        b.setAttribute(ATTR_BTN, '1');
                    }
                }
            }
        } else {
            if (band.hasAttribute(ATTR_BAND)) band.removeAttribute(ATTR_BAND);
            if (band.hasAttribute(ATTR_BTN)) band.removeAttribute(ATTR_BTN);
        }

        const parent = band.closest('.epitaxy-composer-aux-view');
        if (parent) checkedContainers.add(parent);
    }

    // Collapse empty parent aux container if all visible children are hidden bands
    if (v.collapseEmptyContainer) {
        for (const container of checkedContainers) {
            const children = Array.from(container.children).filter((c) => {
                const cs = window.getComputedStyle(c);
                return cs && cs.display !== 'none' && cs.visibility !== 'hidden';
            });
            const allHidden = children.length > 0 && children.every((c) => c.hasAttribute(ATTR_BAND));
            if (allHidden) container.setAttribute(ATTR_CONTAINER, '1');
            else container.removeAttribute(ATTR_CONTAINER);
        }
    }
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

    let containerRules = '';
    if (v.collapseEmptyContainer) {
        containerRules = `
[${ATTR_CONTAINER}="1"] {
    margin-bottom: 0 !important;
    padding-bottom: 0 !important;
    min-height: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
}
`;
    }

    return bandRules + btnRules + containerRules;
}

function apply(v) {
    cfg = v;
    style.textContent = generateCss(v);
    scanBands();
}

// Observers and hooks
ctx.observe(document.documentElement, { childList: true, subtree: true }, scanBands);
ctx.track(window, 'resize', scanBands, { passive: true });
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) scanBands(); });
ctx.every(800, scanBands);
cuimod.onSessionChange(scanBands);

// ------------------------------------------------------------------ panel & preview
const spec = {
    plugin: 'hide-usage-band',
    title: 'Usage band cleaner',
    description: 'Hides or collapses weekly limit reached and quota warning bands above the composer.',
    defaults: {
        enabled: false,
        mode: 'hide',
        hideWeekly: true,
        hideSession: true,
        hideOtherLimits: true,
        hideButton: true,
        collapseEmptyContainer: true,
        dimOpacity: 0.2,
        customKeywords: '',
    },
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
