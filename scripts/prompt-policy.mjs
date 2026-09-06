#!/usr/bin/env node
// Local helper for the prompt-policy skill. It reads the router's explicit
// prompt capture and writes a validated profile through the dashboard store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsFile = process.env.MODEL_ROUTER_SETTINGS_FILE || path.join(root, '.state', 'settings.json');
const captureFile = path.join(process.env.MODEL_ROUTER_STATE_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'gemini-bridge'), 'prompt-policy-capture-v2.json');
const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] || null;
};
const providerId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
    ? value.toLowerCase() : null;

function read(file, fallback)
{
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return fallback; }
}

function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function show()
{
    const captures = read(captureFile, { entries: [] }).entries
        .filter(value => Array.isArray(value.tools) && value.tools.length > 0);
    const session = option('--session') || process.env.CLAUDE_CODE_SESSION_ID || null;
    const entry = session ? captures.find(value => value.sessionId === session) : captures[0];
    if (!entry) throw new Error(`no captured agent prompt exists${session ? ` for session ${session}` : ''}; send one routed agent request first`);
    process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
}

function apply()
{
    const name = option('--name');
    const mode = option('--mode');
    const systemFile = option('--system-file');
    const session = option('--session');
    const requestedProvider = option('--provider');
    if (!name || !['append', 'replace'].includes(mode) || !systemFile) throw new Error('apply needs --name, --mode append|replace, and --system-file');
    const providerScope = requestedProvider ? providerId(requestedProvider) : null;
    if (requestedProvider && !providerScope) throw new Error('invalid --provider scope');
    const systemText = fs.readFileSync(systemFile, 'utf8');
    if (!systemText.trim()) throw new Error('system prompt text is empty; refusing to create a policy that silently erases the prompt');
    const settings = read(settingsFile, {});
    const provider = settings['provider-picker'] && typeof settings['provider-picker'] === 'object'
        ? settings['provider-picker'] : {};
    const profiles = Array.isArray(provider.promptPolicies) ? provider.promptPolicies.filter(profile => profile?.id && profile.id !== 'preserve') : [];
    const profile = {
        id: 'policy-' + crypto.randomBytes(4).toString('hex'),
        name: name.slice(0, 80), generation: 1, enabled: true,
        providers: providerScope ? [providerScope] : [],
        systemMode: mode, systemText,
        userPrefix: '', userSuffix: '', toolDescriptionPrefix: '', toolDescriptionSuffix: '',
    };
    provider.promptPolicies = profiles.concat(profile);
    if (session) provider.promptPolicySessionBindings = { ...(provider.promptPolicySessionBindings || {}), [session]: profile.id };
    else if (providerScope)
    {
        const activeByProvider = { ...(provider.activePromptPolicyIds || {}) };
        const current = profiles.find((value) => value.id === provider.activePromptPolicyId);
        if (Array.isArray(current?.providers) && current.providers.length)
        {
            for (const provider of current.providers)
            {
                const scope = providerId(provider);
                if (scope && !activeByProvider[scope]) activeByProvider[scope] = current.id;
            }
            provider.activePromptPolicyId = 'preserve';
        }
        activeByProvider[providerScope] = profile.id;
        provider.activePromptPolicyIds = activeByProvider;
    }
    else provider.activePromptPolicyId = profile.id;
    settings['provider-picker'] = provider;
    write(settingsFile, settings);
    process.stdout.write(JSON.stringify({ profileId: profile.id, provider: providerScope, sessionId: session, settingsFile }) + '\n');
}

function preserve()
{
    const session = option('--session');
    const requestedProvider = option('--provider');
    const providerScope = requestedProvider ? providerId(requestedProvider) : null;
    if (requestedProvider && !providerScope) throw new Error('invalid --provider scope');
    const settings = read(settingsFile, {});
    const provider = settings['provider-picker'] && typeof settings['provider-picker'] === 'object'
        ? settings['provider-picker'] : {};
    if (session) provider.promptPolicySessionBindings = { ...(provider.promptPolicySessionBindings || {}), [session]: 'preserve' };
    else if (providerScope) provider.activePromptPolicyIds = { ...(provider.activePromptPolicyIds || {}), [providerScope]: 'preserve' };
    else
    {
        provider.activePromptPolicyId = 'preserve';
        provider.activePromptPolicyIds = {};
    }
    settings['provider-picker'] = provider;
    write(settingsFile, settings);
    process.stdout.write(JSON.stringify({ profileId: 'preserve', provider: providerScope, sessionId: session, settingsFile }) + '\n');
}

try {
    if (args[0] === 'show') show();
    else if (args[0] === 'apply') apply();
    else if (args[0] === 'preserve') preserve();
    else throw new Error('usage: prompt-policy.mjs show [--session ID] | apply --name NAME --mode append|replace --system-file FILE [--provider ID] [--session ID] | preserve [--provider ID] [--session ID]');
}
catch (error)
{
    process.stderr.write(`prompt-policy: ${error.message}\n`);
    process.exitCode = 1;
}
