'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rescue = require('../src/plugins/file-pane-access/rescue');
const plugin = require('../src/plugins/file-pane-access/main');

const SUFFIX = '_$_claude.web_$_LocalSessions_$_readSessionFileWithStatus';
const SID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cuimod-file-pane-'));
const cwd = path.join(tempRoot, 'repo');
const elsewhere = path.join(tempRoot, 'elsewhere');
fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });
const inCwd = path.join(cwd, 'src', 'main.cpp');
const outside = path.join(elsewhere, 'notes.md');
fs.writeFileSync(inCwd, 'int main() {}\n', 'utf8');
fs.writeFileSync(outside, '# notes\n', 'utf8');
const deps = {
    readSession: (sid) => (sid === SID ? { roots: [cwd], cliSessionId: null } : { roots: [], cliSessionId: null }),
    gitFiles: async () => [],
};

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('an existing file outside the granted roots comes back in the shell\'s ok shape', async () => {
    const result = await rescue.rescue(SID, outside.split(path.sep).join('/'), undefined, deps);
    assert.deepEqual(result, { status: 'ok', file: { contents: '# notes\n', absPath: outside, fileSize: 8 } });
    assert.equal('hash' in result.file, false);
});

test('relative paths resolve against the session cwd and line suffixes are dropped', async () => {
    assert.equal((await rescue.rescue(SID, 'src/main.cpp', undefined, deps)).file.absPath, inCwd);
    assert.equal((await rescue.rescue(SID, inCwd + ':31', undefined, deps)).file.absPath, inCwd);
    assert.equal((await rescue.rescue(SID, inCwd + ':31-40', undefined, deps)).file.absPath, inCwd);
});

test('a relative link into a sibling repo resolves against the cwd\'s ancestors', async () => {
    const sibling = path.join(tempRoot, 'server', 'src', 'simulation.cpp');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'void tick() {}\n', 'utf8');
    assert.equal((await rescue.rescue(SID, 'server/src/simulation.cpp', undefined, deps)).file.absPath, sibling);
    assert.equal((await rescue.rescue(SID, 'server/src/simulation.cpp:509', undefined, deps)).file.absPath, sibling);
    // The cwd's own copy wins over an ancestor's.
    fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'src', 'main.cpp'), 'shadow\n', 'utf8');
    assert.equal((await rescue.rescue(SID, 'src/main.cpp', undefined, deps)).file.absPath, inCwd);
});

test('a bare file name resolves to the newest existing absolute mention in the transcript', async () => {
    const older = path.join(tempRoot, 'server', 'engine', 'physics.cpp');
    const newer = path.join(tempRoot, 'client', 'engine', 'physics.cpp');
    for (const f of [older, newer]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, f, 'utf8'); }
    const bash = '/' + newer[0].toLowerCase() + newer.slice(2).split(path.sep).join('/');
    const transcript = path.join(tempRoot, 'session.jsonl');
    const line = (text) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
    fs.writeFileSync(transcript,
        line('Read ' + older)
        + line('$ find . -name physics.cpp\n' + bash + '\n')
        + line('gone: ' + path.join(tempRoot, 'deleted', 'engine', 'physics.cpp'))
        + line('see `physics.cpp:12`'), 'utf8');
    const withTranscript = { ...deps, readSession: () => ({ roots: [cwd], cliSessionId: 'x' }), transcriptPath: () => transcript };
    // Git Bash form, JSON-escaped newline in front, newest existing mention wins.
    assert.equal((await rescue.rescue(SID, 'physics.cpp', undefined, withTranscript)).file.absPath, newer);
    assert.equal((await rescue.rescue(SID, 'server/engine/physics.cpp', undefined, withTranscript)).file.absPath, older);
    assert.equal(await rescue.rescue(SID, 'render/physics.cpp', undefined, withTranscript), null);
});

test('a transcript mention straddling a scan chunk boundary is still found', async () => {
    const target = path.join(tempRoot, 'chunked', 'net', 'packets.h');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '', 'utf8');
    const transcript = path.join(tempRoot, 'chunked.jsonl');
    const mention = JSON.stringify({ content: 'Read ' + target });
    const at = mention.indexOf(target);
    const withTranscript = { ...deps, readSession: () => ({ roots: [cwd], cliSessionId: 'x' }), transcriptPath: () => transcript };
    // The first chunk read ends at the file end and starts CHUNK bytes before it
    // (plus overlap); put that start inside, at the edges of, and around the path.
    for (const delta of [-3000, -1, 0, 1, 10, target.length - 3, target.length + 5, 3000]) {
        const tail = rescue.TRANSCRIPT_CHUNK - (mention.length - at - delta) - 1;
        fs.writeFileSync(transcript, 'x'.repeat(4096) + '\n' + mention + '\n' + 'y'.repeat(tail), 'utf8');
        const result = await rescue.rescue(SID, 'packets.h', undefined, withTranscript);
        assert.equal(result && result.file.absPath, target, 'boundary delta ' + delta);
    }
});

test('a name the transcript never spelled out is found among the roots\' tracked files', async () => {
    const deep = path.join(cwd, 'lib', 'a', 'b', 'util.h');
    const shallow = path.join(cwd, 'lib', 'util.h');
    for (const f of [deep, shallow]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '', 'utf8'); }
    const withGit = { ...deps, gitFiles: async (root) => (root === cwd ? ['lib/a/b/util.h', 'lib/util.h', 'lib/missing.h'] : []) };
    assert.equal((await rescue.rescue(SID, 'util.h', undefined, withGit)).file.absPath, shallow);
    assert.equal((await rescue.rescue(SID, 'b/util.h', undefined, withGit)).file.absPath, deep);
    assert.equal(await rescue.rescue(SID, 'missing.h', undefined, withGit), null);
});

test('missing files, directories, UNC paths and unknown sessions keep the native answer', async () => {
    assert.equal(await rescue.rescue(SID, path.join(cwd, 'gone.txt'), undefined, deps), null);
    assert.equal(await rescue.rescue(SID, cwd, undefined, deps), null);
    assert.equal(await rescue.rescue(SID, '\\\\server\\share\\file.txt', undefined, deps), null);
    assert.equal(await rescue.rescue(SID, '//server/share/file.txt', undefined, deps), null);
    assert.equal(await rescue.rescue('local_ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', 'src/main.cpp', undefined, deps), null);
});

test('tail reads and the size cap follow the shell', async () => {
    const log = path.join(elsewhere, 'run.log');
    fs.writeFileSync(log, 'aaaaébbbb', 'utf8');
    const tail = await rescue.rescue(SID, log, { tailBytes: 5 }, deps);
    assert.equal(tail.file.isTail, true);
    assert.equal(tail.file.contents, 'bbbb');
    const big = path.join(elsewhere, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, rescue.MAX_BYTES + 1);
    assert.deepEqual(await rescue.rescue(SID, big, undefined, deps), { status: 'tooLarge', maxBytes: rescue.MAX_BYTES });
});

test('the wrapper replaces only a notFound for an existing file', async () => {
    const rescued = [];
    const answers = { [outside]: { status: 'notFound' }, [inCwd]: { status: 'ok', file: { contents: 'native', hash: 'h' } } };
    const original = async (_event, _sid, filePath) => answers[filePath] || { status: 'notFound' };
    const wrapper = plugin.wrapHandler(original, (p) => rescued.push(p), deps);
    assert.equal((await wrapper({}, SID, inCwd)).file.contents, 'native');
    assert.equal((await wrapper({}, SID, outside)).file.contents, '# notes\n');
    assert.deepEqual(await wrapper({}, SID, path.join(cwd, 'gone.txt')), { status: 'notFound' });
    assert.deepEqual(rescued, [outside]);
});

function fakeHost(registry) {
    const disposers = [];
    const wc = { ipc: { _invokeHandlers: registry }, isDestroyed: () => false };
    const ctx = {
        boot: { MOD_DIR: tempRoot },
        electron: { webContents: { getAllWebContents: () => [wc] } },
        every() {},
        onDispose(fn) { disposers.push(fn); },
    };
    plugin(ctx);
    return () => { for (const fn of disposers) fn(); };
}

test('hot reload never stacks wrappers and disposal restores the shell handler', () => {
    const original = async () => ({ status: 'notFound' });
    const key = '$eipc_message$_uuid' + SUFFIX;
    const registry = new Map([[key, original]]);
    const disposeFirst = fakeHost(registry);
    const first = registry.get(key);
    assert.notEqual(first, original);
    const disposeSecond = fakeHost(registry);
    assert.equal(registry.get(key).__cuimodFilePaneOriginal, original);
    disposeFirst();
    assert.notEqual(registry.get(key), original);
    disposeSecond();
    assert.equal(registry.get(key), original);
});
