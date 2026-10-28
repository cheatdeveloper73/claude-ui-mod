'use strict';
const path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict');
const PLUGIN_DIR = path.resolve(__dirname, '..', '..', 'src', 'plugins', 'codex-browser');
const { originApproval } = require(path.join(PLUGIN_DIR, 'native-approval.js'));
function fixture(allowed = true) {
    const calls = [], controller = new AbortController();
    const params = { mode: 'form', message: 'Allow Browser use to access http://127.0.0.1:62241?',
        requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'browser-use',
            tool_name: 'access_browser_origin', origin: 'http://127.0.0.1:62241',
            'x-codex-turn-metadata': { session_id: 's', turn_id: 't' } } };
    const native = { permissionBroker: { createPreviewOriginPermissionHandler: sid => async (...args) => { calls.push([sid, ...args]); return { allowed, always: false }; } } };
    const invoke = () => originApproval(params, { sessionId: 's', turnId: 't', signal: controller.signal, manager: native });
    return { params, calls, controller, native, invoke };
}
test('origin access uses the real native browser policy without another Codex prompt', async () => {
    const f = fixture(); assert.deepEqual(await f.invoke(), { action: 'accept', content: {} });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 's'); assert.equal(f.calls[0][1], 'http://127.0.0.1:62241');
    assert.equal(f.calls[0][3], f.controller.signal);
});
test('native denial remains a denial', async () => { const f = fixture(false); assert.deepEqual(await f.invoke(), { action: 'decline' }); });
test('foreign sessions and turns do not reach the native policy', async () => {
    for (const field of ['session_id', 'turn_id']) { const f = fixture(); f.params._meta['x-codex-turn-metadata'][field] = 'foreign';
        await assert.rejects(f.invoke(), /session|turn/); assert.equal(f.calls.length, 0); }
});
test('only empty origin-access forms are mapped to native browser policy', async () => {
    for (const change of [p => { p.mode = 'url'; }, p => { p._meta.tool_name = 'upload_files'; },
        p => { p.requestedSchema.properties.password = { type: 'string' }; }, p => { p._meta.origin += '/private'; }]) {
        const f = fixture(); change(f.params); assert.equal(await f.invoke(), null); assert.equal(f.calls.length, 0);
    }
});
test('cancelled requests do not obtain a late approval', async () => {
    const f = fixture(); f.controller.abort(); await assert.rejects(f.invoke(), /cancel/); assert.equal(f.calls.length, 0);
    const g = fixture(); g.native.permissionBroker.createPreviewOriginPermissionHandler = () => async () => { g.controller.abort(); return { allowed: true }; };
    await assert.rejects(g.invoke(), /cancel/);
});
