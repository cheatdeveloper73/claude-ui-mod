#!/usr/bin/env node
'use strict';
/* claude-ui-mod :: patcher
 *
 *   node patch.js status     what is installed where
 *   node patch.js apply      inject into the newest app-<version>
 *   node patch.js apply --all      inject into every app-<version> present
 *   node patch.js apply --force    skip the "Claude is running" guard
 *   node patch.js revert     restore the pristine asar from backup
 *
 * Windows keeps app.asar mapped while the app runs, so patching the version
 * that is currently executing fails with EBUSY/EPERM. Patching a *different*
 * (freshly downloaded) app-<version> works fine while the old one runs — that
 * is what watch.js relies on.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const asar = require('./lib/asar');

const MOD_DIR = __dirname;
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AnthropicClaude');
const MARKER = '/*cuimod:v1*/';
const PRELOAD_ENTRY = '.vite/build/mainView.js';
const MAIN_ENTRY = '.vite/build/index.pre.js';

function appDirs() {
    let names;
    try { names = fs.readdirSync(ROOT); } catch (_) { return []; }
    return names
        .filter((n) => /^app-\d+\.\d+\.\d+$/.test(n))
        .map((n) => ({
            name: n,
            dir: path.join(ROOT, n),
            asar: path.join(ROOT, n, 'resources', 'app.asar'),
            backup: path.join(ROOT, n, 'resources', 'app.asar.cuimod-backup'),
            exe: path.join(ROOT, n, 'claude.exe'),
            exeBackup: path.join(ROOT, n, 'claude.exe.cuimod-backup'),
            ver: n.slice(4).split('.').map(Number),
        }))
        .filter((a) => fs.existsSync(a.asar))
        .sort((a, b) => b.ver[0] - a.ver[0] || b.ver[1] - a.ver[1] || b.ver[2] - a.ver[2]);
}

function isPatched(a) {
    try {
        return asar.readFile(a.asar, PRELOAD_ENTRY).includes(MARKER);
    } catch (_) {
        return false;
    }
}

function running() {
    try {
        return /claude\.exe/i.test(
            execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { encoding: 'utf8' })
        );
    } catch (_) {
        return false;
    }
}

function buildPayloads(originalPreload) {
    // The eipc channel prefix carries a build-specific uuid; lift the real one
    // out of this build's preload rather than hardcoding it. Hot code composes
    // any channel from it via boot.eipc(ns, iface, method).
    const m = originalPreload.match(/\$eipc_message\$_[0-9a-f-]{36}_\$_/);
    const prefix = m ? m[0] : '';

    let pre = fs.readFileSync(path.join(MOD_DIR, 'src', 'preload-hook.js'), 'utf8');
    pre = pre.replace("'__EIPC_PREFIX__'", JSON.stringify(prefix));

    let main = fs.readFileSync(path.join(MOD_DIR, 'src', 'main-hook.js'), 'utf8');
    main = main.replace("'__MOD_DIR__'", JSON.stringify(MOD_DIR));
    main = main.replace("'__EIPC_PREFIX__'", JSON.stringify(prefix));

    if (pre.includes('__EIPC_PREFIX__') || main.includes('__MOD_DIR__') || main.includes('__EIPC_PREFIX__')) {
        throw new Error('payload substitution incomplete');
    }
    return { pre, main, channel: prefix };
}

function patchOne(a, log = console.log) {
    // Always inject into pristine bytes so re-running never double-appends.
    let source = a.asar;
    if (fs.existsSync(a.backup)) {
        source = a.backup;
    } else if (isPatched(a)) {
        throw new Error(a.name + ': looks patched but the backup is gone; reinstall Claude for a clean asar');
    } else {
        fs.copyFileSync(a.asar, a.backup);
    }

    const originalPreload = asar.readFile(source, PRELOAD_ENTRY).toString('utf8');
    const originalMain = asar.readFile(source, MAIN_ENTRY).toString('utf8');
    const { pre, main, channel } = buildPayloads(originalPreload);
    if (!channel) log('! ' + a.name + ': LocalSessions onEvent channel not found; session detection falls back to URL');

    const tmp = a.asar + '.cuimod-tmp';
    const newHeaderHash = asar.writePatched(source, tmp, {
        [PRELOAD_ENTRY]: Buffer.from(originalPreload + '\n' + MARKER + '\n' + pre, 'utf8'),
        [MAIN_ENTRY]: Buffer.from(originalMain + '\n' + MARKER + '\n' + main, 'utf8'),
    });

    // The rewritten archive must read back byte-identically for an entry we did
    // not touch, and must carry the marker in the two we did.
    if (!asar.readFile(tmp, '.vite/build/mainWindow.js').equals(asar.readFile(source, '.vite/build/mainWindow.js'))) {
        fs.rmSync(tmp, { force: true });
        throw new Error(a.name + ': verification failed, untouched entry changed');
    }
    if (!asar.readFile(tmp, PRELOAD_ENTRY).includes(MARKER) || !asar.readFile(tmp, MAIN_ENTRY).includes(MARKER)) {
        fs.rmSync(tmp, { force: true });
        throw new Error(a.name + ': verification failed, marker missing');
    }

    // Electron validates the header hash against a value baked into claude.exe;
    // repoint it BEFORE swapping the asar so the two are never mismatched on disk
    // for a launch. The exe is not locked while the app is closed.
    const r = asar.repointExeIntegrity(a.exe, newHeaderHash, a.exeBackup);
    log('exe hash ' + (r.changed ? r.oldHash.slice(0, 12) + '.. -> ' + newHeaderHash.slice(0, 12) + '..' : 'already ' + newHeaderHash.slice(0, 12) + '..'));

    fs.rmSync(a.asar, { force: true });   // throws EBUSY/EPERM if this build is running
    fs.renameSync(tmp, a.asar);
    log('patched  ' + a.name);
}

function apply(opts = {}) {
    const list = appDirs();
    if (!list.length) throw new Error('no app-<version> directory under ' + ROOT);
    const targets = (opts.all ? list : [list[0]]).filter((a) => opts.rebuild || !isPatched(a));
    if (!targets.length) { console.log('already patched'); return; }
    if (!opts.force && running()) {
        throw new Error('Claude is running. Quit it from the tray icon and re-run, or pass --force.');
    }
    for (const a of targets) {
        patchOne(a);
    }
}

function revert() {
    if (running()) throw new Error('Claude is running; quit it first.');
    let n = 0;
    for (const a of appDirs()) {
        let did = false;
        if (fs.existsSync(a.exeBackup)) {
            fs.rmSync(a.exe, { force: true });
            fs.renameSync(a.exeBackup, a.exe);
            did = true;
        }
        if (fs.existsSync(a.backup)) {
            fs.rmSync(a.asar, { force: true });
            fs.renameSync(a.backup, a.asar);
            did = true;
        }
        if (did) { console.log('reverted ' + a.name); n++; }
    }
    if (!n) console.log('nothing to revert');
}

function status() {
    console.log('root     ' + ROOT);
    console.log('mod      ' + MOD_DIR);
    console.log('running  ' + (running() ? 'yes' : 'no'));
    const list = appDirs();
    if (!list.length) { console.log('(no app directories found)'); return; }
    list.forEach((a, i) => {
        console.log(
            (i === 0 ? '* ' : '  ') + a.name +
            '  patched=' + (isPatched(a) ? 'yes' : 'no') +
            '  backup=' + (fs.existsSync(a.backup) ? 'yes' : 'no')
        );
    });
}

module.exports = { appDirs, isPatched, patchOne, apply, revert, status, running, MARKER, ROOT };

if (require.main === module) {
    const args = process.argv.slice(2);
    const cmd = args[0] || 'status';
    const opts = {
        all: args.includes('--all'),
        force: args.includes('--force'),
        rebuild: args.includes('--rebuild') || args.includes('--force'),
    };
    try {
        if (cmd === 'apply') apply(opts);
        else if (cmd === 'revert') revert();
        else if (cmd === 'status') status();
        else { console.error('usage: node patch.js apply|revert|status [--all] [--force]'); process.exit(2); }
    } catch (err) {
        console.error('error: ' + (err && err.message ? err.message : err));
        process.exit(1);
    }
}
