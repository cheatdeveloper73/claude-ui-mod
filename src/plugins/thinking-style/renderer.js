/* claude-ui-mod :: thinking-style (renderer)
 *
 * Restyles the Code transcript's thinking blocks and formats their inline
 * Markdown. Gemini and GPT reasoning summaries use Markdown delimiters; Claude
 * thinking is ordinarily plain text, so blocks with no delimiter stay untouched.
 *
 * Formatting is intentionally inline-only. Thinking nodes stream under React
 * ownership, and their stock pre-wrap whitespace already represents paragraphs
 * and line breaks. Replacing that with headings, lists, tables or paragraph nodes
 * caused broken line layout and horizontal-rule artefacts. Code, emphasis,
 * strikethrough and HTTPS links need no change to that structure.
 *
 * React replaces the text node as a thought streams. The observer reformats each
 * replacement, while the raw-text marker makes the mutation caused by our own
 * innerHTML write a no-op. CSS still owns the visual treatment, so React may
 * replace a formatted node at any point without losing the thinking view.
 */
'use strict';

const SCOPE = '.epitaxy-transcript-typography ';
const TEXT = SCOPE + '.text-body.text-muted.italic.whitespace-pre-wrap';
const SELECTOR = '.epitaxy-transcript-typography .text-body.text-muted.italic.whitespace-pre-wrap';
// claude.ai now frames transcript groups with `div.border-l-2.border-alpha-2.pl-md`.
// Ten of the eleven in a measured transcript held a thinking block, where its rule
// landed 10px outside ours and the thought read as two grey lines with a gutter.
// The eleventh held one `.prose` paragraph — a status blurb, no thought anywhere
// inside it — and drew the same rule beside a line that is not a thought.
//
// Every one of them is dropped while this plugin is on, not just the ones holding
// a thought. The app applies this component inconsistently: most status blurbs sit
// outside it entirely, so the rule marks nothing the reader can act on, and keying
// the suppression on the contents would leave that odd one behind and admit
// whatever the app wraps next. The transcript gets exactly one kind of vertical
// rule, ours, from the spine and indent controls.
const WRAPPER = '.epitaxy-transcript-typography .border-l-2.border-alpha-2';

const MARKED = 'data-cuimod-think-md';
const RAW = '__cuimodThinkingRaw';
const RENDERED = '__cuimodThinkingRendered';

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

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hasInlineMarkdown(text) {
    return /```|`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|~~[^~\r\n]+~~|\[[^\]\r\n]+\]\(https?:\/\/[^\s)]+\)|(?:^|[^\w*])\*[^*\r\n]+\*(?=[^\w*]|$)|(?:^|[^\w_])_[^_\r\n]+_(?=[^\w_]|$)/.test(text);
}

// Only generated markup reaches innerHTML. Text and URL attributes are escaped
// before substitution, and link targets are restricted to explicit HTTP(S).
function formatInlineMarkdown(text) {
    const code = [];
    let s = String(text == null ? '' : text);
    const holdCode = (content, block) => {
        const token = '￰CODE_' + code.length + '_￱';
        code.push('<code class="cuimod-think-code' + (block ? ' block' : '') + '">' + escapeHtml(content) + '</code>');
        return token;
    };

    s = s.replace(/(^|\r?\n)```[^\r\n]*\r?\n?([\s\S]*?)```/g,
        (_, lead, content) => lead + holdCode(content, true));
    s = s.replace(/`([^`\r\n]+)`/g, (_, content) => holdCode(content, false));
    s = escapeHtml(s);

    s = s.replace(/\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a class="cuimod-think-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*\*([^*\r\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~\r\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^\w*])\*([^*\r\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\r\n]+)_(?=[^\w_]|$)/g, '$1<em>$2</em>');
    return s.replace(/￰CODE_(\d+)_￱/g, (_, i) => code[Number(i)] || '');
}

function rules(sel, v) {
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
${sel} + ${sel}::before { content: none; }
${sel}::first-line { color: ${v.firstLine ? firstLine : ink}; }
${sel} .cuimod-think-code {
    font-family: var(--font-mono, "Cascadia Mono", Consolas, ui-monospace, monospace);
    font-size: .92em;
    padding: 1px 5px;
    border-radius: 4px;
    background: color-mix(in srgb, currentColor 10%, transparent);
    white-space: pre-wrap;
}
${sel} .cuimod-think-code.block {
    display: block;
    margin: .45em 0;
    padding: 7px 10px;
    overflow-x: auto;
    border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
${sel} .cuimod-think-link {
    color: ${v.useThemeColor ? 'hsl(var(--text-200))' : ink};
    text-decoration: underline;
    text-underline-offset: 2px;
}
${sel} strong { font-weight: 600; }
${sel} em { font-style: italic; }
${sel} del { text-decoration: line-through; opacity: .7; }
`;
}

// Kept out of rules() because rules() is reused for the preview stage, which has
// no app wrapper and must not emit a transcript-wide selector.
function wrapperRules() {
    return `
${WRAPPER} { border-left-width: 0; padding-left: 0; }
`;
}

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

let currentConfig = null;

function forgetNode(node) {
    delete node[RAW];
    delete node[RENDERED];
    node.removeAttribute(MARKED);
}

function formatNode(node) {
    if (!currentConfig || !currentConfig.enabled || !currentConfig.renderMarkdown || !node.isConnected) return;
    const raw = node.textContent || '';
    // innerHTML turns delimiters into markup, so textContent is the rendered
    // string rather than the source string. React's next source replacement is
    // distinguishable because it differs from this saved rendered text.
    if (node.getAttribute(MARKED) === '1' && node[RENDERED] === raw) return;
    if (!hasInlineMarkdown(raw)) { forgetNode(node); return; }
    node[RAW] = raw;
    node.innerHTML = formatInlineMarkdown(raw);
    node[RENDERED] = node.textContent;
    node.setAttribute(MARKED, '1');
}

function restoreNode(node) {
    const raw = node[RAW];
    // React can replace its text between the last observer delivery and a hot
    // reload. Preserve that newer source rather than restoring an old snapshot.
    if (raw != null && node.textContent === node[RENDERED]) node.textContent = raw;
    forgetNode(node);
}

function restoreAll() {
    for (const node of document.querySelectorAll('[' + MARKED + '="1"]')) restoreNode(node);
}

function scanAndFormat() {
    if (!currentConfig || !currentConfig.enabled || !currentConfig.renderMarkdown) { restoreAll(); return; }
    for (const node of document.querySelectorAll(SELECTOR)) formatNode(node);
}

function apply(v) {
    currentConfig = v;
    style.textContent = v.enabled ? rules(TEXT, v) + wrapperRules() : '';
    scanAndFormat();
}

ctx.observe(document.documentElement, { childList: true, subtree: true, characterData: true }, scanAndFormat);
cuimod.onSessionChange(scanAndFormat);
ctx.onDispose(() => { restoreAll(); try { style.remove(); } catch (_) {} });

const SAMPLE = `Checking \`net_player_state.cpp\` before accepting the **first three fields**.

\`\`\`cpp
uint16_t x, y;
\`\`\``;

const spec = {
    plugin: 'thinking-style',
    title: 'Thinking style',
    description: 'Typography, framing, and inline Markdown for thinking blocks in the transcript.',
    defaults: {
        enabled: true,
        renderMarkdown: true,
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
        { key: 'enabled', type: 'toggle', label: 'Enabled', hint: 'Off leaves the app’s muted italic alone.', group: 'Type' },
        { key: 'renderMarkdown', type: 'toggle', label: 'Inline Markdown', hint: 'Formats code, emphasis, strikethrough, links, and fenced code without changing thought layout.', group: 'Format' },
        { key: 'face', type: 'combo', label: 'Typeface', options: FACES, group: 'Type' },
        { key: 'size', type: 'slider', label: 'Size', min: 10, max: 22, step: 0.5, unit: 'px', group: 'Type' },
        { key: 'leading', type: 'slider', label: 'Line height', min: 1.1, max: 2.2, step: 0.01, unit: '×', hint: 'Also scales the blank lines the model emits between paragraphs.', group: 'Type' },
        { key: 'measure', type: 'slider', label: 'Measure', min: 40, max: 200, step: 1, unit: 'ch', hint: 'Line length. The column still caps it.', group: 'Type' },
        { key: 'useThemeColor', type: 'toggle', label: 'Follow theme colors', hint: 'On, colors come from the app’s tokens and track light/dark.', group: 'Color' },
        { key: 'color', type: 'color', label: 'Text color', hint: 'Used only when “Follow theme colors” is off.', group: 'Color' },
        { key: 'spineColor', type: 'color', label: 'Spine and label color', group: 'Color' },
        { key: 'spineAlpha', type: 'slider', label: 'Spine opacity', min: 0, max: 1, step: 0.01, group: 'Color' },
        { key: 'firstLine', type: 'toggle', label: 'Brighten first line', hint: 'Anchors the eye at the start of each block.', group: 'Color' },
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
        node(which) {
            const d = document.createElement('div');
            d.className = 'pv-text';
            if (which === 'after') d.innerHTML = formatInlineMarkdown(SAMPLE);
            else d.textContent = SAMPLE;
            return d;
        },
        css(v, sel, which) { return which === 'before' ? stockRules(sel + ' .pv-text') : rules(sel + ' .pv-text', v); },
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
