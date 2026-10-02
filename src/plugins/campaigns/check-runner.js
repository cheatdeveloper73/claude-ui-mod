'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { fingerprint } = require('./revision');

function missingMarkers(files, markers) {
    const pending = new Map(markers.map(marker => [marker, Buffer.from(marker)]));
    const overlap = Math.max(1, ...[...pending.values()].map(value => value.length));
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.allocUnsafe(65536);
        let tail = Buffer.alloc(0);
        try {
            for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
                const bytes = Buffer.concat([tail, buffer.subarray(0, size)]);
                for (const [marker, needle] of pending) if (bytes.includes(needle)) pending.delete(marker);
                tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - overlap)));
            }
        } finally { fs.closeSync(fd); }
    }
    return [...pending.keys()];
}

// Invoked by the native Bash tool after the campaign records the exact request.
// A missing terminal record stays incomplete even when a GUI or wrapper exits 0.
function run(requestFile) {
    const requestBytes = fs.readFileSync(requestFile);
    const request = JSON.parse(requestBytes);
    if (request.version !== 1 || !path.isAbsolute(request.cwd) || typeof request.executable !== 'string'
        || !Array.isArray(request.args) || !request.args.every(value => typeof value === 'string')) throw Error('invalid check request');
    const dir = path.dirname(requestFile);
    const lock = fs.openSync(path.join(dir, 'started.lock'), 'wx');
    fs.writeSync(lock, String(process.pid)); fs.closeSync(lock);
    const resultPath = path.join(dir, 'result.json');
    const base = { version: 1, id: request.id, requestSha256: crypto.createHash('sha256').update(requestBytes).digest('hex'),
        sourceRevision: request.sourceRevision, startedAt: new Date().toISOString(), cwd: request.cwd,
        executable: request.executable, args: request.args, platform: process.platform, node: process.version };
    function save(value) {
        fs.writeFileSync(resultPath + '.new', JSON.stringify({ ...base, ...value }, null, 2));
        fs.renameSync(resultPath + '.new', resultPath);
    }
    save({ terminal: false, exitCode: null, status: 'running' });
    const stdout = fs.openSync(path.join(dir, 'stdout.log'), 'wx');
    const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'wx');
    let finished = false;
    function finish(code, signal, error) {
        if (finished) return;
        finished = true;
        fs.fsyncSync(stdout); fs.fsyncSync(stderr);
        fs.closeSync(stdout); fs.closeSync(stderr);
        const terminal = !error && Number.isInteger(code) && !signal;
        const outputs = [path.join(dir, 'stdout.log'), path.join(dir, 'stderr.log')];
        const artifacts = [];
        const missingArtifacts = [];
        for (const file of request.artifacts || []) {
            try { artifacts.push(fingerprint(file)); } catch (_) { missingArtifacts.push(file); }
        }
        for (const before of request.completionFiles || []) {
            try {
                const after = fingerprint(before.path);
                if (after.sha256 !== before.sha256) { outputs.push(after.path); artifacts.push(after); }
            } catch (_) { /* A missing or unchanged old log cannot prove completion. */ }
        }
        const missing = missingMarkers(outputs, request.successMarkers || []);
        save({ terminal, exitCode: Number.isInteger(code) ? code : null, signal: signal || null,
            error: error ? String(error.message || error) : null, finishedAt: new Date().toISOString(), artifacts,
            missingMarkers: missing, missingArtifacts,
            status: !terminal ? 'incomplete' : code !== 0 ? 'failed' : missing.length || missingArtifacts.length ? 'incomplete' : 'passed' });
        process.stdout.write(JSON.stringify({ campaignCheck: request.id, terminal, exitCode: code, resultPath }) + '\n');
        process.exitCode = terminal && code === 0 && missing.length === 0 && missingArtifacts.length === 0 ? 0 : 1;
    }
    let child;
    try {
        child = spawn(request.executable, request.args, { cwd: request.cwd, windowsHide: true,
            shell: false, stdio: ['ignore', stdout, stderr] });
    } catch (error) { finish(null, null, error); return; }
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
}

if (require.main === module) {
    try { run(path.resolve(process.argv[2] || '')); }
    catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; }
}
module.exports = { run };
