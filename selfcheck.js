#!/usr/bin/env node
'use strict';
/* Compile + wiring check for the whole hot tree, without touching the app.
 * Run this after editing anything; it catches the failures that would otherwise
 * only show up as a silent "kept previous version" at runtime.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const asar = require('./lib/asar');

const MOD = __dirname;
let bad = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => { bad++; console.log('  FAIL ' + m); };

function compile(label, src, wrapper) {
    try { new vm.Script(wrapper ? wrapper(src) : src, { filename: label }); ok(label); }
    catch (e) { fail(label + ': ' + e.message); }
}

console.log('compile:');
compile('src/main-hook.js', fs.readFileSync(path.join(MOD, 'src/main-hook.js'), 'utf8'));
compile('src/preload-hook.js', fs.readFileSync(path.join(MOD, 'src/preload-hook.js'), 'utf8'));
compile('src/runtime/host.js', fs.readFileSync(path.join(MOD, 'src/runtime/host.js'), 'utf8'));
compile('src/runtime/bridge.js', fs.readFileSync(path.join(MOD, 'src/runtime/bridge.js'), 'utf8'),
    (s) => '(function(boot,plugins){' + s + '\n})');

const pluginsDir = path.join(MOD, 'src/plugins');
for (const name of fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []) {
    const r = path.join(pluginsDir, name, 'renderer.js');
    const m = path.join(pluginsDir, name, 'main.js');
    if (fs.existsSync(r)) compile('plugins/' + name + '/renderer.js', fs.readFileSync(r, 'utf8'),
        (s) => '(function(cuimod,ctx){' + s + '\n})');
    if (fs.existsSync(m)) compile('plugins/' + name + '/main.js', fs.readFileSync(m, 'utf8'));
}

console.log('host load (fake electron):');
const listeners = { intervals: 0, watchers: 0 };
const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
global.setInterval = (...a) => { listeners.intervals++; return realSetInterval(...a); };
global.clearInterval = (t) => { listeners.intervals--; return realClearInterval(t); };
const realWatch = fs.watch;
fs.watch = function (...a) {
    listeners.watchers++;
    return { on() {}, close() { listeners.watchers--; } };
};
try {
    delete require.cache[require.resolve('./src/runtime/host.js')];
    const factory = require('./src/runtime/host.js');
    const boot = {
        electron: { webContents: { getAllWebContents: () => [] }, shell: { openPath() {} }, app: { on() {} } },
        MOD_DIR: MOD, generation: 1, log: () => {}, broadcast: () => {}, loadHost: () => {},
    };
    const host = factory(boot);
    ok('host constructed');
    const info = host.dispatch('host.info', {});
    Promise.resolve(info).then((i) => {
        ok('host.info -> ' + i.methods.length + ' methods, plugins=[' + i.plugins.join(',') + ']');
        return host.dispatch('host.rendererBundle', {});
    }).then((b) => {
        if (!b.bridge || !b.bridge.length) fail('rendererBundle: empty bridge');
        else ok('rendererBundle: bridge ' + b.bridge.length + 'B, plugins=' + b.plugins.map((p) => p.name).join(','));
        host.dispose();
        if (listeners.intervals !== 0) fail('leak: ' + listeners.intervals + ' interval(s) after dispose');
        else ok('no interval leak after dispose');
        if (listeners.watchers !== 0) fail('leak: ' + listeners.watchers + ' watcher(s) after dispose');
        else ok('no watcher leak after dispose');
        finish();
    }).catch((e) => { fail('host dispatch: ' + e.message); finish(); });
} catch (e) {
    fail('host construct: ' + ((e && e.stack) || e));
    finish();
}

function finish() {
    fs.watch = realWatch;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    console.log('patch payload:');
    try {
        const a = require('./patch').appDirs()[0];
        // No Claude Desktop install here (CI, or a machine that only edits the
        // tree). Everything above still ran; only the asar-derived check can't.
        if (!a) { console.log('  skip (no Claude Desktop install found)'); return done(); }
        const src = fs.existsSync(a.backup) ? a.backup : a.asar;
        const pre = asar.readFile(src, '.vite/build/mainView.js').toString('utf8');
        const m = pre.match(/\$eipc_message\$_[0-9a-f-]{36}_\$_/);
        if (m) ok('eipc prefix found: ' + m[0].slice(0, 30) + '...'); else fail('eipc prefix not found');
    } catch (e) { fail('payload: ' + e.message); }
    done();
}

function done() {
    console.log(bad ? '\nSELFCHECK FAILED (' + bad + ')' : '\nSELFCHECK PASS');
    process.exitCode = bad ? 1 : 0;
}
