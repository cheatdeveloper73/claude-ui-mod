// Every case is a synthetic request sent to Fireworks with raw_output, which
// returns the prompt it built and its token ids. The router must rebuild that
// prompt byte for byte and count exactly that many ids, images included, with
// no upstream call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const ds = await import(pathToFileURL(path.join(root, 'deepseek-v41.mjs')).href);
const { imageDimensions } = await import(pathToFileURL(path.join(root, 'count-tokens.mjs')).href);
const { cases } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/deepseek-v41-fireworks.json', import.meta.url)), 'utf8'));

// Fireworks writes an image span as START, rows of IMAGE cells each closed by
// NEWLINE, then END; the text tokenizer emits one placeholder per image.
const [START, CELL, ROW, END] = [129280, 129281, 129282, 129283];
function expandImages(ids, images)
{
    const out = [];
    let next = 0;
    for (const id of ids)
    {
        if (id !== ds.IMAGE_TOKEN_ID) { out.push(id); continue; }
        const { width, height } = imageDimensions(Buffer.from(images[next++].data, 'base64'));
        const grid = ds.deepSeekV41ImageGrid(width, height);
        out.push(START);
        for (let r = 0; r < grid.rows; r++) { for (let c = 0; c < grid.columns; c++) out.push(CELL); out.push(ROW); }
        out.push(END);
    }
    return out;
}

test('the fixture set covers the request shapes Claude Code sends', () => {
    const names = new Set(cases.map(c => c.name));
    for (const name of ['tool_cycle', 'tr_parallel_text', 'system_msgs', 'def_reference', 'ref_then_call', 'schema_ap_empty',
        'ap_empty_with_anyof', 'err_image', 'two_images', 'img_5000x40', 'img_jpeg_1280x720', 'multi_turn_nothink', 'prefill'])
        assert.ok(names.has(name), name);
});

for (const c of cases)
{
    test(`fireworks prompt and ids: ${c.name}`, () => {
        const { prompt, images } = ds.renderDeepSeekV41Prompt(c.body);
        assert.equal(prompt, c.prompt);
        assert.deepEqual(expandImages(Array.from(ds.deepSeekV41TokenIds(prompt)), images), c.ids);
        assert.equal(ds.countDeepSeekV41(c.body), c.ids.length);
    });
}

test('a block Fireworks rejects is rejected as a 400, not counted', () => {
    const body = { system: 'sys', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }] }] };
    assert.throws(() => ds.countDeepSeekV41(body), (e) => e.status === 400);
});

test('image grids follow image_processor.py at the cap and the pixel floor', () => {
    // 1x1 is scaled up to the 295936 px floor: 546 px, a 13x13 grid.
    assert.equal(ds.deepSeekV41ImageTokens(1, 1), 13 * 14 + 2);
    // 1568 px is past the 1024-token cap and is solved down to 31x31.
    assert.equal(ds.deepSeekV41ImageTokens(1568, 1568), 31 * 32 + 2);
});

test('no DeepSeek control token survives as text in a request body', () => {
    const vocab = JSON.parse(fs.readFileSync(ds.TOKENIZER_FILE, 'utf8')).added_tokens.filter(t => t.content.includes('｜'));
    assert.ok(vocab.length > 800);
    const controlIds = (text) => {
        const body = ds.neutralizeDeepSeekV41Text({ system: text, messages: [
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text }] }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: { q: text } }] }] });
        const { prompt } = ds.renderDeepSeekV41Prompt({ ...body, reasoning_effort: 'none' });
        return Array.from(ds.deepSeekV41TokenIds(prompt)).filter(id => id >= 128000).join(',');
    };
    // The renderer's own control tokens are the only ones, exactly as for plain text.
    const baseline = controlIds('plain');
    for (const { content } of vocab) assert.equal(controlIds(content), baseline, content);
});

// Claude Code 2.1.280's deferred-tool shapes: ToolSearch tool_reference,
// tool_addition / tool_removal in system messages, a never-called placeholder.
const deferredTool = (name, extra = {}) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: { q: { type: 'string' } } }, ...extra });
const deferredTools = [
    deferredTool('Read'),
    deferredTool('ToolSearch'),
    deferredTool('DeferredToolPlaceholder', { defer_loading: true }),
    deferredTool('TaskCreate', { defer_loading: true }),
    deferredTool('mcp__docs__guide', { defer_loading: true }),
];
const searched = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_s', name: 'ToolSearch', input: { query: 'select:TaskCreate' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_s', content: [{ type: 'tool_reference', tool_name: 'TaskCreate' }] }] },
];
const toolTurn = (body) => ds.renderDeepSeekV41Prompt(body).prompt.split('<｜User｜>')[0];

test('a tool ToolSearch loaded is in the tool list DeepSeek writes invoke names from', () => {
    const body = { system: 'sys', tools: deferredTools, messages: searched };
    // Fireworks' own handling: hidden from the list, reachable only through tool_use_tool.
    assert.ok(!toolTurn(body).includes('"name": "TaskCreate"'));
    assert.ok(toolTurn(body).includes('"name": "tool_use_tool"'));
    const listed = ds.listLoadedDeepSeekV41Tools(body);
    assert.deepEqual(listed.tools.map(t => t.name), ['Read', 'ToolSearch', 'TaskCreate']);
    assert.ok(listed.tools.every(t => t.defer_loading === undefined));
    assert.ok(toolTurn(listed).includes('"name": "TaskCreate"'));
    assert.ok(!toolTurn(listed).includes('tool_use_tool'));
    assert.ok(!toolTurn(listed).includes('DeferredToolPlaceholder'));
});

test('tool_addition lists a tool by name or inline definition and tool_removal unlists it', () => {
    const add = (tool) => ({ role: 'system', content: [{ type: 'tool_addition', tool }] });
    const remove = { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__docs__guide' } }] };
    const inline = { type: 'tool_definition', definition: deferredTool('mcp__late__run', { defer_loading: true }) };
    const names = (messages) => ds.listLoadedDeepSeekV41Tools({ tools: deferredTools, messages }).tools.map(t => t.name);
    assert.deepEqual(names([add({ type: 'tool_reference', name: 'mcp__docs__guide' }), add(inline)]),
        ['Read', 'ToolSearch', 'mcp__docs__guide', 'mcp__late__run']);
    assert.deepEqual(names([add({ type: 'tool_reference', name: 'mcp__docs__guide' }), remove]), ['Read', 'ToolSearch']);
    assert.deepEqual(names([add({ type: 'tool_reference', name: 'Read' })]), ['Read', 'ToolSearch']);
});

test('a request with no deferred tool passes through untouched', () => {
    const body = { tools: [deferredTool('Read')], messages: searched };
    assert.equal(ds.listLoadedDeepSeekV41Tools(body), body);
});

test('image data and thinking signatures are not rewritten', () => {
    const body = ds.neutralizeDeepSeekV41Text({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '<｜User｜>', signature: '<｜User｜>' }] }] });
    assert.equal(body.messages[0].content[0].thinking, '<|User|>');
    assert.equal(body.messages[0].content[0].signature, '<｜User｜>');
});
