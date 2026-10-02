'use strict';
// A plugin that brings its own provider declares it in a provider.json beside
// its main.js. The routing, picker, compaction and model-lock plugins read
// those declarations instead of knowing a backend by name, so a tree that does
// not ship the plugin has no declaration and none of their special cases fire.
//
//   { "version": 1, "provider": "<id>", "label": "<menu label>",
//     "idPattern": "<regex over the bare, lower-case model id>",
//     "modelsFile": "<discovery output, relative to the mod directory>",
//     "modelsFileEnv": "<optional variable that overrides modelsFile>" }
//
// A registered provider's models are discovered at run time rather than
// catalogued, travel under their own id instead of a claude- alias, carry a
// measured context ceiling that caps the session window, and serve one request
// per session at a time. That last property is why a session on one keeps its
// helper model elsewhere: the CLI's own classifier calls would otherwise queue
// behind the turn that made them.
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.resolve(__dirname, '..');
const TTL_MS = 1000;
let cached = { at: 0, key: '', value: [] };

function readDeclarations(pluginsDir, out, seen) {
    let names = [];
    try { names = fs.readdirSync(pluginsDir).sort(); } catch (_) { return; }
    for (const name of names) {
        let value;
        try { value = JSON.parse(fs.readFileSync(path.join(pluginsDir, name, 'provider.json'), 'utf8').replace(/^﻿/, '')); }
        catch (_) { continue; }
        if (value?.version !== 1 || typeof value.provider !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.provider)
            || seen.has(value.provider) || typeof value.idPattern !== 'string' || typeof value.modelsFile !== 'string') continue;
        let pattern;
        try { pattern = new RegExp(value.idPattern); } catch (_) { continue; }
        seen.add(value.provider);
        out.push({
            provider: value.provider,
            label: typeof value.label === 'string' && value.label ? value.label : value.provider,
            pattern,
            modelsFile: value.modelsFile,
            modelsFileEnv: typeof value.modelsFileEnv === 'string' ? value.modelsFileEnv : null,
        });
    }
}

// CUIMOD_PROVIDER_REGISTRATIONS names one more directory laid out like
// src/plugins, so tests can declare a provider without shipping a plugin.
function providerRegistrations() {
    const extra = process.env.CUIMOD_PROVIDER_REGISTRATIONS || '';
    const now = Date.now();
    if (cached.key === extra && now - cached.at < TTL_MS) return cached.value;
    const out = [];
    const seen = new Set();
    readDeclarations(PLUGINS_DIR, out, seen);
    if (extra) readDeclarations(path.resolve(extra), out, seen);
    cached = { at: now, key: extra, value: out };
    return out;
}

// `id` is already bare: no claude- prefix, [1m] tag or effort suffix.
function registrationFor(id) {
    const text = String(id || '');
    return text ? providerRegistrations().find(registration => registration.pattern.test(text)) || null : null;
}

function registrationModelsFile(registration, modDir) {
    const override = registration.modelsFileEnv ? process.env[registration.modelsFileEnv] : '';
    return override || path.resolve(modDir, registration.modelsFile);
}

module.exports = { providerRegistrations, registrationFor, registrationModelsFile };
