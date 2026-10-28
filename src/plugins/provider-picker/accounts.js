'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const WEEK_MIN_SECONDS = 6 * 24 * 60 * 60;
const RESET_OUTCOMES = new Set(['reset', 'alreadyRedeemed']);

function decodeJwt(token) {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
    catch (_) { return {}; }
}

function authIdentity(file, raw) {
    let value;
    try { value = JSON.parse(raw.replace(/^﻿/, '')); }
    catch (_) { throw new Error('OpenAI login credential file is invalid'); }
    const tokens = value?.tokens;
    if (!tokens?.access_token || !tokens?.account_id) throw new Error('OpenAI login did not return a subscription account');
    const access = decodeJwt(tokens.access_token);
    const identity = decodeJwt(tokens.id_token);
    const auth = identity['https://api.openai.com/auth'] || access['https://api.openai.com/auth'] || {};
    const profile = identity['https://api.openai.com/profile'] || access['https://api.openai.com/profile'] || {};
    const accountId = String(tokens.account_id);
    return {
        file,
        raw,
        id: crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 32),
        name: String(identity.name || profile.name || '').trim(),
        email: String(identity.email || profile.email || '').trim(),
        plan: String(auth.chatgpt_plan_type || '').trim().toLowerCase(),
    };
}

function readAuth(file) {
    return authIdentity(file, fs.readFileSync(file, 'utf8'));
}

function jwtExpiry(token) {
    const payload = decodeJwt(token);
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
}

function weeklyLimit(value) {
    const rate = value?.rate_limit;
    const windows = [rate?.primary_window, rate?.secondary_window]
        .filter(window => Number.isFinite(window?.limit_window_seconds)
            && window.limit_window_seconds >= WEEK_MIN_SECONDS)
        .sort((a, b) => b.limit_window_seconds - a.limit_window_seconds);
    const window = windows[0];
    if (!window) return null;
    return {
        usedPercent: Number.isFinite(window.used_percent) ? window.used_percent : null,
        resetAt: Number.isFinite(window.reset_at) ? window.reset_at : null,
        windowSeconds: window.limit_window_seconds,
    };
}

function atomicWrite(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${crypto.randomUUID()}`, fs.constants.COPYFILE_EXCL);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.writeFileSync(tmp, contents);
        fs.renameSync(tmp, file);
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = function createOpenAIAccounts(options) {
    const authFile = options.authFile;
    const stateDir = options.stateDir;
    const profilesDir = path.join(stateDir, 'openai-accounts');
    const indexFile = path.join(stateDir, 'openai-accounts.json');
    const lockFile = authFile + '.cuimod-lock';
    const spawnLogin = options.spawnLogin;
    const fetchImpl = options.fetch || globalThis.fetch;
    const tokenUrl = options.tokenUrl || TOKEN_URL;
    const usageUrl = options.usageUrl || USAGE_URL;
    const usageCacheMs = options.usageCacheMs ?? 5 * 60 * 1000;
    const log = options.log || (() => {});
    const appServerRequestOverride = options.appServerRequest || null;
    const usageCache = new Map();
    const usageInflight = new Map();
    const usageVersions = new Map();
    const resetInflight = new Map();
    let appServerRequestPromise = null;
    let login = null;
    let disposed = false;

    function isReader() {
        const file = process.env.MODEL_ROUTER_AUTHORITY_FILE || path.join(stateDir, 'credential-authority.json');
        if (!fs.existsSync(file)) return false;
        let value;
        try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
        catch (_) { throw new Error('Credential authority configuration is unavailable.'); }
        if (value?.version !== 1 || typeof value.authorityHost !== 'string')
            throw new Error('Credential authority configuration is unavailable.');
        return value.authorityHost.toLowerCase() !== os.hostname().toLowerCase();
    }

    function readIndex() {
        try {
            const value = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^﻿/, ''));
            return value && typeof value === 'object' ? value : {};
        } catch (_) { return {}; }
    }

    function writeIndex(active) {
        atomicWrite(indexFile, JSON.stringify({ version: 1, active }, null, 2));
    }

    function profileFile(id) {
        if (!/^[a-f0-9]{32}$/.test(String(id))) throw new Error('unknown OpenAI account');
        return path.join(profilesDir, `${id}.json`);
    }

    function saveProfile(account) {
        const file = profileFile(account.id);
        let same = false;
        try { same = fs.readFileSync(file, 'utf8') === account.raw; } catch (_) {}
        if (!same) atomicWrite(file, account.raw);
        return { ...account, file };
    }

    function syncCanonical() {
        const account = readAuth(authFile);
        saveProfile(account);
        const index = readIndex();
        if (index.active !== account.id) writeIndex(account.id);
        return account;
    }

    function profileAccounts() {
        const accounts = [];
        let names = [];
        try { names = fs.readdirSync(profilesDir); } catch (_) {}
        for (const name of names) {
            if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
            try { accounts.push(readAuth(path.join(profilesDir, name))); }
            catch (_) {}
        }
        return accounts;
    }

    function publicStatus() {
        let authError = null;
        try { if (!isReader()) syncCanonical(); }
        catch (_) { authError = 'OpenAI is signed out'; }
        const active = readIndex().active || null;
        const accounts = profileAccounts().map(account => ({
            id: account.id,
            name: account.name,
            email: account.email,
            plan: account.plan,
            active: account.id === active,
        })).sort((a, b) => Number(b.active) - Number(a.active)
            || (a.email || a.name || a.id).localeCompare(b.email || b.name || b.id));
        return {
            active,
            accounts,
            authError,
            login: login ? { phase: login.phase, message: login.message || null } : { phase: 'idle', message: null },
        };
    }

    async function withAuthLock(fn) {
        if (isReader()) throw new Error('OpenAI credentials are owned by the UI machine.');
        let handle = null;
        for (let i = 0; i < 200 && !disposed; i++) {
            try {
                handle = fs.openSync(lockFile, 'wx');
                break;
            } catch (err) {
                if (err?.code !== 'EEXIST') throw err;
                try {
                    if (Date.now() - fs.statSync(lockFile).mtimeMs > 300000) fs.unlinkSync(lockFile);
                } catch (_) {}
                await wait(50);
            }
        }
        if (!handle) throw new Error('OpenAI credentials are busy; try again');
        try { return await fn(); }
        finally {
            try { fs.closeSync(handle); } catch (_) {}
            try { fs.unlinkSync(lockFile); } catch (_) {}
        }
    }

    async function freshAccount(id) {
        if (isReader()) {
            const { readerCredential } = await import('../../../router/credential-authority.mjs');
            const account = authIdentity(authFile, JSON.stringify({ tokens: readerCredential('openai') }));
            if (account.id !== id) throw new Error('Inactive account usage is owned by the UI machine.');
            return account;
        }
        let account = readAuth(profileFile(id));
        const expiry = jwtExpiry(JSON.parse(account.raw).tokens?.access_token);
        if (!expiry || Date.now() <= expiry - 300000) return account;

        return withAuthLock(async () => {
            let canonical = null;
            try { canonical = readAuth(authFile); } catch (_) {}
            account = canonical?.id === id ? canonical : readAuth(profileFile(id));
            const value = JSON.parse(account.raw);
            const tokens = value.tokens || {};
            const currentExpiry = jwtExpiry(tokens.access_token);
            if (!currentExpiry || Date.now() <= currentExpiry - 300000) {
                saveProfile(account);
                return account;
            }
            if (!tokens.refresh_token) throw new Error('OpenAI account needs sign-in again');

            const response = await fetchImpl(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: CLIENT_ID,
                    grant_type: 'refresh_token',
                    refresh_token: tokens.refresh_token,
                }),
            });
            if (!response.ok) throw new Error(`OpenAI token refresh failed (${response.status})`);
            const got = await response.json();
            const next = { ...value, tokens: { ...tokens }, last_refresh: new Date().toISOString() };
            if (got.access_token) next.tokens.access_token = got.access_token;
            if (got.refresh_token) next.tokens.refresh_token = got.refresh_token;
            if (got.id_token) next.tokens.id_token = got.id_token;
            const raw = JSON.stringify(next, null, 2);
            const refreshed = authIdentity(account.file, raw);
            saveProfile(refreshed);
            if (canonical?.id === id) atomicWrite(authFile, raw);
            return refreshed;
        });
    }

    function usageVersion(id) {
        return usageVersions.get(id) || 0;
    }

    function invalidateUsage(id) {
        usageVersions.set(id, usageVersion(id) + 1);
        usageCache.delete(id);
        usageInflight.delete(id);
    }

    async function accountUsage(id, force) {
        const cached = usageCache.get(id);
        if (!force && cached && Date.now() - cached.at < usageCacheMs) return cached.value;
        const running = usageInflight.get(id);
        if (running) {
            if (!force) return running;
            await running.catch(() => {});
        }
        const version = usageVersion(id);
        const promise = (async () => {
            const account = await freshAccount(id);
            const tokens = JSON.parse(account.raw).tokens;
            const response = await fetchImpl(usageUrl, {
                headers: {
                    Authorization: `Bearer ${tokens.access_token}`,
                    'chatgpt-account-id': tokens.account_id,
                    Accept: 'application/json',
                    originator: 'codex_cli_rs',
                },
            });
            if (!response.ok) throw new Error(`OpenAI usage failed (${response.status})`);
            const value = await response.json();
            return {
                observedAt: new Date().toISOString(),
                weekly: weeklyLimit(value),
                resetCredits: Number.isSafeInteger(value?.rate_limit_reset_credits?.available_count)
                    && value.rate_limit_reset_credits.available_count >= 0 ? value.rate_limit_reset_credits.available_count : null,
            };
        })().then(value => {
            if (usageVersion(id) === version) usageCache.set(id, { at: Date.now(), value });
            return value;
        });
        usageInflight.set(id, promise);
        promise.then(
            () => { if (usageInflight.get(id) === promise) usageInflight.delete(id); },
            () => { if (usageInflight.get(id) === promise) usageInflight.delete(id); },
        );
        return promise;
    }

    async function consumeResetViaCodex(account, idempotencyKey) {
        if (!appServerRequestOverride && !appServerRequestPromise)
            appServerRequestPromise = import('../../../router/reset-credits.mjs');
        const appServerRequest = appServerRequestOverride || (await appServerRequestPromise).appServerRequest;
        const home = path.join(stateDir, `openai-reset-${account.id}-${crypto.randomUUID()}`);
        fs.mkdirSync(home, { recursive: true });
        try {
            fs.writeFileSync(path.join(home, 'auth.json'), account.raw, { mode: 0o600 });
            return await appServerRequest('account/rateLimitResetCredit/consume', { idempotencyKey }, {
                env: { ...process.env, CODEX_HOME: home },
            });
        } finally {
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
        }
    }

    async function consumeResetCreditOnce(id) {
        if (disposed) throw new Error('OpenAI account manager is unavailable');
        if (isReader()) throw new Error('OpenAI reset credits are owned by the UI machine.');
        readAuth(profileFile(id));
        const before = await accountUsage(id, true);
        // Usage may refresh an expired profile; redeem with the token just read,
        // not the credential snapshot that preceded that refresh.
        const account = readAuth(profileFile(id));
        const requestFile = path.join(stateDir, `openai-reset-request-${account.id}.json`);
        function pendingKey() {
            try {
                const key = JSON.parse(fs.readFileSync(requestFile, 'utf8')).idempotencyKey;
                if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key))
                    throw new Error('Invalid pending OpenAI reset request');
                return key;
            } catch (error) {
                if (error?.code === 'ENOENT') return null;
                throw error;
            }
        }
        // A lost response can already have spent the credit. Keep the exact
        // request key across usage changes and host reloads until its outcome
        // is known; deriving a new key from the reduced count spends another.
        let idempotencyKey = pendingKey();
        if (!idempotencyKey) {
            if (!Number.isFinite(before.resetCredits) || before.resetCredits < 1)
                throw new Error('No OpenAI reset credit available');
            idempotencyKey = crypto.randomUUID();
            fs.mkdirSync(stateDir, { recursive: true });
            try { fs.writeFileSync(requestFile, JSON.stringify({ idempotencyKey }), { flag: 'wx' }); }
            catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                idempotencyKey = pendingKey();
                if (!idempotencyKey) throw new Error('Reset request completed; reread usage before retrying');
            }
        }
        let result;
        try { result = await consumeResetViaCodex(account, idempotencyKey); }
        finally { invalidateUsage(id); }
        const outcome = result?.outcome;
        if (RESET_OUTCOMES.has(outcome) || outcome === 'noCredit' || outcome === 'nothingToReset')
            fs.rmSync(requestFile, { force: true });
        if (!RESET_OUTCOMES.has(outcome)) throw new Error(`OpenAI reset credit was not consumed (${outcome || 'unknown outcome'})`);
        let quota;
        try { quota = await accountUsage(id, true); }
        catch (error) { throw new Error(`Reset credit applied; usage refresh failed: ${error?.message || error}`); }
        return { accountId: id, outcome, usage: quota };
    }

    async function consumeResetCreditForAccount(id) {
        const running = resetInflight.get(id);
        if (running) return running;
        const promise = consumeResetCreditOnce(id);
        resetInflight.set(id, promise);
        promise.then(
            () => { if (resetInflight.get(id) === promise) resetInflight.delete(id); },
            () => { if (resetInflight.get(id) === promise) resetInflight.delete(id); },
        );
        return promise;
    }

    async function usage(force = false) {
        const status = publicStatus();
        const accounts = [];
        // These are paid account endpoints. Read each profile once and sequentially;
        // the cache prevents an open dashboard from turning into a polling burst.
        for (const account of status.accounts) {
            let quota;
            try { quota = await accountUsage(account.id, force); }
            catch (err) { quota = { error: err?.message || 'OpenAI usage unavailable' }; }
            accounts.push({ ...account, usage: quota });
        }
        return { ...status, accounts };
    }

    async function autoSwitch(threshold, currentSettings) {
        if (isReader()) return { switched: false, reason: 'authority-owned' };
        const limit = Number(threshold);
        if (!Number.isFinite(limit)) return { switched: false, reason: 'invalid-threshold' };

        const status = publicStatus();
        const active = status.accounts.find(account => account.active);
        if (!active) return { switched: false, reason: 'no-active-account' };
        if (status.accounts.length < 2) return { switched: false, reason: 'no-eligible-account' };

        let activeUsage;
        try { activeUsage = await accountUsage(active.id); }
        catch (_) { return { switched: false, reason: 'usage-unavailable' }; }
        const used = activeUsage?.weekly?.usedPercent;
        if (!Number.isFinite(used)) return { switched: false, reason: 'usage-unavailable' };
        if (used < limit) return { switched: false, reason: 'below-threshold' };

        const candidates = [];
        // Do not read inactive meters unless the active account can actually
        // trigger a switch. These are paid account endpoints.
        for (const account of status.accounts) {
            if (account.id === active.id) continue;
            let quota;
            try { quota = await accountUsage(account.id); }
            catch (_) { continue; }
            const candidateUsed = quota?.weekly?.usedPercent;
            if (Number.isFinite(candidateUsed) && candidateUsed < limit)
                candidates.push({ ...account, usage: quota });
        }
        const target = candidates.sort((a, b) => a.usage.weekly.usedPercent - b.usage.weekly.usedPercent
            || a.id.localeCompare(b.id))[0];
        if (!target) return { switched: false, reason: 'no-eligible-account' };

        try {
            return await withAuthLock(async () => {
                let canonical;
                try { canonical = readAuth(authFile); }
                catch (_) { return { switched: false, reason: 'usage-unavailable' }; }
                if (canonical.id !== active.id) return { switched: false, reason: 'stale-active-account' };

                let replacement;
                try { replacement = readAuth(profileFile(target.id)); }
                catch (_) { return { switched: false, reason: 'no-eligible-account' }; }
                if (replacement.id !== target.id) return { switched: false, reason: 'no-eligible-account' };

                saveProfile(canonical);
                const settings = typeof currentSettings === 'function'
                    ? currentSettings() : { enabled: true, threshold: limit };
                if (!settings?.enabled || Number(settings.threshold) !== limit)
                    return { switched: false, reason: 'settings-changed' };
                atomicWrite(authFile, replacement.raw);
                writeIndex(replacement.id);
                return { switched: true, from: active.id, to: replacement.id };
            });
        } catch (_) {
            return { switched: false, reason: 'usage-unavailable' };
        }
    }

    async function switchAccount(id) {
        return withAuthLock(async () => {
            const target = readAuth(profileFile(id));
            try { saveProfile(readAuth(authFile)); } catch (_) {}
            atomicWrite(authFile, target.raw);
            writeIndex(target.id);
            return publicStatus();
        });
    }

    async function removeAccount(id) {
        return withAuthLock(async () => {
            const file = profileFile(id);
            if (!fs.existsSync(file)) throw new Error('unknown OpenAI account');
            let canonical = null;
            try { canonical = readAuth(authFile); } catch (_) {}
            // Every status read re-imports auth.json as a profile. Deleting only
            // the stored profile of the active account would resurrect it, so
            // the canonical file is handed to another account or removed.
            if (canonical?.id === id) {
                const cachedUsed = account => usageCache.get(account.id)?.value?.weekly?.usedPercent;
                const rank = account => Number.isFinite(cachedUsed(account)) ? cachedUsed(account) : Infinity;
                const next = profileAccounts().filter(account => account.id !== id)
                    .sort((a, b) => rank(a) - rank(b)
                        || (a.email || a.name || a.id).localeCompare(b.email || b.name || b.id))[0];
                if (next) {
                    atomicWrite(authFile, next.raw);
                    writeIndex(next.id);
                } else {
                    fs.rmSync(authFile, { force: true });
                    writeIndex(null);
                }
            }
            fs.rmSync(file, { force: true });
            invalidateUsage(id);
            return publicStatus();
        });
    }

    function isCurrentLogin(child) {
        return !disposed && login?.child === child;
    }

    async function finishLogin(home, code, child) {
        if (!isCurrentLogin(child)) return;
        if (code !== 0) {
            if (!isCurrentLogin(child)) return;
            login = { phase: 'error', message: 'Sign-in did not finish' };
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
            return;
        }
        try {
            const incoming = readAuth(path.join(home, 'auth.json'));
            if (!isCurrentLogin(child)) return;
            await withAuthLock(async () => {
                // The host can cancel a completed browser login while this waits
                // behind a refresh or account switch. Never revive it afterward.
                if (!isCurrentLogin(child)) return;
                try { saveProfile(readAuth(authFile)); } catch (_) {}
                saveProfile(incoming);
                atomicWrite(authFile, incoming.raw);
                writeIndex(incoming.id);
            });
            if (!isCurrentLogin(child)) return;
            login = { phase: 'done', message: 'Account added and selected' };
        } catch (err) {
            if (!isCurrentLogin(child)) return;
            login = { phase: 'error', message: err?.message || 'Could not save the OpenAI login' };
            log('OpenAI account login failed: ' + (err?.message || err));
        } finally {
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
        }
    }

    function startLogin() {
        if (isReader()) throw new Error('OpenAI sign-in is owned by the UI machine.');
        if (login?.phase === 'waiting') return publicStatus();
        const home = path.join(stateDir, `openai-login-${crypto.randomBytes(8).toString('hex')}`);
        fs.mkdirSync(home, { recursive: true });
        let child;
        try { child = spawnLogin(home); }
        catch (err) {
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
            login = { phase: 'error', message: 'Could not start OpenAI sign-in' };
            log('OpenAI account login launch failed: ' + (err?.message || err));
            return publicStatus();
        }
        login = { phase: 'waiting', message: 'Finish signing in in your browser', child, home };
        const onError = err => {
            if (disposed || login?.child !== child) return;
            login = { phase: 'error', message: 'Could not start OpenAI sign-in' };
            log('OpenAI account login process failed: ' + (err?.message || err));
            try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
        };
        const onExit = code => {
            if (login?.child !== child) return;
            finishLogin(home, code, child).catch(err => log('OpenAI account login completion failed: ' + (err?.message || err)));
        };
        child.once('error', onError);
        child.once('exit', onExit);
        login.onError = onError;
        login.onExit = onExit;
        return publicStatus();
    }

    function cancelLogin() {
        const current = login;
        if (!current?.child) return;
        current.child.removeListener('error', current.onError);
        current.child.removeListener('exit', current.onExit);
        try { current.child.kill(); } catch (_) {}
        try { fs.rmSync(current.home, { recursive: true, force: true }); } catch (_) {}
        login = null;
    }

    function dispose() {
        disposed = true;
        cancelLogin();
    }

    return { status: publicStatus, usage, consumeResetCredit: consumeResetCreditForAccount, autoSwitch, switchAccount, removeAccount, startLogin, cancelLogin, dispose };
};

module.exports.authIdentity = authIdentity;
module.exports.weeklyLimit = weeklyLimit;
