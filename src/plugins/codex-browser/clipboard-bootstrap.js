'use strict';
const fs = require('node:fs');

function clipboardBootstrap(servicePath) {
    const source = fs.readFileSync(servicePath, 'utf8');
    const match = /function ([$\w]+)\(([$\w]+)\)\{return`([^`]*const installPageClipboardBridge = \$\{([$\w]+)\.toString\(\)\};[^`]*)`\}/.exec(source);
    if (!match) throw Error('official clipboard bootstrap contract unavailable');
    const template = match[3], fnName = match[4];
    const end = source.lastIndexOf(';', match.index), start = source.lastIndexOf(fnName + '=', end) + fnName.length + 1;
    const fn = source.slice(start, end);
    if (!/^[$\w]+=>\{/.test(fn) || !fn.endsWith('}')) throw Error('official clipboard helper unavailable');
    const name = template.match(/\$\{([$\w]+)\}/)?.[1];
    const assignment = name && new RegExp('(?:var |,)' + name + '=("(?:\\\\.|[^"\\\\])*")').exec(source);
    if (!assignment) throw Error('official clipboard helper prefix unavailable');
    const rendered = template.replace('${' + name + '}', JSON.parse(assignment[1])).replace('${' + fnName + '.toString()}', fn);
    const parts = rendered.split('${JSON.stringify(' + match[2] + ')}');
    if (parts.length !== 2) throw Error('official clipboard template changed');
    return (candidate, bindings) => {
        if (typeof candidate !== 'string' || !candidate.startsWith(parts[0]) || !candidate.endsWith(parts[1])) return null;
        const encoded = candidate.slice(parts[0].length, candidate.length - parts[1].length);
        let binding;
        try { binding = JSON.parse(encoded); } catch (_) { return null; }
        return typeof binding === 'string' && bindings.has(binding) && JSON.stringify(binding) === encoded ? binding : null;
    };
}
module.exports = { clipboardBootstrap };
