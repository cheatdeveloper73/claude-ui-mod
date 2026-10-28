// Fireworks prepaid balance. The gateway is injected, so these are about the
// settlement arithmetic the live figure depends on, not about the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const { FireworksBilling, stringField } = await import(pathToFileURL(path.join(root, 'fireworks-billing.mjs')).href);

const varint = (n) => { const out = []; do { const b = n & 0x7f; n = Math.floor(n / 128); out.push(n ? b | 0x80 : b); } while (n); return Buffer.from(out); };
const tagged = (no, wire, payload) => Buffer.concat([varint((no << 3) | wire), wire === 2 ? varint(payload.length) : Buffer.alloc(0), payload]);
const int = (no, v) => tagged(no, 0, varint(v));
const msg = (no, inner) => tagged(no, 2, inner);
const moneyOf = (usd) => Buffer.concat([stringField(1, 'USD'), int(2, Math.floor(usd)), int(3, Math.round((usd - Math.floor(usd)) * 1e9))]);
const balanceReply = (usd) => msg(1, moneyOf(usd));
const invoicesReply = (list) => Buffer.concat(list.map(i => msg(1, Buffer.concat([msg(2, moneyOf(i.usd)), msg(6, int(1, i.paid)), int(7, i.state)]))));

function harness()
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fireworks-billing-'));
    let clock = Date.parse('2026-10-06T02:00:00Z');
    const gateway = { balance: 1, invoices: [] };
    const billing = new FireworksBilling({
        stateFile: path.join(dir, 'state.json'),
        getApiKey: () => 'fw_test',
        costOf: (r) => r.usd,
        now: () => clock,
        fetch: async () => ({ ok: true, json: async () => ({ accounts: [{ name: 'accounts/test-1' }] }) }),
        grpcCall: async (method) => method === 'GetBalance' ? balanceReply(gateway.balance) : invoicesReply(gateway.invoices),
    });
    return { billing, gateway, tick: (ms) => { clock += ms; }, at: () => new Date(clock).toISOString(), dir };
}

test('the live balance is the reported one minus costs Fireworks has not deducted yet', async () => {
    const h = harness();
    h.gateway.balance = 0.50;
    await h.billing.read(true);
    h.billing.observe({ usd: 0.10, observedAt: h.at() });
    h.billing.observe({ usd: 0.05, observedAt: h.at() });
    let s = await h.billing.read(true);
    assert.equal(+s.balance.live.toFixed(9), 0.35);
    assert.equal(s.balance.pendingResponses, 2);

    // Fireworks deducts the first response only: the oldest pending cost settles.
    h.gateway.balance = 0.40;
    h.tick(60000);
    s = await h.billing.read(true);
    assert.equal(s.balance.pendingResponses, 1);
    assert.equal(+s.balance.live.toFixed(9), 0.35);
});

test('an overdraft settles when a top-up arrives, and the top-up becomes the denominator', async () => {
    const h = harness();
    h.gateway.balance = 0.04;
    await h.billing.read(true);
    h.billing.observe({ usd: 0.0997, observedAt: h.at() });
    // GetBalance floors at zero while overdrawn.
    h.gateway.balance = 0;
    h.tick(60000);
    let s = await h.billing.read(true);
    assert.ok(s.balance.live < 0, 'an overdrawn account reads negative, not zero');
    // $5 paid, 4.9403 reported: everything pending was deducted.
    h.gateway.balance = 4.9403;
    h.gateway.invoices = [{ usd: 5, paid: Math.floor(Date.parse('2026-10-06T02:02:00Z') / 1000), state: 2 }, { usd: 0, paid: 1, state: 1 }];
    h.tick(60000);
    s = await h.billing.read(true);
    assert.equal(s.balance.pendingResponses, 0);
    assert.equal(+s.balance.live.toFixed(4), 4.9403);
    assert.equal(s.topUp.usd, 5);
    assert.equal(+s.usedPercent.toFixed(3), 1.194);
});

test('deductions this router never saw still count toward the burn and the runout', async () => {
    const h = harness();
    h.gateway.balance = 2;
    await h.billing.read(true);
    h.billing.observe({ usd: 0.25, observedAt: h.at() });
    h.tick(30 * 60000);
    // Fireworks took 0.25 for this router plus 0.25 from elsewhere.
    h.gateway.balance = 1.5;
    const s = await h.billing.read(true);
    assert.equal(+s.burn.usdPerHour.toFixed(6), 0.5);
    // The runout runs on the decayed rate, which the fresh 0.25 deduction
    // dominates; the flat hour is still reported beside it.
    assert.equal(s.runout.confidence, 'low');
    assert.equal(+s.runout.hours.toFixed(6), +(s.balance.live / s.burn.smoothedPerHour).toFixed(6));
});

test('a failed read keeps the last good figure, marked stale', async () => {
    const h = harness();
    h.gateway.balance = 1.25;
    await h.billing.read(true);
    h.billing.grpc = async () => { throw new Error('gateway down'); };
    const s = await h.billing.read(true);
    assert.equal(s.stale, true);
    assert.equal(s.balance.reported, 1.25);
});

test('state survives a worker swap', async () => {
    const h = harness();
    h.gateway.balance = 1;
    await h.billing.read(true);
    h.billing.observe({ usd: 0.2, observedAt: h.at() });
    const next = new FireworksBilling({ stateFile: path.join(h.dir, 'state.json'), getApiKey: () => null, costOf: () => 0, now: () => Date.parse(h.at()) });
    assert.equal(+next.snapshot().balance.live.toFixed(9), 0.8);
});

test('a peer router joins one settlement, and a late sighting is burn but not pending', async () => {
    const h = harness();
    let peer = [];
    h.billing.peers = async () => peer;
    h.gateway.balance = 3;
    await h.billing.read(true);
    h.billing.observe({ responseId: 'local-1', usd: 0.10, observedAt: h.at() });
    peer = [{ id: 'peer-1', at: h.at(), usd: 0.20 }, { id: 'peer-old', at: new Date(Date.parse(h.at()) - 10 * 60000).toISOString(), usd: 0.50 }];
    let s = await h.billing.read(true);
    assert.equal(+s.balance.pending.toFixed(9), 0.30);
    assert.equal(+s.balance.live.toFixed(9), 2.70);
    // Fireworks deducts both fresh costs; nothing is left pending or double-settled.
    h.gateway.balance = 2.70;
    h.tick(60000);
    s = await h.billing.read(true);
    assert.equal(s.balance.pendingResponses, 0);
    assert.equal(+s.balance.live.toFixed(9), 2.70);
    // The late sighting still counts toward the hour's burn: 0.10 + 0.20 + 0.50.
    assert.equal(+s.burn.usdPerHour.toFixed(6), 0.80);
    // Seen once, merged once.
    s = await h.billing.read(true);
    assert.equal(+s.burn.usdPerHour.toFixed(6), 0.80);
});

test('the smoothed rate follows a burst the flat hour average hides', async () => {
    const h = harness();
    h.gateway.balance = 100;
    await h.billing.read(true);
    // Fifty quiet minutes, then a burst in the last minute.
    h.billing.observe({ usd: 0.10, observedAt: h.at() });
    h.tick(50 * 60000);
    h.billing.observe({ usd: 0.10, observedAt: h.at() });
    h.tick(9 * 60000);
    h.billing.observe({ usd: 0.30, observedAt: h.at() });
    h.tick(30000);
    h.billing.observe({ usd: 0.30, observedAt: h.at() });
    h.tick(30000);
    const s = await h.billing.read(true);

    assert.equal(+s.burn.usdPerHour.toFixed(6), 0.8);
    // The decayed rate is dominated by the last two responses: 0.60 of the 0.80
    // landed in the final minute, so the live rate is many times the flat hour.
    assert.ok(s.burn.smoothedPerHour > 4 && s.burn.smoothedPerHour < 12, `smoothed ${s.burn.smoothedPerHour}`);
    assert.ok(s.burn.recentPerHour > 30, `recent ${s.burn.recentPerHour}`);
    assert.equal(s.burn.smoothedWindowMinutes, 5);
    assert.equal(s.burn.samples, 4);
    // The runout is the live balance over that smoothed rate, with a confidence
    // that reflects how much history the estimate rests on.
    assert.equal(+s.runout.hours.toFixed(6), +(s.balance.live / s.burn.smoothedPerHour).toFixed(6));
    assert.equal(s.runout.confidence, 'medium');
});

test('activity reports live requests and tokens over trailing windows', async () => {
    const h = harness();
    h.gateway.balance = 5;
    await h.billing.read(true);
    h.billing.observe({ usd: 0.01, tokens: { contextInputTokens: 1000, outputTokens: 200 }, observedAt: h.at() });
    h.tick(30000);
    h.billing.observe({ usd: 0.02, tokens: { contextInputTokens: 2000, outputTokens: 300 }, observedAt: h.at() });
    h.tick(30 * 60000);
    h.billing.observe({ usd: 0.03, tokens: { contextInputTokens: 400, outputTokens: 100 }, observedAt: h.at() });
    const a = (await h.billing.read(true)).activity;

    assert.equal(a.windows.m1.requests, 1);
    assert.equal(a.windows.m5.requests, 1);
    assert.equal(a.windows.m15.requests, 1);
    assert.equal(a.windows.m60.requests, 3);
    assert.equal(a.windows.m1.tokens, 500);
    assert.equal(a.windows.m60.tokens, 1200 + 2300 + 500);
    assert.equal(a.tokensExact, true);
    // Per-minute figures come off the five-minute window, so a single response
    // reads as a rate rather than as a one-sample spike.
    assert.equal(+a.tokensPerMinute.toFixed(2), 100);
    assert.equal(+a.requestsPerMinute.toFixed(3), 0.2);
    assert.equal(a.lastAt, h.at());
});

test('a peer spend log with no tokens marks the activity token sum partial', async () => {
    const h = harness();
    let peer = [];
    h.billing.peers = async () => peer;
    h.gateway.balance = 5;
    await h.billing.read(true);
    h.billing.observe({ responseId: 'local-1', usd: 0.01, tokens: { contextInputTokens: 100, outputTokens: 0 }, observedAt: h.at() });
    peer = [{ id: 'peer-1', at: h.at(), usd: 0.02 }];
    const s = await h.billing.read(true);

    assert.equal(s.activity.windows.m1.requests, 2);
    assert.equal(s.activity.windows.m1.tokens, 100);
    assert.equal(s.activity.tokensExact, false);
});

test('a peer that records tokens contributes them to the activity window', async () => {
    const h = harness();
    let peer = [];
    h.billing.peers = async () => peer;
    h.gateway.balance = 5;
    await h.billing.read(true);
    h.billing.observe({ responseId: 'local-1', usd: 0.01, tokens: { contextInputTokens: 100, outputTokens: 0 }, observedAt: h.at() });
    peer = [{ id: 'peer-1', at: h.at(), usd: 0.02, tokens: 900 }];
    const s = await h.billing.read(true);

    assert.equal(s.activity.windows.m1.requests, 2);
    assert.equal(s.activity.windows.m1.tokens, 1000);
    assert.equal(s.activity.tokensExact, true);
});
