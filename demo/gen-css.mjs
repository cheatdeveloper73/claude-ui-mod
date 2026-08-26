/* Pull the real CSS out of the plugin sources so the demo cannot drift from
 * what the mod actually renders. Writes src/generated-css.js.
 *
 * task-rail and dashboard hold a plain `const CSS = ` template literal.
 * usage-bar builds its CSS from a pure function of its settings, so that one is
 * evaluated with the plugin's own defaults.
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

function literal(src, decl) {
    const i = src.indexOf(decl);
    if (i === -1) throw new Error('declaration not found: ' + decl);
    const start = i + decl.length;
    const end = src.indexOf('\n`;', start);
    if (end === -1) throw new Error('unterminated literal after: ' + decl);
    const body = src.slice(start, end);
    if (body.includes('${')) throw new Error('literal after ' + decl + ' interpolates; evaluate it instead');
    return body;
}

function fnBody(src, signature) {
    const i = src.indexOf(signature);
    if (i === -1) throw new Error('function not found: ' + signature);
    let depth = 0;
    let j = src.indexOf('{', i);
    const from = j;
    for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
    }
    return src.slice(from + 1, j);
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
function scope(css, cls) {
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
const railCss = prepare(literal(read('task-rail'), 'const CSS = `'), 'cui-rail', '__rail');
const dashCss = prepare(literal(read('dashboard'), 'const CSS = `'), 'cui-dash', '__dash');

const usageSrc = read('usage-bar');
// eslint-disable-next-line no-new-func
const barCss = new Function('p', 'v', fnBody(usageSrc, 'function barCss(p, v)'));
const usageDefaults = {
    width: 96, thickness: 4, gap: 12, idle: 0.55, intensity: 1, glow: false,
    warn: 0.6, danger: 0.85,
    ctxCalm: '#8ecae6', ctxWarn: '#a9a0f0', ctxHot: '#cf8ef5',
    limCalm: '#9fd8a8', limWarn: '#f3cb8a', limHot: '#f5949a',
};
const usageCss = prepare(barCss('', usageDefaults), 'cui-usage', '__usage');

const out = `// GENERATED by gen-css.mjs from ../src/plugins — do not edit by hand.
export const RAIL_CSS = ${JSON.stringify(railCss)};
export const DASH_CSS = ${JSON.stringify(dashCss)};
export const USAGE_CSS = ${JSON.stringify(usageCss)};
`;
fs.writeFileSync(path.join(here, 'src', 'generated-css.js'), out);
console.log('rail  ' + railCss.length + 'B');
console.log('dash  ' + dashCss.length + 'B');
console.log('usage ' + usageCss.length + 'B');
