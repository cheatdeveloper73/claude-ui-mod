// Browser-origin guard shared by the supervisor (public port 8789) and the
// worker behind it.
//
// The router binds loopback, but loopback is reachable from every web page in
// the user's browser: a cross-site form or no-cors fetch can POST to it with no
// preflight, an <img> can GET it, and a page whose DNS name is rebound to
// 127.0.0.1 becomes same-origin with it. Neither Claude Code nor any plugin
// sends an Origin or Sec-Fetch-* header (captured from claude 2.1.260; the
// plugins use node:http), so those headers are exactly the signal that a
// browser, not a client, is on the other end.
//
//   Host            must be a loopback name on a port this listener serves.
//                   Defeats DNS rebinding, which keeps the attacker's own Host.
//   Origin          if present, must be a loopback origin on such a port.
//                   Defeats cross-site POSTs, which always carry one.
//   Sec-Fetch-Site  if present, must be same-origin or none (address bar,
//                   openExternal). Defeats <img>/<script> GETs, which carry no
//                   Origin but always carry this.
//
// A header is judged by value, never echoed back, and the rejection is a fixed
// string.

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

function portOf(value, hostnames, prefix)
{
    if (typeof value !== 'string' || !value.toLowerCase().startsWith(prefix)) return null;
    const rest = value.toLowerCase().slice(prefix.length);
    const colon = rest.lastIndexOf(':');
    if (colon === -1) return null;
    if (!hostnames.includes(rest.slice(0, colon))) return null;
    const digits = rest.slice(colon + 1);
    return /^\d{1,5}$/.test(digits) ? Number(digits) : null;
}

// ports: every port this listener legitimately answers on. For the supervisor
// that is the socket's own port. For the worker it is its private port (what
// the supervisor rewrites Host to) and the public port (what a browser
// page's Origin names, since the supervisor forwards Origin untouched).
export function requestRejection(headers, ports)
{
    const allowed = new Set(ports.filter(port => Number.isInteger(port) && port > 0));
    const host = portOf(headers.host, LOOPBACK_HOSTS, '');
    if (host === null || !allowed.has(host)) return 'host';

    const origin = headers.origin;
    if (origin !== undefined)
    {
        const originPort = portOf(origin, LOOPBACK_HOSTS, 'http://');
        if (originPort === null || !allowed.has(originPort)) return 'origin';
    }

    const site = headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'fetch-site';
    return null;
}

// Returns true, having already answered 403, when the request must not be
// processed. The body is drained and dropped; a rejected request is never read.
export function rejectRequest(request, response, ports)
{
    const reason = requestRejection(request.headers, ports);
    if (!reason) return false;
    response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error',
        message: 'the model router only serves local clients; browser cross-site and non-loopback requests are refused' } }));
    request.resume();
    return true;
}

// The port a browser page sees the router on. The supervisor tells its worker;
// a worker started by a supervisor that predates the guard falls back to the
// same environment the supervisor itself reads.
export function publicRouterPort()
{
    return Number(process.env.MODEL_ROUTER_PUBLIC_PORT || process.env.GEMINI_BRIDGE_PORT || 8789);
}
