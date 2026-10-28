'use strict';
const { randomUUID } = require('node:crypto');

const MAX_ACTIVE_CALLS = 32;
const MAX_PENDING_ELICITATIONS = 1;
const FORM_ELICITATION_ERROR = 'the calling SDK client does not support form elicitation';

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function sdkServer({ tools, call }) {
    const connections = new Set();
    return { type: 'sdk', name: 'cua_repl', instance: {
        async connect(transport) {
            const pending = new Map();
            const serverPending = new Map();
            const connection = { transport, pending, serverPending, clientCapabilities: null, closed: false };
            connections.add(connection);

            function removeSignalListeners(entry) {
                for (const [signal, listener] of entry.listeners) signal.removeEventListener('abort', listener);
                entry.listeners = [];
            }

            function rejectServerRequest(id, error, { notify = false } = {}) {
                const entry = serverPending.get(id);
                if (!entry) return false;
                serverPending.delete(id);
                removeSignalListeners(entry);
                if (notify && entry.sent && !entry.cancelSent && !connection.closed) {
                    entry.cancelSent = true;
                    void Promise.resolve(transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled',
                        params: { requestId: id } })).catch(() => {});
                }
                entry.reject(error);
                return true;
            }

            function supportsFormElicitation() {
                const capability = connection.clientCapabilities?.elicitation;
                return !!capability && typeof capability === 'object' && !Array.isArray(capability)
                    && (Object.prototype.hasOwnProperty.call(capability, 'form') || Object.keys(capability).length === 0);
            }

            function createElicitation(params, callSignal, extraSignal) {
                if (connection.closed) return Promise.reject(Error('the SDK transport is closed'));
                if (!supportsFormElicitation()) return Promise.reject(Error(FORM_ELICITATION_ERROR));
                if (callSignal?.aborted || extraSignal?.aborted) return Promise.reject(Error('elicitation request cancelled'));
                if (serverPending.size >= MAX_PENDING_ELICITATIONS)
                    return Promise.reject(Error('another browser approval is pending'));

                let id;
                do id = `elicitation-${randomUUID()}`; while (serverPending.has(id));
                return new Promise((resolve, reject) => {
                    const entry = { resolve, reject, listeners: [], sent: false, cancelSent: false };
                    const abort = () => rejectServerRequest(id, Error('elicitation request cancelled'), { notify: true });
                    const signals = new Set([callSignal, extraSignal].filter(signal => signal
                        && typeof signal.addEventListener === 'function'));
                    for (const signal of signals) {
                        signal.addEventListener('abort', abort, { once: true });
                        entry.listeners.push([signal, abort]);
                    }
                    serverPending.set(id, entry);
                    if (connection.closed || [...signals].some(signal => signal.aborted)) {
                        abort(); return;
                    }
                    entry.sent = true;
                    let sending;
                    try {
                        sending = transport.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
                    } catch (error) {
                        rejectServerRequest(id, error); return;
                    }
                    Promise.resolve(sending).catch(error => rejectServerRequest(id, error));
                });
            }

            transport.onclose = () => {
                if (connection.closed) return;
                connection.closed = true;
                for (const controller of pending.values()) controller.abort();
                for (const [id, entry] of [...serverPending]) {
                    serverPending.delete(id);
                    removeSignalListeners(entry);
                    entry.reject(Error('the SDK transport closed'));
                }
                connections.delete(connection);
            };
            transport.onmessage = async message => {
                if (connection.closed) return;
                if (message.method === 'notifications/cancelled') {
                    pending.get(message.params?.requestId)?.abort();
                    rejectServerRequest(message.params?.requestId, Error('elicitation request cancelled by client'));
                    return;
                }
                if (typeof message.method !== 'string') {
                    const entry = serverPending.get(message.id);
                    if (!entry) return;
                    serverPending.delete(message.id);
                    removeSignalListeners(entry);
                    if (message.error !== undefined) {
                        entry.reject(Error(errorMessage(message.error?.message || 'elicitation request failed')));
                    } else if (!message.result || !['accept', 'decline', 'cancel'].includes(message.result.action)) {
                        entry.reject(Error('invalid native elicitation response'));
                    } else {
                        entry.resolve(message.result);
                    }
                    return;
                }
                if (message.id === undefined) return;
                const reply = { jsonrpc: '2.0', id: message.id };
                try {
                    if (message.method === 'initialize') {
                        connection.clientCapabilities = message.params?.capabilities;
                        reply.result = { protocolVersion: message.params?.protocolVersion || '2025-06-18',
                            capabilities: { tools: { listChanged: true } },
                            serverInfo: { name: 'cua_repl', version: '1.0.0' },
                            instructions: 'The official Codex cua_repl tools here control Claude Desktop\'s existing built-in browser pane, tabs and profile. '
                                + 'Prefer cua_repl js for browser workflows: batch actions, observations and branches inside one call using the returned official API documentation. '
                                + 'Original Claude Browser tools remain available for preview servers and unsupported operations. Native browser policy remains authoritative. '
                                + 'An uncertain action must not be replayed automatically.' };
                    } else if (message.method === 'ping') reply.result = {};
                    else if (message.method === 'tools/list') reply.result = { tools: (await tools())
                        .filter(tool => tool.name === 'js' || tool.name === 'js_reset')
                        .map(tool => ({ ...tool, _meta: { ...tool._meta, 'anthropic/alwaysLoad': true } })) };
                    else if (message.method === 'tools/call') {
                        const name = message.params?.name;
                        if (name !== 'js' && name !== 'js_reset') throw Error('unsupported Codex browser tool');
                        if (pending.has(message.id) || serverPending.has(message.id)) throw Error('duplicate pending request id');
                        if (pending.size >= MAX_ACTIVE_CALLS) throw Error('too many active browser tool requests');
                        const controller = new AbortController(); pending.set(message.id, controller);
                        const meta = message.params?._meta || {};
                        const turnId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : randomUUID();
                        try {
                            reply.result = await call(name, message.params.arguments || {}, {
                                turnId, signal: controller.signal,
                                createElicitation: (params, extra = {}) => createElicitation(params, controller.signal, extra.signal),
                            });
                        } finally {
                            pending.delete(message.id);
                        }
                    } else reply.error = { code: -32601, message: 'Method not supported' };
                } catch (error) {
                    if (message.method === 'tools/call') reply.result = { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
                    else reply.error = { code: -32603, message: errorMessage(error) };
                }
                try { await transport.send(reply); } catch (_) { /* The native query may have closed. */ }
            };
            await transport.start();
        },
        async notifyToolsChanged() {
            await Promise.all([...connections].map(({ transport }) => transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }).catch(() => {})));
        },
        async close() {
            for (const { pending, transport } of [...connections]) {
                for (const controller of pending.values()) controller.abort();
                await transport.close();
            }
            connections.clear();
        },
    } };
}

module.exports = { sdkServer };
