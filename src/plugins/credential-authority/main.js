'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

module.exports = function (ctx) {
    const modRoot = ctx.boot?.MOD_DIR || path.resolve(ctx.dir || __dirname, '../../..');
    const stateDir = path.join(modRoot, '.state');
    const configFile = path.join(stateDir, 'credential-authority.json');
    const viewFile = path.join(stateDir, 'credential-claude-view.json');
    let inFlight = false;
    let disposed = false;
    let status = { ready: false };
    const read = file => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
        catch (_) { return null; }
    };
    function write(file, value, credential = false) {
        const raw = JSON.stringify(value, null, 2);
        let previous;
        try { previous = fs.readFileSync(file, 'utf8'); } catch (_) {}
        if (previous === raw) return;
        fs.mkdirSync(stateDir, { recursive: true });
        if (credential && previous !== undefined)
            fs.copyFileSync(file, `${file}.backup-${crypto.randomUUID()}`, fs.constants.COPYFILE_EXCL);
        const tmp = `${file}.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmp, raw, { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, file);
    }
    async function publish() {
        const config = read(configFile);
        if (disposed || inFlight || config?.version !== 1 || config.authorityHost?.toLowerCase() !== os.hostname().toLowerCase()) return;
        inFlight = true;
        try {
            const entries = Object.values(require.cache || {});
            const manager = entries.map(entry => entry?.exports?.claudeCodeSessionManager)
                .find(value => typeof value?.cliOAuthTokenKeeper?.getCcdOauthTokenWithMargin === 'function'
                    && typeof value.managerOAuthAccount === 'function');
            // Read the native consumer's own expiry/config call. Export aliases
            // change per Desktop build; its opaque token must not get a made-up TTL.
            const expiryCall = manager?.cliOAuthTokenKeeper?.trackCliOAuthToken
                && String(manager.cliOAuthTokenKeeper.trackCliOAuthToken).match(/[\w$]+\.([\w$]+)\([\w$]+\.([\w$]+)\(\),[\w$]+\.spawnToken\)/);
            const expiryKey = expiryCall?.[1];
            const configKey = expiryCall?.[2];
            const core = expiryCall && entries.map(entry => entry?.exports).find(value =>
                typeof value?.[expiryKey] === 'function' && typeof value[configKey] === 'function'
                && String(value[expiryKey]).includes('expiresAt') && String(value[configKey]).includes('user:sessions:claude_code'));
            if (!manager || !core) throw new Error('native OAuth keeper unavailable');
            const account = manager.managerOAuthAccount();
            const got = await manager.cliOAuthTokenKeeper.getCcdOauthTokenWithMargin(account);
            if (!got?.ok || typeof got.token !== 'string') throw new Error('native OAuth credential unavailable');
            const expiresAt = core[expiryKey](core[configKey](), got.token);
            if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('native OAuth expiry unavailable');
            if (disposed) return;
            write(viewFile, { version: 1, authorityHost: config.authorityHost,
                claude: { accessToken: got.token, expiresAt, scopes: String(got.grantedScope || core[configKey]().scope).split(' ').filter(Boolean),
                    subscriptionType: got.subscriptionType, rateLimitTier: got.rateLimitTier } }, true);
            status = { ready: true, authorityHost: os.hostname(), expiryLookup: 'native-consumer', expiresAt, utc: new Date().toISOString() };
            write(path.join(stateDir, 'credential-claude-status.json'), status);
        } catch (_) {
            // Never return a native exception or token-bearing object over RPC.
            status = { ready: false, reason: 'Native credential publication is unavailable.', utc: new Date().toISOString() };
            if (!disposed) write(path.join(stateDir, 'credential-claude-status.json'), status);
        } finally { inFlight = false; }
    }
    ctx.method('status', () => status);
    ctx.every(10000, publish);
    ctx.onDispose(() => { disposed = true; });
    publish();
};
