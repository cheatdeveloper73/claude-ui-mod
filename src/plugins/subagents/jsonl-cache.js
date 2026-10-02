'use strict';
const fs = require('fs');

// CLI transcripts append to a stable file. Keep the unfinished line as bytes:
// both JSON records and multi-byte UTF-8 characters can cross write boundaries.
// Rotation, truncation and same-size rewrites start a fresh aggregate. On growth,
// small prefix/tail anchors also reject truncate-and-rewrite of that same inode.
module.exports = function jsonlCache(create, record, options = {}) {
    const cache = new Map();
    const chunk = 256 * 1024, anchor = 64;
    const maxEntries = options.maxEntries || 64;
    const maxBytes = options.maxBytes || 64 * 1024 * 1024;
    const stats = { reads: 0, bytes: 0, lines: 0, hits: 0, resets: 0, evictions: 0 };
    const identity = st => [st.dev, st.ino, st.birthtimeMs].join(':');
    const stamp = st => [st.size, st.mtimeMs, st.ctimeMs].join(':');
    function bytes(fd, at, size) {
        const buf = Buffer.alloc(size);
        const n = size ? fs.readSync(fd, buf, 0, size, at) : 0;
        if (size) { stats.reads++; stats.bytes += n; }
        return buf.subarray(0, n);
    }
    function read(file, variant = '') {
        const key = file + '\0' + variant;
        let fd;
        try {
            const st = fs.statSync(file);
            let entry = cache.get(key);
            if (entry && entry.identity === identity(st) && entry.stamp === stamp(st)) {
                stats.hits++; cache.delete(key); cache.set(key, entry); return entry.state;
            }
            fd = fs.openSync(file, 'r');
            const current = fs.fstatSync(fd);
            let append = entry && entry.identity === identity(current) && current.size > entry.offset;
            if (append && entry.offset) {
                append = bytes(fd, 0, entry.head.length).equals(entry.head)
                    && bytes(fd, entry.offset - entry.tail.length, entry.tail.length).equals(entry.tail);
            }
            if (!append) {
                if (entry) stats.resets++;
                entry = { identity: identity(current), offset: 0, carry: Buffer.alloc(0),
                    state: create(variant), head: Buffer.alloc(0), tail: Buffer.alloc(0) };
            }
            while (entry.offset < current.size) {
                const next = bytes(fd, entry.offset, Math.min(chunk, current.size - entry.offset));
                if (!next.length) throw Error('transcript changed during read');
                if (entry.head.length < anchor) entry.head = Buffer.from(Buffer.concat([entry.head, next]).subarray(0, anchor));
                entry.tail = Buffer.from(Buffer.concat([entry.tail, next]).subarray(-anchor));
                entry.offset += next.length;
                const block = entry.carry.length ? Buffer.concat([entry.carry, next]) : next;
                let from = 0, end;
                while ((end = block.indexOf(10, from)) !== -1) {
                    record(entry.state, block.subarray(from, end).toString('utf8'));
                    stats.lines++; from = end + 1;
                }
                entry.carry = Buffer.from(block.subarray(from));
            }
            // Observe only this opened file's snapshot; an append during the
            // read is picked up on the next call, never marked as consumed.
            entry.stamp = stamp(current);
            cache.delete(key); cache.set(key, entry);
            let retained = 0;
            for (const value of cache.values()) retained += value.offset;
            for (const [oldKey, value] of cache) {
                if (cache.size <= maxEntries && retained <= maxBytes) break;
                cache.delete(oldKey); retained -= value.offset; stats.evictions++;
            }
            return entry.state;
        } catch (error) {
            cache.delete(key); throw error;
        } finally { if (fd != null) fs.closeSync(fd); }
    }
    return { read, clear: () => cache.clear(), stats: () => ({ ...stats, entries: cache.size }) };
};
