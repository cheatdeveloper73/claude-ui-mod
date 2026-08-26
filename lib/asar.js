'use strict';
// Minimal asar reader/patcher. A replaced file's new bytes are appended past the
// end of the existing data region and the header entry is re-pointed at them.
// Every other entry keeps its original offset, so all `unpacked` flags and every
// other file's integrity record stay byte-identical.
const fs = require('fs');
const crypto = require('crypto');

const align4 = (n) => (n + 3) & ~3;

function readHeader(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const p = Buffer.alloc(16);
        fs.readSync(fd, p, 0, 16, 0);
        if (p.readUInt32LE(0) !== 4) throw new Error('not an asar (bad pickle prologue)');
        const headerPickleSize = p.readUInt32LE(4);
        const jsonLen = p.readUInt32LE(12);
        const jb = Buffer.alloc(jsonLen);
        fs.readSync(fd, jb, 0, jsonLen, 16);
        return {
            header: JSON.parse(jb.toString('utf8')),
            dataStart: 8 + headerPickleSize,
            fileSize: fs.fstatSync(fd).size,
        };
    } finally {
        fs.closeSync(fd);
    }
}

function entryFor(header, relPath) {
    const parts = relPath.split('/');
    let node = header;
    for (let i = 0; i < parts.length; i++) {
        if (!node.files || !node.files[parts[i]]) return null;
        node = node.files[parts[i]];
    }
    return node;
}

function readFile(file, relPath) {
    const { header, dataStart } = readHeader(file);
    const e = entryFor(header, relPath);
    if (!e || e.files) throw new Error('no such file in asar: ' + relPath);
    if (e.unpacked) throw new Error('entry is unpacked: ' + relPath);
    const fd = fs.openSync(file, 'r');
    try {
        const b = Buffer.alloc(e.size);
        fs.readSync(fd, b, 0, e.size, dataStart + Number(e.offset));
        return b;
    } finally {
        fs.closeSync(fd);
    }
}

// SHA256 of the header JSON bytes — the value Electron's asar_util.cc checks
// against the hash embedded in claude.exe.
function headerHash(file) {
    const { header } = readHeader(file);
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    return crypto.createHash('sha256').update(json).digest('hex');
}

function integrityFor(buf) {
    const BLOCK = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < buf.length || i === 0; i += BLOCK) {
        blocks.push(crypto.createHash('sha256').update(buf.subarray(i, Math.min(i + BLOCK, buf.length))).digest('hex'));
    }
    return {
        algorithm: 'SHA256',
        hash: crypto.createHash('sha256').update(buf).digest('hex'),
        blockSize: BLOCK,
        blocks,
    };
}

// replacements: { 'rel/path.js': Buffer, ... }
function writePatched(srcFile, dstFile, replacements) {
    const { header, dataStart, fileSize } = readHeader(srcFile);
    let dataLen = fileSize - dataStart;

    const appends = [];
    for (const [rel, buf] of Object.entries(replacements)) {
        const e = entryFor(header, rel);
        if (!e || e.files) throw new Error('no such file in asar: ' + rel);
        if (e.unpacked) throw new Error('cannot replace an unpacked entry: ' + rel);
        e.offset = String(dataLen);
        e.size = buf.length;
        if (e.integrity) e.integrity = integrityFor(buf);
        appends.push(buf);
        dataLen += buf.length;
    }

    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const padded = align4(json.length);
    const headerStringSize = padded + 4;
    const headerPickleSize = headerStringSize + 4;

    const out = fs.openSync(dstFile, 'w');
    try {
        const pre = Buffer.alloc(16 + (padded - json.length));
        pre.writeUInt32LE(4, 0);
        pre.writeUInt32LE(headerPickleSize, 4);
        pre.writeUInt32LE(headerStringSize, 8);
        pre.writeUInt32LE(json.length, 12);
        fs.writeSync(out, pre.subarray(0, 16));
        fs.writeSync(out, json);
        if (padded > json.length) fs.writeSync(out, Buffer.alloc(padded - json.length));

        const src = fs.openSync(srcFile, 'r');
        try {
            const CH = 8 * 1024 * 1024;
            const buf = Buffer.alloc(CH);
            let pos = dataStart;
            while (pos < fileSize) {
                const n = fs.readSync(src, buf, 0, Math.min(CH, fileSize - pos), pos);
                if (n <= 0) break;
                fs.writeSync(out, buf, 0, n);
                pos += n;
            }
        } finally {
            fs.closeSync(src);
        }

        for (const b of appends) fs.writeSync(out, b);
    } finally {
        fs.closeSync(out);
    }
    // The hash Electron will compute over this archive's header.
    return crypto.createHash('sha256').update(json).digest('hex');
}

// Repoint the Electron ASAR-integrity resource embedded in the app executable
// so it expects `newHash` for resources/app.asar. The value is a 64-char ASCII
// hex string inside a JSON blob in the PE; replacing it is length-preserving.
// Returns { oldHash, offset }. Throws if the field is absent or ambiguous.
function repointExeIntegrity(exeFile, newHash, backupFile) {
    if (!/^[0-9a-f]{64}$/.test(newHash)) throw new Error('bad newHash');
    const buf = fs.readFileSync(exeFile);
    // ..."<path>app.asar","alg":"SHA256","value":"<64 hex>"
    const re = /(app\.asar","alg":"SHA256","value":")([0-9a-f]{64})/g;
    const hits = [];
    let m;
    while ((m = re.exec(buf.toString('latin1'))) !== null) hits.push({ index: m.index + m[1].length, old: m[2] });
    if (hits.length === 0) throw new Error('asar integrity field not found in exe');
    if (hits.length > 1) throw new Error('multiple asar integrity fields in exe (' + hits.length + ')');
    const { index, old } = hits[0];
    if (old === newHash) return { oldHash: old, offset: index, changed: false };
    if (backupFile && !fs.existsSync(backupFile)) fs.copyFileSync(exeFile, backupFile);
    const fd = fs.openSync(exeFile, 'r+');
    try {
        fs.writeSync(fd, Buffer.from(newHash, 'latin1'), 0, 64, index);
    } finally {
        fs.closeSync(fd);
    }
    return { oldHash: old, offset: index, changed: true };
}

module.exports = { readHeader, entryFor, readFile, writePatched, integrityFor, headerHash, repointExeIntegrity };
