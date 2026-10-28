'use strict';
const path = require('node:path');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const test = require('node:test'), assert = require('node:assert/strict');
const { nativeSurfaces } = require(path.join(PLUGIN_DIR, 'native-surfaces.js'));
test('resolve semantic preview functions through the loaded bundle exports, without private test access', () => {
    const functions = { getPreviewUrlForTab() {}, getNavCommitEpoch() {}, checkToolAccessGate() {}, hasPreviewContext() {}, describeOriginlessPreviewTab() {} };
    const source = 'var namespace=e.r({' + Object.keys(functions).map((key, i) => key + ':()=>local' + i).join(',') + '});'
        + Object.keys(functions).map((_key, i) => 'Object.defineProperty(exports,"a' + i + '",{enumerable:!0,get:function(){return local' + i + '}})').join(',');
    const launch = { loadBrowserPreview() {}, getBrowserPreviewForSession() {} };
    const exported = { manager: launch, ...Object.fromEntries(Object.values(functions).map((value, i) => ['a' + i, value])) };
    const found = nativeSurfaces({ '/app.asar/core.js': { exports: exported } }, () => source);
    assert.equal(found.launch, launch);
    for (const name of Object.keys(functions)) assert.equal(found.preview[name], functions[name]);
    assert.equal(found.preview._test, undefined);
});
test('missing or ambiguous semantic exports fail closed', () => {
    const launch = { loadBrowserPreview() {}, getBrowserPreviewForSession() {} };
    assert.throws(() => nativeSurfaces({ '/app.asar/core.js': { exports: { launch } } }, () => ''), /contracts unavailable/);
});
