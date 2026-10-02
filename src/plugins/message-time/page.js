/* Runs in the page world; only the identity marker is written here. */
(() => {
    const rows = [];
    for (const node of document.querySelectorAll('time[data-cds="RelativeTime"]')) {
        if (!node.closest('[data-testid="transcript-row"]')) continue;
        const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
        let fiber = key ? node[key] : null;
        let uuid = null;
        for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
            const entry = fiber.memoizedProps?.entry;
            if (entry?.author !== 'assistant') continue;
            if (typeof entry.lastAssistantUuid === 'string') uuid = entry.lastAssistantUuid;
            break;
        }
        if (!uuid) {
            if (node.hasAttribute('data-cuimod-msg')) node.removeAttribute('data-cuimod-msg');
            continue;
        }
        if (node.getAttribute('data-cuimod-msg') !== uuid) node.setAttribute('data-cuimod-msg', uuid);
        rows.push({ uuid, nativeIso: node.getAttribute('datetime') });
    }
    return rows;
})()
