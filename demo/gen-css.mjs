/* Pull the real CSS out of the plugin sources so the demo cannot drift from
 * what the mod actually renders. Writes src/generated-css.js.
 *
 * Three shapes of stylesheet occur in the plugins:
 *   - a plain `const CSS = ` template literal (task-rail, dashboard, throughput),
 *   - an arrow function of the plugin's settings (subagents, queue, and
 *     usage-bar's HOST_CSS), evaluated here with the plugin's own defaults,
 *   - usage-bar's barCss, which HOST_CSS calls, taken from the same file.
 *
 * The plugins run inside a shadow root; the demo does not. Every rule is
 * therefore scoped to a wrapper class, `:host` becomes that class, and keyframe
 * names are suffixed per plugin — `pulse` means two different animations in
 * task-rail and usage-bar, and one global sheet would let one win.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugins = path.join(here, '..', 'src', 'plugins');

const read = (name) => fs.readFileSync(path.join(plugins, name, 'renderer.js'), 'utf8');

const BT = '`';

function literal(src, decl) {
    const i = src.indexOf(decl);
    if (i === -1) throw new Error('declaration not found: ' + decl);
    const start = i + decl.length;
    const end = src.indexOf('\n' + BT + ';', start);
    if (end === -1) throw new Error('unterminated literal after: ' + decl);
    const body = src.slice(start, end);
    if (body.includes('${')) throw new Error('literal after ' + decl + ' interpolates; evaluate it instead');
    return body;
}

// A template literal that interpolates is evaluated with the free names the
// plugin would have had at rest: its own defaults, speed 1, no reduced motion.
function evalLiteral(src, decl, names) {
    const i = src.indexOf(decl);
    if (i === -1) throw new Error('declaration not found: ' + decl);
    const start = i + decl.length;
    const end = src.indexOf('\n' + BT + ';', start);
    if (end === -1) throw new Error('unterminated literal after: ' + decl);
    const keys = Object.keys(names);
    // eslint-disable-next-line no-new-func
    return new Function(...keys, 'return ' + BT + src.slice(start, end) + BT + ';')(...Object.values(names));
}

// The balanced {...} that starts at or after `from`.
function block(src, from) {
    let depth = 0;
    let j = src.indexOf('{', from);
    const open = j;
    for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
    }
    return src.slice(open, j + 1);
}

// `const DEF = { ... };` evaluated as an object literal.
// eslint-disable-next-line no-new-func
const defOf = (src) => new Function('return ' + block(src, src.indexOf('const DEF = {')))();

function fnBody(src, signature) {
    const i = src.indexOf(signature);
    if (i === -1) throw new Error('function not found: ' + signature);
    return block(src, i).slice(1, -1);
}

// ---------------------------------------------------------------- scoping
function renameKeyframes(css, suffix) {
    const names = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    for (const n of new Set(names)) {
        css = css.replace(new RegExp('@keyframes\\s+' + n + '\\b', 'g'), '@keyframes ' + n + suffix);
        // animation shorthand and animation-name both reference the bare name.
        css = css.replace(new RegExp('(animation(?:-name)?\\s*:[^;}]*?)\\b' + n + '\\b', 'g'), '$1' + n + suffix);
    }
    return css;
}

function prefixSelector(sel, cls) {
    return sel
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            if (s.startsWith(':host')) return s.replace(/^:host(\([^)]*\))?/, '.' + cls);
            if (s === '*') return '.' + cls + ' *, .' + cls;
            return '.' + cls + ' ' + s;
        })
        .join(', ');
}

// Walks top-level blocks. @keyframes bodies pass through untouched, @media
// bodies are scoped recursively, everything else gets its selector prefixed.
// Comments are stripped first: some of the plugins' comments contain braces.
function scope(css, cls) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let out = '';
    let i = 0;
    while (i < css.length) {
        const brace = css.indexOf('{', i);
        if (brace === -1) { out += css.slice(i); break; }
        const head = css.slice(i, brace).trim();
        let depth = 0;
        let j = brace;
        for (; j < css.length; j++) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}' && --depth === 0) break;
        }
        const body = css.slice(brace + 1, j);
        if (/^@keyframes/i.test(head)) {
            out += '\n' + head + ' {' + body + '}\n';
        } else if (/^@media/i.test(head)) {
            out += '\n' + head + ' {\n' + scope(body, cls) + '\n}\n';
        } else if (head.startsWith('@')) {
            out += '\n' + head + ' {' + body + '}\n';
        } else {
            out += '\n' + prefixSelector(head, cls) + ' {' + body + '}\n';
        }
        i = j + 1;
    }
    return out;
}

// Remotion captures each frame after a seek, so wall-clock CSS transitions and
// animations would render at whatever state they happened to be in. Every
// motion in the demo is driven from the frame instead; the sheets keep the
// look and give up their own timing.
const FREEZE = (cls) => `
.${cls}, .${cls} * { transition: none !important; animation: none !important; }
`;
const prepare = (css, cls, suffix) => scope(renameKeyframes(css, suffix), cls) + FREEZE(cls);

// ---------------------------------------------------------------- build
const railCss = prepare(literal(read('task-rail'), 'const CSS = ' + BT), 'cui-rail', '__rail');
const dashCss = prepare(literal(read('dashboard'), 'const CSS = ' + BT), 'cui-dash', '__dash');
const tpCss = prepare(literal(read('throughput'), 'const CSS = ' + BT), 'cui-tp', '__tp');

// usage-bar: HOST_CSS is the whole shadow sheet — .wrap's own placement rules
// plus barCss, which it calls. Both come from the plugin, with its own spec
// defaults as the settings.
const usageSrc = read('usage-bar');
// eslint-disable-next-line no-new-func
const barCssFn = new Function(
    'return function barCss(prefix, value) {' + fnBody(usageSrc, 'function barCss(prefix, value)') + '}',
)();
// eslint-disable-next-line no-new-func
const usageDefaults = new Function(
    'return ' + block(usageSrc, usageSrc.indexOf('defaults: {', usageSrc.indexOf('const spec = {'))),
)();
const usageCss = prepare(
    evalLiteral(usageSrc, 'const HOST_CSS = (value) => ' + BT, { value: usageDefaults, barCss: barCssFn }),
    'cui-usage',
    '__usage',
);

const saSrc = read('subagents');
const saCss = prepare(
    evalLiteral(saSrc, 'const CSS = () => ' + BT, {
        V: defOf(saSrc),
        MS: (n) => n,
        CHAT_CLAMP: Number(saSrc.match(/const CHAT_CLAMP = (\d+)/)[1]),
    }),
    'cui-sa',
    '__sa',
);

const qSrc = read('queue');
const qCss = prepare(
    evalLiteral(qSrc, 'const CSS = () => ' + BT, { V: defOf(qSrc), MS: (n) => n }),
    'cui-q',
    '__q',
);

const out = `// GENERATED by gen-css.mjs from ../src/plugins — do not edit by hand.
export const RAIL_CSS = ${JSON.stringify(railCss)};
export const DASH_CSS = ${JSON.stringify(dashCss)};
export const USAGE_CSS = ${JSON.stringify(usageCss)};
export const TP_CSS = ${JSON.stringify(tpCss)};
export const SA_CSS = ${JSON.stringify(saCss)};
export const Q_CSS = ${JSON.stringify(qCss)};
export const USAGE_DEFAULTS = ${JSON.stringify(usageDefaults)};
`;
fs.writeFileSync(path.join(here, 'src', 'generated-css.js'), out);
for (const [n, c] of [['rail', railCss], ['dash', dashCss], ['usage', usageCss], ['tp', tpCss], ['sa', saCss], ['queue', qCss]])
    console.log(n.padEnd(6) + c.length + 'B');
