/* claude-ui-mod :: subagents (main)
 *
 * The data layer for the subagent view. Everything it serves comes off disk, so
 * it does not depend on the app's background-task pane — which is why the
 * "view transcript" button here cannot break the way the app's does. The app
 * keeps almost nothing per subagent (activeBackgroundTasks is a
 * Map<taskId, 'local_agent'|'local_bash'|'local_workflow'>); the CLI, by
 * contrast, writes a complete transcript per agent.
 *
 * Layout, verified against app-1.26832.0 / CLI transcripts:
 *
 *   ~/.claude/projects/<project-slug>/<cliSessionId>.jsonl          parent
 *   ~/.claude/projects/<project-slug>/<cliSessionId>/subagents/
 *                                      agent-<agentId>.jsonl        one per agent
 *
 * agentId is the only key needed: it names the transcript file, and the parent's
 * Agent tool_result hands it back next to the output_file path.
 *
 * The join: the spawner-picked name lives ONLY in the parent, on the Agent
 * tool_use ({ name, description, subagent_type, model }); the agentId comes back
 * in the matching tool_result ("Async agent launched successfully … agentId: X").
 * The agent's own file carries attributionAgent (the type), per-message model,
 * effort, usage and timestamps — but not the name its spawner chose.
 *
 * Cost discipline: a busy session has ~150 agent files of ~1MB each. The index
 * therefore reads only a head chunk and a tail chunk per file, and full-parses
 * exactly one agent on demand. The parent is scanned line-wise but only lines
 * that can possibly match are handed to JSON.parse.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const NL = String.fromCharCode(10);
const FENCE = '---';
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 256 * 1024;

module.exports = function (ctx) {
    // ---------------------------------------------------------------- io bits
    function readChunk(file, from, len) {
        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(len);
            const n = fs.readSync(fd, buf, 0, len, from);
            return buf.slice(0, n).toString('utf8');
        } catch (_) { return ''; }
        finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
    }

    // A tail chunk starts mid-line, and a head chunk ends mid-line. Both ends
    // are dropped rather than repaired: a partial JSON line is worthless.
    function tailLines(file, size) {
        const from = Math.max(0, size - TAIL_BYTES);
        const text = readChunk(file, from, Math.min(TAIL_BYTES, size));
        const lines = text.split('\n');
        if (from > 0) lines.shift();
        return lines.filter((l) => l.trim().length);
    }
    function headLines(file, size) {
        const text = readChunk(file, 0, Math.min(HEAD_BYTES, size));
        const lines = text.split('\n');
        if (size > HEAD_BYTES) lines.pop();
        return lines.filter((l) => l.trim().length);
    }
    const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

    // ---------------------------------------------------------------- project
    // The project slug is derived from the cwd, so rather than reproduce that
    // mangling, look for the session that lives in it.
    const projCache = new Map();   // cliSid -> { dir, at }
    function projectDirFor(cliSid) {
        const hit = projCache.get(cliSid);
        if (hit && Date.now() - hit.at < 60000) return hit.dir;
        let dirs = [];
        try { dirs = fs.readdirSync(PROJECTS); } catch (_) { return null; }
        let found = null;
        for (const d of dirs) {
            const base = path.join(PROJECTS, d);
            if (fs.existsSync(path.join(base, cliSid))) { found = base; break; }
            if (fs.existsSync(path.join(base, cliSid + '.jsonl'))) found = base;
        }
        projCache.set(cliSid, { dir: found, at: Date.now() });
        return found;
    }

    // ---------------------------------------------------------------- the join
    // agentId -> { name, description, type, model, spawnedAt }
    const joinCache = new Map();   // parent path -> { stamp, map }
    const LAUNCH = 'Async agent launched successfully';

    function spawnTable(parentFile) {
        let st = null;
        try { st = fs.statSync(parentFile); } catch (_) { return new Map(); }
        const stamp = st.mtimeMs + ':' + st.size;
        const hit = joinCache.get(parentFile);
        if (hit && hit.stamp === stamp) return hit.map;

        const map = new Map();
        const pending = new Map();     // tool_use_id -> spawn record
        let text = '';
        try { text = fs.readFileSync(parentFile, 'utf8'); } catch (_) { return map; }

        for (const line of text.split('\n')) {
            // Only lines that can possibly matter are parsed. On a 15MB parent
            // that is the difference between a blink and a stall.
            const isSpawn = line.indexOf('"name":"Agent"') !== -1;
            const isLaunch = line.indexOf(LAUNCH) !== -1;
            if (!isSpawn && !isLaunch) continue;
            const d = parse(line);
            const content = d && d.message && d.message.content;
            if (!Array.isArray(content)) continue;
            for (const c of content) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'tool_use' && c.name === 'Agent') {
                    const i = c.input || {};
                    pending.set(c.id, {
                        name: i.name || null,
                        description: i.description || null,
                        type: i.subagent_type || null,
                        model: i.model || null,
                        isolation: i.isolation || null,
                        background: i.run_in_background !== false,
                        spawnedAt: d.timestamp || null,
                        prompt: typeof i.prompt === 'string' ? i.prompt : null,
                    });
                }
                if (c.type === 'tool_result') {
                    const flat = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
                    if (flat.indexOf(LAUNCH) === -1) continue;
                    const m = /agentId:\s*([0-9a-z]+)/i.exec(flat);
                    if (!m) continue;
                    const rec = pending.get(c.tool_use_id) || {};
                    const out = /output_file:\s*(\S[^"\\\n]*)/i.exec(flat);
                    map.set(m[1], Object.assign({}, rec, {
                        agentId: m[1],
                        toolUseId: c.tool_use_id || null,
                        outputFile: out ? out[1].trim() : null,
                    }));
                }
            }
        }
        joinCache.set(parentFile, { stamp, map });
        return map;
    }

    // ---------------------------------------------------------------- index
    // Per-file summary from a head chunk and a tail chunk only.
    const rowCache = new Map();   // file -> { stamp, row }

    function firstText(msg) {
        if (!msg) return '';
        const c = msg.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            for (const p of c) if (p && p.type === 'text' && p.text) return p.text;
        }
        return '';
    }

    // ---------------------------------------------------------------- state
    /* An agent's own transcript says what happened to it, structurally, with no
     * timing in it anywhere. The CLI writes one jsonl line per content block and
     * puts stop_reason on the LAST block of an assistant turn, so:
     *
     *   terminal stop_reason on the last line    it finished on its own terms
     *   an interruption marker on the last line  it was stopped
     *   anything else                            the CLI still owes it a write
     *
     * Only the third case needs an outside opinion, and the only thing that can
     * give one is whether the session that owns it still has live background
     * activity - see the renderer. Measured over the 142 agents of one real
     * session: 116 done, 21 stopped, 5 unterminated.
     */
    const TERMINAL = { end_turn: 1, max_tokens: 1, stop_sequence: 1, refusal: 1 };
    const INTERRUPTED = 'Request interrupted';
    const REJECTED = 'want to proceed with this tool use';

    function allText(msg) {
        if (!msg) return '';
        const c = msg.content;
        if (typeof c === 'string') return c;
        if (!Array.isArray(c)) return '';
        let out = '';
        for (const p of c) {
            if (!p || typeof p !== 'object') continue;
            if (typeof p.text === 'string') out += p.text;
            else if (typeof p.content === 'string') out += p.content;
            else if (Array.isArray(p.content)) {
                for (const q of p.content) if (q && typeof q.text === 'string') out += q.text;
            }
        }
        return out;
    }

    function stateOf(last) {
        if (!last) return 'inflight';
        const m = last.message || {};
        if (m.stop_reason && TERMINAL[m.stop_reason]) return 'done';
        if (last.toolDenialKind) return 'stopped';
        if (last.type === 'user') {
            const t = allText(m);
            if (t.indexOf(INTERRUPTED) >= 0 || t.indexOf(REJECTED) >= 0) return 'stopped';
        }
        return 'inflight';
    }

    // ---------------------------------------------------------------- sidecar
    /* Every agent file has an agent-<id>.meta.json beside it carrying exactly
     * what the parent-transcript join was reconstructing - and carrying it for
     * nested agents too, which the join cannot see because their spawner is
     * another agent rather than the session itself. */
    const metaCache = new Map();   // meta path -> { stamp, meta }
    const META_RE = /\.jsonl$/;
    function metaFor(file) {
        const mf = file.replace(META_RE, '.meta.json');
        let st = null;
        try { st = fs.statSync(mf); } catch (_) { return null; }
        const stamp = st.mtimeMs + ':' + st.size;
        const hit = metaCache.get(mf);
        if (hit && hit.stamp === stamp) return hit.meta;
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (_) { meta = null; }
        metaCache.set(mf, { stamp, meta });
        return meta;
    }

    function rowFor(file, st) {
        const stamp = st.mtimeMs + ':' + st.size;
        const hit = rowCache.get(file);
        if (hit && hit.stamp === stamp) return hit.row;

        const head = headLines(file, st.size).map(parse).filter(Boolean);
        const tail = tailLines(file, st.size).map(parse).filter(Boolean);
        if (!head.length) return null;

        const first = head[0];
        const last = tail.length ? tail[tail.length - 1] : first;

        // Most recent signals, walked backwards: what it said last, and what
        // tool it reached for last (which is "what it is doing" for a live one).
        let lastText = '', lastTool = null, model = null, effort = null;
        for (let i = tail.length - 1; i >= 0; i--) {
            const d = tail[i];
            if (d.type !== 'assistant') continue;
            const m = d.message || {};
            if (!model) model = m.model || null;
            if (!effort) effort = d.effort || null;
            const c = Array.isArray(m.content) ? m.content : [];
            for (let j = c.length - 1; j >= 0; j--) {
                const p = c[j];
                if (!p || typeof p !== 'object') continue;
                if (!lastTool && p.type === 'tool_use') lastTool = p.name || null;
                if (!lastText && p.type === 'text' && p.text) lastText = p.text;
            }
            if (lastText && lastTool && model) break;
        }

        const row = {
            agentId: first.agentId || path.basename(file).replace(/^agent-|\.jsonl$/g, ''),
            file,
            size: st.size,
            mtime: st.mtimeMs,
            startedAt: first.timestamp || null,
            lastAt: last.timestamp || null,
            attribution: null,
            model,
            effort,
            slug: first.slug || null,
            cwd: first.cwd || null,
            gitBranch: first.gitBranch || null,
            brief: firstText(first.message).slice(0, 1200),
            lastText: lastText.slice(0, 600),
            lastTool,
            state: stateOf(last),
        };
        for (const d of tail) if (d.attributionAgent) { row.attribution = d.attributionAgent; break; }
        if (!row.attribution) for (const d of head) if (d.attributionAgent) { row.attribution = d.attributionAgent; break; }

        rowCache.set(file, { stamp, row });
        return row;
    }

    function listAgents(cliSid) {
        const proj = projectDirFor(cliSid);
        if (!proj) return { ok: false, reason: 'no project dir for ' + cliSid };
        const dir = path.join(proj, cliSid, 'subagents');
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { names = []; }

        const join = spawnTable(path.join(proj, cliSid + '.jsonl'));
        const now = Date.now();
        const rows = [];
        for (const n of names) {
            if (!n.endsWith('.jsonl')) continue;
            const file = path.join(dir, n);
            let st = null;
            try { st = fs.statSync(file); } catch (_) { continue; }
            if (!st.size) continue;
            const row = rowFor(file, st);
            if (!row) continue;
            const j = join.get(row.agentId) || {};
            const meta = metaFor(file) || {};
            rows.push(Object.assign(row, {
                name: meta.name || j.name || null,
                description: meta.description || j.description || null,
                type: meta.agentType || j.type || row.attribution || null,
                askedModel: meta.model || j.model || null,
                parentAgentId: meta.parentAgentId || null,
                depth: meta.spawnDepth || 1,
                isolation: j.isolation || null,
                outputFile: j.outputFile || null,
                spawnedAt: j.spawnedAt || row.startedAt,
                idleFor: now - st.mtimeMs,
            }));
        }
        // Newest first inside each group; the view groups by active.
        rows.sort((a, b) => b.mtime - a.mtime);
        return { ok: true, cliSid, dir, agents: rows, spawned: join.size,
            named: rows.filter((r) => r.name).length, at: now };
    }

    // ---------------------------------------------------------------- detail
    // Full parse of one agent, with the turn list the reader renders. Gaps are
    // kept as first-class entries: a stop-then-resume shows up as a real seam
    // rather than as a transcript that silently jumps.
    function detail(cliSid, agentId, opts) {
        const o = opts || {};
        const gapMs = Number(o.gapMs) || 90000;
        const maxTurns = Number(o.maxTurns) || 400;
        const proj = projectDirFor(cliSid);
        if (!proj) return { ok: false, reason: 'no project dir' };
        const file = path.join(proj, cliSid, 'subagents', 'agent-' + agentId + '.jsonl');
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: 'no transcript' }; }

        const turns = [];
        const tools = {};
        let outTokens = 0, cacheRead = 0, cacheWrite = 0, inTokens = 0;
        let prevAt = null, lines = 0;

        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            const d = parse(line);
            if (!d) continue;
            lines++;
            const at = d.timestamp ? Date.parse(d.timestamp) : null;
            if (at && prevAt && at - prevAt > gapMs) {
                turns.push({ kind: 'gap', ms: at - prevAt, at: d.timestamp });
            }
            if (at) prevAt = at;

            const m = d.message || {};
            const u = m.usage;
            if (u) {
                outTokens += u.output_tokens || 0;
                inTokens += u.input_tokens || 0;
                cacheRead += u.cache_read_input_tokens || 0;
                cacheWrite += u.cache_creation_input_tokens || 0;
            }

            const content = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
            const parts = [];
            for (const c of content) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'text' && c.text) parts.push({ t: 'text', text: c.text });
                else if (c.type === 'thinking' && c.thinking) parts.push({ t: 'thinking', text: c.thinking });
                else if (c.type === 'tool_use') {
                    tools[c.name] = (tools[c.name] || 0) + 1;
                    parts.push({ t: 'tool', name: c.name, input: brief(c.input) });
                } else if (c.type === 'tool_result') {
                    parts.push({ t: 'result', text: flat(c.content).slice(0, 900), error: !!c.is_error });
                }
            }
            if (!parts.length) continue;
            turns.push({
                kind: d.type === 'assistant' ? 'assistant' : 'user',
                at: d.timestamp || null,
                model: m.model || null,
                parts,
            });
        }

        const trimmed = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
        return {
            ok: true,
            agentId,
            file,
            lines,
            turns: trimmed,
            dropped: turns.length - trimmed.length,
            tools,
            tokens: { out: outTokens, in: inTokens, cacheRead, cacheWrite },
        };
    }

    function flat(v) {
        if (typeof v === 'string') return v;
        if (Array.isArray(v)) return v.map((x) => (x && x.type === 'text' ? x.text : flat(x))).join('\n');
        if (v && typeof v === 'object') return JSON.stringify(v);
        return String(v == null ? '' : v);
    }
    // Tool inputs are shown as one line, so a 40KB prompt cannot blow the reader.
    function brief(input) {
        if (!input || typeof input !== 'object') return '';
        const bits = [];
        for (const k of ['command', 'file_path', 'pattern', 'path', 'prompt', 'description', 'query', 'url', 'subagent_type', 'name']) {
            if (typeof input[k] === 'string' && input[k]) bits.push(k + ': ' + input[k].replace(/\s+/g, ' ').slice(0, 160));
        }
        if (!bits.length) return JSON.stringify(input).slice(0, 200);
        return bits.join('  ·  ');
    }

    // ---------------------------------------------------------------- defs
    // The agent definitions behind the types that actually ran. Frontmatter
    // only — the body is the system prompt and the view has no use for it.
    const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
    let defsCache = null;
    function definitions() {
        if (defsCache && Date.now() - defsCache.at < 30000) return defsCache.map;
        const map = {};
        let names = [];
        try { names = fs.readdirSync(AGENTS_DIR); } catch (_) { names = []; }
        for (const n of names) {
            if (!n.endsWith('.md')) continue;
            let head = '';
            try { head = readChunk(path.join(AGENTS_DIR, n), 0, 4096); } catch (_) { continue; }
            // Hand-parsed rather than regexed: frontmatter is two fences and
            // key: value lines, and a regex here buys nothing.
            const lines = head.split(NL);
            if (!lines.length || lines[0].trim() !== FENCE) continue;
            const def = {};
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                if (line.trim() === FENCE) break;
                const c = line.indexOf(':');
                if (c > 0) def[line.slice(0, c).trim()] = line.slice(c + 1).trim();
            }
            const key = def.name || n.slice(0, -3);
            map[key] = {
                name: key,
                description: def.description || null,
                model: def.model || null,
                effort: def.effort || null,
                tools: def.tools || null,
            };
        }
        defsCache = { at: Date.now(), map };
        return map;
    }

    // ---------------------------------------------------------------- methods
    ctx.method('list', (p) => {
        const sid = p && p.cliSid;
        if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return { ok: false, reason: 'bad session id' };
        return listAgents(sid);
    });

    ctx.method('detail', (p) => {
        const sid = p && p.cliSid;
        const id = p && p.agentId;
        if (typeof sid !== 'string' || !SESSION_RE.test(sid)) return { ok: false, reason: 'bad session id' };
        if (typeof id !== 'string' || !/^[0-9a-z]{4,40}$/i.test(id)) return { ok: false, reason: 'bad agent id' };
        return detail(sid, id, p);
    });

    ctx.method('defs', () => definitions());

    ctx.method('reveal', async (p) => {
        const f = p && p.file;
        if (typeof f !== 'string' || !f) return false;
        try { ctx.electron.shell.showItemInFolder(f); return true; } catch (_) { return false; }
    });

    ctx.onDispose(() => { projCache.clear(); joinCache.clear(); rowCache.clear(); metaCache.clear(); defsCache = null; });
};
