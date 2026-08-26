/* claude-ui-mod :: transcript-type (renderer)
 *
 * Typeface and size for the *normal* transcript text — the assistant's replies,
 * your prompts, tool rows. Thinking blocks are thinking-style's business.
 *
 * It does not fight the app's own typography rule
 *   .epitaxy-root .epitaxy-transcript-typography :where(.text-body):not(button,…)
 *     { font-size: var(--chat-body); line-height: var(--chat-leading) }
 * it feeds it. Redefining --chat-body / --chat-leading on the transcript root
 * means every rule the app derives from them stays consistent (--chat-footnote,
 * --chat-turn-gap and --chat-item-gap are all calc()d off --chat-body), and the
 * override cannot leak outside the transcript.
 *
 * The app sets those tokens in
 *   .epitaxy-root .epitaxy-transcript-typography { --chat-body: 14px; … }
 * at (0,2,0), with (0,2,0) siblings for [data-chat-text-size=s|l]. The class is
 * repeated below purely to reach (0,3,0) and win against all of them without
 * depending on stylesheet order. --chat-leading is a UNITLESS multiplier there,
 * not a length.
 *
 * Four tokens have to be redefined, not one. The app's font graph is
 *   --font-ui = var(--font-anthropic-sans)
 *   --font-claude-response / --font-user-message / --font-sans-serif = var(--font-ui)
 * so overriding --font-ui covers those — but --family-ui (11 consumers) and
 * --cds-font-sans (5) are independent tokens that resolve to the same stack by a
 * different route, and anything reading them kept rendering anthropic-sans. That
 * was the "inconsistently applied" symptom: it depended on which components were
 * on screen. Overriding --font-anthropic-sans covers the whole --font-ui chain at
 * its root; the other two are set alongside it.
 *
 * Mono and serif tokens are deliberately left alone, so code blocks stay mono and
 * thinking-style keeps whichever face it picks.
 */
'use strict';

const FACES = [
    { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
    { value: 'Tahoma, Verdana, sans-serif', label: 'Tahoma' },
    { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
    { value: 'var(--font-anthropic-sans, ui-sans-serif), system-ui, sans-serif', label: 'Anthropic Sans (stock)' },
    { value: 'var(--font-serif)', label: 'Anthropic Serif' },
    { value: 'Georgia, serif', label: 'Georgia' },
    { value: '"Cascadia Mono", Consolas, ui-monospace, monospace', label: 'Cascadia Mono' },
    { value: 'Consolas, ui-monospace, monospace', label: 'Consolas' },
];

const style = document.createElement('style');
style.id = 'cuimod-transcript-type';
(document.head || document.documentElement).appendChild(style);
ctx.onDispose(() => { try { style.remove(); } catch (_) {} });

// The live rule feeds the app's tokens; a preview stage has no app rule reading
// those tokens, so it takes the resolved values directly. Both come from here so
// the numbers cannot drift apart.
function typeRules(sel, face, size, leading) {
    return `
${sel} { font-family: ${face}; font-size: ${size}px; line-height: ${leading}; color: hsl(var(--text-100)); }
${sel} .pv-p + .pv-p { margin-top: .75em; }
${sel} .pv-b { font-weight: 600; }
${sel} .pv-c {
    font-family: var(--font-mono);
    font-size: ${(size * 0.92).toFixed(2)}px;
    background: color-mix(in srgb, currentColor 12%, transparent);
    padding: 1px 4px; border-radius: 4px;
}
`;
}

// The app's own transcript scale, from its stylesheet: 14px with a unitless
// 1.42857 leading, on the UI sans.
const STOCK = { face: 'var(--font-ui)', size: 14, leading: 1.42857 };

function apply(v) {
    if (!v.enabled) { style.textContent = ''; return; }
    style.textContent = `
.epitaxy-root .epitaxy-transcript-typography.epitaxy-transcript-typography {
    --chat-body: ${v.size}px;
    --chat-leading: ${v.leading};
    --font-anthropic-sans: ${v.face};
    --font-ui: ${v.face};
    --family-ui: ${v.face};
    --cds-font-sans: ${v.face};
    font-family: ${v.face};
}
`;
}

const spec = {
    plugin: 'transcript-type',
    title: 'Transcript type',
    description: 'Typeface and size for normal transcript text.',
    defaults: {
        enabled: true,
        face: 'Verdana, Geneva, sans-serif',
        size: 12,
        leading: 1.55,
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled',
          hint: 'Off restores the app’s own typography.', group: 'Type' },
        { key: 'face', type: 'combo', label: 'Typeface', options: FACES, group: 'Type' },
        { key: 'size', type: 'slider', label: 'Size', min: 10, max: 20, step: 0.5, unit: 'px',
          hint: 'Drives --chat-body, so the whole transcript scale follows.', group: 'Type' },
        { key: 'leading', type: 'slider', label: 'Line height', min: 1.1, max: 2.2, step: 0.01,
          unit: '×', group: 'Type' },
    ],
    apply,
    preview: {
        title: 'Preview — transcript text',
        beforeLabel: 'stock app, plugin off',
        node() {
            const box = document.createElement('div');
            box.className = 'pv-copy';

            const p1 = document.createElement('div');
            p1.className = 'pv-p';
            const b = document.createElement('span');
            b.className = 'pv-b';
            b.textContent = 'The fourth field is the desync. ';
            const c = document.createElement('span');
            c.className = 'pv-c';
            c.textContent = 'net_player_state.cpp:214';
            p1.append(b, 'The client reads a u16 where the server writes a u32, so every packet after it lands one short. ', c);

            const p2 = document.createElement('div');
            p2.className = 'pv-p';
            p2.textContent = 'Both sides agree on the first three fields, which is why it looks like a tick-rate problem until you read the struct.';

            box.append(p1, p2);
            return box;
        },
        css(v, sel, which) {
            const t = which === 'before' ? STOCK : v;
            return typeRules(sel + ' .pv-copy', t.face, t.size, t.leading);
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

// Stand alone if the dashboard is not loaded: nothing else would ever call apply.
if (REG.subs.size === 0) apply(spec.defaults);
