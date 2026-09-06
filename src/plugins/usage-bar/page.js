/* Runs in the page world. The account's live limit windows and the composer's
 * selected model both live in React state the isolated world cannot reach:
 * plan-usage-history.json carries only the five-hour and weekly-all buckets,
 * and a session that has never sent a message has no context usage to name a
 * model with. Read both, mutate nothing. */
(() => {
    const clients = new Set();
    const scopes = [];
    for (const node of document.querySelectorAll('.epitaxy-prompt')) {
        let fiber = node[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
        for (let depth = 0; fiber && depth < 170; depth += 1, fiber = fiber.return) {
            const store = fiber.memoizedProps?.scopeStore;
            if (store?.getState && !scopes.includes(store)) scopes.push(store);
            const seen = new Set();
            for (let dep = fiber.dependencies?.firstContext; dep && !seen.has(dep); dep = dep.next) {
                seen.add(dep);
                const client = dep.memoizedValue;
                if (typeof client?.getQueryCache === 'function') clients.add(client);
            }
        }
    }

    let usage = null;
    for (const client of clients) {
        for (const query of client.getQueryCache().getAll()) {
            const value = query.state.data;
            if (!value || !Array.isArray(value.limits)) continue;
            if (!usage || query.state.dataUpdatedAt > usage.at) usage = { at: query.state.dataUpdatedAt, value };
        }
    }

    const footer = scopes.map((store) => store.getState().footer).find((state) => state && state.modelId);
    const limits = (usage?.value.limits || []).map((row) => ({
        kind: typeof row.kind === 'string' ? row.kind : null,
        group: typeof row.group === 'string' ? row.group : null,
        percent: typeof row.percent === 'number' ? row.percent : null,
        resetsAt: row.resets_at || null,
        model: row.scope?.model?.display_name || null,
        surface: row.scope?.surface?.display_name || null,
    })).filter((row) => row.percent !== null);

    return {
        model: footer?.modelId || null,
        label: typeof footer?.modelLabel === 'string' ? footer.modelLabel : null,
        limits,
        observedAt: usage?.at || null,
    };
})()
