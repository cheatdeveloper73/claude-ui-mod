'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const patch = require('../patch');
const ROOT = path.resolve(__dirname, '..');

// 2026-10-21: the asar baked on 2026-09-28 still ran the loader without the
// atime filter from b288ad5, because the sweep stopped at the marker. Every
// read of a stale src file reloaded the host, eight times in ten minutes.
test('a baked loader that differs from src is not current', () => {
    const original = 'require("electron");const c="$eipc_message$_8b0746ac-a196-4039-a1e6-207fdafaa0c8_$_";';
    const prefix = '$eipc_message$_8b0746ac-a196-4039-a1e6-207fdafaa0c8_$_';
    const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload-hook.js'), 'utf8')
        .replace("'__EIPC_PREFIX__'", JSON.stringify(prefix));
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main-hook.js'), 'utf8')
        .replace("'__MOD_DIR__'", JSON.stringify(ROOT))
        .replace("'__EIPC_PREFIX__'", JSON.stringify(prefix));
    const baked = (body) => 'original();\n' + patch.MARKER + '\n' + body;

    assert.equal(patch.payloadCurrent(original + '\n' + patch.MARKER + '\n' + pre, baked(main)), true);
    const stale = main.replace('if (touchedOnly(n)) return;', '');
    assert.notEqual(stale, main);
    assert.equal(patch.payloadCurrent(original + '\n' + patch.MARKER + '\n' + pre, baked(stale)), false);
    assert.equal(patch.payloadCurrent(original + '\n' + patch.MARKER + '\n' + pre + '//', baked(main)), false);
    assert.equal(patch.payloadCurrent(original, 'original();'), false);
});
