'use strict';

const fs = require('fs');
const path = require('path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 128 * 1024;

class JsonlIndex {
    constructor(file) {
        this.file = file;
        this.timestamps = new Map();
        this.offset = 0;
        this.fragments = [];
        this.partialBytes = 0;
        this.identity = null;
    }

    reset() {
        this.timestamps.clear();
        this.offset = 0;
        this.fragments = [];
        this.partialBytes = 0;
    }

    record(buffer) {
        try {
            const line = JSON.parse(buffer.toString('utf8'));
            if (line.type !== 'assistant' || typeof line.uuid !== 'string' || !UUID.test(line.uuid)) return;
            if (typeof line.timestamp !== 'string' || !Number.isFinite(Date.parse(line.timestamp))) return;
            this.timestamps.set(line.uuid, new Date(line.timestamp).toISOString());
        } catch (_) { /* A torn or malformed record is not an assistant timestamp. */ }
    }

    consume(buffer) {
        let start = 0;
        for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
            const part = buffer.subarray(start, end);
            if (this.fragments.length) {
                this.fragments.push(part);
                this.record(Buffer.concat(this.fragments, this.partialBytes + part.length));
                this.fragments = [];
                this.partialBytes = 0;
            } else {
                this.record(part);
            }
            start = end + 1;
        }
        if (start < buffer.length) {
            const rest = Buffer.from(buffer.subarray(start));
            this.fragments.push(rest);
            this.partialBytes += rest.length;
        }
    }

    async update() {
        const handle = await fs.promises.open(this.file, 'r');
        try {
            const stat = await handle.stat();
            const identity = stat.dev + ':' + stat.ino;
            if (this.identity !== null && (this.identity !== identity || stat.size < this.offset)) this.reset();
            this.identity = identity;
            const end = stat.size;
            const chunk = Buffer.allocUnsafe(CHUNK);
            while (this.offset < end) {
                const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK, end - this.offset), this.offset);
                if (!bytesRead) break;
                this.consume(chunk.subarray(0, bytesRead));
                this.offset += bytesRead;
            }
        } finally {
            await handle.close();
        }
        return this;
    }

    get(uuid) {
        return this.timestamps.get(uuid) || null;
    }
}

async function findSessionFile(projectsRoot, sessionId) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
    let projects;
    try { projects = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); }
    catch (_) { return null; }
    for (const project of projects) {
        if (!project.isDirectory()) continue;
        const file = path.join(projectsRoot, project.name, sessionId + '.jsonl');
        try { if ((await fs.promises.stat(file)).isFile()) return file; }
        catch (_) {}
    }
    return null;
}

module.exports = { JsonlIndex, findSessionFile, UUID };
