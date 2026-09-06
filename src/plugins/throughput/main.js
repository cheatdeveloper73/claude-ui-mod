/* claude-ui-mod :: throughput (main)
 *
 * The data layer for the generation-rate readout. It joins two sources that
 * neither one of them can replace:
 *
 *   the router  exact tokens and exact clocks per provider response, keyed by
 *               provider response id. It is the only place the wire is visible,
 *               so it is the only place a real rate can be measured.
 *   the CLI     which agent produced that response. The router cannot know:
 *               every subagent turn carries the PARENT session id in
 *               x-claude-code-session-id, so at the transport layer a session's
 *               main turns and its fifty agents are one indistinguishable
 *               stream. The request does say whether it is A subagent
 *               (cc_is_subagent=true in the billing-header system block, which
 *               the router records) but never WHICH one.
 *
 * The join key is the provider response id, and it is exact on both sides: the
 * CLI writes the provider's own message id into the transcript as message.id.
 * Verified 2026-09-01 against both an Anthropic session (msg_011Cebmuu…) and a
 * a non-Anthropic provider (opaque ids like -BiWaqK-HP_UjMcP48PyqAQ).
 *
 * Cost discipline. A busy session's subagent directory is ~150 files of ~1MB.
 * Reading all of it on every poll would stall the main process, so:
 *   - each file is read only from the offset last scanned, since a jsonl
 *     transcript is append-only;
 *   - files untouched since the oldest record being attributed are skipped
 *     outright, which in practice is nearly all of them;
 *   - a byte budget bounds the cold pass, and anything left unresolved stays
 *     unresolved rather than blocking. An unattributed row still shows its
 *     lane, because the router already knows main from subagent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROUTER = process.env.CUIMOD_ROUTER_URL || 'http://127.0.0.1:8789';
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One cold pass over a busy session's transcripts, bounded. Steady state reads
// the few kilobytes appended since the last poll.
const SCAN_BUDGET_BYTES = 24 * 1024 * 1024;
const ASSISTANT = '"role":"assistant"';

// Live data must be live. This is short enough that two windows polling at 1s
// still feel immediate, and long enough that they share most requests.
const SNAPSHOT_TTL_MS = 400;
const HISTORY_TTL_MS = 15000;

module.exports = function (ctx) {
    // ------------------------------------------------------------ router io
    function routerJSON(route) {
        return new Promise((resolve, reject) => {
            const req = http.get(ROUTER + route, { timeout: 10000 }, (res) => {
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > 16 * 1024 * 1024) { req.destroy(new Error('router response too large')); return; }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) { reject(new Error('router ' + res.statusCode)); return; }
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                    catch (err) { reject(err); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('router timeout')));
            req.on('error', reject);
        });
    }

    const caches = new Map();      // route -> { at, value }
    const inflight = new Map();    // route -> promise
    function cached(route, ttl) {
        const hit = caches.get(route);
        if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
        if (inflight.has(route)) return inflight.get(route);
        const promise = routerJSON(route)
            .then((value) => { caches.set(route, { at: Date.now(), value }); return value; })
            .finally(() => inflight.delete(route));
        inflight.set(route, promise);
        return promise;
    }

    // --------------------------------------------------------- project dirs
    const projectDirs = new Map();  // cliSid -> { dir, at }
    function projectDirFor(cliSid) {
        const hit = projectDirs.get(cliSid);
        if (hit && Date.now() - hit.at < 60000) return hit.dir;
        let names = [];
        try { names = fs.readdirSync(PROJECTS); } catch (_) { return null; }
        let found = null;
        for (const name of names) {
            const base = path.join(PROJECTS, name);
            // The directory (holding subagents/) is the stronger signal, so it
            // wins outright; a bare parent jsonl is kept as a fallback.
            if (fs.existsSync(path.join(base, cliSid))) { found = base; break; }
            if (fs.existsSync(path.join(base, cliSid + '.jsonl'))) found = base;
        }
        projectDirs.set(cliSid, { dir: found, at: Date.now() });
        return found;
    }

    // ------------------------------------------------------------ the join
    // cliSid -> { byResponse: Map, offsets: Map, agents: Map }
    const indexes = new Map();
    function indexFor(cliSid) {
        let index = indexes.get(cliSid);
        if (!index) {
            index = { byResponse: new Map(), offsets: new Map(), agents: new Map() };
            indexes.set(cliSid, index);
        }
        return index;
    }

    // agent-<id>.meta.json beats reconstructing the spawn from the parent's
    // Agent tool_use / tool_result pair: it exists for nested agents too, whose
    // spawner is another agent rather than the session.
    function agentMeta(index, dir, agentId) {
        const hit = index.agents.get(agentId);
        const file = path.join(dir, 'agent-' + agentId + '.meta.json');
        let stat = null;
        try { stat = fs.statSync(file); } catch (_) { /* an agent may have no sidecar */ }
        const stamp = stat ? stat.mtimeMs + ':' + stat.size : 'none';
        if (hit && hit.stamp === stamp) return hit.value;

        let value = { agentId, name: null, agentType: null, spawnDepth: null, parentAgentId: null };
        if (stat) {
            try {
                const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
                value = {
                    agentId,
                    name: typeof doc.name === 'string' ? doc.name.slice(0, 64) : null,
                    agentType: typeof doc.agentType === 'string' ? doc.agentType.slice(0, 64) : null,
                    spawnDepth: Number.isFinite(doc.spawnDepth) ? doc.spawnDepth : null,
                    parentAgentId: typeof doc.parentAgentId === 'string' ? doc.parentAgentId : null,
                };
            } catch (_) { /* mid-write */ }
        }
        index.agents.set(agentId, { stamp, value });
        return value;
    }

    // Append-only, so only the tail is new. The final line of a chunk may be
    // half-written; it is dropped and the offset stops before it, which makes
    // the next pass pick it up whole rather than repairing a partial JSON line.
    function scanFile(index, file, size, agentId, dir) {
        const from = index.offsets.get(file) || 0;
        if (size <= from) return 0;
        let text = '';
        let fd = null;
        try {
            fd = fs.openSync(file, 'r');
            const length = size - from;
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, from);
            text = buffer.subarray(0, read).toString('utf8');
        } catch (_) { return 0; }
        finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }

        const cut = text.lastIndexOf('\n');
        if (cut === -1) return 0;
        index.offsets.set(file, from + Buffer.byteLength(text.slice(0, cut + 1), 'utf8'));

        for (const line of text.slice(0, cut).split('\n')) {
            // Only lines that can possibly carry a provider message id are
            // parsed. On a 4MB parent that is 352 parses instead of 20,000.
            if (line.indexOf(ASSISTANT) === -1) continue;
            let entry = null;
            try { entry = JSON.parse(line); } catch (_) { continue; }
            const id = entry && entry.message && entry.message.id;
            if (typeof id !== 'string' || !id) continue;
            const owner = typeof entry.agentId === 'string' ? entry.agentId : agentId;
            const model = typeof entry.message.model === 'string' ? entry.message.model : null;
            if (owner) {
                const meta = agentMeta(index, dir, owner);
                index.byResponse.set(id, {
                    lane: 'subagent', agentId: owner, name: meta.name, agentType: meta.agentType,
                    spawnDepth: meta.spawnDepth, model,
                });
            } else if (entry.isSidechain === true) {
                // A sidechain turn with no agentId is a subagent whose identity
                // this file does not carry. Saying "main" here would be worse
                // than saying nothing.
                index.byResponse.set(id, { lane: 'subagent', agentId: null, name: null, agentType: null, spawnDepth: null, model });
            } else {
                index.byResponse.set(id, { lane: 'main', agentId: null, name: null, agentType: null, spawnDepth: null, model });
            }
        }
        return size - from;
    }

    function attribute(cliSid, needed, sinceMs) {
        if (typeof cliSid !== 'string' || !SESSION_RE.test(cliSid)) return new Map();
        const index = indexFor(cliSid);
        const outstanding = new Set([...needed].filter((id) => !index.byResponse.has(id)));
        const dir = projectDirFor(cliSid);
        if (!dir) return index.byResponse;

        const candidates = [];
        const parent = path.join(dir, cliSid + '.jsonl');
        try {
            const stat = fs.statSync(parent);
            candidates.push({ file: parent, size: stat.size, mtime: stat.mtimeMs, agentId: null, dir });
        } catch (_) { /* a session may have no parent file yet */ }

        const agentsDir = path.join(dir, cliSid, 'subagents');
        let names = [];
        try { names = fs.readdirSync(agentsDir); } catch (_) { names = []; }
        for (const name of names) {
            if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
            const file = path.join(agentsDir, name);
            let stat = null;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            candidates.push({
                file, size: stat.size, mtime: stat.mtimeMs,
                agentId: name.slice('agent-'.length, -'.jsonl'.length), dir: agentsDir,
            });
        }

        // Newest first, and never older than the oldest record being attributed.
        // A file untouched since before that record cannot contain it.
        let budget = SCAN_BUDGET_BYTES;
        candidates.sort((a, b) => b.mtime - a.mtime);
        for (const candidate of candidates) {
            if (!outstanding.size && index.offsets.has(candidate.file)) continue;
            if (Number.isFinite(sinceMs) && candidate.mtime < sinceMs && !index.offsets.has(candidate.file)) continue;
            if (budget <= 0) break;
            budget -= scanFile(index, candidate.file, candidate.size, candidate.agentId, candidate.dir);
            for (const id of outstanding) if (index.byResponse.has(id)) outstanding.delete(id);
        }
        return index.byResponse;
    }

    // Attribution never widens what the router already established. The router
    // read the lane off the wire; the transcript only names the agent.
    function decorate(rows, byResponse) {
        return rows.map((row) => {
            const hit = byResponse.get(row.responseId) || null;
            const lane = row.subagent === true ? 'subagent' : row.subagent === false ? 'main' : hit ? hit.lane : 'unknown';
            return {
                ...row,
                lane,
                agentId: hit ? hit.agentId : null,
                agentName: hit ? hit.name : null,
                agentType: hit ? hit.agentType : null,
                spawnDepth: hit ? hit.spawnDepth : null,
            };
        });
    }

    const laneKey = (row) => (row.lane === 'subagent'
        ? 'agent:' + (row.agentId || 'unnamed')
        : row.lane === 'main' ? 'main' : 'unknown');

    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

    function percentile(values, fraction) {
        const sorted = values.filter((v) => number(v) !== null).sort((a, b) => a - b);
        if (!sorted.length) return null;
        return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1) + 0.5))];
    }

    // Tokens over generation time, not the mean of the per-response rates. A
    // twelve-token acknowledgement must not outvote a four-thousand-token turn.
    function rollup(rows, keyOf, labelOf) {
        const groups = new Map();
        for (const row of rows) {
            const key = keyOf(row);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }
        return [...groups.entries()].map(([key, list]) => {
            const tokens = list.reduce((total, row) => total + (row.tokens?.outputTokens || 0), 0);
            const streamMs = list.reduce((total, row) => total + (number(row.streamMs) || 0), 0);
            return {
                key,
                label: labelOf ? labelOf(list[0], list) : key,
                responses: list.length,
                outputTokens: tokens,
                reasoningOutputTokens: list.reduce((t, row) => t + (row.tokens?.reasoningOutputTokens || 0), 0),
                contextInputTokens: list.reduce((t, row) => t + (row.tokens?.contextInputTokens || 0), 0),
                sustainedTps: streamMs > 0 && tokens > 0 ? Number(((tokens * 1000) / streamMs).toFixed(1)) : null,
                p50Tps: percentile(list.map((row) => row.outputTps), 0.5),
                p90Tps: percentile(list.map((row) => row.outputTps), 0.9),
                p50TtftMs: percentile(list.map((row) => row.ttftMs), 0.5),
                p50TtfbMs: percentile(list.map((row) => row.ttfbMs), 0.5),
                providers: [...new Set(list.map((row) => row.provider))],
                models: [...new Set(list.map((row) => row.servedModel))],
                lastAt: list.reduce((max, row) => (max === null || row.completedAt > max ? row.completedAt : max), null),
            };
        }).sort((a, b) => b.outputTokens - a.outputTokens);
    }

    const oldest = (rows) => rows.reduce((min, row) => {
        const at = Date.parse(row.completedAt);
        return Number.isFinite(at) && (min === null || at < min) ? at : min;
    }, null);

    // ---------------------------------------------------------------- methods

    // The live surface. Recent completions are attributed; in-flight rows carry
    // only what the router can see, because a response with no id yet has
    // nothing to join against.
    //
    // The recent list is fetched session-scoped rather than filtered out of the
    // router's global ring. That ring holds the last forty responses across
    // every session sharing this router, so a window whose session is quieter
    // than its neighbour would filter it down to nothing and show an empty
    // panel while its own model was plainly answering.
    ctx.method('snapshot', async (params) => {
        const sessionId = params && params.sessionId;
        const all = params && params.scope === 'all';
        const recentRoute = all || !sessionId
            ? '/throughputz'
            : '/throughput/api?limit=40&session=' + encodeURIComponent(sessionId);
        const [snapshot, scopedSource] = await Promise.all([
            cached('/throughputz', SNAPSHOT_TTL_MS),
            all || !sessionId ? null : cached(recentRoute, SNAPSHOT_TTL_MS),
        ]);
        const scoped = scopedSource ? scopedSource.records : snapshot.recent;
        const live = all ? snapshot.live : snapshot.live.filter((row) => row.sessionId === sessionId);

        const since = oldest(scoped);
        const byResponse = sessionId
            ? attribute(sessionId, new Set(scoped.map((row) => row.responseId)),
                Number.isFinite(since) ? since - 60 * 60 * 1000 : NaN)
            : new Map();
        const recent = decorate(scoped, byResponse);

        return {
            observedAt: snapshot.observedAt,
            records: snapshot.records,
            sessionId: sessionId || null,
            live: live.map((row) => {
                const hit = row.responseId ? byResponse.get(row.responseId) : null;
                return {
                    ...row,
                    lane: row.subagent === true ? 'subagent' : row.subagent === false ? 'main' : 'unknown',
                    agentId: hit ? hit.agentId : null,
                    agentName: hit ? hit.name : null,
                    agentType: hit ? hit.agentType : null,
                };
            }),
            recent: recent.slice(-24).reverse(),
            // Lanes belong to history(), which sees the whole window rather than
            // the last forty responses. Rolling them up twice would let the two
            // sections disagree about the same session.
            providers: snapshot.providers,
        };
    });

    // History. The router owns the archive; this adds the agent join and the
    // per-lane rollup, which only make sense with the transcripts in hand.
    ctx.method('history', async (params) => {
        const sessionId = params && params.sessionId;
        const scope = (params && params.scope) || 'session';
        const hours = Number(params && params.hours);
        const query = new URLSearchParams();
        if (scope === 'session' && sessionId) query.set('session', sessionId);
        if (Number.isFinite(hours) && hours > 0) query.set('since', new Date(Date.now() - hours * 3600000).toISOString());
        query.set('limit', '2000');

        const value = await cached('/throughput/api?' + query.toString(), HISTORY_TTL_MS);
        const rows = value.records || [];
        const since = oldest(rows);
        const byResponse = scope === 'session' && sessionId
            ? attribute(sessionId, new Set(rows.map((row) => row.responseId)),
                Number.isFinite(since) ? since - 60 * 60 * 1000 : NaN)
            : new Map();
        const decorated = decorate(rows, byResponse);

        return {
            scope,
            hours: Number.isFinite(hours) && hours > 0 ? hours : null,
            matched: value.matched,
            returned: value.returned,
            models: rollup(decorated, (row) => row.provider + ':' + row.servedModel,
                (row) => row.servedModel),
            providers: rollup(decorated, (row) => row.provider, (row) => row.provider),
            lanes: rollup(decorated, laneKey, (row) => (row.lane === 'main' ? 'Main session'
                : row.agentName || row.agentType || (row.agentId ? 'agent ' + row.agentId.slice(0, 8) : 'Subagent'))),
            sessions: scope === 'session' ? [] : rollup(decorated, (row) => row.sessionId || 'unknown',
                (row) => (row.sessionId ? row.sessionId.slice(0, 8) : 'unknown')),
        };
    });

    // The chip in the app's own streaming strip polls this rather than
    // snapshot(): it needs one number, several times a second, and an in-flight
    // response has no id to join a transcript against anyway. No attribution, no
    // history, no rollups.
    ctx.method('live', async (params) => {
        const sessionId = params && params.sessionId;
        // The last completed response comes back with the in-flight ones because
        // a turn is mostly NOT streaming: the model answers, tools run, the model
        // answers again. Without it the chip would blink out during every tool
        // call, which reads as broken rather than as idle.
        //
        // Session-scoped from the archive rather than filtered out of the global
        // recent ring: that ring is forty deep across every session sharing this
        // router, so a busy neighbour would push this session's last response out
        // of it.
        const [snapshot, previous] = await Promise.all([
            cached('/throughputz', SNAPSHOT_TTL_MS),
            sessionId ? cached('/throughput/api?limit=1&session=' + encodeURIComponent(sessionId), SNAPSHOT_TTL_MS) : null,
        ]);
        const rows = sessionId
            ? snapshot.live.filter((row) => row.sessionId === sessionId)
            : snapshot.live;
        const last = previous && previous.records && previous.records.length
            ? previous.records[previous.records.length - 1]
            : null;
        return {
            observedAt: snapshot.observedAt,
            last: last ? {
                servedModel: last.servedModel,
                completedAt: last.completedAt,
                outputTps: last.outputTps,
                endToEndTps: last.endToEndTps,
                outputTokens: last.tokens ? last.tokens.outputTokens : null,
                ttftMs: last.ttftMs,
            } : null,
            live: rows.map((row) => ({
                id: row.id,
                provider: row.provider,
                servedModel: row.servedModel,
                lane: row.subagent === true ? 'subagent' : row.subagent === false ? 'main' : 'unknown',
                elapsedMs: row.elapsedMs,
                ttftMs: row.ttftMs,
                observedTokens: row.observedTokens,
                observedTps: row.observedTps,
                estimatedTps: row.estimatedTps,
                charsPerSecond: row.charsPerSecond,
                calibrationSamples: row.calibration ? row.calibration.samples : null,
            })),
        };
    });

    ctx.method('revealLedger', async () => {
        let file = null;
        try { file = (await cached('/throughputz', SNAPSHOT_TTL_MS)).file; } catch (_) {}
        if (!file) return { ok: false, error: 'router unreachable' };
        try { ctx.electron.shell.showItemInFolder(file); } catch (err) { return { ok: false, error: String(err && err.message) }; }
        return { ok: true, file };
    });

    ctx.onDispose(() => { caches.clear(); inflight.clear(); indexes.clear(); projectDirs.clear(); });
};
