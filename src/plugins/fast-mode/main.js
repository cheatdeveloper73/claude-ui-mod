/* claude-ui-mod :: fast-mode (main)
 *
 * Makes the composer's fast switch belong to the session it is shown on.
 *
 * Desktop keeps no per-session fast state for a started session. Its
 * LocalSessions.setFastMode only pushes applyFlagSettings({fastMode}) to the
 * live worker (pendingFirstStart.options is written only before the first
 * process). The switch itself (pinned frontend, Bf in c66fe388e) shows the
 * value picked in the current opening, else the one global `fastMode` in the
 * epitaxyPrefs bucket. So after a switch in session A, every other session
 * showed A's value, and the next (re)start of a session took whatever the
 * composer showed at that moment.
 *
 * Every caller reaches the manager's setFastMode: the composer switch, the
 * ccd_session_mgmt tool, and Desktop's own turn-off when usage credits run out.
 * Wrapping it records what was last set per session in .state/fast-mode.json.
 * The renderer half writes that value back into the epitaxyPrefs bucket when a
 * session comes on screen, and provider-routing puts it in the launch settings
 * of that session's next worker. The same values, indexed by Claude Code
 * session id under `cli`, let router/fast-mode.mjs follow a switch on the next
 * GPT request rather than the next turn.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STATE = ['.state', 'fast-mode.json'];
// On the worker's query object, so a host reload does not push twice.
const GRANTED = Symbol.for('cuimod.fast-mode.granted');

function statePath(modDir) { return path.join(modDir, ...STATE); }

function readState(modDir) {
    try {
        const value = JSON.parse(fs.readFileSync(statePath(modDir), 'utf8'));
        const sessions = value?.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) ? value.sessions : {};
        const cli = value?.cli && typeof value.cli === 'object' && !Array.isArray(value.cli) ? value.cli : {};
        const flags = map => Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'boolean'));
        return { sessions: flags(sessions), draft: typeof value?.draft === 'boolean' ? value.draft : null, cli: flags(cli) };
    } catch (_) { return { sessions: {}, draft: null, cli: {} }; }
}

// What the user last set on this Desktop session, or undefined when never set.
function readFastIntent(modDir, sessionId) {
    const value = readState(modDir).sessions[String(sessionId || '')];
    return typeof value === 'boolean' ? value : undefined;
}

function managers() {
    const found = [];
    for (const module of Object.values(require.cache || {})) {
        const manager = module?.exports?.claudeCodeSessionManager;
        if (manager?.sessions && typeof manager.setFastMode === 'function' && !found.includes(manager)) found.push(manager);
    }
    return found;
}

module.exports = function (ctx) {
    const modDir = ctx.boot?.MOD_DIR || path.resolve(ctx.dir, '..', '..', '..');
    let state = readState(modDir);

    function save() {
        const file = statePath(modDir);
        const tmp = file + '.tmp-' + process.pid;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
            fs.renameSync(tmp, file);
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            ctx.log('fast-mode state write failed: ' + err.message);
        }
    }

    // `byUser` also moves the draft default: before this plugin the one global
    // value was simply the last switch the user flipped, anywhere.
    function record(sessionId, value, byUser = false) {
        if (typeof sessionId !== 'string' || !sessionId) return;
        const draft = byUser ? value : state.draft;
        if (state.sessions[sessionId] === value && state.draft === draft) return;
        state.sessions[sessionId] = value;
        state.draft = draft;
        state.cli = cliIndex() || state.cli;
        save();
    }

    // Rebuilt from the manager, not appended: /clear gives a session a new
    // Claude Code id, and the router must find the switch under that one.
    // null while no manager is loaded, so an early tick cannot wipe the index.
    function cliIndex() {
        const found = managers();
        if (!found.length) return null;
        const next = {};
        for (const [sessionId, value] of Object.entries(state.sessions)) for (const manager of found) {
            const cli = manager.sessions.get(sessionId)?.cliSessionId;
            if (typeof cli === 'string' && cli) next[cli.toLowerCase()] = value;
        }
        return next;
    }
    function reindex() {
        const next = cliIndex();
        if (next && JSON.stringify(next) !== JSON.stringify(state.cli)) { state.cli = next; save(); }
    }

    // A worker spawned before provider-routing added the fast_mode capability
    // env ignores the switch on GPT. apply_flag_settings env reaches the CLI's
    // capability read live (measured on 2.1.284: fastMode alone left a GPT turn
    // standard; with the env patch the same worker sent speed:"fast"). The
    // session's persisted flag env is re-sent with it, so no other key moves.
    async function grantFast(session) {
        const query = session.query;
        if (typeof query?.applyFlagSettings !== 'function' || query[GRANTED]) return;
        const { codexFastSlugs, fastModeCapabilities } = require('../provider-routing/main');
        const slugs = codexFastSlugs();
        if (!slugs.length) return;
        try {
            await query.applyFlagSettings({ env: { ...(session.sessionSettings?.env || {}),
                CLAUDE_CODE_MODEL_CAPABILITIES: fastModeCapabilities(slugs, process.env.CLAUDE_CODE_MODEL_CAPABILITIES) } });
            query[GRANTED] = true;
        } catch (err) { ctx.log('fast-mode capability push failed: ' + (err?.message || err)); }
    }

    // manager -> { original, wrapper }
    const wrapped = new Map();
    function attach() {
        for (const manager of managers()) {
            const current = manager.setFastMode;
            if (wrapped.get(manager)?.wrapper === current) continue;
            // A newer host generation is built before this one is disposed;
            // unwrap to the app's own method so wrappers never stack.
            const original = current.__cuimodFastOriginal || current;
            const wrapper = function (sessionId, fastMode, ...rest) {
                // Recorded before the call: Desktop's setFastMode can wait on an
                // in-flight start, and the session must read back as set while
                // it does.
                // The third argument is Desktop's caller tag: "agent" for the
                // session tool; absent for the composer and for the credits
                // turn-off, which is a fair default for the next session too.
                const session = this.sessions?.get?.(sessionId);
                if (!session) return original.call(this, sessionId, fastMode, ...rest);
                record(sessionId, fastMode === true, rest[0] !== 'agent');
                if (fastMode !== true || !session.query || session.query[GRANTED]) return original.call(this, sessionId, fastMode, ...rest);
                return grantFast(session).then(() => original.call(this, sessionId, fastMode, ...rest));
            };
            wrapper.__cuimodFastOriginal = original;
            manager.setFastMode = wrapper;
            wrapped.set(manager, { original, wrapper });
        }
    }
    attach();
    reindex();
    ctx.every(1000, () => { attach(); reindex(); });
    ctx.onDispose(() => {
        for (const [manager, { original, wrapper }] of wrapped)
            if (manager.setFastMode === wrapper) manager.setFastMode = original;
        wrapped.clear();
    });

    function session(sessionId) {
        for (const manager of managers()) {
            const found = manager.sessions.get(sessionId);
            if (found) return found;
        }
        return null;
    }

    // true/false: what the switch should show for this session. null: not
    // knowable yet, leave the switch alone.
    ctx.method('desired', p => {
        const sessionId = String(p?.sessionId || '');
        if (typeof state.sessions[sessionId] === 'boolean') return state.sessions[sessionId];
        const s = session(sessionId);
        if (!s) return null;
        // A session created from the draft carries the draft's switch until its
        // first process attaches; keep it, so the switch does not flip off.
        const pending = s.pendingFirstStart?.options?.fastMode;
        if (typeof pending === 'boolean') { record(sessionId, pending); return pending; }
        if (s.pendingFirstStart) return null;
        // Never set here: the worker's own report is the truth. A live worker
        // that has not reported yet is unknown; a stopped one resumes with
        // whatever the switch shows, and a session nobody set runs standard.
        if (s.fastModeState === 'on' || s.fastModeState === 'cooldown') return true;
        if (s.fastModeState === 'off') return false;
        return s.query ? null : false;
    });

    // The draft composer (no session yet) keeps Desktop's own meaning of the
    // switch: the last value picked there carries into the next new session.
    ctx.method('draft', p => {
        if (typeof p?.value === 'boolean' && state.draft !== p.value) { state.draft = p.value; save(); }
        return state.draft;
    });
};

module.exports.readFastIntent = readFastIntent;
