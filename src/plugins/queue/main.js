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
    const modDir = ctx.boot?.MOD_DIR || path.join(ctx.dir, '..', '..', '..');
    const STATE = path.join(modDir, '.state', 'queue.json');
    const SETTINGS = path.join(modDir, '.state', 'settings.json');
    const SESSION = /^local_[0-9a-f-]{36}$/i;
    const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/;
    const DEFAULTS = { enabled: true, autoSend: true, autoSendDelay: 350 };

    function images(value) {
        if (!Array.isArray(value)) return [];
        const out = [];
        for (const image of value) {
            if (out.length >= 5) break;
            if (!image || typeof image !== 'object') continue;
            if (typeof image.base64 !== 'string' || !image.base64 || !IMAGE_MIME.test(image.mimeType || '')) continue;
            const next = { base64: image.base64, mimeType: image.mimeType };
            if (typeof image.filename === 'string' && image.filename) next.filename = image.filename;
            out.push(next);
        }
        return out;
    }

    function queuedItem(item) {
        const next = { id: item.id, text: item.text, at: Number(item.at) || Date.now() };
        const attached = images(item.images);
        if (attached.length) next.images = attached;
        return next;
    }

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
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
        return data;
    }

    function savedConfig() {
        try {
            const all = JSON.parse(fs.readFileSync(SETTINGS, 'utf8').replace(/^﻿/, ''));
            return Object.assign({}, DEFAULTS, all && all.queue);
        } catch (_) { return Object.assign({}, DEFAULTS); }
    }
    let config = savedConfig();
    const shared = globalThis[Symbol.for('cuimod.queue.drains')]
        || (globalThis[Symbol.for('cuimod.queue.drains')] = { sessions: new Set() });

    // Same write discipline as the dashboard: debounced, and atomic so a crash
    // mid-write cannot leave a truncated queue behind. A successful send flushes
    // synchronously: once delivery has answered, a crash must not resurrect the
    // released item from older disk state and send it twice after restart.
    let timer = null;
    function flush() {
        timer = null;
        const tmp = STATE + '.tmp';
        try {
            fs.mkdirSync(path.dirname(STATE), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
            fs.renameSync(tmp, STATE);
            try { const st = fs.statSync(STATE); stamp = st.mtimeMs + ':' + st.size; } catch (_) { stamp = ''; }
            return true;
        } catch (e) {
            ctx.log('queue save failed: ' + ((e && e.message) || e));
            return false;
        }
    }
    function scheduleFlush() {
        clearTimeout(timer);
        timer = setTimeout(flush, 250);
    }
    function notify(sid, sentId) {
        ctx.broadcast({ type: 'queue-changed', sessionId: sid, sentId: sentId || null });
    }
    function replace(sid, items, sentId, immediate) {
        const d = read();
        const next = Array.isArray(items) ? items : [];
        if (next.length) d[sid] = next; else delete d[sid];
        if (immediate) {
            if (timer) clearTimeout(timer);
            if (!flush()) scheduleFlush();
        } else scheduleFlush();
        notify(sid, sentId);
        return next;
    }
    function current(sid) {
        const value = read()[sid];
        return Array.isArray(value) ? value : [];
    }

    ctx.onDispose(() => { if (timer) { clearTimeout(timer); flush(); } });

    ctx.method('load', () => read());
    // Kept for a renderer from the preceding hot generation. New code mutates by
    // item so a background drain cannot be overwritten by a stale whole-array save.
    ctx.method('save', (p) => {
        const sid = p && p.sid;
        if (!SESSION.test(sid || '')) return false;
        replace(sid, p.items);
        return true;
    });
    ctx.method('enqueue', (p) => {
        const sid = p && p.sid;
        const item = p && p.item;
        if (!SESSION.test(sid || '') || !item || typeof item.id !== 'string' || typeof item.text !== 'string')
            throw new Error('valid session and queue item required');
        const items = current(sid);
        return replace(sid, items.some((x) => x && x.id === item.id) ? items : items.concat([queuedItem(item)]));
    });
    ctx.method('update', (p) => {
        const sid = p && p.sid;
        if (!SESSION.test(sid || '') || typeof p.id !== 'string' || typeof p.text !== 'string')
            throw new Error('valid session, item id and text required');
        const replaceImages = Object.prototype.hasOwnProperty.call(p, 'images');
        return replace(sid, current(sid).map((x) => {
            if (!x || x.id !== p.id) return x;
            const next = Object.assign({}, x, { text: p.text });
            if (replaceImages) {
                const attached = images(p.images);
                if (attached.length) next.images = attached; else delete next.images;
            }
            return next;
        }));
    });
    ctx.method('remove', (p) => {
        const sid = p && p.sid;
        if (!SESSION.test(sid || '') || typeof p.id !== 'string') throw new Error('valid session and item id required');
        return replace(sid, current(sid).filter((x) => !x || x.id !== p.id));
    });

    // ---------------------------------------------------------------- editor
    // Every op re-finds the editor: the composer remounts on session switch, so
    // a cached reference would go stale exactly when it is needed.
    const FIND_NODE = "(function(){"
        + " var els = document.querySelectorAll('.epitaxy-prompt-input .tiptap');"
        + " var best = null, bestRect = null;"
        + " for (var i = 0; i < els.length; i++) {"
        + "   var e = els[i];"
        + "   if (!e.editor) continue;"
        + "   if (e.closest('.epitaxy-composer-width')) return e;"
        + "   var r = e.getBoundingClientRect();"
        + "   if (r.width < 120) continue;"
        + "   if (!bestRect || r.width > bestRect.width + 8 ||"
        + "       (Math.abs(r.width - bestRect.width) <= 8 && r.bottom > bestRect.bottom)) { best = e; bestRect = r; }"
        + " }"
        + " return best; })()";

    // Attachment state is a React hook closure, separate from TipTap. The live
    // 2026-09-21 composer passes a staging facade through the prompt fiber's
    // props; the pinned older release retains the same facade in hook state.
    // Match capabilities rather than minified names, and keep the walk bounded.
    const FIND_ATTACHMENTS = "(function(root){"
        + " if (!root) return null;"
        + " function isState(v) { return !!v && typeof v === 'object'"
        + "   && typeof v.takeForSend === 'function' && typeof v.waitForImagesReady === 'function'"
        + "   && typeof v.addImageFiles === 'function'"
        + "   && (typeof v.getImages === 'function' || Array.isArray(v.images)); }"
        + " function scan(v, depth, seen) {"
        + "   if (isState(v)) return v;"
        + "   if (!v || depth <= 0 || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return null;"
        + "   seen.add(v); var ds; try { ds = Object.getOwnPropertyDescriptors(v); } catch (_) { return null; }"
        + "   var ks = Reflect.ownKeys(ds);"
        + "   for (var i = 0; i < ks.length && i < 80; i++) { var d = ds[ks[i]];"
        + "     if (!d || !Object.prototype.hasOwnProperty.call(d, 'value')) continue;"
        + "     var hit = scan(d.value, depth - 1, seen); if (hit) return hit; }"
        + "   return null; }"
        + " var key = Object.keys(root).find(function(k){ return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });"
        + " var fiber = key ? root[key] : null;"
        + " for (var depth = 0; fiber && depth < 240; depth++, fiber = fiber.return) {"
        + "   var found = scan(fiber.memoizedProps, 3, new Set()); if (found) return found;"
        + "   for (var hook = fiber.memoizedState, n = 0; hook && n < 400; hook = hook.next, n++) {"
        + "     found = scan(hook.memoizedState, 3, new Set()); if (found) return found; }"
        + " } return null; })(node.closest('.epitaxy-prompt'))";

    function snippet(body, async) {
        return '(' + (async ? 'async ' : '') + '() => { try { var node = ' + FIND_NODE + ';'
            + ' var ed = node && node.editor; if (!ed) return { ok: false, reason: "no-editor" };'
            + body
            + ' } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } })()';
    }

    const GET = snippet(
        ' var text = ed.getText(); var doc = JSON.stringify(ed.getJSON());'
        + ' var state = ' + FIND_ATTACHMENTS + ';'
        + ' var shelf = node.closest(".epitaxy-prompt").querySelector(".epitaxy-attachment-shelf");'
        + ' if (!state) return shelf ? { ok: false, reason: "attachment-state-unavailable" }'
        + '   : { ok: true, text: text, images: [], empty: !text || !text.trim(), focused: !!ed.isFocused };'
        + ' function list(s) { var value = typeof s.getImages === "function" ? s.getImages() : s.images;'
        + '   return Array.isArray(value) ? value : []; }'
        + ' var before = list(state), ids = before.map(function(image){ return image && image.id; });'
        + ' if (before.some(function(image){ return image && image.status === "loading"; })) {'
        + '   await state.waitForImagesReady(); await new Promise(function(resolve){ setTimeout(resolve, 0); });'
        + '   state = ' + FIND_ATTACHMENTS + '; if (!state) return { ok: false, reason: "attachment-state-unavailable" }; }'
        + ' var current = list(state);'
        + ' if (JSON.stringify(ids) !== JSON.stringify(current.map(function(image){ return image && image.id; }))'
        + '     || doc !== JSON.stringify(ed.getJSON()) || text !== ed.getText())'
        + '   return { ok: false, reason: "composer-changed" };'
        + ' var hasAny = typeof state.hasStagedAttachmentsNow === "function" ? state.hasStagedAttachmentsNow() : !!state.hasAttachments;'
        + ' if (hasAny && !current.length) return { ok: false, reason: "unsupported-attachment" };'
        + ' var attached = [];'
        + ' for (var i = 0; i < current.length; i++) { var image = current[i], source = image && image.block && image.block.source;'
        + '   if (!image || image.status !== "ready" || !source || source.type !== "base64"'
        + '       || typeof source.data !== "string" || !source.data || !/^image\\/(?:png|jpeg|gif|webp)$/.test(source.media_type || ""))'
        + '     return { ok: false, reason: "image-not-ready" };'
        + '   attached.push({ base64: source.data, mimeType: source.media_type, filename: image.name || undefined }); }'
        + ' return { ok: true, text: text, images: attached, empty: (!text || !text.trim()) && !attached.length, focused: !!ed.isFocused };',
        true
    );
    const CLEAR = snippet(
        ' var state = ' + FIND_ATTACHMENTS + ';'
        + ' if (state) { var value = typeof state.getImages === "function" ? state.getImages() : state.images;'
        + '   var hasAny = typeof state.hasStagedAttachmentsNow === "function" ? state.hasStagedAttachmentsNow() : !!state.hasAttachments;'
        + '   if (hasAny || Array.isArray(value) && value.length) state.takeForSend(); }'
        + ' ed.commands.clearContent(true); return { ok: true }; '
    );

    function setScript(text, attached) {
        // setContent with a plain string would be parsed as HTML; the text is
        // fed as an explicit paragraph doc so "<" and "&" survive verbatim and
        // blank lines stay blank lines. Images return through the native staging
        // hook, which owns compression, previews, limits, and the attachment shelf.
        return snippet(
            ' var attached = ' + JSON.stringify(attached) + ';'
            + ' var state = attached.length ? ' + FIND_ATTACHMENTS + ' : null;'
            + ' if (attached.length && !state) return { ok: false, reason: "attachment-state-unavailable" };'
            + ' var lines = ' + JSON.stringify(String(text).split('\n')) + ';'
            + ' var doc = { type: "doc", content: lines.map(function (l) {'
            + '   return l.length ? { type: "paragraph", content: [{ type: "text", text: l }] }'
            + '                   : { type: "paragraph" }; }) };'
            + ' ed.commands.setContent(doc, true);'
            + ' if (attached.length) { var files = attached.map(function(image, index){'
            + '   var raw = atob(image.base64), bytes = new Uint8Array(raw.length);'
            + '   for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);'
            + '   var ext = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6);'
            + '   return new File([bytes], image.filename || ("queued-image-" + (index + 1) + "." + ext), { type: image.mimeType }); });'
            + '   var added = state.addImageFiles(files);'
            + '   if (added !== files.length) return { ok: false, reason: "image-restore-failed" }; }'
            + ' ed.commands.focus("end");'
            + ' return { ok: true, images: attached.length };'
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

    async function backgroundForeground(sid) {
        if (!SESSION.test(sid || '')) return { ok: false, reason: 'bad session id' };
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
    }
    ctx.method('backgroundForeground', (p) => backgroundForeground(p && p.sid));

    // -------------------------------------------------------------- auto-send
    /* Turn-end delivery belongs in main, not in the view showing the composer.
     * Renderer timers are throttled when the window is hidden, and a renderer
     * tracks only the session in its URL. The session manager owns every live
     * query regardless of focus, and its isCliProvablyIdle() predicate is the
     * same authority Desktop uses before deciding whether a send is immediate.
     * Polling here is a fallback-safe edge detector: busy clears the deadline;
     * the first idle observation starts the configured grace period. */
    const readyAt = new Map();
    const holds = new Map();

    function held(sid) {
        const h = holds.get(sid);
        if (!h) return false;
        if (h.until > Date.now()) return true;
        holds.delete(sid);
        return false;
    }

    function idleSession(sid) {
        const mgr = sessionManager();
        const sess = mgr?.sessions.get(sid);
        if (!sess?.query || typeof mgr.isCliProvablyIdle !== 'function') return null;
        try { return mgr.isCliProvablyIdle(sess) ? { mgr, sess } : null; }
        catch (_) { return null; }
    }

    /* A steer sent while the model is streaming text is held by the desktop
     * until the stream reaches a boundary, yet sendMessage pushes it into the
     * message buffer and emits it to the renderer at once (app 2.7032.0). The
     * web store decides where an arriving user message goes: into the steered
     * bar ("sends after this response") only while its bucket's
     * pendingQueuedSends is non-zero, otherwise straight into the transcript,
     * which puts it above the text still streaming. The native composer calls
     * the store's noteQueuedSend(sessionId) before every send; a send made
     * from main has to do the same, or the echo lands out of order.
     *
     * The store is module-scoped, not on a context provider, so it is reached
     * as the function a component selected into its hook state. A method
     * shorthand keeps its name through minification. The action no-ops when
     * no turn is pending, and the store resets the count at turn end, so a
     * send that then fails leaks nothing past the turn. */
    const NOTE_QUEUED = (sid) => '(function (sid) {'
        + ' var stack = [], nodes = document.querySelectorAll("body > *");'
        + ' for (var i = 0; i < nodes.length; i++) {'
        + '   var k = Object.keys(nodes[i]).find(function (x) { return x.indexOf("__reactContainer$") === 0; });'
        + '   var r = k && nodes[i][k]; if (r) stack.push(r.stateNode && r.stateNode.current || r); }'
        + ' for (var visited = 0; stack.length && visited < 100000; visited++) {'
        + '   var f = stack.pop(); if (!f) continue;'
        + '   for (var h = f.memoizedState, j = 0; h && typeof h === "object" && j < 200; h = h.next, j++) {'
        + '     if (typeof h.memoizedState === "function" && h.memoizedState.name === "noteQueuedSend") {'
        + '       h.memoizedState(sid); return { ok: true }; } }'
        + '   if (f.sibling) stack.push(f.sibling); if (f.child) stack.push(f.child); }'
        + ' return { ok: false, reason: "noteQueuedSend not found" };'
        + '})(' + JSON.stringify(sid) + ')';

    async function noteQueuedSend(sender, sid) {
        const r = await withTimeout(Promise.resolve().then(() => sender.executeJavaScript(NOTE_QUEUED(sid), false)), 500);
        return r.value || { ok: false, reason: r.error || 'timeout' };
    }

    async function deliver(sid, id, priority, requireIdle, beforeSend) {
        if (shared.sessions.has(sid)) return { ok: false, reason: 'send already in flight' };
        shared.sessions.add(sid);
        try {
            const live = requireIdle ? idleSession(sid) : (() => {
                const mgr = sessionManager();
                const sess = mgr?.sessions.get(sid);
                return mgr && sess?.query ? { mgr, sess } : null;
            })();
            if (!live) return { ok: false, reason: requireIdle ? 'session is not idle' : 'session is unavailable' };
            if (requireIdle && held(sid)) return { ok: false, reason: 'message is being edited' };
            const item = current(sid).find((x) => x && x.id === id);
            if (!item) return { ok: false, reason: 'queue item is gone' };
            const options = { initiator: 'user' };
            if (priority) options.priority = priority;
            const attached = images(item.images);
            if (beforeSend) await beforeSend();
            const result = await live.mgr.sendMessage(sid, item.text, attached.length ? attached : undefined, options);
            if (result?.delivered === false) return { ok: false, reason: result.reason || 'delivery failed' };
            const items = replace(sid, current(sid).filter((x) => !x || x.id !== id), id, true);
            return { ok: true, items, delivery: result || null };
        } catch (e) {
            return { ok: false, reason: String((e && e.message) || e) };
        } finally { shared.sessions.delete(sid); }
    }

    ctx.method('configure', (p) => {
        config = Object.assign({}, DEFAULTS, p || {});
        if (!config.enabled || !config.autoSend) readyAt.clear();
        scan();
        return true;
    });
    ctx.method('hold', (p) => {
        const sid = p && p.sid;
        if (!SESSION.test(sid || '')) return false;
        if (typeof p.id === 'string' && p.id) holds.set(sid, { id: p.id, until: Date.now() + 5000 });
        else holds.delete(sid);
        return true;
    });
    ctx.method('steer', async (p, event) => {
        const sid = p && p.sid;
        const id = p && p.id;
        if (!SESSION.test(sid || '') || typeof id !== 'string') return { ok: false, reason: 'valid session and item id required' };
        let foreground = null;
        let priority = 'next';
        if (p.freeForeground !== false) {
            foreground = await backgroundForeground(sid);
            if (!foreground?.backgrounded) priority = 'now';
        }
        const sender = event && event.sender;
        let echo = null;
        const result = await deliver(sid, id, priority, false,
            sender ? async () => { echo = await noteQueuedSend(sender, sid); } : null);
        return Object.assign(result, { foreground, priority, echo });
    });

    function scan() {
        const queues = read();
        if (!config.enabled || !config.autoSend) { readyAt.clear(); return; }
        const now = Date.now();
        for (const sid of Object.keys(queues)) {
            const items = Array.isArray(queues[sid]) ? queues[sid] : [];
            if (!SESSION.test(sid) || !items.length || held(sid) || !idleSession(sid)) {
                readyAt.delete(sid);
                continue;
            }
            if (!readyAt.has(sid)) readyAt.set(sid, now + Math.max(0, Number(config.autoSendDelay) || 0));
            if (readyAt.get(sid) > now || shared.sessions.has(sid)) continue;
            const id = items[0] && items[0].id;
            if (typeof id !== 'string') { readyAt.delete(sid); continue; }
            deliver(sid, id, null, true).then((result) => {
                readyAt.delete(sid);
                if (!result.ok && result.reason !== 'session is not idle' && result.reason !== 'message is being edited')
                    ctx.log('auto-send failed for ' + sid + ': ' + result.reason);
            });
        }
        for (const sid of [...readyAt.keys()]) if (!Array.isArray(queues[sid]) || !queues[sid].length) readyAt.delete(sid);
    }

    ctx.method('status', () => {
        const mgr = sessionManager();
        return {
            manager: { found: !!mgr, sendMessage: typeof mgr?.sendMessage === 'function',
                idlePredicate: typeof mgr?.isCliProvablyIdle === 'function' },
            queues: Object.fromEntries(Object.entries(read()).filter(([, value]) => Array.isArray(value) && value.length)
                .map(([key, value]) => [key, value.length])),
            ready: [...readyAt.keys()],
            sending: [...shared.sessions],
            held: [...holds.keys()].filter(held),
            config: { enabled: !!config.enabled, autoSend: !!config.autoSend,
                autoSendDelay: Math.max(0, Number(config.autoSendDelay) || 0) },
        };
    });
    ctx.every(200, scan);
    scan();

    const run = (wc, code) => wc.executeJavaScript(code, false);

    ctx.method('editorGet', (p, event) => run(event.sender, GET));
    ctx.method('editorClear', (p, event) => run(event.sender, CLEAR));
    ctx.method('editorSet', (p, event) => run(event.sender, setScript((p && p.text) || '', images(p && p.images))));
};
