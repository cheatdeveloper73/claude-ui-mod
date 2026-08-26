/* claude-ui-mod :: probe (main) — EXAMPLE, not loaded by default
 *
 * Copy this directory to src/plugins/probe/ to activate it; it is picked up
 * live, with no re-patch and no restart. Delete it again when you are done.
 *
 * Why it exists: the desktop app's console.log goes to a stdout nobody is
 * capturing, so "did my change take effect?" cannot be answered by reading a
 * log. This writes evidence to disk instead.
 *
 * Two rules it demonstrates:
 *   - It writes to .probe/, NEVER under src/. The baked loader watches src/,
 *     so a write there would reload the host, which would write again, forever.
 *   - Every resource comes from a ctx helper, so a reload cannot leak it.
 *
 * Each generation heartbeats to its own file (beat-<generation>.json). After a
 * reload exactly one file should keep updating; a second live file is a leak.
 */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
    const dir = path.join(ctx.boot.MOD_DIR, '.probe');
    const gen = ctx.boot.generation;
    const beat = path.join(dir, 'beat-' + gen + '.json');
    const events = path.join(dir, 'events.log');

    fs.mkdirSync(dir, { recursive: true });

    const event = (kind, extra) => {
        try {
            fs.appendFileSync(events, JSON.stringify({ t: Date.now(), gen, kind, ...extra }) + '\n');
        } catch (_) {}
    };

    event('load');

    ctx.every(1000, () => {
        try { fs.writeFileSync(beat, JSON.stringify({ t: Date.now(), gen }, null, 1)); } catch (_) {}
    });

    // The renderer half calls this once it has something worth recording.
    ctx.method('report', (p) => {
        try { fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(p, null, 1)); } catch (_) {}
        event('report', { keys: Object.keys(p || {}) });
        return true;
    });

    // Evaluate in the page's own world. Only main can do this: the isolated
    // world sees neither page-world objects nor React fiber expandos.
    ctx.method('page', async (p, event_) => {
        try { return await event_.sender.executeJavaScript(String(p && p.code), false); }
        catch (e) { return { error: String((e && e.message) || e) }; }
    });

    ctx.onDispose(() => event('dispose'));
};
