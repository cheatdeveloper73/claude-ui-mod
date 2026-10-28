// Fireworks prepaid balance, live.
//
// Fireworks' REST API has no balance; every balance-shaped route 404s and the
// account object carries none. The figure firectl prints comes from the gRPC
// control-plane call gateway.Gateway/GetBalance on gateway.fireworks.ai, which
// takes the same API key in x-api-key. The message is two fields wide, so it is
// spoken over node:http2 with hand-framed protobuf rather than a gRPC library.
// ListInvoices on the same gateway lists paid top-ups.
//
// Measured 2026-10-06: GetBalance moves in batched steps minutes behind spend,
// it floors at 0 while the account is overdrawn (a $5 top-up then read 4.90),
// and billing/summary flips between replicas, so it is not used. The live
// figure is therefore the reported balance minus the exact cost of this
// router's responses that Fireworks has not deducted yet. Each step down in the
// reported balance settles the oldest pending costs first.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';

const GATEWAY = 'https://gateway.fireworks.ai';
const REST = 'https://api.fireworks.ai/v1';
const PAID = 2n;
const EPSILON = 1e-9;
const KEEP_MS = 24 * 3600 * 1000;
const BURN_WINDOW_MS = 3600 * 1000;
// Another router's response first seen this long after it finished may already
// be in the reported balance (deductions measured 2.5-8 min behind spend), so
// it counts toward the burn but not toward pending.
const PEER_PENDING_MS = 3 * 60 * 1000;

// The live rate is a decayed average of exact costs. tau is the recency scale:
// a response contributes e^(-age/tau), so the rate follows a burst within a few
// minutes and falls back over an idle stretch, while never inventing spend. The
// flat one-hour figure is kept for the dashboard and for history, which want a
// window they can name rather than a moving scale.
const RATE_TAU_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 2 * 3600 * 1000;
// Below this the observed span is padded to the floor, which is what stops a
// single fresh response from dividing by a near-zero window and reading as an
// infinite rate.
const RATE_MIN_SPAN_MS = 30 * 1000;
const ACTIVITY_WINDOWS = [[60, 'm1'], [300, 'm5'], [900, 'm15'], [3600, 'm60']];

// Total billable tokens on a normalized usage object, or null when the caller
// carried none -- a peer router's spend log has costs only, and an old state
// file predates the field.
function tokensOf(tokens)
{
    if (typeof tokens === 'number' && Number.isFinite(tokens)) return tokens;
    if (!tokens || typeof tokens !== 'object') return null;
    const total = (Number(tokens.contextInputTokens) || 0) + (Number(tokens.outputTokens) || 0);
    return total || null;
}

// ------------------------------------------------------------ protobuf
const varint = (n) => { const out = []; do { const b = n & 0x7f; n = Math.floor(n / 128); out.push(n ? b | 0x80 : b); } while (n); return out; };
const stringField = (no, s) => { const b = Buffer.from(s, 'utf8'); return Buffer.from([...varint((no << 3) | 2), ...varint(b.length), ...b]); };
const frame = (m) => Buffer.concat([Buffer.from([0, (m.length >>> 24) & 255, (m.length >>> 16) & 255, (m.length >>> 8) & 255, m.length & 255]), m]);

function walk(buf)
{
    const out = [];
    let i = 0;
    const read = () => {
        let v = 0n, s = 0n;
        for (;;)
        {
            if (i >= buf.length) throw new Error('truncated varint');
            const b = buf[i++];
            v |= BigInt(b & 0x7f) << s;
            if (!(b & 0x80)) return v;
            s += 7n;
        }
    };
    while (i < buf.length)
    {
        const tag = Number(read());
        const no = tag >> 3, wire = tag & 7;
        if (wire === 0) out.push({ no, wire, v: read() });
        else if (wire === 2) { const len = Number(read()); out.push({ no, wire, b: buf.subarray(i, i + len) }); i += len; }
        else if (wire === 5) i += 4;
        else if (wire === 1) i += 8;
        else break;
    }
    return out;
}
const sub = (fields, no) => fields.find(f => f.no === no && f.wire === 2)?.b;
const int = (fields, no) => fields.find(f => f.no === no && f.wire === 0)?.v;

// google.type.Money { currency_code = 1, units = 2, nanos = 3 }
function money(buf)
{
    const f = walk(buf);
    const units = int(f, 2) ?? 0n;
    const nanos = int(f, 3) ?? 0n;
    return Number(BigInt.asIntN(64, units)) + Number(BigInt.asIntN(64, nanos)) / 1e9;
}

function unframe(body)
{
    if (body.length < 5 || body[0] !== 0) throw new Error('unexpected gRPC frame');
    const length = body.readUInt32BE(1);
    if (body.length < 5 + length) throw new Error('truncated gRPC frame');
    return body.subarray(5, 5 + length);
}

function grpc(method, account, apiKey)
{
    return new Promise((resolve, reject) => {
        const client = http2.connect(GATEWAY);
        const fail = (error) => { client.destroy(); reject(error); };
        client.on('error', fail);
        client.setTimeout(10000, () => fail(new Error(`fireworks ${method} timed out`)));
        const req = client.request({ ':method': 'POST', ':path': `/gateway.Gateway/${method}`,
            'x-api-key': apiKey, 'content-type': 'application/grpc', te: 'trailers' });
        const chunks = [];
        let status = null, grpcStatus = null, grpcMessage = '';
        req.on('response', (h) => { status = h[':status']; grpcStatus = h['grpc-status'] ?? null; });
        req.on('trailers', (t) => { grpcStatus = t['grpc-status'] ?? grpcStatus; grpcMessage = t['grpc-message'] || ''; });
        req.on('data', (c) => chunks.push(c));
        req.on('error', fail);
        req.on('end', () => {
            client.close();
            if (status !== 200 || String(grpcStatus) !== '0')
                return reject(new Error(`fireworks ${method} ${status}/${grpcStatus} ${decodeURIComponent(grpcMessage)}`.trim()));
            try { resolve(unframe(Buffer.concat(chunks))); } catch (error) { reject(error); }
        });
        req.end(frame(stringField(1, account)));
    });
}

// ------------------------------------------------------------ tracker
export class FireworksBilling
{
    constructor({ stateFile, getApiKey, costOf, fetch: fetchImpl = fetch, now = () => Date.now(), grpcCall = grpc, peers = null })
    {
        // Other routers on the same Fireworks account: () => their spend entries.
        // One settlement over everyone's pending, or each router would credit the
        // others' deductions to its own costs.
        this.peers = peers;
        this.stateFile = stateFile;
        this.getApiKey = getApiKey;
        this.costOf = costOf;
        this.fetch = fetchImpl;
        this.now = now;
        this.grpc = grpcCall;
        this.state = this.load();
        this.inflight = null;
        this.cache = null;
    }

    load()
    {
        try
        {
            const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
            if (value?.version === 1) return value;
        }
        catch (_) {}
        return { version: 1, account: null, reported: null, topUp: null, pending: [], spend: [], unattributed: [] };
    }

    save()
    {
        const tmp = this.stateFile + '.tmp';
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.state));
        fs.renameSync(tmp, this.stateFile);
    }

    // Every Fireworks response this router finishes, priced exactly.
    observe(record)
    {
        const usd = this.costOf(record);
        if (!(usd > 0)) return;
        const at = record.observedAt || new Date(this.now()).toISOString();
        this.state.pending.push({ id: record.responseId || null, at, usd });
        this.state.spend.push({ id: record.responseId || null, at, usd, tokens: tokensOf(record.tokens) });
        this.prune();
        try { this.save(); } catch (_) {}
        this.cache = null;
    }

    prune()
    {
        const floor = new Date(this.now() - KEEP_MS).toISOString();
        this.state.spend = this.state.spend.filter(e => e.at >= floor);
        this.state.unattributed = this.state.unattributed.filter(e => e.at >= floor);
        // A cost Fireworks never deducted within a day is not pending any more.
        this.state.pending = this.state.pending.filter(e => e.at >= floor);
    }

    async account(apiKey)
    {
        if (this.state.account) return this.state.account;
        const r = await this.fetch(`${REST}/accounts`, { headers: { authorization: `Bearer ${apiKey}` } });
        if (!r.ok) throw new Error(`fireworks accounts ${r.status}`);
        const name = (await r.json())?.accounts?.[0]?.name;
        if (!/^accounts\/[a-z0-9-]+$/i.test(String(name))) throw new Error('fireworks account id unavailable');
        this.state.account = name;
        return name;
    }

    async poll()
    {
        const apiKey = this.getApiKey();
        if (!apiKey) throw new Error('fireworks billing unavailable: no API key');
        const account = await this.account(apiKey);
        const [balanceMsg, invoicesMsg] = await Promise.all([this.grpc('GetBalance', account, apiKey), this.grpc('ListInvoices', account, apiKey)]);
        const moneyField = sub(walk(balanceMsg), 1);
        if (!moneyField) throw new Error('fireworks GetBalance returned no balance');
        const balance = money(moneyField);

        // ListInvoices { invoices = 1 }; Invoice { amount = 2 (Money), paid = 6 {seconds = 1}, state = 7 }.
        let last = null;
        for (const raw of walk(invoicesMsg).filter(f => f.no === 1 && f.wire === 2))
        {
            const f = walk(raw.b);
            if (int(f, 7) !== PAID) continue;
            const amount = sub(f, 2) ? money(sub(f, 2)) : 0;
            const seconds = sub(f, 6) ? int(walk(sub(f, 6)), 1) : null;
            if (!(amount > 0) || seconds == null) continue;
            const at = new Date(Number(seconds) * 1000).toISOString();
            if (!last || at > last.at) last = { usd: amount, at };
        }
        return { balance, topUp: last };
    }

    settle(balance, topUp)
    {
        const now = new Date(this.now()).toISOString();
        const prior = this.state.reported;
        const newTopUp = topUp && (!this.state.topUp || topUp.at > this.state.topUp.at) ? topUp : null;
        if (prior)
        {
            // What Fireworks deducted since the last reading. A top-up in between
            // adds its amount back, which is also how an overdraft shows: $5 in,
            // 4.90 reported, so 0.10 of pending cost was settled.
            let deducted = prior.usd + (newTopUp ? newTopUp.usd : 0) - balance;
            while (deducted > EPSILON && this.state.pending.length)
            {
                const head = this.state.pending[0];
                if (head.usd <= deducted + EPSILON) { deducted -= head.usd; this.state.pending.shift(); }
                else { head.usd -= deducted; deducted = 0; }
            }
            // Deductions this router never saw: another machine's traffic, or
            // anything else on the account. They still count toward the burn.
            if (deducted > 1e-6) this.state.unattributed.push({ at: now, usd: deducted });
        }
        if (topUp) this.state.topUp = topUp;
        this.state.reported = { usd: balance, at: now };
        this.prune();
    }

    // Decayed spend rate in USD/hour. Costs older than RATE_WINDOW_MS are
    // ignored; the denominator is the decayed length of the observed span, so an
    // idle gap lowers the rate rather than being skipped. For a span much shorter
    // than tau this reduces to the plain mean over the span, which is why the
    // first minutes after the router starts are not read as a runaway rate.
    // Unattributed deductions count, because they are spend on this account from
    // somewhere the router cannot see, and the drain is real regardless.
    rate(tauMs, nowMs)
    {
        let cost = 0, count = 0, first = Infinity;
        for (const entry of [...this.state.spend, ...this.state.unattributed])
        {
            const t = Date.parse(entry.at);
            if (!Number.isFinite(t) || t > nowMs || nowMs - t > RATE_WINDOW_MS) continue;
            if (t < first) first = t;
            cost += entry.usd * Math.exp(-(nowMs - t) / tauMs);
            count += 1;
        }
        if (!count) return { perHour: null, count: 0, spanMs: 0 };
        const spanMs = Math.max(nowMs - first, RATE_MIN_SPAN_MS);
        const decayedSpan = tauMs * (1 - Math.exp(-spanMs / tauMs));
        return { perHour: decayedSpan > 0 ? cost / decayedSpan * 3600000 : null, count, spanMs };
    }

    // What the account is doing right now, over trailing windows. Requests are
    // exact (one per observed response); tokens are absent for a peer router's
    // entries and for anything recorded before the field existed, so the caller
    // is told when the sum is partial rather than being shown a short total as
    // if it were the whole picture.
    activity(nowMs)
    {
        const windows = Object.fromEntries(ACTIVITY_WINDOWS.map(([seconds, key]) =>
            [key, { seconds, requests: 0, tokens: 0, tokensMeasured: 0, usd: 0 }]));
        let lastAt = null;
        for (const entry of this.state.spend)
        {
            const t = Date.parse(entry.at);
            if (!Number.isFinite(t) || t > nowMs) continue;
            if (!lastAt || t > Date.parse(lastAt)) lastAt = entry.at;
            for (const [seconds, key] of ACTIVITY_WINDOWS)
            {
                if (nowMs - t > seconds * 1000) continue;
                const window = windows[key];
                window.requests += 1;
                window.usd += entry.usd;
                if (Number.isFinite(entry.tokens)) { window.tokens += entry.tokens; window.tokensMeasured += 1; }
            }
        }
        const m5 = windows.m5;
        const perMinute = m5.seconds / 60;
        return {
            lastAt,
            requestsPerMinute: m5.requests / perMinute,
            tokensPerMinute: m5.tokens / perMinute,
            usdPerMinute: m5.usd / perMinute,
            tokensExact: m5.requests > 0 && m5.tokensMeasured === m5.requests,
            windows,
        };
    }

    snapshot()
    {
        const nowMs = this.now();
        const reported = this.state.reported;
        const pending = this.state.pending.reduce((s, e) => s + e.usd, 0);
        const live = reported ? reported.usd - pending : null;
        const since = new Date(nowMs - BURN_WINDOW_MS).toISOString();
        const burned = [...this.state.spend, ...this.state.unattributed].filter(e => e.at >= since).reduce((s, e) => s + e.usd, 0);
        const perHour = burned * 3600000 / BURN_WINDOW_MS;

        const smooth = this.rate(RATE_TAU_MS, nowMs);
        const recentFloor = nowMs - 60000;
        const recentUsd = this.state.spend.filter(e => Date.parse(e.at) >= recentFloor).reduce((s, e) => s + e.usd, 0);
        // The runout runs on the smoothed rate, which is the same exact spend as
        // the flat hour weighted toward the present. RATE_WINDOW_MS is wider than
        // BURN_WINDOW_MS, so anything the flat hour counts the smoothed rate
        // counts too; a null smoothed rate means the account has been quiet for
        // two hours and has no rate to forecast from.
        const basis = smooth.perHour;
        const runoutMs = live !== null && live > 0 && basis > 0 ? live / basis * 3600000 : null;
        const confidence = !smooth.count ? 'insufficient'
            : smooth.spanMs >= 900000 && smooth.count >= 8 ? 'high'
            : smooth.spanMs >= 300000 && smooth.count >= 3 ? 'medium' : 'low';
        const credit = this.state.topUp?.usd || null;
        return {
            source: 'fireworks.gateway.GetBalance',
            exact: true,
            observedAt: new Date(nowMs).toISOString(),
            balance: {
                live, reported: reported?.usd ?? null, reportedAt: reported?.at ?? null,
                pending, pendingResponses: this.state.pending.length,
            },
            topUp: this.state.topUp,
            usedPercent: credit && live !== null ? Math.max(0, Math.min(100, (credit - live) / credit * 100)) : null,
            burn: {
                usdPerHour: perHour, windowMinutes: BURN_WINDOW_MS / 60000,
                smoothedPerHour: smooth.perHour, recentPerHour: recentUsd * 60,
                smoothedWindowMinutes: RATE_TAU_MS / 60000,
                samples: smooth.count, spanMinutes: smooth.spanMs / 60000,
            },
            runout: runoutMs === null ? null : {
                at: new Date(nowMs + runoutMs).toISOString(), hours: runoutMs / 3600000, confidence,
            },
            activity: this.activity(nowMs),
        };
    }

    async mergePeers()
    {
        if (!this.peers) return;
        let entries;
        try { entries = await this.peers(); } catch (_) { return; }
        const seen = new Set(this.state.spend.map(e => e.id).filter(Boolean));
        const floor = this.now() - KEEP_MS;
        for (const e of entries || [])
        {
            if (!e?.id || seen.has(e.id) || !(e.usd > 0) || !(Date.parse(e.at) >= floor)) continue;
            seen.add(e.id);
            const entry = { id: e.id, at: e.at, usd: e.usd, peer: true };
            // A peer that records tokens contributes them; one whose state file
            // predates the field does not, and the activity block says so rather
            // than reading its absence as zero.
            if (Number.isFinite(e.tokens)) entry.tokens = e.tokens;
            this.state.spend.push(entry);
            if (this.now() - Date.parse(e.at) <= PEER_PENDING_MS) this.state.pending.push({ ...entry });
        }
        this.state.pending.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    }

    async read(force = false)
    {
        if (!force && this.cache && this.now() - this.cache.at < 30000) return this.cache.value;
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try
            {
                const [{ balance, topUp }] = await Promise.all([this.poll(), this.mergePeers()]);
                this.settle(balance, topUp);
                try { this.save(); } catch (_) {}
                const value = this.snapshot();
                this.cache = { at: this.now(), value };
                return value;
            }
            catch (error)
            {
                // A failed read keeps the last good figure, marked stale, rather than
                // reading as an empty account.
                const value = this.state.reported ? { ...this.snapshot(), stale: true, error: String(error?.message || error) }
                    : { error: String(error?.message || error) };
                return value;
            }
        })().finally(() => { this.inflight = null; });
        return this.inflight;
    }
}

// Peer routers listed in a private JSON file: [{ host, port, identityFile, path }].
// Each is read over ssh (batch mode, no window) and contributes its spend log.
export function sshPeers(configFile)
{
    return async () => {
        let peers;
        try { peers = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) { return []; }
        const reads = (Array.isArray(peers) ? peers : []).map(peer => new Promise((resolve) => {
            const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR'];
            if (peer.identityFile) args.push('-i', peer.identityFile);
            if (peer.port) args.push('-p', String(peer.port));
            args.push(peer.host, `cat '${String(peer.path).replace(/'/g, '')}'`);
            execFile('ssh', args, { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                if (error) return resolve([]);
                try { resolve(JSON.parse(stdout).spend || []); } catch (_) { resolve([]); }
            });
        }));
        return (await Promise.all(reads)).flat();
    };
}

export { walk, money, frame, stringField };
