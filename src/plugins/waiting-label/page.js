/* Runs in the page world. Read the main composer's selected model and mutate
 * nothing. The footer label is cleaned down to a human-sized waiting label. */
(() => {
    const scopes = [];
    for (const node of document.querySelectorAll('.epitaxy-prompt')) {
        let fiber = node[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
        for (let depth = 0; fiber && depth < 170; depth += 1, fiber = fiber.return) {
            const store = fiber.memoizedProps?.scopeStore;
            if (store?.getState && !scopes.includes(store)) scopes.push(store);
        }
    }

    const current = location.pathname.match(/(?:^|\/)(local_[A-Za-z0-9_-]+)/)?.[1] || null;
    const states = scopes.map((store) => {
        try { return store.getState(); } catch (_) { return null; }
    }).filter(Boolean);
    const state = current
        ? states.find((value) => value.sessionRef?.id === current)
        : states.find((value) => value.footer?.modelId);
    const footer = state?.footer || null;
    const model = typeof footer?.modelId === 'string' ? footer.modelId : null;
    const bare = model
        ? model.replace(/^claude-/i, '').replace(/\[[^\]]+\]$/i, '')
            .replace(/:(low|medium|high|xhigh|max)$/i, '')
        : null;
    const native = typeof footer?.modelLabel === 'string' ? footer.modelLabel.trim() : '';
    const clean = (native || bare || '').replace(/\s+\d+(?:\.\d+)?\s*[kmg]$/i, '').trim();
    const named = bare && /^gpt-\d+(?:\.\d+)?-([a-z][a-z0-9-]*)$/i.exec(bare);
    const label = named
        ? named[1].split('-').map((part) => part.replace(/^./, (letter) => letter.toUpperCase())).join(' ')
        : clean || null;
    return { model, label };
})()
