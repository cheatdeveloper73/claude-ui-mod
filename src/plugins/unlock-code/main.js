/* claude-ui-mod :: unlock-code (main)
 *
 * Injects page.js into webContents and lets catalogued local-router models
 * start Code sessions with a local-only credential.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require('async_hooks');
const { providerRegistrations, registrationModelsFile } = require('../provider-routing/registrations');

const ROUTED_AUTH = Symbol.for('cuimod.unlock-code.routed-auth');
const ORIGINAL = Symbol.for('cuimod.unlock-code.routed-auth.original');
const GENERATION = Symbol.for('cuimod.unlock-code.routed-auth.generation');
const LOCAL_TOKEN = 'cuimod-local-router';
const DEPLOYMENT_MODE_MARKER = 'getDeploymentMode() called before initDeploymentMode()';

function routedModel(modDir, model) {
    if (typeof model !== 'string' || !model) return false;
    const selected = model.toLowerCase().replace(/:(?:none|minimal|low|medium|high|xhigh|max|ultra|pro)$/, '')
        .replace(/\[1m\]$/, '');
    const picker = path.join(modDir, 'src', 'plugins', 'provider-picker');
    const sources = [path.join(picker, 'catalogue.json'), path.join(picker, 'catalogue.private.json'),
        ...providerRegistrations().map(registration => registrationModelsFile(registration, modDir))];
    for (const file of sources) {
        let rows;
        try {
            const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
            rows = Array.isArray(value) ? value : value?.models;
        } catch (_) { continue; }
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
            if (!row?.id || !row.provider || row.provider === 'claude') continue;
            const id = String(row.id).toLowerCase();
            if (selected === id || selected === `claude-${id}`) return true;
        }
    }
    return false;
}

module.exports = function (ctx) {
    const modDir = ctx.boot.MOD_DIR;
    const state = globalThis[ROUTED_AUTH] || { als: new AsyncLocalStorage(), records: [], owner: null };
    globalThis[ROUTED_AUTH] = state;
    const owner = {};
    state.owner = owner;
    // The dashboard store is authoritative once loaded; the file lags it until
    // the next save.
    function switchedOff() {
        const live = globalThis[Symbol.for('cuimod.dashboard.settings')]?.store;
        if (live && typeof live === 'object' && !Array.isArray(live)) return live['unlock-code']?.enabled === false;
        try {
            const settings = JSON.parse(fs.readFileSync(path.join(modDir, '.state', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
            return settings?.['unlock-code']?.enabled === false;
        } catch (_) { return false; }
    }
    state.isRouted = model => {
        if (switchedOff()) return false;
        return routedModel(modDir, model);
    };

    function replace(target, key, factory) {
        const current = target?.[key];
        if (typeof current !== 'function' || current[GENERATION] === owner) return false;
        const original = current[ORIGINAL] || current;
        const wrapped = factory(original);
        Object.defineProperty(wrapped, ORIGINAL, { value: original });
        Object.defineProperty(wrapped, GENERATION, { value: owner });
        target[key] = wrapped;
        const record = state.records.find(record => record.target === target && record.key === key);
        if (record) record.wrapped = wrapped;
        else state.records.push({ target, key, original, wrapped });
        return true;
    }

    // getDeploymentMode's export name is minified per build: `cM` in 1.46388.4,
    // `PW` in 2.7032.0, where `cM` became an unrelated path helper. Its
    // uninitialised-guard message is the stable identity.
    let deploymentMode = null;
    const scannedExports = new WeakSet();
    function findDeploymentMode(exports) {
        if (!exports || typeof exports !== 'object' || scannedExports.has(exports)) return null;
        scannedExports.add(exports);
        for (const key of Object.keys(exports)) {
            let fn;
            try { fn = exports[key]; } catch (_) { continue; }
            if (typeof fn === 'function' && fn.length === 0 && String(fn).includes(DEPLOYMENT_MODE_MARKER)) return fn;
        }
        return null;
    }

    function patchAuth() {
        let manager = null;
        let mode = null;
        for (const entry of Object.values(require.cache)) {
            const exports = entry?.exports;
            const candidate = exports?.claudeCodeSessionManager;
            if (!manager && candidate?.sessions instanceof Map && typeof candidate.startSession === 'function')
                manager = candidate;
            if (!deploymentMode) deploymentMode = findDeploymentMode(exports);
        }
        if (deploymentMode) {
            try {
                const value = deploymentMode();
                if (value?.type === '1p' && typeof value?.deps?.getOauthToken === 'function') mode = value;
            } catch (_) {}
        }
        if (manager) {
            replace(manager, 'startSession', original => function (options, ...rest) {
                return state.als.run({ model: options?.model }, () => Reflect.apply(original, this, [options, ...rest]));
            });
            replace(manager, 'sendMessage', original => function (sessionId, ...rest) {
                const model = this.sessions?.get(sessionId)?.model;
                return state.als.run({ model }, () => Reflect.apply(original, this, [sessionId, ...rest]));
            });
            replace(manager, 'getBaseQueryConfig', original => function (...args) {
                // A routed result must not enter Desktop's shared OAuth config
                // memo, where a later native Claude session could reuse it.
                if (state.isRouted(state.als.getStore()?.model) && typeof this._fetchBaseQueryConfig === 'function')
                    return Reflect.apply(this._fetchBaseQueryConfig, this, args);
                return Reflect.apply(original, this, args);
            });
        }
        if (mode) {
            // The Code credential path dispatches through getApiToken only for
            // provider-managed routing. Limit that branch to this async start.
            replace(mode, 'managesProviderRouting', original => function (...args) {
                if (state.isRouted(state.als.getStore()?.model)) return true;
                return Reflect.apply(original, this, args);
            });
            replace(mode.deps, 'getOauthToken', original => function (config, ...rest) {
                if (state.isRouted(state.als.getStore()?.model)
                    && String(config?.scope || '').includes('user:sessions:claude_code')) {
                    return Promise.resolve({ ok: true, token: LOCAL_TOKEN,
                        subscriptionType: null, rateLimitTier: null });
                }
                return Reflect.apply(original, this, [config, ...rest]);
            });
        }
    }
    patchAuth();
    ctx.every(1000, patchAuth);

    const pageFile = path.join(ctx.dir, "page.js");
    let pageSource = "";
    try { pageSource = fs.readFileSync(pageFile, "utf8"); } catch (_) {}

    async function inject(wc) {
        if (!wc || wc.isDestroyed()) return;
        try {
            const url = wc.getURL();
            if (!url || !url.includes("claude.ai")) return;
            await wc.executeJavaScript(pageSource, false);
        } catch (_) {}
    }

    // The switch has to stop the account rewrite itself, not only the routed
    // credential and the stylesheet: retire the page script once when it goes
    // off, and stop re-injecting it. The page's cached record returns to the
    // server's on its next refetch.
    const RETIRE = "try { window.__cuimod_unlock_code_native?.dispose(); } catch (_) {}";
    let off = false;
    function sweep() {
        const nowOff = switchedOff();
        if (nowOff && !off) {
            for (const wc of ctx.electron.webContents.getAllWebContents()) {
                if (wc.isDestroyed()) continue;
                try { wc.executeJavaScript(RETIRE, false).catch(() => {}); } catch (_) {}
            }
        }
        off = nowOff;
        if (off) return;
        for (const wc of ctx.electron.webContents.getAllWebContents()) {
            inject(wc);
        }
    }

    sweep();
    ctx.every(3000, sweep);

    ctx.method("patch", async (_p, event) => {
        if (switchedOff()) return { ok: false, disabled: true };
        if (event && event.sender && !event.sender.isDestroyed()) {
            return await event.sender.executeJavaScript(pageSource, false);
        }
        sweep();
        return { ok: true };
    });

    ctx.onDispose(() => {
        if (state.owner === owner) {
            for (const record of state.records.reverse()) {
                if (record.target[record.key] === record.wrapped) record.target[record.key] = record.original;
            }
            state.records.length = 0;
            delete globalThis[ROUTED_AUTH];
        }
        for (const wc of ctx.electron.webContents.getAllWebContents()) {
            if (!wc.isDestroyed()) {
                try {
                    wc.executeJavaScript("try { window.__cuimod_unlock_code_native?.dispose(); } catch (_) {}", false);
                } catch (_) {}
            }
        }
    });
};

module.exports.routedModel = routedModel;
