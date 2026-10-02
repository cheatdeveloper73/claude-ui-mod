'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ensure, directory, inside, hash } = require('./core');

function fingerprint(file) {
    const real = fs.realpathSync(file);
    const before = fs.statSync(real);
    ensure(before.isFile(), 'evidence is not a file: ' + real);
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(65536);
    const fd = fs.openSync(real, 'r');
    try {
        for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, size));
        const after = fs.fstatSync(fd);
        ensure(before.size === after.size && before.mtimeMs === after.mtimeMs, 'file changed while fingerprinting: ' + real);
    } finally { fs.closeSync(fd); }
    return { path: real, bytes: before.size, sha256: digest.digest('hex') };
}

function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], {
        windowsHide: true, encoding: null, maxBuffer: 64 * 1024 * 1024,
        timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
}

function untracked(root) {
    return git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
        .toString('utf8').split('\0').filter(Boolean).sort().map(name => {
            const file = path.resolve(root, name);
            ensure(inside(file, root), 'untracked path escapes its source root');
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) return { path: name, link: fs.readlinkSync(file) };
            const ref = fingerprint(file);
            ensure(inside(ref.path, root), 'untracked file resolves outside its source root');
            return { path: name, bytes: ref.bytes, sha256: ref.sha256 };
        });
}

function tree(root) {
    const files = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === '.git') continue;
            const file = path.join(dir, entry.name);
            const name = path.relative(root, file).replace(/\\/g, '/');
            if (entry.isSymbolicLink()) files.push({ path: name, link: fs.readlinkSync(file) });
            else if (entry.isDirectory()) walk(file);
            else if (entry.isFile()) {
                const ref = fingerprint(file);
                files.push({ path: name, bytes: ref.bytes, sha256: ref.sha256 });
            }
        }
    }
    walk(root);
    return { root, kind: 'directory', files };
}

function headRef(root) {
    try { return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).toString('utf8').trim(); }
    catch (error) { if (error.status === 1) return null; throw error; }
}

function captureRoot(value) {
    const root = directory(value);
    let isGit = false;
    try { isGit = git(root, ['rev-parse', '--is-inside-work-tree']).toString('utf8').trim() === 'true'; }
    catch (error) {
        if (!String(error.stderr || '').includes('not a git repository')) throw error;
    }
    if (!isGit) return tree(root);
    const head = headRef(root);
    const index = hash(git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--', '.']));
    const working = hash(git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', '.']));
    const files = untracked(root);
    // The CLI may be writing while another task asks for a checkpoint. Refuse a
    // moving capture instead of binding successful checks to a hybrid revision.
    ensure(head === headRef(root)
        && index === hash(git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--', '.']))
        && working === hash(git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--', '.']))
        && hash(JSON.stringify(files)) === hash(JSON.stringify(untracked(root))), 'source changed during checkpoint capture');
    return { root, kind: 'git', head, index, working, untracked: files };
}

function captureRevision(roots, inputs = []) {
    ensure(Array.isArray(roots) && roots.length > 0, 'a source revision needs its actual source roots');
    const manifest = {
        version: 1,
        roots: [...new Set(roots.map(directory))].sort().map(captureRoot),
        inputs: [...new Set(inputs)].sort().map(fingerprint),
    };
    return { ...manifest, id: hash(JSON.stringify(manifest)) };
}

function verifyRevision(revision) {
    ensure(revision?.version === 1 && Array.isArray(revision.roots), 'unsupported source revision');
    const current = captureRevision(revision.roots.map(root => root.root), revision.inputs.map(ref => ref.path));
    ensure(current.id === revision.id, 'source revision changed; prior verification remains historical');
    return current;
}

function verifyEvidence(ref) {
    const current = fingerprint(ref.path);
    ensure(current.sha256 === ref.sha256 && current.bytes === ref.bytes, 'evidence changed: ' + ref.path);
}

module.exports = { fingerprint, captureRoot, captureRevision, verifyRevision, verifyEvidence };
