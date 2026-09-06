/* claude-ui-mod :: queue (main)
 *
 * Disk-backed store for the explicit send queue, plus the only route to the
 * composer's editor.
 *
 * Why the editor lives here: the composer is TipTap, and the ProseMirror DOM
 * node carries the editor instance as an expando (`el.editor`). Expandos are
 * per-world, so the preload's isolated world cannot see it — only
 * webContents.executeJavaScript runs in the page's own world. Going through the
 * real editor instance rather than synthesising keystrokes means reads, clears
 * and inserts all go through ProseMirror transactions, so the app's own draft
 * state stays in sync (TipTap emits onUpdate, which is what the app listens to).
 *
 * There are two ProseMirror editors on screen — the main composer and the side
 * panel's. `.epitaxy-composer-width` used to separate them and is gone from the
 * build the app serves from claude.ai, so they are told apart by measure here
 * exactly as they are in renderer.js: the main composer spans the transcript
 * column, the side panel's is a narrower one. Both halves have to agree, or a
 * queued edit reads one editor and writes the other.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function (ctx) {
    const STATE = path.join(ctx.dir, '..', '..', '..', '.state', 'queue.json');

    // Cached, but re-read when the file changes underneath us: a second window
    // on the same session writes the same file, and holding the first read
    // forever would make one of them authoritative until restart.
    let data = null;
    let stamp = '';
    function read() {
        let st = null;
        try { st = fs.statSync(STATE); } catch (_) {}
        const now = st ? st.mtimeMs + ':' + st.size : '';
        if (data && now === stamp) return data;
        stamp = now;
        try { data = JSON.parse(fs.readFileSync(STATE, 'utf8')); }
        catch (_) { data = {}; }
        if (!data || typeof data !== 'object') data = {};
        return data;
    }

    // Same write discipline as the dashboard: debounced, and atomic so a crash
    // mid-write cannot leave a truncated queue behind.
    let timer = null;
    function flush() {
        timer = null;
        const tmp = STATE + '.tmp';
        try {
            fs.mkdirSync(path.dirname(STATE), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
            fs.renameSync(tmp, STATE);
            try { const st = fs.statSync(STATE); stamp = st.mtimeMs + ':' + st.size; } catch (_) { stamp = ''; }
        } catch (e) { ctx.log('queue save failed: ' + ((e && e.message) || e)); }
    }
    ctx.onDispose(() => { if (timer) { clearTimeout(timer); flush(); } });

    ctx.method('load', () => read());
    ctx.method('save', (p) => {
        const d = read();
        const sid = p && p.sid;
        if (!sid) return false;
        const items = Array.isArray(p.items) ? p.items : [];
        if (items.length) d[sid] = items; else delete d[sid];
        clearTimeout(timer);
        timer = setTimeout(flush, 250);
        return true;
    });

    // ---------------------------------------------------------------- editor
    // Every op re-finds the editor: the composer remounts on session switch, so
    // a cached reference would go stale exactly when it is needed.
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

    function snippet(body) {
        return '(() => { try { var ed = ' + FIND + ';'
            + ' if (!ed) return { ok: false, reason: "no-editor" };'
            + body
            + ' } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } })()';
    }

    const GET = snippet(
        ' var t = ed.getText();'
        + ' return { ok: true, text: t, empty: !t || !t.trim(), focused: !!ed.isFocused };'
    );
    const CLEAR = snippet(' ed.commands.clearContent(true); return { ok: true }; ');

    function setScript(text) {
        // setContent with a plain string would be parsed as HTML; the text is
        // fed as an explicit paragraph doc so "<" and "&" survive verbatim and
        // blank lines stay blank lines.
        return snippet(
            ' var lines = ' + JSON.stringify(String(text).split('\n')) + ';'
            + ' var doc = { type: "doc", content: lines.map(function (l) {'
            + '   return l.length ? { type: "paragraph", content: [{ type: "text", text: l }] }'
            + '                   : { type: "paragraph" }; }) };'
            + ' ed.commands.setContent(doc, true);'
            + ' ed.commands.focus("end");'
            + ' return { ok: true };'
        );
    }

    // ------------------------------------------------------- foreground tool
    /* A steer is supposed to land NOW. It does not, when the turn is sitting in
     * a foreground tool call: the CLI only reads the injected message once the
     * tool returns, so a call that never returns swallows the steer with it.
     *
     * There are two levers, and which one applies is decided by the tool:
     *
     *   query.backgroundTasks(toolUseId)
     *     -> { subtype: 'background_tasks', tool_use_id } -> { backgrounded }
     *
     * backgrounds the call and preserves its work, but ONLY for a call that
     * owns a task registry entry. The CLI's handler is a lookup keyed on
     * toolUseId with exactly two arms (claude.exe 1.26832):
     *
     *   for (let [n, r] of Object.entries(t.all())) {
     *       if (r.toolUseId !== e) continue;
     *       if (Bg(r) && !r.isBackgrounded && r.shellCommand) return Wnr(n, t);
     *       if (Uo(r) && !r.isBackgrounded && !Age(r)) { VJ(n, t); return !0 }
     *       return !1;
     *   }
     *   return !1;
     *
     * Bg is type === 'local_bash', Uo is type === 'local_agent'. So: Bash and
     * a foreground Agent, and nothing else in the tool set. A TaskOutput call
     * has no registry entry at all — it is not a task, it is a poll watching
     * one — so it falls off the end and answers false. That is the case that
     * looked like the feature silently not working: TaskOutput blocks in
     *
     *   while (Date.now() - o < n) {
     *       if (r?.signal.aborted) throw new Zn;
     *       let a = t().tasks?.[e];
     *       if (!a) return null;
     *       if (a.status !== 'running' && a.status !== 'pending') return a;
     *       await en(100);
     *   }
     *
     * for up to its `timeout` input — 30s by default, 600s if the model asks —
     * and only the watched task ending, that timeout, or an abort ends it.
     * Backgrounding the watched task does not: VJ sets isBackgrounded and
     * leaves `status` on 'running', which the loop keeps sleeping through.
     *
     * The second lever is the message's own priority. The desktop's exposed
     * LocalSessions.sendMessage already validates three values —
     * `s === 'now' || s === 'next' || s === 'later'` — and passes them through
     * to the CLI's queue. The headless input loop subscribes to that queue:
     *
     *   y.subscribe(() => {
     *       if (Re && !tn() && y.getCommandsByMaxPriority('now').length > 0)
     *           Re.abort(rr('interrupt'));
     *   });
     *
     * Re is the in-flight turn's abort controller, tn() is "shutting down". So
     * 'now' ends the turn wherever it is standing and the message is dequeued
     * first. It is NOT the `interrupt` control request: that one additionally
     * runs a task sweep which kills every running agent, backgrounded ones
     * included. 'now' is the bare abort, and a backgrounded subagent runs on
     * its own controller (the Agent tool's stream override takes the task's
     * abortController, not the tool call's), so it keeps going.
     *
     * Hence the policy here: background the call when the CLI can, because
     * that keeps its work; otherwise say so and let the renderer send 'now',
     * because the only thing lost is a poll that costs nothing to redo.
     *
     * The CLI declines to background a tool that has only just started —
     * the same tool_use_id answered `backgrounded: false` twice and then
     * `true` about three seconds in. That is not worth retrying around: a
     * steer aimed at a tool that young is read when it returns a moment
     * later anyway, and 'now' covers it regardless. The message sends either
     * way.
     */
    const TAIL_BYTES = 512 * 1024;

    // The only two arms of the CLI's toolUseId lookup: a local_bash task and a
    // local_agent task. Anything else is not in the registry and answers false,
    // so asking costs a control round trip to learn nothing.
    const BACKGROUNDABLE = new Set(['Bash', 'Agent', 'Task']);
    const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

    let mgrCache = null;
    function sessionManager() {
        if (mgrCache && mgrCache.sessions && typeof mgrCache.sessions.get === 'function') return mgrCache;
        mgrCache = null;
        for (const k of Object.keys(require.cache)) {
            let e;
            try { e = require.cache[k] && require.cache[k].exports; } catch (_) { continue; }
            if (!e || typeof e !== 'object') continue;
            const m = e.claudeCodeSessionManager;
            if (m && m.sessions && typeof m.sessions.get === 'function') { mgrCache = m; break; }
        }
        return mgrCache;
    }

    function transcriptFile(cliSid) {
        let dirs = [];
        try { dirs = fs.readdirSync(PROJECTS); } catch (_) { return null; }
        for (const d of dirs) {
            const f = path.join(PROJECTS, d, cliSid + '.jsonl');
            if (fs.existsSync(f)) return f;
        }
        return null;
    }

    // The outstanding foreground tool call: the last tool_use with no
    // tool_result. Only the tail is read — a busy session's parent transcript
    // runs to tens of megabytes and this is on the path of a keypress.
    function foregroundToolUse(file) {
        let st;
        try { st = fs.statSync(file); } catch (_) { return null; }
        const from = Math.max(0, st.size - TAIL_BYTES);
        let text = '';
        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            const len = Math.min(TAIL_BYTES, st.size);
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, from);
            text = buf.subarray(0, n).toString('utf8');
        } catch (_) { return null; }
        finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }

        const lines = text.split('\n');
        if (from > 0) lines.shift();     // a tail chunk starts mid-line

        const done = new Set();
        const open = [];
        for (const line of lines) {
            if (!line.trim()) continue;
            let d;
            try { d = JSON.parse(line); } catch (_) { continue; }
            const c = d && d.message && d.message.content;
            if (!Array.isArray(c)) continue;
            for (const part of c) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'tool_result' && part.tool_use_id) done.add(part.tool_use_id);
                else if (part.type === 'tool_use' && part.id) open.push({ id: part.id, name: part.name || null });
            }
        }
        for (let i = open.length - 1; i >= 0; i--) {
            if (done.has(open[i].id)) continue;
            return open[i];
        }
        return null;
    }

    // Never let this hold up the send. Whatever happens here, the message goes.
    function withTimeout(promise, ms) {
        return new Promise((resolve) => {
            let settled = false;
            const t = setTimeout(() => { if (!settled) { settled = true; resolve({ timedOut: true }); } }, ms);
            promise.then(
                (v) => { if (!settled) { settled = true; clearTimeout(t); resolve({ value: v }); } },
                (e) => { if (!settled) { settled = true; clearTimeout(t); resolve({ error: String((e && e.message) || e) }); } }
            );
        });
    }

    ctx.method('backgroundForeground', async (p) => {
        const sid = p && p.sid;
        if (typeof sid !== 'string' || !/^local_[0-9a-f-]{36}$/i.test(sid)) return { ok: false, reason: 'bad session id' };
        const mgr = sessionManager();
        if (!mgr) return { ok: false, reason: 'no session manager' };
        const sess = mgr.sessions.get(sid);
        if (!sess) return { ok: false, reason: 'unknown session' };
        const q = sess.query;
        if (!q || typeof q.backgroundTasks !== 'function') return { ok: false, reason: 'session has no live query' };
        const cliSid = sess.cliSessionId;
        if (!cliSid) return { ok: false, reason: 'no cli session id' };
        const file = transcriptFile(cliSid);
        if (!file) return { ok: false, reason: 'no transcript' };
        const tu = foregroundToolUse(file);
        if (!tu) return { ok: true, backgrounded: false, reason: 'nothing in the foreground' };
        // Not asking is the point: for a tool with no task the answer is a
        // known false, and waiting up to 1.5s for it would put the delay back
        // on the exact steer this exists to make instant.
        if (!BACKGROUNDABLE.has(tu.name)) {
            return { ok: true, backgrounded: false, reason: 'not a task', tool: tu.name, toolUseId: tu.id };
        }

        const r = await withTimeout(Promise.resolve().then(() => q.backgroundTasks(tu.id)), 1500);
        if (r.timedOut) return { ok: false, reason: 'timeout', tool: tu.name, toolUseId: tu.id };
        if (r.error) return { ok: false, reason: r.error, tool: tu.name, toolUseId: tu.id };
        return { ok: true, backgrounded: r.value !== false, tool: tu.name, toolUseId: tu.id };
    });

    const run = (wc, code) => wc.executeJavaScript(code, false);

    ctx.method('editorGet', (p, event) => run(event.sender, GET));
    ctx.method('editorClear', (p, event) => run(event.sender, CLEAR));
    ctx.method('editorSet', (p, event) => run(event.sender, setScript((p && p.text) || '')));
};
