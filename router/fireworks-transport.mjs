import http2 from 'node:http2';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { fetchResilient, NO_STATUS_RETRY } from './relay.mjs';

const sessions = new Set();
let opened = 0;
const IDLE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 55 * 60 * 1000;
const MAX_SESSIONS = 16;
const CONNECT_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION']);

function retire(entry)
{
    entry.retired = true;
    clearTimeout(entry.timer);
    if (entry.active === 0)
    {
        sessions.delete(entry);
        if (!entry.session.destroyed) entry.session.close();
    }
}

function idle(entry)
{
    if (entry.active) return;
    if (!entry.connected) { entry.session.destroy(); return; }
    if (entry.retired || entry.session.closed || entry.session.destroyed || Date.now() - entry.created >= MAX_AGE_MS) { retire(entry); return; }
    entry.session.unref();
    entry.timer = setTimeout(() => retire(entry), IDLE_MS);
    entry.timer.unref();
}

export function closeFireworksSessions()
{
    for (const entry of sessions) { clearTimeout(entry.timer); entry.session.destroy(); }
    sessions.clear();
}

export function fireworksTransportState()
{
    return { protocol: 'http2', opened, sessions: sessions.size, active: [...sessions].reduce((sum, entry) => sum + entry.active, 0) };
}

function reserve(target, headers, timeout)
{
    // HTTP/2 multiplexes turns without another TCP/TLS handshake. Partition by
    // credential identity so rotating keys cannot inherit authenticated state.
    const authorization = ['authorization', 'x-api-key'].map(name => headers.get(name) || '');
    const key = crypto.createHash('sha256').update(JSON.stringify([target.origin, authorization])).digest('hex');
    for (const entry of sessions)
    {
        if (Date.now() - entry.created >= MAX_AGE_MS) retire(entry);
        if (!entry.retired && !entry.session.closed && !entry.session.destroyed && entry.key === key
            && entry.active < Math.min(entry.session.remoteSettings.maxConcurrentStreams ?? 100, 100))
        {
            clearTimeout(entry.timer);
            entry.active++;
            entry.session.ref();
            return entry;
        }
    }
    if (sessions.size >= MAX_SESSIONS)
    {
        const available = [...sessions].find(entry => entry.active === 0);
        if (available) retire(available);
        else throw new Error('Fireworks HTTP/2 pool is busy');
    }
    const session = http2.connect(target.origin);
    const entry = { key, session, active: 1, created: Date.now(), retired: false, connected: false, timer: null, streams: new Set(), ready: null };
    sessions.add(entry);
    entry.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error('Fireworks HTTP/2 connection timed out');
            error.code = 'ETIMEDOUT';
            session.destroy(error);
        }, timeout);
        session.once('connect', () => { entry.connected = true; opened++; clearTimeout(timer); resolve(); });
        session.on('error', error => {
            clearTimeout(timer);
            entry.retired = true;
            sessions.delete(entry);
            reject(error);
            for (const stream of entry.streams) stream.destroy(error);
        });
        session.once('close', () => {
            clearTimeout(timer);
            clearTimeout(entry.timer);
            sessions.delete(entry);
            reject(new Error('Fireworks HTTP/2 connection closed'));
        });
        session.on('goaway', () => retire(entry));
    });
    return entry;
}

async function requestOnce(target, options, signal)
{
    const headers = new Headers(options.headers);
    // Keep responses uncompressed in the common case; decode a server that sends
    // compression anyway so the Anthropic relay keeps fetch's byte semantics.
    headers.set('accept-encoding', 'identity');
    const timeout = options.headersTimeoutMs || 120000;
    const entry = reserve(target, headers, timeout);
    let stream;
    let released = false;
    let sent = false;
    const release = () => {
        if (released) return;
        released = true;
        if (stream) entry.streams.delete(stream);
        entry.active--;
        idle(entry);
    };
    try
    {
        // A disconnect must also wake a caller waiting for a shared TLS handshake.
        await new Promise((resolve, reject) => {
            const abort = () => reject(new Error('client disconnected'));
            signal?.addEventListener('abort', abort, { once: true });
            entry.ready.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
            if (signal?.aborted) abort();
        });
        if (signal?.aborted) throw new Error('client disconnected');
        const requestHeaders = { ':method': options.method || 'POST', ':path': target.pathname + target.search };
        for (const [name, value] of headers)
            if (!['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(name)) requestHeaders[name] = value;
        stream = entry.session.request(requestHeaders);
        sent = true;
        entry.streams.add(stream);
        stream.once('close', release);
        return await new Promise((resolve, reject) => {
            let responded = false;
            const abort = () => stream.destroy(new Error('client disconnected'));
            const timer = setTimeout(() => {
                const error = new Error('Fireworks response headers timed out');
                error.code = 'ETIMEDOUT';
                stream.destroy(error);
            }, timeout);
            const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
            signal?.addEventListener('abort', abort, { once: true });
            stream.once('close', () => {
                cleanup();
                if (!responded) reject(new Error('Fireworks HTTP/2 stream closed before headers'));
            });
            stream.on('error', error => { if (!responded) reject(error); });
            stream.once('response', raw => {
                responded = true;
                clearTimeout(timer);
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(raw))
                {
                    if (name.startsWith(':') || value === undefined) continue;
                    if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, String(item));
                    else responseHeaders.set(name, String(value));
                }
                let source = stream;
                const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
                const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
                    : encoding === 'br' ? createBrotliDecompress() : null;
                if (decoder)
                {
                    source = stream.pipe(decoder);
                    stream.on('error', error => decoder.destroy(error));
                    decoder.once('close', () => { if (!stream.destroyed) stream.destroy(); });
                    responseHeaders.delete('content-encoding');
                    responseHeaders.delete('content-length');
                }
                const status = Number(raw[':status']);
                if ([204, 205, 304].includes(status)) { source.resume(); resolve(new Response(null, { status, headers: responseHeaders })); }
                else resolve(new Response(Readable.toWeb(source), { status, headers: responseHeaders }));
            });
            if (signal?.aborted) { abort(); return; }
            stream.end(options.body);
        });
    }
    catch (error)
    {
        if (stream && !stream.destroyed) stream.destroy();
        else release();
        error.requestSent = sent;
        throw error;
    }
}

export async function fireworksRequest(url, options, clientGone, log = () => {})
{
    const parsed = new URL(url);
    const signal = options.signal || clientGone?.signal;
    if (signal?.aborted || clientGone?.()) throw new Error('client disconnected');
    // Existing HTTP loopback fixtures keep their original fetch transport.
    if (!['https:', 'h2c:'].includes(parsed.protocol))
        return fetchResilient(url, { ...options, signal }, 'fireworks', clientGone, NO_STATUS_RETRY, log);
    const target = parsed.protocol === 'h2c:' ? new URL(`http://${parsed.host}${parsed.pathname}${parsed.search}`) : parsed;
    for (let attempt = 0; ; attempt++)
    {
        try { return await requestOnce(target, options, signal); }
        catch (error)
        {
            // Only reconnect before a stream was submitted. A reset after POST
            // is ambiguous even before headers and must never duplicate inference.
            if (error.requestSent || attempt || signal?.aborted || clientGone?.() || !CONNECT_ERRORS.has(error.code)) throw error;
            log('fireworks reconnecting before request submission');
        }
    }
}
