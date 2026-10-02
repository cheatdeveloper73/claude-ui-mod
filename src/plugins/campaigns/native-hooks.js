'use strict';

// Desktop 1.46388.4 / CLI 2.1.260: a repeated initialize replaces SDK-host
// hooks and reports hooks_applied. It retires in-flight callbacks, so registration
// must happen at an idle boundary. MCP replacement must carry the complete map.
const DEFAULT_EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'];
const COMPACT_EVENTS = ['PreCompact', 'PostCompact'];
const RELAY_EVENTS = ['PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop'];
const EVENTS = new Set([...DEFAULT_EVENTS, ...COMPACT_EVENTS, ...RELAY_EVENTS, 'PostToolUseFailure', 'SessionStart']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function eventName(name) {
    if (EVENTS.has(name)) return name;
    throw new RangeError('native-hooks: unknown hook event "' + name + '"');
}
function addHooks(options, hooks) {
    if (!object(hooks)) throw new TypeError('addHooks: hooks must be an object of event -> matcher entries');
    const source = object(options) ? options : {};
    const merged = { ...(source.hooks || {}) };
    for (const [event, value] of Object.entries(hooks)) {
        if (!EVENTS.has(event)) throw new TypeError('addHooks: ' + event + ' is not a hook event');
        const entries = (Array.isArray(value) ? value : [value]).map(entry => {
            if (typeof entry === 'function') return { matcher: '', hooks: [entry] };
            if (!object(entry)) throw new TypeError('addHooks: each matcher must be a function or {matcher, hooks:[fn]}');
            const functions = typeof entry.hooks === 'function' ? [entry.hooks] : entry.hooks;
            if (!Array.isArray(functions) || !functions.every(fn => typeof fn === 'function')) throw new TypeError('invalid hook callbacks');
            return { ...entry, matcher: entry.matcher || '', hooks: functions };
        });
        merged[event] = [...(merged[event] || []), ...entries];
    }
    return { ...source, hooks: merged };
}
function serversOf(session) { return { ...(session?.activeMcpServers || {}) }; }

async function installQuery({ query, hooks, servers, isIdle, failClosed } = {}) {
    const fail = (error, extra = {}) => {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof failClosed === 'function') failClosed(message);
        return { ok: false, error: message, ...extra };
    };
    if (!query || typeof query.reinitialize !== 'function') return fail('installQuery: query.reinitialize() is unavailable');
    if (typeof isIdle !== 'function') return fail('installQuery: isIdle must be a function the parent controls');
    if (!isIdle()) return fail('installQuery: query is not idle; hooks can only be registered between turns', { pending: true });
    const hooksBefore = query.hooks, payloadBefore = query.initHooksPayload;
    try {
        if (object(servers)) {
            if (typeof query.setMcpServers !== 'function') return fail('installQuery: query.setMcpServers() is unavailable');
            if (query.sdkMcpServers instanceof Map) {
                for (const name of query.sdkMcpServers.keys()) if (!servers[name]) return fail('installQuery: full MCP server map is required; missing ' + name);
            }
            await query.setMcpServers(servers);
            if (!isIdle()) return fail('installQuery: a new turn started before hook registration', { pending: true });
        }
        query.hooks = addHooks({ hooks: query.hooks }, hooks).hooks;
        query.initHooksPayload = undefined;
        const result = await query.reinitialize();
        if (result?.hooks_applied !== true) throw Error('installQuery: reinitialize did not apply hooks (hooks_applied !== true)');
        return { ok: true, hooks_applied: true, restored: false };
    } catch (error) {
        query.hooks = hooksBefore; query.initHooksPayload = payloadBefore;
        // This restores local preparation. A lost response is not proof of the
        // CLI's state; the campaign remains unstarted until a confirmed retry.
        return fail(error, { restored: true });
    }
}
function toolUseIdOf(message) {
    const value = message?.params?._meta?.['claudecode/toolUseId'];
    return typeof value === 'string' && value ? value : null;
}
function agentIdOf(input) { return typeof input?.agent_id === 'string' && input.agent_id ? input.agent_id : null; }

module.exports = { DEFAULT_EVENTS, COMPACT_EVENTS, RELAY_EVENTS, addHooks, serversOf, installQuery, eventName, toolUseIdOf, agentIdOf };
