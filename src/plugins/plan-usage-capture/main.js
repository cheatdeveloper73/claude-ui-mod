'use strict';

const fs = require('fs');
const path = require('path');

const URL_PATTERN = /\/api\/organizations\/[^/]+\/usage(?:$|\?)/;

const BUCKET_NAMES = [
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_oauth_apps',
    'seven_day_cowork',
    'seven_day_omelette',
    'omelette_promotional',
    'seven_day_sonnet'
];

function truncateString(val) {
    if (typeof val !== 'string') {
        return null;
    }
    return val.length > 120 ? val.slice(0, 120) : val;
}

module.exports = function (ctx) {
    const dir = path.join(ctx.boot.MOD_DIR, '.probe');
    const file = path.join(dir, 'plan-usage-' + process.pid + '-' + Date.now() + '.jsonl');
    const resetsFile = path.join(ctx.boot.MOD_DIR, '.state', 'claude-plan-resets.json');

    function writeResets(buckets, limits) {
        try {
            const payload = { version: 1, observedAt: new Date().toISOString(), buckets: {}, scoped: [] };
            for (const name of Object.keys(buckets)) {
                const b = buckets[name];
                if (b && typeof b.resetsAt === 'string') {
                    payload.buckets[name] = { resetsAt: b.resetsAt, usedPercent: b.utilization };
                }
            }
            // A per-model weekly limit appears only here; the plan history
            // file has no bucket for it, so it is invisible without this.
            for (const item of Array.isArray(limits) ? limits : []) {
                if (item && item.kind === 'weekly_scoped' && typeof item.model === 'string'
                    && typeof item.percent === 'number' && Number.isFinite(item.percent)) {
                    payload.scoped.push({
                        model: item.model,
                        percent: item.percent,
                        group: item.group,
                        resetsAt: item.resetsAt,
                        severity: item.severity
                    });
                }
            }
            if (Object.keys(payload.buckets).length === 0 && payload.scoped.length === 0) {
                return;
            }
            const dir = path.dirname(resetsFile);
            fs.mkdirSync(dir, { recursive: true });
            const temp = resetsFile + '.tmp.' + process.pid;
            fs.writeFileSync(temp, JSON.stringify(payload), 'utf8');
            fs.renameSync(temp, resetsFile);
        } catch (error) {
            lastError = error && error.message ? error.message : String(error);
        }
    }

    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}

    let installed = false;
    let observations = 0;
    let lastObservedAt = null;
    let lastError = null;

    ctx.method('status', () => ({
        file: file,
        installed: installed,
        observations: observations,
        lastObservedAt: lastObservedAt,
        lastError: lastError
    }));

    const net = ctx.electron && ctx.electron.net;
    if (!net || typeof net.fetch !== 'function') {
        ctx.log('plan-usage-capture: net.fetch unavailable');
        return;
    }

    const previous = net.fetch;
    const original = previous && previous.__cuimodPlanUsageOriginal ? previous.__cuimodPlanUsageOriginal : previous;

    function record(body) {
        try {
            if (!body || typeof body !== 'object') {
                return;
            }

            const now = new Date().toISOString();
            const buckets = {};

            for (let i = 0; i < BUCKET_NAMES.length; i++) {
                const name = BUCKET_NAMES[i];
                const bucket = body[name];
                if (bucket && typeof bucket === 'object') {
                    const util = bucket.utilization;
                    if (typeof util === 'number' && Number.isFinite(util)) {
                        buckets[name] = {
                            utilization: util,
                            isInteger: Number.isInteger(util),
                            resetsAt: truncateString(bucket.resets_at)
                        };
                    }
                }
            }

            const out = {
                v: 1,
                observedAt: now,
                buckets: buckets
            };

            if (body.extra_usage !== null && body.extra_usage !== undefined) {
                const extra = typeof body.extra_usage === 'object' ? body.extra_usage : {};
                const monthlyLimit = typeof extra.monthly_limit === 'number' && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null;
                const usedCredits = typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits) ? extra.used_credits : null;
                const util = typeof extra.utilization === 'number' && Number.isFinite(extra.utilization) ? extra.utilization : null;

                out.extraUsage = {
                    isEnabled: Boolean(extra.is_enabled),
                    monthlyLimit: monthlyLimit,
                    monthlyLimitIsInteger: monthlyLimit !== null ? Number.isInteger(monthlyLimit) : null,
                    usedCredits: usedCredits,
                    usedCreditsIsInteger: usedCredits !== null ? Number.isInteger(usedCredits) : null,
                    utilization: util,
                    utilizationIsInteger: util !== null ? Number.isInteger(util) : null
                };
            }

            if (Array.isArray(body.limits)) {
                out.limits = body.limits.map(item => {
                    if (!item || typeof item !== 'object') {
                        return {
                            kind: null,
                            group: null,
                            percent: null,
                            percentIsInteger: null,
                            severity: null,
                            resetsAt: null,
                            model: null,
                            surface: null
                        };
                    }
                    const percent = typeof item.percent === 'number' && Number.isFinite(item.percent) ? item.percent : null;
                    const modelName = item.scope && item.scope.model && typeof item.scope.model.display_name === 'string'
                        ? item.scope.model.display_name
                        : null;
                    const surfaceName = item.scope && item.scope.surface && typeof item.scope.surface.display_name === 'string'
                        ? item.scope.surface.display_name
                        : null;

                    return {
                        kind: truncateString(item.kind),
                        group: truncateString(item.group),
                        percent: percent,
                        percentIsInteger: percent !== null ? Number.isInteger(percent) : null,
                        severity: truncateString(item.severity),
                        resetsAt: truncateString(item.resets_at),
                        model: truncateString(modelName),
                        surface: truncateString(surfaceName)
                    };
                });
            }

            const line = JSON.stringify(out) + '\n';
            fs.appendFileSync(file, line, 'utf8');
            writeResets(buckets, out.limits);

            observations++;
            lastObservedAt = now;
        } catch (error) {
            lastError = error && error.message ? error.message : String(error);
            ctx.log('plan-usage-capture: record error: ' + lastError);
        }
    }

    function observe(input, result) {
        if (!result || typeof result.then !== 'function') {
            return;
        }

        let url = null;
        if (typeof input === 'string') {
            url = input;
        } else if (input && typeof input === 'object' && typeof input.url === 'string') {
            url = input.url;
        }

        if (!url || !URL_PATTERN.test(url)) {
            return;
        }

        result.then(
            response => {
                try {
                    if (!response || response.ok !== true || typeof response.clone !== 'function') {
                        return;
                    }
                    // Clone the response to read body without consuming the stream
                    let copy;
                    try {
                        copy = response.clone();
                    } catch (_) {
                        return;
                    }
                    if (copy && typeof copy.json === 'function') {
                        copy.json().then(
                            body => {
                                record(body);
                            },
                            () => {}
                        );
                    }
                } catch (_) {}
            },
            () => {}
        );
    }

    function wrapper(...args) {
        const result = original.apply(this, args);
        try {
            observe(args[0], result);
        } catch (_) {}
        return result;
    }
    wrapper.__cuimodPlanUsageOriginal = original;

    try {
        net.fetch = wrapper;
        installed = true;
    } catch (error) {
        lastError = error && error.message ? error.message : String(error);
        ctx.log('plan-usage-capture: cannot wrap net.fetch: ' + (error && error.message));
        return;
    }

    ctx.onDispose(() => {
        if (net.fetch === wrapper) {
            net.fetch = original;
        }
    });
};
