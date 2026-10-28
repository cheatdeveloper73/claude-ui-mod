'use strict';

async function originApproval(params, { sessionId, turnId, signal, manager }) {
    const meta = params?._meta, schema = params?.requestedSchema;
    if (params?.mode !== 'form' || meta?.connector_id !== 'browser-use' || meta.tool_name !== 'access_browser_origin'
        || schema?.type !== 'object' || !schema.properties || Object.keys(schema.properties).length) return null;
    let origin;
    try { origin = new URL(meta.origin); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== meta.origin) return null;
    const context = meta['x-codex-turn-metadata'];
    if (context?.session_id !== sessionId || context?.turn_id !== turnId) throw Error('browser approval session/turn mismatch');
    const active = () => { if (signal?.aborted) throw Error('browser approval cancelled'); };
    active();
    // Origin requests inherit the owner's native browser policy, including its
    // bypass mode. Every subsequent command still enters the native dispatcher.
    const handler = manager.permissionBroker.createPreviewOriginPermissionHandler(sessionId);
    const result = await handler(origin.origin, 'Codex browser origin access', signal);
    active();
    return result?.allowed === true ? { action: 'accept', content: {} } : { action: 'decline' };
}
module.exports = { originApproval };
