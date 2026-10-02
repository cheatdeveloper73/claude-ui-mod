// The router listens on a fixed loopback port that any web page in the user's
// browser can reach. These tests send the requests such a page can send --
// a cross-site form/fetch POST, an <img> GET, a DNS-rebound Host -- and the
// requests the real clients send, and pin which of them get through. Fake
// upstreams and synthetic credentials only; nothing here can spend quota.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.PROVIDER_ROUTER_DIR || fileURLToPath(new URL('../router', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-guard-test-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        upstreamCalls.push({ url: req.url, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_guard', type: 'message', role: 'assistant', model: 'stub-compat-1',
            content: [{ type: 'text', text: 'GUARD_FIXTURE' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

const catalogueFile = path.join(temp, 'catalogue.json');
const secretsFile = path.join(temp, 'provider-secrets.json');
const adapterDir = path.join(temp, 'no-adapters');
fs.mkdirSync(adapterDir, { recursive: true });
fs.writeFileSync(catalogueFile, JSON.stringify([{ id: 'Stub-Compat-agent', name: 'Stub Compat Agent', efforts: [], provider: 'stub',
    backend: { protocol: 'anthropic-messages', baseUrl: upstreamBase + '/stub', apiKeyHeader: 'x-api-key', secret: 'stub' } }]));
fs.writeFileSync(secretsFile, JSON.stringify({ stub: { apiKey: 'stub-test-key-guard' } }));
const token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.test';
const authFile = path.join(temp, 'auth.json');
fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: token, account_id: 'test-only', refresh_token: 'test' }, last_refresh: new Date().toISOString() }));
Object.assign(process.env, {
    CODEX_AUTH_FILE: authFile,
    CODEX_RESPONSES_URL: upstreamBase + '/responses',
    MODEL_ROUTER_UPSTREAM: upstreamBase + '/anthropic',
    MODEL_ROUTER_ADAPTER_DIR: adapterDir,
    MODEL_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_SETTINGS_FILE: path.join(temp, 'settings.json'),
    MODEL_ROUTER_CATALOGUE_FILE: catalogueFile,
    MODEL_ROUTER_SECRETS_FILE: secretsFile,
});

// Explicit Host/Origin/Sec-Fetch-Site: fetch() forbids setting them, which is
// exactly why these tests do not use it.
function send(port, { method = 'GET', route = '/', headers = {}, body = null, host } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const request = http.request({
            host: '127.0.0.1', port, method, path: route, setHost: false,
            headers: { Host: host ?? `127.0.0.1:${port}`, ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
        }, response => {
            const chunks = [];
            response.on('data', c => chunks.push(c));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (_) {}
                resolve({ status: response.statusCode, headers: response.headers, text, json });
            });
        });
        request.setTimeout(8000, () => request.destroy(new Error('request timed out')));
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

const CLI_HEADERS = {
    // Captured from claude 2.1.260 (Bun) against a local listener: no Origin,
    // no Referer, no Sec-Fetch-*.
    'User-Agent': 'claude-cli/2.1.260 (external, claude-desktop, agent-sdk/0.3.284)',
    'x-app': 'cli',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'X-Stainless-Lang': 'js',
    'x-claude-code-session-id': '7639f89b-8c86-405a-af85-b2caaddf2450',
    'content-type': 'application/json',
};
const MESSAGE = { model: 'claude-Stub-Compat-agent', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hello' }] };

const { server } = await import(pathToFileURL(path.join(root, 'index.mjs')));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const workerPort = server.address().port;

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    await new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections?.();
});

test('worker: a cross-site page cannot POST state-changing routes', async () => {
    for (const origin of ['https://evil.example', 'http://evil.example', 'null', 'http://localhost:3000',
        `http://127.0.0.1:${workerPort + 1}`])
    {
        const response = await send(workerPort, { method: 'POST', route: '/poolpinz?force=1', headers: { Origin: origin, 'content-type': 'text/plain' }, body: '{"action":"auto"}' });
        assert.equal(response.status, 403, `Origin ${origin}`);
        assert.equal(response.json?.type, 'error');
        assert.ok(!response.text.includes('evil.example'), 'the rejection must not echo caller-controlled values');
        assert.ok(response.text.length < 300);
    }
});

test('worker: a no-cors text/plain POST to /v1/messages never reaches a provider', async () => {
    const before = upstreamCalls.length;
    const response = await send(workerPort, { method: 'POST', route: '/v1/messages',
        headers: { Origin: 'https://evil.example', 'content-type': 'text/plain', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' },
        body: MESSAGE });
    assert.equal(response.status, 403);
    assert.equal(upstreamCalls.length, before, 'the provider must not be called');
});

test('worker: Sec-Fetch-Site gates GETs that carry no Origin (<img>, navigation)', async () => {
    for (const site of ['cross-site', 'same-site'])
    {
        const response = await send(workerPort, { route: '/healthz', headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' } });
        assert.equal(response.status, 403, `Sec-Fetch-Site: ${site}`);
    }
    for (const site of ['same-origin', 'none'])
    {
        const response = await send(workerPort, { route: '/healthz', headers: { 'Sec-Fetch-Site': site } });
        assert.equal(response.status, 200, `Sec-Fetch-Site: ${site}`);
    }
});

test('worker: a rebound or foreign Host is rejected, loopback names are not', async () => {
    for (const host of [`evil.example:${workerPort}`, `evil.example`, `127.0.0.1.evil.example:${workerPort}`, '127.0.0.1:1', '127.0.0.1', `localhost.evil.example:${workerPort}`])
    {
        const response = await send(workerPort, { route: '/healthz', host });
        assert.equal(response.status, 403, `Host ${host}`);
    }
    for (const host of [`127.0.0.1:${workerPort}`, `localhost:${workerPort}`, `LOCALHOST:${workerPort}`, `[::1]:${workerPort}`])
    {
        const response = await send(workerPort, { route: '/healthz', host });
        assert.equal(response.status, 200, `Host ${host}`);
    }
});

test('worker: a CLI-style request with no Origin is served', async () => {
    const before = upstreamCalls.length;
    const response = await send(workerPort, { method: 'POST', route: '/v1/messages?beta=true', headers: CLI_HEADERS, body: MESSAGE });
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.equal(response.json?.content?.[0]?.text, 'GUARD_FIXTURE');
    assert.equal(upstreamCalls.length, before + 1);
    const hello = await send(workerPort, { method: 'HEAD', route: '/api/hello', headers: { 'User-Agent': 'Bun/1.4.1', Accept: '*/*' } });
    assert.notEqual(hello.status, 403);
});

test('worker: the router\'s own page may fetch and POST back to itself', async () => {
    const origin = `http://127.0.0.1:${workerPort}`;
    const page = await send(workerPort, { route: '/usage/', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } });
    assert.equal(page.status, 200);
    assert.ok(/<html/i.test(page.text));
    const asset = await send(workerPort, { route: '/usage/app.js', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors' } });
    assert.equal(asset.status, 200);
    const read = await send(workerPort, { route: '/poolpinz', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } });
    assert.notEqual(read.status, 403);
    const write = await send(workerPort, { method: 'POST', route: '/poolpinz', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: { action: 'auto' } });
    assert.notEqual(write.status, 403, 'same-origin dashboard POST');
    // The localhost spelling is a different origin string for the same server.
    const viaName = await send(workerPort, { method: 'POST', route: '/poolpinz', host: `localhost:${workerPort}`,
        headers: { Origin: `http://localhost:${workerPort}`, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: { action: 'auto' } });
    assert.notEqual(viaName.status, 403);
});

test('worker: the public-port origin forwarded by the supervisor is accepted, including by an older supervisor', async () => {
    // A supervisor started before this change does not tell the worker its
    // public port; the worker has to assume the documented 8789.
    const port = await new Promise(resolve => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const log = path.join(temp, 'legacy-worker.log');
    const env = { ...process.env, MODEL_ROUTER_WORKER_PORT: String(port) };
    delete env.MODEL_ROUTER_PUBLIC_PORT; delete env.GEMINI_BRIDGE_PORT; delete env.MODEL_ROUTER_PORT;
    const child = childProcess.spawn(process.execPath, [path.join(root, 'index.mjs')], { env, windowsHide: true, stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')] });
    try
    {
        let ready = false;
        for (let attempt = 0; attempt < 100 && !ready; attempt++)
        {
            try { ready = (await send(port, { route: '/healthz' })).status === 200; } catch (_) { await delay(100); }
        }
        assert.ok(ready, 'worker did not come up: ' + fs.readFileSync(log, 'utf8').slice(-400));
        const forwarded = await send(port, { method: 'POST', route: '/poolpinz', headers: { Origin: 'http://127.0.0.1:8789', 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: { action: 'auto' } });
        assert.notEqual(forwarded.status, 403);
        const evil = await send(port, { method: 'POST', route: '/poolpinz', headers: { Origin: 'http://evil.example:8789', 'content-type': 'application/json' }, body: { action: 'auto' } });
        assert.equal(evil.status, 403);
    }
    finally { child.kill(); }
});

function stubWorker(file) {
    // Records the Host/Origin it was forwarded and every request it served.
    fs.writeFileSync(file, `import http from 'node:http';
import fs from 'node:fs';
const hits = ${JSON.stringify(path.join(temp, 'stub-hits.log').replace(/\\/g, '/'))};
http.createServer((req, res) => {
    if (req.url === '/healthz') { res.end('{"ok":true}'); return; }
    fs.appendFileSync(hits, req.method + ' ' + req.url + '\\n');
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin || null, site: req.headers['sec-fetch-site'] || null }));
}).listen(Number(process.env.MODEL_ROUTER_WORKER_PORT), '127.0.0.1');
`);
}

test('supervisor: guards its own endpoints and everything it proxies', async () => {
    const { RouterSupervisor } = await import(pathToFileURL(path.join(root, 'supervisor.mjs')));
    const dir = fs.mkdtempSync(path.join(temp, 'sup-'));
    const entry = path.join(dir, 'worker.mjs');
    stubWorker(entry);
    const hitsFile = path.join(temp, 'stub-hits.log');
    fs.writeFileSync(hitsFile, '');
    const supervisor = new RouterSupervisor({ entry, watchDir: dir, port: 0, rollbackWindowMs: 20000, canary: false });
    try
    {
        await supervisor.start();
        const port = supervisor.server.address().port;
        // A second generation so there is a warm standby to roll back to.
        fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8') + '\n// v2\n');
        const deadline = Date.now() + 12000;
        while ((supervisor.current?.generation < 2 || supervisor.reloading) && Date.now() < deadline) await delay(25);
        assert.equal(supervisor.current.generation, 2);
        assert.equal(supervisor.standby?.generation, 1);

        // Rollback from a web page is rejected and changes nothing.
        const forged = await send(port, { method: 'POST', route: '/rollbackz', headers: { Origin: 'https://evil.example', 'content-type': 'text/plain' } });
        assert.equal(forged.status, 403);
        const forgedSite = await send(port, { method: 'POST', route: '/rollbackz', headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.equal(forgedSite.status, 403);
        assert.equal(supervisor.current.generation, 2, 'a rejected rollback must not swap the worker');
        assert.equal(supervisor.standby?.generation, 1);

        // A rebound name cannot read supervisor state or reach the worker.
        const rebound = await send(port, { route: '/supervisorz', host: `evil.example:${port}` });
        assert.equal(rebound.status, 403);
        assert.ok(!rebound.headers['x-cuimod-router-supervisor'] || rebound.json?.type === 'error');
        const reboundProxy = await send(port, { route: '/anything', host: `evil.example:${port}` });
        assert.equal(reboundProxy.status, 403);
        const crossSiteProxy = await send(port, { route: '/anything', headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.equal(crossSiteProxy.status, 403);
        assert.equal(fs.readFileSync(hitsFile, 'utf8'), '', 'no rejected request may reach the worker');

        // Legitimate callers.
        const status = await send(port, { route: '/supervisorz' });
        assert.equal(status.status, 200);
        assert.equal(status.headers['x-cuimod-router-supervisor'], '1');
        const forward = await send(port, { route: '/page', headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
        assert.equal(forward.status, 200);
        assert.equal(forward.json.origin, `http://127.0.0.1:${port}`);
        assert.equal(forward.json.host, `127.0.0.1:${supervisor.current.port}`, 'the worker is addressed by its private port');
        const cli = await send(port, { route: '/v1/messages', method: 'POST', headers: CLI_HEADERS, body: MESSAGE });
        assert.equal(cli.status, 200);
        const rollback = await send(port, { method: 'POST', route: '/rollbackz' });
        assert.equal(rollback.status, 200, 'a bare local POST (curl, scripts) still rolls back');
        assert.equal(supervisor.current.generation, 1);
    }
    finally { await supervisor.close(); }
});

test('supervisor in front of the real worker: same-origin dashboard calls work, forged ones do not', async () => {
    const { RouterSupervisor } = await import(pathToFileURL(path.join(root, 'supervisor.mjs')));
    const supervisor = new RouterSupervisor({ entry: path.join(root, 'index.mjs'), watchDir: path.join(temp, 'no-watch'), port: 0, canary: false });
    fs.mkdirSync(path.join(temp, 'no-watch'), { recursive: true });
    try
    {
        await supervisor.start();
        const port = supervisor.server.address().port;
        const ok = await send(port, { method: 'POST', route: '/poolpinz', headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/json' }, body: { action: 'auto' } });
        assert.notEqual(ok.status, 403, 'dashboard POST through the supervisor: ' + ok.text.slice(0, 200));
        const page = await send(port, { route: '/usage/', headers: { 'Sec-Fetch-Site': 'none' } });
        assert.equal(page.status, 200);
        const cli = await send(port, { method: 'POST', route: '/v1/messages', headers: CLI_HEADERS, body: MESSAGE });
        assert.equal(cli.status, 200, cli.text.slice(0, 200));
        const before = upstreamCalls.length;
        const forged = await send(port, { method: 'POST', route: '/v1/messages', headers: { Origin: 'https://evil.example', 'content-type': 'text/plain' }, body: MESSAGE });
        assert.equal(forged.status, 403);
        const rebound = await send(port, { route: '/healthz', host: `evil.example:${port}` });
        assert.equal(rebound.status, 403);
        assert.equal(upstreamCalls.length, before);
        // The worker is also reachable on its private port; a rebound name there is no better.
        const direct = await send(supervisor.current.port, { route: '/healthz', host: `evil.example:${supervisor.current.port}` });
        assert.equal(direct.status, 403);
    }
    finally { await supervisor.close(); }
});

test('healthz does not echo parse errors from the provider secrets file', async () => {
    // Built at run time so no credential-shaped literal sits in the source; the
    // publish scan would rightly refuse one.
    fs.writeFileSync(secretsFile, JSON.stringify({ stub: { apiKey: ['LEAK', 'CANARY', 'value'].join('-') } }).slice(0, -2) + ' ');
    try
    {
        const response = await send(workerPort, { route: '/healthz' });
        assert.equal(response.status, 200);
        assert.ok(response.json.compatible.secretsError, 'a broken secrets file must still be reported');
        assert.ok(!response.text.includes('LEAK-CANARY'), 'secrets content leaked through /healthz');
        assert.ok(!/position|Unexpected|JSON at/.test(response.json.compatible.secretsError), 'raw JSON.parse text leaked');
        fs.rmSync(secretsFile);
        const missing = await send(workerPort, { route: '/healthz' });
        assert.ok(!/ENOENT|open '/.test(missing.json.compatible.secretsError || ''), 'raw fs error text leaked');
    }
    finally { fs.writeFileSync(secretsFile, JSON.stringify({ stub: { apiKey: 'stub-test-key-guard' } })); }
});
