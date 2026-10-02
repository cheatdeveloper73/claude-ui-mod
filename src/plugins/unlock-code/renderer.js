/* claude-ui-mod :: unlock-code (renderer)
 *
 * Suppresses marketing discovery takeover modal and triggers page-world
 * capability patches to allow full Claude Code usage and spoof Max 20x tier.
 */
'use strict';

const STYLE_ID = 'cuimod-unlock-code';
const style = document.createElement('style');
style.id = STYLE_ID;
(document.head || document.documentElement).appendChild(style);

function cleanupDom() {
    try { style.remove(); } catch (_) {}
}
ctx.onDispose(cleanupDom);

let cfg = null;

const DEFAULTS = {
    enabled: true,
    hideTakeover: true,
    suppressUpsells: true,
};

function generateCss(v) {
    if (!v || !v.enabled) return '';
    let rules = '';
    if (v.hideTakeover) {
        rules += `
.df-discovery-takeover,
[data-testid="discovery-preview-takeover"],
div[class*="discovery-takeover"] {
    display: none !important;
    pointer-events: none !important;
}
`;
    }
    if (v.suppressUpsells) {
        rules += `
[data-testid="overages-upsell-body-skeleton"],
div:has(> [data-testid="overages-upsell-body-skeleton"]),
.animate-upsell-banner-in,
.animate-upsell-row-in,
[data-testid="free-limit-pro-offer"],
div[class*="FreeLimitProOffer"] {
    display: none !important;
    pointer-events: none !important;
}
`;
    }
    return rules;
}

function triggerPatch() {
    if (!cfg || !cfg.enabled) return;
    try {
        cuimod.rpc('unlock-code.patch').catch(() => {});
    } catch (_) {}
}

function apply(v) {
    cfg = Object.assign({}, DEFAULTS, v);
    style.textContent = generateCss(cfg);
    if (cfg.enabled) {
        triggerPatch();
    }
}

triggerPatch();
ctx.every(3000, triggerPatch);

const spec = {
    plugin: 'unlock-code',
    title: 'Unlock Claude Code & Spoof Max 20x',
    description: 'Unlocks Claude Code view and spoof organization to Max 20x plan to eliminate upgrade paywalls and popups.',
    defaults: DEFAULTS,
    controls: [
        {
            key: 'enabled',
            type: 'toggle',
            label: 'Enabled',
            hint: 'Injects claude_code and claude_max capabilities and default_claude_max_20x tier.',
            group: 'Behavior',
        },
        {
            key: 'hideTakeover',
            type: 'toggle',
            label: 'Suppress paywall modal',
            hint: 'Hides the marketing takeover modal.',
            group: 'Behavior',
        },
        {
            key: 'suppressUpsells',
            type: 'toggle',
            label: 'Suppress upsell popups',
            hint: 'Hides upgrade upsell and limit modals.',
            group: 'Behavior',
        },
    ],
    apply,
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});

if (REG.subs.size === 0) apply(spec.defaults);
