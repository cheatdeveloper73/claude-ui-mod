/* claude-ui-mod :: context-management (main)
 *
 * Exposes the router's context-window bookkeeping to the isolated renderer.
 *
 * There is deliberately nothing sensitive to filter here. Note and history
 * results are Fernet-encrypted by the backend and decrypted inside inference, so
 * the router never holds their plaintext; what /contextz reports is window ids,
 * counts, the drift verdict, and the one plaintext line the backend itself
 * returns for the thread hint.
 */
'use strict';
const http = require('http');

const ROUTER = process.env.CUIMOD_ROUTER_URL || 'http://127.0.0.1:8789';
const SESSION_RE = /^[0-9a-fA-F-]{8,64}$/;

module.exports = function (ctx) {
    ctx.method('status', (p) => new Promise((resolve, reject) => {
        const sessionId = typeof p?.sessionId === 'string' && SESSION_RE.test(p.sessionId)
            ? p.sessionId : '';
        const req = http.get(ROUTER + '/contextz' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''),
            { timeout: 5000 }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > 1024 * 1024) { req.destroy(new Error('context status too large')); return; }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error('router ' + res.statusCode)); return; }
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (error) { reject(error); }
                });
            });
        req.on('timeout', () => req.destroy(new Error('router timeout')));
        req.on('error', reject);
    }));
};
