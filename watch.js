#!/usr/bin/env node
'use strict';
/* claude-ui-mod :: update watcher
 *
 * Two jobs:
 *  1. Auto-update: Squirrel lays each update into a new app-<version> dir and
 *     switches to it on relaunch. A fresh dir is not the running one, so it can
 *     be patched immediately; fs.watch catches it.
 *  2. Same-version restart: the running version's app.asar is memory-mapped and
 *     cannot be rewritten. The only window to patch it is while the app is fully
 *     closed. A 1s liveness probe (try to open app.asar read-write; the image
 *     mapping blocks that while any Electron process is up) patches the instant
 *     the app goes down, so a quit->reopen is enough — no command to run.
 *
 * Run via install.ps1, which registers it as a logon scheduled task.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./patch');

const LOG = path.join(__dirname, 'watch.log');
const PROBE_MS = 1500;
const SWEEP_MS = 5 * 60 * 1000;

function log(msg) {
    const line = new Date().toISOString() + '  ' + msg + '\n';
    process.stdout.write(line);
    try {
        if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
        fs.appendFileSync(LOG, line);
    } catch (_) {}
}

// The Electron app and the Claude Code CLI agents are BOTH claude.exe, so a bare
// image-name count is ambiguous. Distinguish by path: the desktop app runs from
// AnthropicClaude\app-<ver>, the CLI agents from Roaming\Claude\claude-code\.
// Returns true only if a desktop-app process is up (it holds the asar mapping).
function desktopRunning() {
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "@(Get-Process claude -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.Path -like '*\\AnthropicClaude\\app-*' }).Count"],
            { encoding: 'utf8', timeout: 8000 });
        return parseInt(String(out).trim(), 10) > 0;
    } catch (_) {
        return true; // on uncertainty, assume up and do not attempt a write
    }
}

let lastState = null; // 'locked' | 'patched'

function attempt(reason) {
    let newest;
    try {
        newest = P.appDirs()[0];
    } catch (err) {
        log('list failed: ' + err.message);
        return;
    }
    if (!newest) return;

    if (P.isPatched(newest)) {
        if (lastState !== 'patched') { log('patched  ' + newest.name + ' (' + reason + ')'); lastState = 'patched'; }
        return;
    }

    if (desktopRunning()) {
        if (lastState !== 'locked') { log('locked   ' + newest.name + '; will patch the moment it closes'); lastState = 'locked'; }
        return;
    }

    // Desktop app is down (or this is a never-launched new version): grab it now.
    try {
        P.patchOne(newest, log);
        lastState = 'patched';
    } catch (err) {
        if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
            // Raced the app coming back up; the next probe retries.
            lastState = 'locked';
        } else {
            log('failed   ' + newest.name + ': ' + err.message);
        }
    }
}

function start() {
    log('watching ' + P.ROOT + ' (probe ' + PROBE_MS + 'ms)');
    attempt('boot');
    try {
        fs.watch(P.ROOT, { persistent: true }, (_ev, name) => {
            if (name && /^app-/.test(String(name))) attempt('fswatch');
        });
    } catch (err) {
        log('fs.watch failed (' + err.message + '); polling only');
    }
    setInterval(() => attempt('probe'), PROBE_MS);
    setInterval(() => { lastState = null; attempt('sweep'); }, SWEEP_MS); // periodic re-log
}

start();
