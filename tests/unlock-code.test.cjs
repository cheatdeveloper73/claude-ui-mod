"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

test("unlock-code plugin syntax and exports", () => {
    const mainPath = path.resolve(__dirname, "../src/plugins/unlock-code/main.js");
    const pagePath = path.resolve(__dirname, "../src/plugins/unlock-code/page.js");
    const rendererPath = path.resolve(__dirname, "../src/plugins/unlock-code/renderer.js");

    assert.ok(fs.existsSync(mainPath), "main.js exists");
    assert.ok(fs.existsSync(pagePath), "page.js exists");
    assert.ok(fs.existsSync(rendererPath), "renderer.js exists");

    const mainFn = require(mainPath);
    assert.equal(typeof mainFn, "function", "main exports a plugin setup function");

    const pageCode = fs.readFileSync(pagePath, "utf8");
    assert.match(pageCode, /claude_code/, "page.js contains claude_code capability patch");
    assert.match(pageCode, /claude_max/, "page.js contains claude_max capability patch");
    assert.match(pageCode, /default_claude_max_20x/, "page.js sets max 20x rate limit tier");
    assert.match(pageCode, /current_account/, "page.js targets current_account queries");

    const rendererCode = fs.readFileSync(rendererPath, "utf8");
    assert.match(rendererCode, /df-discovery-takeover/, "renderer.js targets takeover modal");
    assert.match(rendererCode, /suppressUpsells/, "renderer.js includes upsell suppression");
});

test("session starts work without an optional native preparation plugin", async () => {
    const mainPath = path.resolve(__dirname, "../src/plugins/unlock-code/main.js");
    const key = Symbol.for("cuimod.native.dormant-migration");
    const previous = globalThis[key];
    const cacheKey = path.join(__dirname, "fixture-native-start.cjs");
    const manager = { sessions: new Map(), startSession: async options => options };
    require.cache[cacheKey] = { exports: { claudeCodeSessionManager: manager } };
    const disposers = [];
    try {
        delete globalThis[key];
        require(mainPath)({ dir: path.dirname(mainPath), boot: { MOD_DIR: path.resolve(__dirname, "..") },
            electron: { webContents: { getAllWebContents: () => [] } },
            every() {}, method() {}, onDispose: fn => disposers.push(fn) });
        const options = { cwd: "fixture", message: "hello", model: "claude-opus-5" };
        assert.equal(await manager.startSession(options), options);
        globalThis[key] = { reconcile() {} };
        assert.equal(await manager.startSession(options), options);
        globalThis[key] = { prepareStart: async (owner, input, flags) => {
            assert.equal(owner, manager);
            assert.equal(input, options);
            assert.equal(flags.initiator, "user");
            return { ...input, prepared: true };
        } };
        assert.deepEqual(await manager.startSession(options, { initiator: "user" }), { ...options, prepared: true });
    } finally {
        disposers.reverse().forEach(fn => fn());
        delete require.cache[cacheKey];
        if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    }
});

test("unlock-code clears precomputed model selector upgrade gates", () => {
    const pageCode = fs.readFileSync(path.resolve(__dirname, "../src/plugins/unlock-code/page.js"), "utf8");
    const query = {
        queryKey: ["current_account", "org-test"],
        state: {
            data: {
                account: {
                    memberships: [{ organization: { capabilities: ["chat"], rate_limit_tier: "default_claude_ai" } }],
                },
                model_selector_config: [{
                    id: "ccd",
                    models: [
                        {
                            id: "claude-fable-5-1",
                            name: "Fable 5.1",
                            disabled: true,
                            disabled_reason: { type: "upgrade_required", required_plan: "pro" },
                            selection_notice: { cta: { intent: "upgrade" } },
                            badge: { message: "Pro or Max", variant: "accent" },
                        },
                        {
                            id: "claude-policy-blocked",
                            disabled: true,
                            disabled_reason: { type: "disabled_by_org_admin" },
                            selection_notice: { cta: { intent: "upgrade" } },
                        },
                    ],
                }],
            },
        },
    };
    const listeners = new Set();
    const cache = {
        getAll: () => [query],
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    const client = {
        getQueryCache: () => cache,
        setQueryData(_key, value) {
            query.state.data = value;
            for (const listener of listeners) listener({ query });
        },
    };
    const root = { __reactFiber$test: { memoizedProps: { client }, child: null, sibling: null } };
    const pageWindow = {};

    vm.runInNewContext(pageCode, {
        window: pageWindow,
        document: { querySelector: selector => selector === "#root" ? root : null, body: { firstElementChild: null } },
        setInterval: () => 1,
        clearInterval: () => {},
    });

    const data = query.state.data;
    const fable = data.model_selector_config[0].models[0];
    assert.equal(fable.disabled, false, "upgrade-gated model becomes selectable");
    assert.equal(Object.hasOwn(fable, "disabled_reason"), false, "upgrade disabled reason is removed");
    assert.equal(Object.hasOwn(fable, "selection_notice"), false, "upgrade selection notice is removed");
    assert.equal(fable.badge.message, "Pro or Max", "non-blocking model metadata is preserved");

    const blocked = data.model_selector_config[0].models[1];
    assert.equal(blocked.disabled, true, "non-upgrade disabled models stay disabled");
    assert.equal(blocked.disabled_reason.type, "disabled_by_org_admin");
    assert.ok(data.account.memberships[0].organization.capabilities.includes("claude_max"));
    assert.equal(data.account.memberships[0].organization.rate_limit_tier, "default_claude_max_20x");

    pageWindow.__cuimod_unlock_code_native.dispose();
});

// The dashboard's Enabled switch must stop the account rewrite itself. Before
// this, it stopped only the routed credential and the stylesheet while the page
// script kept being re-injected every sweep.
test("unlock-code stops injecting its page script when switched off", () => {
    const os = require("node:os");
    const mainPath = path.resolve(__dirname, "../src/plugins/unlock-code/main.js");
    const run = (enabled) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuimod-unlock-"));
        fs.mkdirSync(path.join(root, ".state"));
        fs.writeFileSync(path.join(root, ".state", "settings.json"), JSON.stringify({ "unlock-code": { enabled } }));
        const scripts = [];
        const wc = { isDestroyed: () => false, getURL: () => "https://claude.ai/epitaxy",
            executeJavaScript: (source) => { scripts.push(source); return Promise.resolve(); } };
        const dispose = [];
        delete require.cache[mainPath];
        require(mainPath)({ dir: path.dirname(mainPath), boot: { MOD_DIR: root },
            electron: { webContents: { getAllWebContents: () => [wc] } },
            every() {}, method() {}, log() {}, onDispose: fn => dispose.push(fn) });
        dispose.forEach(fn => fn());
        return scripts;
    };
    const page = (scripts) => scripts.some(source => /current_account/.test(source));
    assert.equal(page(run(true)), true, "an enabled plugin injects the page script");
    const off = run(false);
    assert.equal(page(off), false, "a disabled plugin must not inject the page script");
});
