// Fireworks DeepSeek V4.1 must see a ToolSearch-loaded tool as a plain tool, and
// only Fireworks: the listing is tied to Fireworks' adapter dropping deferred
// tools, so another provider that shares the counter keeps its tool list.
// Synthetic requests through the real prepareCompatibleBody; nothing is sent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fireworks-deferred-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const adapterDir = path.join(temp, 'no-adapters');
fs.mkdirSync(adapterDir, { recursive: true });
fs.writeFileSync(path.join(temp, 'catalogue.json'), '[]');
fs.writeFileSync(path.join(temp, 'provider-secrets.json'), '{}');
// A missing authority file keeps this suite off the live credential view.
Object.assign(process.env, {
    MODEL_ROUTER_AUTHORITY_FILE: path.join(temp, 'no-credential-authority.json'),
    CODEX_AUTH_FILE: path.join(temp, 'no-auth.json'),
    MODEL_ROUTER_UPSTREAM: 'http://127.0.0.1:9/anthropic',
    CODEX_RESPONSES_URL: 'http://127.0.0.1:9/responses',
    MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: path.join(temp, 'catalogue.json'),
    MODEL_ROUTER_SECRETS_FILE: path.join(temp, 'provider-secrets.json'),
});
const { prepareCompatibleBody } = await import(pathToFileURL(path.join(root, 'index.mjs')).href);
const { renderDeepSeekV41Prompt } = await import(pathToFileURL(path.join(root, 'deepseek-v41.mjs')).href);
const { renderGlm53Prompt } = await import(pathToFileURL(path.join(root, 'glm-53.mjs')).href);

const fireworks = { provider: 'fireworks', upstreamId: 'accounts/fireworks/models/deepseek-v4p1-flash', counter: 'deepseek-v4.1-fireworks' };
const sharedCounter = { provider: 'other-host', upstreamId: 'deepseek-v4.1-flash', counter: 'deepseek-v4.1-fireworks' };
const glm = { provider: 'fireworks', upstreamId: 'accounts/fireworks/models/glm-5p3', counter: 'glm-5.3-fireworks' };
const noCounter = { provider: 'other-deepseek-host', upstreamId: 'deepseek/deepseek-v4.1-flash' };

const schema = () => ({ type: 'object', properties: { address: { type: 'string', description: 'EA' } }, required: ['address'], additionalProperties: false });
const tool = (name, extra = {}) => ({ name, description: `${name} description`, input_schema: schema(), ...extra });
const LOADED = 'mcp__ida-pro-mcp__decompile_function';
const UNLOADED = 'mcp__ida-pro-mcp__rename_function';
const REMOVED = 'mcp__ida-pro-mcp__get_callers';
const tools = () => [
    tool('Read'),
    tool('ToolSearch'),
    tool(LOADED, { defer_loading: true }),
    tool(UNLOADED, { defer_loading: true }),
    tool(REMOVED, { defer_loading: true }),
];
const request = () => ({
    model: 'claude-x', max_tokens: 64, system: 'sys', tools: tools(),
    messages: [
        { role: 'user', content: 'decompile it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'ToolSearch', input: { query: `select:${LOADED},${REMOVED}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
            { type: 'tool_reference', tool_name: LOADED }, { type: 'tool_reference', tool_name: REMOVED }] }] },
        { role: 'user', content: [{ type: 'text', text: `${UNLOADED} is literal text here` }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: LOADED, input: { address: '0x1' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: `result mentions ${UNLOADED} and ${REMOVED}` }] },
        { role: 'system', content: [{ type: 'tool_removal', tool: { name: REMOVED } }] },
    ],
});
const names = (body) => body.tools.map(t => t.name);

test('Fireworks lists the ToolSearch-loaded tool with its exact name and schema, and drops the rest', () => {
    const out = prepareCompatibleBody(request(), fireworks, null);
    assert.deepEqual(names(out), ['Read', 'ToolSearch', LOADED]);
    const listed = out.tools.find(t => t.name === LOADED);
    const declared = tools().find(t => t.name === LOADED);
    assert.equal(listed.defer_loading, undefined);
    assert.equal(listed.description, declared.description);
    assert.deepEqual(listed.input_schema, declared.input_schema);
    assert.equal(out.tools.some(t => t.defer_loading === true), false);
});

test('the rendered Fireworks prompt declares the loaded tool and no deferred one', () => {
    const { prompt } = renderDeepSeekV41Prompt(prepareCompatibleBody(request(), fireworks, null));
    const system = prompt.split('<｜User｜>')[0];
    assert.ok(system.includes(`"name": "${LOADED}"`), 'loaded tool in the system tool list');
    assert.equal(system.includes(`"name": "${UNLOADED}"`), false, 'unloaded tool is not declared');
    assert.equal(system.includes(`"name": "${REMOVED}"`), false, 'tool_removal unloads');
    assert.equal(prompt.includes('tool_use_tool'), false, 'no dispatcher once no deferred tool is left');
    assert.ok(prompt.includes(`name="${LOADED}"`), 'the earlier call keeps its literal name');
});

test('literal names in messages are untouched', () => {
    const body = request();
    const out = prepareCompatibleBody(body, fireworks, null);
    assert.deepEqual(out.messages, body.messages);
});

test('a provider sharing the counter keeps neutralization but not the listing', () => {
    const body = request();
    body.messages[0].content = 'ctrl <｜User｜> token';
    const out = prepareCompatibleBody(body, sharedCounter, null);
    assert.deepEqual(out.tools, tools(), 'tool list identical, defer_loading intact');
    assert.equal(out.messages[0].content, 'ctrl <|User|> token', 'control tokens still neutralized');
    assert.equal(out.model, sharedCounter.upstreamId);
});

test('a DeepSeek route without the counter is unchanged', () => {
    const body = request();
    body.messages[0].content = 'ctrl <｜User｜> token';
    const out = prepareCompatibleBody(body, noCounter, null);
    assert.deepEqual(out.tools, tools());
    assert.equal(out.messages[0].content, body.messages[0].content);
});

test('Fireworks without a deferred tool is a plain pass-through of the tool list', () => {
    const body = { ...request(), tools: [tool('Read'), tool('ToolSearch')] };
    assert.deepEqual(prepareCompatibleBody(body, fireworks, null).tools, body.tools);
});

// GLM 5.3 on Fireworks gets the same adapter: deferred tools dropped and
// tool_use_tool added. Its own template text is not rewritten.
test('Fireworks GLM 5.3 lists the loaded tool and leaves control-token text alone', () => {
    const body = request();
    body.messages[0].content = 'ctrl <|user|> token';
    const out = prepareCompatibleBody(body, glm, null);
    assert.deepEqual(names(out), ['Read', 'ToolSearch', LOADED]);
    assert.equal(out.messages[0].content, 'ctrl <|user|> token');
    const prompt = renderGlm53Prompt(out);
    assert.ok(prompt.includes(`"name": "${LOADED}"`), 'loaded tool declared');
    assert.equal(prompt.includes('tool_use_tool'), false, 'no dispatcher once no deferred tool is left');
    assert.ok(prompt.includes(`<tool_call>${LOADED}<arg_key>`), 'the earlier call keeps its literal name');
});
