'use strict';

const path = require('node:path');

const WIN = path.win32;

function windowsPath(value) {
    if (typeof value !== 'string') return null;
    const raw = value.replace(/^\/([A-Za-z]:[\\/])/, '$1');
    if (!/^[A-Za-z]:[\\/]/.test(raw) || /[\x00-\x1f]/.test(raw)) return null;
    if (raw.slice(2).includes(':')) return null;
    return WIN.normalize(raw);
}

// Any drive-absolute image on the Windows guest, as file-pane-access serves any
// existing absolute path for a local session. The native roots (cwd, worktree,
// uploads, /tmp/claude-<uid>) miss the CLI scratchpad and every sibling of the
// cwd, which is where SendUserFile deliveries usually live. UNC, device and
// alternate-stream spellings stay refused by windowsPath, before and after
// realpath, and only an already-connected controller is used.
async function remoteFile(session, filePath, controller) {
    if (!controller?.connected || controller.isWindows !== true) return null;
    const file = windowsPath(filePath);
    if (!file) return null;
    const real = await controller.realpath(file.replace(/\\/g, '/'));
    return windowsPath(real) ? real : null;
}

function wrapRemoteImage(original, getController, onRescue) {
    const wrapper = async function (session, target, filePath, options) {
        let result;
        let failure;
        try { result = await original.call(this, session, target, filePath, options); }
        catch (error) {
            // Automatic reads throw where manual reads return null; both can use the bounded fallback.
            if (error?.message !== 'Remote image path could not be resolved'
                && error?.message !== 'Remote image read failed') throw error;
            failure = error;
        }
        if (result) return result;
        const mime = this.constructor.REMOTE_IMAGE_EXT_TO_MIME?.[WIN.extname(filePath).toLowerCase()];
        if (mime && target?.kind === 'ssh') {
            const controller = getController(session);
            const real = await remoteFile(session, filePath, controller);
            if (real) {
                // The controller normalizes /C:/ for containment, but the binary
                // reader compares its expected path against raw SFTP realpath.
                const expected = await controller.withSftp(sftp => new Promise(resolve =>
                    sftp.realpath(real, (error, value) => resolve(error ? null : value))));
                const canonical = windowsPath(expected);
                if (!controller.connected || !canonical || canonical.toLowerCase() !== windowsPath(real)?.toLowerCase()) return null;
                const answer = await controller.readBinaryFileWithStatus(real, this.constructor.REMOTE_IMAGE_MAX_BYTES, expected);
                if (answer.ok) {
                    if (onRescue) onRescue(filePath, 'remote-image');
                    return 'data:' + mime + ';base64,' + answer.data.toString('base64');
                }
                if (options?.automatic && answer.reason === 'readError') throw new Error('Remote image read failed');
                return null;
            }
        }
        if (failure) throw failure;
        return result;
    };
    wrapper.__cuimodRemoteImageOriginal = original;
    return wrapper;
}

// Pool lookup only: the paired selector identifies the native remote module,
// but is never called here, so a preview cannot create a connection or prompt.
function remotePool(cache = require.cache) {
    for (const item of Object.values(cache)) {
        const value = item.exports;
        if (typeof value?.a !== 'function' || typeof value?.i !== 'function') continue;
        const lookup = Function.prototype.toString.call(value.a);
        const selector = Function.prototype.toString.call(value.i);
        if (/return\s+[\w$]+\.get\(/.test(lookup) && /\.kind\s*===\s*["']wsl["']/.test(selector)) return value.a;
    }
    return null;
}

module.exports = { remoteFile, wrapRemoteImage, remotePool };
