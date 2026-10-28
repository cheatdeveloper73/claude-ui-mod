'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { wrapRemoteImage } = require('../src/plugins/file-pane-access/remote-image');

test('binary identity check keeps raw Windows SFTP spelling after normalized containment', async () => {
    const cli = '355ef34f-d305-4cab-9478-ea6a53e8a573';
    const root = 'C:/Users/Remote/AppData/Local/Temp/claude/C--repo/' + cli + '/scratchpad';
    const file = root + '/image.png';
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    let expected;
    const controller = {
        connected: true, isWindows: true, remoteHome: 'C:/Users/Remote',
        lstat: async () => ({ isDirectory: true, isSymbolicLink: false }),
        realpath: async value => value,
        withSftp: async fn => fn({ realpath: (value, callback) => callback(null, '/' + value) }),
        readBinaryFileWithStatus: async (value, max, identity) => {
            expected = identity;
            assert.equal(max, 10485760);
            return identity === '/' + value ? { ok: true, data: bytes } : { ok: false, reason: 'readError' };
        },
    };
    const owner = { constructor: { REMOTE_IMAGE_EXT_TO_MIME: { '.png': 'image/png' }, REMOTE_IMAGE_MAX_BYTES: 10485760 } };
    const session = { cliSessionId: cli, cwd: 'C:\\repo' };
    const wrapper = wrapRemoteImage(async (_session, _target, _filePath, options) => {
        if (options?.automatic) throw new Error('Remote image read failed');
        return null;
    }, () => controller);
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64');
    assert.equal(await wrapper.call(owner, session, { kind: 'ssh' }, file, {}), dataUrl);
    assert.equal(expected, '/' + file);
    assert.equal(await wrapper.call(owner, session, { kind: 'ssh' }, file, { automatic: true }), dataUrl);
    assert.equal(expected, '/' + file);
    controller.withSftp = async fn => fn({ realpath: (_value, callback) => callback(null, '/C:/elsewhere/image.png') });
    assert.equal(await wrapper.call(owner, session, { kind: 'ssh' }, file, { automatic: true }), null);
    const unrelated = wrapRemoteImage(async () => { throw new Error('Remote transport unavailable'); }, () => controller);
    await assert.rejects(unrelated.call(owner, session, { kind: 'ssh' }, file, { automatic: true }), /Remote transport unavailable/);
});
