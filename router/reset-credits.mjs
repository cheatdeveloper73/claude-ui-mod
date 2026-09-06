// Codex rate-limit reset credits.
//
// The ChatGPT plan occasionally grants a "full reset" credit that clears an
// exhausted Codex window. It is scarce and it expires, and deciding when to
// spend it belongs to whoever is running the work, not to this router. So the
// router never redeems on its own: an orchestrator calls POST /resetz, and the
// gate here refuses anything short of a window actually at limit_reached or
// 100%. A high percentage is not exhaustion, and neither is a bare 429 -- the
// short per-model windows produce those too.
//
// Redemption goes through the codex CLI's app-server rather than a hand-rolled
// call to the wham endpoint. The router already reads /wham/usage for the credit
// count, but the consume request body is not something to infer on the one call
// that spends the credit: `codex app-server` speaks a versioned JSON-RPC
// (`account/rateLimitResetCredit/consume`) generated from the same Rust types
// the backend expects, and it reuses the auth.json refresh the router
// deliberately does not duplicate.
//
// The idempotency key is derived from the exhausted window rather than random.
// Two turns that hit 429 together, or a blue-green worker swap in the middle of
// an episode, converge on the same key, and the backend answers
// `alreadyRedeemed` for the second attempt instead of spending a second credit.
// That is the durable half of the guard; the in-memory single-flight below is
// only the cheap half, and it does not survive a generation swap.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

// The vendored exe is preferred over the `codex` shim on PATH because it needs
// no shell, and a shell on Windows means cmd quoting rules in a path that
// already contains spaces.
export function codexBinary()
{
    if (process.env.CODEX_BIN) return { command: process.env.CODEX_BIN, shell: false };
    const vendor = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex',
        'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (fs.existsSync(vendor)) return { command: vendor, shell: false };
    return { command: 'codex', shell: true };
}

// One request per process. The app server is a long-lived stdio daemon in the
// desktop app; here it is asked one question on a rare event, and a process that
// exits is a process that cannot leak into an 18-hour run.
export function appServerRequest(method, params, options = {})
{
    const { command, shell } = options.binary || codexBinary();
    const timeoutMs = options.timeoutMs ?? 30000;
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true }); }
        catch (error) { reject(new Error(`codex app-server could not start: ${String(error?.message || error)}`)); return; }

        let settled = false;
        let stderr = '';
        let buffer = '';
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill(); } catch {}
            error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`)), timeoutMs);

        child.on('error', error => finish(new Error(`codex app-server failed to run: ${String(error?.message || error)}`)));
        child.on('exit', code => finish(new Error(`codex app-server exited (${code}) before answering ${method}: ${stderr.slice(0, 240)}`)));
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => {
            buffer += chunk;
            for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n'))
            {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                if (message.id === 1) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n'); continue; }
                if (message.id !== 2) continue;                      // server-initiated traffic
                if (message.error) { finish(new Error(`codex ${method}: ${JSON.stringify(message.error).slice(0, 240)}`)); return; }
                finish(null, message.result);
                return;
            }
        });

        child.stdin.on('error', () => {});
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { clientInfo: { name: 'cuimod-router', version: '1' } } }) + '\n');
    });
}

function finite(value)
{
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A UUID-shaped key so the backend sees the format its own clients send, but
// derived rather than random -- see the header note on why that matters.
function derivedKey(seed)
{
    const hex = crypto.createHash('sha256').update(`cuimod-reset:${seed}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ResetCredits
{
    constructor(options = {})
    {
        this.limits = options.limits || null;
        this.journalFile = options.journalFile || null;
        this.log = options.log || (() => {});
        this.rpc = options.rpc || ((method, params) => appServerRequest(method, params, { timeoutMs: options.timeoutMs }));
        this.now = options.now || (() => Date.now());
        // A window at its limit stays at its limit for as long as the window
        // lasts, so a burst of 429s is one episode. The key makes a second
        // redemption harmless; the cooldown makes it not happen at all.
        this.cooldownMs = options.cooldownMs ?? 300000;
        this.minUsedPercent = options.minUsedPercent ?? 100;
        this.attempts = this.readJournal();
        this.inflight = null;
    }

    readJournal()
    {
        if (!this.journalFile) return [];
        try
        {
            return fs.readFileSync(this.journalFile, 'utf8').split('\n')
                .filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
                .filter(Boolean).slice(-50);
        }
        catch { return []; }
    }

    record(attempt)
    {
        this.attempts.push(attempt);
        this.attempts = this.attempts.slice(-50);
        if (!this.journalFile) return attempt;
        try
        {
            fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
            fs.appendFileSync(this.journalFile, JSON.stringify(attempt) + '\n');
        }
        catch (error) { this.log(`reset-credit journal write failed: ${String(error?.message || error).slice(0, 200)}`); }
        return attempt;
    }

    // The exhausted window, or null. Reported per named scope so the journal
    // says which window was reset rather than only that something was.
    episode(limitsValue)
    {
        const openai = limitsValue?.openai;
        if (!openai || openai.error) return null;
        const spent = (scope, window, reached) => {
            if (!window) return null;
            const used = finite(window.usedPercent);
            if (!reached && !(used !== null && used >= this.minUsedPercent)) return null;
            return { scope, usedPercent: used, resetAt: finite(window.resetAt), limitWindowSeconds: finite(window.limitWindowSeconds) };
        };

        const reached = openai.rateLimit?.limitReached === true;
        const candidates = [
            spent('primary', openai.rateLimit?.primary, reached),
            spent('secondary', openai.rateLimit?.secondary, reached),
        ];
        for (const extra of openai.additionalRateLimits || [])
        {
            const name = extra?.name || extra?.feature || 'additional';
            const hit = extra?.rateLimit?.limitReached === true;
            candidates.push(spent(`${name}:primary`, extra?.rateLimit?.primary, hit));
            candidates.push(spent(`${name}:secondary`, extra?.rateLimit?.secondary, hit));
        }
        // The longest window first: a weekly limit is the one worth a credit,
        // and a five-hour window that happens to also be full will come back on
        // its own long before the weekly one does.
        const found = candidates.filter(Boolean).sort((a, b) => (b.limitWindowSeconds ?? 0) - (a.limitWindowSeconds ?? 0));
        return found[0] || null;
    }

    available(limitsValue)
    {
        return finite(limitsValue?.openai?.resetCredits) ?? 0;
    }

    lastReset()
    {
        for (let i = this.attempts.length - 1; i >= 0; i--)
            if (this.attempts[i]?.outcome === 'reset') return this.attempts[i];
        return null;
    }

    // The redemption itself. `outcome: 'reset'` is the only value that means a
    // credit was spent and the caller may retry its turn; every other value
    // left the account exactly as it was.
    async attempt(context = {})
    {
        if (this.inflight) return this.inflight;
        this.inflight = this.redeem(context).finally(() => { this.inflight = null; });
        return this.inflight;
    }

    async redeem(context = {})
    {
        const at = new Date(this.now()).toISOString();
        const previous = this.lastReset();
        if (!context.force && previous && this.now() - Date.parse(previous.at) < this.cooldownMs)
            return { at, outcome: 'skipped', reason: 'a reset was redeemed within the cooldown', previous: previous.at };

        let limitsValue = null;
        try { limitsValue = await this.limits.refresh(true); }
        catch (error) { return this.record({ at, outcome: 'error', reason: `usage read failed: ${String(error?.message || error).slice(0, 200)}` }); }

        const episode = this.episode(limitsValue);
        const credits = this.available(limitsValue);
        if (!episode && !context.force)
            return { at, outcome: 'skipped', reason: 'no window is at its limit', credits, status: context.status ?? null };
        if (credits < 1 && !context.force)
            return { at, outcome: 'skipped', reason: 'no reset credit available', credits, scope: episode?.scope ?? null };

        const seed = episode
            ? `${episode.scope}:${episode.resetAt}:${episode.limitWindowSeconds}`
            : `forced:${Math.floor(this.now() / this.cooldownMs)}`;
        const idempotencyKey = context.idempotencyKey || derivedKey(seed);

        let result;
        try { result = await this.rpc('account/rateLimitResetCredit/consume', { idempotencyKey }); }
        catch (error)
        {
            // An uncertain redemption is the one case worth journalling loudly:
            // the retry must reuse this key, and the key is derived, so a later
            // 429 on the same window reproduces it.
            return this.record({ at, outcome: 'error', idempotencyKey, scope: episode?.scope ?? null, credits,
                reason: String(error?.message || error).slice(0, 240) });
        }

        const outcome = OUTCOMES.has(result?.outcome) ? result.outcome : 'unknown';
        const attempt = { at, outcome, idempotencyKey, credits,
            scope: episode?.scope ?? null, usedPercent: episode?.usedPercent ?? null,
            windowResetAt: episode?.resetAt ?? null, reason: context.reason || 'upstream 429' };
        this.log(`codex reset credit ${outcome} scope=${attempt.scope ?? 'none'} credits=${credits} key=${idempotencyKey.slice(0, 8)}`);
        return this.record(attempt);
    }

    // Everything an orchestrator needs to decide whether the run is healthy,
    // without a second provider call: the credit count and window state come
    // from the cached usage snapshot the dashboard already shares.
    async state(force = false)
    {
        let limitsValue = null;
        let error = null;
        try { limitsValue = await this.limits.refresh(force); }
        catch (e) { error = String(e?.message || e).slice(0, 240); }
        const episode = limitsValue ? this.episode(limitsValue) : null;
        return {
            version: 1,
            observedAt: new Date(this.now()).toISOString(),
            cooldownMs: this.cooldownMs,
            minUsedPercent: this.minUsedPercent,
            error,
            credits: limitsValue ? this.available(limitsValue) : null,
            planType: limitsValue?.openai?.planType ?? null,
            exhausted: episode,
            rateLimit: limitsValue?.openai?.rateLimit ?? null,
            lastReset: this.lastReset(),
            attempts: this.attempts.slice(-10),
        };
    }
}

export { derivedKey };
