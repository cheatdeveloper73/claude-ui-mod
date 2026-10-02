/* claude-ui-mod :: branding (main)
 *
 * The checked-in helmet keeps one loud key colour so the renderer can recolour
 * every copy without duplicating the artwork or trying to filter finished RGB.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KEY_COLOR = '#00FF66';
const ASSET_NAMES = new Set(['helmet.svg', 'firefight.svg']);

function readAssets(dir) {
    const source = fs.readFileSync(path.join(dir, 'helmet.svg'), 'utf8');
    const sceneSource = fs.readFileSync(path.join(dir, 'firefight.svg'), 'utf8');
    if (!/^<svg[\s>]/.test(source.trim()) || !source.includes(KEY_COLOR)) {
        throw new Error('helmet.svg must be an SVG containing the branding key colour');
    }
    if (!/^<svg[\s>]/.test(sceneSource.trim()) || !sceneSource.includes(KEY_COLOR)) {
        throw new Error('firefight.svg must be an SVG containing the branding key colour');
    }
    return { source, sceneSource };
}

module.exports = function (ctx) {
    let assets = readAssets(ctx.dir);

    ctx.watch(ctx.dir, {}, (_event, filename) => {
        const name = path.basename(String(filename || ''));
        if (name && !ASSET_NAMES.has(name)) return;
        try {
            assets = readAssets(ctx.dir);
        } catch (err) {
            ctx.log('asset reload rejected: ' + ((err && err.message) || err));
            return;
        }
        ctx.broadcast({ type: 'renderer-reload', reason: 'branding/' + (name || 'asset') });
    });

    ctx.method('helmet', () => ({ ...assets, keyColor: KEY_COLOR }));
};
