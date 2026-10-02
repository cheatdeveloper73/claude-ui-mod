import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterSupervisor } from '../router/supervisor.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function workerSource(version, exitAfterHealth = false, slowDurationMs = 350)
{
    return `import http from 'node:http';
const version=${JSON.stringify(version)};
const exitAfterHealth=${JSON.stringify(exitAfterHealth)};
const slowDurationMs=${JSON.stringify(slowDurationMs)};
const server=http.createServer((req,res)=>{
    if(req.url==='/healthz'){res.end(JSON.stringify({ok:true,version}));if(exitAfterHealth)setTimeout(()=>process.exit(17),10);return;}
    if(req.url==='/slow'){res.write(version+'-start\\n');setTimeout(()=>res.end(version+'-end\\n'),slowDurationMs);return;}
    if(req.url==='/hang'){res.write(version+'-start\\n');return;}
    res.end(version);
});
server.requestTimeout=0;server.listen(Number(process.env.MODEL_ROUTER_WORKER_PORT),'127.0.0.1');
`;
}

async function waitFor(predicate, label)
{
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline)
    {
        if (predicate()) return;
        await delay(25);
    }
    throw new Error(`timed out waiting for ${label}`);
}

test('supervisor swaps only healthy workers and drains old streams', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, rollbackWindowMs: 2000, canary: false });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v1');

        const slowResponse = await fetch(endpoint + '/slow');
        const reader = slowResponse.body.getReader();
        const first = Buffer.from((await reader.read()).value).toString();
        assert.equal(first, 'v1-start\n');

        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.current?.generation >= 2 && !supervisor.reloading, 'healthy v2 worker');
        const fresh = await fetch(endpoint + '/version');
        assert.equal(await fresh.text(), 'v2');
        assert.equal(fresh.headers.get('x-cuimod-router-generation'), '2');
        assert.equal(fresh.headers.get('x-cuimod-router-supervisor'), '1');

        let rest = '';
        for (;;)
        {
            const part = await reader.read();
            if (part.done) break;
            rest += Buffer.from(part.value).toString();
        }
        assert.equal(first + rest, 'v1-start\nv1-end\n');
        assert.equal(supervisor.standby?.generation, 1);
        const status = await (await fetch(endpoint + '/supervisorz')).json();
        assert.deepEqual({ current: status.currentGeneration, standby: status.standbyGeneration }, { current: 2, standby: 1 });

        const rollback = await fetch(endpoint + '/rollbackz', { method: 'POST' });
        assert.equal(rollback.status, 200);
        assert.equal((await rollback.json()).generation, 1);
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v1');
        await waitFor(() => [...supervisor.workers].every(worker => worker.generation !== 2), 'rejected v2 drain');

        fs.writeFileSync(entry, 'this is not valid JavaScript');
        await waitFor(() => supervisor.generation >= 3 && !supervisor.reloading, 'rejected invalid worker');
        assert.equal(supervisor.current.generation, 1);
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v1');

        fs.writeFileSync(entry, workerSource('v3'));
        await waitFor(() => supervisor.current?.generation >= 4 && !supervisor.reloading, 'healthy v3 worker');
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v3');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('rollback expiry keeps an active old response until it drains', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-long-drain-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1', false, 2200));
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0,
        rollbackWindowMs: 150, retiredDrainTimeoutMs: 4000, canary: false });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        const response = await fetch(endpoint + '/slow');
        const reader = response.body.getReader();
        const first = Buffer.from((await reader.read()).value).toString();
        const old = supervisor.current;
        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.current?.generation === 2 && !supervisor.reloading, 'long-drain replacement');
        await waitFor(() => supervisor.standby === null, 'long-drain rollback expiry');
        const status = await (await fetch(endpoint + '/supervisorz')).json();
        assert.equal(status.retiredDrainTimeoutMs, 4000);
        assert.equal(old.exited, false);
        assert.equal(old.active, 1);

        let rest = '';
        for (;;)
        {
            const part = await reader.read();
            if (part.done) break;
            rest += Buffer.from(part.value).toString();
        }
        assert.equal(first + rest, 'v1-start\nv1-end\n');
        await waitFor(() => old.exited, 'completed old response cleanup');
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v2');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('retired worker with a wedged response still has a hard drain deadline', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-wedged-drain-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0,
        rollbackWindowMs: 150, retiredDrainTimeoutMs: 600, canary: false });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        const response = await fetch(endpoint + '/hang');
        const reader = response.body.getReader();
        assert.equal(Buffer.from((await reader.read()).value).toString(), 'v1-start\n');
        const old = supervisor.current;
        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.current?.generation === 2 && !supervisor.reloading, 'wedged replacement');
        await waitFor(() => supervisor.standby === null, 'wedged rollback expiry');
        assert.equal(old.exited, false);
        await waitFor(() => old.exited, 'wedged retired worker deadline');
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v2');
        await reader.cancel().catch(() => {});
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('supervisor reloads when a nested adapter module changes', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-nested-watch-'));
    const entry = path.join(temp, 'worker.mjs');
    const adapter = path.join(temp, 'adapters', 'fixture', 'index.mjs');
    fs.mkdirSync(path.dirname(adapter), { recursive: true });
    fs.writeFileSync(entry, workerSource('v1'));
    fs.writeFileSync(adapter, 'export default 1;\n');
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, rollbackWindowMs: 2000, canary: false });

    try
    {
        await supervisor.start();
        assert.equal(supervisor.current?.generation, 1);
        fs.writeFileSync(adapter, 'export default 2;\n');
        await waitFor(() => supervisor.current?.generation >= 2 && !supervisor.reloading, 'nested adapter-triggered reload');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('supervisor automatically rolls back when the current worker exits', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-exit-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, rollbackWindowMs: 2000, canary: false });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.current?.generation === 2 && !supervisor.reloading, 'healthy v2 worker');
        assert.equal(supervisor.standby?.generation, 1);

        supervisor.stopWorker(supervisor.current);
        await waitFor(() => supervisor.current?.generation === 1, 'automatic rollback to v1');
        const response = await fetch(endpoint + '/version');
        assert.equal(await response.text(), 'v1');
        assert.equal(response.headers.get('x-cuimod-router-generation'), '1');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('supervisor rejects a healthy worker when its semantic canary fails', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-canary-'));
    const entry = path.join(temp, 'worker.mjs');
    const canary = path.join(temp, 'canary.mjs');
    const flag = path.join(temp, 'canary.txt');
    fs.writeFileSync(entry, workerSource('v1'));
    fs.writeFileSync(flag, 'ok');
    fs.writeFileSync(canary, `import fs from 'node:fs';\nif(fs.readFileSync(${JSON.stringify(flag)},'utf8').trim()!=='ok')throw new Error('semantic failure');\n`);
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, rollbackWindowMs: 2000, canary });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        fs.writeFileSync(flag, 'fail');
        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.generation >= 2 && !supervisor.reloading, 'rejected semantic failure');
        assert.equal(supervisor.current.generation, 1);
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v1');

        fs.writeFileSync(flag, 'ok');
        fs.writeFileSync(entry, workerSource('v3'));
        await waitFor(() => supervisor.current?.generation >= 3 && !supervisor.reloading, 'accepted canary recovery');
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v3');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('a supervisor that loses the public-port race closes its private worker', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-race-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    const owner = new RouterSupervisor({ entry, watchDir: temp, port: 0, canary: false });
    let contender = null;

    try
    {
        await owner.start();
        contender = new RouterSupervisor({ entry, watchDir: temp, port: owner.server.address().port, canary: false });
        await assert.rejects(contender.start(), error => error?.code === 'EADDRINUSE');
        await waitFor(() => contender.workers.size === 0, 'contending private worker cleanup');
    }
    finally
    {
        await contender?.close();
        await owner.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('a candidate that exits during its canary never replaces the current worker', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-canary-exit-'));
    const entry = path.join(temp, 'worker.mjs');
    const canary = path.join(temp, 'canary.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    fs.writeFileSync(canary, 'await new Promise(resolve=>setTimeout(resolve,150));\n');
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, canary });

    try
    {
        await supervisor.start();
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        fs.writeFileSync(entry, workerSource('v2', true));
        await waitFor(() => supervisor.generation >= 2 && !supervisor.reloading, 'candidate exit rejection');
        assert.equal(supervisor.current.generation, 1);
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v1');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('watcher startup failure closes the public listener and private worker', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-watch-'));
    const entry = path.join(temp, 'worker.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    const supervisor = new RouterSupervisor({ entry, watchDir: path.join(temp, 'missing'), port: 0, canary: false });

    try
    {
        await assert.rejects(supervisor.start(), error => error?.code === 'ENOENT');
        await waitFor(() => supervisor.workers.size === 0, 'watcher failure worker cleanup');
        assert.equal(supervisor.server.listening, false);
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('a source event during canary supersedes the partial candidate', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-supervisor-supersede-'));
    const entry = path.join(temp, 'worker.mjs');
    const canary = path.join(temp, 'canary.mjs');
    fs.writeFileSync(entry, workerSource('v1'));
    fs.writeFileSync(canary, 'await new Promise(resolve=>setTimeout(resolve,250));\n');
    const supervisor = new RouterSupervisor({ entry, watchDir: temp, port: 0, canary });

    try
    {
        await supervisor.start();
        fs.writeFileSync(entry, workerSource('v2'));
        await waitFor(() => supervisor.reloading && [...supervisor.workers].some(worker => worker.generation === 2), 'v2 canary');
        fs.writeFileSync(entry, workerSource('v3'));
        await waitFor(() => supervisor.current?.generation === 3 && !supervisor.reloading, 'final v3 candidate');
        assert.equal(supervisor.standby?.generation, 1);
        const endpoint = `http://127.0.0.1:${supervisor.server.address().port}`;
        assert.equal(await (await fetch(endpoint + '/version')).text(), 'v3');
    }
    finally
    {
        await supervisor.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
