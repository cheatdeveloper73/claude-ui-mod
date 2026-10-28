'use strict';

const MAX_FRAME = 16 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function frame(value, max = MAX_FRAME) {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.length > max) throw Error('backend frame exceeds size limit');
    const output = Buffer.allocUnsafe(bytes.length + 4);
    output.writeUInt32LE(bytes.length, 0);
    bytes.copy(output, 4);
    return output;
}

class Decoder {
    constructor(max = MAX_FRAME) { this.max = max; this.buffer = Buffer.alloc(0); }
    push(bytes) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
        const values = [];
        while (this.buffer.length >= 4) {
            const size = this.buffer.readUInt32LE(0);
            if (!size || size > this.max) throw Error('invalid backend frame length');
            if (this.buffer.length < size + 4) break;
            values.push(JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')));
            this.buffer = this.buffer.subarray(size + 4);
        }
        return values;
    }
}

function connection(socket, invoke, { maxPending = 64 } = {}) {
    const decoder = new Decoder(), active = new Set();
    let closed = false;
    function send(value) {
        if (closed || socket.destroyed) return;
        try { socket.write(frame(value)); } catch (_) { close(); }
    }
    function close() {
        if (closed) return;
        closed = true;
        for (const controller of active) controller.abort();
        active.clear();
        socket.removeListener('data', data);
        socket.removeListener('error', close);
        socket.removeListener('close', close);
        socket.destroy();
    }
    async function dispatch(message) {
        if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            send({ jsonrpc: '2.0', id: object(message) ? message.id ?? null : null,
                error: { code: -32600, message: 'invalid backend request' } });
            return;
        }
        const hasId = Object.hasOwn(message, 'id');
        const params = message.params ?? {};
        if (!object(params) || (hasId && !['number', 'string'].includes(typeof message.id))) {
            if (hasId) send({ jsonrpc: '2.0', id: message.id ?? null,
                error: { code: -32602, message: 'invalid backend request parameters' } });
            return;
        }
        if (active.size >= maxPending) {
            if (hasId) send({ jsonrpc: '2.0', id: message.id,
                error: { code: -32000, message: 'backend request capacity reached' } });
            return;
        }
        const controller = new AbortController();
        active.add(controller);
        try {
            const result = await invoke(message.method, params, { signal: controller.signal });
            if (hasId && !controller.signal.aborted)
                send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
        } catch (error) {
            if (hasId && !controller.signal.aborted)
                send({ jsonrpc: '2.0', id: message.id,
                    error: { code: -32000, message: String(error?.message || 'backend operation failed') } });
        } finally { active.delete(controller); }
    }
    function data(bytes) {
        try { for (const value of decoder.push(bytes)) void dispatch(value); }
        catch (_) { close(); }
    }
    socket.on('data', data);
    socket.on('error', close);
    socket.on('close', close);
    return { close, notify: (method, params) => send({ jsonrpc: '2.0', method, params }) };
}

module.exports = { frame, Decoder, connection };
