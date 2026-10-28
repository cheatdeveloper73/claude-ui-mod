'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function discoverRuntime({ home = os.homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
    const root = path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
    const official = path.join(localAppData || path.join(home, 'AppData', 'Local'), 'OpenAI', 'Codex');
    const inside = (file, directory) => {
        const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    let candidates = [];
    try {
        candidates = fs.readdirSync(root).map(name => path.join(root, name, '.mcp.json'))
            .filter(file => fs.existsSync(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    } catch (_) { return null; }
    for (const file of candidates) {
        try {
            const source = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers?.cua_repl;
            const env = source?.env;
            if (!source || !env || source.args?.length !== 1) continue;
            const runtime = { node: source.command, entry: source.args[0], nodeRepl: env.CUA_REPL_NODE_REPL_PATH,
                nodeModules: env.NODE_REPL_NODE_MODULE_DIRS, codexCli: env.CODEX_CLI_PATH,
                codexHome: path.join(home, '.codex'), appVersion: env.BROWSER_USE_CODEX_APP_VERSION };
            if (Object.entries(runtime).some(([key, value]) => key !== 'appVersion' && (typeof value !== 'string' || !fs.existsSync(value)))) continue;
            if (!['node', 'entry', 'nodeRepl', 'nodeModules', 'codexCli'].every(key => inside(runtime[key], official))) continue;
            const bin = path.dirname(runtime.node);
            if (path.basename(runtime.node) !== 'node.exe' || path.basename(runtime.nodeRepl) !== 'node_repl.exe'
                || path.dirname(runtime.nodeRepl) !== bin || runtime.nodeModules !== path.join(bin, 'node_modules')
                || runtime.entry !== path.join(runtime.nodeModules, '@oai', 'cua-repl', 'bin', 'cua-repl.mjs')
                || path.basename(runtime.codexCli) !== 'codex.exe') continue;
            const browser = JSON.parse(fs.readFileSync(path.join(runtime.nodeModules, '@oai', 'browser-desktop', 'package.json'), 'utf8'));
            const repl = JSON.parse(fs.readFileSync(path.join(runtime.nodeModules, '@oai', 'cua-repl', 'package.json'), 'utf8'));
            if (browser.name !== '@oai/browser-desktop' || repl.name !== '@oai/cua-repl') continue;
            return { ...runtime, browserVersion: browser.version, replVersion: repl.version,
                fingerprint: [runtime.node, runtime.codexCli, browser.version, repl.version].join('|') };
        } catch (_) { /* An update can replace the manifest between these reads. */ }
    }
    return null;
}

module.exports = { discoverRuntime };
