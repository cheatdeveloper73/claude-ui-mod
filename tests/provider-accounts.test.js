'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const createOpenAIAccounts = require('../src/plugins/provider-picker/accounts');
const { weeklyLimit } = createOpenAIAccounts;

const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
function auth(accountId, email, name, plan, expires = Math.floor(Date.now() / 1000) + 3600) {
    const claims = {
        email,
        name,
        'https://api.openai.com/auth': { chatgpt_plan_type: plan },
    };
    return JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
            access_token: jwt({ ...claims, exp: expires }),
            id_token: jwt(claims),
            refresh_token: `refresh-${accountId}`,
            account_id: accountId,
        },
    }, null, 2);
}

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('condition did not settle');
}

function addProfile(stateDir, raw) {
    const account = createOpenAIAccounts.authIdentity('fixture', raw);
    const dir = path.join(stateDir, 'openai-accounts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${account.id}.json`), raw);
    return account;
}

function usageResponse(usedPercent) {
    return new Response(JSON.stringify({ rate_limit: { primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 604800,
        reset_at: 1893456000,
    } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('OpenAI account store imports, adds, and switches credentials without exposing tokens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-accounts-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let child = null;
    const manager = createOpenAIAccounts({
        authFile,
        stateDir,
        spawnLogin(home) {
            child = new EventEmitter();
            child.kill = () => {};
            queueMicrotask(() => {
                fs.writeFileSync(path.join(home, 'auth.json'), auth('account-two', 'two@example.test', 'Two', 'pro'));
                child.emit('exit', 0);
            });
            return child;
        },
    });
    try {
        const initial = manager.status();
        assert.equal(initial.accounts.length, 1);
        assert.equal(initial.accounts[0].email, 'one@example.test');
        assert.equal(initial.accounts[0].plan, 'plus');
        assert.equal(initial.accounts[0].active, true);
        assert.equal(JSON.stringify(initial).includes('refresh-account-one'), false);
        assert.equal(JSON.stringify(initial).includes('access_token'), false);

        const waiting = manager.startLogin();
        assert.equal(waiting.login.phase, 'waiting');
        const added = await until(() => {
            const value = manager.status();
            return value.login.phase === 'done' ? value : null;
        });
        assert.equal(added.accounts.length, 2);
        assert.equal(added.accounts.find(account => account.active).email, 'two@example.test');
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-two');

        const first = added.accounts.find(account => account.email === 'one@example.test');
        const switched = await manager.switchAccount(first.id);
        assert.equal(switched.accounts.find(account => account.active).email, 'one@example.test');
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('removing an account deletes its stored credentials and hands the active slot on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-account-remove-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const manager = createOpenAIAccounts({ authFile, stateDir, spawnLogin() { throw new Error('unused'); } });
    const profile = id => path.join(stateDir, 'openai-accounts', `${id}.json`);
    try {
        const first = manager.status().accounts[0];
        const second = addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const third = addProfile(stateDir, auth('account-three', 'three@example.test', 'Three', 'pro'));

        const inactive = await manager.removeAccount(third.id);
        assert.deepEqual(inactive.accounts.map(account => account.id).sort(), [first.id, second.id].sort());
        assert.equal(fs.existsSync(profile(third.id)), false);
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');

        // The canonical file is re-imported on every status read, so removing
        // the active account must replace it or the account comes straight back.
        const active = await manager.removeAccount(first.id);
        assert.equal(active.active, second.id);
        assert.deepEqual(active.accounts.map(account => account.id), [second.id]);
        assert.equal(fs.existsSync(profile(first.id)), false);
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-two');
        assert.deepEqual(manager.status().accounts.map(account => account.id), [second.id]);

        const last = await manager.removeAccount(second.id);
        assert.equal(last.active, null);
        assert.deepEqual(last.accounts, []);
        assert.equal(fs.existsSync(authFile), false);
        assert.deepEqual(manager.status().accounts, []);
        await assert.rejects(manager.removeAccount(second.id), /unknown OpenAI account/);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('cancelled login cannot overwrite auth after waiting on the account lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-login-cancel-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let child;
    let loginHome;
    const manager = createOpenAIAccounts({
        authFile, stateDir,
        spawnLogin(home) {
            loginHome = home;
            child = new EventEmitter();
            child.kill = () => {};
            return child;
        },
    });
    try {
        const initial = manager.status().accounts[0];
        const incoming = auth('account-two', 'two@example.test', 'Two', 'pro');
        const target = createOpenAIAccounts.authIdentity('fixture', incoming);
        manager.startLogin();
        fs.writeFileSync(path.join(loginHome, 'auth.json'), incoming);
        const lock = authFile + '.cuimod-lock';
        fs.writeFileSync(lock, 'account refresh in progress');
        child.emit('exit', 0);
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(manager.status().login.phase, 'waiting', 'completion must still be blocked on auth lock');

        manager.cancelLogin();
        assert.equal(manager.status().login.phase, 'idle');
        fs.unlinkSync(lock);
        await new Promise(resolve => setTimeout(resolve, 120));

        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'openai-accounts.json'), 'utf8')).active, initial.id);
        assert.equal(fs.existsSync(path.join(stateDir, 'openai-accounts', `${target.id}.json`)), false);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('main-model weekly usage excludes the separate Codex Spark meter', () => {
    const value = {
        rate_limit: {
            primary_window: { used_percent: 42.25, limit_window_seconds: 18000, reset_at: 100 },
            secondary_window: { used_percent: 17.5, limit_window_seconds: 604800, reset_at: 200 },
        },
        additional_rate_limits: [{
            limit_name: 'GPT-5.3-Codex-Spark',
            rate_limit: { secondary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: 300 } },
        }],
    };
    assert.deepEqual(weeklyLimit(value), { usedPercent: 17.5, resetAt: 200, windowSeconds: 604800 });
});

test('usage reads each stored account once and returns no credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-account-usage-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let child;
    const calls = [];
    const manager = createOpenAIAccounts({
        authFile,
        stateDir,
        usageCacheMs: 60000,
        fetch: async (_url, options) => {
            calls.push(options.headers['chatgpt-account-id']);
            const used = options.headers['chatgpt-account-id'] === 'account-one' ? 12.5 : 37;
            return new Response(JSON.stringify({
                rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800, reset_at: 1893456000 } },
                additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark', rate_limit: {
                    primary_window: { used_percent: 88, limit_window_seconds: 604800, reset_at: 1999999999 },
                } }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
        spawnLogin(home) {
            child = new EventEmitter(); child.kill = () => {};
            queueMicrotask(() => {
                fs.writeFileSync(path.join(home, 'auth.json'), auth('account-two', 'two@example.test', 'Two', 'pro'));
                child.emit('exit', 0);
            });
            return child;
        },
    });
    try {
        manager.status();
        manager.startLogin();
        await until(() => manager.status().login.phase === 'done');
        const first = await manager.usage();
        const second = await manager.usage();
        assert.deepEqual(calls.sort(), ['account-one', 'account-two']);
        assert.equal(first.accounts.find(account => account.email === 'one@example.test').usage.weekly.usedPercent, 12.5);
        assert.equal(first.accounts.find(account => account.email === 'two@example.test').usage.weekly.usedPercent, 37);
        assert.deepEqual(second.accounts.map(account => account.usage.weekly.resetAt), first.accounts.map(account => account.usage.weekly.resetAt));
        const serialized = JSON.stringify(first);
        for (const secret of ['refresh-account-one', 'refresh-account-two', 'access_token', 'GPT-5.3-Codex-Spark'])
            assert.equal(serialized.includes(secret), false);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('usage exposes reset-credit count and consumes only the selected account before rereading it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-reset-credit-account-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const usageCalls = [];
    const consumeCalls = [];
    const remaining = new Map([['account-one', [2]], ['account-two', [5, 5, 4]]]);
    const manager = createOpenAIAccounts({
        authFile, stateDir, usageCacheMs: 60000, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => {
            const id = options.headers['chatgpt-account-id'];
            usageCalls.push(id);
            const values = remaining.get(id) || [];
            const resetCredits = values.shift();
            return new Response(JSON.stringify({
                rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1893456000 } },
                rate_limit_reset_credits: { available_count: resetCredits },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
        appServerRequest: async (method, params, options) => {
            assert.equal(method, 'account/rateLimitResetCredit/consume');
            const scopedHome = options.env.CODEX_HOME;
            const scoped = JSON.parse(fs.readFileSync(path.join(scopedHome, 'auth.json'), 'utf8'));
            consumeCalls.push({ id: scoped.tokens.account_id, key: params.idempotencyKey, scopedHome });
            return { outcome: 'reset' };
        },
    });
    try {
        manager.status();
        const target = addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const before = await manager.usage();
        assert.equal(before.accounts.find(account => account.id === target.id).usage.resetCredits, 5);

        const after = await manager.consumeResetCredit(target.id);
        assert.equal(after.accountId, target.id);
        assert.equal(after.outcome, 'reset');
        assert.equal(after.usage.resetCredits, 4);
        assert.deepEqual(consumeCalls.map(call => call.id), ['account-two']);
        assert.match(consumeCalls[0].key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(fs.existsSync(consumeCalls[0].scopedHome), false, 'scoped auth home must be removed after the request');
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one',
            'consumption must never switch the canonical account');
        assert.deepEqual(usageCalls, ['account-one', 'account-two', 'account-two', 'account-two']);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reset retries reuse their key and overlapping requests consume once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-reset-retry-'));
    const authFile = path.join(root, 'auth.json');
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const keys = [];
    let fail = true;
    const options = {
        authFile, stateDir: path.join(root, '.state'),
        fetch: async () => new Response(JSON.stringify({
            rate_limit: { primary_window: { used_percent: fail ? 99 : 0, limit_window_seconds: 604800, reset_at: 1893456000 } },
            rate_limit_reset_credits: { available_count: fail ? 2 : 1 },
        })),
        appServerRequest: async (_method, params) => {
            keys.push(params.idempotencyKey);
            await new Promise(resolve => setTimeout(resolve, 15));
            if (fail) throw new Error('response lost');
            return { outcome: 'alreadyRedeemed' };
        },
    };
    let manager = createOpenAIAccounts(options);
    try {
        const id = manager.status().active;
        await assert.rejects(manager.consumeResetCredit(id), /response lost/);
        await assert.rejects(manager.consumeResetCredit(id), /response lost/);
        assert.equal(keys[0], keys[1], 'a new usage observation must not create a second redemption key');
        fail = false;
        manager.dispose();
        manager = createOpenAIAccounts(options);
        const results = await Promise.all([manager.consumeResetCredit(id), manager.consumeResetCredit(id)]);
        assert.equal(keys.length, 3);
        assert.equal(keys[2], keys[0], 'a lost response can already have reduced the API credit count');
        assert.equal(results[0].usage.weekly.usedPercent, 0);
        assert.deepEqual(results[0], results[1]);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function resetRendererHarness() {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/renderer.js'), 'utf8');
    const nodes = [];
    const calls = [];
    let answer = { accountId: 'one', outcome: 'reset', usage: { observedAt: 'after', resetCredits: 1, weekly: { usedPercent: 0 } } };
    const context = vm.createContext({
        document: { createElement() {
            const handlers = {};
            const node = { style: {}, setAttribute() {}, append(icon) { this.icon = icon; }, addEventListener: (event, fn) => { handlers[event] = fn; },
                dispatch: (event, detail = 1) => handlers[event]?.({ detail }) };
            nodes.push(node);
            return node;
        } },
        cuimod: { rpc: async (method, params) => { calls.push({ method, params }); if (answer instanceof Error) throw answer; return answer; } },
        queueMicrotask,
    });
    vm.runInContext(`let accountState = { accounts: [{ id: 'one', usage: { observedAt: 'before', resetCredits: 2, weekly: { usedPercent: 99 } } }] };
        let accountBusy = false, accountResetBusy = null, accountResetConfirm = null;
        let accountUsageBusy = false, disposed = false;
        function paintAccountPanel() {}
        const accountName = account => account.id;
        ${source.slice(source.indexOf('function mergeAccountUsage('), source.indexOf('function resetDate('))}
        ${source.slice(source.indexOf('function accountButton('), source.indexOf('function accountAction('))}
        ${source.slice(source.indexOf('function accountResetButton('), source.indexOf('function paintAccountPanel('))}
        function make() { return accountResetButton(accountState.accounts[0], false, false); }
        function state() { return accountState.accounts[0].usage; }`, context);
    return { context, calls, make: () => vm.runInContext('make()', context), state: () => vm.runInContext('state()', context),
        fail: () => { answer = new Error('refresh failed'); } };
}

test('displayed reset count requires a double click and repaints returned usage', async () => {
    const ui = resetRendererHarness();
    const button = ui.make();
    assert.match(button.textContent, /2 resets/);
    assert.equal(button.icon?.innerHTML?.includes('stroke-width="2.4"'), true, 'reset icon must use a drawn, legible stroke');
    assert.equal(button.textContent.includes('↻'), false, 'the font glyph must not be used');
    await button.dispatch('click', 1);
    assert.equal(ui.calls.length, 0, 'single click only arms confirmation');
    await button.dispatch('click', 2);
    assert.equal(ui.calls.length, 0, 'the second click event alone must not redeem');
    await button.dispatch('dblclick', 2);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].params.id, 'one');
    assert.equal(ui.state().weekly.usedPercent, 0);
    assert.equal(ui.state().resetCredits, 1);
});

test('changed usage invalidates double-click confirmation and duplicate events cannot redeem twice', async () => {
    const ui = resetRendererHarness();
    const button = ui.make();
    await button.dispatch('click', 1);
    vm.runInContext("accountState.accounts[0].usage.observedAt = 'newer'", ui.context);
    await button.dispatch('dblclick', 2);
    assert.equal(ui.calls.length, 0);
    await button.dispatch('click', 1);
    await Promise.all([button.dispatch('dblclick', 2), button.dispatch('dblclick', 2)]);
    assert.equal(ui.calls.length, 1);
});

test('zero or unknown reset credits never reach the consume transport', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-reset-unavailable-'));
    const authFile = path.join(root, 'auth.json');
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let count = 0;
    let calls = 0;
    const manager = createOpenAIAccounts({
        authFile, stateDir: path.join(root, '.state'),
        fetch: async () => new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: count } })),
        appServerRequest: async () => { calls++; throw new Error('must never consume'); },
    });
    try {
        const id = manager.status().active;
        for (count of [0, null, -1, 1.5]) await assert.rejects(manager.consumeResetCredit(id), /No OpenAI reset credit/);
        assert.equal(calls, 0);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed post-reset read invalidates the cached pre-reset meter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-reset-refresh-'));
    const authFile = path.join(root, 'auth.json');
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let consumed = false;
    const manager = createOpenAIAccounts({
        authFile, stateDir: path.join(root, '.state'),
        fetch: async () => {
            if (consumed) throw new Error('usage read failed');
            return new Response(JSON.stringify({ rate_limit_reset_credits: { available_count: 2 },
                rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: 1893456000 } } }));
        },
        appServerRequest: async () => { consumed = true; return { outcome: 'reset' }; },
    });
    try {
        const id = manager.status().active;
        await manager.usage();
        await assert.rejects(manager.consumeResetCredit(id), /usage read failed/);
        const current = (await manager.usage()).accounts[0].usage;
        assert.equal(current.weekly, undefined);
        assert.match(current.error, /usage read failed/);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed reset refresh clears the stale usage bar', async () => {
    const ui = resetRendererHarness();
    ui.fail();
    const button = ui.make();
    await button.dispatch('click', 1);
    await button.dispatch('dblclick', 2);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.state().weekly, undefined);
    assert.match(ui.state().error, /refresh failed/);
});

test('an inactive account refreshes for usage without replacing the active account', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-inactive-refresh-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const calls = [];
    const manager = createOpenAIAccounts({
        authFile,
        stateDir,
        tokenUrl: 'https://fixture.test/token',
        usageUrl: 'https://fixture.test/usage',
        fetch: async (url, options) => {
            if (url.endsWith('/token')) {
                const body = JSON.parse(options.body);
                calls.push(body.refresh_token);
                return new Response(JSON.stringify({
                    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
                    refresh_token: 'rotated-account-one',
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({ rate_limit: {
                primary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: 1893456000 },
            } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
        spawnLogin() { throw new Error('unused'); },
    });
    try {
        const first = manager.status().accounts[0];
        fs.writeFileSync(path.join(stateDir, 'openai-accounts', `${first.id}.json`),
            auth('account-one', 'one@example.test', 'One', 'plus', Math.floor(Date.now() / 1000) - 60));
        fs.writeFileSync(authFile, auth('account-two', 'two@example.test', 'Two', 'pro'));
        manager.status();
        await manager.usage();
        assert.deepEqual(calls, ['refresh-account-one']);
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-two');
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'openai-accounts', `${first.id}.json`), 'utf8')).tokens.refresh_token,
            'rotated-account-one');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('OpenAI account controls stay outside the native model menu', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/renderer.js'), 'utf8');
    const decoration = source.slice(source.indexOf('function decorate(menu)'), source.indexOf('function reanchor()'));
    assert.doesNotMatch(decoration, /account(?:Action|Control|Panel|Switch|Login)/,
        'focusable account controls inside the native menu can break its owned focus tree');
    assert.match(source, /type: 'custom'[^}]*node: accountControl/,
        'the provider dashboard must retain the account management surface');
    assert.match(decoration, /poolStrip\.dataset\.cuimodPoolPin = 'native'/,
        'the Gemini account pool belongs in the model picker');
    assert.match(decoration, /choice\.setAttribute\('role', 'radio'\);[\s\S]*choice\.tabIndex = -1/,
        'pool choices must not join the native menu focus tree');
    assert.match(decoration, /active === 'gemini'/,
        'the pool selector must stay scoped to the Gemini provider tab');
    assert.doesNotMatch(decoration, /poolStrip[\s\S]*menuitemradio/,
        'pool accounts are controls, never fake model rows');
    assert.match(source, /copy\.append\(usage\);/,
        'reset credits must not add a fourth line to the account details');
    assert.match(source, /actions\.append\(creditLine\);/,
        'reset credits belong above the account action in its existing right-hand space');
    assert.match(source, /accountResetConfirm/,
        'reset consumption must have a renderer-side confirmation state');
    assert.match(source, /provider-picker\.accountResetCredit/,
        'the reset action must target the account RPC rather than the active-account switch');
    assert.match(source, /current\.usage\?\.observedAt !== accountResetConfirm\.observedAt/,
        'a confirmation from an older usage read must not consume a newer account state');
    assert.match(source, /markAccountUsageError\(account\.id/,
        'a failed post-consumption usage read must not retain a stale bar');
    const main = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/main.js'), 'utf8');
    assert.match(main, /ctx\.method\('accountResetCredit', p => accounts\.consumeResetCredit\(p\?\.id\)\)/);
});

test('provider strip recognizes current generic menu rows without data-model-id', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/renderer.js'), 'utf8');
    const helpers = renderer.slice(renderer.indexOf('let owners = new Map();'), renderer.indexOf('const decorated = new Map();'));
    const api = vm.runInNewContext('(function(){' + helpers + '; return { refreshModelLabels, rowModelId, modelIdFromText, MENU, ROW }; })()');
    const custom = [
        { id: 'claude-gpt-5.6-sol[1m]', name: 'GPT-5.6 Sol 1M', provider: 'openai' },
        { id: 'claude-opus-4-6-google', name: 'Claude Opus 4.6 (Google)', provider: 'gemini' },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'claude' },
    ];
    const native = [{ id: 'claude-fable-5-1', name: 'Fable 5.1' }];
    api.refreshModelLabels(custom, native);
    const row = (text, dataset = {}, attrs = {}) => ({
        textContent: text,
        dataset: { ...dataset },
        getAttribute(name) { return attrs[name] ?? null; },
    });

    assert.equal(api.rowModelId(row('✓ GPT-5.6 Sol 1M6')), 'claude-gpt-5.6-sol[1m]');
    assert.equal(api.rowModelId(row('Claude Opus 4.6 (Google)9')), 'claude-opus-4-6-google',
        'longer provider-qualified labels must win over their prefix');
    assert.equal(api.rowModelId(row('Fable 5.1 Pro or Max2')), 'claude-fable-5-1',
        'native badge text may follow the base model name');
    assert.equal(api.rowModelId(row('legacy', { modelId: 'claude-opus-4-6' })), 'claude-opus-4-6',
        'the previous data-model-id contract remains supported');
    assert.equal(api.ROW, '[role="menuitemradio"]');
    assert.match(api.MENU, /data-cds="ModelSelector"/);
    assert.match(api.MENU, /data-cds="Menu"/);
    assert.match(renderer, /const TAB_COLUMNS = 4;/,
        'provider tabs must wrap at four per row so seven providers land 4/3');
    assert.match(renderer, /display:flex;gap:\$\{TAB_GAP\}px;width:100%/,
        'each tab row must be an inline flex line, not a column of stacked tabs');
    assert.match(renderer, /line\.style\.width = 'max-content'[\s\S]{0,260}getBoundingClientRect\(\)\.width[\s\S]{0,200}line\.style\.width = '100%'/,
        'rows must be measured at intrinsic width, then stretched so 4 and 3 end on one edge');
    assert.match(renderer, /flex:1 1 auto;min-width:max-content;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis/,
        'tabs must keep content-sized flex bases so long provider labels stay visible');
    assert.match(renderer, /for \(const button of allTabs\) button\.style\.flex = '1 1 auto'/,
        'tabs must return to content-based flex sizing after intrinsic row measurement');
    assert.match(renderer, /row-gap:\$\{TAB_GAP\}px/,
        'rows must use one small gap rather than stacking gaps on button padding');
    assert.match(renderer, /strip\.scrollWidth \+ menuChrome/,
        'the popup must size to the tab rows plus its native chrome');
    assert.match(renderer, /overflow-x:auto;scrollbar-width:none/,
        'a narrow viewport must scroll the tab rows instead of clipping labels');

    const main = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/main.js'), 'utf8');
    assert.match(main, /\{ id: m\.wireId, name: m\.name, provider: m\.provider \}/,
        'renderer sync must carry injected display names for generic menu rows');
});

test('model picker pool RPC reads status and applies exact pin and Auto actions through the local router', async () => {
    const http = require('node:http');
    const mainPath = require.resolve('../src/plugins/provider-picker/main');
    const accountsPath = require.resolve('../src/plugins/provider-picker/accounts');
    const heldMain = require.cache[mainPath];
    const originalAccounts = require.cache[accountsPath].exports;
    const previousRouter = process.env.CUIMOD_ROUTER_URL;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-pool-pin-'));
    const requests = [];
    const server = http.createServer((req, res) => {
        (async () => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
            requests.push({ method: req.method, url: req.url, body });
            const status = body?.action === 'pin'
                ? { mode: 'pin', targetAccountId: body.id, appliedAccountId: body.id, applied: true }
                : { mode: 'auto', targetAccountId: null, appliedAccountId: null, applied: true };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, label: 'Account pool', accounts: [
                { id: 1, name: 'One', schedulable: true }, { id: 2, name: 'Two', schedulable: true },
            ], ...status }));
        })().catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.CUIMOD_ROUTER_URL = `http://127.0.0.1:${server.address().port}`;
    require.cache[accountsPath].exports = () => ({
        status: () => ({ active: null, accounts: [] }), usage: async () => ({ active: null, accounts: [] }),
        autoSwitch: async () => ({ switched: false }), switchAccount: async () => ({}), startLogin: () => ({}),
        cancelLogin() {}, dispose() {},
    });
    delete require.cache[mainPath];
    const methods = {};
    const disposers = [];
    try {
        require(mainPath)({
            dir: path.join(__dirname, '../src/plugins/provider-picker'), boot: { MOD_DIR: root },
            electron: { webContents: { getAllWebContents: () => [] } },
            method: (name, fn) => { methods[name] = fn; }, every() {}, onDispose: fn => disposers.push(fn), log() {},
        });
        const initial = await methods.poolPinStatus();
        assert.equal(initial.supported, true);
        assert.equal(initial.mode, 'auto');
        assert.deepEqual(initial.accounts.map(account => account.name), ['One', 'Two']);

        const pinned = await methods.poolPinSet({ action: 'pin', id: 2 });
        assert.equal(pinned.targetAccountId, 2);
        assert.equal(pinned.applied, true);
        const restored = await methods.poolPinSet({ action: 'auto' });
        assert.equal(restored.mode, 'auto');
        assert.deepEqual(requests.map(row => [row.method, row.url, row.body]), [
            ['GET', '/poolpinz', null],
            ['POST', '/poolpinz', { action: 'pin', id: 2 }],
            ['POST', '/poolpinz', { action: 'auto' }],
        ]);
        await assert.rejects(methods.poolPinSet({ action: 'pin', id: 0 }), /Invalid account id/);
        assert.equal(requests.length, 3, 'invalid ids must fail before router mutation');
    } finally {
        disposers.reverse().forEach(fn => fn());
        await new Promise(resolve => server.close(resolve));
        require.cache[accountsPath].exports = originalAccounts;
        if (heldMain) require.cache[mainPath] = heldMain;
        else delete require.cache[mainPath];
        if (previousRouter === undefined) delete process.env.CUIMOD_ROUTER_URL;
        else process.env.CUIMOD_ROUTER_URL = previousRouter;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('OpenAI account switch waits for a credential refresh lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-account-lock-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const manager = createOpenAIAccounts({ authFile, stateDir, spawnLogin() { throw new Error('unused'); } });
    try {
        const first = manager.status().accounts[0];
        fs.writeFileSync(authFile, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const second = manager.status().accounts.find(account => account.email === 'two@example.test');
        const lock = authFile + '.cuimod-lock';
        fs.writeFileSync(lock, 'refreshing');
        setTimeout(() => fs.unlinkSync(lock), 80);
        const switched = await manager.switchAccount(first.id);
        assert.equal(switched.active, first.id);
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
        assert.notEqual(second.id, first.id);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching does not poll a single stored account', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-single-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let usageCalls = 0;
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async () => { usageCalls++; throw new Error('usage must not be requested'); },
    });
    try {
        assert.deepEqual(await manager.autoSwitch(98), { switched: false, reason: 'no-eligible-account' });
        assert.equal(usageCalls, 0);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching leaves a below-threshold active account selected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-below-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const usageCalls = [];
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => {
            const id = options.headers['chatgpt-account-id'];
            usageCalls.push(id);
            return usageResponse(id === 'account-one' ? 97 : 10);
        },
    });
    try {
        manager.status();
        addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const result = await manager.autoSwitch(98);
        assert.deepEqual(result, { switched: false, reason: 'below-threshold' });
        assert.deepEqual(usageCalls, ['account-one'], 'below threshold must not read an inactive paid meter');
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching chooses the lowest eligible account with a stable ID tie-break', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-target-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => usageResponse(options.headers['chatgpt-account-id'] === 'account-one' ? 99 : 10),
    });
    try {
        const first = manager.status().accounts[0];
        const second = addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const third = addProfile(stateDir, auth('account-three', 'three@example.test', 'Three', 'pro'));
        const target = [second, third].sort((a, b) => a.id.localeCompare(b.id))[0];
        const result = await manager.autoSwitch(98);
        assert.deepEqual(result, { switched: true, from: first.id, to: target.id });
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id,
            target.id === second.id ? 'account-two' : 'account-three');
        assert.equal(JSON.stringify(result).includes('refresh-'), false);
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching leaves no eligible or unknown candidate selected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-unavailable-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => {
            const id = options.headers['chatgpt-account-id'];
            return usageResponse(id === 'account-one' ? 99 : id === 'account-two' ? null : 98);
        },
    });
    try {
        manager.status();
        addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        addProfile(stateDir, auth('account-three', 'three@example.test', 'Three', 'pro'));
        const result = await manager.autoSwitch(98);
        assert.deepEqual(result, { switched: false, reason: 'no-eligible-account' });
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching revalidates the active account after acquiring the auth lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-stale-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    const usageCalls = [];
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => {
            const id = options.headers['chatgpt-account-id'];
            usageCalls.push(id);
            return usageResponse(id === 'account-one' ? 99 : 10);
        },
    });
    try {
        manager.status();
        addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const manual = addProfile(stateDir, auth('account-three', 'three@example.test', 'Three', 'pro'));
        const lock = authFile + '.cuimod-lock';
        fs.writeFileSync(lock, 'manual switch in progress');
        const pending = manager.autoSwitch(98);
        await until(() => usageCalls.length === 3);
        fs.writeFileSync(authFile, manual.raw);
        fs.writeFileSync(path.join(stateDir, 'openai-accounts.json'), JSON.stringify({ version: 1, active: manual.id }));
        fs.unlinkSync(lock);
        assert.deepEqual(await pending, { switched: false, reason: 'stale-active-account' });
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-three');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic switching revalidates settings inside the auth lock before writing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auto-switch-settings-'));
    const stateDir = path.join(root, '.state');
    const authFile = path.join(root, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, auth('account-one', 'one@example.test', 'One', 'plus'));
    let releaseTarget;
    let targetRequested = false;
    let settings = { enabled: true, threshold: 98 };
    const manager = createOpenAIAccounts({
        authFile, stateDir, spawnLogin() { throw new Error('unused'); },
        fetch: async (_url, options) => {
            if (options.headers['chatgpt-account-id'] === 'account-one') return usageResponse(99);
            targetRequested = true;
            return new Promise(resolve => { releaseTarget = () => resolve(usageResponse(10)); });
        },
    });
    try {
        manager.status();
        addProfile(stateDir, auth('account-two', 'two@example.test', 'Two', 'pro'));
        const disabled = manager.autoSwitch(98, () => settings);
        await until(() => targetRequested);
        settings = { enabled: false, threshold: 98 };
        releaseTarget();
        assert.deepEqual(await disabled, { switched: false, reason: 'settings-changed' });
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');

        settings = { enabled: true, threshold: 98 };
        const changedThreshold = manager.autoSwitch(98, () => settings);
        settings = { enabled: true, threshold: 97 };
        assert.deepEqual(await changedThreshold, { switched: false, reason: 'settings-changed' });
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.account_id, 'account-one');
    } finally {
        manager.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('automatic account switching stays main-owned with dashboard controls', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/main.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(__dirname, '../src/plugins/provider-picker/renderer.js'), 'utf8');
    assert.match(main, /Symbol\.for\('cuimod\.dashboard\.settings'\)/);
    assert.match(main, /live\['provider-picker'\]/);
    assert.match(main, /settingsFile/);
    assert.match(main, /if \(!settings\.enabled\) return;/);
    assert.match(main, /accounts\.autoSwitch\(settings\.threshold, autoSwitchSettings\)/);
    assert.match(main, /ctx\.every\(AUTO_SWITCH_INTERVAL_MS, runAutoSwitch\)/);
    assert.match(main, /Symbol\.for\('cuimod\.provider-picker\.auto-switch'\)/);
    assert.match(main, /state\.inflight \|\| Date\.now\(\) - state\.lastStartedAt < AUTO_SWITCH_INTERVAL_MS/);
    assert.match(renderer, /autoSwitchAccounts: true, autoSwitchWeeklyThreshold: 98/);
    assert.match(renderer, /key: 'autoSwitchAccounts', type: 'toggle'/);
    assert.match(renderer, /key: 'autoSwitchWeeklyThreshold', type: 'number',[\s\S]*min: 1, max: 100/);
    assert.match(renderer, /automatic switching, apply to the next GPT request\. Current turns are unchanged/);
});

test('disabled automatic switching makes no paid usage call and clamps its threshold in main', async () => {
    const mainPath = require.resolve('../src/plugins/provider-picker/main');
    const accountsPath = require.resolve('../src/plugins/provider-picker/accounts');
    const heldMain = require.cache[mainPath];
    const originalAccounts = require.cache[accountsPath].exports;
    const settingsKey = Symbol.for('cuimod.dashboard.settings');
    const autoSwitchKey = Symbol.for('cuimod.provider-picker.auto-switch');
    const heldSettings = globalThis[settingsKey];
    const heldAutoSwitch = globalThis[autoSwitchKey];
    const calls = [], timers = [], disposers = [], methods = {};
    require.cache[accountsPath].exports = () => ({
        status: () => ({ active: null, accounts: [] }), usage: async () => ({ active: null, accounts: [] }),
        autoSwitch: async threshold => { calls.push(threshold); return { switched: false, reason: 'below-threshold' }; },
        switchAccount: async () => ({}), startLogin: () => ({}), cancelLogin() {}, dispose() {},
    });
    globalThis[settingsKey] = { store: { 'provider-picker': { autoSwitchAccounts: false, autoSwitchWeeklyThreshold: 98 } } };
    delete globalThis[autoSwitchKey];
    delete require.cache[mainPath];
    try {
        const factory = require(mainPath);
        factory({
            dir: path.join(__dirname, '../src/plugins/provider-picker'),
            electron: {
                app: { whenReady: () => Promise.resolve() },
                webContents: { getAllWebContents: () => [] },
            },
            every: (ms, fn) => timers.push({ ms, fn }), method: (name, fn) => { methods[name] = fn; },
            onDispose: fn => disposers.push(fn), log() {},
        });
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(calls, [], 'disabled setting must not fetch paid account usage');
        assert.equal(timers.length, 2, 'auto-switch and menu attachment each use a managed interval');

        globalThis[settingsKey].store['provider-picker'] = { autoSwitchAccounts: true, autoSwitchWeeklyThreshold: 101 };
        timers.find(timer => timer.ms === 5 * 60 * 1000)?.fn();
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(calls, [100]);
    } finally {
        disposers.forEach(fn => fn());
        require.cache[accountsPath].exports = originalAccounts;
        if (heldMain) require.cache[mainPath] = heldMain;
        else delete require.cache[mainPath];
        if (heldSettings === undefined) delete globalThis[settingsKey];
        else globalThis[settingsKey] = heldSettings;
        if (heldAutoSwitch === undefined) delete globalThis[autoSwitchKey];
        else globalThis[autoSwitchKey] = heldAutoSwitch;
    }
});

test('hot provider-picker generations finish one candidate pass before disposing its manager', async () => {
    const mainPath = require.resolve('../src/plugins/provider-picker/main');
    const accountsPath = require.resolve('../src/plugins/provider-picker/accounts');
    const heldMain = require.cache[mainPath];
    const originalAccounts = require.cache[accountsPath].exports;
    const settingsKey = Symbol.for('cuimod.dashboard.settings');
    const autoSwitchKey = Symbol.for('cuimod.provider-picker.auto-switch');
    const heldSettings = globalThis[settingsKey];
    const heldAutoSwitch = globalThis[autoSwitchKey];
    const calls = [], logs = [];
    let cancelled = 0;
    let disposedManagers = 0;
    let completedPasses = 0;
    let releaseCandidate;
    require.cache[accountsPath].exports = () => {
        let managerDisposed = false;
        return {
            status: () => ({ active: null, accounts: [] }), usage: async () => ({ active: null, accounts: [] }),
            autoSwitch: async threshold => {
                calls.push(threshold);
                await new Promise(resolve => { releaseCandidate = resolve; });
                if (managerDisposed) throw new Error('manager disposed during candidate usage');
                completedPasses++;
                return { switched: true, from: 'first', to: 'second' };
            },
            switchAccount: async () => ({}), startLogin: () => ({}),
            cancelLogin() { cancelled++; },
            dispose() { managerDisposed = true; disposedManagers++; },
        };
    };
    globalThis[settingsKey] = { store: { 'provider-picker': { autoSwitchAccounts: true, autoSwitchWeeklyThreshold: 98 } } };
    delete globalThis[autoSwitchKey];
    delete require.cache[mainPath];
    const make = () => {
        const disposers = [];
        require(mainPath)({
            dir: path.join(__dirname, '../src/plugins/provider-picker'),
            electron: {
                app: { whenReady: () => Promise.resolve() },
                webContents: { getAllWebContents: () => [] },
            },
            every() {}, method() {}, onDispose: fn => disposers.push(fn), log: message => logs.push(message),
        });
        return () => disposers.forEach(fn => fn());
    };
    let disposeOld;
    let disposeNew;
    try {
        disposeOld = make();
        await until(() => calls.length === 1 && releaseCandidate);
        disposeNew = make();
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(calls, [98], 'successor must share the predecessor paid pass');

        disposeOld();
        disposeOld = null;
        assert.equal(cancelled, 1, 'login cancellation remains immediate during replacement');
        assert.equal(disposedManagers, 0, 'the active candidate pass keeps its manager alive');
        releaseCandidate();
        await until(() => disposedManagers === 1);
        assert.equal(completedPasses, 1, 'the candidate pass must complete after its generation is disposed');
        assert.deepEqual(logs, [], 'a disposed generation must not report a switch it completed');
        assert.deepEqual(calls, [98], 'reload must not start duplicate paid usage');
    } finally {
        disposeOld?.();
        disposeNew?.();
        require.cache[accountsPath].exports = originalAccounts;
        if (heldMain) require.cache[mainPath] = heldMain;
        else delete require.cache[mainPath];
        if (heldSettings === undefined) delete globalThis[settingsKey];
        else globalThis[settingsKey] = heldSettings;
        if (heldAutoSwitch === undefined) delete globalThis[autoSwitchKey];
        else globalThis[autoSwitchKey] = heldAutoSwitch;
    }
});
