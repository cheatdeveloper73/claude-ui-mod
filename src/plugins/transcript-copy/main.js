/* claude-ui-mod :: transcript-copy (main)
 *
 * Turns the session's own CLI transcript into one tagged block of text on the
 * clipboard, so a conversation can be handed to another model with the parts
 * the app's own copy never carries: thinking, tool calls, tool output, and the
 * context that was injected rather than typed.
 *
 * Source is the CLI's jsonl, never the DOM:
 *   ~/.claude/projects/<project-slug>/<cliSessionId>.jsonl          session
 *   ~/.claude/projects/<project-slug>/<cliSessionId>/subagents/     one per agent
 * The rendered page collapses thinking, truncates tool output and never shows
 * the injected turns at all, so scraping it would lose exactly the information
 * this plugin exists to keep.
 *
 * Line shapes, verified against app-1.44121.4 / CLI 2.1.222 transcripts:
 *
 *   type=user       message.content string|array  a turn
 *   type=assistant  message.content array         text | thinking | tool_use
 *   type=attachment attachment.{type,...}         injected reminders, file reads
 *   type=system     subtype=stop_hook_summary     hook bookkeeping
 *   type=mode | last-prompt | custom-title | queue-operation   view bookkeeping
 *
 * The one distinction the file makes and the transcript view does not: a user
 * line the human actually typed carries promptSource/origin. Everything else on
 * role "user" is machinery -- skill bodies, system-reminders, tool results --
 * and would otherwise read as the user's own words in whatever the paste lands
 * in. Those are tagged <system>, and are off by default.
 *
 * DELTA
 *
 * The paste target is a chat window that already holds an earlier export, so
 * re-sending the whole session wastes its context and buries what changed. A
 * delta copy carries only the entries after a previous export ended.
 *
 * Where "ended" comes from is worked out from the transcript on the clipboard,
 * by aligning it against the session. Nothing is written into the export to
 * make this possible -- the export stays text a human would want to read, and
 * an export made before this code existed, or one trimmed by hand, or one
 * reflowed by whatever it was pasted into, aligns exactly as well.
 *
 * The alignment, in align():
 *
 *   Both sides are whitespace-collapsed, so wrapping, indentation and the
 *   tags-versus-markdown choice all stop mattering; what is compared is the
 *   text of the turns themselves. Each record is probed against the clipboard
 *   by a prefix of its body -- a prefix, because a length cap truncates the
 *   tail, so the same turn exported under a tighter cap still starts the same.
 *   Records too short to identify anything (under 40 characters) are neither
 *   evidence for nor against, and are stepped over.
 *
 *   The result is not "the newest record that appears somewhere". A single
 *   coincidental hit -- the same file path, the same one-line reply -- would
 *   put the cut in the wrong place, and a cut placed too late drops turns
 *   silently. So the cut is the end of the longest RUN of consecutive matches,
 *   tolerating up to two misses inside it for a category the earlier export
 *   did not carry (images off, tool results off). Two hits minimum. An isolated
 *   coincidence is one hit surrounded by misses and loses to any real run.
 *
 *   A run is not required to start at the beginning, which is what lets a
 *   delta align against a previous *delta* -- a window from the middle of the
 *   session -- and chain.
 *
 * When the clipboard holds no transcript at all, the fallback is the mark this
 * plugin kept for itself: .state/transcript-delta.json, written after every
 * successful copy, naming the last entry that copy carried. That is a uuid and
 * a content-block index, never an ordinal, because compaction rewrites the file
 * and ordinals move.
 *
 * If neither resolves, the copy says so and leaves the clipboard alone rather
 * than pasting a whole session into a window that expected a few turns.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_RE = /^agent-([0-9a-z]+)\.jsonl$/i;

// Mirrors the dashboard spec's defaults. Kept here as well because copy() has
// to produce something sane when it is called before the dashboard has loaded.
const DEFAULTS = {
    format: 'tags',
    legend: true,
    timestamps: true,
    models: true,
    thinking: true,
    toolCalls: true,
    toolResults: true,
    system: false,
    attachments: false,
    subagents: false,
    images: 'placeholder',
    toolInputMax: 2000,
    toolResultMax: 4000,
    textMax: 0,
    tailEntries: 0,

    deltaAnchor: 'auto',
    deltaFallback: 'none',
};

const SKIP_TYPES = { mode: 1, 'last-prompt': 1, 'custom-title': 1, 'queue-operation': 1, summary: 1 };

const SAMPLE = [
    { type: 'user', promptSource: 'sdk', timestamp: '2026-09-03T10:14:02.113Z',
      message: { role: 'user', content: 'Why does the client read one field short after the fourth?' } },
    { type: 'assistant', timestamp: '2026-09-03T10:14:05.902Z', effort: 'high',
      message: { role: 'assistant', model: 'claude-opus-5', content: [
          { type: 'thinking', thinking: 'The fourth field is where the two structs stop agreeing. Read the header before guessing at tick math.' }] } },
    { type: 'assistant', timestamp: '2026-09-03T10:14:06.410Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'net/player_state.h', limit: 40 } }] } },
    { type: 'user', timestamp: '2026-09-03T10:14:06.688Z',
      message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: 'u16 tick;\nu16 flags;\nu32 seq;\nu16 health;' }] } },
    { type: 'user', timestamp: '2026-09-03T10:14:07.000Z',
      message: { role: 'user', content: [
          { type: 'text', text: 'Injected context lands on the user role but was never typed.' }] } },
    { type: 'assistant', timestamp: '2026-09-03T10:14:11.220Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [
          { type: 'text', text: 'The client reads a u16 where the server writes a u32, so every packet after the fourth field lands one short.' }] } },
    { type: 'user', promptSource: 'sdk', timestamp: '2026-09-03T10:15:40.006Z',
      message: { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(8) } },
          { type: 'text', text: 'Here is the packet dump.' }] } },
].map(function (o) { return JSON.stringify(o); }).join('\n');

module.exports = function (ctx) {
    // ---------------------------------------------------------------- project
    // The slug is a mangling of the cwd, so rather than reproduce it, look for
    // the directory the session lives in. Same approach as subagents/main.js.
    const projCache = new Map();
    function projectDirFor(cliSid) {
        const hit = projCache.get(cliSid);
        if (hit && Date.now() - hit.at < 60000) return hit.dir;
        let dirs = [];
        try { dirs = fs.readdirSync(PROJECTS); } catch (_) { return null; }
        let found = null;
        for (const d of dirs) {
            const base = path.join(PROJECTS, d);
            if (fs.existsSync(path.join(base, cliSid + '.jsonl'))) { found = base; break; }
            if (fs.existsSync(path.join(base, cliSid))) found = base;
        }
        projCache.set(cliSid, { dir: found, at: Date.now() });
        return found;
    }
    ctx.onDispose(() => projCache.clear());

    // ---------------------------------------------------------------- options
    function normalize(raw) {
        const o = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
        if (o.format !== 'markdown') o.format = 'tags';
        if (['omit', 'placeholder', 'dataurl'].indexOf(o.images) === -1) o.images = 'placeholder';
        if (['auto', 'clipboard', 'mark'].indexOf(o.deltaAnchor) === -1) o.deltaAnchor = 'auto';
        if (['none', 'full'].indexOf(o.deltaFallback) === -1) o.deltaFallback = 'none';
        for (const k of ['toolInputMax', 'toolResultMax', 'textMax', 'tailEntries']) {
            const n = Number(o[k]);
            o[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        }
        return o;
    }

    // ---------------------------------------------------------------- text bits
    const num = (n) => Number(n).toLocaleString('en-US');

    // Windows takes a clipboard string as NUL-terminated UTF-16, so one U+0000
    // anywhere in the text silently drops everything after it -- the paste ends
    // mid-word and nothing reports a failure. A tool result carrying raw bytes
    // is enough to trigger it: `grep` over the CLI bundle put 1,671 NULs into
    // one result, the first at character 14,222 of a 201,977-character export,
    // and the paste arrived 7% long. The other C0 controls survive the
    // clipboard but are noise in a text export, so they go the same way.
    const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

    function clip(s, max) {
        const t = (typeof s === 'string' ? s : String(s == null ? '' : s)).replace(CTRL, '\uFFFD');
        if (!max || t.length <= max) return t;
        return t.slice(0, max) + '\n... [+' + num(t.length - max) + ' chars truncated]';
    }
    function jsonish(v) {
        try { return JSON.stringify(v === undefined ? null : v, null, 2); }
        catch (_) { return String(v); }
    }

    function imageBits(src) {
        const s = src && typeof src === 'object' ? src : {};
        const data = typeof s.data === 'string' ? s.data : '';
        return {
            media: s.media_type || (s.type === 'url' ? 'url' : 'unknown'),
            // base64 carries 3 bytes per 4 characters; padding is inside the rounding.
            bytes: data ? Math.round(data.length * 0.75) : null,
            url: typeof s.url === 'string' ? s.url : null,
            data,
        };
    }
    function imageText(src, o) {
        const b = imageBits(src);
        if (o.images === 'omit') return '';
        if (o.images === 'dataurl' && b.data) return 'data:' + b.media + ';base64,' + b.data;
        if (b.url) return b.url;
        return '';
    }

    // tool_result content is a string, or an array mixing text and image blocks.
    function flat(v, o, counts) {
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) {
            const out = [];
            for (const c of v) {
                if (!c || typeof c !== 'object') { out.push(String(c == null ? '' : c)); continue; }
                if (c.type === 'text') { out.push(c.text || ''); continue; }
                if (c.type === 'image') {
                    counts.image++;
                    if (o.images === 'omit') continue;
                    const b = imageBits(c.source);
                    const body = imageText(c.source, o);
                    out.push('[image ' + b.media + (b.bytes ? ' ' + num(b.bytes) + ' bytes' : '') + ']' + (body ? '\n' + body : ''));
                    continue;
                }
                out.push(jsonish(c));
            }
            return out.join('\n');
        }
        if (v && typeof v === 'object') return jsonish(v);
        return String(v == null ? '' : v);
    }

    // ---------------------------------------------------------------- render
    function attrs(pairs) {
        let s = '';
        for (let i = 0; i < pairs.length; i += 2) {
            const v = pairs[i + 1];
            if (v === null || v === undefined || v === '' || v === false) continue;
            // A quote inside an attribute would end it. Values here are ids,
            // model names and paths, so bending one is cheaper than an escape
            // scheme the reader on the other end has to know about.
            s += ' ' + pairs[i] + '="' + String(v).replace(/"/g, "'") + '"';
        }
        return s;
    }
    const stamp = (r, o) => (o.timestamps && r.at ? String(r.at).replace(/\.\d+Z$/, 'Z') : null);
    const modelOf = (r, o) => (o.models ? r.model || null : null);
    const fence = (body) => '```\n' + body + '\n```';

    function render(r, o) {
        const t = stamp(r, o);
        const md = o.format === 'markdown';

        if (r.kind === 'interrupt') return md ? '**[request interrupted]**' : '<interrupt' + attrs(['t', t]) + '/>';

        if (r.kind === 'image') {
            const size = r.bytes ? num(r.bytes) + ' bytes' : '';
            if (md) return '### IMAGE ' + r.media + (size ? ' - ' + size : '') + (r.body ? '\n' + fence(r.body) : '');
            return r.body
                ? '<image' + attrs(['media', r.media, 'bytes', r.bytes, 't', t]) + '>\n' + r.body + '\n</image>'
                : '<image' + attrs(['media', r.media, 'bytes', r.bytes, 'src', r.url, 't', t]) + '/>';
        }

        if (md) {
            let head;
            if (r.kind === 'user') head = '## USER' + (t ? ' - ' + t : '');
            else if (r.kind === 'assistant') head = '## ASSISTANT' + (modelOf(r, o) ? ' - ' + r.model : '') + (o.models && r.effort ? ' - ' + r.effort : '');
            else if (r.kind === 'thinking') head = '## THINKING' + (modelOf(r, o) ? ' - ' + r.model : '');
            else if (r.kind === 'tool') head = '### TOOL ' + (r.name || '?');
            else if (r.kind === 'result') head = '### RESULT ' + (r.name || '?') + (r.error ? ' - error' : '');
            else if (r.kind === 'system') head = '## SYSTEM' + (r.source ? ' - ' + r.source : '');
            else head = '### ATTACHMENT ' + (r.source || '?');
            if (r.agent) head += ' - sidechain';
            const boxed = r.kind === 'tool' || r.kind === 'result' || r.kind === 'attachment';
            return head + '\n' + (boxed ? fence(r.body) : r.body);
        }

        let tag, a;
        if (r.kind === 'user') { tag = 'user'; a = ['t', t, 'agent', r.agent]; }
        else if (r.kind === 'assistant') { tag = 'assistant'; a = ['model', modelOf(r, o), 'effort', o.models ? r.effort : null, 't', t, 'agent', r.agent]; }
        else if (r.kind === 'thinking') { tag = 'thinking'; a = ['model', modelOf(r, o), 't', t, 'agent', r.agent]; }
        else if (r.kind === 'tool') { tag = 'tool'; a = ['name', r.name, 'id', r.id, 't', t, 'agent', r.agent]; }
        else if (r.kind === 'result') { tag = 'tool_result'; a = ['name', r.name, 'id', r.id, 'error', r.error ? 'true' : null, 't', t]; }
        else if (r.kind === 'system') { tag = 'system'; a = ['source', r.source, 't', t]; }
        else { tag = 'attachment'; a = ['kind', r.source, 't', t]; }
        return '<' + tag + attrs(a) + '>\n' + r.body + '\n</' + tag + '>';
    }

    // ---------------------------------------------------------------- collect
    function collectText(text, o) {
        const recs = [];
        const counts = { user: 0, assistant: 0, thinking: 0, tool: 0, result: 0, image: 0, system: 0, attachment: 0 };
        const toolNames = new Map();
        const lineOf = new Map();       // line uuid -> ordinal, for anchor lookup
        let meta = null, lines = 0;

        // Every record remembers where it came from: the uuid of the jsonl line
        // and the index of the content block inside it. That pair is the delta
        // anchor, and it survives options changing between two copies -- a
        // record's ordinal in the export does not.
        let cur = { u: null, li: 0 };

        // interrupt markers are the user's doing, so they count as user turns
        // rather than as a category of their own.
        const push = (r, b) => {
            r.u = cur.u; r.li = cur.li; r.b = b === undefined ? -1 : b;
            recs.push(r);
            counts[r.kind === 'interrupt' ? 'user' : r.kind]++;
        };

        for (const line of String(text).split('\n')) {
            if (!line.trim()) continue;
            let d;
            try { d = JSON.parse(line); } catch (_) { continue; }
            lines++;
            if (!meta && d.cwd) meta = { cwd: d.cwd, branch: d.gitBranch || null, version: d.version || null };
            cur = { u: typeof d.uuid === 'string' ? d.uuid : null, li: lines };
            if (cur.u && !lineOf.has(cur.u)) lineOf.set(cur.u, lines);
            if (SKIP_TYPES[d.type]) continue;

            const at = d.timestamp || null;

            if (d.type === 'attachment') {
                if (!o.attachments) continue;
                const a = d.attachment || {};
                push({ kind: 'attachment', source: a.type || null, body: clip(jsonish(a), o.toolResultMax), at });
                continue;
            }
            if (d.type === 'system') {
                if (!o.system) continue;
                push({ kind: 'system', source: d.subtype || 'system', body: clip(jsonish(d), o.toolResultMax), at });
                continue;
            }

            const m = d.message;
            if (!m) continue;
            const agent = d.isSidechain === true ? 'sidechain' : null;
            const content = typeof m.content === 'string'
                ? [{ type: 'text', text: m.content }]
                : (Array.isArray(m.content) ? m.content : []);
            const typed = d.promptSource !== undefined || d.origin !== undefined;

            for (let bi = 0; bi < content.length; bi++) {
                const c = content[bi];
                if (!c || typeof c !== 'object') continue;

                if (c.type === 'text') {
                    const txt = c.text || '';
                    if (d.type === 'assistant') {
                        push({ kind: 'assistant', body: clip(txt, o.textMax), model: m.model || null, effort: d.effort || null, at, agent }, bi);
                    } else if (/^\s*\[Request interrupted/.test(txt)) {
                        push({ kind: 'interrupt', at }, bi);
                    } else if (typed) {
                        push({ kind: 'user', body: clip(txt, o.textMax), at, agent }, bi);
                    } else if (o.system) {
                        push({ kind: 'system', source: 'injected', body: clip(txt, o.toolResultMax), at }, bi);
                    }
                } else if (c.type === 'thinking') {
                    if (o.thinking) push({ kind: 'thinking', body: clip(c.thinking || '', o.textMax), model: m.model || null, at, agent }, bi);
                } else if (c.type === 'tool_use') {
                    if (c.id) toolNames.set(c.id, c.name || null);
                    if (o.toolCalls) push({ kind: 'tool', name: c.name || null, id: c.id || null, body: clip(jsonish(c.input), o.toolInputMax), at, agent }, bi);
                } else if (c.type === 'tool_result') {
                    if (!o.toolResults) continue;
                    push({ kind: 'result', name: toolNames.get(c.tool_use_id) || null, id: c.tool_use_id || null,
                        error: !!c.is_error, body: clip(flat(c.content, o, counts), o.toolResultMax), at }, bi);
                } else if (c.type === 'image') {
                    counts.image++;
                    if (o.images === 'omit') continue;
                    const b = imageBits(c.source);
                    // counted above; push() would count it a second time.
                    const rec = { kind: 'image', media: b.media, bytes: b.bytes, url: b.url, body: imageText(c.source, o), at };
                    rec.u = cur.u; rec.li = cur.li; rec.b = bi;
                    recs.push(rec);
                }
            }
        }
        return { recs, counts, meta, lines, lineOf };
    }

    function collectFile(file, o) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
        return collectText(text, o);
    }

    // ---------------------------------------------------------------- assemble
    function legendText(o, delta) {
        const md = o.format === 'markdown';
        const l = [
            delta ? 'Continuation of a Claude Code transcript already sent: only the entries recorded'
                  : 'Exported Claude Code transcript. Roles are delimited, not escaped: a',
            delta ? 'after that export ends are below. Roles are delimited, not escaped: a delimiter is'
                  : 'delimiter is always alone on its line and the content between is verbatim.',
            delta ? 'always alone on its line and the content between is verbatim.' : null,
            md ? 'USER typed input, ASSISTANT reply, THINKING internal reasoning, TOOL/RESULT calls and output.'
               : '<user> typed input, <assistant> reply, <thinking> internal reasoning, <tool>/<tool_result> calls and output.',
        ].filter(Boolean);
        if (o.system) {
            l.push(md ? 'SYSTEM is context the harness injected into the user role, not typed by the user.'
                      : '<system> is context the harness injected into the user role, not typed by the user.');
        }
        return l.map((s) => (md ? '> ' : '# ') + s).join('\n');
    }

    function headOpen(head, o) {
        if (o.format === 'markdown') {
            const bits = ['# Transcript ' + head.session + (head.part === 'delta' ? ' (continuation)' : '')];
            if (head.cwd) bits.push('- cwd: ' + head.cwd);
            if (head.branch) bits.push('- branch: ' + head.branch);
            bits.push('- entries: ' + num(head.entries));
            bits.push('- exported: ' + head.exported);
            if (head.part === 'delta') bits.push('- continues: the export that ended at ' + (head.from || 'an earlier point'));
            return bits.join('\n');
        }
        return '<transcript' + attrs(['session', head.session, 'cwd', head.cwd, 'branch', head.branch,
            'entries', head.entries, 'exported', head.exported, 'part', head.part,
            'continues', head.from]) + '>';
    }

    function assemble(recs, o, head) {
        const parts = [];
        if (o.legend) parts.push(legendText(o, !!(head && head.part === 'delta')));
        if (head) parts.push(headOpen(head, o));
        for (const r of recs) parts.push(render(r, o));
        if (head && o.format !== 'markdown') parts.push('</transcript>');
        return parts.join('\n\n') + '\n';
    }

    const tail = (recs, o) => (o.tailEntries > 0 && recs.length > o.tailEntries ? recs.slice(-o.tailEntries) : recs);

    // ---------------------------------------------------------------- subagents
    function subagentBlocks(proj, cliSid, o) {
        const dir = path.join(proj, cliSid, 'subagents');
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { return { text: '', agents: 0 }; }
        const files = [];
        for (const n of names) {
            const m = AGENT_RE.exec(n);
            if (!m) continue;
            const file = path.join(dir, n);
            let st = null;
            try { st = fs.statSync(file); } catch (_) { continue; }
            if (!st.size) continue;
            files.push({ id: m[1], file, mtime: st.mtimeMs });
        }
        // Oldest first, so the agents read in the order they were spawned.
        files.sort((a, b) => a.mtime - b.mtime);

        const out = [];
        for (const f of files) {
            const got = collectFile(f.file, o);
            if (!got || !got.recs.length) continue;
            // The name its spawner chose lives only in the sidecar; the agent's
            // own file never carries it.
            let meta = null;
            try { meta = JSON.parse(fs.readFileSync(f.file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch (_) {}
            const name = (meta && (meta.name || meta.agentType)) || null;
            const body = got.recs.map((r) => render(r, o)).join('\n\n');
            out.push(o.format === 'markdown'
                ? '# SUBAGENT ' + f.id + (name ? ' - ' + name : '') + '\n\n' + body
                : '<subagent' + attrs(['id', f.id, 'name', name]) + '>\n\n' + body + '\n\n</subagent>');
        }
        return { text: out.join('\n\n'), agents: out.length };
    }

    // ---------------------------------------------------------------- marks
    const MARKS = path.join(ctx.dir, '..', '..', '..', '.state', 'transcript-delta.json');
    const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

    // The last record an export actually carried. Records off the tail of the
    // slice can lack a uuid only if the jsonl line did, so walk back to one that
    // has it rather than giving up on the whole export.
    function anchorOf(recs) {
        for (let i = recs.length - 1; i >= 0; i--) if (recs[i].u) return recs[i].u + '.' + recs[i].b;
        return null;
    }
    function parseAnchor(s) {
        const m = new RegExp('^(' + UUID_TEXT + ')\\.(-?\\d+)$', 'i').exec(String(s == null ? '' : s).trim());
        return m ? { uuid: m[1].toLowerCase(), b: Number(m[2]) } : null;
    }

    // Disk marks. Re-stat before every read: a second window copying the same
    // session writes this file, and caching the first read forever would make
    // one window's idea of "already sent" outlive the other's.
    let marks = null, marksStamp = '';
    function readMarks() {
        let st = null;
        try { st = fs.statSync(MARKS); } catch (_) {}
        const now = st ? st.mtimeMs + ':' + st.size : '';
        if (marks && now === marksStamp) return marks;
        marksStamp = now;
        try { marks = JSON.parse(fs.readFileSync(MARKS, 'utf8')); } catch (_) { marks = {}; }
        if (!marks || typeof marks !== 'object') marks = {};
        return marks;
    }
    // Written straight through rather than debounced: a copy is a rare, explicit
    // act, and a mark lost to a host reload costs a duplicate paste.
    function writeMark(cliSid, anchor) {
        const all = readMarks();
        all[cliSid] = { anchor, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
        const tmp = MARKS + '.tmp';
        try {
            fs.mkdirSync(path.dirname(MARKS), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
            fs.renameSync(tmp, MARKS);
            try { const st = fs.statSync(MARKS); marksStamp = st.mtimeMs + ':' + st.size; } catch (_) { marksStamp = ''; }
        } catch (e) { ctx.log('delta mark save failed: ' + ((e && e.message) || e)); }
    }
    ctx.onDispose(() => { marks = null; marksStamp = ''; });

    // ---------------------------------------------------------------- align
    // Collapsing whitespace is what makes the comparison survive the trip: the
    // same turn is wrapped differently under markdown than under tags, code in
    // a tool result carries indentation the far side may re-indent, and a paste
    // that came back out of another chat window has been reflowed outright.
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

    // Below this a body identifies nothing -- "Done.", a bare file path, "ok" --
    // and matching on it would put the cut in the wrong place.
    const MIN_PROBE = 40;
    // Longest first: a long probe is near-impossible to hit by coincidence, and
    // the shorter retries exist only for a body the earlier export truncated.
    const PROBES = [200, 96, MIN_PROBE];
    // Misses tolerated inside one chain, for a category the earlier export did
    // not carry appearing between turns that it did.
    const GAP = 4;
    // A chain may end on a hit only if that hit was strong enough to be worth
    // believing on its own. Strong means the probe covered the whole body, or it
    // was long in absolute terms; weak means a short prefix of a body that has
    // much more to it, which is the coincidence-prone case -- measured on a real
    // session, a chain reached the true boundary at 98.9% of the clipboard and
    // then over-ran it by three entries on one 40-character prefix match.
    // Interior weak hits are fine: the strong ones after them vouch for them.
    const TRUST = 96;
    const strong = (hit) => hit.len >= TRUST || hit.len === hit.body;
    // Guard against pathological input only. Attempts partition the record list
    // -- each restarts past where the last one broke -- so the real bound is the
    // number of records, and the total work stays linear.
    const ATTEMPTS = 64;

    // Match in order, not by containment. That distinction is the whole thing:
    // a transcript repeats itself constantly -- the same file read twice, the
    // same system reminder, the same test output -- and a record from after the
    // cut will happily be "found" in text that only ever contained its earlier
    // twin. Measured against a real 1,031-line session, containment alone put
    // the cut up to eleven entries too late, which is entries silently dropped.
    //
    // So each record must match at or after where the previous one matched. A
    // coincidental twin sits earlier in the clipboard than the cursor has
    // already reached, so it is not a match, and the run ends where the real
    // overlap ends.
    function align(recs, clipText) {
        const hay = norm(clipText);
        if (hay.length < MIN_PROBE) return null;

        const probe = new Array(recs.length).fill(null);
        let testable = 0;
        for (let i = 0; i < recs.length; i++) {
            const r = recs[i];
            if (!r.u) continue;
            const body = norm(r.body);
            if (body.length < MIN_PROBE) continue;
            probe[i] = body;
            testable++;
        }
        if (!testable) return null;

        function seek(body, cursor) {
            let tried = 0;
            for (const n of PROBES) {
                const len = Math.min(n, body.length);
                if (len === tried) continue;          // body shorter than both caps
                tried = len;
                const at = hay.indexOf(body.slice(0, len), cursor);
                if (at !== -1) return { at, len };
            }
            return null;
        }

        let best = { hits: 0, end: -1 };
        let start = 0;
        for (let attempt = 0; attempt < ATTEMPTS && start < recs.length; attempt++) {
            let cursor = 0, gap = 0, broke = -1;
            let chain = [];                           // {i, len} of every hit so far
            for (let i = start; i < recs.length; i++) {
                if (probe[i] === null) continue;      // steps over, neither way
                const hit = seek(probe[i], cursor);
                if (hit) {
                    chain.push({ i, len: hit.len, body: probe[i].length });
                    gap = 0; cursor = hit.at + hit.len;
                    continue;
                }
                // A chain has to prove itself with two consecutive hits before
                // it earns any gap tolerance. Until then a miss just means the
                // hunt continues -- the clipboard may hold a window from the
                // middle of the session, so leading misses are expected, and a
                // lone coincidence must not inherit the real chain behind it.
                if (chain.length < 2) { chain = []; cursor = 0; continue; }
                if (++gap > GAP) { broke = i; break; }
            }
            // Trim a tail the chain cannot vouch for. An interior weak hit keeps
            // its place; a weak hit at the very end is where an over-run starts.
            while (chain.length && !strong(chain[chain.length - 1])) chain.pop();
            if (chain.length > best.hits) best = { hits: chain.length, end: chain[chain.length - 1].i };
            if (broke === -1) break;
            start = broke + 1;
        }

        // One hit is only ever enough when the session has nothing else to
        // corroborate it with.
        if (best.end === -1) return null;
        if (best.hits < 2 && testable > 1) return null;

        // An interrupt marker carries no text, so nothing can ever match it and
        // it lands in every delta after the one that first sent it. Step the cut
        // over trailing ones. Only interrupts: any other record with a body too
        // short to identify might still be a real new turn, and re-sending a
        // duplicate is cheaper than dropping one.
        let end = best.end;
        while (end + 1 < recs.length && recs[end + 1].kind === 'interrupt' && recs[end + 1].u) end++;

        const r = recs[end];
        return { anchor: { uuid: r.u, b: r.b }, matched: best.hits, testable };
    }

    function cutAfter(recs, lineOf, anchor) {
        if (!anchor || !anchor.uuid) return null;
        let idx = -1;
        for (let i = 0; i < recs.length; i++) {
            if (recs[i].u === anchor.uuid && recs[i].b <= anchor.b) idx = i;
        }
        if (idx !== -1) return recs.slice(idx + 1);
        // The anchored block is not in the export any more -- a toggle moved
        // between the two copies. The line it came from is still identity
        // enough, so resume from the line after it.
        const li = lineOf.get(anchor.uuid);
        if (li === undefined) return null;
        let j = 0;
        while (j < recs.length && recs[j].li <= li) j++;
        return recs.slice(j);
    }

    // The timestamp of the entry the previous export ended on. It goes in the
    // delta's header for the reader on the far side; nothing reads it back.
    function stampAt(recs, anchor) {
        for (let i = recs.length - 1; i >= 0; i--) {
            if (recs[i].u === anchor.uuid && recs[i].at) return String(recs[i].at).replace(/\.\d+Z$/, 'Z');
        }
        return null;
    }

    function resolveDelta(cliSid, got, o) {
        const order = o.deltaAnchor === 'mark' ? ['mark']
            : o.deltaAnchor === 'clipboard' ? ['clipboard'] : ['clipboard', 'mark'];

        for (const src of order) {
            if (src === 'clipboard') {
                let text = '';
                try { text = ctx.electron.clipboard.readText() || ''; } catch (_) { text = ''; }
                if (!text) continue;
                const hit = align(got.recs, text);
                if (!hit) continue;
                const cut = cutAfter(got.recs, got.lineOf, hit.anchor);
                if (!cut) continue;
                return { ok: true, recs: cut, how: 'clipboard', matched: hit.matched,
                    from: stampAt(got.recs, hit.anchor), sinceAt: null };
            }
            const mk = readMarks()[cliSid];
            const a = mk && parseAnchor(mk.anchor);
            if (!a) continue;
            const cut = cutAfter(got.recs, got.lineOf, a);
            // A mark that names a line this transcript no longer has is not an
            // error to report -- it just is not usable here.
            if (!cut) continue;
            return { ok: true, recs: cut, how: 'mark', matched: 0,
                from: stampAt(got.recs, a), sinceAt: mk.at || null };
        }

        if (o.deltaFallback === 'full') return { ok: true, recs: null, how: 'full', from: null, sinceAt: null };
        return { ok: false, reason: o.deltaAnchor === 'mark'
            ? 'nothing copied from this session yet — copy the full transcript once first'
            : o.deltaAnchor === 'clipboard'
                ? 'the clipboard does not hold enough of this session to line up against'
                : 'no transcript on the clipboard, and nothing copied from this session yet' };
    }

    function tally(recs) {
        const c = { user: 0, assistant: 0, thinking: 0, tool: 0, result: 0, image: 0, system: 0, attachment: 0 };
        for (const r of recs) c[r.kind === 'interrupt' ? 'user' : r.kind]++;
        return c;
    }

    // ---------------------------------------------------------------- methods
    function build(cliSid, o, delta) {
        const proj = projectDirFor(cliSid);
        if (!proj) return { ok: false, reason: 'no transcript directory for this session yet' };
        const file = path.join(proj, cliSid + '.jsonl');
        const got = collectFile(file, o);
        if (!got) return { ok: false, reason: 'transcript unreadable' };

        let all = got.recs, how = null, from = null, sinceAt = null, matched = 0;
        if (delta) {
            const res = resolveDelta(cliSid, got, o);
            if (!res.ok) return res;
            how = res.how; from = res.from; sinceAt = res.sinceAt; matched = res.matched || 0;
            if (res.recs) all = res.recs;
            if (!all.length) return { ok: false, empty: true, how, sinceAt, matched, reason: 'nothing new since the last copy' };
        }

        const recs = tail(all, o);
        const head = {
            session: cliSid,
            cwd: got.meta && got.meta.cwd,
            branch: got.meta && got.meta.branch,
            entries: recs.length,
            exported: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            part: delta && how !== 'full' ? 'delta' : null,
            from: delta && how !== 'full' ? from : null,
            anchor: anchorOf(recs),
        };
        let text = assemble(recs, o, head);
        let agents = 0;
        // Subagent transcripts have no anchor of their own, so a delta would
        // re-send every one of them. They belong to the full export only.
        if (o.subagents && !delta) {
            const sub = subagentBlocks(proj, cliSid, o);
            agents = sub.agents;
            if (sub.text) text += '\n' + sub.text + '\n';
        }
        return { ok: true, text, file, lines: got.lines, entries: recs.length,
            dropped: all.length - recs.length, counts: delta ? tally(recs) : got.counts,
            agents, anchor: head.anchor, how, sinceAt, matched };
    }

    function doCopy(p, delta) {
        const sid = p && p.cliSid;
        if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return { ok: false, reason: 'no session on screen' };
        const o = normalize(p && p.options);
        const r = build(sid, o, delta);
        if (!r.ok) return r;
        // Through electron.clipboard, not navigator.clipboard: the isolated
        // world never gets prompted for the write permission and silently
        // rejects. Same reason dashboard.clipWrite exists.
        try { ctx.electron.clipboard.writeText(r.text); }
        catch (e) { return { ok: false, reason: 'clipboard write failed: ' + (e && e.message) }; }
        if (r.anchor) writeMark(sid, r.anchor);
        return { ok: true, delta: !!delta, how: r.how, sinceAt: r.sinceAt, matched: r.matched,
            chars: r.text.length, bytes: Buffer.byteLength(r.text), entries: r.entries,
            dropped: r.dropped, lines: r.lines, counts: r.counts, agents: r.agents, file: r.file };
    }

    ctx.method('copy', (p) => doCopy(p, false));
    ctx.method('copyDelta', (p) => doCopy(p, true));

    // What a delta would carry right now, without touching the clipboard: the
    // second pill uses it to show a count and to stay out of the way when the
    // session has nothing new.
    ctx.method('deltaPeek', (p) => {
        const sid = p && p.cliSid;
        if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return { ok: false, reason: 'no session on screen' };
        const o = normalize(p && p.options);
        const r = build(sid, o, true);
        return r.ok ? { ok: true, entries: r.entries, how: r.how, sinceAt: r.sinceAt,
                        matched: r.matched, bytes: Buffer.byteLength(r.text) }
                    : { ok: false, empty: !!r.empty, how: r.how || null, reason: r.reason };
    });

    // Same formatter, a fixed seven-line transcript: what the dashboard shows,
    // so a toggle can be judged against real output rather than a description.
    ctx.method('sample', (p) => {
        const o = normalize(p && p.options);
        const got = collectText(SAMPLE, o);
        return { text: assemble(tail(got.recs, o), o, null) };
    });
};
