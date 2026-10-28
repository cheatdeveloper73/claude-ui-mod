'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), test = require('node:test'), assert = require('node:assert/strict');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { clipboardBootstrap } = require(path.join(PLUGIN_DIR, 'clipboard-bootstrap.js'));
test('only the installed helper with an owned binding can become a new-document script', () => {
    const file = path.join(os.tmpdir(), 'codex-browser-clipboard-fixture-' + process.pid + '-' + Date.now() + '.txt');
    fs.writeFileSync(file, 'var tee="const __name = (target) => target;",ree=t=>{void t};' + String.raw`function mN(t){return` + '`(() => {\n    ${tee}\n    const installPageClipboardBridge = ${ree.toString()};\n    installPageClipboardBridge(${JSON.stringify(t)});\n  })()`}');
    try {
        const validate = clipboardBootstrap(file), binding = 'clipboard-binding';
        const candidate = '(() => {\n    const __name = (target) => target;\n    const installPageClipboardBridge = t=>{void t};\n    installPageClipboardBridge("clipboard-binding");\n  })()';
        assert.equal(validate(candidate, new Set([binding])), binding);
        assert.equal(validate(candidate, new Set()), null);
        assert.equal(validate(candidate.replace('void t', 'fetch(t)'), new Set([binding])), null);
        assert.equal(validate(candidate + ';fetch("elsewhere")', new Set([binding])), null);
    } finally { fs.unlinkSync(file); }
});
