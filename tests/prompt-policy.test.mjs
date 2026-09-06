import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-policy-'));
process.env.MODEL_ROUTER_STATE_DIR = temp;
process.env.MODEL_ROUTER_SETTINGS_FILE = path.join(temp, 'settings.json');
const {
    applyPromptPolicy,
    isPromptPolicyRequest,
    normalizePromptPolicySettings,
    policyChangesCachePrefix,
    resolvePromptPolicy,
} = await import('../router/prompt-policy.mjs');
const { capturePrompt, promptCaptureFile } = await import('../router/prompt-capture.mjs');
const { buildResponsesRequest } = await import('../router/openai.mjs');
const { prepareCompatibleBody } = await import('../router/index.mjs');
const { readProviderSettings } = await import('../router/settings.mjs');

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const alpha = {
    id: 'alpha', name: 'Alpha', generation: 1, enabled: true,
    systemMode: 'append', systemText: 'policy system', userPrefix: '[prefix]', userSuffix: '[suffix]',
    toolDescriptionPrefix: 'before: ', toolDescriptionSuffix: ' :after',
};
const body = {
    model: 'claude-gpt-5.6-sol[1m]',
    system: 'base system',
    messages: [
        { role: 'user', content: 'first user' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'result' }, { type: 'text', text: 'current user' }] },
    ],
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
};

function selection(profile) { return { profile, id: profile.id, generation: profile.generation }; }

test('Preserve returns the original body and keeps the existing OpenAI cache key', () => {
    const preserve = normalizePromptPolicySettings({}).promptPolicies[0];
    assert.strictEqual(applyPromptPolicy(body, selection(preserve)), body);
    assert.equal(policyChangesCachePrefix(preserve), false);
    assert.equal(buildResponsesRequest(body).key, buildResponsesRequest(body, {}, selection(preserve)).key);
});

test('policy transforms system, only the current direct user turn, and tool descriptions', () => {
    const transformed = applyPromptPolicy(body, selection(alpha));
    assert.equal(transformed.system, 'base system\n\npolicy system');
    assert.equal(transformed.messages[0], body.messages[0]);
    assert.deepEqual(transformed.messages[2].content, [
        { type: 'text', text: '[prefix]' },
        { type: 'tool_result', tool_use_id: 'tool_1', content: 'result' },
        { type: 'text', text: 'current user' },
        { type: 'text', text: '[suffix]' },
    ]);
    assert.equal(transformed.tools[0].description, 'before: Read a file :after');
    assert.equal(policyChangesCachePrefix(alpha), true);

    const replacement = applyPromptPolicy(body, selection({ ...alpha, systemMode: 'replace', systemText: 'replacement' }));
    assert.equal(replacement.system, 'replacement');
    assert.equal(Object.hasOwn(applyPromptPolicy(body, selection({ ...alpha, systemMode: 'replace', systemText: '' })), 'system'), false);
});

test('profile changes apply to the next request without a conversation pin', () => {
    const firstSettings = normalizePromptPolicySettings({ promptPolicies: [alpha], activePromptPolicyId: 'alpha' });
    const first = resolvePromptPolicy(body, 'openai', firstSettings);
    assert.equal(first.id, 'alpha');
    assert.equal(first.generation, 1);

    const revised = { ...alpha, generation: 2, systemText: 'revised policy system' };
    const nextSettings = normalizePromptPolicySettings({
        promptPolicies: [revised], promptPolicyVersions: [alpha], activePromptPolicyId: 'alpha',
    });
    const current = resolvePromptPolicy(body, 'openai', nextSettings);
    assert.equal(current.generation, 2);
    assert.equal(current.profile.systemText, 'revised policy system');
    assert.equal(fs.existsSync(path.join(temp, 'prompt-policy-pins-v1.json')), false);
});

test('a session binding overrides the default on every request', () => {
    const settings = normalizePromptPolicySettings({
        promptPolicies: [alpha], activePromptPolicyId: 'preserve',
        promptPolicySessionBindings: { 'session-a': 'alpha', 'session-b': 'missing' },
    });
    assert.equal(resolvePromptPolicy(body, 'acme', settings, 'session-a').id, 'alpha');
    assert.equal(resolvePromptPolicy(body, 'acme', settings, 'session-b').id, 'preserve');
    assert.equal(resolvePromptPolicy(body, 'acme', settings, 'session-c').id, 'preserve');

    const rebound = normalizePromptPolicySettings({
        promptPolicies: [alpha], activePromptPolicyId: 'alpha',
        promptPolicySessionBindings: { 'session-a': 'preserve' },
    });
    assert.equal(resolvePromptPolicy(body, 'acme', rebound, 'session-a').id, 'preserve');
});

test('provider-scoped defaults coexist and preserve every non-target provider', () => {
    const acmeOnly = { ...alpha, id: 'acme-only', providers: ['Acme', 'acme', 'bad provider'] };
    const openaiOnly = { ...alpha, id: 'openai-only', providers: ['openai'] };
    const settings = normalizePromptPolicySettings({
        promptPolicies: [acmeOnly, openaiOnly], activePromptPolicyId: 'preserve',
        activePromptPolicyIds: { Acme: 'acme-only', openai: 'openai-only', invalid: 'missing' },
    });
    assert.deepEqual(settings.promptPolicies[1].providers, ['acme']);
    assert.deepEqual(settings.activePromptPolicyIds, { acme: 'acme-only', openai: 'openai-only' });
    assert.equal(resolvePromptPolicy(body, 'acme', settings, 'session-a').id, 'acme-only');
    assert.equal(resolvePromptPolicy(body, 'openai', settings, 'session-a').id, 'openai-only');
    assert.equal(resolvePromptPolicy(body, 'anthropic', settings, 'session-a').id, 'preserve');
    assert.equal(resolvePromptPolicy(body, 'stub', settings, 'session-a').id, 'preserve');
});

test('control-plane requests never enter the agent prompt-policy namespace', () => {
    const control = {
        ...body,
        model: 'claude-sonnet-5',
        system: 'You are a security monitor for autonomous AI coding agents.',
        tools: [],
    };
    const settings = normalizePromptPolicySettings({ promptPolicies: [alpha], activePromptPolicyId: 'alpha' });
    const selected = resolvePromptPolicy(control, 'anthropic', settings, 'session-a');
    assert.equal(isPromptPolicyRequest(control), false);
    assert.equal(selected.requestKind, 'control');
    assert.equal(selected.id, 'preserve');
    assert.strictEqual(applyPromptPolicy(control, selected), control);

    const agent = resolvePromptPolicy(body, 'openai', settings, 'session-a');
    assert.equal(isPromptPolicyRequest(body), true);
    assert.equal(agent.requestKind, 'agent');
    assert.equal(agent.id, 'alpha');
});

test('OpenAI cache keys isolate changed cache prefixes but retain user-only stability', () => {
    const appendOne = selection(alpha);
    const appendTwo = selection({ ...alpha, generation: 2 });
    const built = buildResponsesRequest(body, {}, appendOne);
    assert.equal(built.promptSurface.system, 'base system');
    assert.equal(built.promptSurface.effectiveSystem, 'base system\n\npolicy system');
    assert.equal(built.promptSurface.tools[0].description, 'Read a file');
    assert.equal(built.promptSurface.effectiveTools[0].description, 'before: Read a file :after');
    assert.notEqual(built.key, buildResponsesRequest(body, {}, appendTwo).key);

    const userOnlyOne = selection({ ...alpha, id: 'user-one', generation: 1, systemMode: 'preserve', systemText: '', toolDescriptionPrefix: '', toolDescriptionSuffix: '' });
    const userOnlyTwo = selection({ ...userOnlyOne.profile, id: 'user-two', generation: 2 });
    assert.equal(buildResponsesRequest(body, {}, userOnlyOne).key, buildResponsesRequest(body, {}, userOnlyTwo).key);
});

// Every arm builds its count body and its inference body from one function, so
// a policy can never apply to one and not the other. The compatible arm stands
// in for all of them here: it is the one that is always compiled in.
test('count and inference preparation receive the same current policy body', () => {
    const selected = selection(alpha);
    const model = { id: 'stub-compat-1', provider: 'stub' };
    const count = prepareCompatibleBody(body, model, selected);
    const inference = prepareCompatibleBody(body, model, selected);
    assert.deepEqual(count, inference);
    assert.equal(count.system, 'base system\n\npolicy system');
    assert.equal(count.messages.at(-1).content[0].text, '[prefix]');
    assert.equal(count.tools[0].description, 'before: Read a file :after');
});

test('prompt capture keeps source and effective surfaces outside telemetry', () => {
    capturePrompt({ provider: 'openai', sessionId: 'capture-session', model: 'gpt-fixture', selection: selection(alpha),
        system: 'verbatim incoming system', tools: [{ name: 'read_file', description: 'Read files' }],
        effectiveSystem: 'verbatim incoming system\n\npolicy system',
        effectiveTools: [{ name: 'read_file', description: 'before: Read files :after' }] });
    const capture = JSON.parse(fs.readFileSync(promptCaptureFile(), 'utf8'));
    assert.equal(capture.version, 2);
    assert.equal(capture.entries[0].system, 'verbatim incoming system');
    assert.equal(capture.entries[0].effectiveSystem, 'verbatim incoming system\n\npolicy system');
    assert.equal(capture.entries[0].tools[0].name, 'read_file');
    assert.equal(capture.entries[0].effectiveTools[0].description, 'before: Read files :after');
    capturePrompt({ provider: 'anthropic', sessionId: 'capture-session', model: 'claude-sonnet-5',
        selection: { ...selection(alpha), requestKind: 'control' },
        system: 'You are a security monitor for autonomous AI coding agents.', tools: [],
        effectiveSystem: 'You are a security monitor for autonomous AI coding agents.', effectiveTools: [] });
    const afterControl = JSON.parse(fs.readFileSync(promptCaptureFile(), 'utf8'));
    assert.equal(afterControl.entries.length, 1);
    assert.equal(afterControl.entries[0].system, 'verbatim incoming system');
    assert.equal(capture.entries[0].response, undefined);
    assert.equal(capture.entries[0].credentials, undefined);
});

test('prompt policy helper binds session policies without changing the global default', () => {
    const script = fileURLToPath(new URL('../scripts/prompt-policy.mjs', import.meta.url));
    const draft = path.join(temp, 'draft.txt');
    fs.writeFileSync(draft, 'approved replacement');
    const captures = JSON.parse(fs.readFileSync(promptCaptureFile(), 'utf8'));
    captures.entries.unshift({ provider: 'anthropic', sessionId: 'capture-session', model: 'claude-sonnet-5',
        capturedAt: new Date(0).toISOString(), policy: { id: 'preserve', generation: 1 },
        system: 'You are a security monitor for autonomous AI coding agents.', tools: [],
        effectiveSystem: 'You are a security monitor for autonomous AI coding agents.', effectiveTools: [] });
    fs.writeFileSync(promptCaptureFile(), JSON.stringify(captures));
    const shown = spawnSync(process.execPath, [script, 'show', '--session', 'capture-session'], { env: process.env, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).system, 'verbatim incoming system');
    const defaulted = spawnSync(process.execPath, [script, 'show'], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'capture-session' }, encoding: 'utf8',
    });
    assert.equal(defaulted.status, 0, defaulted.stderr);
    assert.equal(JSON.parse(defaulted.stdout).system, 'verbatim incoming system');

    const existingAcme = { ...alpha, id: 'existing-acme', providers: ['acme'] };
    fs.writeFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, JSON.stringify({
        'provider-picker': { activePromptPolicyId: 'existing-acme', promptPolicies: [existingAcme] },
    }));

    const applied = spawnSync(process.execPath, [script, 'apply', '--name', 'Session policy', '--mode', 'replace', '--system-file', draft, '--provider', 'acme', '--session', 'session-a'], {
        env: process.env, encoding: 'utf8',
    });
    assert.equal(applied.status, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout);
    const settings = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, 'utf8'))['provider-picker'];
    assert.equal(settings.activePromptPolicyId, 'existing-acme');
    assert.equal(appliedResult.provider, 'acme');
    assert.match(settings.promptPolicySessionBindings['session-a'], /^policy-/);
    assert.deepEqual(settings.promptPolicies.find(profile => profile.id === appliedResult.profileId).providers, ['acme']);

    const global = spawnSync(process.execPath, [script, 'apply', '--name', 'OpenAI policy', '--mode', 'append', '--system-file', draft, '--provider', 'OpenAI'], {
        env: process.env, encoding: 'utf8',
    });
    assert.equal(global.status, 0, global.stderr);
    const globalResult = JSON.parse(global.stdout);
    const migrated = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, 'utf8'))['provider-picker'];
    assert.equal(migrated.activePromptPolicyId, 'preserve');
    assert.equal(migrated.activePromptPolicyIds.acme, 'existing-acme');
    assert.equal(migrated.activePromptPolicyIds.openai, globalResult.profileId);

    fs.writeFileSync(draft, '');
    const empty = spawnSync(process.execPath, [script, 'apply', '--name', 'Empty', '--mode', 'replace', '--system-file', draft], {
        env: process.env, encoding: 'utf8',
    });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /silently erases/);

    const openaiPreserved = spawnSync(process.execPath, [script, 'preserve', '--provider', 'openai'], { env: process.env, encoding: 'utf8' });
    assert.equal(openaiPreserved.status, 0, openaiPreserved.stderr);
    const onePreserved = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, 'utf8'))['provider-picker'];
    assert.equal(onePreserved.activePromptPolicyIds.openai, 'preserve');
    assert.equal(onePreserved.activePromptPolicyIds.acme, 'existing-acme');

    const preserved = spawnSync(process.execPath, [script, 'preserve'], { env: process.env, encoding: 'utf8' });
    assert.equal(preserved.status, 0, preserved.stderr);
    const allPreserved = JSON.parse(fs.readFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, 'utf8'))['provider-picker'];
    assert.equal(allPreserved.activePromptPolicyId, 'preserve');
    assert.deepEqual(allPreserved.activePromptPolicyIds, {});
});

test('settings reject malformed and empty replacement profiles safely', () => {
    fs.writeFileSync(process.env.MODEL_ROUTER_SETTINGS_FILE, JSON.stringify({
        'provider-picker': {
            activePromptPolicyId: 'empty', activePromptPolicyIds: { Acme: 'empty', openai: 'missing', 'bad provider': 'empty' },
            promptPolicies: [{ id: 'bad id', systemMode: 'invalid' }, { id: 'empty', systemMode: 'replace', systemText: '' }],
        },
    }));
    const settings = readProviderSettings();
    assert.equal(settings.activePromptPolicyId, 'empty');
    assert.deepEqual(settings.activePromptPolicyIds, { acme: 'empty' });
    assert.deepEqual(settings.promptPolicies.map(profile => profile.id), ['preserve', 'empty']);
    assert.equal(settings.promptPolicies[1].systemMode, 'preserve');
    assert.strictEqual(applyPromptPolicy(body, resolvePromptPolicy(body, 'openai', settings)), body);
});
