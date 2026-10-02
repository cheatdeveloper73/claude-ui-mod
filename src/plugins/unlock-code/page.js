/* Runs in page world: intercepts React Query cache updates for current_account */
"use strict";
(function () {
    var KEY = "__cuimod_unlock_code_native";
    var old = window[KEY];
    if (old && typeof old.dispose === "function") {
        try { old.dispose(); } catch (_) {}
    }
    var REQUIRED_CAPS = [
        "chat",
        "claude_pro",
        "claude_max",
        "raven",
        "claude_code",
        "claude_code_desktop"
    ];
    var RATE_LIMIT_TIER = "default_claude_max_20x";

    var queryClients = new Set();
    var unsubscribers = [];
    var disposed = false;

    function unlockUpgradeModels(configs) {
        if (!Array.isArray(configs)) return { changed: false, configs: configs };
        var changed = false;
        var nextConfigs = configs.map(function (section) {
            if (!section || !Array.isArray(section.models)) return section;
            var sectionChanged = false;
            var nextModels = section.models.map(function (model) {
                if (!model) return model;
                var reasonUpgrade = model.disabled_reason && model.disabled_reason.type === "upgrade_required";
                var noticeUpgrade = model.selection_notice && model.selection_notice.cta && model.selection_notice.cta.intent === "upgrade";
                if (model.disabled_reason && !reasonUpgrade) return model;
                if (!reasonUpgrade && !noticeUpgrade) return model;
                sectionChanged = true;
                changed = true;
                var next = Object.assign({}, model, { disabled: false });
                if (reasonUpgrade) delete next.disabled_reason;
                if (noticeUpgrade) delete next.selection_notice;
                return next;
            });
            return sectionChanged ? Object.assign({}, section, { models: nextModels }) : section;
        });
        return { changed: changed, configs: nextConfigs };
    }

    function patchCache(client) {
        if (!client || typeof client.getQueryCache !== "function") return false;
        var cache = client.getQueryCache();
        var accountQueries = cache.getAll().filter(function (q) {
            return Array.isArray(q.queryKey) && q.queryKey[0] === "current_account";
        });
        var anyPatched = false;
        for (var i = 0; i < accountQueries.length; i++) {
            var q = accountQueries[i];
            var data = q.state.data;
            if (!data || !data.account || !Array.isArray(data.account.memberships)) continue;
            var membershipChanged = false;
            var newMemberships = data.account.memberships.map(function (m) {
                if (!m || !m.organization) return m;
                var existing = new Set(m.organization.capabilities || []);
                var added = false;
                for (var j = 0; j < REQUIRED_CAPS.length; j++) {
                    var cap = REQUIRED_CAPS[j];
                    if (!existing.has(cap)) {
                        existing.add(cap);
                        added = true;
                    }
                }
                var tierChanged = m.organization.rate_limit_tier !== RATE_LIMIT_TIER;
                if (added || tierChanged) {
                    membershipChanged = true;
                    var nextOrg = Object.assign({}, m.organization, {
                        capabilities: Array.from(existing),
                        rate_limit_tier: RATE_LIMIT_TIER,
                    });
                    return Object.assign({}, m, { organization: nextOrg });
                }
                return m;
            });
            var selector = unlockUpgradeModels(data.model_selector_config);
            if (membershipChanged || selector.changed) {
                var nextData = data;
                if (membershipChanged) {
                    nextData = Object.assign({}, nextData, {
                        account: Object.assign({}, data.account, { memberships: newMemberships }),
                    });
                }
                if (selector.changed) nextData = Object.assign({}, nextData, { model_selector_config: selector.configs });
                client.setQueryData(q.queryKey, nextData);
                anyPatched = true;
            }
        }
        return anyPatched;
    }

    function findQueryClient() {
        var rootEl = document.querySelector("#root") || document.querySelector(".cds-root") || document.body.firstElementChild;
        if (!rootEl) return null;
        var key = Object.keys(rootEl).find(function (k) {
            return k.startsWith("__reactFiber") || k.startsWith("__reactContainer");
        });
        if (!key) return null;
        var node = rootEl[key];
        var queue = [node];
        var visited = new Set();
        while (queue.length > 0 && queue.length < 3000) {
            var curr = queue.shift();
            if (!curr || visited.has(curr)) continue;
            visited.add(curr);
            if (curr.memoizedProps && curr.memoizedProps.client && typeof curr.memoizedProps.client.getQueryCache === "function") {
                return curr.memoizedProps.client;
            }
            if (curr.child) queue.push(curr.child);
            if (curr.sibling) queue.push(curr.sibling);
        }
        return null;
    }

    function trackClient(client) {
        if (!client || queryClients.has(client)) return;
        queryClients.add(client);
        patchCache(client);
        try {
            var unsub = client.getQueryCache().subscribe(function (event) {
                if (disposed) return;
                if (event && event.query && Array.isArray(event.query.queryKey) && event.query.queryKey[0] === "current_account") {
                    patchCache(client);
                }
            });
            unsubscribers.push(unsub);
        } catch (_) {}
    }

    var initial = findQueryClient();
    if (initial) trackClient(initial);

    var timer = setInterval(function () {
        if (disposed) return;
        var c = findQueryClient();
        if (c) trackClient(c);
        queryClients.forEach(function (cl) { patchCache(cl); });
    }, 2000);

    window[KEY] = {
        patch: function () {
            var c = findQueryClient();
            if (c) trackClient(c);
            var any = false;
            queryClients.forEach(function (cl) {
                if (patchCache(cl)) any = true;
            });
            return any;
        },
        dispose: function () {
            disposed = true;
            clearInterval(timer);
            for (var i = 0; i < unsubscribers.length; i++) {
                try { unsubscribers[i](); } catch (_) {}
            }
            queryClients.clear();
            unsubscribers.length = 0;
            delete window[KEY];
        }
    };
})();
