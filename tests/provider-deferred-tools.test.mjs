// Claude Code's deferred-tool protocol, translated for the Responses API.
// Shapes are Claude Code 2.1.280's own (eZr in the shipped bundle): tool_addition
// and tool_removal ride in mid-conversation system messages, tool_reference in a
// ToolSearch tool_result.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-deferred-'));
process.env.MODEL_ROUTER_SETTINGS_FILE = path.join(temp, 'settings.json');
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { buildResponsesRequest } = await import(pathToFileURL(path.join(root, 'openai.mjs')).href);

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: { q: { type: 'string' } } }, ...extra });
const tools = [
    tool('Read'),
    tool('ToolSearch'),
    tool('DeferredToolPlaceholder', { defer_loading: true }),
    tool('WebSearch', { defer_loading: true }),
    tool('mcp__docs__guide', { defer_loading: true }),
];
const settings = { reasoningEnabled: true, reasoningSummary: 'auto' };
const build = (messages, list = tools) => buildResponsesRequest({ model: 'claude-gpt-5.6-sol', system: 'sys', tools: list, messages }, settings, null).req;
const names = req => (req.tools || []).map(t => t.name);
const additions = req => req.input.filter(i => i.type === 'additional_tools');

const user = { role: 'user', content: 'go' };
const search = { role: 'assistant', content: [{ type: 'tool_use', id: 'call_s', name: 'ToolSearch', input: { query: 'select:WebSearch' } }] };
const found = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_s', content: [{ type: 'tool_reference', tool_name: 'WebSearch' }] }] };
const addDocs = { role: 'system', content: [
    { type: 'text', text: 'The following tools just became available.' },
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__docs__guide' } },
] };

test('deferred tools stay out of the top-level tools that prefix every request', () => {
    const before = build([user]);
    assert.deepEqual(names(before), ['Read', 'ToolSearch']);
    const afterLoad = build([user, search, found, addDocs]);
    assert.deepEqual(afterLoad.tools, before.tools);
    assert.deepEqual(afterLoad.input.slice(0, before.input.length), before.input);
});

test('a ToolSearch tool_reference loads the schema right after its output', () => {
    const input = build([user, search, found]).input;
    const at = input.findIndex(i => i.type === 'function_call_output');
    assert.equal(input[at].output, 'Loaded tool: WebSearch');
    assert.deepEqual(input[at + 1], { type: 'additional_tools', role: 'developer', tools: [{
        type: 'function', name: 'WebSearch', description: 'WebSearch tool', strict: false,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
    }] });
});

test('tool_addition by reference and inline definition load where they appear', () => {
    const inline = { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: tool('mcp__late__run') } }] };
    const input = build([user, addDocs, inline]).input;
    const texts = input.filter(i => i.type === 'message').map(i => i.content[0].text);
    assert.ok(texts.includes('The following tools just became available.'));
    assert.deepEqual(additions({ input }).map(a => a.tools.map(t => t.name)), [['mcp__docs__guide'], ['mcp__late__run']]);
    const docsAt = input.findIndex(i => i.type === 'additional_tools');
    assert.equal(input[docsAt - 1].content[0].text, 'The following tools just became available.');
});

test('a loaded tool is sent once, a removal is announced, and a re-add loads it again', () => {
    const removeDocs = { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__docs__guide' } }] };
    const req = build([user, addDocs, { role: 'user', content: 'again' }, addDocs, removeDocs, addDocs]);
    assert.equal(additions(req).length, 2);
    assert.ok(req.input.some(i => i.type === 'message' && i.role === 'developer'
        && i.content.some(p => p.text === 'Tool no longer available: mcp__docs__guide')));
});

test('a reference to a tool that was never declared loads nothing', () => {
    const ghost = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_s', content: [{ type: 'tool_reference', tool_name: 'Nope' }] }] };
    const req = build([user, search, ghost]);
    assert.equal(additions(req).length, 0);
    assert.equal(req.input.find(i => i.type === 'function_call_output').output, 'Loaded tool: Nope');
});
