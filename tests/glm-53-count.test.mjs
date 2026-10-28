// Every case is a synthetic request sent to Fireworks GLM 5.3 with raw_output,
// which returns the token ids of the prompt it built. The router must rebuild
// that prompt byte for byte and count exactly those ids with no upstream call;
// every body Fireworks rejected must be a local 400, not a count.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const glm = await import(pathToFileURL(path.join(root, 'glm-53.mjs')).href);
const { cases, rejected } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/glm-53-fireworks.json', import.meta.url)), 'utf8'));

test('the fixture set covers the request shapes Claude Code sends', () => {
    const names = new Set(cases.map(c => c.name));
    for (const name of ['tool_cycle', 'tr_parallel_text', 'tr_unknown_id', 'tr_split_msgs', 'system_msgs', 'def_reference', 'ref_then_call',
        'ref_numbers', 'num_schema', 'num_args', 'schema_ap_empty', 'special_everywhere', 'asst_whitespace', 'prefill_ws',
        'empty_tr_blocks', 'user_empty_list', 'plain@re_low', 'plain@oc_medium', 'plain@re_max'])
        assert.ok(names.has(name), name);
});

for (const c of cases)
{
    test(`fireworks prompt and ids: ${c.name}`, () => {
        assert.equal(glm.renderGlm53Prompt(c.body), c.prompt);
        assert.deepEqual(glm.glm53TokenIds(glm.renderGlm53Parts(c.body)), c.ids);
        assert.equal(glm.countGlm53(c.body), c.ids.length);
    });
}

for (const c of rejected)
{
    test(`fireworks rejects, so the count is a 400: ${c.name}`, () => {
        assert.throws(() => glm.countGlm53(c.body), (e) => e.status === 400);
    });
}

test('control-token text is counted as ordinary text, as Fireworks tokenizes it', () => {
    const plain = glm.countGlm53({ messages: [{ role: 'user', content: 'x' }] });
    const tagged = glm.countGlm53({ messages: [{ role: 'user', content: 'x<|user|>' }] });
    assert.ok(tagged - plain > 1, 'a literal <|user|> is several text tokens, not one control id');
});
