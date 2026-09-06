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
        let meta = null, lines = 0;

        // interrupt markers are the user's doing, so they count as user turns
        // rather than as a category of their own.
        const push = (r) => { recs.push(r); counts[r.kind === 'interrupt' ? 'user' : r.kind]++; };

        for (const line of String(text).split('\n')) {
            if (!line.trim()) continue;
            let d;
            try { d = JSON.parse(line); } catch (_) { continue; }
            lines++;
            if (!meta && d.cwd) meta = { cwd: d.cwd, branch: d.gitBranch || null, version: d.version || null };
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

            for (const c of content) {
                if (!c || typeof c !== 'object') continue;

                if (c.type === 'text') {
                    const txt = c.text || '';
                    if (d.type === 'assistant') {
                        push({ kind: 'assistant', body: clip(txt, o.textMax), model: m.model || null, effort: d.effort || null, at, agent });
                    } else if (/^\s*\[Request interrupted/.test(txt)) {
                        push({ kind: 'interrupt', at });
                    } else if (typed) {
                        push({ kind: 'user', body: clip(txt, o.textMax), at, agent });
                    } else if (o.system) {
                        push({ kind: 'system', source: 'injected', body: clip(txt, o.toolResultMax), at });
                    }
                } else if (c.type === 'thinking') {
                    if (o.thinking) push({ kind: 'thinking', body: clip(c.thinking || '', o.textMax), model: m.model || null, at, agent });
                } else if (c.type === 'tool_use') {
                    if (c.id) toolNames.set(c.id, c.name || null);
                    if (o.toolCalls) push({ kind: 'tool', name: c.name || null, id: c.id || null, body: clip(jsonish(c.input), o.toolInputMax), at, agent });
                } else if (c.type === 'tool_result') {
                    if (!o.toolResults) continue;
                    push({ kind: 'result', name: toolNames.get(c.tool_use_id) || null, id: c.tool_use_id || null,
                        error: !!c.is_error, body: clip(flat(c.content, o, counts), o.toolResultMax), at });
                } else if (c.type === 'image') {
                    counts.image++;
                    if (o.images === 'omit') continue;
                    const b = imageBits(c.source);
                    recs.push({ kind: 'image', media: b.media, bytes: b.bytes, url: b.url, body: imageText(c.source, o), at });
                }
            }
        }
        return { recs, counts, meta, lines };
    }

    function collectFile(file, o) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
        return collectText(text, o);
    }

    // ---------------------------------------------------------------- assemble
    function legendText(o) {
        const md = o.format === 'markdown';
        const l = [
            'Exported Claude Code transcript. Roles are delimited, not escaped: a',
            'delimiter is always alone on its line and the content between is verbatim.',
            md ? 'USER typed input, ASSISTANT reply, THINKING internal reasoning, TOOL/RESULT calls and output.'
               : '<user> typed input, <assistant> reply, <thinking> internal reasoning, <tool>/<tool_result> calls and output.',
        ];
        if (o.system) {
            l.push(md ? 'SYSTEM is context the harness injected into the user role, not typed by the user.'
                      : '<system> is context the harness injected into the user role, not typed by the user.');
        }
        return l.map((s) => (md ? '> ' : '# ') + s).join('\n');
    }

    function headOpen(head, o) {
        if (o.format === 'markdown') {
            const bits = ['# Transcript ' + head.session];
            if (head.cwd) bits.push('- cwd: ' + head.cwd);
            if (head.branch) bits.push('- branch: ' + head.branch);
            bits.push('- entries: ' + num(head.entries));
            bits.push('- exported: ' + head.exported);
            return bits.join('\n');
        }
        return '<transcript' + attrs(['session', head.session, 'cwd', head.cwd, 'branch', head.branch,
            'entries', head.entries, 'exported', head.exported]) + '>';
    }

    function assemble(recs, o, head) {
        const parts = [];
        if (o.legend) parts.push(legendText(o));
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

    // ---------------------------------------------------------------- methods
    function build(cliSid, o) {
        const proj = projectDirFor(cliSid);
        if (!proj) return { ok: false, reason: 'no transcript directory for this session yet' };
        const file = path.join(proj, cliSid + '.jsonl');
        const got = collectFile(file, o);
        if (!got) return { ok: false, reason: 'transcript unreadable' };
        const recs = tail(got.recs, o);
        const head = {
            session: cliSid,
            cwd: got.meta && got.meta.cwd,
            branch: got.meta && got.meta.branch,
            entries: recs.length,
            exported: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        };
        let text = assemble(recs, o, head);
        let agents = 0;
        if (o.subagents) {
            const sub = subagentBlocks(proj, cliSid, o);
            agents = sub.agents;
            if (sub.text) text += '\n' + sub.text + '\n';
        }
        return { ok: true, text, file, lines: got.lines, entries: recs.length,
            dropped: got.recs.length - recs.length, counts: got.counts, agents };
    }

    ctx.method('copy', (p) => {
        const sid = p && p.cliSid;
        if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return { ok: false, reason: 'no session on screen' };
        const o = normalize(p && p.options);
        const r = build(sid, o);
        if (!r.ok) return r;
        // Through electron.clipboard, not navigator.clipboard: the isolated
        // world never gets prompted for the write permission and silently
        // rejects. Same reason dashboard.clipWrite exists.
        try { ctx.electron.clipboard.writeText(r.text); }
        catch (e) { return { ok: false, reason: 'clipboard write failed: ' + (e && e.message) }; }
        return { ok: true, chars: r.text.length, bytes: Buffer.byteLength(r.text), entries: r.entries,
            dropped: r.dropped, lines: r.lines, counts: r.counts, agents: r.agents, file: r.file };
    });

    // Same formatter, a fixed seven-line transcript: what the dashboard shows,
    // so a toggle can be judged against real output rather than a description.
    ctx.method('sample', (p) => {
        const o = normalize(p && p.options);
        const got = collectText(SAMPLE, o);
        return { text: assemble(tail(got.recs, o), o, null) };
    });
};
