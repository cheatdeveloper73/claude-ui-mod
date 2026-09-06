/* claude-ui-mod :: goal (main)
 *
 * The data layer for the goal band. Everything it serves is derived from the
 * CLI's own transcript, because that is where the goal system actually keeps
 * its record — and it is a better source than the app's stream state, which is
 * what the built-in indicator reads and loses.
 *
 * What /goal really does, read out of claude.exe (CLI 2.1.222):
 *
 *   /goal <condition>   registers a session-scoped Stop hook of type "prompt"
 *                       and sets activeGoal = { condition, iterations, setAt,
 *                       origin, tokensAtStart }. Every attempt to end the turn
 *                       is then graded by an evaluator against the condition.
 *
 * Each of those events lands in ~/.claude/projects/<slug>/<cliSessionId>.jsonl
 * as an attachment:
 *
 *   { type:"goal_status", met:false, sentinel:true, condition }   goal armed
 *   { type:"goal_status", met:true,  sentinel:true, condition }   goal cleared
 *   { type:"goal_status", met, condition, reason,                 a check-in
 *     failed?, iterations?, durationMs?, tokens? }
 *
 * The `reason` on a check-in is the evaluator's full written verdict on the
 * goal, produced every single time the model tried to stop. It is the progress
 * readout the desktop never shows, and the whole point of this plugin.
 *
 * INTERRUPT IS NOT A CLEAR PATH. The CLI's clear classifier returns null — keep
 * the goal — for aborted_streaming, aborted_tools, hook_stopped,
 * stop_hook_prevented and max_turns. The complete set of real clears is:
 * /goal clear (user_clear), a new /goal (superseded), session resume
 * (resume_swap), the condition being met or judged impossible, and an
 * unrecoverable error (auth, billing, context limit, model unavailable).
 * Verified on disk: session 4754d158 carried one /goal through ten interrupts
 * and 43 evaluations over six and a half hours before it was met.
 *
 * A user clear and an error clear write the SAME sentinel, so the only thing
 * that tells them apart is the warning the CLI emits alongside the error one
 * ("Goal cleared after an unrecoverable error"). Auto re-arm keys off that
 * string, which is why the scan looks for it as well.
 *
 * Cost discipline: a busy transcript is 15MB and grows all turn. The scan is
 * therefore incremental — a byte cursor per file, only appended bytes are read,
 * and a line is handed to JSON.parse only if it carries one of two substrings.
 * That is what makes the renderer's poll affordable: a tick with no new bytes
 * costs one stat and a replay of a few dozen cached records, so this side needs
 * no watcher and the bridge needs no host-event fan-out it does not have.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MARK = '"goal_status"';
const ERRMARK = 'Goal cleared after an unrecoverable error';
const CHUNK = 4 * 1024 * 1024;      // ceiling on one read, not on the file

module.exports = function (ctx) {
    // ---------------------------------------------------------------- project
    // The slug is a mangling of the cwd; rather than reproduce it, find the
    // directory that already contains this session.
    const projCache = new Map();     // cliSid -> { file, at }
    function transcriptFor(cliSid) {
        if (typeof cliSid !== 'string' || !SESSION_RE.test(cliSid)) return null;
        const hit = projCache.get(cliSid);
        if (hit && Date.now() - hit.at < 60000) return hit.file;
        let dirs = [];
        try { dirs = fs.readdirSync(PROJECTS); } catch (_) { return null; }
        let found = null;
        for (const d of dirs) {
            const f = path.join(PROJECTS, d, cliSid + '.jsonl');
            if (fs.existsSync(f)) { found = f; break; }
        }
        projCache.set(cliSid, { file: found, at: Date.now() });
        return found;
    }

    // ---------------------------------------------------------------- scan
    // One entry per transcript. `offset` is how far into the file the records
    // already account for; `carry` is the tail of the last read, which is a
    // partial line whenever the CLI was mid-append.
    const scans = new Map();         // file -> { offset, carry, recs }

    function parse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

    function record(line) {
        const d = parse(line);
        if (!d) return null;
        const a = d.attachment;
        if (!a || a.type !== 'goal_status' || typeof a.condition !== 'string') {
            // The error clear is a warning message, not an attachment, and it
            // is the only thing that separates an unrecoverable-error clear from
            // a user clear — both write the identical sentinel.
            //
            // The `message` guard is not defensive padding. Any conversation
            // that discusses the goal system puts this exact sentence into its
            // own transcript as ordinary prose, and without the guard reading
            // about a clear would register as one. This file's development
            // session carries six such lines, every one of them a user or
            // assistant turn.
            if (line.indexOf(ERRMARK) !== -1 && !d.message && d.type !== 'user' && d.type !== 'assistant') {
                return { kind: 'error-clear', t: d.timestamp || null };
            }
            return null;
        }
        return {
            kind: 'status',
            t: d.timestamp || null,
            sentinel: !!a.sentinel,
            met: !!a.met,
            failed: !!a.failed,
            condition: a.condition,
            reason: typeof a.reason === 'string' ? a.reason : '',
            iterations: typeof a.iterations === 'number' ? a.iterations : null,
            durationMs: typeof a.durationMs === 'number' ? a.durationMs : null,
            tokens: typeof a.tokens === 'number' ? a.tokens : null,
        };
    }

    function scan(file) {
        let st = null;
        try { st = fs.statSync(file); } catch (_) { scans.delete(file); return null; }

        let s = scans.get(file);
        // A file that shrank is a different file: /clear rewrites the transcript
        // and a resumed session can start a fresh one under the same name. The
        // cursor from the old one would land mid-line in the new.
        if (!s || st.size < s.offset) { s = { offset: 0, carry: '', recs: [] }; scans.set(file, s); }
        if (st.size === s.offset) return s;

        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            while (s.offset < st.size) {
                const len = Math.min(CHUNK, st.size - s.offset);
                const buf = Buffer.alloc(len);
                const n = fs.readSync(fd, buf, 0, len, s.offset);
                if (n <= 0) break;
                s.offset += n;
                const text = s.carry + buf.slice(0, n).toString('utf8');
                const lines = text.split('\n');
                // The last element is whatever came after the final newline. It
                // is only a complete line if the read ended exactly on one, so
                // it is always carried rather than parsed.
                s.carry = lines.pop();
                for (const line of lines) {
                    // Two substring tests before any JSON.parse. On a 15MB
                    // transcript that is the difference between a blink and a
                    // stall — practically every line matches neither.
                    if (line.indexOf(MARK) === -1 && line.indexOf(ERRMARK) === -1) continue;
                    const r = record(line);
                    if (r) s.recs.push(r);
                }
            }
        } catch (_) {
            return s;
        } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
        return s;
    }

    // ---------------------------------------------------------------- derive
    // Replay the records in order. Everything the band shows falls out of this
    // one pass: what is armed, how many times it has been graded, what the
    // evaluator last said, and how the previous goal ended.
    function derive(recs) {
        let live = null;
        let last = null;

        const close = (how, at, final) => {
            if (!live) return;
            last = {
                condition: live.condition, setAt: live.setAt, endedAt: at, how,
                checkins: live.checkins, final: final || null,
            };
            live = null;
        };

        for (const r of recs) {
            if (r.kind === 'error-clear') { close('error', r.t, null); continue; }
            if (r.sentinel) {
                // met=true sentinel is a clear; met=false is an arm. An arm
                // while one is already live is the CLI's "superseded" path.
                if (r.met) close('cleared', r.t, null);
                else {
                    close('superseded', r.t, null);
                    live = { condition: r.condition, setAt: r.t, checkins: [], restored: false };
                }
                continue;
            }
            // A check-in for a condition that was never armed in this file is a
            // resume: the CLI restores the goal from the transcript on resume
            // and does not write a fresh sentinel when it does.
            if (!live || live.condition !== r.condition) {
                close('superseded', r.t, null);
                live = { condition: r.condition, setAt: r.t, checkins: [], restored: true };
            }
            live.checkins.push(r);
            if (r.met || r.failed) close(r.failed ? 'impossible' : 'met', r.t, r);
        }

        return { live, last };
    }

    const trim = (c) => ({
        t: c.t, met: c.met, failed: c.failed, reason: c.reason,
        iterations: c.iterations, durationMs: c.durationMs, tokens: c.tokens,
    });

    // ---------------------------------------------------------------- methods
    ctx.method('state', (p) => {
        const file = transcriptFor(p && p.cliSid);
        if (!file) return { ok: false, reason: 'no-transcript' };
        const s = scan(file);
        if (!s) return { ok: false, reason: 'no-transcript' };
        const { live, last } = derive(s.recs);

        // The band never needs every check-in at once; the sheet asks for the
        // rest. Shipping 43 verdicts of 800 characters on a poll would be 30KB
        // a tick over IPC to draw a strip showing one line of it.
        return {
            ok: true,
            file,
            armed: !!live,
            condition: live ? live.condition : (last ? last.condition : null),
            setAt: live ? live.setAt : null,
            restored: live ? live.restored : false,
            checkins: live ? live.checkins.length : 0,
            latest: live && live.checkins.length ? trim(live.checkins[live.checkins.length - 1]) : null,
            last: last ? {
                condition: last.condition, how: last.how, endedAt: last.endedAt,
                checkins: last.checkins.length,
                final: last.final ? trim(last.final) : null,
            } : null,
        };
    });

    // Full history, on demand — the sheet's payload, never the band's.
    ctx.method('history', (p) => {
        const file = transcriptFor(p && p.cliSid);
        if (!file) return { ok: false, checkins: [] };
        const s = scan(file);
        if (!s) return { ok: false, checkins: [] };
        const { live, last } = derive(s.recs);
        const which = live || last;
        if (!which) return { ok: true, condition: null, checkins: [] };
        return {
            ok: true,
            condition: which.condition,
            setAt: which.setAt,
            armed: !!live,
            how: live ? null : last.how,
            checkins: which.checkins.map(trim),
        };
    });

    // ---------------------------------------------------------------- editor
    /* The composer is TipTap and the ProseMirror node carries the editor
     * instance as an expando (`el.editor`). Expandos are per-world, so the
     * preload's isolated world cannot see it — only webContents.executeJavaScript
     * runs in the page's own world. Reading through the real instance rather
     * than scraping textContent is what preserves newlines in a multi-line
     * condition, and clearing through it goes via a ProseMirror transaction, so
     * the app's own draft state stays in step.
     *
     * The queue plugin has the same pair of methods for the same reason. They
     * are duplicated rather than shared: a plugin that reached into another
     * plugin's RPC would break whenever that one is disabled, and the two are
     * independently installable.
     *
     * The measure rule for picking the main composer over the side panel's has
     * to match the one in renderer.js exactly, or a /goal typed into one editor
     * would be read out of the other. */
    const FIND = "(function(){"
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

    function snippet(bodyJs) {
        return '(() => { try { var ed = ' + FIND + ';'
            + ' if (!ed) return { ok: false, reason: "no-editor" };'
            + bodyJs
            + ' } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } })()';
    }

    const GET = snippet(' var t = ed.getText(); return { ok: true, text: t }; ');
    const CLEAR = snippet(' ed.commands.clearContent(true); return { ok: true }; ');

    ctx.method('editorGet', (p, event) => event.sender.executeJavaScript(GET, false));
    ctx.method('editorClear', (p, event) => event.sender.executeJavaScript(CLEAR, false));

    ctx.onDispose(() => { scans.clear(); projCache.clear(); });
};
