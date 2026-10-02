import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const jwt = exp => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
const auth = (account, refresh, exp) => JSON.stringify({
    tokens: { access_token: jwt(exp), refresh_token: refresh, account_id: account },
});

async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('condition did not settle');
}

test('an account switch that owns the auth lock wins before token refresh starts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auth-lock-'));
    const authFile = path.join(root, 'auth.json');
    const lockFile = authFile + '.cuimod-lock';
    fs.writeFileSync(authFile, auth('old-account', 'old-refresh', Math.floor(Date.now() / 1000) - 60));
    fs.writeFileSync(lockFile, 'switching');
    const priorFile = process.env.CODEX_AUTH_FILE;
    const priorFetch = globalThis.fetch;
    process.env.CODEX_AUTH_FILE = authFile;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('refresh should not start'); };
    try {
        const module = await import(`../router/openai.mjs?auth-lock=${Date.now()}`);
        const pending = module.chatgptAuth();
        await new Promise(resolve => setTimeout(resolve, 40));
        fs.writeFileSync(authFile, auth('new-account', 'new-refresh', Math.floor(Date.now() / 1000) + 3600));
        fs.unlinkSync(lockFile);
        const tokens = await pending;
        assert.equal(tokens.account_id, 'new-account');
        assert.equal(tokens.refresh_token, 'new-refresh');
        assert.equal(fetches, 0);
        assert.equal(fs.existsSync(lockFile), false);
    } finally {
        globalThis.fetch = priorFetch;
        if (priorFile === undefined) delete process.env.CODEX_AUTH_FILE;
        else process.env.CODEX_AUTH_FILE = priorFile;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('token refresh holds the auth lock through its rotating-token write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-auth-refresh-'));
    const authFile = path.join(root, 'auth.json');
    const lockFile = authFile + '.cuimod-lock';
    fs.writeFileSync(authFile, auth('account', 'old-refresh', Math.floor(Date.now() / 1000) - 60));
    const priorFile = process.env.CODEX_AUTH_FILE;
    const priorFetch = globalThis.fetch;
    process.env.CODEX_AUTH_FILE = authFile;
    let release;
    globalThis.fetch = () => new Promise(resolve => { release = () => resolve({
        ok: true,
        text: async () => JSON.stringify({
            access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: 'new-refresh',
        }),
    }); });
    try {
        const module = await import(`../router/openai.mjs?auth-refresh=${Date.now()}`);
        const pending = module.chatgptAuth();
        await until(() => typeof release === 'function');
        assert.equal(fs.existsSync(lockFile), true);
        release();
        const tokens = await pending;
        assert.equal(tokens.refresh_token, 'new-refresh');
        assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).tokens.refresh_token, 'new-refresh');
        assert.equal(fs.existsSync(lockFile), false);
    } finally {
        globalThis.fetch = priorFetch;
        if (priorFile === undefined) delete process.env.CODEX_AUTH_FILE;
        else process.env.CODEX_AUTH_FILE = priorFile;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
