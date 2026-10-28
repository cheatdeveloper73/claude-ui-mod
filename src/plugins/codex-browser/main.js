'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { discoverRuntime } = require('./discovery');
const { createRuntime } = require('./runtime-host');
const { connection } = require('./pipe');
const { createBackend } = require('./native-backend');
const { sdkServer } = require('./sdk-server');
const { nativeSurfaces } = require('./native-surfaces');
const { createNativeAdapter } = require('./native-adapter');
const { originApproval } = require('./native-approval');
const { clipboardBootstrap } = require('./clipboard-bootstrap');

const KEY = Symbol.for('cuimod.codex-browser');
const SERVER = 'cua_repl';
const DESKTOP_VERSION = '2.9939.4';
const FILES = ['main.js', 'native-backend.js', 'native-call.js', 'runtime-host.js', 'pipe.js', 'sdk-server.js', 'discovery.js', 'hidden-launch.mjs', 'native-surfaces.js', 'native-adapter.js', 'native-approval.js', 'clipboard-bootstrap.js'];

module.exports = function (ctx) {
    if (!process.versions.electron) return;
    let state = globalThis[KEY];
    const legacy = state && state.sdkProtocol !== 2 ? state : null;
    if (!state || legacy) {
        const previous = legacy ? [...legacy.servers] : [];
        state = globalThis[KEY] = { sdkProtocol: 2, bindings: new Map(), servers: new Map(), schema: null, manager: null,
            serverMeta: new WeakMap(), allServers: new Set(previous.map(([, server]) => server)),
            ownedServers: new WeakSet(previous.map(([, server]) => server)) };
        for (const [sid, server] of previous) state.serverMeta.set(server, { sid, revision: null });
    }
    const owner = {};
    state.owner = owner;
    if (legacy) {
        legacy.api = null; legacy.owner = owner;
        if (legacy.manager && legacy.manager.buildStartSdkOptions === legacy.installedBuild) legacy.manager.buildStartSdkOptions = legacy.originalBuild;
        void legacy.schema?.host.close();
        for (const binding of legacy.bindings.values()) void disposeBinding(binding);
        legacy.bindings.clear();
        for (const server of legacy.servers.values()) void server.instance.close().catch(() => {});
        legacy.servers.clear();
    }
    const revision = createHash('sha256').update(FILES.map(file => fs.readFileSync(path.join(ctx.dir, file))).join('\n')).digest('hex');
    const stateDir = path.join(ctx.boot.MOD_DIR, '.state', 'codex-browser');
    const disposers = new Set();
    let disposed = false;
    const manager = () => require('../desktop-mcp-bridge/desktop-adapter').discover();
    const supported = () => ctx.electron.app.getVersion() === DESKTOP_VERSION;
    function status() {
        return { supported: supported(), desktopVersion: ctx.electron.app.getVersion(), revision,
            installed: !!discoverRuntime(), sessions: [...state.bindings].map(([sessionId, binding]) => ({ sessionId,
                busy: binding.busy, runtime: binding.host?.status().state || 'starting', revision: binding.revision })) };
    }
    function save() {
        try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify(status(), null, 2)); }
        catch (_) { ctx.log('could not persist browser status'); }
    }
    function nativeSession(sid) {
        if (!supported()) throw Error('native browser adapter is not verified for this Desktop build; use original browser tools');
        const m = manager(), session = m.sessions.get(sid);
        if (!session || session.isArchived || session.sshConfig || session.wslConfig || session.backend?.remoteTarget)
            throw Error('Codex browser requires an existing local Desktop session');
        const context = m.mcpCoordinator.buildInternalServerContext(sid, {
            ...m.buildInternalServerOptions(sid), sessionCwd: session.cwd, model: session.model,
        }, () => undefined);
        const definition = m.mcpCoordinator.internalManager.resolvedServers?.find(server => server.serverName === 'Claude Browser');
        if (!definition?.isEnabled(context)) throw Error('native browser is disabled or unavailable for this session');
        return { m, session, context, definition };
    }
    async function tools() {
        if (!supported()) throw Error('Codex browser adapter is not verified for this Desktop build');
        const runtime = discoverRuntime();
        if (!runtime) throw Error('install or update Codex Desktop to supply its official browser runtime');
        if (state.schema?.fingerprint !== runtime.fingerprint) {
            const fingerprint = runtime.fingerprint;
            const probe = createRuntime({ runtime, pipePath: '\\\\.\\pipe\\claude-codex-schema-' + randomUUID(),
                sessionId: randomUUID(), logDir: path.join(stateDir, 'schema') });
            const schema = { fingerprint, host: probe };
            state.schema = schema;
            schema.promise = (async () => {
                try { return await probe.start(); } finally { await probe.close(); }
            })().catch(error => { if (state.schema === schema) state.schema = null; throw error; });
            disposers.add(() => probe.close());
        }
        return state.schema.promise;
    }
    async function disposeBinding(binding) {
        if (binding.closing) return binding.closing;
        binding.closing = (async () => {
            binding.closed = true;
            for (const controller of binding.calls.values()) controller.abort();
            if (binding.backend) await binding.backend.close();
            for (const peer of binding.peers) peer.close();
            for (const dispose of binding.disposers) { try { dispose(); } catch (_) {} }
            if (binding.host) await binding.host.close();
            if (binding.server) await new Promise(resolve => binding.server.close(resolve));
            if (state.bindings.get(binding.sid) === binding) state.bindings.delete(binding.sid);
        })();
        return binding.closing;
    }
    async function bindingFor(sid) {
        const current = nativeSession(sid);
        let binding = state.bindings.get(sid);
        if (binding?.closed) { await disposeBinding(binding); binding = null; }
        if (binding && (binding.revision !== revision || binding.query !== current.session.query)) {
            if (binding.busy) throw Error('previous browser runtime is draining; no action was replayed');
            await disposeBinding(binding); binding = null;
        }
        if (binding) { await binding.ready; return binding; }
        const runtime = discoverRuntime();
        if (!runtime) throw Error('official Codex browser runtime is not installed');
        binding = { sid, revision, query: current.session.query, busy: 0, calls: new Map(), peers: new Set(), disposers: [], closed: false,
            accountId: current.m.currentAccountId, orgId: current.m.currentOrgId };
        state.bindings.set(sid, binding);
        const validate = () => {
            const now = nativeSession(sid);
            if (binding.closed || now.session.query !== binding.query || now.m.currentAccountId !== binding.accountId || now.m.currentOrgId !== binding.orgId)
                throw Error('native browser session/account changed');
        };
        const invoke = async (name, input) => {
            validate();
            const now = nativeSession(sid), refusal = now.m.mcpCoordinator.toolCheck(sid)?.('local:Claude Browser:' + name);
            if (refusal !== undefined) throw Error(refusal);
            return now.definition.handleToolCall(name, input, now.context);
        };
        binding.ready = (async () => {
            const adapter = createNativeAdapter({ ...nativeSurfaces(), sessionId: sid, cwd: current.session.cwd,
                invoke, electron: ctx.electron, onDispose: fn => binding.disposers.push(fn) });
            let scriptValidator;
            binding.backend = createBackend({ sessionId: sid, codexSessionId: sid, preview: adapter.preview,
                invoke: adapter.invoke, validate, createBlank: adapter.createBlank, captureScreenshot: adapter.captureScreenshot,
                allowScript: (source, bindings) => (scriptValidator ||= clipboardBootstrap(path.join(runtime.nodeModules,
                    '@oai', 'browser-desktop', 'scripts', 'browser-service.mjs')))(source, bindings),
                onDispose: fn => binding.disposers.push(fn) });
            const pipePath = '\\\\.\\pipe\\claude-codex-browser-' + randomUUID();
            binding.server = net.createServer(socket => {
                let peer;
                peer = connection(socket, (name, params, request) => {
                    const active = binding.clientRequest;
                    if (name !== 'ping' && (!active || active.turnId !== params.turn_id || active.signal.aborted)) throw Error('browser call is no longer active');
                    return binding.backend.invoke(name, params, { ...request, signal: active ? AbortSignal.any([active.signal, request.signal]) : request.signal });
                });
                binding.peers.add(peer);
                socket.once('close', () => binding.peers.delete(peer));
            });
            binding.backend.setNotify((name, params) => { for (const peer of binding.peers) peer.notify(name, params); });
            await new Promise((resolve, reject) => { binding.server.once('error', reject); binding.server.listen(pipePath, resolve); });
            binding.host = createRuntime({ runtime, pipePath, sessionId: sid, logDir: path.join(stateDir, sid),
                onCancel: ({ turnId }) => { if (binding.clientRequest?.turnId === turnId) binding.clientRequest.controller.abort(); },
                onElicitation: async params => {
                    validate();
                    const request = binding.clientRequest;
                    if (!request || request.signal.aborted) throw Error('browser call is no longer active');
                    const native = await originApproval(params, { sessionId: sid, turnId: request.turnId,
                        signal: request.signal, manager: nativeSession(sid).m });
                    validate();
                    if (native) return native;
                    if (typeof request.createElicitation !== 'function') throw Error('unsupported browser approval form');
                    return request.createElicitation(params, { signal: request.signal });
                } });
            await binding.host.start();
            save();
        })().catch(async error => { await disposeBinding(binding); throw error; });
        await binding.ready;
        return binding;
    }
    async function call(sid, name, args, options) {
        const binding = await bindingFor(sid), controller = new AbortController();
        const abort = () => controller.abort();
        if (options.signal?.aborted) controller.abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        binding.busy++;
        binding.calls.set(options.turnId, controller);
        const previous = binding.tail || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const request = { createElicitation: options.createElicitation, controller, signal: controller.signal,
                turnId: binding.turnId ||= randomUUID() };
            binding.clientRequest = request;
            try { return await binding.host.call(name, args, { ...options, turnId: request.turnId, signal: controller.signal }); }
            finally { if (binding.clientRequest === request) binding.clientRequest = null; }
        });
        binding.tail = operation;
        try { return await operation; }
        finally {
            controller.abort();
            binding.busy--; binding.calls.delete(options.turnId);
            options.signal?.removeEventListener('abort', abort);
        }
    }
    function serverFor(sid, fresh = false) {
        const m = manager(), previous = state.servers.get(sid), meta = previous && state.serverMeta.get(previous);
        if (fresh || !meta || meta.revision !== revision || meta.accountId !== m.currentAccountId || meta.orgId !== m.currentOrgId) {
            const server = sdkServer({
                tools: () => { if (!state.api) throw Error('Codex browser plugin unavailable'); return state.api.tools(); },
                call: (name, args, options) => {
                    if (!state.api) throw Error('Codex browser plugin unavailable');
                    return state.api.callFromServer(server, sid, name, args, options);
                },
            });
            state.serverMeta.set(server, { sid, revision, accountId: m.currentAccountId, orgId: m.currentOrgId });
            state.servers.set(sid, server); state.allServers.add(server); state.ownedServers.add(server);
        }
        return state.servers.get(sid);
    }
    async function callFromServer(server, sid, name, args, options) {
        const { m, session } = nativeSession(sid), meta = state.serverMeta.get(server);
        if (!meta || session.activeMcpServers?.[SERVER] !== server || m.currentAccountId !== meta.accountId || m.currentOrgId !== meta.orgId
            || meta.query && meta.query !== session.query) throw Error('stale or inactive Codex browser connection');
        meta.query = session.query;
        return call(sid, name, args, options);
    }
    function configure(sid, result) {
        if (!supported() || !discoverRuntime()) return result;
        let current;
        try { current = nativeSession(sid); } catch (_) { return result; }
        if (result.allMcpServers?.[SERVER] && !state.ownedServers.has(result.allMcpServers[SERVER])) return result;
        const isolated = !current.session.backend.cliRunsAsThisUser() || current.m.startedThroughHostCliLauncher(current.session, current.session.query);
        const server = serverFor(sid, true), sealed = current.m.mcpCoordinator.sealForSdk(sid, isolated, { [SERVER]: server });
        result.sdkOptions = { ...result.sdkOptions, mcpServers: { ...(result.sdkOptions?.mcpServers || {}), [SERVER]: sealed[SERVER] } };
        result.allMcpServers = { ...(result.allMcpServers || {}), [SERVER]: server };
        return result;
    }
    state.api = { tools, invoke: call, callFromServer, status, configure };
    function attach() {
        if (disposed || !supported()) return;
        let m;
        try { m = manager(); } catch (_) { return; }
        if (state.manager !== m) {
            if (state.manager && state.manager.buildStartSdkOptions === state.installedBuild) state.manager.buildStartSdkOptions = state.originalBuild;
            const originalBuild = m.buildStartSdkOptions;
            state.manager = m; state.originalBuild = originalBuild;
            state.installedBuild = async function (...args) {
                const result = await Reflect.apply(originalBuild, this, args);
                return state.api ? state.api.configure(args[0].sessionId, result) : result;
            };
            m.buildStartSdkOptions = state.installedBuild;
        } else if (m.buildStartSdkOptions === state.originalBuild) m.buildStartSdkOptions = state.installedBuild;
        for (const [sid, session] of m.sessions) {
            if (!session.query || !session.activeMcpServers || session._cuimodCodexAttaching) continue;
            const existing = session.activeMcpServers[SERVER];
            if (existing && !state.ownedServers.has(existing)) continue;
            if (session.cliLastTurnMessageWasResult !== true || m.hasAgentRunInProgress(sid)) continue;
            if (session.activeBackgroundTasks instanceof Map && session.activeBackgroundTasks.size
                || Array.isArray(session.activeBackgroundTasks) && session.activeBackgroundTasks.some(task => !['completed', 'failed', 'killed'].includes(task.status))) continue;
            if (session.query.sdkMcpServers instanceof Map && [...session.query.sdkMcpServers.keys()].some(name => !session.activeMcpServers[name])) continue;
            if (session.hostRequestsInFlight?.size || typeof session.hostRequestsInFlight === 'number' && session.hostRequestsInFlight > 0) continue;
            try { nativeSession(sid); } catch (_) { continue; }
            const server = serverFor(sid);
            if (existing === server || state.bindings.get(sid)?.busy) continue;
            session._cuimodCodexAttaching = true;
            const query = session.query, before = session.activeMcpServers, servers = { ...before, [SERVER]: server };
            const seal = map => m.mcpCoordinator.sealForSdk(sid, !session.backend.cliRunsAsThisUser() || m.startedThroughHostCliLauncher(session, query), map);
            Promise.resolve().then(async () => {
                // Query.setMcpServers keeps an existing SDK instance by name.
                // Remove only our idle server before replacing its transport.
                if (existing) {
                    const without = { ...before }; delete without[SERVER];
                    await query.setMcpServers(seal(without));
                    if (session.query !== query || session.activeMcpServers !== before) throw Error('native MCP map changed during replacement');
                }
                await query.setMcpServers(seal(servers));
                // The native map records the acknowledged configuration. CLI
                // connection status can still be pending when that ack arrives.
                if (session.query === query && session.activeMcpServers === before) {
                    session.activeMcpServers = servers;
                    if (existing) { void existing.instance.close().catch(() => {}); state.allServers.delete(existing); }
                }
            }).then(() => query.mcpServerStatus())
                .then(statuses => {
                    const status = statuses.find(server => server.name === SERVER)?.status;
                    if (status !== 'connected' && status !== 'pending') throw Error('Codex browser tools did not connect');
                })
                .catch(() => ctx.log('could not attach browser tools to idle session'))
                .finally(() => { delete session._cuimodCodexAttaching; });
        }
        for (const server of state.allServers) {
            const sid = state.serverMeta.get(server)?.sid, session = m.sessions.get(sid);
            if (session && !session.isArchived) continue;
            if (state.servers.get(sid) === server) state.servers.delete(sid);
            state.allServers.delete(server);
            void server.instance.close().catch(() => {});
        }
        for (const [sid, binding] of state.bindings) {
            const session = m.sessions.get(sid);
            if (!session || session.isArchived || session.query !== binding.query || m.currentAccountId !== binding.accountId || m.currentOrgId !== binding.orgId)
                void disposeBinding(binding);
            else if (!binding.busy && !session.isRunning && binding.turnId && !binding.ending) {
                const turnId = binding.turnId, controller = new AbortController();
                binding.turnId = null; binding.ending = true; binding.busy++; binding.calls.set(turnId, controller);
                const ending = (binding.tail || Promise.resolve()).catch(() => {}).then(async () => {
                    const request = { turnId, controller, signal: controller.signal };
                    binding.clientRequest = request;
                    try { await binding.host.call('turn_ended', { hook_event_name: 'Stop', session_id: sid, turn_id: turnId }, { turnId, signal: controller.signal }); }
                    finally { if (binding.clientRequest === request) binding.clientRequest = null; }
                }).catch(() => {}).finally(() => { controller.abort(); binding.calls.delete(turnId); binding.busy--; binding.ending = false; });
                binding.tail = ending;
            }
        }
    }
    ctx.method('status', status);
    attach(); ctx.every(1000, attach); save();
    ctx.onDispose(() => {
        disposed = true;
        if (state.owner !== owner) return;
        state.api = null;
        if (state.manager && state.manager.buildStartSdkOptions === state.installedBuild) state.manager.buildStartSdkOptions = state.originalBuild;
        void state.schema?.host.close();
        for (const server of state.allServers) void server.instance.close().catch(() => {});
        state.servers.clear(); state.allServers.clear();
        for (const dispose of disposers) void dispose();
        for (const binding of state.bindings.values()) void disposeBinding(binding);
    });
};
module.exports.nativeSurfaces = nativeSurfaces;
