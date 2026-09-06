'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

module.exports = function (ctx) {
    // catalogue.json is the shipped list. catalogue.private.json, if present,
    // adds models this deployment can route but the published tree does not
    // carry -- an adapter's models, typically. Absent is the normal case, and
    // the picker must never offer a model no arm will claim: a model in this
    // menu that nothing routes falls through to Anthropic and errors under its
    // own label.
    const read = (name) => JSON.parse(fs.readFileSync(path.join(ctx.dir, name), 'utf8').replace(/^﻿/, ''));
    const defaults = read('catalogue.json');
    try { defaults.push(...read('catalogue.private.json')); }
    catch (_) {}
    let cache = [];
    try { cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')).models || []; } catch (_) {}
    const tiers = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const wireId = (id) => String(id || '').toLowerCase().startsWith('claude-') ? id : `claude-${id}`;
    const models = defaults.map(({ backend, ...m }) => {
        const cached = cache.find(c => c.slug === m.id);
        const efforts = cached?.supported_reasoning_levels?.map(e => e.effort).filter(e => tiers.has(e));
        const contextTag = Number.isFinite(m.context) && m.context >= 1000000 ? '[1m]' : '';
        return { ...m, efforts: efforts?.length ? efforts : m.efforts, wireId: `${wireId(m.id)}${contextTag}` };
    });
    // A provider's display label travels with its catalogue entries, so a
    // backend this tree does not ship can still name itself in the menu
    // without editing this file. The map covers the shipped ones.
    const labels = { openai: 'OpenAI', meta: 'Meta', nanogpt: 'NanoGPT' };
    const providers = [{ id: 'claude', label: 'Claude' }];
    for (const model of models) if (!providers.some(provider => provider.id === model.provider))
        providers.push({ id: model.provider, label: model.providerLabel || labels[model.provider] || model.provider });
    const pageSource = fs.readFileSync(path.join(ctx.dir, 'page.js'), 'utf8');
    const version = crypto.createHash('sha256').update(pageSource + JSON.stringify({ models, providers })).digest('hex');
    const script = '(function(models,providers,version){' + pageSource + '\n})(' + JSON.stringify(models) + ',' + JSON.stringify(providers) + ',' + JSON.stringify(version) + ')';

    // The strip has to classify a menu row before it can ask the page world
    // anything, so every sync carries the wire id -> provider pairs and nothing
    // else about the model.
    const owners = models.map(m => ({ id: m.wireId, provider: m.provider }));

    ctx.method('catalogue', () => ({ models, providers }));
    ctx.method('nativeSync', async (_p, event) => {
        if (!event?.sender || event.sender.isDestroyed()) return { installed: false, providers, models: owners };
        const result = await event.sender.executeJavaScript(script, false);
        return { ...result, providers, models: owners };
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
            const wrapper = (event, list) => original(event, [...new Set([...(Array.isArray(list) ? list : []), ...models.map(m => m.wireId)])]);
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
                wc.executeJavaScript('if(window.__cuimod_provider_native?.version === ' + JSON.stringify(version) + ') window.__cuimod_provider_native.dispose();', false).catch(() => {});
            }
        });
    });
    ctx.method('status', () => ({ architecture: 'native-catalog', windows: wrapped.size, providers, models: models.map(m => m.wireId) }));
};
