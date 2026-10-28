'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

test('the shipped remote image consumer reads Windows guest images outside its roots', {
    skip: !process.env.CUIMOD_FILE_PANE_NATIVE_CHUNK,
}, async () => {
    const source = fs.readFileSync(process.env.CUIMOD_FILE_PANE_NATIVE_CHUNK, 'utf8');
    const native = source.match(/class e\{constructor\(e\)\{this\.deps=e,this\.remoteRootRealpathCache=new Map\}.*?invalidateRemoteRootCache\(e\)\{return this\.remoteRootRealpathCache\.delete\(e\)\}\}/s)?.[0];
    assert.ok(native, 'native SessionFileReads class must be present in the inspected shell');
    const image = process.env.CUIMOD_FILE_PANE_REMOTE_PNG;
    const bytes = fs.readFileSync(image);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const positive = path.join(cwd, 'control.png');
    fs.writeFileSync(positive, bytes);
    let reads = 0;
    const realpath = async file => {
        try { return fs.realpathSync(path.win32.normalize(file.replace(/^\/([A-Za-z]:)/, '$1'))).replace(/\\/g, '/'); }
        catch (_) { return null; }
    };
    const controller = {
        connected: true, isWindows: true, remoteHome: os.homedir().replace(/\\/g, '/'),
        expandRemoteTilde: value => value,
        ensureReady: async () => {}, ensureReadyInBackground: async () => {},
        realpath,
        withSftp: async fn => fn({ realpath: (file, done) => realpath(file).then(value => done(null, value)) }),
        lstat: async file => {
            try { const stat = fs.lstatSync(file); return { isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() }; }
            catch (_) { return 'absent'; }
        },
        readBinaryFileWithStatus: async (file, max, expected) => {
            reads++;
            if (await realpath(file) !== expected) return { ok: false, reason: 'readError' };
            const data = fs.readFileSync(file);
            return data.length > max ? { ok: false, reason: 'tooLarge' } : { ok: true, data };
        },
    };
    const target = { kind: 'ssh' };
    const session = { sessionId: SID, backend: { kind: 'ssh', remoteTarget: target }, sshConfig: target,
        cliSessionId: process.env.CUIMOD_FILE_PANE_REMOTE_CLI, cwd };
    const remote = { i: () => controller };
    const refuseNetwork = value => /^[/\\]{2}/.test(value);
    // Inspected 2.7032.0 and 2.9939.4 use different minified import aliases.
    const NativeReads = vm.runInNewContext('(' + native + ')', {
        G: path, y: remote, m: remote,
        t: { cf: 10485760, af: 10485760, IY: refuseNetwork, KK: refuseNetwork, pv: (home, sid) => home + '/.claude/uploads/' + sid },
        a: { _: () => true }, i: { _: () => true },
    });
    const consumer = new NativeReads({ getSession: () => session, collectContainmentAdditionalDirectories: async () => [] });
    const expected = 'data:image/png;base64,' + bytes.toString('base64');
    function assertImage(value, label) {
        assert.equal(typeof value, 'string', label);
        assert.equal(value.length, expected.length, label + ' byte count');
        assert.ok(value === expected, label + ' exact PNG bytes');
    }
    assertImage(await consumer.readSessionImageAsDataUrl(SID, positive), 'native in-root positive control');
    assert.equal(reads, 1, 'positive control reaches the binary reader');
    session.cwd = process.env.CUIMOD_FILE_PANE_REMOTE_CWD;
    const base = await consumer.readSessionImageAsDataUrl(SID, image);
    assert.equal(base, null, 'shipped shell currently refuses Windows owned scratch');
    assert.equal(reads, 1, 'base refuses before binary retrieval');
    const managerKey = path.join(tempRoot, 'native-manager.cjs');
    const poolKey = path.join(tempRoot, 'native-remote-pool.cjs');
    const $ = new Map([[target, controller]]);
    require.cache[managerKey] = { exports: { claudeCodeSessionManager: { sessionFileReads: consumer } } };
    require.cache[poolKey] = { exports: {
        a: function lookup(value) { return $.get(value); },
        i: function select(value) { return value.kind === 'wsl' ? null : $.get(value); },
    } };
    const dispose = fakeHost(new Map());
    try {
        assertImage(await consumer.readSessionImageAsDataUrl(SID, image), 'owned remote PNG must reach the unchanged native image consumer');
        assert.equal(reads, 2);
        assertImage(await consumer.readSessionImageAsDataUrl(SID, image, false, { automatic: true }), 'automatic owned scratch preview');
        assertImage(await consumer.readSessionImageAsDataUrl(SID, image.toUpperCase().replace(/\//g, '\\')), 'Windows case and slash variants');
        assertImage(await consumer.readSessionImageAsDataUrl(SID, '/' + image.replace(/\\/g, '/')), 'OpenSSH drive spelling');
        const { remoteFile } = require('../src/plugins/file-pane-access/remote-image');
        const junction = { ...controller, realpath: async () => '//host/share/file.png' };
        assert.equal(await remoteFile(session, image, junction), null, 'a junction onto a network path stays refused');
        assert.equal(await remoteFile(session, image, { ...controller, connected: false }), null, 'preview cannot dial a new controller');
        assert.equal(await remoteFile(session, image + ':private', controller), null, 'alternate data streams stay refused');
        assert.equal(await remoteFile(session, '\\\\host\\share\\file.png', controller), null, 'network paths stay refused');
        const binary = controller.readBinaryFileWithStatus;
        try {
            controller.readBinaryFileWithStatus = async (_file, max) => {
                assert.equal(max, 10 * 1024 * 1024, 'native image size cap');
                return { ok: false, reason: 'tooLarge' };
            };
            assert.equal(await consumer.readSessionImageAsDataUrl(SID, image, false, { automatic: true }), null, 'oversized images retain the native refusal');
            controller.readBinaryFileWithStatus = async () => ({ ok: false, reason: 'readError' });
            await assert.rejects(consumer.readSessionImageAsDataUrl(SID, image, false, { automatic: true }), /Remote image read failed/);
        } finally { controller.readBinaryFileWithStatus = binary; }
        assertImage(await consumer.readRemoteSessionImageAsDataUrl(session, target, positive, {}), 'an image beside the cwd on the guest reaches the consumer');
        const wrapper = consumer.readRemoteSessionImageAsDataUrl;
        const disposeNext = fakeHost(new Map());
        dispose();
        assert.notEqual(consumer.readRemoteSessionImageAsDataUrl, wrapper);
        disposeNext();
        assert.equal(await consumer.readSessionImageAsDataUrl(SID, image), null, 'disposal restores native containment');
    } finally {
        dispose();
        delete require.cache[managerKey];
        delete require.cache[poolKey];
    }
});

test('WSL native image results never enter the SSH-only fallback', async () => {
    const { wrapRemoteImage } = require('../src/plugins/file-pane-access/remote-image');
    const getController = () => { throw new Error('SSH lookup must not run for WSL'); };
    const owner = { constructor: { REMOTE_IMAGE_EXT_TO_MIME: { '.png': 'image/png' } } };
    const target = { kind: 'wsl' };
    const wrapper = wrapRemoteImage(async () => null, getController);
    assert.equal(await wrapper.call(owner, {}, target, 'C:/image.png', {}), null);
    const failure = new Error('Remote image path could not be resolved');
    const failed = wrapRemoteImage(async () => { throw failure; }, getController);
    await assert.rejects(failed.call(owner, {}, target, 'C:/image.png', { automatic: true }), error => error === failure);
});

test('a Windows guest image outside every native root reaches the image consumer', async () => {
    const { wrapRemoteImage } = require('../src/plugins/file-pane-access/remote-image');
    const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const file = path.join(tempRoot, 'records', 'captures', 'm16_keyframes.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    const real = file.replace(/\\/g, '/');
    const canonical = value => {
        try { return fs.realpathSync(path.win32.normalize(value.replace(/^\/([A-Za-z]:)/, '$1'))).replace(/\\/g, '/'); }
        catch (_) { return null; }
    };
    const controller = {
        connected: true, isWindows: true, remoteHome: 'C:/Users/Administrator',
        realpath: async value => canonical(value),
        lstat: async value => { try { return { isDirectory: fs.statSync(value).isDirectory(), isSymbolicLink: false }; } catch (_) { return 'absent'; } },
        withSftp: async fn => fn({ realpath: (value, done) => done(null, canonical(value)) }),
        readBinaryFileWithStatus: async (value, max, expected) => {
            assert.equal(canonical(value), expected);
            return { ok: true, data: fs.readFileSync(value) };
        },
    };
    const owner = { constructor: { REMOTE_IMAGE_EXT_TO_MIME: { '.png': 'image/png' }, REMOTE_IMAGE_MAX_BYTES: 10485760 } };
    const session = { cwd: path.join(tempRoot, 'repo'), cliSessionId: 'ff55f517-e330-4256-993a-e45f82180ef0' };
    const target = { kind: 'ssh' };
    const native = async () => { throw new Error('Remote image path could not be resolved'); };
    const wrapper = wrapRemoteImage(native, () => controller);
    const expected = 'data:image/png;base64,' + bytes.toString('base64');
    assert.equal(await wrapper.call(owner, session, target, file, { automatic: true }), expected);
    assert.equal(await wrapper.call(owner, session, target, '/' + real, {}), expected);
    await assert.rejects(wrapper.call(owner, session, target, '\\\\host\\share\\m16.png', { automatic: true }), /could not be resolved/);
    await assert.rejects(wrapper.call(owner, session, target, file + ':hidden', { automatic: true }), /could not be resolved/);
    const offline = wrapRemoteImage(native, () => ({ ...controller, connected: false }));
    await assert.rejects(offline.call(owner, session, target, file, { automatic: true }), /could not be resolved/);
});
