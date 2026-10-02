/* claude-ui-mod :: waiting-label (main)
 *
 * React keeps the selected model and its display label in the page world's
 * scope store. The renderer can rewrite the native status chip, but it cannot
 * read that store from the isolated world, so this is the narrow bridge for
 * one metadata snapshot.
 */
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
    const pageSource = fs.readFileSync(path.join(ctx.dir, 'page.js'), 'utf8');

    ctx.method('native', async (_params, event) => {
        if (!event?.sender || event.sender.isDestroyed()) return null;
        return event.sender.executeJavaScript(pageSource, false);
    });
};
