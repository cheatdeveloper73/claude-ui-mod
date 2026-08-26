/* claude-ui-mod :: thinking-style (renderer)
 *
 * Restyles the Code transcript's thinking blocks. Pure CSS: one <style> tag in
 * document.head, no DOM mutation, no observer, nothing to keep in sync.
 *
 * Why CSS-only. The thinking text lives in a React-owned node that re-renders
 * per token while it streams, so anything inserted *inside* it is destroyed on
 * the next token, and a `class` added to it is clobbered whenever React rewrites
 * className. Styling from a stylesheet touches neither, and ::before is a
 * pseudo-element rather than a child, so the label survives too.
 *
 * Two different components render thinking text: one wraps it in a
 * `group/thinking` container (it carries a hover control), one drops it bare
 * into the message column with no wrapper at all — 9 wrapped and 11 bare in one
 * transcript, which is why keying on the container styled only some of them.
 * The text element is the common hook and carries the same four classes in both.
 *
 * The transcript's own typography rule is
 *   .epitaxy-root .epitaxy-transcript-typography :where(.text-body):not(button,…)
 * at (0,2,1), setting font-size/line-height from --chat-body/--chat-leading.
 * Prefixing with that same ancestor puts these rules at (0,6,0), which beats it
 * without !important, and scopes everything here to the transcript.
 *
 * Nothing hides, clamps, truncates or collapses: whitespace-pre-wrap and
 * break-words are left as the app set them, so every character still renders.
 */
'use strict';

const SCOPE = '.epitaxy-transcript-typography ';
const TEXT = SCOPE + '.text-body.text-muted.italic.whitespace-pre-wrap';

const FACES = [
    { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
    { value: 'Tahoma, Verdana, sans-serif', label: 'Tahoma' },
    { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
    { value: 'var(--font-serif)', label: 'Anthropic Serif' },
    { value: 'Georgia, serif', label: 'Georgia' },
    { value: 'var(--font-anthropic-sans, ui-sans-serif), system-ui, sans-serif', label: 'Anthropic Sans (stock)' },
    { value: '"Cascadia Mono", Consolas, ui-monospace, monospace', label: 'Cascadia Mono' },
    { value: 'Consolas, ui-monospace, monospace', label: 'Consolas' },
];

const style = document.createElement('style');
style.id = 'cuimod-thinking-style';
(document.head || document.documentElement).appendChild(style);
ctx.onDispose(() => { try { style.remove(); } catch (_) {} });

// One generator for both the live stylesheet and the dashboard's "after" stage,
// so the preview is the real rules at real size, not a drawing of them.
function rules(sel, v) {
    // Theme tokens follow light/dark for free; a picked colour is absolute.
    const ink = v.useThemeColor ? 'hsl(var(--text-300))' : v.color;
    const firstLine = v.useThemeColor ? 'hsl(var(--text-200))' : v.color;
    const spineInk = v.useThemeColor ? 'hsl(var(--text-500))' : v.spineColor;
    const spineHoverInk = v.useThemeColor ? 'hsl(var(--text-400))' : v.spineColor;
    const spine = `color-mix(in srgb, ${spineInk} ${Math.round(v.spineAlpha * 100)}%, transparent)`;
    const spineHover = `color-mix(in srgb, ${spineHoverInk} ${Math.min(100, Math.round(v.spineAlpha * 190))}%, transparent)`;

    return `
${sel} {
    font-family: ${v.face};
    font-style: normal;
    font-size: ${v.size}px;
    line-height: ${v.leading};
    color: ${ink};
    white-space: pre-wrap;

    /* The indent is added back because the app sets border-box, and the
     * measure is about the text, not the box. */
    max-width: calc(${v.measure}ch + ${v.indent}px);

    border-left: ${v.spineWidth}px solid ${spine};
    padding-left: ${v.indent}px;
    margin: ${v.gap}px 0 ${v.gap + 2}px;
    transition: border-color 160ms ease;

    text-wrap: pretty;
}
${sel}:hover { border-left-color: ${spineHover}; }

${sel}::before {
    content: ${v.showLabel ? JSON.stringify(v.labelText) : 'none'};
    display: block;
    font-family: var(--font-ui, inherit);
    font-size: ${v.labelSize}px;
    font-style: normal;
    font-weight: 500;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: ${v.useThemeColor ? 'hsl(var(--text-500) / .75)' : v.spineColor};
    margin-bottom: 7px;
    user-select: none;
}
/* A turn that thinks three times in a row is labelled once. */
${sel} + ${sel}::before { content: none; }

${sel}::first-line { color: ${v.firstLine ? firstLine : ink}; }
`;
}

// What the app does on its own, measured from the live transcript: muted italic
// anthropic-sans at 14/20, no framing, running the full column width.
function stockRules(sel) {
    return `
${sel} {
    font-family: var(--font-ui);
    font-style: italic;
    font-size: 14px;
    line-height: 20px;
    color: hsl(var(--text-500));
    white-space: pre-wrap;
    max-width: none;
    margin: 0;
}
`;
}

function apply(v) {
    style.textContent = v.enabled ? rules(TEXT, v) : '';
}

// A real newline pair in the sample, because the blank lines the model emits are
// exactly what the leading knob scales.
const SAMPLE = `The user is asking about the wire format, so the answer has to come from the struct definition rather than from the field names. Checking the packed layout before I say anything about offsets.

Both sides agree on the first three fields; the fourth is where the client reads a u16 and the server writes a u32.`;

const spec = {
    plugin: 'thinking-style',
    title: 'Thinking style',
    description: 'Typography and framing for thinking blocks in the transcript.',
    defaults: {
        enabled: true,
        face: 'Verdana, Geneva, sans-serif',
        size: 14,
        leading: 1.62,
        measure: 62,
        useThemeColor: true,
        color: '#c3c2b7',
        spineColor: '#97958d',
        spineAlpha: 0.3,
        spineWidth: 2,
        indent: 14,
        gap: 10,
        showLabel: true,
        labelText: 'thinking',
        labelSize: 10,
        firstLine: true,
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled',
          hint: 'Off leaves the app’s muted italic alone.', group: 'Type' },
        { key: 'face', type: 'combo', label: 'Typeface', options: FACES, group: 'Type' },
        { key: 'size', type: 'slider', label: 'Size', min: 10, max: 22, step: 0.5, unit: 'px', group: 'Type' },
        { key: 'leading', type: 'slider', label: 'Line height', min: 1.1, max: 2.2, step: 0.01, unit: '×',
          hint: 'Also scales the blank lines the model emits between paragraphs.', group: 'Type' },
        { key: 'measure', type: 'slider', label: 'Measure', min: 40, max: 200, step: 1, unit: 'ch',
          hint: 'Line length. The classic 62–70 is a convention, not a limit — the column caps it anyway.',
          group: 'Type' },

        { key: 'useThemeColor', type: 'toggle', label: 'Follow theme colours',
          hint: 'On, colours come from the app’s tokens and track light/dark.', group: 'Colour' },
        { key: 'color', type: 'color', label: 'Text colour',
          hint: 'Used only when “Follow theme colours” is off.', group: 'Colour' },
        { key: 'spineColor', type: 'color', label: 'Spine and label colour', group: 'Colour' },
        { key: 'spineAlpha', type: 'slider', label: 'Spine opacity', min: 0, max: 1, step: 0.01, group: 'Colour' },
        { key: 'firstLine', type: 'toggle', label: 'Brighten first line',
          hint: 'Anchors the eye at the start of each block.', group: 'Colour' },

        { key: 'spineWidth', type: 'slider', label: 'Spine width', min: 0, max: 6, step: 1, unit: 'px', group: 'Frame' },
        { key: 'indent', type: 'slider', label: 'Indent', min: 0, max: 40, step: 1, unit: 'px', group: 'Frame' },
        { key: 'gap', type: 'slider', label: 'Vertical gap', min: 0, max: 40, step: 1, unit: 'px', group: 'Frame' },

        { key: 'showLabel', type: 'toggle', label: 'Show label', group: 'Label' },
        { key: 'labelText', type: 'text', label: 'Label text', group: 'Label' },
        { key: 'labelSize', type: 'slider', label: 'Label size', min: 8, max: 16, step: 0.5, unit: 'px', group: 'Label' },
    ],
    apply,
    preview: {
        title: 'Preview — thinking block',
        beforeLabel: 'stock app, plugin off',
        node() {
            const d = document.createElement('div');
            d.className = 'pv-text';
            d.textContent = SAMPLE;
            return d;
        },
        css(v, sel, which) {
            return which === 'before' ? stockRules(sel + ' .pv-text') : rules(sel + ' .pv-text', v);
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
