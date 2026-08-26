/* claude-ui-mod :: usage-bar (main)
 *
 * Rate-limit utilisation, read straight off disk.
 *
 * The desktop samples its own utilisation into
 * %APPDATA%/Claude/plan-usage-history.json every ~4.5 minutes and keeps 30 days.
 * Schema v2 is { version, samples: [{ t, org, u: { fh, sd, … } }] }, with the
 * bucket keys abbreviated by the app as:
 *    fh five_hour   sd seven_day   so seven_day_opus   sn seven_day_sonnet
 *    oa seven_day_oauth_apps   cw seven_day_cowork
 *    om seven_day_omelette     op omelette_promotional   xu extra usage
 * Values are whole percents. History is what makes a sparkline possible.
 *
 * Reset times are NOT in that file; the renderer scrapes those off the app's own
 * banner before hiding it.
 *
 * Context is NOT read here. It comes from the CLI itself, over the app's own
 * LocalSessions.getContextUsage channel — see the renderer. Nothing in this mod
 * needs to know which model is running or how big its window is.
 *
 * The plan file is 250KB+ and rewritten atomically, so it is parsed only when
 * mtime moves.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLAN_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'plan-usage-history.json');
const SERIES_MAX = 64;

const BUCKETS = {
    fh: { id: 'five_hour', label: '5h', title: 'Session (5 hour)' },
    sd: { id: 'seven_day', label: '7d', title: 'Weekly (7 day)' },
    so: { id: 'seven_day_opus', label: '7d opus', title: 'Weekly, Opus' },
    sn: { id: 'seven_day_sonnet', label: '7d sonnet', title: 'Weekly, Sonnet' },
    oa: { id: 'seven_day_oauth_apps', label: '7d apps', title: 'Weekly, OAuth apps' },
    cw: { id: 'seven_day_cowork', label: '7d cowork', title: 'Weekly, Cowork' },
    om: { id: 'seven_day_omelette', label: '7d om', title: 'Weekly, Omelette' },
    op: { id: 'omelette_promotional', label: 'om promo', title: 'Omelette promotional' },
    xu: { id: 'extra_usage', label: 'extra', title: 'Extra usage' },
};

module.exports = function (ctx) {
    let cache = null;   // { mtime, size, value }

    function readPlan() {
        let st;
        try { st = fs.statSync(PLAN_FILE); } catch (_) { return { missing: true, buckets: BUCKETS }; }
        if (cache && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.value;

        let doc;
        try { doc = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); }
        catch (err) { return { error: String(err && err.message), buckets: BUCKETS }; }

        const samples = Array.isArray(doc && doc.samples) ? doc.samples : [];
        const last = samples[samples.length - 1] || null;
        const org = last && last.org;

        // Only this org's samples: a second account on the same machine would
        // otherwise interleave its utilisation into the same line.
        const mine = org ? samples.filter((s) => s.org === org) : samples;
        const tail = mine.slice(-SERIES_MAX);

        const series = {};
        for (const key of Object.keys(BUCKETS)) {
            const line = tail.map((s) => (s.u && typeof s.u[key] === 'number' ? s.u[key] : null));
            if (line.some((v) => v !== null)) series[key] = line;
        }

        const value = {
            at: last ? last.t : null,
            latest: (last && last.u) || {},
            series,
            samples: mine.length,
            buckets: BUCKETS,
        };
        cache = { mtime: st.mtimeMs, size: st.size, value };
        return value;
    }

    ctx.method('plan', () => readPlan());
};
