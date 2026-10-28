'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const { routedModel } = require('../unlock-code/main');
const { registrationFor, providerRegistrations, registrationModelsFile } = require('./registrations');

const DASHBOARD_SETTINGS = Symbol.for('cuimod.dashboard.settings');
const CONTEXT_QUEUE = Symbol.for('cuimod.provider-context.queue');
const MIN_WINDOW = 100000;
const MAX_WINDOW = 1000000;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'];
const FAMILY_ENV_KEYS = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'];
const MODEL_ENV_KEYS = ['ANTHROPIC_SMALL_FAST_MODEL', ...FAMILY_ENV_KEYS];
// Saved sessions carry this variable in their settings env, so it keeps the
// spelling it first shipped with.
const MODEL_ENV_DEFAULTS = 'CUIMOD_COS_MODEL_ENV_DEFAULTS';

// The model a routed session hands its helper work to, and the tier its
// unconsidered subagents land on, are deployment choices that only make sense
// where that model routes. defaults.private.json beside this file names them. A
// tree without one keeps Desktop's own helper and lets those subagents inherit
// the session's model, which route wherever the session does.
// CUIMOD_ROUTING_DEFAULTS points tests at a fixture.
function deploymentDefaults() {
    let value = null;
    try {
        const file = process.env.CUIMOD_ROUTING_DEFAULTS || path.join(__dirname, 'defaults.private.json');
        value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) {}
    const text = key => typeof value?.[key] === 'string' && value[key] ? value[key] : null;
    return { helper: text('helperModel'), routedSubagent: text('routedSubagentModel') };
}

function bare(model) {
    return String(model || '').trim().toLowerCase().replace(/\[1m\]/g, '')
        .replace(/:(none|minimal|low|medium|high|xhigh|max|ultra|pro)$/, '')
        .replace(/^(?:claude-)+/, '');
}

// A model belongs to a declared provider (registrations.js) by its bare id.
function isRegisteredModel(model) { return registrationFor(bare(model)) !== null; }

// CLI 2.1.280 resolves an agent definition with no `model:` (general-purpose,
// the FleetView catch-all, workflow leaves) through CLAUDE_CODE_SUBAGENT_MODEL
// before inheriting the parent. That is the one hook that lets an unconsidered
// spawn land on the launching provider's cheap tier instead of on the root's
// model. The CLI then shapes the child's requests for the model it will really
// call; rewriting the model in the router would send a request built for Fable
// to Sonnet. Fixed at spawn, like the helper model: a later provider switch
// keeps the launch-time tier.
const SUBAGENT_DEFAULTS = {
    claude: 'claude-sonnet-5-5',
    openai: 'claude-gpt-5.6-luna[1m]:high',
};

function subagentDefault(model, routed) {
    if (model.startsWith('gpt-')) return SUBAGENT_DEFAULTS.openai;
    return routed || isRegisteredModel(model) ? deploymentDefaults().routedSubagent : SUBAGENT_DEFAULTS.claude;
}

// CLI 2.1.260 resolves agent family aliases independently of SMALL_FAST_MODEL.
// Keep their original values in the session's existing env so a later model
// change, hot reload or resume can restore them without forcing concrete agents.
function applyRegisteredModelEnvironment(env, model) {
    const next = { ...env };
    let defaults;
    if (next[MODEL_ENV_DEFAULTS]) {
        try { defaults = JSON.parse(next[MODEL_ENV_DEFAULTS]); } catch (_) {}
        if (!defaults || Array.isArray(defaults) || !MODEL_ENV_KEYS.every(key =>
            defaults[key] === null || typeof defaults[key] === 'string'))
            throw new Error('Invalid saved model environment defaults.');
    }
    if (isRegisteredModel(model)) {
        defaults ||= Object.fromEntries(MODEL_ENV_KEYS.map(key => [key, next[key] ?? null]));
        next[MODEL_ENV_DEFAULTS] = JSON.stringify(defaults);
        const selected = String(model).trim().toLowerCase().replace(/\[1m\]/g, '').replace(/^(?:claude-)+/, '');
        // Claude Code uses SMALL_FAST_MODEL for internal helper/classifier work,
        // including MCP permission checks. A registered provider serves one
        // request per session, so pointing that back at it creates a recursive
        // request while the main turn is still active, which trips the
        // single-request guard and can loop on safety-classifier retries. Keep
        // the preserved helper unless it is registered too (then the
        // deployment's helper, else the CLI's own), and route only the
        // model-family aliases.
        const helper = defaults.ANTHROPIC_SMALL_FAST_MODEL;
        const kept = helper && !isRegisteredModel(helper) ? helper : deploymentDefaults().helper;
        if (kept) next.ANTHROPIC_SMALL_FAST_MODEL = kept;
        else delete next.ANTHROPIC_SMALL_FAST_MODEL;
        for (const key of FAMILY_ENV_KEYS) next[key] = selected;
    } else if (defaults) {
        for (const key of MODEL_ENV_KEYS) {
            if (defaults[key] === null) delete next[key];
            else next[key] = defaults[key];
        }
        delete next[MODEL_ENV_DEFAULTS];
    }
    return next;
}

// Codex's models cache lists each slug's speed tiers; the one with id
// "priority" is what Codex's /fast turns on. Read per call so a refreshed cache
// reaches the next spawn.
function codexFastSlugs(file = path.join(os.homedir(), '.codex', 'models_cache.json')) {
    let models;
    try { models = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).models; }
    catch (_) { return []; }
    return (Array.isArray(models) ? models : [])
        .filter(m => typeof m?.slug === 'string' && /^gpt-[a-z0-9._-]+$/i.test(m.slug)
            && Array.isArray(m.service_tiers) && m.service_tiers.some(tier => tier?.id === 'priority'))
        .map(m => m.slug.toLowerCase());
}

// CLI 2.1.284 sends speed:"fast" only for a model with the fast_mode
// capability, and a routed id has none, so the session's fast switch did
// nothing on GPT. CLAUDE_CODE_MODEL_CAPABILITIES grants it per model:
// "pattern=cap;..." where a trailing * is a prefix match against the id with
// [1m] removed, so it also covers the ":tier" agent spellings. The env is fixed
// at spawn and a session can switch model live, so every fast-capable slug is
// listed on every worker. Inherited entries come after ours; the last match wins.
function fastModeCapabilities(slugs, inherited) {
    const ours = slugs.flatMap(slug => [`claude-${slug}*=fast_mode`, `${slug}*=fast_mode`]);
    const theirs = String(inherited || '').split(';').map(entry => entry.trim()).filter(Boolean);
    return [...new Set([...ours, ...theirs])].join(';');
}

// Launch, model selection and the live compaction editor must resolve the same
// policy. Keep these helpers on this module so importing them starts no plugin.
function createContextPolicy(modDir) {
    const settingsFile = path.join(modDir, '.state', 'settings.json');
    const read = file => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
        catch (_) { return null; }
    };
    // Each declared provider's discovery output, as picker rows. The provider
    // and its label come from the declaration, never from the file it points at.
    function models() {
        const seen = new Set();
        return providerRegistrations().flatMap(registration => {
            const value = read(registrationModelsFile(registration, modDir));
            if (value?.version !== 1 || !Array.isArray(value.models)) return [];
            return value.models.flatMap(row => {
                const id = String(row?.id || '').toLowerCase();
                const context = Number(row?.context);
                if (!registration.pattern.test(id) || seen.has(id)
                    || !Number.isFinite(context) || context < MIN_WINDOW || context > MAX_WINDOW
                    || !Array.isArray(row.efforts) || row.efforts.some(e => !EFFORTS.includes(e))) return [];
                seen.add(id);
                const efforts = [...new Set(row.efforts)];
                return [{ id, name: String(row.name || id), provider: registration.provider, providerLabel: registration.label,
                    registered: true,
                    efforts, defaultEffort: efforts.includes(row.defaultEffort) ? row.defaultEffort : efforts[0] || null,
                    context: Math.round(context), ...(typeof row.contextNote === 'string' ? { contextNote: row.contextNote } : {}) }];
            });
        });
    }
    function policy() {
        const live = globalThis[DASHBOARD_SETTINGS]?.store;
        const saved = live && typeof live === 'object' && !Array.isArray(live)
            ? live['auto-compact'] : read(settingsFile)?.['auto-compact'];
        const window = value => {
            const n = Number(value);
            return Number.isFinite(n) && n > 0 ? Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.round(n))) : null;
        };
        const perModel = {};
        for (const [id, value] of Object.entries(saved?.perModel || {})) {
            const n = window(value);
            if (n !== null) perModel[bare(id)] = n;
        }
        const sessions = {};
        for (const [id, value] of Object.entries(saved?.sessionOverrides || {})) {
            if (!/^[0-9a-f-]{8,64}$/i.test(id) || !value || typeof value !== 'object') continue;
            const n = window(value.window);
            sessions[id.toLowerCase()] = {
                ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
                ...(n !== null ? { window: n } : {}),
            };
        }
        return { enabled: saved?.enabled === true, defaultWindow: window(saved?.defaultWindow), perModel, sessions,
            precompute: ['default', 'on', 'off'].includes(saved?.precompute) ? saved.precompute : 'default' };
    }
    function providerWindow(model) {
        return isRegisteredModel(model) ? models().find(row => row.id === bare(model))?.context ?? null : null;
    }
    function resolve(model, sessionId, override) {
        const config = policy();
        const session = config.sessions[String(sessionId || '').toLowerCase()];
        const requested = override === undefined
            ? session?.window ?? config.perModel[bare(model)] ?? config.defaultWindow : override;
        const cap = providerWindow(model);
        const registration = registrationFor(bare(model));
        if (registration && cap === null)
            throw new Error(`${registration.label} context metadata is unavailable for ${bare(model)}. Refresh model discovery before selecting it.`);
        return { window: cap === null ? requested : Math.min(requested || cap, cap),
            providerWindow: cap, enabled: session?.enabled ?? config.enabled, precompute: config.precompute };
    }
    function catalogWindow(model) {
        for (const name of ['catalogue.json', 'catalogue.private.json']) {
            const rows = read(path.join(modDir, 'src', 'plugins', 'provider-picker', name));
            const row = Array.isArray(rows) ? rows.find(row => bare(row?.id) === bare(model)) : null;
            const n = Number(row?.context);
            if (Number.isFinite(n) && n >= MIN_WINDOW && n <= MAX_WINDOW) return Math.round(n);
        }
        return null;
    }
    return { models, policy, providerWindow, resolve, catalogWindow };
}

function serializeContext(session, task) {
    const prior = session[CONTEXT_QUEUE] || Promise.resolve();
    const run = prior.then(task, task);
    const settled = run.then(() => {}, () => {});
    session[CONTEXT_QUEUE] = settled;
    settled.then(() => { if (session[CONTEXT_QUEUE] === settled) delete session[CONTEXT_QUEUE]; });
    return run;
}

async function applySessionSettings(owner, session, patch, runtimePatch = patch) {
    const before = session.sessionSettings;
    const next = { ...(before || {}), ...patch };
    session.sessionSettings = next;
    try {
        owner.saveSession?.(session);
        owner.emitSessionUpdated?.(session);
        await session.query.applyFlagSettings(runtimePatch);
    } catch (error) {
        if (session.sessionSettings === next) {
            session.sessionSettings = before;
            try { owner.saveSession?.(session); owner.emitSessionUpdated?.(session); } catch (_) {}
        }
        throw error;
    }
}

// Desktop explicitly supplies api.anthropic.com in the child environment, which
// overrides settings.json. Patch the actual spawn boundary, preserving all of
// Desktop's other environment and argument values.
module.exports = function (ctx) {
    const entry = path.resolve(ctx.dir || __dirname, '..', '..', '..', 'router', 'supervisor.mjs');
    let pending = null;
    let stopped = false;
    const currentSpawn = childProcess.spawn;
    const originalSpawn = currentSpawn.__cuimodRoutingOriginal || currentSpawn;
    // In Electron, process.execPath is claude.exe, not Node.  Setting
    // ELECTRON_RUN_AS_NODE is not dependable on fused production builds and
    // can recursively launch Desktop instead of the bridge.  This project is
    // installed by Node, so resolve it through PATH unless explicitly pinned.
    const node = process.env.CLAUDE_UI_MOD_NODE || 'node.exe';

    // The policy is carried as a launch-time session setting, never by writing
    // ~/.claude.json. The CLI rewrites that file wholesale, while a per-session
    // setting can later be changed through the worker's own control channel.
    const modDir = ctx.boot?.MOD_DIR || path.resolve(ctx.dir || __dirname, '../../..');
    const contextPolicy = createContextPolicy(modDir);

    function optionValue(args, name) {
        for (let i = 0; i < args.length; i++) {
            const value = String(args[i]);
            if (value === name) return args[i + 1] == null ? null : String(args[i + 1]);
            if (value.startsWith(name + '=')) return value.slice(name.length + 1);
        }
        return null;
    }

    function replaceOption(args, name, value) {
        const out = [];
        for (let i = 0; i < args.length; i++) {
            const arg = String(args[i]);
            if (arg === name) { i++; continue; }
            if (arg.startsWith(name + '=')) continue;
            out.push(args[i]);
        }
        out.push(name, value);
        return out;
    }

    // Desktop supplies an inline --settings blob. Preserve its unrelated
    // session flags and place CUIMOD's enable/precompute policy in that same
    // highest-priority launch source. A non-JSON setting source is left intact:
    // window and off state still have their dedicated flag/environment controls.
    function mergeLaunchSettings(args, patch, model, inheritedEnv) {
        const out = args.slice();
        const merge = parsed => {
            const settings = { ...parsed, ...patch };
            if (isRegisteredModel(model) || parsed.env?.[MODEL_ENV_DEFAULTS]) {
                const defaults = Object.fromEntries([...MODEL_ENV_KEYS, MODEL_ENV_DEFAULTS]
                    .filter(key => Object.hasOwn(inheritedEnv, key)).map(key => [key, inheritedEnv[key]]));
                settings.env = applyRegisteredModelEnvironment({ ...defaults, ...parsed.env }, model);
            }
            return JSON.stringify(settings);
        };
        for (let i = 0; i < out.length; i++) {
            const arg = String(out[i]);
            const inline = arg === '--settings' ? out[i + 1]
                : arg.startsWith('--settings=') ? arg.slice('--settings='.length) : null;
            if (typeof inline !== 'string') continue;
            let parsed;
            try { parsed = JSON.parse(inline); }
            catch (_) { continue; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            const merged = merge(parsed);
            if (arg === '--settings') out[i + 1] = merged;
            else out[i] = '--settings=' + merged;
            return out;
        }
        out.push('--settings', merge({}));
        return out;
    }

    // The fast value the user last set on the Desktop session this worker
    // belongs to. Desktop fills the launch's fastMode from the composer switch
    // at (re)start; the recorded per-session value is the one to keep.
    function sessionFastMode(cliSessionId) {
        if (!cliSessionId) return undefined;
        for (const module of Object.values(require.cache || {})) {
            const manager = module?.exports?.claudeCodeSessionManager;
            if (!manager?.sessions || typeof manager.sessions.values !== 'function') continue;
            for (const session of manager.sessions.values())
                if (String(session?.cliSessionId || '').toLowerCase() === cliSessionId)
                    return require('../fast-mode/main').readFastIntent(modDir, session.sessionId);
        }
        return undefined;
    }

    function routedSpawn(file, args, options) {
        if (Array.isArray(args) && /[\\/]claude-code[\\/]/i.test(String(file))) {
            // The provider bridge is the owned transport for every spawned
            // Claude Code session. Startup begins at host load; this call
            // preserves the routing contract while the bridge becomes ready.
            if (ctx.electron.app?.isReady) ensure();

            const selectedModel = optionValue(args, '--model');
            const model = bare(selectedModel);
            const sessionId = (optionValue(args, '--resume') || optionValue(args, '--session-id') || '').toLowerCase();
            const policy = contextPolicy.resolve(model, sessionId);
            const providerWindow = policy.providerWindow;
            // Bare adapter ids let Claude Code honour this launch window instead
            // of the ~180k unknown-Claude guard that a fabricated `claude-` alias
            // activates. A registered provider's observed ceiling remains the cap;
            // an explicit smaller user window is still respected.
            const requestedWindow = policy.window;
            const enabled = policy.enabled;
            // This is the worker's own launch-time setting, above bootstrap
            // clientdata. `auto` is deliberate: rows without a window retain
            // Claude Code's resolver instead of receiving an invented number.
            args = replaceOption(args, '--autocompact', requestedWindow ? String(requestedWindow) : 'auto');

            // Use the session setting for default-off. DISABLE_AUTO_COMPACT would
            // make a live opt-in impossible because its environment gate wins
            // before the worker can consult autoCompactEnabled.
            const launchSettings = {
                autoCompactEnabled: enabled,
                // This skips only Anthropic's domain-reputation lookup. Claude
                // Code still applies URL, permission, redirect and egress guards
                // before its local fetch, while the session's helper handles
                // the result transform.
                skipWebFetchPreflight: true,
            };
            if (policy.precompute === 'on') launchSettings.precomputeCompactionEnabled = true;
            if (policy.precompute === 'off') launchSettings.precomputeCompactionEnabled = false;
            const fastMode = sessionFastMode(sessionId);
            if (typeof fastMode === 'boolean') launchSettings.fastMode = fastMode;
            // The deployment's helper stands in for Haiku only where the session
            // runs on a routed provider. A native Claude session keeps whatever
            // helper Desktop gave it, so its background work (titles, WebFetch,
            // permission checks) stays on Claude. The helper is fixed at spawn:
            // a later switch between Claude and a routed model keeps it.
            const baseEnv = options?.env || process.env;
            // gpt-* is the router's own OpenAI arm; retired ids leave the
            // catalogue but stay routable for saved sessions.
            const routed = model.startsWith('gpt-') || routedModel(modDir, selectedModel);
            const helperModel = deploymentDefaults().helper;
            const inheritedEnv = routed && helperModel
                ? { ...baseEnv, ANTHROPIC_SMALL_FAST_MODEL: helperModel } : { ...baseEnv };
            // An explicit value from the launching environment is the owner's
            // choice and wins over the per-provider tier.
            const tier = inheritedEnv.CLAUDE_CODE_SUBAGENT_MODEL ? null : subagentDefault(model, routed);
            if (tier) inheritedEnv.CLAUDE_CODE_SUBAGENT_MODEL = tier;
            // Native advisor ranks only cover Claude ids. A session can switch
            // to GPT without respawning, so its capability gate must be open at
            // launch. This chooses no reviewer; explicit overrides still win.
            if (!inheritedEnv.CLAUDE_CODE_DISABLE_ADVISOR_TOOL
                && inheritedEnv.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL === undefined)
                inheritedEnv.CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL = '1';
            args = mergeLaunchSettings(args, launchSettings, selectedModel, inheritedEnv);

            const env = applyRegisteredModelEnvironment({ ...inheritedEnv,
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789',
                // Bare adapter ids consult this cap. Keep the generic 1M
                // ceiling for catalogued providers, but a registered provider's
                // row reports its measured ceiling rather than pretending a
                // same-named API model's 1M class applies to it.
                CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(providerWindow ?? 1000000),
                _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
            }, selectedModel);
            // These alter the worker after its launch settings have been parsed.
            // Remove inherited overrides so the child cannot silently outrank the
            // policy it was spawned with.
            delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
            delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
            // Both environment gates bypass the worker's session setting. They
            // must be absent so a displayed session can opt in or out live.
            delete env.DISABLE_AUTO_COMPACT;
            delete env.DISABLE_COMPACT;
            // CCR worker routes are Anthropic product endpoints. Local WebFetch
            // plus the Messages-side hosted search bridge are the portable paths.
            delete env.CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY;
            delete env.CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY;
            const fastSlugs = codexFastSlugs();
            if (fastSlugs.length) env.CLAUDE_CODE_MODEL_CAPABILITIES = fastModeCapabilities(fastSlugs, env.CLAUDE_CODE_MODEL_CAPABILITIES);
            options = { ...options, env };
        }
        return originalSpawn.call(this, file, args, options);
    }
    routedSpawn.__cuimodRoutingOriginal = originalSpawn;
    childProcess.spawn = routedSpawn;

    // Model-lock filters renderer reconciliation before it reaches this manager.
    // Hook the manager so accepted internal changes also await their context
    // settings, without depending on which WebContents made the selection.
    const modelManagers = new Map();
    function attachModelContext() {
        for (const module of Object.values(require.cache || {})) {
            const manager = module?.exports?.claudeCodeSessionManager;
            if (!manager?.sessions || typeof manager.setModel !== 'function') continue;
            const current = manager.setModel;
            if (modelManagers.get(manager)?.wrapper === current) continue;
            const original = current.__cuimodRoutingModelOriginal || current;
            const wrapper = function (sessionId, model, ...rest) {
                const session = this.sessions.get(sessionId);
                if (!session) return original.call(this, sessionId, model, ...rest);
                return serializeContext(session, async () => {
                    if (this.sessions.get(sessionId) !== session)
                        throw new Error('The session changed before its model selection could be applied.');
                    const from = session.model;
                    if (!isRegisteredModel(from) && !isRegisteredModel(model))
                        return original.call(this, sessionId, model, ...rest);
                    const before = session.sessionSettings;
                    const heldWindow = Number(before?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || Number(before?.autoCompactWindow);
                    const override = bare(from) === bare(model) && heldWindow >= MIN_WINDOW && heldWindow <= MAX_WINDOW
                        ? heldWindow : undefined;
                    const target = contextPolicy.resolve(model, session.cliSessionId, override);
                    // A freshly launched registered-provider worker owns these defaults
                    // even before Desktop has saved a live settings patch. Only
                    // inherit model keys; never persist the parent's whole env.
                    const inheritedEnv = Object.fromEntries(MODEL_ENV_KEYS
                        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
                    const helperModel = deploymentDefaults().helper;
                    const previousEnv = applyRegisteredModelEnvironment({ ...inheritedEnv,
                        ...(helperModel ? { ANTHROPIC_SMALL_FAST_MODEL: helperModel } : {}), ...(before?.env || {}) }, from);
                    const nextEnv = applyRegisteredModelEnvironment(previousEnv, model);
                    const patchFor = policy => {
                        const window = policy.window ?? contextPolicy.catalogWindow(session.model);
                        return { autoCompactWindow: window, env: { ...nextEnv,
                            CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(policy.providerWindow ?? MAX_WINDOW),
                            CLAUDE_CODE_AUTO_COMPACT_WINDOW: window ? String(window) : '',
                            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '',
                        } };
                    };
                    let patched = false;
                    const apply = async policy => {
                        const patch = patchFor(policy);
                        patched = true;
                        if (typeof session.query?.applyFlagSettings === 'function') {
                            const env = { ...patch.env };
                            // Omitting a settings env key leaves the process value
                            // behind. The CLI's x.str() maps '' to undefined, so
                            // send clears to the worker but persist true absence.
                            for (const key of [...MODEL_ENV_KEYS, MODEL_ENV_DEFAULTS])
                                if (!Object.hasOwn(env, key)) env[key] = '';
                            await applySessionSettings(this, session, patch, { ...patch, env });
                        } else {
                            session.sessionSettings = { ...(session.sessionSettings || {}), ...patch };
                            this.saveSession?.(session);
                            this.emitSessionUpdated?.(session);
                        }
                    };
                    const restore = async () => {
                        if (!patched || this.sessions.get(sessionId) !== session) return;
                        if (typeof session.query?.applyFlagSettings === 'function') {
                            const env = { ...(before?.env || {}) };
                            for (const key of [...MODEL_ENV_KEYS, MODEL_ENV_DEFAULTS]) env[key] = previousEnv[key] ?? '';
                            for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'])
                                if (!Object.hasOwn(env, key)) env[key] = '';
                            await session.query.applyFlagSettings({ autoCompactWindow: before?.autoCompactWindow ?? null, env });
                        }
                        session.sessionSettings = before;
                        this.saveSession?.(session);
                        this.emitSessionUpdated?.(session);
                    };
                    try {
                        // Lower a running worker's budget before selecting a registered model.
                        // Raising it waits until the native model change succeeds.
                        const heldCap = Number(before?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS) || MAX_WINDOW;
                        if (target.providerWindow !== null && target.providerWindow <= heldCap) await apply(target);
                        if (this.sessions.get(sessionId) !== session)
                            throw new Error('The session changed while its context settings were being applied.');
                        const result = await original.call(this, sessionId, model, ...rest);
                        if (this.sessions.get(sessionId) !== session) return result;
                        if (result === false || bare(session.model) !== bare(model)) { await restore(); return result; }
                        if (!patched) await apply(contextPolicy.resolve(session.model, session.cliSessionId, override));
                        return result;
                    } catch (error) {
                        if (this.sessions.get(sessionId) === session) {
                            try {
                                if (session.model !== from) await original.call(this, sessionId, from);
                                await restore();
                            } catch (rollback) {
                                throw new AggregateError([error, rollback], 'Model/context update failed and its previous settings could not be restored.');
                            }
                        }
                        throw error;
                    }
                });
            };
            wrapper.__cuimodRoutingModelOriginal = original;
            manager.setModel = wrapper;
            modelManagers.set(manager, { original, wrapper });
        }
    }
    attachModelContext();
    ctx.every(1000, attachModelContext);
    // Probe the supervisor itself, not a worker endpoint. /healthz is deliberately
    // forwarded to the current worker, whose event loop can be busy with a large
    // request or ledger load. Treating that delay as a dead front door launches a
    // duplicate supervisor; it then boots a full worker before dying on EADDRINUSE.
    // /supervisorz is answered directly by the stable listener and stays cheap even
    // while the worker is saturated. Two misses still gate a cold-start spawn.
    function probe() {
        return new Promise(resolve => {
            const req = http.get('http://127.0.0.1:8789/supervisorz', res => { res.resume(); resolve(res.statusCode === 200 && res.headers?.['x-cuimod-router-supervisor'] === '1'); });
            req.setTimeout(5000, () => req.destroy());
            req.on('error', () => resolve(false));
        });
    }
    function ensure() {
        if (pending) return pending;
        pending = (async () => {
            if (await probe()) return true;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (await probe()) return true;
            if (stopped || !fs.existsSync(entry)) return false;
            const child = originalSpawn(node, [entry], {
                windowsHide: true, detached: true, stdio: 'ignore',
                env: { ...process.env },
            });
            child.on('error', err => ctx.log('router start: ' + err.message));
            child.unref();
            for (let attempt = 0; attempt < 25 && !stopped; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                if (await probe()) return true;
            }
            if (!stopped) ctx.log('router did not become healthy; will retry startup in 10 seconds');
            return false;
        })().finally(() => { pending = null; });
        return pending;
    }
    // Don't launch a daemon from selfcheck's fake Electron host.
    if (ctx.electron.app?.isReady) ensure();
    ctx.every(10000, () => { if (ctx.electron.app?.isReady) ensure(); });
    ctx.method('status', async () => ({ bridge: 'http://127.0.0.1:8789', entry, ready: await probe() }));
    ctx.onDispose(() => {
        stopped = true;
        // The loader constructs the next host before disposing this one. Never
        // overwrite the new host's wrapper while cleaning up the old instance.
        if (childProcess.spawn === routedSpawn) childProcess.spawn = originalSpawn;
        for (const [manager, { original, wrapper }] of modelManagers)
            if (manager.setModel === wrapper) manager.setModel = original;
        modelManagers.clear();
    });
};

module.exports.createContextPolicy = createContextPolicy;
module.exports.bareModel = bare;
module.exports.isRegisteredModel = isRegisteredModel;
module.exports.serializeContext = serializeContext;
module.exports.applySessionSettings = applySessionSettings;
module.exports.applyRegisteredModelEnvironment = applyRegisteredModelEnvironment;
module.exports.subagentDefault = subagentDefault;
module.exports.deploymentDefaults = deploymentDefaults;
module.exports.codexFastSlugs = codexFastSlugs;
module.exports.fastModeCapabilities = fastModeCapabilities;
