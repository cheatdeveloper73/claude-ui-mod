'use strict';
// Host for the official Codex cua-repl runtime (node.exe -> hidden-launch.mjs ->
// cua-repl bin -> node_repl -> kernel). Speaks MCP over the root's stdio as
// newline-delimited JSON; the browser backend is reached by the runtime itself
// through BROWSER_USE_BACKEND_PATHS, never through this module.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TOOL_NAMES = Object.freeze(['js', 'js_reset', 'turn_ended']);
const DEFAULT_LIMITS = Object.freeze({
    maxLineBytes: 16 * 1024 * 1024,
    maxPending: 32,
    startTimeoutMs: 60000,
    callTimeoutMs: 15 * 60 * 1000,
    closeTimeoutMs: 5000,
    logCapBytes: 1024 * 1024,
    stderrTailBytes: 8192,
});
const RUNTIME_KEYS = ['node', 'entry', 'nodeRepl', 'nodeModules', 'codexCli', 'codexHome'];
// Everything the runtime needs from the ambient environment on Windows, and
// nothing else: provider keys and tokens in the host's env stay out of it.
const ENV_ALLOW = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME',
    'USERDOMAIN', 'COMPUTERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'DRIVERDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
]);

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(options) {
    if (!isPlainObject(options) || !isPlainObject(options.runtime)) throw fail('BAD_OPTIONS', 'createRuntime: runtime paths are required');
    for (const key of RUNTIME_KEYS) {
        if (typeof options.runtime[key] !== 'string' || options.runtime[key] === '') throw fail('BAD_OPTIONS', `createRuntime: runtime.${key} is required`);
    }
    const { pipePath, sessionId, logDir } = options;
    // The runtime splits BROWSER_USE_BACKEND_PATHS on ';' and demands absolute entries.
    if (typeof pipePath !== 'string' || pipePath === '' || pipePath.includes(';') || !path.win32.isAbsolute(pipePath)) {
        throw fail('BAD_OPTIONS', 'createRuntime: pipePath must be one absolute path without ";"');
    }
    if (typeof sessionId !== 'string' || sessionId === '') throw fail('BAD_OPTIONS', 'createRuntime: sessionId is required');
    if (typeof logDir !== 'string' || logDir === '') throw fail('BAD_OPTIONS', 'createRuntime: logDir is required');
}

function buildEnv(options, baseEnv) {
    const env = {};
    for (const key of Object.keys(baseEnv)) {
        if (ENV_ALLOW.has(key.toUpperCase()) && typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
    }
    const { node, nodeRepl, nodeModules, codexCli, codexHome } = options.runtime;
    Object.assign(env, {
        NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
        NODE_REPL_NODE_MODULE_DIRS: nodeModules,
        NODE_REPL_NODE_PATH: node,
        NODE_REPL_TRUSTED_CODE_PATHS: `${codexHome};${nodeModules}`,
        CODEX_HOME: codexHome,
        BROWSER_USE_AVAILABLE_BACKENDS: 'iab',
        BROWSER_USE_TINYSKY_ENABLED: '1',
        NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: 'Control the in-app browser in conjunction with the Browser Plugin.',
        NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: 'Control the Chrome browser in conjunction with the Chrome Plugin.',
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
        BROWSER_USE_CODEX_APP_VERSION: options.runtime.appVersion || '26.1007.21434',
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: '@oai/browser-desktop/service' }),
        CUA_REPL_NODE_REPL_PATH: nodeRepl,
        CUA_REPL_ENABLED_SURFACES: 'browser',
        BROWSER_USE_BACKEND_PATHS: options.pipePath,
        // The installed official binary: without it the browser service drops the
        // backend over native-config preference failures.
        CODEX_CLI_PATH: codexCli,
    });
    return env;
}

// Stderr from the runtime can carry paths; scrub anything that looks like a credential.
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?[^\s"',;]+)/gi;

class RuntimeHost {
    constructor(options) {
        validate(options);
        this.options = options;
        this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
        this.sessionId = options.sessionId;
        this.launcher = options.launcher || path.join(__dirname, 'hidden-launch.mjs');
        this.baseEnv = options.baseEnv || process.env;
        this.state = 'idle';
        this.child = null;
        this.pid = null;
        this.exited = false;
        this.exit = null;
        this.closing = false;
        this.tools = null;
        this.startPromise = null;
        this.closePromise = null;
        this.killPromise = null;
        this.pending = new Map();
        this.nextId = 1;
        this.buffer = Buffer.alloc(0);
        this.stderrTail = '';
        this.stderrBytes = 0;
        this.logBytes = new Map();
        this.counters = { protocolErrors: 0, lateResponses: 0, notifications: 0, serverRequests: 0 };
        this.exitTimer = null;
    }

    // ---- logging: lifecycle metadata only, never arguments, results or env ----
    log(event, fields) {
        this.append('runtime-host.log', `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
    }

    append(file, text) {
        let used = this.logBytes.get(file);
        if (used === undefined) {
            try { used = fs.statSync(path.join(this.options.logDir, file)).size; } catch (_) { used = 0; }
        }
        if (used >= this.limits.logCapBytes) return;
        const chunk = text.slice(0, this.limits.logCapBytes - used);
        this.logBytes.set(file, used + Buffer.byteLength(chunk));
        try {
            fs.mkdirSync(this.options.logDir, { recursive: true });
            fs.appendFileSync(path.join(this.options.logDir, file), chunk);
        } catch { /* logging must never take the host down */ }
    }

    // ---- start ----------------------------------------------------------------
    start() {
        if (!this.startPromise) {
            this.startPromise = this.doStart().catch(async error => {
                if (this.state !== 'closed') this.state = 'failed';
                this.log('start-failed', { code: error.code || null, message: String(error.message).slice(0, 300) });
                await this.killTree();
                this.rejectAll(fail('RUNTIME_FAILED', 'runtime failed to start'));
                throw error;
            });
        }
        return this.startPromise;
    }

    async doStart() {
        const missing = RUNTIME_KEYS.filter(key => key !== 'codexHome' && !fs.existsSync(this.options.runtime[key]));
        if (!fs.existsSync(this.launcher)) missing.push('launcher');
        if (missing.length) throw fail('RUNTIME_MISSING', `official runtime files missing: ${missing.join(', ')}`, { missing });
        this.state = 'starting';
        const child = spawn(this.options.runtime.node, [this.launcher, this.options.runtime.entry], {
            env: buildEnv(this.options, this.baseEnv),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        this.pid = child.pid || null;
        this.exitWaiter = new Promise(resolve => { this.resolveExit = resolve; });
        child.stdout.on('data', chunk => this.onStdout(chunk));
        child.stderr.on('data', chunk => this.onStderr(chunk));
        child.stdin.on('error', error => this.log('stdin-error', { code: error.code || null }));
        child.on('error', error => this.onFatal(fail('RUNTIME_SPAWN', `runtime spawn failed: ${error.code || error.message}`)));
        child.on('exit', (code, signal) => this.onExit(code, signal));
        child.on('close', () => this.onClose());
        this.log('spawned', { pid: this.pid });

        const timeoutMs = this.limits.startTimeoutMs;
        await this.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: typeof this.options.onElicitation === 'function' ? { elicitation: { form: {} } } : {},
            clientInfo: { name: 'claude-ui-mod-runtime-host', version: '1.0.0' },
        }, { timeoutMs });
        this.notify('notifications/initialized', {});

        const byName = new Map();
        let cursor;
        for (let page = 0; page < 4; page++) {
            const listed = await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs });
            for (const tool of Array.isArray(listed && listed.tools) ? listed.tools : []) {
                if (tool && TOOL_NAMES.includes(tool.name) && !byName.has(tool.name)) byName.set(tool.name, tool);
            }
            cursor = listed && listed.nextCursor;
            if (byName.size === TOOL_NAMES.length || !cursor) break;
        }
        const absent = TOOL_NAMES.filter(name => !byName.has(name));
        if (absent.length) throw fail('RUNTIME_TOOLS_MISSING', `runtime tools/list lacks: ${absent.join(', ')}`);
        // Preserve the runtime's own ordering and definitions.
        this.tools = [...byName.values()];
        this.state = 'ready';
        this.log('ready', { pid: this.pid, tools: this.tools.map(tool => tool.name) });
        return this.tools;
    }

    // ---- JSONL transport ---------------------------------------------------------
    onStdout(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        let start = 0;
        for (;;) {
            const newline = this.buffer.indexOf(0x0a, start);
            if (newline < 0) break;
            let end = newline;
            if (end > start && this.buffer[end - 1] === 0x0d) end--;
            if (end - start > this.limits.maxLineBytes) return this.onFatal(fail('RUNTIME_PROTOCOL', 'runtime stdout line exceeds limit'));
            this.onLine(this.buffer.subarray(start, end));
            start = newline + 1;
        }
        this.buffer = Buffer.from(this.buffer.subarray(start));
        if (this.buffer.length > this.limits.maxLineBytes) this.onFatal(fail('RUNTIME_PROTOCOL', 'runtime stdout line exceeds limit'));
    }

    onLine(line) {
        if (line.length === 0 || (line.length === 1 && line[0] === 0x20)) return;
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch { message = null; }
        if (!isPlainObject(message)) {
            this.counters.protocolErrors++;
            this.log('stdout-not-json', { bytes: line.length });
            return;
        }
        if (typeof message.method === 'string') {
            if (message.id === undefined || message.id === null) {
                this.counters.notifications++;
                return;
            }
            this.counters.serverRequests++;
            this.log('server-request', { method: message.method.slice(0, 80) });
            if (message.method === 'elicitation/create' && typeof this.options.onElicitation === 'function') {
                if (this.eliciting) {
                    this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'another browser approval is pending' } });
                    return;
                }
                this.eliciting = true;
                Promise.resolve().then(() => this.options.onElicitation(message.params))
                    .then(result => {
                        if (!result || !['accept', 'decline', 'cancel'].includes(result.action)) throw Error('invalid native elicitation response');
                        this.send({ jsonrpc: '2.0', id: message.id, result });
                    }).catch(error => this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }))
                    .finally(() => { this.eliciting = false; });
                return;
            }
            // No approval is ever fabricated here; ping is liveness, not consent.
            this.send(message.method === 'ping'
                ? { jsonrpc: '2.0', id: message.id, result: {} }
                : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
            return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
            this.counters.lateResponses++;
            return;
        }
        this.pending.delete(message.id);
        this.disarm(entry);
        if (message.error !== undefined) {
            const rpc = isPlainObject(message.error) ? message.error : {};
            entry.reject(fail(rpc.code === undefined ? 'RPC_ERROR' : rpc.code, String(rpc.message || 'runtime error'), { data: rpc.data }));
        } else {
            entry.resolve(message.result);
        }
    }

    onStderr(chunk) {
        this.stderrBytes += chunk.length;
        // Kernel diagnostics can quote source or auth failures. Byte counts
        // remain observable without persisting any page text or credentials.
        this.log('stderr', { bytes: chunk.length });
    }

    // Serialise first so an unserialisable payload never leaves a pending entry behind.
    encode(message) {
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line) > this.limits.maxLineBytes) throw fail('REQUEST_TOO_LARGE', 'request exceeds limit');
        return line;
    }

    send(message) {
        const stdin = this.child && this.child.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) return false;
        stdin.write(this.encode(message), error => { if (error) this.log('write-error', { code: error.code || null }); });
        return true;
    }

    notify(method, params) {
        return this.send({ jsonrpc: '2.0', method, params });
    }

    request(method, params, { timeoutMs, signal, onAbort } = {}) {
        if (this.pending.size >= this.limits.maxPending) return Promise.reject(fail('RUNTIME_BUSY', 'too many pending runtime requests'));
        if (signal && signal.aborted) return Promise.reject(this.abortError(signal));
        const id = this.nextId++;
        let line;
        try { line = this.encode({ jsonrpc: '2.0', id, method, params }); } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
            const entry = { id, method, resolve, reject, timer: null, signal: null, abort: null };
            // Waiter first, write second: a fast reply can never beat its registration.
            this.pending.set(id, entry);
            if (timeoutMs) {
                entry.timer = setTimeout(() => {
                    if (!this.pending.delete(id)) return;
                    this.disarm(entry);
                    this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
                    if (onAbort) { try { onAbort(id); } catch (_) {} }
                    reject(fail('RUNTIME_TIMEOUT', `runtime request ${method} timed out`));
                }, timeoutMs);
                entry.timer.unref();
            }
            if (signal) {
                entry.signal = signal;
                entry.abort = () => {
                    if (!this.pending.delete(id)) return;
                    this.disarm(entry);
                    this.notify('notifications/cancelled', { requestId: id, reason: 'caller cancelled' });
                    if (onAbort) { try { onAbort(id); } catch { /* caller hook must not break cancellation */ } }
                    reject(this.abortError(signal));
                };
                signal.addEventListener('abort', entry.abort, { once: true });
            }
            const stdin = this.child && this.child.stdin;
            if (!stdin || stdin.destroyed || !stdin.writable) {
                this.pending.delete(id);
                this.disarm(entry);
                reject(fail('RUNTIME_EXITED', 'runtime stdin is closed'));
                return;
            }
            stdin.write(line, error => {
                if (!error || !this.pending.delete(id)) return;
                this.disarm(entry);
                reject(fail('RUNTIME_WRITE', `runtime write failed: ${error.code || error.message}`));
            });
        });
    }

    disarm(entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    }

    abortError(signal) {
        return Object.assign(new Error('runtime call aborted'), { name: 'AbortError', code: 'ABORT_ERR', cause: signal && signal.reason });
    }

    rejectAll(error) {
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const entry of entries) {
            this.disarm(entry);
            entry.reject(error);
        }
    }

    // ---- call ---------------------------------------------------------------------
    call(name, args, { turnId, signal } = {}) {
        if (!TOOL_NAMES.includes(name)) return Promise.reject(fail('UNSUPPORTED_TOOL', `unsupported tool: ${String(name).slice(0, 64)}`));
        if (this.state !== 'ready') return Promise.reject(fail('RUNTIME_NOT_READY', `runtime not ready (${this.state})`));
        if (typeof turnId !== 'string' || turnId === '') return Promise.reject(fail('BAD_CALL', 'call requires a non-empty turnId'));
        const callArgs = args === undefined ? {} : args;
        if (!isPlainObject(callArgs)) return Promise.reject(fail('BAD_CALL', 'tool arguments must be an object'));
        const startedAt = Date.now();
        // Always rebuilt here; caller-supplied metadata cannot reach the runtime.
        const params = {
            name,
            arguments: callArgs,
            _meta: { 'x-codex-turn-metadata': { session_id: this.sessionId, turn_id: turnId } },
        };
        const onAbort = id => {
            this.log('call-cancelled', { id, tool: name, turnId });
            if (typeof this.options.onCancel === 'function') {
                try { this.options.onCancel({ id, name, turnId }); } catch { /* hook errors stay local */ }
            }
        };
        return this.request('tools/call', params, { timeoutMs: this.limits.callTimeoutMs, signal, onAbort }).then(result => {
            this.log('call', { tool: name, turnId, ms: Date.now() - startedAt, isError: !!(result && result.isError) });
            return result;
        }, error => {
            this.log('call-failed', { tool: name, turnId, ms: Date.now() - startedAt, code: error.code === undefined ? null : error.code });
            throw error;
        });
    }

    // ---- lifecycle ----------------------------------------------------------------
    onFatal(error) {
        if (this.state === 'closed' || this.state === 'failed' || this.state === 'exited') return;
        this.state = 'failed';
        this.log('fatal', { code: error.code || null, message: String(error.message).slice(0, 200) });
        this.rejectAll(error);
        this.killTree();
    }

    onExit(code, signal) {
        this.exited = true;
        this.exit = { code, signal };
        this.log('exit', { code, signal });
        // 'close' follows once stdout is drained; bound the wait in case a
        // descendant still holds the pipe.
        this.exitTimer = setTimeout(() => this.onClose(), 300);
        this.exitTimer.unref();
    }

    onClose() {
        if (this.exitTimer) { clearTimeout(this.exitTimer); this.exitTimer = null; }
        if (!this.exited) return;
        if (this.state === 'ready' || this.state === 'starting') this.state = 'exited';
        this.rejectAll(fail(this.closing ? 'RUNTIME_CLOSED' : 'RUNTIME_EXITED', this.closing ? 'runtime closed' : `runtime exited (code ${this.exit.code}, signal ${this.exit.signal})`));
        if (this.resolveExit) this.resolveExit();
    }

    // Kill exactly our root PID and its tree. Never by image name.
    killTree() {
        if (this.killPromise) return this.killPromise;
        const child = this.child;
        if (!child || !this.pid || this.exited) return Promise.resolve();
        this.killPromise = new Promise(resolve => {
            const settle = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(resolve, this.limits.closeTimeoutMs);
            timer.unref();
            if (process.platform !== 'win32') {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
                this.exitWaiter.then(settle);
                return;
            }
            let fd;
            try {
                fs.mkdirSync(this.options.logDir, { recursive: true });
                fd = fs.openSync(path.join(this.options.logDir, 'taskkill.log'), 'w');
            } catch { fd = undefined; }
            const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
            const killer = spawn(taskkill, ['/PID', String(this.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: ['ignore', fd === undefined ? 'ignore' : fd, fd === undefined ? 'ignore' : fd],
            });
            const closeFd = () => { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } fd = undefined; } };
            killer.on('error', error => { this.log('taskkill-error', { code: error.code || null }); closeFd(); settle(); });
            killer.on('close', status => {
                this.log('taskkill', { pid: this.pid, status });
                closeFd();
                this.exitWaiter.then(settle);
            });
        });
        return this.killPromise;
    }

    close() {
        if (!this.closePromise) {
            this.closePromise = (async () => {
                this.closing = true;
                if (this.state !== 'failed') this.state = 'closed';
                this.rejectAll(fail('RUNTIME_CLOSED', 'runtime closed'));
                const child = this.child;
                if (child && child.stdin && !child.stdin.destroyed) { try { child.stdin.end(); } catch { /* ignore */ } }
                await this.killTree();
                this.state = 'closed';
                this.log('closed', { pid: this.pid, exited: this.exited });
            })();
        }
        return this.closePromise;
    }

    status() {
        return {
            state: this.state,
            pid: this.pid,
            pipePath: this.options.pipePath,
            sessionId: this.sessionId,
            pending: this.pending.size,
            tools: this.tools ? this.tools.map(tool => tool.name) : [],
            exit: this.exit,
            stderrBytes: this.stderrBytes,
            stderrTail: this.stderrTail,
            ...this.counters,
        };
    }
}

function createRuntime(options) {
    const host = new RuntimeHost(options);
    return Object.freeze({
        start: () => host.start(),
        call: (name, args, callOptions) => host.call(name, args, callOptions),
        close: () => host.close(),
        status: () => host.status(),
    });
}

module.exports = { createRuntime, TOOL_NAMES };
