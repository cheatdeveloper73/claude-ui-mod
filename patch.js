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

// Desktop removes agent-to-agent messaging twice, at two layers, and both have
// to go or the symptom just changes shape.
//
//   registry  `U.disallowedTools = [...U.disallowedTools ?? [], "SendMessage"]`
//             closes the spawn-options chain with no guard. A disallowed tool
//             is dropped inside the CLI's XA() before deferred classification,
//             so the name never reaches ToolSearch's pool: `select:SendMessage`
//             answers "no matching deferred tools" — the shape of a missing
//             feature, not of a denial.
//
//   call      a PreToolUse hook matches the tool name and returns deny. It
//             never inspects `to`, so a send to an in-process subagent or a
//             teammate is refused with a message about terminal sessions being
//             unreachable. Lifting only the registry ban surfaces the tool and
//             then fails every call.
//
// Nothing substitutes for either. mcp__ccd_session_mgmt__send_message addresses
// Desktop *sessions*; SendMessage addresses *agents*.
//
// With the deny branch neutralised, SendMessage falls through the same chain as
// any other tool: `n.Jn` still refuses it in a remote-dispatched tree, and the
// directory pre-card still runs. Only the blanket refusal goes.
//
// Every identifier here is minified per build, so match statement shape and
// resolve the SendMessage literal from the same chunk. Each edit asserts
// exactly one site — a Desktop update that reshapes either one fails the patch
// loudly rather than quietly restoring half the ban.
function unbanSendMessage(source, log) {
    const { header } = asar.readHeader(source);
    const build = header.files?.['.vite']?.files?.build?.files;
    if (!build) throw new Error('.vite/build not found in asar');

    const out = {};
    const found = { registry: 0, call: 0 };
    for (const name of Object.keys(build)) {
        if (!name.endsWith('.js') || build[name].unpacked) continue;
        const rel = '.vite/build/' + name;
        const src = asar.readFile(source, rel).toString('utf8');
        const decl = src.match(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*"SendMessage"/);
        if (!decl) continue;

        let next = src;
        let hits = 0;

        const banned = new RegExp(
            '([A-Za-z_$][\\w$]*)\\.disallowedTools=\\[\\.\\.\\.\\1\\.disallowedTools\\?\\?\\[\\],'
            + decl[1] + '\\]',
            'g');
        next = next.replace(banned, () => { found.registry++; hits++; return 'void 0'; });

        // The condition, not the branch: a dead `if (false)` is provably
        // equivalent to deleting it and needs no brace or template matching.
        const denied = /(?:[A-Za-z_$][\w$]*\.tool_name==="SendMessage"|"SendMessage"===[A-Za-z_$][\w$]*\.tool_name)/g;
        next = next.replace(denied, () => { found.call++; hits++; return 'false'; });

        if (!hits) continue;
        out[rel] = Buffer.from(next, 'utf8');
        log('unbanned SendMessage in ' + rel
            + ' (registry ' + found.registry + ', call ' + found.call + ')');
    }
    // Desktop removed both blanket bans in 2.7032.0 and has not brought them
    // back. Accept only archives whose pristine header hash was inspected by
    // hand; a later build with zero matches needs a fresh audit, because zero
    // matches is also what a renamed ban looks like.
    //
    // 2.9939.4 is the second audited build. It reshaped the call-site deny
    // rather than removing it: the PreToolUse entry is now `matcher:
    // `^${Ps}$`` with Ps = "SendMessage", and its body returns {} unless
    // Fs(tool_input) holds. Fs is true only when `to` is a non-string, carries
    // `:`, `/` or `\`, ends `.sock`, or matches /^local_/i — that is, when the
    // target is a *session* or a socket path, which is the cross-session guard
    // Desktop has always had and which this patch never touched. An agent name
    // fails every arm, so agent-to-agent sends are not refused.
    //
    // The registry side is gone outright. The only arrays still carrying the
    // literal are is=["SendMessage","ListAgents","ListPeers"], read solely by
    // the ds name-set that fs() prefix-matches, and the dotted tool catalogue
    // string — neither reaches a disallowedTools append. Every append in the
    // build lists AskUserQuestion, SubscribePR, the unattended session
    // lifecycle set, or the onboarding pair.
    const AUDITED = {
        '62f0a21d5a95750273b3a44900009019f73c521c976711c5fdd6ffbba6daf288': '2.7032.0',
        'c5274bb77257bc824d5d02bb10eb503a0ad1a693ebee05dc953ab9d130701ad5': '2.9939.4',
    };
    const audited = AUDITED[asar.headerHash(source)];
    if (found.registry === 0 && found.call === 0 && audited) {
        log('SendMessage blanket bans absent in audited Desktop ' + audited);
        return out;
    }
    if (found.registry !== 1) {
        throw new Error('expected exactly 1 SendMessage disallowedTools append, found ' + found.registry);
    }
    if (found.call !== 1) {
        throw new Error('expected exactly 1 SendMessage PreToolUse deny, found ' + found.call);
    }
    return out;
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

    const unban = unbanSendMessage(source, log);

    const tmp = a.asar + '.cuimod-tmp';
    const newHeaderHash = asar.writePatched(source, tmp, {
        ...unban,
        [PRELOAD_ENTRY]: Buffer.from(originalPreload + '\n' + MARKER + '\n' + pre, 'utf8'),
        [MAIN_ENTRY]: Buffer.from(originalMain + '\n' + MARKER + '\n' + main, 'utf8'),
    });

    // The rewritten archive must read back byte-identically for an entry we did
    // not touch, and must carry the marker in the two we did.
    if (!asar.readFile(tmp, '.vite/build/mainWindow.js').equals(asar.readFile(source, '.vite/build/mainWindow.js'))) {
        fs.rmSync(tmp, { force: true });
        throw new Error(a.name + ': verification failed, untouched entry changed');
    }
    for (const rel of Object.keys(unban)) {
        if (!asar.readFile(tmp, rel).equals(unban[rel])) {
            fs.rmSync(tmp, { force: true });
            throw new Error(a.name + ': verification failed, SendMessage unban did not land in ' + rel);
        }
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

module.exports = { appDirs, isPatched, patchOne, apply, revert, status, running, unbanSendMessage, MARKER, ROOT };

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
