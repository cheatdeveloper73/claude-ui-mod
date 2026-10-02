/* claude-ui-mod :: SendMessage hot unban (main)
 *
 * Desktop removes SendMessage twice. patch.js fixes both for the next app
 * launch; this plugin removes the call-time half from Query objects that are
 * already running, so their CLI processes and in-flight agents survive.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_KEY = Symbol.for('cuimod.sendmessage-unban');
const WRAPPED = Symbol.for('cuimod.sendmessage-unban.wrapped');
const ORIGINAL = Symbol.for('cuimod.sendmessage-unban.original');
const DENY_MARKER = 'cli_native_send_message';

module.exports = function (ctx) {
    const ownerToken = {};
    const state = globalThis[STATE_KEY] || {
        owner: null,
        records: [],
        queries: new WeakSet(),
        manager: null,
        patchedQueries: 0,
        patchedCallbacks: 0,
    };
    globalThis[STATE_KEY] = state;
    state.owner = ownerToken;

    function sessionManager() {
        if (state.manager?.sessions && typeof state.manager.sessions.get === 'function') return state.manager;
        state.manager = null;
        for (const key of Object.keys(require.cache)) {
            let exports;
            try { exports = require.cache[key]?.exports; } catch (_) { continue; }
            const candidate = exports?.claudeCodeSessionManager;
            if (candidate?.sessions && typeof candidate.sessions.get === 'function') {
                state.manager = candidate;
                break;
            }
        }
        return state.manager;
    }

    function isDesktopDeny(fn) {
        return typeof fn === 'function' && String(fn).includes(DENY_MARKER);
    }

    function wrapperFor(original) {
        if (original?.[WRAPPED]) return original;
        const wrapped = async function (...args) {
            const input = args[0];
            if (input?.hook_event_name === 'PreToolUse' && input.tool_name === 'SendMessage') return {};
            return await Reflect.apply(original, this, args);
        };
        Object.defineProperties(wrapped, {
            [WRAPPED]: { value: true },
            [ORIGINAL]: { value: original },
        });
        return wrapped;
    }

    function tracked(target, key, map) {
        return state.records.some(record => record.target === target && record.key === key && !!record.map === !!map);
    }

    function replace(target, key) {
        const original = target?.[key];
        if (!isDesktopDeny(original) || original[WRAPPED]) return false;
        const wrapped = wrapperFor(original);
        target[key] = wrapped;
        state.records.push({ target, key, original, wrapped });
        state.patchedCallbacks++;
        return true;
    }

    function patchHookSet(hooks) {
        let changed = 0;
        for (const group of hooks?.PreToolUse || []) {
            for (let index = 0; index < (group?.hooks?.length || 0); index++) {
                if (replace(group.hooks, index)) changed++;
            }
        }
        return changed;
    }

    function patchQuery(query) {
        if (!query || state.queries.has(query)) return false;
        let changed = patchHookSet(query.hooks);
        let covered = changed > 0;
        if (query.hookCallbacks instanceof Map) {
            for (const [key, fn] of query.hookCallbacks) {
                if (fn?.[WRAPPED]) {
                    covered = true;
                    // A future query receives the wrapper from createBaseHooks,
                    // then copies it into this map. Track that second location so
                    // a real unload restores it too.
                    if (!tracked(query.hookCallbacks, key, true)) {
                        state.records.push({ target: query.hookCallbacks, key,
                            original: fn[ORIGINAL], wrapped: fn, map: true });
                    }
                    continue;
                }
                if (!isDesktopDeny(fn)) continue;
                const wrapped = wrapperFor(fn);
                query.hookCallbacks.set(key, wrapped);
                state.records.push({ target: query.hookCallbacks, key, original: fn, wrapped, map: true });
                state.patchedCallbacks++;
                changed++;
                covered = true;
            }
        }
        // Do not mark a query that has not registered its callbacks yet. The next
        // tick catches it after initialize() populates hooks and hookCallbacks.
        if (covered) {
            state.queries.add(query);
            state.patchedQueries++;
        }
        return changed > 0;
    }

    function patchFactory(manager) {
        const broker = manager?.permissionBroker;
        if (!broker) return false;
        const proto = Object.getPrototypeOf(broker);
        if (!proto || typeof proto.createBaseHooks !== 'function') return false;
        if (proto.createBaseHooks[WRAPPED]) return true;

        const original = proto.createBaseHooks;
        const wrapped = function (...args) {
            const hooks = Reflect.apply(original, this, args);
            patchHookSet(hooks);
            return hooks;
        };
        Object.defineProperty(wrapped, WRAPPED, { value: true });
        proto.createBaseHooks = wrapped;
        state.records.push({ target: proto, key: 'createBaseHooks', original, wrapped });
        return true;
    }

    let lastStatus = '';
    function status() {
        const manager = sessionManager();
        let live = 0;
        if (manager) {
            patchFactory(manager);
            for (const session of manager.sessions.values()) {
                if (!session?.query) continue;
                live++;
                patchQuery(session.query);
            }
        }
        const result = {
            generation: ctx.boot.generation,
            manager: !!manager,
            factory: !!manager?.permissionBroker
                && !!Object.getPrototypeOf(manager.permissionBroker)?.createBaseHooks?.[WRAPPED],
            liveQueries: live,
            patchedQueries: state.patchedQueries,
            patchedCallbacks: state.patchedCallbacks,
        };
        const text = JSON.stringify(result);
        if (text !== lastStatus) {
            lastStatus = text;
            const out = path.join(ctx.boot.MOD_DIR, '.probe', 'sendmessage-hot-unban.json');
            try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)); }
            catch (error) { ctx.log('status write failed: ' + error.message); }
            ctx.log('status ' + text);
        }
        return result;
    }

    ctx.method('status', status);
    status();
    ctx.every(500, status);

    ctx.onDispose(() => {
        // Host reload constructs the replacement before disposing this instance.
        // Its ownership claim keeps these wrappers continuous across that handoff.
        if (state.owner !== ownerToken) return;
        for (let index = state.records.length - 1; index >= 0; index--) {
            const record = state.records[index];
            if (record.map) {
                if (record.target.get(record.key) === record.wrapped) record.target.set(record.key, record.original);
            } else if (record.target[record.key] === record.wrapped) {
                record.target[record.key] = record.original;
            }
        }
        state.records.length = 0;
        state.queries = new WeakSet();
        state.manager = null;
        state.patchedQueries = 0;
        state.patchedCallbacks = 0;
        delete globalThis[STATE_KEY];
    });
};
