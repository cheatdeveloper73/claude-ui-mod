import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

export const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function clientFrame(payload, opcode)
{
    const size = payload.length;
    const prefix = size < 126 ? 2 : size < 65536 ? 4 : 10;
    const frame = Buffer.allocUnsafe(prefix + 4 + size);
    frame[0] = 128 | opcode;
    if (prefix === 2) frame[1] = 128 | size;
    else if (prefix === 4) { frame[1] = 128 | 126; frame.writeUInt16BE(size, 2); }
    else { frame[1] = 128 | 127; frame.writeBigUInt64BE(BigInt(size), 2); }
    const mask = crypto.randomBytes(4);
    mask.copy(frame, prefix);
    for (let i = 0; i < size; i++) frame[prefix + 4 + i] = payload[i] ^ mask[i % 4];
    return frame;
}

// No extensions are offered: RSV bits are therefore errors, not compressed JSON.
// Node's WebSocket hides upgrade rejection status and the socket's abort/unref
// lifecycle. Both are required to preserve Retry-After and reclaim canceled turns.
class SocketConnection
{
    constructor(socket, head, headers)
    {
        this.socket = socket;
        this.headers = headers;
        this.dead = false;
        this.onmessage = null;
        this.onerror = null;
        this.buffer = head;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmenting = false;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        socket.pause();
        socket.on('data', data => {
            try {
                this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
                this.parse();
            } catch (_) { this.destroy(new Error('invalid upstream WebSocket frame')); }
        });
        socket.on('error', () => this.destroy(new Error('upstream WebSocket socket error')));
        socket.on('end', () => this.destroy(new Error('upstream WebSocket ended')));
        socket.on('close', () => this.destroy(new Error('upstream WebSocket closed without close frame')));
    }

    start()
    {
        try { this.parse(); }
        catch (_) { this.destroy(new Error('invalid upstream WebSocket frame')); }
        if (!this.dead) this.socket.resume();
    }

    parse()
    {
        while (!this.dead && this.buffer.length >= 2)
        {
            const b = this.buffer;
            const fin = !!(b[0] & 128);
            const opcode = b[0] & 15;
            if ((b[0] & 112) || (b[1] & 128) || ![0, 1, 8, 9, 10].includes(opcode)) throw new Error('unsupported frame');
            let length = b[1] & 127;
            let offset = 2;
            if (length === 126)
            {
                if (b.length < 4) return;
                length = b.readUInt16BE(2);
                offset = 4;
                if (length < 126) throw new Error('noncanonical length');
            }
            else if (length === 127)
            {
                if (b.length < 10) return;
                const large = b.readBigUInt64BE(2);
                if (large < 65536n || large > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) throw new Error('invalid length');
                length = Number(large);
                offset = 10;
            }
            const control = opcode >= 8;
            if (control && (!fin || length > 125)) throw new Error('invalid control frame');
            if (length > MAX_WEBSOCKET_MESSAGE_BYTES || (!control && this.fragmentBytes + length > MAX_WEBSOCKET_MESSAGE_BYTES)) throw new Error('message too large');
            if (b.length < offset + length) return;
            const payload = b.subarray(offset, offset + length);
            this.buffer = b.subarray(offset + length);
            if (opcode === 9) { this.socket.write(clientFrame(payload, 10)); continue; }
            if (opcode === 10) continue;
            if (opcode === 8)
            {
                if (length === 1) throw new Error('invalid close');
                let code = 1005;
                let reason = '';
                if (length >= 2)
                {
                    code = payload.readUInt16BE(0);
                    if (!(code >= 3000 && code <= 4999) && ![1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code)) throw new Error('invalid close code');
                    reason = utf8(payload.subarray(2));
                }
                this.dead = true;
                this.buffer = Buffer.alloc(0);
                this.fragments = [];
                this.socket.end(clientFrame(payload, 8));
                const timer = setTimeout(() => this.socket.destroy(), 1000);
                timer.unref();
                this.socket.once('close', () => clearTimeout(timer));
                // The close code is the only server-side account of why a turn was lost.
                const error = new Error(`upstream WebSocket closed ${code}${reason ? ' ' + reason.slice(0, 120) : ''}`);
                error.closeCode = code;
                this.onerror?.(error);
                return;
            }
            if ((opcode === 0 && !this.fragmenting) || (opcode === 1 && this.fragmenting)) throw new Error('invalid continuation');
            if (!fin || opcode === 0)
            {
                this.fragments.push(payload);
                this.fragmentBytes += length;
                this.fragmenting = !fin;
                if (!fin) continue;
                const text = utf8(Buffer.concat(this.fragments, this.fragmentBytes));
                this.fragments = [];
                this.fragmentBytes = 0;
                this.onmessage?.(text);
            }
            else this.onmessage?.(utf8(payload));
        }
    }

    send(text)
    {
        if (this.dead) throw new Error('upstream WebSocket closed');
        const payload = Buffer.from(text);
        if (payload.length > MAX_WEBSOCKET_MESSAGE_BYTES) throw new Error('OpenAI WebSocket request exceeds message limit');
        this.socket.write(clientFrame(payload, 1));
    }

    destroy(error = new Error('upstream WebSocket reclaimed'))
    {
        if (this.dead) return;
        this.dead = true;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.socket.destroy();
        this.onerror?.(error);
    }
}

// Resolve HTTP upgrade rejections as Responses so callers retain status/retry headers.
// Never redirect an authenticated upgrade or retry a request after it was sent.
export function connectWebSocket(url, headers, { signal, timeout = 120000 } = {})
{
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) { reject(new Error('invalid WebSocket URL')); return; }
        target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
        const key = crypto.randomBytes(16).toString('base64');
        const request = (target.protocol === 'https:' ? https : http).request(target, {
            method: 'GET', agent: false,
            headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
        });
        let settled = false;
        let response = null;
        const abort = () => fail(new Error('client disconnected'));
        const timer = setTimeout(() => {
            const error = new Error('OpenAI WebSocket upgrade timed out');
            error.code = 'OPENAI_WS_UPGRADE_TIMEOUT';
            fail(error);
        }, timeout);
        timer.unref?.();
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            response?.destroy();
            request.destroy();
            reject(error);
        };
        request.on('error', () => {
            const error = new Error('OpenAI WebSocket upgrade failed');
            error.code = 'OPENAI_WS_UPGRADE_FAILED';
            fail(error);
        });
        request.on('upgrade', (res, socket, head) => {
            const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
            if (settled || res.statusCode !== 101 || String(res.headers.upgrade || '').toLowerCase() !== 'websocket'
                || !String(res.headers.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')
                || res.headers['sec-websocket-accept'] !== expected || res.headers['sec-websocket-extensions'] || res.headers['sec-websocket-protocol'])
            {
                socket.destroy();
                const error = new Error('invalid OpenAI WebSocket upgrade');
                error.code = 'OPENAI_WS_UPGRADE_INVALID';
                fail(error);
                return;
            }
            settled = true;
            cleanup();
            resolve(new SocketConnection(socket, head, new Headers(res.headers)));
        });
        request.on('response', res => {
            response = res;
            if (res.statusCode < 300) { fail(new Error('OpenAI WebSocket upgrade was not accepted')); return; }
            const chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_WEBSOCKET_MESSAGE_BYTES) { fail(new Error('OpenAI WebSocket upgrade body exceeds limit')); return; }
                chunks.push(chunk);
            });
            res.on('error', () => fail(new Error('OpenAI WebSocket upgrade response failed')));
            res.on('aborted', () => fail(new Error('OpenAI WebSocket upgrade response aborted')));
            res.on('end', () => {
                if (settled) return;
                settled = true;
                cleanup();
                const response = new Response(res.statusCode === 304 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers });
                response.webSocketUpgradeRejected = true;
                resolve(response);
            });
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        request.end();
    });
}
