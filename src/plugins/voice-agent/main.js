'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SESSION = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW = /^fresh-[0-9a-z-]{8,80}$/i;
const MAX_REPLY = 8 * 1024 * 1024;
const TRANSCRIPT_TAIL = 2 * 1024 * 1024;
const SHARED = Symbol.for('claude-ui-mod.voice-agent.main');
const FIND_EDITOR = "(function(){"
    + " var els = document.querySelectorAll('.epitaxy-prompt-input .tiptap');"
    + " var best = null, bestRect = null;"
    + " for (var i = 0; i < els.length; i++) {"
    + "   var e = els[i];"
    + "   if (!e.editor) continue;"
    + "   if (e.closest('.epitaxy-composer-width')) return e.editor;"
    + "   var r = e.getBoundingClientRect();"
    + "   if (r.width < 120) continue;"
    + "   if (!bestRect || r.width > bestRect.width + 8 ||"
    + "       (Math.abs(r.width - bestRect.width) <= 8 && r.bottom > bestRect.bottom)) { best = e; bestRect = r; }"
    + " }"
    + " return best ? best.editor : null; })()";

const DEFAULTS = {
    enabled: true,
    wakeEnabled: true,
    wakeAction: 'send',
    continuousJournal: false,
    emotionEnabled: true,
    cueEnabled: true,
    ttsEnabled: true,
    ttsVoice: 'af_heart',
    ttsSpeed: 1,
    retentionDays: 30,
    wakePhrase: 'hey agent',
    stopPhrase: 'green apple',
    companionPort: 18764,
};

module.exports = function (ctx) {
    const stateDir = path.join(ctx.boot.MOD_DIR, '.state', 'voice-agent');
    const tokenFile = path.join(stateDir, 'token');
    const dispatchFile = path.join(stateDir, 'plugin-state.json');
    const owner = {};
    const shared = globalThis[SHARED] || (globalThis[SHARED] = {
        owner: null,
        loaded: false,
        cursor: 0,
        reservation: null,
        uncertain: [],
        fallback: null,
        bindings: new Map(),
        config: Object.assign({}, DEFAULTS),
        configDirty: true,
        configVersion: 0,
        polling: false,
        service: null,
        serviceError: null,
        dispatchError: null,
        dispatching: null,
        lastHealth: 0,
        manager: null,
    });
    shared.owner = owner;
    if (typeof shared.configDirty !== 'boolean') shared.configDirty = true;
    if (!Number.isInteger(shared.configVersion)) shared.configVersion = 0;
    if (!shared.fallback || !Number.isInteger(shared.fallback.id)) shared.fallback = null;

    function loadDispatch() {
        let value;
        try { value = JSON.parse(fs.readFileSync(dispatchFile, 'utf8')); }
        catch (_) { return; }
        if (Number.isInteger(value.cursor) && value.cursor >= 0) shared.cursor = Math.max(shared.cursor, value.cursor);
        if (Array.isArray(value.uncertain)) shared.uncertain = value.uncertain.slice(-50);
        if (value.fallback && Number.isInteger(value.fallback.id)) shared.fallback = value.fallback;
        if (value.reservation && Number.isInteger(value.reservation.id)) {
            shared.uncertain.push({ ...value.reservation, recoveredAt: new Date().toISOString() });
            shared.cursor = Math.max(shared.cursor, value.reservation.id);
            shared.reservation = null;
            saveDispatch();
        }
    }
    function saveDispatch() {
        fs.mkdirSync(stateDir, { recursive: true });
        const temporary = dispatchFile + '.tmp';
        const body = JSON.stringify({
            cursor: shared.cursor,
            reservation: shared.reservation,
            uncertain: shared.uncertain.slice(-50),
            fallback: shared.fallback,
        }, null, 2) + '\n';
        const fd = fs.openSync(temporary, 'w');
        try {
            fs.writeFileSync(fd, body);
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, dispatchFile);
    }
    if (!shared.loaded) {
        loadDispatch();
        shared.loaded = true;
    }

    function token() {
        const value = fs.readFileSync(tokenFile, 'utf8').trim();
        if (value.length < 32) throw new Error('voice companion token is missing or too short');
        return value;
    }

    function request(method, route, payload, timeout = 5000) {
        const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
        const port = Math.max(1, Math.min(65535, Number(shared.config.companionPort) || DEFAULTS.companionPort));
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method, path: route,
                headers: {
                    authorization: 'Bearer ' + token(),
                    ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
                },
            }, (response) => {
                const parts = [];
                let size = 0;
                response.on('data', (part) => {
                    size += part.length;
                    if (size <= MAX_REPLY) parts.push(part);
                    else response.destroy(new Error('voice companion response is too large'));
                });
                response.on('end', () => {
                    try {
                        const value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
                        if (response.statusCode < 200 || response.statusCode >= 300)
                            throw new Error(value.error || 'voice companion HTTP ' + response.statusCode);
                        resolve(value);
                    } catch (error) { reject(error); }
                });
            });
            req.setTimeout(timeout, () => req.destroy(new Error('voice companion timed out')));
            req.on('error', reject);
            if (body) req.end(body); else req.end();
        });
    }

    function sessionManager() {
        if (shared.manager?.sessions && typeof shared.manager.sessions.get === 'function') return shared.manager;
        shared.manager = null;
        for (const key of Object.keys(require.cache)) {
            let value;
            try { value = require.cache[key]?.exports; } catch (_) { continue; }
            const manager = value && value.claudeCodeSessionManager;
            if (manager?.sessions && typeof manager.sessions.get === 'function') {
                shared.manager = manager;
                break;
            }
        }
        return shared.manager;
    }

    function validBinding(binding) {
        if (!binding || !(SESSION.test(binding.desktopSessionId || '')
            || (!binding.desktopSessionId && VIEW.test(binding.viewId || '')))) return false;
        try { return !binding.sender.isDestroyed(); } catch (_) { return false; }
    }
    function bindingFor(target) {
        const webContentsId = Number(target?.webContentsId);
        const desktopSessionId = target?.desktopSessionId;
        const viewId = VIEW.test(target?.viewId || '') ? target.viewId : null;
        let exact = null;
        if (Number.isInteger(webContentsId)) exact = shared.bindings.get(webContentsId);
        if (validBinding(exact) && (!desktopSessionId || exact.desktopSessionId === desktopSessionId)
            && (!viewId || exact.viewId === viewId)) return exact;
        // A sessionless composer is owned by its exact page generation. Falling
        // back to another focused binding is precisely how a fresh-chat command
        // used to land in an unrelated existing session.
        if (viewId || (Number.isInteger(webContentsId) && !SESSION.test(desktopSessionId || ''))) return null;
        const candidates = [...shared.bindings.values()].filter(validBinding);
        const scoped = SESSION.test(desktopSessionId || '');
        const same = scoped ? candidates.filter(binding => binding.desktopSessionId === desktopSessionId) : [];
        const pool = scoped ? same : candidates;
        const focused = pool.filter(binding => binding.focusedAt > 0);
        const ranked = focused.length ? focused : pool;
        return ranked.sort((a, b) => focused.length
            ? b.focusedAt - a.focusedAt : b.seenAt - a.seenAt)[0] || null;
    }

    async function editorAppend(binding, text, separate = false) {
        text = String(text || '').trim();
        if (!text) return false;
        const code = `(function(){
            var ed = ${FIND_EDITOR};
            if (!ed || !ed.commands || typeof ed.commands.insertContent !== 'function') return false;
            var value = ${JSON.stringify(text)};
            var before = typeof ed.getText === 'function' ? ed.getText() : '';
            if (${separate ? 'true' : 'false'} && before) value = '\\n\\n' + value;
            else if (before && !/\\s$/.test(before) && !/^[,.;:!?]/.test(value)) value = ' ' + value;
            var lines = value.split(/\\r?\\n/), content = [];
            for (var i = 0; i < lines.length; i++) {
                if (lines[i]) content.push({ type: 'text', text: lines[i] });
                if (i + 1 < lines.length) content.push({ type: 'hardBreak' });
            }
            ed.commands.focus('end');
            return ed.commands.insertContent(content.length ? content : value) !== false;
        })()`;
        const result = await binding.sender.executeJavaScript(code, false);
        if (!result) throw new Error('voice transcript could not find the main composer');
        return true;
    }

    async function freshComposerReady(binding) {
        const result = await binding.sender.executeJavaScript(`(function(){
            var ed = ${FIND_EDITOR};
            if (!ed || typeof ed.getText !== 'function') return 'missing composer';
            if (ed.getText().trim()) return 'composer already contains a draft';
            return document.querySelector('button[data-testid="code-prompt-send"], button[aria-label="Send"]')
                ? 'ready' : 'missing send control';
        })()`, false);
        if (result !== 'ready') throw new Error('fresh voice target: ' + result);
    }

    async function submitFresh(binding, text) {
        await editorAppend(binding, text);
        const result = await binding.sender.executeJavaScript(`new Promise(function(resolve){
            setTimeout(function(){
                var button = document.querySelector('button[data-testid="code-prompt-send"], button[aria-label="Send"]');
                if (!button || button.disabled) return resolve(false);
                button.click();
                resolve(true);
            }, 50);
        })`, false);
        if (!result) throw new Error('fresh voice target could not submit the composer');
        return true;
    }

    async function sendPrompt(binding, text) {
        const manager = sessionManager();
        const session = manager?.sessions.get(binding.desktopSessionId);
        if (!session || typeof manager.sendMessage !== 'function') throw new Error('target Desktop session is unavailable');
        const options = { initiator: 'user' };
        try {
            if (typeof manager.isCliProvablyIdle === 'function' && !manager.isCliProvablyIdle(session)) options.priority = 'next';
        } catch (_) { options.priority = 'next'; }
        const result = await manager.sendMessage(binding.desktopSessionId, text, undefined, options);
        if (result?.delivered === false) throw new Error(result.reason || 'voice prompt delivery failed');
        return result;
    }

    function transcriptFile(cliSessionId) {
        if (!CLI_SESSION.test(cliSessionId || '')) return null;
        const projects = path.join(os.homedir(), '.claude', 'projects');
        let names;
        try { names = fs.readdirSync(projects); } catch (_) { return null; }
        for (const name of names) {
            const file = path.join(projects, name, cliSessionId + '.jsonl');
            if (fs.existsSync(file)) return file;
        }
        return null;
    }
    function transcriptText(binding) {
        const manager = sessionManager();
        const session = manager?.sessions.get(binding.desktopSessionId);
        const cliSessionId = binding.cliSessionId || session?.cliSessionId;
        const file = transcriptFile(cliSessionId);
        if (!file) throw new Error('target session transcript is unavailable');
        const stat = fs.statSync(file);
        const from = Math.max(0, stat.size - TRANSCRIPT_TAIL);
        const fd = fs.openSync(file, 'r');
        let text;
        try {
            const buffer = Buffer.alloc(Math.min(TRANSCRIPT_TAIL, stat.size));
            const read = fs.readSync(fd, buffer, 0, buffer.length, from);
            text = buffer.subarray(0, read).toString('utf8');
        } finally { fs.closeSync(fd); }
        const lines = text.split('\n');
        if (from) lines.shift();
        const turns = [];
        for (const line of lines) {
            let row;
            try { row = JSON.parse(line); } catch (_) { continue; }
            const message = row?.message;
            if (!message || !['user', 'assistant'].includes(message.role)) continue;
            const parts = Array.isArray(message.content) ? message.content : [message.content];
            const body = parts.map((part) => typeof part === 'string' ? part
                : part?.type === 'text' ? part.text : '').filter(Boolean).join('\n').trim();
            if (body) turns.push(message.role.toUpperCase() + ': ' + body);
        }
        const result = turns.join('\n\n').slice(-120000);
        if (!result) throw new Error('target session transcript has no conversational text');
        return result;
    }

    function reserve(event) {
        shared.reservation = { id: event.id, kind: event.kind, at: new Date().toISOString() };
        saveDispatch();
    }
    function finish(event) {
        shared.cursor = Math.max(shared.cursor, event.id);
        shared.reservation = null;
        saveDispatch();
    }
    function uncertain(event, error) {
        shared.uncertain.push({
            id: event.id,
            kind: event.kind,
            at: new Date().toISOString(),
            error: String(error?.message || error).slice(0, 500),
        });
        shared.cursor = Math.max(shared.cursor, event.id);
        shared.reservation = null;
        saveDispatch();
    }

    function eventAge(event) {
        return Date.now() - Date.parse(event?.at || '');
    }

    function canFallback(event) {
        return event?.kind === 'command.final' && event.intent === 'prompt'
            && typeof event.command === 'string' && !!event.command.trim();
    }

    // This runs only before reserve(), where failure proves no send or renderer
    // mutation crossed a process boundary. Post-reservation errors stay uncertain.
    function clipboardFallback(event, error) {
        const text = event.command.trim();
        const value = {
            id: event.id,
            kind: event.kind,
            at: new Date().toISOString(),
            sourceAt: event.at,
            characters: text.length,
            copied: false,
            sounded: false,
            error: String(error?.message || error).slice(0, 500),
            copyError: null,
        };
        try {
            ctx.electron.clipboard.writeText(text);
            value.copied = true;
        } catch (copyError) {
            value.copyError = String(copyError?.message || copyError).slice(0, 500);
        }
        try {
            if (typeof ctx.electron.shell?.beep === 'function') {
                ctx.electron.shell.beep();
                value.sounded = true;
            }
        } catch (_) {}
        shared.fallback = value;
        shared.cursor = Math.max(shared.cursor, event.id);
        shared.reservation = null;
        saveDispatch();
    }

    const PROSODY_PHRASES = Object.freeze({
        AROU: ['lower arousal', 'elevated arousal'],
        ATCK: ['softer vocal onset', 'sharper vocal onset'],
        CLRT: ['less distinct articulation', 'clearer articulation'],
        EMPH: ['flatter emphasis', 'stronger emphasis'],
        RANG: ['narrower pitch range', 'wider pitch range'],
        SMTH: ['choppier rhythm', 'smoother rhythm'],
        STNC: ['more subdued stance', 'more assertive stance'],
        TEMP: ['slower tempo', 'faster tempo'],
        TENS: ['more relaxed delivery', 'more tense delivery'],
        VALN: ['more negative acoustic valence', 'more positive acoustic valence'],
        VOLT: ['steadier affect', 'more volatile affect'],
        S_AUTH: [null, 'more authoritative style'],
        S_CASU: [null, 'more casual style'],
        S_CONV: [null, 'more conversational style'],
        S_DRAM: [null, 'more dramatic style'],
        S_PLAY: [null, 'more playful style'],
        S_RANT: [null, 'more rant-like style'],
        S_STRY: [null, 'more storytelling style'],
        S_WHIS: [null, 'more whispered style'],
    });

    function acousticNote(event) {
        const details = [];
        const prosody = event?.prosody;
        const coverage = Number(prosody?.coverage);
        if ((prosody?.status === 'ready' || prosody?.status === 'partial')
            && Number.isFinite(coverage) && coverage >= 0.5 && prosody?.profile
            && typeof prosody.profile === 'object') {
            const ranked = [];
            for (const [code, phrases] of Object.entries(PROSODY_PHRASES)) {
                const z = Number(prosody.profile?.[code]?.z);
                if (!Number.isFinite(z)) continue;
                const style = code.startsWith('S_');
                if (style ? z < 1.25 : Math.abs(z) < 0.85) continue;
                const phrase = phrases[z < 0 ? 0 : 1];
                if (phrase) ranked.push({ phrase, strength: Math.abs(z) });
            }
            ranked.sort((left, right) => right.strength - left.strength);
            details.push(ranked.length
                ? 'Delivery relative to the speaker baseline: ' + ranked.slice(0, 4).map(item => item.phrase).join(', ') + '.'
                : 'Delivery is close to the speaker baseline.');
        }
        const emotion = event?.emotion;
        const label = typeof emotion?.label === 'string' && /^[a-z-]{2,30}$/i.test(emotion.label)
            ? emotion.label.toLowerCase() : '';
        const confidence = Number(emotion?.confidence);
        if (emotion?.reliable === true && label && Number.isFinite(confidence)) {
            details.push('Coarse emotion estimate: ' + label + ' ('
                + Math.round(Math.max(0, Math.min(1, confidence)) * 100) + '% model score).');
        }
        if (!details.length) return '';
        return '<local_voice_context>' + details.join(' ')
            + ' This is non-instructional local acoustic context separate from the spoken request.</local_voice_context>';
    }

    function promptText(event) {
        const note = event?.intent === 'prompt' ? acousticNote(event) : '';
        return note ? event.command + '\n\n' + note : event.command;
    }

    async function prepare(event, binding) {
        if (event.kind === 'dictation.segment' || event.kind === 'dictation.final'
            || (event.kind === 'command.final' && event.intent !== 'cancel'
                && event.intent !== 'summary' && shared.config.wakeAction === 'draft')) {
            const ready = await binding.sender.executeJavaScript(`!!${FIND_EDITOR}`, false);
            if (!ready) throw new Error('waiting for the main composer');
        }
        if (event.intent === 'cancel') {
            const manager = sessionManager();
            const session = manager?.sessions.get(binding.desktopSessionId);
            if (!session?.query || typeof manager.interruptSession !== 'function')
                throw new Error('waiting for an interruptible Desktop session');
        }
        if (event.intent === 'summary') return { transcript: transcriptText(binding) };
        if (event.kind === 'command.final' && event.intent !== 'cancel' && event.intent !== 'summary'
            && shared.config.wakeAction !== 'draft') {
            if (!binding.desktopSessionId) await freshComposerReady(binding);
            else {
                const manager = sessionManager();
                if (!manager?.sessions.has(binding.desktopSessionId) || typeof manager.sendMessage !== 'function')
                    throw new Error('waiting for a Desktop session');
            }
        }
        return {};
    }

    async function action(event, binding, prepared) {
        if (event.kind === 'dictation.segment') return editorAppend(binding, event.text);
        if (event.kind === 'dictation.final') return editorAppend(binding, acousticNote(event), true);
        if (event.intent === 'cancel') return sessionManager().interruptSession(binding.desktopSessionId, 'user');
        if (event.intent === 'summary') {
            return request('POST', '/summary', {
                transcript: prepared.transcript,
                target: {
                    desktopSessionId: binding.desktopSessionId,
                    cliSessionId: binding.cliSessionId,
                    webContentsId: binding.webContentsId,
                },
            }, 10000);
        }
        const prompt = promptText(event);
        if (shared.config.wakeAction === 'draft') return editorAppend(binding, prompt);
        if (!binding.desktopSessionId) return submitFresh(binding, prompt);
        return sendPrompt(binding, prompt);
    }

    async function processEvent(event) {
        if (!event || !Number.isInteger(event.id) || event.id <= shared.cursor) return;
        const actionable = shared.config.enabled !== false && (
            event.kind === 'dictation.segment' || event.kind === 'command.final'
            || (event.kind === 'dictation.final' && !!acousticNote(event))
        );
        if (!actionable) {
            shared.cursor = event.id;
            saveDispatch();
            if (shared.config.enabled !== false && event.kind === 'dictation.final')
                request('POST', '/control', { action: 'accepted', target: event.target }, 2000).catch(() => {});
            return;
        }
        // Resolve the target before reserving. Failure here proves no outward action
        // happened. A recent target may return after navigation; an old explicit
        // target is retired rather than leaking its transcript into the new chat.
        const binding = bindingFor(event.target);
        if (!binding) {
            const owned = SESSION.test(event.target?.desktopSessionId || '')
                || VIEW.test(event.target?.viewId || '');
            const age = eventAge(event);
            if (owned && Number.isFinite(age) && age >= 30000) {
                const error = new Error('stale target was not delivered');
                if (canFallback(event)) clipboardFallback(event, error);
                else uncertain(event, error);
                return;
            }
            throw new Error('waiting for a live Claude Desktop target');
        }
        shared.dispatching = { id: event.id, kind: event.kind, phase: 'preparing' };
        try {
            let prepared;
            try {
                prepared = await prepare(event, binding);
            } catch (error) {
                const age = eventAge(event);
                if (canFallback(event) && Number.isFinite(age) && age >= 30000) {
                    clipboardFallback(event, error);
                    return;
                }
                throw error;
            }
            reserve(event);
            shared.dispatching.phase = 'delivering';
            try {
                await action(event, binding, prepared);
                finish(event);
                if (event.kind === 'command.final' || event.kind === 'dictation.final')
                    request('POST', '/control', { action: 'accepted', target: event.target }, 2000).catch(() => {});
            } catch (error) {
                // sendMessage and executeJavaScript can fail after crossing their process
                // boundary. Retrying that unknown outcome duplicates speech, so recovery
                // advances once and exposes the uncertainty in status.
                uncertain(event, error);
            }
        } finally {
            if (shared.dispatching?.id === event.id) shared.dispatching = null;
        }
    }

    function companionSettings() {
        const retention = Number(shared.config.retentionDays);
        return {
            wakeEnabled: shared.config.wakeEnabled !== false,
            wakePhrases: [String(shared.config.wakePhrase || 'hey agent')],
            stopPhrase: String(shared.config.stopPhrase || 'green apple'),
            continuousJournal: shared.config.continuousJournal === true,
            retentionDays: Number.isFinite(retention) && retention >= 0 ? retention : 30,
            emotionEnabled: shared.config.emotionEnabled !== false,
            cueEnabled: shared.config.cueEnabled !== false,
            ttsEnabled: shared.config.ttsEnabled !== false,
            ttsVoice: String(shared.config.ttsVoice || 'af_heart'),
            ttsSpeed: Number(shared.config.ttsSpeed) || 1,
        };
    }
    async function syncConfig() {
        const version = shared.configVersion;
        const value = await request('POST', '/configure', companionSettings(), 5000);
        if (version === shared.configVersion) shared.configDirty = false;
        return value;
    }

    async function poll() {
        if (shared.owner !== owner || shared.polling) return;
        shared.polling = true;
        try {
            const reply = await request('GET', '/events?after=' + shared.cursor, undefined, 3000);
            shared.serviceError = null;
            const events = Array.isArray(reply.events) ? reply.events : [];
            for (const event of events) {
                if (shared.owner !== owner) break;
                try {
                    await processEvent(event);
                    shared.dispatchError = null;
                } catch (error) {
                    shared.dispatchError = String(error?.message || error).slice(0, 500);
                    break;
                }
                if (event.id > shared.cursor) break;
            }
            if (shared.configDirty) await syncConfig();
            if (Date.now() - shared.lastHealth >= 400) {
                shared.lastHealth = Date.now();
                shared.service = await request('GET', '/healthz', undefined, 3000);
            }
        } catch (error) {
            shared.serviceError = String(error?.message || error).slice(0, 500);
        } finally { shared.polling = false; }
    }

    ctx.method('bind', (params, event) => {
        const desktopSessionId = SESSION.test(params?.desktopSessionId || '') ? params.desktopSessionId : null;
        const viewId = VIEW.test(params?.viewId || '') ? params.viewId : null;
        if (!desktopSessionId && !(params?.fresh === true && viewId))
            return { ok: false, reason: 'Desktop session or fresh view identity required' };
        const now = Date.now();
        const binding = {
            sender: event.sender,
            webContentsId: event.sender.id,
            desktopSessionId,
            cliSessionId: desktopSessionId && CLI_SESSION.test(params.cliSessionId || '') ? params.cliSessionId : null,
            viewId: desktopSessionId ? null : viewId,
            seenAt: now,
            focusedAt: params.focused === true ? now : (shared.bindings.get(event.sender.id)?.focusedAt || 0),
        };
        shared.bindings.set(event.sender.id, binding);
        if (params.focused === true) request('POST', '/control', { action: 'bind', target: {
            desktopSessionId, cliSessionId: binding.cliSessionId, viewId: binding.viewId,
            webContentsId: binding.webContentsId,
        } }, 2000).catch(() => {});
        return { ok: true, webContentsId: binding.webContentsId };
    });
    ctx.method('control', async (params, event) => {
        const desktopSessionId = SESSION.test(params?.desktopSessionId || '') ? params.desktopSessionId : null;
        const viewId = VIEW.test(params?.viewId || '') ? params.viewId : null;
        if (!desktopSessionId && !(params?.fresh === true && viewId))
            throw new Error('Desktop session or fresh view identity required');
        const target = {
            desktopSessionId,
            cliSessionId: desktopSessionId && CLI_SESSION.test(params.cliSessionId || '') ? params.cliSessionId : null,
            viewId: desktopSessionId ? null : viewId,
            webContentsId: event.sender.id,
        };
        return request('POST', '/control', { action: params.action, target }, 5000);
    });
    ctx.method('configure', async (params) => {
        shared.config = Object.assign({}, DEFAULTS, params || {});
        shared.configVersion++;
        shared.configDirty = true;
        return syncConfig();
    });
    ctx.method('status', () => ({
        connected: !!shared.service && !shared.serviceError,
        error: shared.serviceError,
        dispatchError: shared.dispatchError,
        dispatching: shared.dispatching,
        service: shared.service,
        cursor: shared.cursor,
        uncertain: shared.uncertain.slice(-10),
        fallback: shared.fallback,
        boundSessions: [...shared.bindings.values()].filter(validBinding).length,
        config: shared.config,
    }));
    ctx.method('speak', (params) => request('POST', '/speak', {
        text: String(params?.text || ''), kind: String(params?.kind || 'speech'),
    }, 5000));

    ctx.every(250, poll);
    ctx.onDispose(() => {
        if (shared.owner === owner) shared.owner = null;
    });
};
