#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.env.MODEL_ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'gemini-bridge');
const stamp = new Date().toISOString().replace(/:/g, '-');
const targets = ['provider-throughput-v1.jsonl', 'provider-usage-v1.jsonl', 'bridge.log'];

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function rotate(name)
{
    const active = path.join(root, name);
    let stat;
    try { stat = fs.statSync(active); } catch (_) { return null; }
    if (!stat.isFile() || stat.size === 0) return null;

    const stem = name.endsWith('.jsonl') ? name.slice(0, -6) : name.replace(/\.log$/, '');
    const staging = path.join(root, `${stem}.archive-${stamp}${name.endsWith('.jsonl') ? '.jsonl' : '.log'}`);
    const archive = staging + '.gz';
    const temporary = archive + '.tmp';

    // Rename first so concurrent appenders immediately create/use a new active
    // tail. No record can land in the bytes being compressed after this point.
    fs.renameSync(active, staging);
    const source = fs.readFileSync(staging);
    const compressed = zlib.gzipSync(source, { level: 9 });
    fs.writeFileSync(temporary, compressed);
    const restored = zlib.gunzipSync(fs.readFileSync(temporary));
    if (source.length !== restored.length || digest(source) !== digest(restored))
        throw new Error(`archive verification failed for ${name}`);
    fs.renameSync(temporary, archive);
    fs.unlinkSync(staging);
    return { name, logicalBytes: source.length, archiveBytes: compressed.length,
        ratio: Number((source.length / compressed.length).toFixed(1)), archive };
}

const archived = [];
for (const name of targets)
{
    const result = rotate(name);
    if (result) archived.push(result);
}
process.stdout.write(JSON.stringify({ root, archived }, null, 2) + '\n');
