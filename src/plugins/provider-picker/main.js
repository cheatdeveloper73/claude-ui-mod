'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');
const http = require('http');
const createOpenAIAccounts = require('./accounts');
const { createContextPolicy, isRegisteredModel, codexFastSlugs } = require('../provider-routing/main');
const { providerRegistrations } = require('../provider-routing/registrations');

const DASHBOARD_SETTINGS = Symbol.for('cuimod.dashboard.settings');
const AUTO_SWITCH_STATE = Symbol.for('cuimod.provider-picker.auto-switch');
const AUTO_SWITCH_INTERVAL_MS = 5 * 60 * 1000;
const ROUTER = process.env.CUIMOD_ROUTER_URL || 'http://127.0.0.1:8789';

function routerJson(method, route, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body === null ? null : Buffer.from(JSON.stringify(body));
        const url = new URL(route, ROUTER);
        const req = http.request(url, {
            method,
            timeout: 5000,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : undefined,
        }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 1024 * 1024) { req.destroy(new Error('router response too large')); return; }
                chunks.push(chunk);
            });
            res.on('end', () => {
                let value = null;
                try { value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
                catch (error) { reject(error); return; }
                resolve({ status: res.statusCode || 0, value });
            });
        });
        req.on('timeout', () => req.destroy(new Error('router timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function poolPinStatus() {
    const result = await routerJson('GET', '/poolpinz');
    if (result.status === 501) return { supported: false };
    if (result.status !== 200) throw new Error('Account pool status is unavailable (router ' + result.status + ')');
    return { supported: true, ...result.value };
}

async function setPoolPin(input) {
    const action = input?.action;
    if (!['auto', 'pin'].includes(action)) throw new Error('Invalid account pool action');
    const body = action === 'pin'
        ? { action, id: Number(input?.id) }
        : { action };
    if (action === 'pin' && (!Number.isSafeInteger(body.id) || body.id <= 0)) throw new Error('Invalid account id');
    const result = await routerJson('POST', '/poolpinz', body);
    if (result.status === 501) return { supported: false };
    if (result.status !== 200) throw new Error(result.value?.error?.message || 'Account pool change failed (router ' + result.status + ')');
    return { supported: true, ...result.value };
}

function autoSwitchState() {
    const existing = globalThis[AUTO_SWITCH_STATE];
    if (existing && typeof existing === 'object') return existing;
    const state = { inflight: null, lastStartedAt: 0 };
    globalThis[AUTO_SWITCH_STATE] = state;
    return state;
}

module.exports = function (ctx) {
    // catalogue.json is the shipped list. catalogue.private.json, if present,
    // adds models this deployment can route but the published tree does not
    // carry -- an adapter's models, typically. Absent is the normal case, and
    // the picker must never offer a model no arm will claim: a model in this
    // menu that nothing routes falls through to Anthropic and errors under its
    // own label.
    const read = (name) => JSON.parse(fs.readFileSync(path.join(ctx.dir, name), 'utf8').replace(/^﻿/, ''));
    const shipped = read('catalogue.json');
    try { shipped.push(...read('catalogue.private.json')); }
    catch (_) {}
    let cache = [];
    try { cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')).models || []; } catch (_) {}
    const tiers = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro']);
    const wireId = (id) => String(id || '').toLowerCase().startsWith('claude-') ? id : `claude-${id}`;
    // A declared provider's models travel under their own ids.
    const modelWireId = (model) => model?.registered ? String(model.id) : wireId(model.id);
    // A provider's display label travels with its catalogue entries, so a
    // backend this tree does not ship can still name itself in the menu
    // without editing this file. The map covers the shipped ones.
    const labels = { openai: 'OpenAI', meta: 'Meta', nanogpt: 'NanoGPT' };
    const pageSource = fs.readFileSync(path.join(ctx.dir, 'page.js'), 'utf8');
    const contextPolicy = createContextPolicy(ctx.boot?.MOD_DIR || path.resolve(ctx.dir, '../../..'));
    function buildCatalogue() {
        const source = [...shipped, ...contextPolicy.models()];
        // Only the router's own OpenAI arm turns speed:"fast" into Codex's
        // priority tier, so only its slugs get the switch.
        const fast = new Set(codexFastSlugs());
        const seen = new Set();
        const models = source.flatMap(({ backend, ...m }) => {
            if (!m?.id || seen.has(m.id)) return [];
            seen.add(m.id);
            const cached = m.registered ? null : cache.find(c => c.slug === m.id);
            const efforts = cached?.supported_reasoning_levels?.map(e => e.effort).filter(e => tiers.has(e));
            const contextTag = m.use1mContextTag === true || (Number.isFinite(m.context) && m.context >= 1000000) ? '[1m]' : '';
            return [{ ...m, efforts: efforts?.length ? efforts : (Array.isArray(m.efforts) ? m.efforts : []), wireId: `${modelWireId(m)}${contextTag}`,
                ...(m.provider === 'openai' && fast.has(String(m.id).toLowerCase()) ? { fastMode: true } : {}) }];
        });
        const providers = [{ id: 'claude', label: 'Claude' }];
        for (const model of models) if (!providers.some(provider => provider.id === model.provider))
            providers.push({ id: model.provider, label: model.providerLabel || labels[model.provider] || model.provider });
        // The page classifies an id that discovery has not listed yet by the
        // declaring provider's own pattern.
        const registered = providerRegistrations().map(r => ({ provider: r.provider, pattern: r.pattern.source }));
        const version = crypto.createHash('sha256').update(pageSource + JSON.stringify({ models, providers, registered })).digest('hex');
        const script = '(function(models,providers,version,registered){' + pageSource + '\n})(' + JSON.stringify(models) + ',' + JSON.stringify(providers) + ',' + JSON.stringify(version) + ',' + JSON.stringify(registered) + ')';
        return { models, providers, version, script };
    }
    let catalogue = buildCatalogue();
    function refreshCatalogue() {
        const next = buildCatalogue();
        if (next.version !== catalogue.version) catalogue = next;
        return catalogue;
    }

    const authFile = process.env.CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');
    const stateDir = path.join(ctx.boot?.MOD_DIR || path.resolve(ctx.dir, '../../..'), '.state');
    function spawnLogin(home) {
        const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
        const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
        const binary = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe');
        if (!fs.existsSync(binary)) throw new Error('Codex CLI is not installed');
        return childProcess.spawn(binary, ['login'], {
            env: { ...process.env, CODEX_HOME: home },
            stdio: 'ignore',
            windowsHide: true,
        });
    }
    const accounts = createOpenAIAccounts({ authFile, stateDir, spawnLogin, log: ctx.log });
    const settingsFile = path.join(stateDir, 'settings.json');
    let autoSwitchStarted = false;
    let autoSwitchRun = null;
    let disposed = false;

    function autoSwitchSettings() {
        let saved = null;
        const live = globalThis[DASHBOARD_SETTINGS]?.store;
        if (live && typeof live === 'object' && !Array.isArray(live)) saved = live['provider-picker'];
        else {
            try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, ''))['provider-picker']; }
            catch (_) {}
        }
        const value = Number(saved?.autoSwitchWeeklyThreshold);
        return {
            enabled: saved?.autoSwitchAccounts !== false,
            threshold: Number.isFinite(value) ? Math.max(1, Math.min(100, Math.round(value))) : 98,
        };
    }

    async function runAutoSwitch() {
        if (disposed) return;
        const settings = autoSwitchSettings();
        if (!settings.enabled) return;

        const state = autoSwitchState();
        if (state.inflight || Date.now() - state.lastStartedAt < AUTO_SWITCH_INTERVAL_MS) return;
        state.lastStartedAt = Date.now();
        const running = (async () => {
            try {
                const result = await accounts.autoSwitch(settings.threshold, autoSwitchSettings);
                if (!disposed && result.switched) ctx.log('OpenAI account auto-switch: ' + result.from + ' -> ' + result.to);
            } catch (_) {
                // Usage failures intentionally leave the selected account unchanged.
            }
        })();
        state.inflight = running;
        autoSwitchRun = running;
        try { await running; }
        finally {
            if (autoSwitchRun === running) autoSwitchRun = null;
            if (state.inflight === running) state.inflight = null;
        }
    }

    function startAutoSwitch() {
        if (autoSwitchStarted || disposed) return;
        autoSwitchStarted = true;
        runAutoSwitch();
        ctx.every(AUTO_SWITCH_INTERVAL_MS, runAutoSwitch);
    }

    if (ctx.electron.app?.whenReady) ctx.electron.app.whenReady().then(startAutoSwitch).catch(() => {});
    ctx.onDispose(() => {
        disposed = true;
        accounts.cancelLogin();
        const running = autoSwitchRun;
        const disposeAccounts = () => {
            try { accounts.dispose(); } catch (_) {}
        };
        if (!running) {
            disposeAccounts();
            return;
        }
        autoSwitchRun = null;
        // The successor shares this paid pass. Keep its manager live until the
        // lock-protected switch has finished, but never let it log afterward.
        running.then(disposeAccounts, disposeAccounts);
    });

    // The strip has to classify a menu row before it can ask the page world
    // anything. Current generic Menu rows no longer expose data-model-id, so the
    // sync carries the display name as the fallback identity alongside provider.
    ctx.method('catalogue', () => { const value = refreshCatalogue(); return { models: value.models, providers: value.providers }; });
    ctx.method('accountStatus', () => accounts.status());
    ctx.method('accountUsage', p => accounts.usage(p?.force === true));
    ctx.method('accountSwitch', p => accounts.switchAccount(p?.id));
    ctx.method('accountRemove', p => accounts.removeAccount(p?.id));
    ctx.method('accountLogin', () => accounts.startLogin());
    ctx.method('poolPinStatus', () => poolPinStatus());
    ctx.method('poolPinSet', p => setPoolPin(p));
    ctx.method('nativeSync', async (_p, event) => {
        const current = refreshCatalogue();
        const owners = current.models.map(m => ({ id: m.wireId, name: m.name, provider: m.provider }));
        const accountStatus = accounts.status();
        if (!event?.sender || event.sender.isDestroyed()) return { installed: false, providers: current.providers, models: owners, accounts: accountStatus };
        const result = await event.sender.executeJavaScript(current.script, false);
        return { ...result, providers: current.providers, models: owners, accounts: accountStatus };
    });
    ctx.method('tab', async (p, event) => {
        if (!event?.sender || event.sender.isDestroyed()) return null;
        return event.sender.executeJavaScript('window.__cuimod_provider_native?.selectTab(' + JSON.stringify(p?.provider || null) + ',' + JSON.stringify(p?.triggerId || '') + ',' + JSON.stringify(p?.open !== false) + ')', false);
    });

    // EIPC is registered on WebContents.ipc. The global ipcMain registry is
    // intentionally almost empty. Extend each genuine catalog push in place;
    // never compete with it by repeatedly replacing the app's model list.
    const wrapped = new Map();
    const suffix = '_$_claude.web_$_LocalSessions_$_setAvailableCodeModels';
    function attach() {
        for (const wc of ctx.electron.webContents.getAllWebContents()) {
            const registry = wc.ipc?._invokeHandlers;
            if (!registry) continue;
            const key = [...registry.keys()].find(k => k.endsWith(suffix));
            if (!key) continue;
            const current = registry.get(key);
            if (wrapped.get(wc)?.wrapper === current) continue;
            // A new host is built before the previous one is disposed. Unwrap
            // our predecessor so hot reload cannot stack wrappers forever.
            const original = current.__cuimodProviderOriginal || current;
            const wrapper = (event, list) => {
                const currentModels = refreshCatalogue().models;
                const native = (Array.isArray(list) ? list : []).filter(id => !isRegisteredModel(id));
                return original(event, [...new Set([...native, ...currentModels.map(m => m.wireId)])]);
            };
            wrapper.__cuimodProviderOriginal = original;
            registry.set(key, wrapper);
            wrapped.set(wc, { registry, key, original, wrapper });
        }
        for (const [wc] of wrapped) if (wc.isDestroyed()) wrapped.delete(wc);
    }
    attach();
    ctx.every(1000, attach);
    ctx.onDispose(() => {
        for (const { registry, key, original, wrapper } of wrapped.values()) if (registry.get(key) === wrapper) registry.set(key, original);
        wrapped.clear();
        queueMicrotask(async () => {
            // Hot replacement retains one page controller. Unloading the host
            // or removing this plugin must release its query subscriptions.
            if (ctx.boot?.host) {
                try { await ctx.boot.host.dispatch('provider-picker.status'); return; } catch (_) {}
            }
            for (const wc of ctx.electron.webContents.getAllWebContents()) {
                if (wc.isDestroyed()) continue;
                wc.executeJavaScript('if(window.__cuimod_provider_native?.version === ' + JSON.stringify(catalogue.version) + ') window.__cuimod_provider_native.dispose();', false).catch(() => {});
            }
        });
    });
    ctx.method('status', () => { const value = refreshCatalogue(); return { architecture: 'native-catalog', windows: wrapped.size, providers: value.providers, models: value.models.map(m => m.wireId) }; });
};
