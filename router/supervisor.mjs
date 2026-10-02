// Stable front door for blue-green router reloads. Edited backend code boots on
// a private port first; only a healthy worker receives new requests, while the
// previous worker drains active responses under a separate hard deadline.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rejectRequest } from './request-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = process.env.MODEL_ROUTER_WORKER_ENTRY || path.join(HERE, 'index.mjs');
const CANARY = process.env.MODEL_ROUTER_CANARY || path.join(HERE, '..', 'scripts', 'router-canary.mjs');
const PORT = Number(process.env.GEMINI_BRIDGE_PORT || 8789);
const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'gemini-bridge');
const HEALTH_TIMEOUT_MS = 10000;
const HEALTH_INTERVAL_MS = 100;
const RELOAD_DEBOUNCE_MS = 180;
const ROLLBACK_WINDOW_MS = 2 * 60 * 1000;
const RETIRED_DRAIN_TIMEOUT_MS = 60 * 60 * 1000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message)
{
    const line = `${new Date().toISOString()} supervisor ${message}\n`;
    process.stdout.write(line);
    try
    {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(path.join(STATE_DIR, 'bridge.log'), line);
    }
    catch (_) {}
}

function freePort()
{
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.unref();
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', () => {
            const port = socket.address().port;
            socket.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function probe(port)
{
    return new Promise(resolve => {
        const request = http.get(`http://127.0.0.1:${port}/healthz`, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.setTimeout(750, () => request.destroy());
        request.on('error', () => resolve(false));
    });
}

export class RouterSupervisor
{
    constructor(options = {})
    {
        this.entry = options.entry || ENTRY;
        this.port = options.port ?? PORT;
        this.watchDir = options.watchDir || path.dirname(this.entry);
        this.spawn = options.spawn || childProcess.spawn;
        this.canarySpawn = options.canarySpawn || childProcess.spawn;
        this.canary = options.canary === false ? null : (options.canary || CANARY);
        this.rollbackWindowMs = options.rollbackWindowMs ?? ROLLBACK_WINDOW_MS;
        this.retiredDrainTimeoutMs = options.retiredDrainTimeoutMs ?? RETIRED_DRAIN_TIMEOUT_MS;
        this.current = null;
        this.standby = null;
        this.workers = new Set();
        this.generation = 0;
        this.reloadTimer = null;
        this.reloading = false;
        this.reloadAgain = false;
        this.closing = false;
        this.watcher = null;
        this.server = http.createServer((request, response) => this.handle(request, response));
        this.server.requestTimeout = 0;
        this.server.headersTimeout = 125000;
        this.server.keepAliveTimeout = 120000;
        this.server.timeout = 0;
    }

    async runCanary()
    {
        if (!this.canary) return;
        if (!fs.existsSync(this.canary)) throw new Error(`router canary is missing: ${this.canary}`);
        await new Promise((resolve, reject) => {
            const child = this.canarySpawn(process.execPath, [this.canary, '--router-dir', path.dirname(this.entry)], {
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'pipe'],
                env: { ...process.env },
            });
            let stderr = '';
            const timer = setTimeout(() => {
                try { child.kill(); } catch (_) {}
                reject(new Error('router canary timed out'));
            }, HEALTH_TIMEOUT_MS);
            child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(stderr.trim() || `router canary exited ${code}`));
            });
        });
    }

    async spawnWorker()
    {
        const port = await freePort();
        const generation = ++this.generation;
        const child = this.spawn(process.execPath, [this.entry], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, MODEL_ROUTER_WORKER_PORT: String(port),
                MODEL_ROUTER_PUBLIC_PORT: String(this.server.address()?.port ?? this.port) },
        });
        const worker = { child, port, generation, active: 0, retired: false, exited: false, stderr: '', expiryTimer: null, drainTimer: null };
        this.workers.add(worker);
        child.stderr?.on('data', chunk => { worker.stderr = (worker.stderr + chunk).slice(-4096); });
        child.once('exit', (code, signal) => {
            worker.exited = true;
            clearTimeout(worker.expiryTimer);
            clearTimeout(worker.drainTimer);
            this.workers.delete(worker);
            if (this.standby === worker) this.standby = null;
            if (this.current === worker)
            {
                const fallback = this.takeStandby();
                if (fallback)
                {
                    this.current = fallback;
                    log(`worker ${generation} exited (${code ?? signal}); rolled back to worker ${fallback.generation}`);
                }
                else
                {
                    this.current = null;
                    if (!this.closing)
                    {
                        log(`worker ${generation} exited (${code ?? signal}); starting replacement`);
                        this.scheduleReload(0);
                    }
                }
            }
        });
        child.once('error', error => { worker.stderr = String(error?.message || error); });

        const deadline = Date.now() + HEALTH_TIMEOUT_MS;
        while (!worker.exited && Date.now() < deadline)
        {
            if (await probe(port))
            {
                try
                {
                    await this.runCanary();
                    if (worker.exited) throw new Error(`worker ${generation} exited during canary`);
                    return worker;
                }
                catch (error) { this.stopWorker(worker); throw error; }
            }
            await delay(HEALTH_INTERVAL_MS);
        }
        this.stopWorker(worker);
        throw new Error(worker.stderr.trim() || `worker ${generation} failed health check`);
    }

    stopWorker(worker)
    {
        if (!worker || worker.exited) return;
        clearTimeout(worker.expiryTimer);
        clearTimeout(worker.drainTimer);
        if (this.standby === worker) this.standby = null;
        try { worker.child.kill(); } catch (_) {}
    }

    stopWhenDrained(worker)
    {
        if (!worker || worker.exited) return;
        worker.retired = true;
        if (worker.active === 0) { this.stopWorker(worker); return; }
        if (worker.drainTimer) return;
        worker.drainTimer = setTimeout(() => {
            log(`retired worker ${worker.generation} exceeded active-drain deadline; stopping ${worker.active} request(s)`);
            this.stopWorker(worker);
        }, this.retiredDrainTimeoutMs);
        worker.drainTimer.unref?.();
    }

    keepStandby(worker)
    {
        if (!worker) return;
        const previousStandby = this.standby;
        if (previousStandby && previousStandby !== worker) this.stopWhenDrained(previousStandby);
        worker.retired = true;
        this.standby = worker;
        clearTimeout(worker.expiryTimer);
        worker.expiryTimer = setTimeout(() => {
            if (this.standby === worker) this.standby = null;
            // Rollback expires before a long buffered response can finish. Remove
            // the rollback target now, but let active requests drain under a
            // separate hard deadline so wedged workers cannot live forever.
            this.stopWhenDrained(worker);
        }, this.rollbackWindowMs);
        worker.expiryTimer.unref?.();
    }

    takeStandby()
    {
        const worker = this.standby;
        if (!worker || worker.exited) { this.standby = null; return null; }
        this.standby = null;
        clearTimeout(worker.expiryTimer);
        worker.expiryTimer = null;
        worker.retired = false;
        return worker;
    }

    rollback()
    {
        const fallback = this.takeStandby();
        if (!fallback) return null;
        const rejected = this.current;
        this.current = fallback;
        this.stopWhenDrained(rejected);
        log(`manual rollback from worker ${rejected?.generation ?? 'none'} to worker ${fallback.generation}`);
        return fallback;
    }

    async reload()
    {
        if (this.reloading) { this.reloadAgain = true; return; }
        this.reloading = true;
        try
        {
            const next = await this.spawnWorker();
            if (this.closing) { this.stopWorker(next); return; }
            if (this.reloadAgain)
            {
                log(`worker ${next.generation} healthy but superseded by a newer source event`);
                this.stopWorker(next);
                return;
            }
            const previous = this.current;
            this.current = next;
            log(`worker ${next.generation} healthy on ${next.port}; accepting new requests`);
            this.keepStandby(previous);
        }
        catch (error)
        {
            log(`reload rejected; last-good worker retained: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500)}`);
        }
        finally
        {
            this.reloading = false;
            if (this.reloadAgain && !this.closing)
            {
                this.reloadAgain = false;
                this.scheduleReload(0);
            }
        }
    }

    scheduleReload(wait = RELOAD_DEBOUNCE_MS)
    {
        if (this.closing) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), wait);
    }

    handle(request, response)
    {
        // Before /supervisorz, /rollbackz or the proxy: this is the process that
        // owns the public port, so it is the one that still sees the browser's
        // own Host. The worker only ever sees the Host rewritten below.
        if (rejectRequest(request, response, [request.socket.localPort])) return;
        const urlPath = (request.url || '').split('?')[0];
        if (request.method === 'GET' && urlPath === '/supervisorz')
        {
            response.writeHead(200, { 'Content-Type': 'application/json', 'X-Cuimod-Router-Supervisor': '1' });
            response.end(JSON.stringify({
                ok: true,
                currentGeneration: this.current?.generation ?? null,
                standbyGeneration: this.standby?.generation ?? null,
                rollbackWindowMs: this.rollbackWindowMs,
                retiredDrainTimeoutMs: this.retiredDrainTimeoutMs,
            }));
            return;
        }
        if (request.method === 'POST' && urlPath === '/rollbackz')
        {
            const worker = this.rollback();
            response.writeHead(worker ? 200 : 409, { 'Content-Type': 'application/json', 'X-Cuimod-Router-Supervisor': '1' });
            response.end(JSON.stringify(worker
                ? { ok: true, generation: worker.generation }
                : { type: 'error', error: { type: 'invalid_request_error', message: 'no warm standby generation is available' } }));
            return;
        }
        this.proxy(request, response);
    }

    proxy(request, response)
    {
        const worker = this.current;
        if (!worker || worker.exited)
        {
            response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1', 'X-Cuimod-Router-Supervisor': '1' });
            response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'router worker is reloading' } }));
            return;
        }

        worker.active++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            worker.active--;
            if (worker.retired && worker !== this.standby && worker.active === 0) this.stopWorker(worker);
        };
        const headers = { ...request.headers, host: `127.0.0.1:${worker.port}` };
        const healthRequest = request.method === 'GET' && (request.url || '').split('?')[0] === '/healthz';
        let incomingEnded = false;
        let healthFellBack = false;
        let healthTimer = null;
        const upstream = http.request({
            host: '127.0.0.1',
            port: worker.port,
            method: request.method,
            path: request.url,
            headers,
        }, incoming => {
            clearTimeout(healthTimer);
            const outgoing = { ...incoming.headers, 'x-cuimod-router-generation': String(worker.generation), 'x-cuimod-router-supervisor': '1' };
            response.writeHead(incoming.statusCode || 502, outgoing);
            incoming.on('error', error => { if (!response.writableEnded) response.destroy(error); });
            incoming.on('end', () => { incomingEnded = true; release(); });
            incoming.pipe(response);
        });
        upstream.on('error', error => {
            clearTimeout(healthTimer);
            release();
            if (healthFellBack) return;
            if (response.headersSent) { response.destroy(error); return; }
            response.writeHead(502, {
                'Content-Type': 'application/json',
                'X-Cuimod-Router-Generation': String(worker.generation),
                'X-Cuimod-Router-Supervisor': '1',
            });
            response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `router worker failure: ${error.message}` } }));
        });
        request.on('aborted', () => { upstream.destroy(); release(); });
        request.on('error', error => { upstream.destroy(error); release(); });
        response.on('close', () => {
            // A timed-out client can close its response after its request body was
            // fully received. Without this, the worker-side request survives and
            // repeated probes accumulate until the worker has dozens of orphaned
            // sockets and no event-loop capacity left for inference.
            if (!incomingEnded) upstream.destroy();
            release();
        });
        if (healthRequest)
        {
            healthTimer = setTimeout(() => {
                if (response.headersSent) return;
                healthFellBack = true;
                upstream.destroy();
                release();
                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'X-Cuimod-Router-Supervisor': '1' });
                response.end(JSON.stringify({ ok: true, supervisor: true, degraded: true,
                    currentGeneration: worker.generation }));
            }, 1000);
            healthTimer.unref?.();
        }
        request.pipe(upstream);
    }

    async start()
    {
        try
        {
            await new Promise((resolve, reject) => {
                this.server.once('error', reject);
                this.server.listen(this.port, '127.0.0.1', resolve);
            });
            // Reserve the public port before doing any expensive worker startup.
            // A duplicate contender now loses immediately instead of loading a
            // full worker and its ledgers only to discover EADDRINUSE afterward.
            await this.reload();
            if (!this.current) throw new Error('no healthy router worker');
            this.watcher = fs.watch(this.watchDir, { recursive: true }, (_event, filename) => {
                const name = String(filename || '').replace(/\\/g, '/');
                if (!name.endsWith('.mjs') || name === path.basename(fileURLToPath(import.meta.url))) return;
                this.scheduleReload();
            });
        }
        catch (error)
        {
            await this.close();
            throw error;
        }
        log(`listening 127.0.0.1:${this.port}; watching ${this.watchDir}`);
    }

    async close()
    {
        this.closing = true;
        clearTimeout(this.reloadTimer);
        this.watcher?.close();
        await new Promise(resolve => this.server.listening ? this.server.close(resolve) : resolve());
        for (const worker of this.workers) this.stopWorker(worker);
    }
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint)
{
    const supervisor = new RouterSupervisor();
    const stop = () => supervisor.close().finally(() => process.exit());
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('uncaughtException', error => log(`uncaughtException: ${error?.stack || error}`));
    process.on('unhandledRejection', error => log(`unhandledRejection: ${error?.stack || error}`));
    supervisor.start().catch(error => {
        log(`startup failed: ${error?.stack || error}`);
        process.exitCode = 1;
    });
}
