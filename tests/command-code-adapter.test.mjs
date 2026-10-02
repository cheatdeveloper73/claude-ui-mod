import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The picker offers the Command Code rows from the shipped catalogue, and the
// shipped adapter is the only arm that can serve them. A row it does not claim
// would fall through and be answered as Claude under its own label.
test('the Command Code adapter claims every Command Code row the picker offers', async () => {
    process.env.MODEL_ROUTER_SECRETS_FILE = path.join(os.tmpdir(), 'cuimod-no-such-secrets.json');
    delete process.env.COMMAND_CODE_API_KEY;
    const { default: createAdapter } = await import('../router/adapters/command-code/index.mjs');
    const adapter = createAdapter({ log() {} });
    const catalogue = JSON.parse(fs.readFileSync(new URL('../src/plugins/provider-picker/catalogue.json', import.meta.url), 'utf8'));
    const rows = catalogue.filter(row => row.provider === 'command-code');
    assert.ok(rows.length, 'the shipped catalogue offers no Command Code rows');
    for (const row of rows) {
        assert.equal(adapter.claims(row.id), true, row.id);
        assert.equal(adapter.claims(`claude-${row.id}[1m]`), true, `${row.id} under its picker alias`);
    }
    for (const other of ['gpt-6.1-sol', 'claude-opus-5', 'muse-spark-1.3'])
        assert.equal(adapter.claims(other), false, other);
    assert.equal(adapter.health().keyOk, false, 'no key configured must read as not ready, not throw');
});

// fetch quotes the whole Authorization header when a key holds a control
// character, so such a key must never be sent.
test('a Command Code key with whitespace or control characters is treated as absent', async () => {
    process.env.MODEL_ROUTER_SECRETS_FILE = path.join(os.tmpdir(), 'cuimod-no-such-secrets.json');
    const { default: createAdapter } = await import('../router/adapters/command-code/index.mjs');
    const adapter = createAdapter({ log() {} });
    try {
        // The environment cannot carry a NUL (Windows truncates there); the
        // secrets file can, and is checked below.
        for (const bad of ['cc-key\ninjected', 'cc key', ''])
        {
            process.env.COMMAND_CODE_API_KEY = bad;
            assert.equal(adapter.health().keyOk, false, JSON.stringify(bad));
        }
        process.env.COMMAND_CODE_API_KEY = '  cc-live-shaped-key  ';
        assert.equal(adapter.health().keyOk, true, 'surrounding whitespace is trimmed, not fatal');
    } finally { delete process.env.COMMAND_CODE_API_KEY; }

    const secrets = path.join(os.tmpdir(), `cuimod-cc-nul-${process.pid}.json`);
    fs.writeFileSync(secrets, JSON.stringify({ 'command-code': 'cc-key\u0000tail' }));
    process.env.MODEL_ROUTER_SECRETS_FILE = secrets;
    try {
        const { default: fresh } = await import('../router/adapters/command-code/index.mjs?nul');
        assert.equal(fresh({ log() {} }).health().keyOk, false, 'a NUL in the secrets file');
    } finally { fs.rmSync(secrets, { force: true }); }
});
