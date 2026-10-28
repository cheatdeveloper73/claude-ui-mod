'use strict';
const fs = require('node:fs');
const FIELDS = ['getPreviewUrlForTab', 'getNavCommitEpoch', 'checkToolAccessGate', 'hasPreviewContext', 'describeOriginlessPreviewTab'];

function nativeSurfaces(cache = require.cache, readSource = file => fs.readFileSync(file, 'utf8')) {
    let preview, launch;
    for (const [filename, item] of Object.entries(cache)) {
        let values;
        try { values = [item.exports, ...Object.values(item.exports || {})]; } catch (_) { continue; }
        for (const value of values) {
            if (!value || typeof value !== 'object') continue;
            if (typeof value.getPreviewTabs === 'function' && typeof value.evaluateInPreview === 'function'
                && typeof value._test?.tabForTest === 'function') preview = value;
            if (typeof value.loadBrowserPreview === 'function' && typeof value.getBrowserPreviewForSession === 'function') {
                launch = value;
                if (!preview) {
                    try {
                        const source = readSource(filename), functions = {};
                        for (const field of FIELDS) {
                            const names = [...source.matchAll(new RegExp(field + ':\\(\\)=>([$\\w]+)(?=,|\\})', 'g'))];
                            if (names.length !== 1) throw Error('ambiguous native field');
                            const symbol = names[0][1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const aliases = [...source.matchAll(new RegExp('Object\\.defineProperty\\(exports,"([^"]+)",\\{enumerable:!0,get:function\\(\\)\\{return ' + symbol + '\\}\\}\\)', 'g'))];
                            if (aliases.length !== 1 || typeof item.exports[aliases[0][1]] !== 'function') throw Error('native field is not exported');
                            functions[field] = item.exports[aliases[0][1]];
                        }
                        preview = functions;
                    } catch (_) { /* Private namespaces are deliberately not guessed or evaluated. */ }
                }
            }
        }
        if (preview && launch) return { preview, launch };
    }
    throw Error('native browser contracts unavailable; original browser tools remain available');
}
module.exports = { nativeSurfaces };
