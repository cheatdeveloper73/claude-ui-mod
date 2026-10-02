/* claude-ui-mod :: computer-use (renderer)
 *
 * Registers the Computer Use controls into the plugin dashboard and triggers
 * live preference synchronization over EIPC and RPC.
 */
'use strict';

let cfg = null;

// enabled stays null until the user flips the switch: null leaves Desktop's
// own Computer Use preference exactly as it is. Installing the mod must not
// hand the model screen, mouse and keyboard control by itself.
const DEFAULTS = {
    enabled: null,
    preferredMode: 'background',
    autoUnhide: true,
};

function apply(v) {
    cfg = Object.assign({}, DEFAULTS, v);
    if (typeof cfg.enabled !== 'boolean') return;

    // 1. Send EIPC directly to the main process from the renderer (origin https://claude.ai)
    try {
        const setPrefChannel = cuimod.eipc('claude.settings', 'AppPreferences', 'setPreference');
        cuimod.appInvoke(setPrefChannel, 'chicagoEnabled', Boolean(cfg.enabled)).catch(() => {});
        cuimod.appInvoke(setPrefChannel, 'chicagoPreferredMode', cfg.preferredMode).catch(() => {});
        cuimod.appInvoke(setPrefChannel, 'chicagoAutoUnhide', Boolean(cfg.autoUnhide)).catch(() => {});
    } catch (_) {}

    // 2. Call main plugin RPC to ensure disk persistence and main-side synchronization
    try {
        cuimod.rpc('computer-use.sync', {
            enabled: Boolean(cfg.enabled),
            preferredMode: cfg.preferredMode,
            autoUnhide: Boolean(cfg.autoUnhide),
        }).catch(() => {});
    } catch (_) {}
}

const spec = {
    plugin: 'computer-use',
    title: 'Computer Use (Windows)',
    description: 'Enables native Windows desktop automation (chicago), screenshots, mouse clicks, and typing without restarting the app.',
    defaults: DEFAULTS,
    controls: [
        {
            key: 'enabled',
            type: 'toggle',
            label: 'Enable Computer Use',
            hint: 'Activates the native Windows automation engine (chicago) and loads mcp__computer-use tools.',
            group: 'Behavior',
        },
        {
            key: 'preferredMode',
            type: 'combo',
            label: 'Capture mode',
            hint: 'Background targets specific app windows; Full Control captures the entire desktop screen.',
            options: [
                { label: 'Background (App-scoped windows)', value: 'background' },
                { label: 'Full Control (Entire desktop)', value: 'full_control' },
            ],
            group: 'Behavior',
        },
        {
            key: 'autoUnhide',
            type: 'toggle',
            label: 'Auto-unhide windows',
            hint: 'Automatically restore minimized windows at turn completion.',
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
