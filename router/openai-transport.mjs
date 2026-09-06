import http2 from 'node:http2';
import { Readable } from 'node:stream';

const HEADERS_TIMEOUT_MS = 120000;
const MAX_ATTEMPTS = 3;
const TRANSIENT = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
    'ERR_HTTP2_STREAM_CANCEL', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_SESSION',
]);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const backoff = attempt => Math.min(500 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 250);

function isTransient(error)
{
    const code = error?.cause?.code || error?.code || '';
    return TRANSIENT.has(code) || /socket|session|connect|timeout|reset|closed|terminated/i.test(error?.message || '');
}

function fetchFallback(url, options, clientGone)
{
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS);
    return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer)).then(response => {
        if (clientGone?.()) response.body?.cancel().catch(() => {});
        return response;
    });
}

function http2Request(url, options)
{
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const target = parsed.protocol === 'h2c:'
            ? new URL(`http://${parsed.host}${parsed.pathname}${parsed.search}`)
            : parsed;
        const session = http2.connect(target.origin);
        let stream = null;
        let settled = false;
        let responseStarted = false;
        const timer = setTimeout(() => {
            const error = new Error('openai response headers timed out');
            error.code = 'ETIMEDOUT';
            if (stream) stream.destroy(error);
            else session.destroy(error);
        }, HEADERS_TIMEOUT_MS);

        const finishSession = () => {
            clearTimeout(timer);
            if (!session.closed && !session.destroyed) session.close();
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!session.destroyed) session.destroy();
            reject(error);
        };

        session.once('error', error => {
            if (!responseStarted) fail(error);
            else stream?.destroy(error);
        });
        session.once('goaway', () => {
            if (!responseStarted) {
                const error = new Error('openai HTTP/2 session received GOAWAY before response headers');
                error.code = 'ERR_HTTP2_GOAWAY_SESSION';
                fail(error);
            }
        });

        session.once('connect', () => {
            const headers = {
                ':method': options.method || 'POST',
                ':path': target.pathname + target.search,
                ':scheme': target.protocol.slice(0, -1),
                ':authority': target.host,
            };
            for (const [name, value] of Object.entries(options.headers || {}))
            {
                const lower = name.toLowerCase();
                if (['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)) continue;
                headers[lower] = value;
            }

            try { stream = session.request(headers); }
            catch (error) { fail(error); return; }

            stream.once('response', rawHeaders => {
                if (settled) return;
                settled = true;
                responseStarted = true;
                clearTimeout(timer);
                const status = Number(rawHeaders[':status']) || 502;
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(rawHeaders))
                {
                    if (name.startsWith(':') || value === undefined) continue;
                    if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, String(entry));
                    else responseHeaders.set(name, String(value));
                }
                stream.once('end', finishSession);
                stream.once('close', finishSession);
                const body = Readable.toWeb(stream);
                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    headers: responseHeaders,
                    body,
                    async text()
                    {
                        const reader = body.getReader();
                        const chunks = [];
                        for (;;)
                        {
                            const { value, done } = await reader.read();
                            if (done) break;
                            chunks.push(Buffer.from(value));
                        }
                        return Buffer.concat(chunks).toString('utf8');
                    },
                });
            });
            stream.once('error', error => {
                if (!responseStarted) fail(error);
            });
            stream.end(options.body);
        });
    });
}

export async function openAIRequest(url, options, clientGone, log = () => {})
{
    const target = new URL(url);
    if (!['https:', 'h2c:'].includes(target.protocol)) return fetchFallback(url, options, clientGone);

    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
    {
        if (clientGone?.()) throw new Error('client disconnected');
        try { return await http2Request(url, options); }
        catch (error)
        {
            last = error;
            if (clientGone?.()) throw new Error('client disconnected');
            if (!isTransient(error) || attempt === MAX_ATTEMPTS) throw error;
            log(`openai HTTP/2 ${error?.code || error?.name || 'error'}, retry ${attempt}/${MAX_ATTEMPTS - 1}`);
            await delay(backoff(attempt));
        }
    }
    throw last || new Error('openai HTTP/2 request failed');
}

export { HEADERS_TIMEOUT_MS, MAX_ATTEMPTS, http2Request };
