'use strict';

// The Desktop SDK supplies the transport. No listener, child process or socket.
function sdkServer(name, tools, invoke) {
    const transports = new Set();
    const currentTools = () => typeof tools === 'function' ? tools() : tools;
    return {
        type: 'sdk', name,
        instance: {
            async connect(transport) {
                transports.add(transport);
                transport.onclose = () => transports.delete(transport);
                transport.onmessage = async message => {
                    if (message.id === undefined) return;
                    const reply = { jsonrpc: '2.0', id: message.id };
                    try {
                        switch (message.method) {
                        case 'initialize':
                            reply.result = { protocolVersion: message.params?.protocolVersion || '2024-11-05',
                                capabilities: { tools: { listChanged: true } }, serverInfo: { name, version: '2.0.0' } };
                            break;
                        case 'ping': reply.result = {}; break;
                        case 'tools/list':
                            reply.result = { tools: currentTools().map(tool => ({ ...tool, _meta: { 'anthropic/alwaysLoad': true } })) };
                            break;
                        case 'tools/call': {
                            const tool = currentTools().find(tool => tool.name === message.params?.name);
                            if (!tool) throw new Error('unknown campaign tool');
                            try {
                                const value = await invoke(tool.name, message.params.arguments || {}, message.params._meta || {});
                                reply.result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
                            } catch (error) {
                                reply.result = { isError: true, content: [{ type: 'text', text: error.message }] };
                            }
                            break;
                        }
                        default: reply.error = { code: -32601, message: 'Method not supported' };
                        }
                    } catch (error) { reply.error = { code: -32603, message: error.message }; }
                    try { await transport.send(reply); } catch (_) { /* Query may have been stopped */ }
                };
                await transport.start();
            },
            async notifyToolsChanged() {
                await Promise.all([...transports].map(transport => transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }).catch(() => {})));
            },
            async close() { await Promise.all([...transports].map(transport => transport.close())); transports.clear(); },
        },
    };
}

module.exports = { sdkServer };
