'use strict';

const { randomUUID } = require('crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAssistant(message) {
    return message?.type === 'assistant' && !message.parent_tool_use_id
        && !message.isSidechain && !message.isApiErrorMessage && UUID.test(message.uuid || '');
}

function blockText(block) {
    if (block?.type === 'text') return block.text;
    if (block?.type === 'thinking') return block.thinking;
    return null;
}

function resolveTextTarget(messages, itemId, text) {
    const match = /^(.*)-(?:t|th)\d+$/.exec(itemId || '');
    if (!match || typeof text !== 'string' || !text.trim()) return null;
    const candidates = messages.filter(message => isAssistant(message)
        && message.message?.id === match[1]
        && Array.isArray(message.message.content)
        && message.message.content.some(block => blockText(block) === text));
    const uuids = [...new Set(candidates.map(message => message.uuid))];
    return uuids.length === 1 ? uuids[0] : null;
}

function insertBoundary(messages, checkpoint, uuid) {
    const index = messages.findIndex(message => message.uuid === checkpoint);
    if (index < 0) throw Error('Assistant checkpoint is no longer in the transcript.');
    if (messages.some(message => message.uuid === uuid)) throw Error('Rewind boundary UUID collision.');
    // Desktop 2.9939.4 accepts a user target and keeps its assistant parent.
    // This entry exists only in this invocation's read results. Inserting it
    // adjacent to the checkpoint preserves native dead-branch/refusal checks;
    // appending it would incorrectly make a dead branch the active chain.
    const boundary = { type: 'user', uuid, parentUuid: checkpoint,
        message: { role: 'user', content: 'Continue from this assistant reply.' } };
    return [...messages.slice(0, index + 1), boundary, ...messages.slice(index + 1)];
}

async function rewindAfter(manager, sessionId, checkpoint, options = {}) {
    if (!UUID.test(checkpoint || '')) throw Error('Invalid assistant checkpoint.');
    const session = manager.sessions.get(sessionId);
    if (!session?.cliSessionId || session.cliSessionId !== options.cliSessionId) {
        throw Error('Session changed. Select the reply again.');
    }
    const native = manager.rewindSession;
    const source = Function.prototype.toString.call(native);
    for (const marker of ['loadTranscriptFromDisk', 'loadRawChainEntries', 'pendingRewindTo',
        'pendingCutKeepsEveryMessage', 'stopSession', 'emitSessionUpdated']) {
        if (!source.includes(marker)) throw Error('This Desktop build has an unsupported rewind implementation.');
    }
    const cliSessionId = session.cliSessionId;
    const sendsSeen = session.sendsSeen;
    const previousRewind = session.pendingRewindTo;
    function unchanged() {
        if (manager.sessions.get(sessionId) !== session || session.cliSessionId !== cliSessionId
            || session.sendsSeen !== sendsSeen || session.pendingRewindTo !== previousRewind) {
            throw Error('Session changed. Select the reply again.');
        }
    }
    const messages = await manager.diskTranscript.loadTranscriptFromDisk(session);
    const chain = await manager.diskTranscript.loadRawChainEntries(session);
    unchanged();
    const selected = messages.find(message => message.uuid === checkpoint);
    const raw = chain.find(message => message.uuid === checkpoint);
    if (!isAssistant(selected) || !isAssistant(raw)
        || !selected.message?.content?.some(block => blockText(block)?.trim())) {
        throw Error('This reply is not a persisted main-session assistant checkpoint.');
    }
    const uuid = (options.mintId || randomUUID)();
    const transcript = insertBoundary(messages, checkpoint, uuid);
    // If no later chain entry has a timestamp, native crash pruning falls back
    // to the target's transcript timestamp. The virtual raw entry stays untimed
    // so a real first-dropped entry still supplies that cutoff when available.
    transcript.find(message => message.uuid === uuid).timestamp = selected.timestamp;
    const entries = insertBoundary(chain, checkpoint, uuid);
    // Bind all ordinary methods back to their real owner. Only this call sees
    // the virtual read boundary; no manager method, file or live buffer changes.
    const disk = new Proxy(manager.diskTranscript, { get(target, key) {
        if (key === 'loadTranscriptFromDisk') return async current => {
            unchanged();
            if (current !== session) throw Error('Unexpected rewind session.');
            return transcript;
        };
        if (key === 'loadRawChainEntries') return async current => {
            unchanged();
            if (current !== session) throw Error('Unexpected rewind session.');
            return entries;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const scoped = new Proxy(manager, { get(target, key) {
        if (key === 'diskTranscript') return disk;
        if (key === 'stopSession') return (...args) => {
            unchanged();
            return target.stopSession(...args);
        };
        if (key === 'emitSessionUpdated') return current => {
            // The native undo marker is retained, with no invented composer
            // text. Sanitize before broadcasting the marker to the frontend.
            if (current === session && current.pendingRewind?.forkPoint === checkpoint) {
                current.pendingRewind.prefill = '';
            }
            return target.emitSessionUpdated(current);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await native.call(scoped, sessionId, uuid);
    if (!result || result.assistantUuid !== checkpoint) throw Error('Desktop refused this assistant rewind point.');
    return { ...result, prefill: '' };
}

module.exports = { UUID, isAssistant, resolveTextTarget, insertBoundary, rewindAfter };
