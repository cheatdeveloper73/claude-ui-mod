'use strict';

// Page-world code: fiber expandos and the native transcript store are invisible
// in preload's isolated world. Keep this function self-contained for execution.
module.exports = async function assistantRewindPage(action, params) {
    const current = location.pathname.split('/').filter(Boolean).at(-1);
    if (action !== 'apply' && current !== params.sessionId) throw Error('The visible session changed.');
    function textItem(node) {
        const key = Object.keys(node).find(name => name.startsWith('__reactFiber$'));
        let fiber = key ? node[key] : null;
        for (let depth = 0; fiber && depth < 48; depth++, fiber = fiber.return) {
            const props = fiber.memoizedProps;
            if (!props?.item) continue;
            if (props.item.kind !== 'text' && props.item.kind !== 'thinking') return null;
            return { itemId: props.item.id, kind: props.item.kind,
                text: props.item.text, sessionRef: props.sessionRef };
        }
        return null;
    }
    if (action === 'discover') {
        const tagged = new Set();
        for (const node of document.querySelectorAll('[data-cds="Prose"]')) {
            const row = node.closest('[data-testid="transcript-row"]');
            if (row?.getAttribute('data-perf-row') !== 'assistant') continue;
            const item = textItem(node);
            if (!item || item.sessionRef?.type !== 'local' || item.sessionRef.id !== params.sessionId) continue;
            // Keep the control outside Markdown's own children and its
            // first/last-child spacing rules. This is the text component's div.
            const anchor = node.parentElement;
            if (!anchor || textItem(anchor)?.itemId !== item.itemId) continue;
            if (anchor.getAttribute('data-cuimod-rewind-text') !== item.itemId) anchor.setAttribute('data-cuimod-rewind-text', item.itemId);
            tagged.add(anchor);
        }
        for (const row of document.querySelectorAll('[data-testid="transcript-row"][data-perf-row="assistant_thinking"]')) {
            const anchor = [...row.querySelectorAll('*')]
                .find(node => node.classList?.contains('group/thinking') && textItem(node)?.kind === 'thinking');
            const item = anchor && textItem(anchor);
            if (!item || item.sessionRef?.type !== 'local' || item.sessionRef.id !== params.sessionId) continue;
            if (anchor.getAttribute('data-cuimod-rewind-text') !== item.itemId) anchor.setAttribute('data-cuimod-rewind-text', item.itemId);
            tagged.add(anchor);
        }
        for (const node of document.querySelectorAll('[data-cuimod-rewind-text]')) {
            if (!tagged.has(node)) node.removeAttribute('data-cuimod-rewind-text');
        }
        return { tagged: tagged.size };
    }
    if (action === 'describe') {
        if (!Number.isSafeInteger(params.index) || params.index < 0) throw Error('Invalid transcript row.');
        const row = document.querySelector('[data-testid="transcript-row"][data-index="' + params.index + '"]');
        const kind = row?.getAttribute('data-perf-row');
        if (!['assistant_text', 'assistant', 'assistant_thinking'].includes(kind)) {
            throw Error('This assistant row moved. Select it again.');
        }
        const anchor = row.querySelector('[data-epitaxy-entry]');
        if (params.entryKey !== undefined && (anchor?.getAttribute('data-epitaxy-entry') !== params.entryKey
            || anchor?.getAttribute('data-epitaxy-item-index') !== params.itemIndex)) {
            throw Error('This assistant row moved. Select it again.');
        }
        if (kind !== 'assistant_text' && !params.textItemId) throw Error('This status update moved. Select it again.');
        const nodes = kind === 'assistant_text' ? row.querySelectorAll('*')
            : [...(row.getAttribute('data-cuimod-rewind-text') ? [row] : []),
                ...row.querySelectorAll('[data-cuimod-rewind-text]')];
        for (const node of nodes) {
            if (kind !== 'assistant_text' && node.getAttribute('data-cuimod-rewind-text') !== params.textItemId) continue;
            const item = textItem(node);
            if (!item || (params.textItemId && item.itemId !== params.textItemId)) continue;
            if (item.sessionRef?.type !== 'local' || item.sessionRef.id !== params.sessionId) {
                throw Error('Assistant rewind is available for local Desktop sessions only.');
            }
            return { itemId: item.itemId, text: item.text };
        }
        throw Error('This Desktop frontend has an unsupported assistant row.');
    }
    // This is the transcript store of the bundled index-Cuw5J4F9 release.
    // Validate its shape and the session/UUID before changing native history.
    const [module, review, shared, panes] = await Promise.all([
        import('https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c06cf64bb-DagteQMi.js'),
        import('https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/ca80fca8d-BP9S5wB3.js'),
        import('https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-0-CIbzJMAO.js'),
        import('https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c5da7eb42-BvmVoK40.js'),
    ]);
    const store = Object.values(module).find(value => typeof value?.getState === 'function'
        && typeof value.getState().truncateAfterMessage === 'function' && value.getState().buckets);
    const state = store?.getState();
    const messages = state?.buckets[params.sessionId]?.messages?.getSnapshot();
    if (!messages?.some(message => message.type === 'assistant' && message.uuid === params.uuid && !message.parent_tool_use_id)) {
        throw Error('The assistant checkpoint is no longer in the displayed transcript.');
    }
    if (typeof review.jo?.clearReviewFindings !== 'function'
        || typeof shared.ed?.getState?.().clearSession !== 'function' || typeof panes.mn !== 'function') {
        throw Error('This Desktop frontend has an unsupported rewind cleanup path.');
    }
    if (action === 'verify') return true;
    if (action !== 'apply') throw Error('Unknown assistant rewind page action.');
    state.truncateAfterMessage(params.sessionId, params.uuid);
    if (params.unwoundRefusalFallback) store.getState().resolveRefusalFallback(params.sessionId);
    // Match the native rewind consumer: discarded messages must not leave their
    // review findings, tracked diffs or cached pane state in the current view.
    review.jo.clearReviewFindings(params.sessionId, false);
    shared.ed.getState().clearSession(params.sessionId);
    panes.mn(params.sessionId);
    const kept = store.getState().buckets[params.sessionId].messages.getSnapshot();
    const last = kept.filter(message => message.type === 'assistant' || message.type === 'user').at(-1);
    if (last?.uuid !== params.uuid) throw Error('The displayed transcript did not keep the selected checkpoint.');
    return { kept: params.uuid, messages: kept.length };
};
