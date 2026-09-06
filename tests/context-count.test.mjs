import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOpenAIInput, imageTokens, imageDimensions } from '../router/count-tokens.mjs';
import { buildResponsesRequest } from '../router/openai.mjs';

const payload = text => ({ model: 'gpt-5.6-sol', instructions: '', input: [{ role: 'user', content: [{ type: 'input_text', text }] }] });

test('GPT preflight uses token boundaries rather than one count per four characters', async () => {
    const repeated = await estimateOpenAIInput(payload(' a'.repeat(1000)));
    assert.ok(repeated > 1000 && repeated < 1100, '1000 separate one-token words plus envelope');
    const cjk = await estimateOpenAIInput(payload('你好世界'.repeat(100)));
    assert.ok(cjk > 100, 'non-Latin input cannot be approximated by JS string length / 4');
    assert.ok(await estimateOpenAIInput(payload('<|endoftext|> literal source code')) > 0);
});

test('GPT counts translated tools and instructions, excluding discarded client identity', async () => {
    const body = { model: 'claude-gpt-5.6-sol[1m]', messages: [{ role: 'user', content: 'test' }] };
    const count = async b => estimateOpenAIInput(buildResponsesRequest(b).req);
    const basic = await count(body);
    assert.equal(await count({ ...body, system: [{ type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }] }), basic);
    assert.ok(await count({ ...body, system: 'Keep this important instruction.', tools: [{ name: 'read_file', description: 'Read a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] }) > basic);
});

test('screenshots use documented patch sizing rather than their base64 string length', async () => {
    assert.equal(imageTokens(1024, 1024, 'gpt-5.4', 'high'), 1229);
    assert.equal(imageTokens(2048, 2048, 'gpt-5.4', 'high'), 3000);
    assert.equal(imageTokens(2048, 2048, 'gpt-5.6-sol', 'auto'), 4916);
    assert.equal(imageTokens(2048, 2048, 'gpt-5.6-sol', 'low'), 308);
    const png = Buffer.alloc(24);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
    png.writeUInt32BE(1024, 16);png.writeUInt32BE(1024, 20);
    assert.deepEqual(imageDimensions(png), { width: 1024, height: 1024 });
    const make = bytes => ({ ...payload(''), input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + bytes.toString('base64') }] }] });
    assert.equal(await estimateOpenAIInput(make(png)), await estimateOpenAIInput(make(Buffer.concat([png, Buffer.alloc(200000)]))));
    assert.throws(() => imageDimensions(Buffer.from([255,216,255,224,0,0])));
});

test('opaque reasoning ciphertext is never counted as visible prompt text', async () => {
    const make = text => ({ ...payload(''), input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: text, summary: [] }] });
    assert.equal(await estimateOpenAIInput(make('short')), await estimateOpenAIInput(make(' a'.repeat(100000))));
});
