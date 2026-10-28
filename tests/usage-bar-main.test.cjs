'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function close(server) { return new Promise(resolve => server.close(resolve)); }

test('Desktop usage RPC caches the full snapshot and returns only the active projection', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-main-'));
    const planFile = path.join(temp, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ version: 2, samples: [
        { t: Date.now(), org: 'fixture', u: { fh: 10, sd: 20 } },
    ] }));
    let requests = 0;
    const routes = [];
    const history = Array.from({ length: 128 }, (_, index) => ({ observedAt: new Date(Date.now() - index * 60000).toISOString(), usedPercent: index / 2 }));
    const meters = [
        { key: 'claude:fixture:fh', provider: 'claude', quotaId: 'five_hour', aggregate: true,
            forecast: { ratePerMinute: 0.05 }, calibration: { tokensPerPercent: 2000 }, history },
        { key: 'openai:chatgpt:primary', provider: 'openai', quotaId: 'primary', aggregate: true,
            forecast: { ratePerMinute: 0.1 }, calibration: { tokensPerPercent: 1000 }, history },
        ...[1, 2, 3, 4].flatMap(id => [
            { key: `acme:${id}:acme-flash-tiered`, provider: 'acme', quotaId: 'acme-flash-tiered', aggregate: false,
                aliases: ['flash', 'pro'], forecast: { ratePerMinute: 0.2 }, calibration: null, history },
            { key: `acme:${id}:acme-pro-agent`, provider: 'acme', quotaId: 'acme-pro-agent', aggregate: false,
                aliases: ['flash', 'pro'], forecast: { ratePerMinute: 0.3 }, calibration: null, history },
        ]),
    ];
    const snapshot = {
        generatedAt: new Date().toISOString(), meters,
        usage: { recent: Array.from({ length: 100 }, (_, index) => ({ responseId: String(index), rawUsage: { input_tokens: index } })) },
        limits: {
            openai: { rateLimit: { primary: { usedPercent: 12 } } },
            acme: { accounts: [1, 2, 3, 4].map(id => ({ id, name: `Account ${id}`, status: 'active', schedulable: true,
                quotas: { 'acme-flash-tiered': { utilization: id * 10 }, 'acme-pro-agent': { utilization: id * 10 } } })) },
            'metered-backend': { windowLimits: { limited: true,
                fiveHour: { used: 7, cap: 14 }, weekly: { used: 21, cap: 35 } },
                credits: { totalRemaining: 14.8 } },
        },
    };
    const server = http.createServer((req, res) => {
        requests += 1;
        routes.push(req.url);
        const value = req.url.includes('scope=claude')
            ? { ...snapshot, limits: { openai: null } }
            : snapshot;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
    });
    await listen(server);

    const oldRouter = process.env.CUIMOD_ROUTER_URL;
    const oldPlan = process.env.CUIMOD_PLAN_USAGE_FILE;
    process.env.CUIMOD_ROUTER_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.CUIMOD_PLAN_USAGE_FILE = planFile;
    const modulePath = require.resolve('../src/plugins/usage-bar/main.js');
    delete require.cache[modulePath];
    const methods = new Map();
    require(modulePath)({
        boot: { host: { dispatch: async name => {
            assert.equal(name, 'provider-picker.catalogue');
            return { models: [{ id: 'oss-model', wireId: 'claude-oss-model[1m]', provider: 'metered-backend' }] };
        } } },
        electron: { shell: { openExternal() {} } },
        method(name, fn) { methods.set(name, fn); },
    });

    try {
        // The first observation has no renderer-side provider hint. Catalogue
        // ownership must choose the full router scope before this request runs.
        const metered = await methods.get('allLimits')({ model: 'claude-oss-model[1m]' });
        const openai = await methods.get('allLimits')({ model: 'claude-gpt-5.6-sol[1m]' });
        const pooled = await methods.get('allLimits')({ model: 'claude-acme-3.7-flash[1m]' });
        const claude = await methods.get('allLimits')({ model: 'claude-opus-5[1m]' });
        assert.equal(requests, 2);
        assert.equal(routes[0], '/usage/api', 'an adapter-owned model must not cold-start through the Claude-only scope');
        assert.ok(openai.openai);
        assert.equal(openai.pool, null);
        assert.equal(openai.provider, 'openai');
        assert.ok(pooled.pool, 'an adapter provider is looked up by its own key in the limits payload');
        assert.equal(pooled.provider, 'acme');
        assert.equal(pooled.openai, null);
        assert.equal(metered.provider, 'metered-backend');
        assert.deepEqual(metered.pool, snapshot.limits['metered-backend']);
        assert.deepEqual(openai.analytics.meters.map(row => row.provider), ['openai']);
        assert.deepEqual(claude.analytics.meters.map(row => row.provider), ['claude']);
        assert.equal(claude.openai, null);
        assert.equal(claude.pool, null);
        assert.equal(claude.provider, 'claude');
        // Narrowed to the quota family that serves THIS model, using the family
        // words the adapter put on the meter rows -- never a quota id written
        // into the plugin.
        assert.equal(pooled.analytics.meters.length, 4);
        assert.ok(pooled.analytics.meters.every(row => row.quotaId === 'acme-flash-tiered'));
        assert.equal('history' in pooled.analytics.meters[0], false);
        assert.ok(Buffer.byteLength(JSON.stringify(openai)) < 5000);
        assert.ok(Buffer.byteLength(JSON.stringify(pooled)) < 20000);

        // The live Fireworks drain is its own uncached route: the popover polls
        // it every second, so it must not carry the analytics snapshot.
        const live = await methods.get('fireworksLive')();
        assert.equal(routes.at(-1), '/fireworksz');
        assert.ok(Array.isArray(live.meters), 'the live route returns the router payload unchanged');
    } finally {
        if (oldRouter === undefined) delete process.env.CUIMOD_ROUTER_URL; else process.env.CUIMOD_ROUTER_URL = oldRouter;
        if (oldPlan === undefined) delete process.env.CUIMOD_PLAN_USAGE_FILE; else process.env.CUIMOD_PLAN_USAGE_FILE = oldPlan;
        delete require.cache[modulePath];
        await close(server);
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
