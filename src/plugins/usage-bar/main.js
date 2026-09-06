/* claude-ui-mod :: usage-bar (main)
 *
 * The native Desktop ring is the account-usage surface. Claude plan history is
 * local; alternate-provider quotas and forecasts come from the router's
 * sanitized loopback API so the renderer never receives credentials.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const PLAN_FILE = process.env.CUIMOD_PLAN_USAGE_FILE
    || path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'plan-usage-history.json');
const SERIES_MAX = 64;
const ROUTER = process.env.CUIMOD_ROUTER_URL || 'http://127.0.0.1:8789';

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
    let planCache = null;
    const analyticsCache = new Map();
    const analyticsInflight = new Map();

    function readPlan() {
        let stat;
        try { stat = fs.statSync(PLAN_FILE); } catch (_) { return { missing: true, buckets: BUCKETS }; }
        if (planCache && planCache.mtime === stat.mtimeMs && planCache.size === stat.size) return planCache.value;

        let doc;
        try { doc = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); }
        catch (err) { return { error: String(err && err.message), buckets: BUCKETS }; }

        const samples = Array.isArray(doc?.samples) ? doc.samples : [];
        const last = samples.at(-1) || null;
        const org = last?.org;
        const mine = org ? samples.filter((sample) => sample.org === org) : samples;
        const tail = mine.slice(-SERIES_MAX);
        const series = {};

        for (const key of Object.keys(BUCKETS)) {
            const line = tail.map((sample) => (typeof sample?.u?.[key] === 'number' ? sample.u[key] : null));
            if (line.some((value) => value !== null)) series[key] = line;
        }

        const value = {
            at: last?.t || null,
            latest: last?.u || {},
            series,
            samples: mine.length,
            buckets: BUCKETS,
        };
        planCache = { mtime: stat.mtimeMs, size: stat.size, value };
        return value;
    }

    function routerJSON(route) {
        return new Promise((resolve, reject) => {
            const req = http.get(ROUTER + route, { timeout: 15000 }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > 8 * 1024 * 1024) { req.destroy(new Error('router response too large')); return; }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error('router ' + res.statusCode)); return; }
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (err) { reject(err); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('router timeout')));
            req.on('error', reject);
        });
    }

    // The router dispatches on the model id, and this has to reach the same
    // answer without asking it. The two compiled-in arms are recognised by
    // name; anything else takes its provider from the leading segment of the
    // bare id, which is the convention every catalogue entry and adapter model
    // already follows. Naming providers here is what made this file need
    // editing every time one was added.
    function providerForModel(model) {
        const raw = String(model || '').toLowerCase();
        if (/gpt|codex|openai/.test(raw)) return 'openai';
        const bare = raw.replace(/^claude-/, '').replace(/\[1m\]/g, '');
        // Anthropic's own families, including the ones whose weekly quota is
        // model-scoped rather than plan-wide. Omitting one does not degrade to
        // the Claude arm -- the leading segment below turns it into a pool
        // provider that no adapter serves, and the popover reports the account
        // as unavailable for a model the plan meters perfectly well.
        if (!bare || /^(claude|opus|sonnet|haiku|fable|design)/.test(bare)) return 'claude';
        const head = bare.split(/[-.:/]/)[0];
        return head || 'claude';
    }

    // A provider with several quota families has to be narrowed to the one that
    // serves THIS model, or the bar shows a meter for a model the session is not
    // using. The quota names are the backend's, so they are never written here:
    // each meter row carries the family words its adapter supplied, and the
    // match is made from those. A provider with one quota family matches all of
    // its rows and is unaffected.
    function metersForModel(meters, provider, model) {
        const name = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const mine = meters.filter((meter) => meter.provider === provider);
        const narrowed = mine.filter((meter) => {
            const aliases = Array.isArray(meter.aliases) ? meter.aliases : [];
            if (!aliases.length) return false;
            const quota = String(meter.quotaId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            return aliases.some((alias) => name.includes(alias) && quota.includes(alias));
        });
        return narrowed.length ? narrowed : mine;
    }

    function compactAnalytics(value, model) {
        const provider = providerForModel(model);
        const meters = metersForModel(value?.meters || [], provider, model).map((meter) => ({
            key: meter.key,
            provider: meter.provider,
            quotaId: meter.quotaId,
            aggregate: meter.aggregate,
            forecast: meter.forecast,
            calibration: meter.calibration,
        }));
        return { generatedAt: value?.generatedAt || null, meters };
    }

    async function analytics(force, scope = 'all') {
        const cached = analyticsCache.get(scope);
        if (!force && cached && Date.now() - cached.at < 30000) return cached.value;
        if (analyticsInflight.has(scope)) return analyticsInflight.get(scope);
        const query = new URLSearchParams();
        if (force) query.set('force', '1');
        if (scope !== 'all') query.set('scope', scope);
        const route = '/usage/api' + (query.size ? '?' + query.toString() : '');
        const promise = routerJSON(route).then((value) => {
            analyticsCache.set(scope, { at: Date.now(), value });
            return value;
        }).finally(() => { analyticsInflight.delete(scope); });
        analyticsInflight.set(scope, promise);
        return promise;
    }

    async function readAllLimits(force, providers, model) {
        const plan = readPlan();
        try {
            const value = await analytics(force, providers ? 'all' : 'claude');
            const provider = providerForModel(model);
            // `pool` is whichever adapter provider serves this model, looked up
            // by its own key in the limits payload. Naming a provider here is
            // what made this file need editing every time one was added.
            const pool = provider === 'openai' || provider === 'claude'
                ? null
                : value.limits?.[provider] || null;
            return {
                observedAt: value.generatedAt || new Date().toISOString(),
                plan,
                provider,
                openai: provider === 'openai' ? value.limits?.openai || null : null,
                pool,
                analytics: compactAnalytics(value, model),
            };
        } catch (err) {
            const error = String(err && err.message);
            return { observedAt: new Date().toISOString(), plan, provider: providerForModel(model),
                openai: { error }, pool: { error }, analytics: null };
        }
    }

    const pageSource = fs.readFileSync(path.join(ctx.dir || __dirname, 'page.js'), 'utf8');

    ctx.method('plan', () => readPlan());
    // The live limit windows and the composer's model selection are React
    // state. Reading them in the page world is the only path that sees a
    // model-scoped weekly window at all; the on-disk history has none.
    ctx.method('native', async (_params, event) => {
        if (!event?.sender || event.sender.isDestroyed()) return null;
        return event.sender.executeJavaScript(pageSource, false);
    });
    ctx.method('allLimits', (params) => readAllLimits(params?.force === true, params?.providers === true, params?.model));
    ctx.method('openDashboard', () => {
        ctx.electron.shell.openExternal(ROUTER + '/usage/');
        return true;
    });
};
