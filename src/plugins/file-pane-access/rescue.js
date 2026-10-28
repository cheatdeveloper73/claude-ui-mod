'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WIN = path.win32;
const UUID_RE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CLI_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// SessionFileAccess.SESSION_FILE_MAX_BYTES in app 2.7032.0.
const MAX_BYTES = 10 * 1024 * 1024;
// The largest transcript on disk was 86 MB on 2026-09-26. Only the tail is
// scanned past this, and the newest mention is the one wanted anyway.
const TRANSCRIPT_MAX_BYTES = 128 * 1024 * 1024;
// The scan runs in the main process, which also paints every window. One chunk
// costs a few ms; the whole 86 MB transcript in one go stalled it ~290 ms.
const TRANSCRIPT_CHUNK = 1024 * 1024;
// A mention's left context is at most 1024 path characters, all ASCII, so a
// 2 KiB overlap gives every match its full context in the chunk it ends in.
const TRANSCRIPT_OVERLAP = 2048;

function sessionsRoot() {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'Claude', 'claude-code-sessions');
}

function projectsRoot() {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// The session JSON lives at <root>/<account>/<workspace>/local_<uuid>.json.
// Returns the roots the shell grants, cwd first, and the CLI transcript id.
function readSession(sessionId, root = sessionsRoot()) {
    const none = { roots: [], cliSessionId: null };
    const match = UUID_RE.exec(String(sessionId || ''));
    if (!match) return none;
    const filename = 'local_' + match[1].toLowerCase() + '.json';
    let accounts;
    try { accounts = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return none; }
    for (const account of accounts) {
        if (!account.isDirectory()) continue;
        let workspaces;
        try { workspaces = fs.readdirSync(path.join(root, account.name), { withFileTypes: true }); } catch (_) { continue; }
        for (const workspace of workspaces) {
            if (!workspace.isDirectory()) continue;
            let data;
            try { data = JSON.parse(fs.readFileSync(path.join(root, account.name, workspace.name, filename), 'utf8')); } catch (_) { continue; }
            if (!data) continue;
            // The identical cwd can name the PC standby copy and guest authority.
            // A native remote miss must not be rescued from this machine's disk.
            if (data.sshConfig || data.wslConfig || data.remoteTarget || data.backend?.remoteTarget) return none;
            const extra = Array.isArray(data.additionalDirectories) ? data.additionalDirectories : [];
            const roots = [data.cwd, data.originCwd, data.worktreePath, data.harnessCwd, ...extra]
                .filter((p) => typeof p === 'string' && WIN.isAbsolute(p) && !isRemoteOrDevice(p))
                .map((p) => WIN.normalize(p));
            const cli = typeof data.cliSessionId === 'string' && CLI_ID_RE.test(data.cliSessionId) ? data.cliSessionId : null;
            return { roots: [...new Set(roots)], cliSessionId: cli };
        }
    }
    return none;
}

// The CLI writes <projects>/<sanitized cwd>/<cliSessionId>.jsonl. Probing every
// project directory avoids re-deriving the CLI's sanitizer.
function transcriptPath(cliSessionId, root = projectsRoot()) {
    if (!cliSessionId) return null;
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const candidate = path.join(root, dir.name, cliSessionId + '.jsonl');
        if (existingFile(candidate)) return candidate;
    }
    return null;
}

// UNC and device paths are refused, as the shell refuses them: opening one can
// hand NTLM credentials to a remote host just by rendering a link.
function isRemoteOrDevice(p) {
    return /^[\\/]{2}/.test(p);
}

function existingFile(p) {
    try {
        const stat = fs.statSync(p);
        return stat.isFile() ? stat : null;
    } catch (_) { return null; }
}

// Chat links can carry an editor-style suffix (file.cpp:31, :31-40). Drop it only
// when the literal path is not a file.
function tryFile(absolute) {
    if (isRemoteOrDevice(absolute)) return null;
    let stat = existingFile(absolute);
    if (stat) return { abs: absolute, stat };
    const stripped = absolute.replace(/:\d+(?:[-:]\d+)?$/, '');
    if (stripped === absolute) return null;
    stat = existingFile(stripped);
    return stat ? { abs: stripped, stat } : null;
}

function segmentsOf(p) {
    return String(p).replace(/:\d+(?:[-:]\d+)?$/, '').split(/[\\/]+/).filter((s) => s && s !== '.');
}

function endsWithSegments(abs, want) {
    const have = abs.split(/[\\/]+/);
    if (have.length < want.length) return false;
    const tail = have.slice(have.length - want.length);
    return tail.every((s, i) => s.toLowerCase() === want[i].toLowerCase());
}

function ancestors(roots) {
    const out = [];
    for (const root of roots) {
        for (let dir = WIN.dirname(root); ; dir = WIN.dirname(dir)) {
            out.push(dir);
            if (WIN.dirname(dir) === dir) break;
        }
    }
    return out;
}

function tryBases(raw, bases) {
    for (const base of new Set(bases)) {
        const found = tryFile(WIN.resolve(base, raw));
        if (found) return found;
    }
    return null;
}

const PATH_CHAR = /[A-Za-z0-9_.\-~$+@\\/:]/;
const NAME_CHAR = /[A-Za-z0-9_.\-]/;
const JSON_ESCAPE = new Set(['n', 't', 'r', '"', 'b', 'f', 'u']);
// An absolute path start: a drive (C:\, C:/) or Git Bash's /c/.
const ABS_START = /[A-Za-z]:[\\/]|[\\/][A-Za-z][\\/]/g;

// Decodes a run of raw JSONL text into plain text. A JSON escape other than \\
// or \/ is a break (a newline or quote between two tokens), not path text.
// Nested JSON leaves runs of backslashes, which a path separator collapses.
function decodeRun(run) {
    let out = '';
    for (let i = 0; i < run.length; i++) {
        const c = run[i];
        if (c !== '\\') { out += c; continue; }
        const next = run[i + 1];
        if (next === '\\' || next === '/') { out += next; i++; continue; }
        if (JSON_ESCAPE.has(next)) { out += ' '; i++; continue; }
        out += c;
    }
    return out;
}

function normalizeMention(text) {
    let p = text;
    const bash = /^[\\/]([A-Za-z])[\\/]/.exec(p);
    if (bash) p = bash[1].toUpperCase() + ':\\' + p.slice(3);
    return WIN.normalize(p.replace(/[\\/]+/g, '\\'));
}

// The agent names a file in prose by its bare name, but it read, edited, listed
// or searched it by absolute path first, and all of that is in the transcript.
// The newest absolute mention whose trailing segments match the link and which
// still exists is the file the link means. `clipped` says the text starts
// mid-file, so a mention reaching its first character may be cut off; the next
// chunk back sees that one whole.
function findInTranscript(text, want, clipped = false) {
    const base = want[want.length - 1];
    if (!base) return null;
    let needle = base.toLowerCase();
    let lower = text.toLowerCase();
    // Lowercasing can change the length of some non-ASCII text, which would
    // misalign every index below. Fall back to a case-sensitive scan.
    if (lower.length !== text.length) { needle = base; lower = text; }
    for (let at = lower.lastIndexOf(needle); at !== -1; at = at > 0 ? lower.lastIndexOf(needle, at - 1) : -1) {
        const end = at + needle.length;
        if (end < text.length && NAME_CHAR.test(text[end])) continue;
        let start = at;
        while (start > 0 && end - start < 1024 && PATH_CHAR.test(text[start - 1])) start--;
        if (start === 0 && clipped) continue;
        const decoded = decodeRun(text.slice(start, end)).split(' ').pop();
        ABS_START.lastIndex = 0;
        for (let m = ABS_START.exec(decoded); m; m = ABS_START.exec(decoded)) {
            const abs = normalizeMention(decoded.slice(m.index));
            if (!endsWithSegments(abs, want)) continue;
            const found = tryFile(abs);
            if (found) return found;
        }
    }
    return null;
}

// Newest first, one chunk per await, so the main process keeps painting and a
// recent mention returns without reading the rest.
async function scanTranscript(file, want) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const { size } = await handle.stat();
        const floor = Math.max(0, size - TRANSCRIPT_MAX_BYTES);
        const buffer = Buffer.alloc(TRANSCRIPT_CHUNK + TRANSCRIPT_OVERLAP);
        for (let end = size; end > floor; end -= TRANSCRIPT_CHUNK) {
            const from = Math.max(floor, end - TRANSCRIPT_CHUNK - TRANSCRIPT_OVERLAP);
            const { bytesRead } = await handle.read(buffer, 0, end - from, from);
            const found = findInTranscript(buffer.toString('utf8', 0, bytesRead), want, from > floor);
            if (found) return found;
        }
        return null;
    } finally {
        await handle.close();
    }
}

function gitFiles(root) {
    return new Promise((resolve) => {
        execFile('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 * 1024 },
            (err, stdout) => resolve(err ? [] : String(stdout).split('\0').filter(Boolean)));
    });
}

// Last resort for a name the transcript never spelled out absolutely: a file
// inside a root whose trailing segments match. The shallowest match wins.
async function findInRoots(roots, want, list = gitFiles) {
    let best = null;
    for (const root of roots) {
        for (const rel of await list(root)) {
            if (!endsWithSegments(rel, want)) continue;
            const depth = rel.split('/').length;
            if (best && best.depth <= depth) continue;
            const found = tryFile(WIN.resolve(root, rel));
            if (found) best = { depth, found };
        }
        if (best) return best.found;
    }
    return null;
}

// Resolution order, cheapest and most certain first: the literal path in each
// granted root; the newest absolute mention in the session's transcript; each
// root's ancestors, for links written relative to a parent of the cwd
// (server/src/x.cpp from a sibling checkout's session); then a search
// of the roots' tracked files. The shell itself tries only the cwd.
async function resolveFile(filePath, session, deps = {}) {
    const raw = String(filePath || '').trim();
    if (!raw || isRemoteOrDevice(raw)) return null;
    if (WIN.isAbsolute(raw)) return tryFile(WIN.normalize(raw));
    const want = segmentsOf(raw);
    if (!want.length || want.includes('..')) return tryBases(raw, session.roots);
    const inRoots = tryBases(raw, session.roots);
    if (inRoots) return inRoots;
    const transcript = (deps.transcriptPath || transcriptPath)(session.cliSessionId);
    if (transcript) {
        let mentioned = null;
        try { mentioned = await scanTranscript(transcript, want); } catch (_) {}
        if (mentioned) return mentioned;
    }
    const above = tryBases(raw, ancestors(session.roots));
    if (above) return above;
    return findInRoots(session.roots, want, deps.gitFiles);
}

// Mirrors SessionFileAccess.readUtf8FileWithCapStatus. The hash is omitted on
// purpose: the shell includes it only for files inside its write roots, and its
// absence is the shell's own read-only form.
function readFile(abs, stat, options) {
    const tailBytes = options && options.tailBytes;
    if (tailBytes !== undefined && tailBytes > 0 && stat.size > tailBytes) {
        const size = Math.min(tailBytes, MAX_BYTES);
        let fd = null;
        try {
            fd = fs.openSync(abs, 'r');
            const buffer = Buffer.alloc(size);
            const read = fs.readSync(fd, buffer, 0, size, stat.size - size);
            let start = 0;
            while (start < read && (buffer[start] & 0xc0) === 0x80) start++;
            return { status: 'ok', file: { contents: buffer.subarray(start, read).toString('utf-8'), absPath: abs, fileSize: stat.size, isTail: true } };
        } catch (_) {
            return { status: 'readError' };
        } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
        }
    }
    if (stat.size > MAX_BYTES) return { status: 'tooLarge', maxBytes: MAX_BYTES };
    try {
        const bytes = fs.readFileSync(abs);
        return { status: 'ok', file: { contents: bytes.toString('utf-8'), absPath: abs, fileSize: bytes.length } };
    } catch (_) {
        return { status: 'readError' };
    }
}

// Resolves to a replacement response, or null to keep the shell's own answer.
async function rescue(sessionId, filePath, options, deps = {}) {
    const session = (deps.readSession || readSession)(sessionId);
    const found = await resolveFile(filePath, session, deps);
    if (!found) return null;
    return readFile(found.abs, found.stat, options);
}

module.exports = { MAX_BYTES, TRANSCRIPT_CHUNK, readSession, transcriptPath, findInTranscript, resolveFile, readFile, rescue };
