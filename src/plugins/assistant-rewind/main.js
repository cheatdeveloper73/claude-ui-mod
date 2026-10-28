'use strict';

const { UUID, resolveTextTarget, rewindAfter } = require('./core');
const page = require('./page');

function findManager() {
    for (const module of Object.values(require.cache)) {
        const manager = module.exports?.claudeCodeSessionManager;
        if (manager?.sessions instanceof Map && typeof manager.rewindSession === 'function') return manager;
    }
    throw Error('Desktop session manager is unavailable.');
}

module.exports = function (ctx) {
    const busy = new Set();
    function visible(event, sessionId) {
        if (!/^local_[0-9a-f-]{36}$/i.test(sessionId || '') || !event?.sender || event.sender.isDestroyed()) {
            throw Error('No local Desktop session on screen.');
        }
        const url = new URL(event.sender.getURL());
        if (url.origin !== 'https://claude.ai' || url.pathname !== '/epitaxy/' + sessionId) {
            throw Error('The visible session changed. Select the reply again.');
        }
    }
    function runPage(event, action, params) {
        return event.sender.executeJavaScript('(' + page.toString() + ')('
            + JSON.stringify(action) + ',' + JSON.stringify(params) + ')', false);
    }
    ctx.method('discover', async (params, event) => {
        visible(event, params?.sessionId);
        return runPage(event, 'discover', { sessionId: params.sessionId });
    });
    ctx.method('prepare', async (params, event) => {
        const sessionId = params?.sessionId;
        visible(event, sessionId);
        const row = await runPage(event, 'describe', { sessionId, index: params.index,
            entryKey: params.entryKey, itemIndex: params.itemIndex, textItemId: params.textItemId });
        const manager = findManager();
        const session = manager.sessions.get(sessionId);
        const cliSessionId = session?.cliSessionId;
        if (!UUID.test(cliSessionId || '')) throw Error('This session has no saved CLI conversation.');
        const messages = await manager.diskTranscript.loadTranscriptFromDisk(session);
        visible(event, sessionId);
        if (session.cliSessionId !== cliSessionId) throw Error('Session changed. Select the reply again.');
        const uuid = resolveTextTarget(messages, row.itemId, row.text);
        if (!uuid) throw Error('This reply has no unambiguous saved assistant checkpoint yet.');
        await runPage(event, 'verify', { sessionId, uuid });
        return { sessionId, cliSessionId, uuid, preview: row.text.slice(0, 400) };
    });
    ctx.method('rewind', async (params, event) => {
        const sessionId = params?.sessionId;
        visible(event, sessionId);
        if (!UUID.test(params?.uuid || '') || !UUID.test(params?.cliSessionId || '')) throw Error('Invalid rewind target.');
        if (busy.has(sessionId)) throw Error('An assistant rewind is already in progress.');
        busy.add(sessionId);
        try {
            await runPage(event, 'verify', params);
            visible(event, sessionId);
            const result = await rewindAfter(findManager(), sessionId, params.uuid, { cliSessionId: params.cliSessionId });
            try {
                const view = await runPage(event, 'apply', { sessionId, uuid: result.assistantUuid,
                    unwoundRefusalFallback: result.unwoundRefusalFallback });
                return { ok: true, ...view };
            } catch (error) {
                return { ok: false, applied: true, error: 'History was rewound, but the view could not update: ' + error.message };
            }
        } finally {
            busy.delete(sessionId);
        }
    });
};
