/* claude-ui-mod :: subagents (renderer)
 *
 * Two surfaces, not one.
 *
 *   The rail   a permanent HUD in the gutter between the app sidebar and the
 *              composer, at the top of the column the task rail occupies at the
 *              bottom. Top-down list of this session's agents: who is running,
 *              what they are on, how long they have been at it.
 *
 *   The sheet  one agent, full width of the transcript region: its transcript
 *              plus the controls for it. Opened by clicking a rail row, and it
 *              grows out of that row rather than cutting to a new screen.
 *
 *   The chat   what passed between that agent and its direct parent — the
 *              assignment, SendMessage traffic both ways, the final report —
 *              drawn in the gutter left of the transcript as the app draws its
 *              own conversation. It sits beside the transcript, never instead
 *              of it, and is simply absent when the window leaves no gutter.
 *
 * Colour carries one meaning: running. Everything else is the app's own neutral
 * ramp, and agent types are told apart by their names rather than by hues
 * assigned from a hash.
 *
 * Data comes from the CLI's per-agent transcript files (see main.js), so the
 * reader works for agents that were stopped and resumed — the app's own
 * "view transcript" does not — and a resume renders as a labelled seam. Turn on
 * `mock` to drive both surfaces from fabricated agents, which is the only way
 * to look at the running state without a session that happens to have one.
 *
 * Nothing is inserted into React-owned DOM: both surfaces live in a shadow root
 * on a floating host, positioned from measured anchors every tick.
 *
 * Rendering is a patch, not a rebuild — see the render section for why that is
 * load-bearing rather than an optimisation.
 */
'use strict';

const DEF = {
    enabled: true,
    hotkey: 'F2',
    mock: false,
    stoppedLimit: 8,
    showThinking: false,
    accent: '#c96442',
    railWidth: 268,
    railTop: 72,
    size: 13,
};

let V = Object.assign({}, DEF);

const GAP = 12;
const RAIL_MIN = 196;
// Not settings. Whether an agent is running is read out of its own transcript
// and out of the app's own session state (see refresh), so there is no
// threshold to tune; the rest of these are implementation numbers, not tastes.
const POLL_MS = 2000;
const SESSION_GAP_MS = 5000;
const TAIL_LINES = 5;
const MAX_TURNS = 400;
const GAP_MS = 90000;
const MEASURE_FALLBACK = 760;
// The chat's column: narrower than CHAT_MIN and a message is a word per line,
// wider than CHAT_MAX and it stops reading as a column beside the transcript.
const CHAT_MIN = 250;
const CHAT_MAX = 440;
const CHAT_GAP = 36;
const CHAT_PAGE = 60;
const CHAT_CLAMP = 280;      // px of message before it folds behind "show more"

// ------------------------------------------------------------------ state
let cliSid = null;
let agents = [];
let defs = {}, defsAt = 0;
const DEFS_MS = 30000;
let detailId = null;         // agent shown in the sheet, or null
let showAll = false;
let railOff = false;         // hidden by the hotkey for this session
let loading = false;
let lastErr = null;
let sessionGap = false;
let sessionGapTimer = null;
let armedStop = null;
let armedTimer = null;

const details = new Map();   // agentId -> detail payload
const pendingDetail = new Set();

// The chat belongs to one agent at a time. chatSeq retires any thread request
// still in flight when the sheet moves to another agent or closes.
let chatItems = [], chatEarlier = 0, chatParent = 'main';
let chatSeq = 0, chatBusy = false;

// Live DOM the renderer patches rather than rebuilds.
let railEl = null, railCap = null, capTxt = null, railDemo = null;
let railBody = null, runBox = null, doneBox = null, moreEl = null, emptyEl = null;
let sheetEl = null, sheetInner = null, scrimEl = null;
let chatEl = null, chatBody = null, chatList = null, chatMore = null;
const runEls = new Map();    // agentId -> row
const doneEls = new Map();
const chatEls = new Map();   // message id -> node

const STOP_TASK = cuimod.eipc('claude.web', 'LocalSessions', 'stopTask');
const GET_SESSION = cuimod.eipc('claude.web', 'LocalSessions', 'getSession');

/* Whether an agent is running is answered in three parts, none of them a timer.
 *
 * main.js reads the agent's own transcript: a terminal stop_reason on the last
 * line means it finished, an interruption marker means it was stopped.
 *
 * Anything else means the CLI still owes that file a write — which is what a
 * hard kill leaves behind, what a live agent looks like, and, far more often
 * than the original measurement suggested, what a perfectly finished agent
 * looks like too. So main.js then reads the parent's own <task-notification>
 * records, which are the CLI stating that a named agent stopped. In two
 * measured sessions that took the unresolved residue from 13 of 16 to 0, and
 * from 22 of 97 to 8 — the 8 being every agent that had written within three
 * minutes.
 *
 * What survives both is an agent with no notification the parent can see, which
 * in practice means a nested one. For those the app publishes the only bit
 * available: hasBackgroundActivity on the session record, which is its own
 * hasLiveBackgroundTasks. If the session that owns the agent has no live
 * background task, nothing is running in it. (activeBackgroundTasks itself, the
 * per-task map, is stripped from the record the renderer receives — checked
 * against app-1.26832.0.) That flag is session-wide, so it must stay a last
 * resort: applied to a large residue it marks every dead agent running at once,
 * which is the failure this was rebuilt to remove. */
async function backgroundActivity() {
    try {
        const local = (location.pathname.match(/local_[0-9a-f-]{36}/) || [null])[0];
        if (!local) return false;
        const sess = await cuimod.appInvoke(GET_SESSION, local);
        return !!(sess && sess.hasBackgroundActivity);
    } catch (_) { return false; }
}

const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
const MS = (n) => (reduced() ? 1 : n);

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}
function dur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
const ts = (v) => (v ? Date.parse(v) : null);
const hhmm = (ms) => (Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 5) : '—');
const clock = (ms) => (Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 8) : '');
// BEGIN definition pin
const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
// What a definition pins, as "model · effort", beside its name. This is the
// definition's own frontmatter, not what the transcript later reports, so it
// is known the moment the agent is. A context tag ("[1m]") and an effort
// already folded into the id ("gpt-6.1-sol:high") are dropped from the model.
function defPin(type) {
    const d = type && defs[type];
    if (!d) return '';
    const model = d.model ? shortModel(String(d.model).replace(/\[[^\]]*\]/g, '').replace(/:.*$/, '')) : '';
    return [model, d.effort].filter(Boolean).join(' · ');
}
// END definition pin
const STRIP = /`([^`]*)`|\*\*([^*]*)\*\*/g;
// A one-liner is plain text. Leaving the source markup in shows the reader
// literal asterisks and backticks in the one place there is no room for them.
const oneline = (s) => String(s || '')
    .replace(STRIP, (_, a, b) => (a != null ? a : b))
    .replace(/\s+/g, ' ').trim();
function spanOf(a) {
    const s = ts(a.spawnedAt || a.startedAt);
    const e = a.active ? Date.now() : ts(a.lastAt);
    return { s, e, ms: s && e ? e - s : null };
}
const byId = (id) => agents.find((a) => a.agentId === id) || null;

// ------------------------------------------------------------------ mock
/* Fabricated agents, so the running state can be looked at without waiting for
 * a session to happen to have one. Everything is derived from a fixed epoch, so
 * clocks tick, the live tails grow, and the reconcile is exercised for real. */
const NLC = String.fromCharCode(10);
const MOCK_T0 = Date.now();
const MOCK_LIVE = 3;
const MOCK = [
    { n: 'rv-scheduler', t: 'reviewer', m: 'claude-opus-5-5', e: 'high', ago: 892000, ran: 0,
      tool: 'Bash', last: 'Checking the backoff table against the spec',
      brief: 'Review the retry scheduler rewrite against the reference implementation.' },
    { n: 'rv-protocol', t: 'reviewer', m: 'claude-opus-5-5', e: 'high', ago: 631000, ran: 0,
      tool: 'Read', last: 'Reading the frame definitions for the delta channel',
      brief: 'Audit the protocol changes for client/server type agreement.' },
    { n: 'rd-cache', t: 'reader', m: 'claude-sonnet-5-5', e: 'medium', ago: 148000, ran: 0,
      tool: 'Grep', last: 'Locating every call into the eviction queue',
      brief: 'Read the cache layer end to end and report its eviction contract.' },
    { n: 'doc-sync', t: 'writer', m: 'claude-sonnet-5-5', e: 'medium', ago: 2280000, ran: 668000,
      tool: 'Write', last: 'Landed. Section written, 12 symbols cross-checked against the write journal.',
      brief: 'Document the sync subsystem.' },
    { n: 'doc-config', t: 'writer', m: 'claude-sonnet-5-5', e: 'medium', ago: 2280000, ran: 586000,
      tool: 'Bash', last: 'File is untracked (new doc, not previously committed) — expected, no diff to show.',
      brief: 'Write the configuration reference.' },
    { n: 'doc-session', t: 'writer', m: 'claude-sonnet-5-5', e: 'medium', ago: 2280000, ran: 712000,
      tool: 'Read', last: 'Resumption and reconciliation both documented; three open questions listed at the end.',
      brief: 'Document session resumption against the clock tick.' },
    { n: 'rv-pool', t: 'reviewer', m: 'claude-opus-5-5', e: 'high', ago: 4100000, ran: 1491000, stopped: true,
      tool: 'Grep', last: 'Two real defects, one of them a lifetime bug in the lease pool. Details inline.',
      brief: 'Review the connection pool refactor.' },
    { n: 'rv-scheduler2', t: 'reviewer', m: 'claude-opus-5-5', e: 'high', ago: 4180000, ran: 1502000,
      tool: 'Read', last: 'No defects that survive verification. One nit about an unused parameter.',
      brief: 'Second pass over the retry scheduler.' },
    { n: 'bench-parse', t: 'tester', m: 'claude-sonnet-5-5', e: 'medium', ago: 5900000, ran: 402000,
      tool: 'Bash', last: 'small 8.64ms -> 7.01ms; large 280ms -> 255ms; streaming not run.',
      brief: 'A/B the parse cost of the new fast path.' },
    { n: 'ed-rename', t: 'editor', m: 'claude-haiku-4-5', e: 'low', ago: 6100000, ran: 41000, stopped: true,
      tool: 'Edit', last: 'Renamed in 4 files. Build clean.',
      brief: 'Rename retry_cfg to backoff_cfg throughout.' },
    { n: 'rd-buffers', t: 'reader', m: 'claude-sonnet-5-5', e: 'medium', ago: 7300000, ran: 903000,
      tool: 'Read', last: 'Buffers are allocated per-request from a ring; the pool is never reset mid-request.',
      brief: 'Read the buffer allocation path.' },
    { n: 'rd-index', t: 'reader', m: 'claude-sonnet-5-5', e: 'medium', ago: 7400000, ran: 1120000,
      tool: 'Bash', last: 'The index is rebuilt on every schema edit. That is the stall.',
      brief: 'Read the index build path and find the stall.' },
    { n: 'wk-cache', t: 'worker', m: 'claude-opus-5-5', e: 'high', ago: 9200000, ran: 2410000,
      tool: 'Bash', last: 'Landed on a worktree, tests green, 3 commits. Stopped once and resumed.',
      brief: 'Implement the result cache.' },
    { n: 'wk-ui-rail', t: 'worker', m: 'claude-opus-5-5', e: 'high', ago: 9600000, ran: 1880000,
      tool: 'Write', last: 'Done. The rail now measures the gutter instead of assuming it.',
      brief: 'Rework the rail positioning to be sidebar-aware.' },
];

const MOCK_SCRIPT = [
    { k: 'user', p: [{ t: 'text', text: 'Read the retry scheduler and review the rewrite against the reference implementation. Report defects with file:line.' }] },
    { k: 'assistant', p: [{ t: 'text', text: 'Starting from the scheduler entry point and following the call chain out.' },
                          { t: 'tool', name: 'Read', input: 'file_path: src/net/scheduler_retry.cpp' }] },
    { k: 'user', p: [{ t: 'result', text: [
        '     1  #include "scheduler_retry.h"',
        '     2  #include "lease_pool.h"',
        '     3  #include "trace.h"',
        '     4',
        '     5  #define RETRY_ITERS 8',
        '     6',
        '     7  void run_retry_batch(retry_batch_t *b, float dt)',
        '     8  {',
        '     9      TRACE_SCOPE("retry");',
        '    10      const float inv_dt = 1.0f / dt;',
        '    11',
        '    12      for (uint32_t i = 0; i < b->count; ++i)',
        '    13      {',
        '    14          retry_t *j = &b->retries[i];',
        '    15          lease_t *a = lease_from_handle(j->a);',
        '    16          lease_t *c = lease_from_handle(j->b);',
        '    17          if (!a || !c) continue;',
        '    18',
        '    19          for (int it = 0; it < RETRY_ITERS; ++it)',
        '    20              retry_one(j, a, c, inv_dt);',
        '    21      }',
        '    22  }',
    ].join(NLC) }] },
    { k: 'assistant', p: [{ t: 'tool', name: 'Grep', input: 'pattern: run_retry_batch, output_mode: content' }] },
    { k: 'user', p: [{ t: 'result', text: 'src/net/tick.cpp:214:    run_retry_batch(&g_retries, dt);\nsrc/net/tick.cpp:281:    run_retry_batch(&g_retries_soft, dt * 0.5f);' }] },
    { k: 'assistant', p: [{ t: 'text', text: 'Two call sites, and the second halves `dt` without halving the iteration count. That is the first thing to check against the reference.' },
                          { t: 'tool', name: 'Bash', input: 'python tools/xref.py run_retry_batch' }] },
    { k: 'user', p: [{ t: 'result', text: 'run_retry_batch\n  called from tick (src/net/tick.cpp:214)\n  called from tick_soft (src/net/tick.cpp:281)' }] },
    { k: 'gap', ms: 252000 },
    { k: 'assistant', p: [{ t: 'text', text: 'Resumed. Picking up at the soft-retry path.' },
                          { t: 'tool', name: 'Read', input: 'file_path: src/net/retry_soft.cpp, offset: 180, limit: 60' }] },
    { k: 'user', p: [{ t: 'result', text: '  180      const float inv_dt = 1.0f / dt;\n  181      // NOTE: iterations tuned for 60hz\n  182      for (int it = 0; it < RETRY_ITERS; ++it)' }] },
    { k: 'assistant', p: [{ t: 'text', text: 'Confirmed: `RETRY_ITERS` is a compile-time constant, so the halved `dt` at `src/net/tick.cpp:281` doubles the effective retry pressure instead of holding it. The reference scales iterations with dt.' },
                          { t: 'tool', name: 'Bash', input: 'git log -S RETRY_ITERS --oneline -- src/net' }] },
    { k: 'user', p: [{ t: 'result', text: 'a41c9de  net: tune retry iterations for 60hz\n7b2210f  net: initial soft retry pass' }] },
    { k: 'assistant', p: [{ t: 'text', text: 'One defect, confirmed against both the source and the reference trace. Writing it up.' },
                          { t: 'tool', name: 'Write', input: 'file_path: reports/retry-scheduler-review.md' }] },
    { k: 'user', p: [{ t: 'result', text: 'File written (2,417 bytes).' }] },
    { k: 'assistant', p: [{ t: 'text', text: '**One real defect.** `src/net/tick.cpp:281` halves `dt` without scaling `RETRY_ITERS`, which doubles effective retry pressure on the soft-retry pass. The reference implementation scales iterations with dt.' + NLC + NLC + 'Everything else in the rewrite matches the reference, including the warm-start path I expected to differ.' }] },
];

function mockList() {
    const now = Date.now();
    return MOCK.map((m, i) => {
        const active = i < MOCK_LIVE;
        const s = MOCK_T0 - m.ago;
        const e = active ? now : s + m.ran;
        return {
            agentId: 'mock-' + i, name: m.n, type: m.t, model: m.m, effort: m.e,
            file: '', size: 0,
            spawnedAt: new Date(s).toISOString(),
            startedAt: new Date(s).toISOString(),
            lastAt: new Date(e).toISOString(),
            lastTool: m.tool, lastText: m.last, brief: m.brief, active,
            description: m.d || null,
            parentAgentId: i === 1 ? 'mock-0' : (i === 2 ? 'mock-1' : null),
            depth: i < MOCK_LIVE ? i + 1 : 1,
            state: active ? 'inflight' : (m.stopped ? 'stopped' : 'done'),
        };
    });
}
function mockDetail(id) {
    const i = Number(String(id).split('-')[1]) || 0;
    const m = MOCK[i] || MOCK[0];
    const active = i < MOCK_LIVE;
    const s = MOCK_T0 - m.ago;
    // A running agent's transcript grows, which is what makes the live tail and
    // the append-only turn rendering worth looking at.
    const grow = active ? Math.floor((Date.now() - MOCK_T0) / 5000) : 0;
    // Each running demo agent sits at a different point in the script, or all
    // three read as one agent rendered three times.
    const n = active
        ? Math.max(3, Math.min(MOCK_SCRIPT.length, 4 + grow + i * 3))
        : MOCK_SCRIPT.length;
    const turns = [];
    const tools = {};
    for (let k = 0; k < n; k++) {
        const t = MOCK_SCRIPT[k];
        if (t.k === 'gap') { turns.push({ kind: 'gap', ms: t.ms }); continue; }
        for (const p of t.p) if (p.t === 'tool') tools[p.name] = (tools[p.name] || 0) + 1;
        turns.push({ kind: t.k, at: new Date(s + k * 47000).toISOString(), parts: t.p });
    }
    return {
        ok: true, lines: n, dropped: 0,
        tokens: { out: 4200 + n * 731, cacheRead: 1000 * (820 + n * 96) },
        tools, turns,
    };
}
// The same agents' side of the conversation: the assignment, one exchange for
// the first of them, and the report for every one that has finished.
function mockThread(id) {
    const i = Number(String(id).split('-')[1]) || 0;
    const m = MOCK[i] || MOCK[0];
    const s = MOCK_T0 - m.ago;
    const at = (ms) => new Date(s + ms).toISOString();
    const messages = [{ id: id + '-brief', kind: 'brief', dir: 'parent', text: m.brief, at: at(0), status: 'sent' }];
    if (i === 0) messages.push(
        { id: id + '-m1', kind: 'message', dir: 'child', at: at(141000), status: 'delivered',
          text: 'Two call sites for `run_retry_batch`. The soft-body one at `src/net/tick.cpp:281` halves `dt` and keeps `RETRY_ITERS`. Checking the reference before I call it a defect.' },
        { id: id + '-m2', kind: 'message', dir: 'parent', at: at(188000), status: 'delivered',
          text: 'Good. Confirm it against the binary, and check whether the warm-start path compensates before reporting.' });
    if (i >= MOCK_LIVE) messages.push({ id: id + '-report', kind: 'report', dir: 'child', text: m.last, at: at(m.ran), status: 'completed' });
    const parent = i === 1 ? MOCK[0].n : (i === 2 ? MOCK[1].n : 'main');
    return { ok: true, messages, total: messages.length, earlier: 0, parentName: parent };
}

const MOCK_DEFS = {
    reviewer: { name: 'reviewer', model: 'claude-opus-5-5', effort: 'medium', description: 'Cross-review lane. Reviews another agent’s landed work for real defects with full coverage, reports every finding with confidence and severity attached, and never fixes.' },
    reader: { name: 'reader', model: 'claude-sonnet-5-5', effort: 'medium', description: 'Exhaustive code reader. Reads the prescribed files in full and follows the dependency chain until zero assumptions remain. Read-only.' },
    writer: { name: 'writer', model: 'claude-opus-5-5', effort: 'medium', description: 'Implementation lane at medium effort. Carries a self-contained brief through build, verification and landing.' },
    worker: { name: 'worker', model: 'claude-opus-5-5', effort: 'high', description: 'Implementation lane worker for orchestrated dispatch, on its own worktree.' },
    tester: { name: 'tester', model: 'claude-opus-5-5', effort: 'medium', description: 'Measurement lane. Produces numbers with their conditions attached, and never implements the optimisation it measures.' },
    editor: { name: 'editor', model: 'claude-sonnet-5-5', effort: 'high', description: 'Small scoped tasks at minimal spend. Literal scope, no design risk.' },
};

// ------------------------------------------------------------------ anchors
function transcriptRegion() {
    return document.querySelector('[data-epitaxy-transcript-region]')
        || document.querySelector('.epitaxy-transcript-typography')
        || document.querySelector('.epitaxy-root');
}
// The composer's box is the transcript's own measure, and its left edge is the
// right wall of the gutter the rail lives in. `.epitaxy-composer-width` was that
// box until the build the app serves from claude.ai dropped it; `.epitaxy-prompt`
// is the same measure and is still there, so it is the fallback.
function composerRect() {
    let best = null;
    for (const sel of ['.epitaxy-composer-width', '.epitaxy-prompt']) {
        for (const n of document.querySelectorAll(sel)) {
            const r = n.getBoundingClientRect();
            if (r.width > 200 && (!best || r.bottom > best.bottom)) best = r;
        }
        if (best) return best;
    }
    return best;
}
// The desktop shell's session sidebar. Collapsible, so anything that is not a
// tall left-anchored panel is treated as "no sidebar".
function sidebarRect() {
    for (const n of document.querySelectorAll('.dframe-sidebar, aside, nav')) {
        const r = n.getBoundingClientRect();
        if (r.left > 2 || r.width < 100 || r.width > innerWidth * 0.5) continue;
        if (r.height < innerHeight * 0.5) continue;
        return r;
    }
    return null;
}
function columnWidth() {
    const r = composerRect();
    return r ? Math.round(r.width) : MEASURE_FALLBACK;
}

// ------------------------------------------------------------------ styles
const CSS = () => `
:host { all: initial; }
* { box-sizing: border-box; font-family: var(--font-ui, ui-sans-serif, system-ui, sans-serif); }

.wrap {
    position: fixed; inset: 0; pointer-events: none;
    --acc: ${V.accent};
    --d1: ${MS(120)}ms; --d2: ${MS(200)}ms; --d3: ${MS(320)}ms;
    --e-out: cubic-bezier(.2,.85,.3,1);
    --e-in: cubic-bezier(.5,0,.9,.4);
    --fg: hsl(var(--text-100, 60 14% 97%));
    --fg2: hsl(var(--text-300, 55 9% 74%));
    --fg3: hsl(var(--text-500, 48 5% 57%));
    --bg: hsl(var(--bg-100, 0 0% 8%));
    --bg2: hsl(var(--bg-200, 0 0% 6.7%));
    --hair: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 9%, transparent);
    --hair2: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 5%, transparent);
    --wash: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
    --accw: color-mix(in srgb, var(--acc) 16%, transparent);
    /* 30px is deliberately taller than a ghost row (~24px), so a row caught by
       the edge is gone rather than dimmed. The intermediate stops approximate
       an ease-out ramp; the alpha values are the mask, not a colour. */
    --fadeT: linear-gradient(to bottom, transparent 0,
        rgba(0,0,0,.28) 9px, rgba(0,0,0,.72) 19px, #000 30px);
    --fadeB: linear-gradient(to bottom, #000 calc(100% - 30px),
        rgba(0,0,0,.72) calc(100% - 19px), rgba(0,0,0,.28) calc(100% - 9px), transparent 100%);
    --fadeTB: linear-gradient(to bottom, transparent 0,
        rgba(0,0,0,.28) 9px, rgba(0,0,0,.72) 19px, #000 30px,
        #000 calc(100% - 30px),
        rgba(0,0,0,.72) calc(100% - 19px), rgba(0,0,0,.28) calc(100% - 9px), transparent 100%);
    font-size: ${V.size}px;
    color: var(--fg2);
}

/* =============================================================== the rail === */
/* A HUD, not a panel: no card, no border, no shadow. It floats on the app's own
 * background in the gutter the task rail occupies at the bottom, and its top
 * edge is the top of the transcript region — which is to say, under the chat's
 * own title rather than pinned to the corner of the window. */
.rail {
    position: fixed; pointer-events: auto;
    display: flex; flex-direction: column;
    opacity: 1;
    animation: railIn var(--d3) var(--e-out);
}
.rail.leaving { animation: railOut var(--d2) var(--e-in) both; }
@keyframes railIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: none; } }
@keyframes railOut { to { opacity: 0; transform: translateY(-4px); } }

.cap {
    flex: 0 0 auto; display: flex; align-items: center; gap: 7px;
    padding: 0 5px 8px;
    font-size: .68em; letter-spacing: .17em; text-transform: uppercase;
    color: var(--fg3); opacity: .6;
}
.cap .n { color: var(--acc); opacity: .95; font-variant-numeric: tabular-nums; }
.cap .sp { flex: 1 1 auto; }
.cap .demo { letter-spacing: .12em; opacity: .8; }

/* overflow-x is not optional here, and neither is the padding.
 *
 * Setting overflow-y alone leaves overflow-x as visible, which per CSS
 * Overflow 3 computes to auto the moment the other axis scrolls. Scrollable
 * overflow is measured after transforms, so the translateX(2px) on .row:hover
 * is 2px of horizontal overflow — and the horizontal scrollbar's thickness
 * comes from ::-webkit-scrollbar's height, which was never set, so it came at
 * the platform default with a full-width thumb. Hovering any row, in a list of
 * any length, drew a 15px filled bar across the bottom of the rail.
 *
 * hidden kills it. The 2px of padding is where the hover shift now lives: the
 * overflow clip box is the padding box, so the row slides into it instead of
 * having its right edge shaved off. */
.rbody {
    flex: 1 1 auto; min-height: 0;
    overflow-y: auto; overflow-x: hidden; padding-right: 2px;
    overscroll-behavior: contain;
    scrollbar-color: auto;
}
/* Fogged edges, and only the edge that actually has something behind it.
 *
 * Three things were wrong with a single always-on bottom mask. It fades the
 * last row of a list that fits, for no reason. It leaves a hard cut at the top
 * the moment you scroll. And 22px is shorter than a row, so the half-row it
 * was meant to hide still shows its top band at full strength — which on hover
 * picks up the row wash and reads as a filled bar sitting under the list
 * rather than as an edge.
 *
 * The ramp is eased rather than linear: a linear alpha ramp has a visible
 * corner where it leaves full opacity, and that corner is the line that made
 * the old fade look like a border. */
.rbody.clipT {
    -webkit-mask-image: var(--fadeT);
    mask-image: var(--fadeT);
}
.rbody.clipB {
    -webkit-mask-image: var(--fadeB);
    mask-image: var(--fadeB);
}
.rbody.clipT.clipB {
    -webkit-mask-image: var(--fadeTB);
    mask-image: var(--fadeTB);
}
.rbody::-webkit-scrollbar { width: 2px; height: 2px; }
.rbody::-webkit-scrollbar-track { background: transparent; }
.rbody::-webkit-scrollbar-thumb { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 18%, transparent); }

/* ---- a row ---- */
.row {
    --tree-indent: 0px; --tree-guide: 9px;
    position: relative; display: grid; grid-template-columns: 7px 1fr auto;
    gap: 8px; align-items: baseline;
    margin-left: var(--tree-indent);
    padding: 4px 5px 5px; border-radius: 7px; cursor: pointer;
    animation: rowIn var(--d2) var(--e-out);
    transition: background var(--d1) linear, opacity var(--d2) var(--e-out),
                transform var(--d1) var(--e-out);
}
.row.child::before {
    content: ''; position: absolute; left: calc(var(--tree-guide) * -1); top: -4px;
    width: max(2px, calc(var(--tree-guide) - 2px)); height: 14px;
    border-left: 1px solid var(--hair); border-bottom: 1px solid var(--hair);
    border-bottom-left-radius: 3px; opacity: .8; pointer-events: none;
}
.row:hover { transform: translateX(2px); }
.row.live:hover .dot { box-shadow: 0 0 12px color-mix(in srgb, var(--acc) 85%, transparent); }
@keyframes rowIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.row:hover { background: var(--wash); }
.row.sel { background: var(--accw); }

.row .dot {
    width: 5px; height: 5px; border-radius: 50%; align-self: start; margin-top: 5px;
    background: currentColor; opacity: .4;
}
.row.live .dot {
    background: var(--acc); opacity: 1;
    box-shadow: 0 0 7px color-mix(in srgb, var(--acc) 70%, transparent);
    animation: breathe 2.1s ease-in-out infinite;
}
@keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .38; } }

.row .mid { min-width: 0; }
.row .nm {
    font-size: .92em; font-weight: 500; color: var(--fg2); line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.row.live .nm { font-weight: 600; color: var(--fg); }
.row:hover .nm, .row.sel .nm { color: var(--fg); }
.row .when {
    font-size: .74em; font-variant-numeric: tabular-nums; color: var(--fg3); white-space: nowrap;
}
.row.live .when { color: var(--acc); }

.row .slot { grid-column: 1 / -1; min-width: 0; padding-left: 15px; }
.row .doing {
    margin-top: 3px; font-size: .7em; font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--fg3); display: flex; gap: 6px; align-items: baseline;
}
.row .doing b { color: color-mix(in srgb, var(--acc) 74%, var(--fg)); font-weight: 600; flex: 0 0 auto; }
.row .doing span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* the travelling line under a running row: the one piece of motion that means
   "still going" without pretending to know how far along it is */
.row .bar { margin: 6px 5px 0 0; height: 1px; background: var(--hair2); overflow: hidden; }
.row .bar i { display: block; height: 100%; width: 30%;
    background: linear-gradient(90deg, transparent, var(--acc), transparent);
    animation: sweep 2.6s var(--e-out) infinite; }
@keyframes sweep { from { transform: translateX(-110%); } to { transform: translateX(400%); } }

/* ---- stopping without opening the agent ----
 *
 * The duration cell is the control. It is the number that makes you want to
 * stop an agent in the first place, so the cell holding the reason is the cell
 * holding the remedy — and it costs the row no width, which at RAIL_MIN there
 * is none of to spend. The colours are the sheet's own .act.danger:hover and
 * .act.armed, unchanged, so arming reads as one gesture in both places.
 *
 * The button is out of flow, so a label wider than the duration would sit on
 * top of the name. .live .rt reserves the width instead of growing on hover,
 * because a cell that resizes under the cursor is the thing this layout was
 * chosen to avoid. */
.row .rt { position: relative; text-align: right; }
.row.live .rt { min-width: 44px; }
.row .when { transition: opacity var(--d1) linear; }
.row.live:hover .when, .row.live.arm .when { opacity: 0; }
.row .kstop {
    all: unset; box-sizing: border-box;
    position: absolute; right: 0; top: 50%; transform: translateY(-50%);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: .68em; letter-spacing: .11em; text-transform: uppercase;
    color: var(--fg3); cursor: pointer; white-space: nowrap;
    padding: 2px 7px; border-radius: 999px; border: 1px solid transparent;
    opacity: 0; pointer-events: none;
    transition: color var(--d1) linear, background var(--d1) linear,
                border-color var(--d1) linear, opacity var(--d1) linear;
}
.row.live:hover .kstop, .row .kstop:focus-visible { opacity: 1; pointer-events: auto; }
.row .kstop:hover { color: #e58b83; background: color-mix(in srgb, #e58b83 13%, transparent); }
.row .kstop:focus-visible { outline: 1px solid #e58b83; outline-offset: 1px; }
.row .kstop.armed {
    opacity: 1; pointer-events: auto; color: #e58b83;
    border-color: color-mix(in srgb, #e58b83 40%, transparent);
}

/* ---- ghosts: finished agents, present but not competing for attention ---- */
.row.ghost { opacity: .3; padding-top: 2px; padding-bottom: 2px; }
/* Stopped is not the same as finished, and it is the one a reader wants to
   spot: the agent never got to say what it found. */
.row.halt .dot { border-radius: 1px; height: 2px; width: 7px; margin-top: 7px; opacity: .75; }
.row.ghost:hover { opacity: .9; }
.row.ghost .nm { font-weight: 400; font-size: .86em; }
.row.ghost .when { font-size: .7em; }
.ghosts { margin-top: 10px; }

.more {
    margin: 5px 5px 0; font-size: .7em; letter-spacing: .1em; text-transform: uppercase;
    color: var(--fg3); opacity: .45; padding: 4px 0; cursor: pointer;
    transition: opacity var(--d1) linear;
}
.more:hover { opacity: .95; }
.rempty { padding: 10px 5px; font-size: .74em; color: var(--fg3); opacity: .5; line-height: 1.6; }

/* The app's composer and footer keep rendering under the sheet, which reads as
 * the agent view being a widget dropped on top of the chat rather than a place
 * you went. They are dimmed by a scrim of our own rather than by restyling
 * React-owned nodes: nothing of the app's is touched, no other plugin's
 * transitions are fought over, and clicking it is the way back. */
.scrim {
    position: fixed; pointer-events: auto; cursor: default;
    background: var(--bg);
    opacity: 0; animation: scrimIn var(--d3) var(--e-out) forwards;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 26px);
    mask-image: linear-gradient(to bottom, transparent, #000 26px);
}
.scrim.leaving { animation: scrimOut var(--d2) var(--e-in) forwards; }
@keyframes scrimIn { to { opacity: .93; } }
@keyframes scrimOut { from { opacity: .93; } to { opacity: 0; } }

/* ============================================================== the sheet === */
.sheet {
    position: fixed; pointer-events: auto; overflow-y: auto; scrollbar-gutter: stable;
    scrollbar-color: auto;
    opacity: 1; background: var(--bg);
}
.sheet::-webkit-scrollbar { width: 11px; }
.sheet::-webkit-scrollbar-track { background: transparent; }
.sheet::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 16%, transparent);
    border-radius: 7px; border: 3px solid transparent; background-clip: padding-box;
}
.sheet::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 26%, transparent);
    background-clip: padding-box;
}
.sheet.leaving { animation: sheetOut var(--d2) var(--e-in) both; }
@keyframes sheetOut { to { opacity: 0; } }
.inner { opacity: 1; animation: innerIn var(--d3) var(--e-out); }
@keyframes innerIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* Fixed. The header does not respond to scrolling at all: same height, same
   controls, same type, top of the transcript or the bottom of it.
   Two consequences worth stating, because both were previously bought by the
   collapse and now have to be paid for outright:
   - The background is opaque, not a gradient to transparent. Content scrolls
     underneath a pinned header, and it ghosted through the transparent part.
   - The hairline is permanent. It is the only thing separating the header from
     text moving under it, which the gradient used to imply. */
.shd {
    position: sticky; top: 0; z-index: 2;
    background: var(--bg);
    padding: 14px 0 14px;
    box-shadow: 0 1px 0 var(--hair2);
}
.shd .in { width: var(--col); max-width: calc(100% - 32px); margin: 0 auto; }
.crumb {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    font-size: .7em; letter-spacing: .12em; text-transform: uppercase; color: var(--fg3);
    padding: 4px 8px 4px 4px; border-radius: 7px; margin-left: -4px;
    transition: color var(--d1) linear, background var(--d1) linear;
}
.crumb:hover { color: var(--fg); background: var(--wash); }
.crumb svg { width: 12px; height: 12px; transition: transform var(--d1) var(--e-out); }
.crumb:hover svg { transform: translateX(-2px); }

.title { display: flex; align-items: center; gap: 11px; margin-top: 5px; }
.title h2 {
    margin: 0; font-size: 1.55em; font-weight: 600; letter-spacing: -.015em; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.title .badge {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px;
    font-size: .64em; letter-spacing: .11em; text-transform: uppercase;
    color: var(--acc); background: var(--accw); padding: 3px 9px; border-radius: 999px;
}
.title .badge i { width: 5px; height: 5px; border-radius: 50%; background: var(--acc);
                  animation: breathe 2.1s ease-in-out infinite; }
.title .badge.halt { color: var(--fg3); background: var(--wash); }
.title .badge.halt i { background: currentColor; border-radius: 1px; height: 2px; width: 7px; animation: none; }
.title .sp { flex: 1 1 auto; }

/* Controls ride the title line. A separate row for them left a band of dead
   space across the top of every agent. */
.acts { display: flex; gap: 2px; flex: 0 0 auto; }
.act {
    font-size: .74em; color: var(--fg3); cursor: pointer; user-select: none;
    padding: 5px 9px; border-radius: 7px; white-space: nowrap;
    border: 1px solid transparent;
    transition: color var(--d1) linear, background var(--d1) linear, border-color var(--d1) linear;
}
.act:hover { color: var(--fg); background: var(--wash); }
.act.danger:hover { color: #e58b83; background: color-mix(in srgb, #e58b83 13%, transparent); }
.act.armed { color: #e58b83; border-color: color-mix(in srgb, #e58b83 40%, transparent); }

.subline {
    margin-top: 7px; font-size: .78em; color: var(--fg3);
    display: flex; gap: 9px; flex-wrap: wrap; align-items: baseline;
}
.subline > span { display: inline-flex; gap: 5px; }
.subline > span + span::before { content: '·'; opacity: .45; margin-right: 4px; }
.subline b { color: var(--fg2); font-weight: 500; }
.subline .pin { opacity: .75; font-variant-numeric: tabular-nums; }

.grid {
    width: var(--col); max-width: calc(100% - 32px); margin: 0 auto;
    display: grid; grid-template-columns: minmax(0, 1fr); gap: 30px; padding-bottom: 90px;
}
.wide .grid { grid-template-columns: minmax(0, 1fr) 208px; }

.side { display: none; }
.wide .side { display: block; align-self: start; position: sticky; top: 128px; }
.card {
    border-top: 1px solid var(--hair); padding-top: 11px; margin-bottom: 20px;
    animation: blkIn var(--d3) var(--e-out) backwards;
}
.card:nth-child(2) { animation-delay: 70ms; }
.card:nth-child(3) { animation-delay: 140ms; }
.card > h3 {
    margin: 0 0 9px; font-size: .66em; font-weight: 600; letter-spacing: .14em;
    text-transform: uppercase; color: var(--fg3);
}
.kv { display: flex; flex-direction: column; gap: 6px; font-size: .78em; }
.kv > div { display: flex; justify-content: space-between; gap: 10px; }
.kv .k { color: var(--fg3); }
.kv .v { color: var(--fg2); font-variant-numeric: tabular-nums; text-align: right;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist { display: flex; flex-direction: column; gap: 5px; font-size: .76em; }
.hist > div { display: grid; grid-template-columns: 62px 1fr 24px; gap: 7px; align-items: center; }
.hist .hn { color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist .hb { height: 4px; border-radius: 2px; background: var(--hair2); overflow: hidden; }
.hist .hb i { display: block; height: 100%; border-radius: 2px;
              background: color-mix(in srgb, var(--acc) 62%, transparent); }
.hist .hv { color: var(--fg3); font-variant-numeric: tabular-nums; text-align: right; }
.defbox { font-size: .78em; color: var(--fg3); line-height: 1.6; }

.brief {
    border-left: 2px solid var(--acc); padding: 3px 0 3px 14px; margin-bottom: 6px;
    color: var(--fg2); line-height: 1.6; font-size: 1.02em;
}

.tail {
    margin: 16px 0 4px; border-radius: 9px; overflow: hidden; border: 1px solid var(--hair2);
    background: var(--bg2);
}
.tail .tl {
    display: flex; align-items: baseline; gap: 8px; padding: 4px 11px;
    font-size: .76em; font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--fg3); white-space: nowrap; overflow: hidden;
}
.tail .tl span { overflow: hidden; text-overflow: ellipsis; }
.tail .tl b { color: color-mix(in srgb, var(--acc) 80%, var(--fg)); font-weight: 600; flex: 0 0 auto; }
.tail .tl.now { color: var(--fg2); }
.tail .tl.now::after {
    content: ''; width: 6px; height: .95em; background: var(--acc); flex: 0 0 auto;
    animation: blink 1.1s steps(2, end) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

/* ---- the transcript ----
 * A tool call and its result are one thing, so they are drawn as one thing. The
 * CLI writes them as two consecutive turns (assistant tool_use, then a user
 * turn carrying only tool_result), which is why the first cut labelled every
 * command's output "INPUT". */
.turns { margin-top: 20px; }
/* Only the first screenful of blocks is staggered, and only on the pass that
   creates them. The backwards fill holds the start frame through the delay and
   leaves the resting state alone, so nothing depends on the animation clock. */
.blk.in { animation: blkIn var(--d3) var(--e-out) backwards; animation-delay: calc(var(--i) * 26ms); }
@keyframes blkIn { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }
.blk { padding: 15px 0; }
.blk + .blk { border-top: 1px solid var(--hair2); }
.blk .who {
    display: flex; align-items: center; gap: 10px; margin-bottom: 8px;
    font-size: .66em; letter-spacing: .14em; text-transform: uppercase; color: var(--fg3);
}
.blk .who .rule { flex: 1 1 auto; height: 1px; background: var(--hair2); }
.blk .who .at { font-variant-numeric: tabular-nums; opacity: .7; letter-spacing: .06em; }
.blk.assistant .who .role { color: color-mix(in srgb, var(--acc) 62%, var(--fg2)); }

.txt { white-space: pre-wrap; line-height: 1.68; color: var(--fg2); overflow-wrap: anywhere; }
.blk.assistant .txt { color: var(--fg); }
.txt + .txt { margin-top: 9px; }
.txt code {
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .88em;
    background: var(--wash); padding: 1px 5px; border-radius: 4px;
    color: color-mix(in srgb, var(--acc) 34%, var(--fg)); white-space: pre-wrap;
}
.txt strong { color: var(--fg); font-weight: 600; }
.txt.think { color: var(--fg3); font-style: italic; border-left: 2px solid var(--hair); padding-left: 11px; }

/* ---- a call: the invocation and whatever came back ---- */
.call {
    margin: 10px 0; border: 1px solid var(--hair2); border-radius: 9px; overflow: hidden;
    background: var(--bg2);
}
.call + .call { margin-top: 8px; }
.chead {
    display: flex; align-items: baseline; gap: 9px; padding: 7px 11px;
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .8em;
    color: var(--fg2); overflow-wrap: anywhere;
}
.chead b { color: color-mix(in srgb, var(--acc) 82%, var(--fg)); font-weight: 600; flex: 0 0 auto; }
.chead .args { color: var(--fg3); min-width: 0; }
.chead .args em { font-style: normal; color: var(--fg3); opacity: .7; }
.cout {
    position: relative; border-top: 1px solid var(--hair2);
    max-height: 176px; overflow: hidden; cursor: pointer;
}
.cout .fade { transition: color var(--d1) linear, opacity var(--d2) var(--e-out); }
.cout.open { max-height: none; cursor: default; }
.cout pre {
    margin: 0; padding: 8px 11px; font-family: var(--font-mono, ui-monospace, monospace);
    font-size: .76em; line-height: 1.55; color: var(--fg3);
    white-space: pre; overflow-x: auto; scrollbar-color: auto;
}
.cout pre::-webkit-scrollbar { height: 4px; }
.cout pre::-webkit-scrollbar-thumb { background: var(--hair); border-radius: 2px; }
.cout.err pre { color: #e58b83; }
.cout .fade {
    position: absolute; left: 0; right: 0; bottom: 0; height: 46px; pointer-events: none;
    display: flex; align-items: flex-end; justify-content: center; padding-bottom: 5px;
    background: linear-gradient(transparent, var(--bg2) 72%);
    font-size: .64em; letter-spacing: .12em; text-transform: uppercase; color: var(--fg3);
}
.cout.open .fade { display: none; }
.cout:hover .fade { color: var(--fg2); }

.seam {
    display: flex; align-items: center; gap: 10px; margin: 18px 0;
    font-size: .68em; letter-spacing: .12em; text-transform: uppercase; color: var(--fg3);
}
.seam::before, .seam::after { content: ''; height: 1px; flex: 1 1 auto; background: var(--hair2); }
.empty { padding: 40px 0; text-align: center; color: var(--fg3); line-height: 1.8; }

/* ================================================================ the chat === */
/* Drawn the way the app draws its own conversation, because that is the chat
 * the reader already knows how to read. The parent is the child's user, so its
 * messages are the app's UserMessage bubble, on the right and at most 85% of
 * the column; the child answers in unboxed text on the left, as Claude does.
 *
 * The bubble's numbers are the app's own, read from ion-dist 2.7032.0:
 * bg-[var(--cds-bg-user-message)] rounded-card px-lg py-md, where the fill is
 * --cds-alpha-1 (neutral-900 at 5%), rounded-card is --cds-radius + .25rem,
 * and every length is scaled by --cds-rem-scale = 16/17. Those tokens live on
 * .cds-root, which this host is not inside, so the fill is read off .cds-root
 * when the chat is built (--ubub) and otherwise derived the same way the rest of
 * this sheet derives its washes: the text colour at 5%.
 *
 * A sibling of the sheet, not a child. The sheet is the scroll container and
 * the chat must stay put while the transcript scrolls; place() pins it to the
 * gutter between the sheet's left edge and the transcript column. */
.chat {
    position: fixed; pointer-events: auto; display: flex; flex-direction: column;
    animation: chatIn var(--d3) var(--e-out) backwards; animation-delay: 90ms;
}
.chat.leaving { animation: chatOut var(--d2) var(--e-in) forwards; }
@keyframes chatIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes chatOut { to { opacity: 0; } }
.chat .cbody {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
    overscroll-behavior: contain; scrollbar-color: auto; padding: 22px 6px 40px 0;
}
.chat .cbody.clipT { -webkit-mask-image: var(--fadeT); mask-image: var(--fadeT); }
.chat .cbody.clipB { -webkit-mask-image: var(--fadeB); mask-image: var(--fadeB); }
.chat .cbody.clipT.clipB { -webkit-mask-image: var(--fadeTB); mask-image: var(--fadeTB); }
.chat .cbody::-webkit-scrollbar { width: 3px; height: 3px; }
.chat .cbody::-webkit-scrollbar-track { background: transparent; }
.chat .cbody::-webkit-scrollbar-thumb { background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 14%, transparent); border-radius: 2px; }
.chat .earlier {
    display: block; margin: 0 auto 18px; font-size: .7em; letter-spacing: .1em;
    text-transform: uppercase; color: var(--fg3); opacity: .6; cursor: pointer;
    padding: 4px 8px; border-radius: 7px; transition: opacity var(--d1) linear, background var(--d1) linear;
}
.chat .earlier:hover { opacity: 1; background: var(--wash); }

.msg { display: flex; flex-direction: column; min-width: 0; }
.msg + .msg { margin-top: 20px; }
.msg.parent { align-items: flex-end; }
.msg .mwho {
    display: flex; gap: 7px; align-items: baseline; margin: 0 2px 6px;
    font-size: .74em; color: var(--fg3); white-space: nowrap; max-width: 100%;
}
.msg .mwho b { font-weight: 500; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; }
.msg .mwho .at { font-variant-numeric: tabular-nums; opacity: .8; }
.msg .mwho .flag { color: #e58b83; }
.msg .mwho .tag { letter-spacing: .1em; text-transform: uppercase; font-size: .9em; }
.msg.child .mwho .tag { color: color-mix(in srgb, var(--acc) 62%, var(--fg2)); }
/* Agent-to-agent messages are status reports packed into one paragraph. The
   treatment below is mechanical, not a rewrite: the lead sentence carries the
   message and is the one bright line; every further sentence starts its own
   line in the secondary colour; long parenthetical asides step back a level;
   paths, commits and file names become short monospace tokens. */
.msg .mtext {
    position: relative; min-width: 0; max-width: 100%;
    line-height: 1.55; color: var(--fg2); overflow-wrap: anywhere;
}
.msg .mtext .s { display: block; }
.msg .mtext .s + .s { margin-top: 5px; }
.msg .mtext .s.lead { color: var(--fg); font-weight: 500; }
.msg .mtext .aside { color: var(--fg3); }
.msg .mtext .enum { display: block; padding-left: 20px; position: relative; margin-top: 4px; }
.msg .mtext .enum > i {
    position: absolute; left: 0; font-style: normal; color: var(--fg3);
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .82em;
}
.msg .mtext .tok {
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .84em;
    color: var(--fg2); background: var(--wash); padding: 0 4px; border-radius: 4px;
    white-space: pre-wrap;
}
.msg .mtext .tok.sha { color: color-mix(in srgb, var(--acc) 60%, var(--fg2)); }
.msg.parent .mtext {
    max-width: 85%; padding: calc(.5rem * 16 / 17) calc(.75rem * 16 / 17);
    border-radius: calc(.625rem * 16 / 17);
    background: var(--ubub, color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 5%, transparent));
}
.msg .mtext .para + .para, .msg .mtext pre + .para, .msg .mtext .para + pre { margin-top: 10px; }
.msg .mtext .hd { font-weight: 600; color: var(--fg); }
.msg .mtext code {
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .88em;
    background: var(--wash); padding: 1px 5px; border-radius: 4px; white-space: pre-wrap;
}
.msg .mtext strong { font-weight: 600; }
.msg .mtext pre {
    margin: 0; padding: 7px 9px; border-radius: 7px; background: var(--bg2);
    border: 1px solid var(--hair2); overflow-x: auto; scrollbar-color: auto;
    font-family: var(--font-mono, ui-monospace, monospace); font-size: .8em;
    line-height: 1.5; color: var(--fg2); white-space: pre;
}
.msg .mtext pre::-webkit-scrollbar { height: 3px; }
.msg .mtext pre::-webkit-scrollbar-thumb { background: var(--hair); border-radius: 2px; }
/* A long message folds the way the app folds a long user message: the content
   inside the bubble is cut at a height and faded out through a mask, so the
   fold needs no colour of its own and the bubble keeps its fill. */
.msg .mbody.fold {
    max-height: ${CHAT_CLAMP}px; overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 3rem), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 3rem), transparent);
}
.msg .grow {
    all: unset; margin: 5px 2px 0; font-size: .74em; color: var(--fg3); cursor: pointer;
    padding: 2px 6px; border-radius: 6px; transition: color var(--d1) linear, background var(--d1) linear;
}
.msg .grow:hover { color: var(--fg); background: var(--wash); }
.msg .grow:focus-visible { outline: 1px solid var(--acc); outline-offset: 1px; }
`;

// ------------------------------------------------------------------ host
let host = null, shadow = null, wrap = null;

function build() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'cuimod-subagents';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:50;pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    // Scroll neither bubbles nor crosses a shadow boundary, so the root of this
    // tree is the only stable place to hear it. Attaching to .rbody instead
    // would register a listener per rail rebuild — and the rail is rebuilt on
    // every F2 and every pass through zero agents.
    ctx.track(shadow, 'scroll', fades, { capture: true, passive: true });
    const style = document.createElement('style');
    style.textContent = CSS();
    wrap = el('div', 'wrap');
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);
}
function restyle() {
    if (!shadow) return;
    const s = shadow.querySelector('style');
    if (s) s.textContent = CSS();
}
function teardown() {
    forgetNodes();
    if (!host) return;
    try { host.remove(); } catch (_) {}
    host = null; shadow = null; wrap = null;
}
ctx.onDispose(teardown);

// Which edges are hiding something. Read on scroll rather than on the 500ms
// tick, because half a second of stale mask during a flick is exactly the hard
// cut the mask exists to remove.
const EDGE = 2;
function fades() {
    for (const n of [railBody, chatBody]) {
        if (!n) continue;
        const over = n.scrollHeight - n.clientHeight;
        n.classList.toggle('clipT', over > EDGE && n.scrollTop > EDGE);
        n.classList.toggle('clipB', over > EDGE && n.scrollTop < over - EDGE);
    }
}

let misses = 0;
function place() {
    if (!host) return;

    if (railEl) {
        const sb = sidebarRect();
        const cr = composerRect();
        const tr = transcriptRegion();
        const trr = tr && tr.getBoundingClientRect();
        const left = Math.round((sb ? sb.right : 0) + GAP);
        const rightWall = cr ? cr.left - GAP : innerWidth - GAP;
        const avail = rightWall - left;
        if (avail < RAIL_MIN) railEl.style.display = 'none';
        else {
            const w = Math.min(V.railWidth, avail);
            // Under the chat's own title, not in the corner of the window: the
            // transcript region starts below the title bar, so its top is the
            // measured answer rather than a guessed offset.
            const top = Math.round((trr ? trr.top : (sb ? sb.top + 54 : 0)) + V.railTop);
            const set = (k, v) => { if (railEl.style[k] !== v) railEl.style[k] = v; };
            set('display', '');
            set('left', Math.round(left + (avail - w) / 2) + 'px');
            set('top', top + 'px');
            set('width', Math.round(w) + 'px');
            set('maxHeight', Math.round(Math.min(innerHeight * 0.62, innerHeight - top - 96)) + 'px');
            fades();
        }
    }

    if (scrimEl) {
        const r = transcriptRegion();
        const b = r && r.getBoundingClientRect();
        const sb = sidebarRect();
        if (b && b.height > 80) {
            const set = (k, v) => { if (scrimEl.style[k] !== v) scrimEl.style[k] = v; };
            set('left', Math.round(sb ? sb.right : 0) + 'px');
            set('top', Math.round(b.bottom - 12) + 'px');
            set('right', '0px');
            set('bottom', '0px');
            set('width', 'auto');
        }
    }

    if (sheetEl) {
        const r = transcriptRegion();
        const b = r && r.getBoundingClientRect();
        // The anchor can vanish for a frame while React swaps the transcript.
        // Two consecutive misses before hiding, so that does not blink it out.
        if (!b || b.width < 80 || b.height < 80) {
            if (++misses >= 2) sheetEl.style.visibility = 'hidden';
        } else {
            misses = 0;
            const set = (k, v) => { if (sheetEl.style[k] !== v) sheetEl.style[k] = v; };
            set('visibility', '');
            set('left', Math.round(b.left) + 'px');
            set('top', Math.round(b.top) + 'px');
            set('width', Math.round(b.width) + 'px');
            set('height', Math.round(b.height) + 'px');
            const col = columnWidth();
            sheetEl.style.setProperty('--col', col + 'px');
            sheetEl.classList.toggle('wide', b.width - col > 300);
        }
    }

    // The gutter is measured, not derived: the grid is centred inside a
    // scroller that reserves a stable scrollbar gutter, so its left edge is not
    // (width - col) / 2 of anything this code knows.
    if (chatEl) {
        const st = sheetEl && sheetEl.__;
        const b = sheetEl && sheetEl.style.visibility !== 'hidden' && sheetEl.getBoundingClientRect();
        const g = st && st.grid.getBoundingClientRect();
        const h = st && st.hd.getBoundingClientRect();
        const right = g ? g.left - CHAT_GAP : 0;
        const left = b ? Math.max(b.left + 24, right - CHAT_MAX) : 0;
        const set = (k, v) => { if (chatEl.style[k] !== v) chatEl.style[k] = v; };
        if (!b || !b.width || right - left < CHAT_MIN || !chatItems.length) set('display', 'none');
        else {
            set('display', '');
            set('left', Math.round(left) + 'px');
            set('top', Math.round(h.bottom) + 'px');
            set('width', Math.round(right - left) + 'px');
            set('height', Math.max(0, Math.round(b.bottom - h.bottom)) + 'px');
            foldChat();
            const cs = chatEl.__;
            if (cs.pin) chatBody.scrollTop = chatBody.scrollHeight;
            else if (cs.anchor) chatBody.scrollTop = cs.anchor.oldTop + chatBody.scrollHeight - cs.anchor.oldH;
            cs.pin = false; cs.anchor = null;
            fades();
        }
    }
}
function dedupe() {
    for (const n of document.querySelectorAll('#cuimod-subagents')) if (n !== host) { try { n.remove(); } catch (_) {} }
}

// ------------------------------------------------------------------ data
/* Accepting workspace trust can leave the current route briefly unresolved.
 * The bridge correctly withdraws the old session until that route has resolved
 * again, but removing the whole rail during that gap makes stable UI
 * blink out and back. Keep only its empty shell: no row from the retired
 * session remains visible, and a genuinely unresolved route still ages out. */
function setSessionGap(on) {
    clearTimeout(sessionGapTimer);
    sessionGapTimer = null;
    sessionGap = !!on;
    if (!sessionGap) return;
    sessionGapTimer = setTimeout(() => {
        sessionGapTimer = null;
        sessionGap = false;
        render();
    }, SESSION_GAP_MS);
}
ctx.onDispose(() => clearTimeout(sessionGapTimer));

async function refresh() {
    if (loading) return;
    if (V.mock) {
        setSessionGap(false);
        agents = mockList();
        defs = MOCK_DEFS;
        lastErr = null;
        for (const a of agents) if (a.active || a.agentId === detailId) details.set(a.agentId, mockDetail(a.agentId));
        if (detailId != null) loadChat(detailId);
        render();
        return;
    }
    // A fresh chat has no session, so there is nothing to have agents in. The
    // early return here used to skip render() too, which left the last
    // session's rail painted over a brand new conversation.
    if (!cliSid) {
        agents = []; defs = {}; details.clear(); lastErr = null;
        render();
        return;
    }
    loading = true;
    const forSid = cliSid;
    try {
        const [r, live] = await Promise.all([
            cuimod.rpc('subagents.list', { cliSid: forSid }),
            backgroundActivity(),
        ]);
        // A poll in flight when the session changes answers for the session it
        // was asked about, not the one on screen. Painting it would resurrect
        // the old rail in the new chat, and the session-change reset cannot
        // undo it because that already ran.
        if (forSid !== cliSid) return;
        // A failed poll keeps the last good list. Clearing it tore the rail down
        // and rebuilt it on the next good one: a flicker caused by nothing.
        if (r && r.ok) {
            setSessionGap(false);
            agents = r.agents || [];
            for (const a of agents) a.active = a.state === 'inflight' && live;
            lastErr = null;
        } else lastErr = (r && r.reason) || 'no data';
    } catch (e) { lastErr = String((e && e.message) || e); }
    finally { loading = false; }
    // Definitions are edited while the window stays open for days, and the
    // sheet now states what each one pins, so a set fetched once goes stale.
    // main.js caches for the same 30s, so this costs one read per period.
    if (!Object.keys(defs).length || Date.now() - defsAt > DEFS_MS) {
        try { defs = (await cuimod.rpc('subagents.defs')) || {}; defsAt = Date.now(); } catch (_) {}
    }
    // A live agent's tail is its detail, so those stay fresh while it runs.
    for (const a of agents) if (a.active || a.agentId === detailId) loadDetail(a.agentId);
    if (detailId != null) loadChat(detailId);
    render();
}

async function loadDetail(id) {
    if (V.mock) { details.set(id, mockDetail(id)); return; }
    if (!cliSid || pendingDetail.has(id)) return;
    pendingDetail.add(id);
    const forSid = cliSid;
    try {
        const d = await cuimod.rpc('subagents.detail', {
            cliSid: forSid, agentId: id, maxTurns: MAX_TURNS, gapMs: GAP_MS,
        });
        if (forSid !== cliSid) return;
        if (d && d.ok) { details.set(id, d); render(); }
    } catch (_) {}
    finally { pendingDetail.delete(id); }
}

function clearChat() {
    chatSeq++;
    chatItems = []; chatEarlier = 0; chatParent = 'main'; chatBusy = false;
    chatEls.clear();
    if (chatList) chatList.textContent = '';
}

// Without beforeId this is the newest page, polled while the sheet is open; it
// is merged by message id, so pages already fetched for scrollback survive it.
async function loadChat(id, beforeId) {
    if (chatBusy || id == null || id !== detailId) return;
    const seq = chatSeq, forSid = cliSid;
    chatBusy = true;
    try {
        const r = V.mock ? mockThread(id) : await cuimod.rpc('subagents.thread', {
            cliSid: forSid, agentId: id, limit: CHAT_PAGE, beforeId,
        });
        if (seq !== chatSeq || forSid !== cliSid || id !== detailId || !r || !r.ok) return;
        const byMsg = new Map(chatItems.map((m) => [m.id, m]));
        for (const m of r.messages || []) byMsg.set(m.id, m);
        chatItems = Array.from(byMsg.values()).sort((x, y) => (ts(x.at) || 0) - (ts(y.at) || 0));
        if (beforeId || !chatEls.size) chatEarlier = r.earlier || 0;
        chatParent = r.parentName || 'main';
        render();
    } catch (_) {}
    finally { if (seq === chatSeq) chatBusy = false; }
}

// ------------------------------------------------------------------ render
/* Rendering is a patch, not a rebuild.
 *
 * An overlay that polls has two jobs that pull against each other: show current
 * data, and stay still. Clearing a container and rebuilding its children
 * satisfies the first and destroys the second, because a fresh node is a node
 * whose CSS animations have never run — every poll replays every entrance, the
 * scroll position resets, and :hover drops off whatever is under the cursor.
 *
 * So nodes are created once, held in a Map keyed by real identity (agentId, not
 * index), and patched. Every write is guarded: assigning an identical
 * textContent still drops and recreates the text node. */

function forgetNodes() {
    railEl = railCap = capTxt = railDemo = null;
    railBody = runBox = doneBox = moreEl = emptyEl = null;
    sheetEl = sheetInner = scrimEl = null;
    chatEl = chatBody = chatList = chatMore = null;
    runEls.clear(); doneEls.clear(); chatEls.clear();
}

// Reconcile parent's children against `keys`, keeping existing nodes alive and
// in order. Nodes are created by make(key) and updated by patch(node, key).
function sync(parent, store, keys, make, patch) {
    const want = new Set(keys);
    for (const k of Array.from(store.keys())) {
        if (want.has(k)) continue;
        const n = store.get(k);
        store.delete(k);
        try { n.remove(); } catch (_) {}
    }
    let prev = null;
    for (const k of keys) {
        let n = store.get(k);
        if (!n) { n = make(k); store.set(k, n); }
        patch(n, k);
        const at = prev ? prev.nextSibling : parent.firstChild;
        if (n !== at) parent.insertBefore(n, at);
        prev = n;
    }
}
const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
const setCls = (n, c, on) => { if (n) n.classList.toggle(c, !!on); };
const setShown = (n, on) => { if (n && (n.style.display === 'none') === !!on) n.style.display = on ? '' : 'none'; };

// BEGIN hierarchy projection
/* The sidecar gives each agent its direct parent. Build from that relation rather
 * than trusting spawnDepth: a missing parent becomes a root, and corrupt cycles
 * still render exactly once. Input order is the existing newest-first order, so
 * it remains the stable order for roots and siblings. */
function hierarchyRows(rows) {
    const all = Array.isArray(rows) ? rows : [];
    const byAgent = new Map();
    for (const a of all) if (a && a.agentId != null) byAgent.set(String(a.agentId), a);

    const children = new Map();
    const roots = [];
    for (const a of all) {
        if (!a || a.agentId == null) continue;
        const id = String(a.agentId);
        const parent = a.parentAgentId == null ? null : String(a.parentAgentId);
        if (!parent || parent === id || !byAgent.has(parent)) roots.push(a);
        else {
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(a);
        }
    }

    const out = [];
    const seen = new Set();
    function visit(a, depth) {
        const id = String(a.agentId);
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ agent: a, depth });
        for (const child of children.get(id) || []) visit(child, depth + 1);
    }
    for (const root of roots) visit(root, 0);
    // A cycle has no root. Follow parents to the repeated node before promoting
    // one, so an ordinary child that appeared earlier never jumps above it.
    for (const start of all) {
        if (!start || start.agentId == null || seen.has(String(start.agentId))) continue;
        const trail = new Set();
        let root = start;
        while (root && !seen.has(String(root.agentId))) {
            const id = String(root.agentId);
            if (trail.has(id)) break;
            trail.add(id);
            const parent = root.parentAgentId == null ? null : byAgent.get(String(root.parentAgentId));
            if (!parent) break;
            root = parent;
        }
        visit(root || start, 0);
    }
    return out;
}

// Keep the deepest row inside the narrowest supported rail while preserving a
// distinct indent for every finite depth. Ordinary trees retain the 14px step.
function hierarchyIndent(maxDepth) {
    return maxDepth > 0 ? Math.min(14, 96 / maxDepth) : 14;
}
// END hierarchy projection

function render() {
    if (!V.enabled) { teardown(); return; }
    const wantRail = !railOff && (agents.length > 0 || sessionGap);
    const wantSheet = detailId != null && byId(detailId);
    if (!wantRail && !wantSheet) { teardown(); return; }

    if (!host || !host.isConnected) forgetNodes();
    build();
    dedupe();
    // Rails are ambient UI. The detail sheet is a modal that owns its input, so
    // only it crosses above Claude's native portal layer.
    host.style.zIndex = wantSheet ? '2147483500' : '50';

    if (wantRail) renderRail();
    else if (railEl) { try { railEl.remove(); } catch (_) {} railEl = null; runEls.clear(); doneEls.clear(); }

    if (wantSheet) {
        if (!scrimEl) {
            scrimEl = el('div', 'scrim');
            scrimEl.addEventListener('click', closeDetail);
            wrap.insertBefore(scrimEl, wrap.firstChild);
        }
        renderSheet(byId(detailId));
        renderChat(byId(detailId));
    } else {
        if (sheetEl) { try { sheetEl.remove(); } catch (_) {} sheetEl = sheetInner = null; }
        if (scrimEl) { try { scrimEl.remove(); } catch (_) {} scrimEl = null; }
        if (chatEl) {
            try { chatEl.remove(); } catch (_) {}
            chatEl = chatBody = chatList = chatMore = null;
            chatEls.clear();
        }
    }

    place();
}

// ---------------------------------------------------------------- the rail
function renderRail() {
    if (!railEl) {
        railEl = el('div', 'rail');
        railCap = el('div', 'cap');
        capTxt = el('span');
        railDemo = el('span', 'demo', 'demo');
        railDemo.style.display = 'none';
        railCap.append(capTxt, el('span', 'sp'), railDemo);
        railBody = el('div', 'rbody');
        runBox = el('div', 'runs');
        doneBox = el('div', 'ghosts');
        railBody.append(runBox, doneBox);
        railEl.append(railCap, railBody);
        wrap.append(railEl);
    }

    const live = agents.filter((a) => a.active);
    const done = agents.filter((a) => !a.active);
    setText(capTxt, live.length
        ? live.length + (live.length === 1 ? ' agent running' : ' agents running')
        : 'subagents');
    setCls(capTxt, 'n', live.length > 0);
    setShown(railDemo, !!V.mock);

    // The demo exists to be looked at, so it is not subject to stoppedLimit.
    // Ancestors are structural and remain visible even when they are finished:
    // otherwise a running child would float at depth zero with its parent hidden.
    const cap = (V.mock || showAll) ? done.length : Math.max(0, V.stoppedLimit);
    const include = new Set(live.map((a) => a.agentId));
    for (const a of done.slice(0, cap)) include.add(a.agentId);
    const allById = new Map(agents.map((a) => [a.agentId, a]));
    for (const start of Array.from(include)) {
        const chain = new Set();
        let a = allById.get(start);
        while (a && a.parentAgentId && !chain.has(a.agentId)) {
            chain.add(a.agentId);
            const parent = allById.get(a.parentAgentId);
            if (!parent) break;
            include.add(parent.agentId);
            a = parent;
        }
    }
    const tree = hierarchyRows(agents.filter((a) => include.has(a.agentId)));
    const depth = new Map(tree.map((x) => [x.agent.agentId, x.depth]));
    const maxDepth = tree.reduce((m, x) => Math.max(m, x.depth), 0);
    const indent = hierarchyIndent(maxDepth);

    // One reconciled list is what keeps a finished parent immediately above a
    // running child. State remains visual: live rows glow, finished rows ghost.
    sync(runBox, runEls, tree.map((x) => x.agent.agentId),
        (id) => makeRow(byId(id)), (n, id) => patchRow(n, byId(id), depth.get(id), indent));
    sync(doneBox, doneEls, [], () => null, () => {});
    setShown(doneBox, false);

    if (!agents.length) {
        if (!emptyEl) {
            emptyEl = el('div', 'rempty');
            railBody.append(emptyEl);
        }
        setText(emptyEl, sessionGap ? 'reconnecting to session…' : 'no agents in this session yet');
    } else if (emptyEl) { emptyEl.remove(); emptyEl = null; }

    const hiddenDone = done.filter((a) => !include.has(a.agentId)).length;
    let label = null;
    if (hiddenDone > 0) label = '+' + hiddenDone + ' more';
    else if (showAll && done.length > V.stoppedLimit) label = 'fewer';
    if (!label) { if (moreEl) { moreEl.remove(); moreEl = null; } }
    else {
        if (!moreEl) {
            moreEl = el('div', 'more');
            moreEl.addEventListener('click', () => { showAll = !showAll; render(); });
            railBody.append(moreEl);
        }
        setText(moreEl, label);
    }
}

function backArrow() {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M15 6l-6 6 6 6');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
}

function makeRow(a) {
    const n = el('div', 'row');
    const dot = el('span', 'dot');
    const mid = el('div', 'mid');
    const nm = el('div', 'nm');
    mid.append(nm);
    const rt = el('div', 'rt');
    const when = el('div', 'when');
    const stop = el('button', 'kstop', 'stop');
    stop.type = 'button';
    rt.append(when, stop);
    const slot = el('div', 'slot');
    n.append(dot, mid, rt, slot);
    n.__ = { nm, when, stop, slot, mode: null, sig: null };
    const id = a.agentId;
    n.addEventListener('click', () => openDetail(id, n));
    stop.addEventListener('click', (e) => {
        // The whole row opens the sheet. Without this the confirm click would
        // stop the agent and then open the agent it just stopped.
        e.preventDefault(); e.stopPropagation();
        const cur = byId(id);
        if (cur && cur.active) armStop(cur);
    });
    return n;
}
function patchRow(n, a, depth, indentStep) {
    if (!a) return;
    const st = n.__;
    const s = spanOf(a);
    const treeDepth = Number.isInteger(depth) && depth > 0 ? depth : 0;
    const step = Number.isFinite(indentStep) && indentStep > 0 ? indentStep : 14;
    const indent = treeDepth * step + 'px';
    const guide = Math.round(Math.max(1, Math.min(9, step)) * 10) / 10 + 'px';
    if (n.style.getPropertyValue('--tree-indent') !== indent) n.style.setProperty('--tree-indent', indent);
    if (n.style.getPropertyValue('--tree-guide') !== guide) n.style.setProperty('--tree-guide', guide);
    if (n.dataset.depth !== String(treeDepth)) n.dataset.depth = String(treeDepth);
    setCls(n, 'child', treeDepth > 0);
    setCls(n, 'live', a.active);
    setCls(n, 'ghost', !a.active);
    setCls(n, 'halt', !a.active && a.state === 'stopped');
    setCls(n, 'sel', detailId === a.agentId);
    setText(st.nm, a.name || a.type || a.agentId.slice(0, 12));
    setText(st.when, dur(s.ms));

    // armedStop is one id for the whole plugin, so a row armed here and the
    // sheet's own stop button are the same armed state — including the 3s
    // disarm, which is why this is patched before the ghost early-return.
    const armed = armedStop === a.agentId;
    setShown(st.stop, !!a.active);
    setCls(st.stop, 'armed', armed);
    setText(st.stop, armed ? 'confirm' : 'stop');
    setCls(n, 'arm', armed);

    // A finished agent is a ghost: a name and how long it took. Whatever it
    // concluded is a click away, and putting it here is what made the rail read
    // as a second inbox rather than a heads-up display.
    const mode = a.active ? 'live' : 'ghost';
    if (st.mode !== mode) {
        st.mode = mode; st.sig = null;
        st.slot.textContent = '';
    }
    if (mode === 'ghost') return;

    const d = details.get(a.agentId);
    let tool = a.lastTool || '', what = oneline(a.lastText || a.brief);
    if (d && d.turns.length) {
        for (let i = d.turns.length - 1; i >= 0; i--) {
            const t = d.turns[i];
            if (t.kind !== 'assistant') continue;
            const p = t.parts[t.parts.length - 1];
            if (!p) continue;
            if (p.t === 'tool') { tool = p.name; what = oneline(p.input); }
            else if (p.t === 'text') { tool = ''; what = oneline(p.text); }
            break;
        }
    }
    const sig = tool + ' ' + what;
    if (st.sig === sig) return;
    st.sig = sig;
    st.slot.textContent = '';
    const doing = el('div', 'doing');
    if (tool) doing.append(el('b', null, tool));
    doing.append(el('span', null, what.slice(0, 140)));
    const bar = el('div', 'bar');
    bar.append(el('i'));
    st.slot.append(doing, bar);
}

// --------------------------------------------------------------- the sheet
function renderSheet(a) {
    let st;
    if (!sheetEl) {
        sheetEl = el('div', 'sheet');
        sheetInner = el('div', 'inner');

        const hd = el('div', 'shd');
        const hin = el('div', 'in');
        const crumb = el('div', 'crumb');
        crumb.append(backArrow(), el('span', null, 'all agents'));
        crumb.addEventListener('click', closeDetail);

        const title = el('div', 'title');
        const h2 = el('h2');
        const badge = el('div', 'badge');
        const badgeDot = el('i');
        const badgeTxt = el('span');
        badge.append(badgeDot, badgeTxt);
        badge.style.display = 'none';
        const acts = el('div', 'acts');
        const stop = el('div', 'act danger', 'stop');
        const copy = el('div', 'act', 'copy id');
        const rev = el('div', 'act', 'reveal file');
        const close = el('div', 'act', 'close');
        acts.append(stop, copy, rev, close);
        title.append(h2, badge, el('div', 'sp'), acts);

        const subline = el('div', 'subline');
        hin.append(crumb, title, subline);
        hd.append(hin);

        const grid = el('div', 'grid');
        const main = el('div', 'main');
        const brief = el('div', 'brief');
        const tail = el('div', 'tailslot');
        const turns = el('div', 'turns');
        main.append(brief, tail, turns);

        const side = el('div', 'side');
        const cRun = card('at a glance');
        const cTools = card('tools');
        const cDef = card('definition');
        side.append(cRun.box, cTools.box, cDef.box);
        grid.append(main, side);

        sheetInner.append(hd, grid);
        sheetEl.append(sheetInner);
        wrap.append(sheetEl);

        st = sheetEl.__ = {
            h2, badge, badgeTxt, subline, stop, copy, rev, close, crumb,
            brief, tail, turns, hd, grid,
            kv: cRun.body, hist: cTools.body, def: cDef.body,
            cToolsBox: cTools.box, cDefBox: cDef.box,
            msig: null, hsig: null, dsig: null, bsig: null, briefSig: null,
            blockLen: 0, dropped: -1, tailNode: null, tailSig: null, pending: null,
        };
        close.addEventListener('click', closeDetail);
        copy.addEventListener('click', () => {
            cuimod.rpc('dashboard.clipWrite', { text: detailId }).catch(() => {});
            setText(copy, 'copied');
            const t = setTimeout(() => setText(copy, 'copy id'), 1100);
            ctx.onDispose(() => clearTimeout(t));
        });
        rev.addEventListener('click', () => {
            const cur = byId(detailId);
            if (cur && cur.file) cuimod.rpc('subagents.reveal', { file: cur.file }).catch(() => {});
        });
        stop.addEventListener('click', () => { const cur = byId(detailId); if (cur) armStop(cur); });
    }
    st = sheetEl.__;

    const s = spanOf(a);
    const d = details.get(a.agentId);

    setText(st.h2, a.name || a.type || a.agentId.slice(0, 12));
    setText(st.badgeTxt, a.active ? 'running' : 'stopped');
    setCls(st.badge, 'halt', !a.active);
    setShown(st.badge, !!a.active || a.state === 'stopped');
    setShown(st.stop, !!a.active);
    setShown(st.rev, !!a.file);
    const armed = armedStop === a.agentId;
    setCls(st.stop, 'armed', armed);
    setText(st.stop, armed ? 'confirm stop' : 'stop');

    const bits = [];
    if (a.type) bits.push(['', a.type, defPin(a.type)]);
    if (a.model) bits.push(['model ', shortModel(a.model)]);
    if (a.effort) bits.push(['effort ', a.effort]);
    bits.push([a.active ? 'running ' : (a.state === 'stopped' ? 'ran before it was stopped ' : 'ran '), dur(s.ms)]);
    bits.push(['started ', hhmm(s.s)]);
    const bsig = JSON.stringify(bits);
    if (st.bsig !== bsig) {
        st.bsig = bsig;
        st.subline.textContent = '';
        for (const [k, v, pin] of bits) {
            const n = el('span');
            if (k) n.append(el('b', null, k));
            n.append(document.createTextNode(v));
            if (pin) n.append(el('span', 'pin', '(' + pin + ')'));
            st.subline.append(n);
        }
    }

    const briefText = (a.description ? a.description + ' — ' : '') + (a.brief || a.lastText || '');
    if (st.briefSig !== briefText) {
        st.briefSig = briefText;
        st.brief.textContent = '';
        fmtInto(st.brief, briefText.replace(/\s+/g, ' ').trim().slice(0, 900));
    }
    setShown(st.brief, !!briefText.trim());

    // at a glance
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([k, String(v)]); };
    add('state', a.active ? 'running' : (a.state === 'stopped' ? 'stopped' : 'finished'));
    add(a.active ? 'running' : 'ran', dur(s.ms));
    add('started', clock(s.s));
    if (!a.active) add('ended', clock(s.e));
    if (d) {
        const t = d.tokens || {};
        add('output', (t.out || 0).toLocaleString() + ' tok');
        add('cache read', Math.round((t.cacheRead || 0) / 1000).toLocaleString() + 'k');
        add('turns', d.lines);
    }
    add('id', a.agentId);
    const msig = JSON.stringify(rows);
    if (st.msig !== msig) {
        st.msig = msig;
        st.kv.textContent = '';
        for (const [k, v] of rows) {
            const line = el('div');
            line.append(el('span', 'k', k), el('span', 'v', v));
            st.kv.append(line);
        }
    }

    // tools
    const tools = Object.entries((d && d.tools) || {}).sort((x, y) => y[1] - x[1]).slice(0, 8);
    const hsig = JSON.stringify(tools);
    if (st.hsig !== hsig) {
        st.hsig = hsig;
        st.hist.textContent = '';
        const max = tools.reduce((m, t) => Math.max(m, t[1]), 1);
        for (const [name, n] of tools) {
            const line = el('div');
            const bar = el('div', 'hb');
            const fill = el('i');
            fill.style.width = Math.max(6, Math.round((n / max) * 100)) + '%';
            bar.append(fill);
            line.append(el('span', 'hn', name), bar, el('span', 'hv', String(n)));
            st.hist.append(line);
        }
    }
    setShown(st.cToolsBox, tools.length > 0);

    // definition
    const def = a.type && defs[a.type];
    const dtext = (def && def.description) || '';
    if (st.dsig !== dtext) {
        st.dsig = dtext;
        st.def.textContent = '';
        if (dtext) st.def.append(el('div', 'defbox', dtext));
    }
    setShown(st.cDefBox, !!dtext);

    if (a.active) patchTail(st.tail, a);
    else if (st.tail.firstChild) { st.tail.textContent = ''; st.tail.__sig = null; }

    patchTurns(st, d);
}

// ---------------------------------------------------------------- the chat
function renderChat(a) {
    if (!chatEl) {
        chatEl = el('div', 'chat');
        chatBody = el('div', 'cbody');
        chatMore = el('div', 'earlier');
        chatMore.style.display = 'none';
        chatMore.addEventListener('click', () => { if (chatItems.length) loadChat(detailId, chatItems[0].id); });
        chatList = el('div', 'clist');
        chatBody.append(chatMore, chatList);
        chatEl.append(chatBody);
        chatEl.__ = { pin: false, anchor: null };
        try {
            const root = document.querySelector('.cds-root');
            const fill = root && getComputedStyle(root).getPropertyValue('--cds-bg-user-message').trim();
            if (fill) chatEl.style.setProperty('--ubub', fill);
        } catch (_) {}
        wrap.append(chatEl);
    }
    const st = chatEl.__;
    const firstFill = !chatEls.size;
    const lastId = chatList.lastChild && chatList.lastChild.__ && chatList.lastChild.__.id;
    const firstId = chatList.firstChild && chatList.firstChild.__ && chatList.firstChild.__.id;
    const atEnd = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 40;
    const oldH = chatBody.scrollHeight, oldTop = chatBody.scrollTop;

    const byMsg = new Map(chatItems.map((m) => [m.id, m]));
    const ids = chatItems.map((m) => m.id);
    sync(chatList, chatEls, ids, (id) => msgNode(id), (n, id) => patchMsg(n, byMsg.get(id), a));
    setText(chatMore, chatEarlier ? chatEarlier + ' earlier' : '');
    setShown(chatMore, chatEarlier > 0);

    // Scroll is settled in place(), once the column has a size: a scrollTop
    // written while it is display:none is discarded.
    if (!ids.length) return;
    if (firstFill) st.pin = true;
    else if (firstId && ids[0] !== firstId) st.anchor = { oldH, oldTop };
    else if (ids[ids.length - 1] !== lastId && atEnd) st.pin = true;
}

function msgNode(id) {
    const n = el('div', 'msg');
    const who = el('div', 'mwho');
    const nm = el('b');
    const tag = el('span', 'tag');
    const at = el('span', 'at');
    const flag = el('span', 'flag');
    who.append(nm, tag, at, flag);
    const bubble = el('div', 'mtext');
    const text = el('div', 'mbody');
    bubble.append(text);
    const grow = el('button', 'grow');
    grow.type = 'button';
    grow.style.display = 'none';
    n.append(who, bubble, grow);
    n.__ = { id, nm, tag, at, flag, text, grow, sig: null, open: false, long: false };
    grow.addEventListener('click', () => { n.__.open = !n.__.open; foldChat(); });
    return n;
}

const REPORT_TAG = { completed: 'final report', killed: 'stopped', failed: 'failed' };
function patchMsg(n, m, a) {
    if (!m) return;
    const st = n.__;
    const side = m.dir === 'parent' ? 'parent' : 'child';
    setCls(n, 'parent', side === 'parent');
    setCls(n, 'child', side === 'child');
    setText(st.nm, side === 'parent' ? chatParent : (a && (a.name || a.type)) || 'agent');
    const tag = m.kind === 'brief' ? 'assignment'
        : m.kind === 'report' ? (REPORT_TAG[m.status] || 'report') : '';
    setText(st.tag, tag);
    setShown(st.tag, !!tag);
    setText(st.at, hhmm(ts(m.at)));
    const flag = m.status === 'failed' && m.kind === 'message' ? 'not delivered'
        : m.status === 'pending' ? 'sending' : '';
    setText(st.flag, flag);
    setShown(st.flag, !!flag);
    if (st.sig !== m.text) {
        st.sig = m.text;
        st.open = false;
        st.text.textContent = '';
        chatInto(st.text, m.text, side === 'parent' ? [chatParent] : [a && a.name, a && a.type]);
    }
}

// A long message folds behind "show more". Whether it is long depends on the
// column's width, so it is measured on every placement rather than guessed from
// the character count.
function foldChat() {
    for (const n of chatEls.values()) {
        const st = n.__;
        st.long = st.text.scrollHeight > CHAT_CLAMP + 48;
        setCls(st.text, 'fold', st.long && !st.open);
        setShown(st.grow, st.long);
        setText(st.grow, st.open ? 'show less' : 'show more');
    }
}

// BEGIN chat formatting
/* Message bodies are prose written by a model for another model: one long
 * paragraph of findings, asides, paths and commit ids. Nothing here rewrites
 * it. The shape it already has is made visible: a sentence starts a line, an
 * inline "(1) … (2) …" run becomes a list, a long parenthetical steps back,
 * and a path shrinks to its last two segments with the whole path on hover.
 * Headings lose their hashes and fences become blocks. Text only — nothing a
 * message contains ever becomes markup. */
const CHAT_TOK = new RegExp([
    '`([^`\\n]+)`',
    '\\*\\*([^*\\n]+)\\*\\*',
    '([A-Za-z]:\\\\[^\\s"\'`<>|]*[^\\s"\'`<>|.,;:)])',
    '((?:\\.{1,2}/)?(?:[\\w@.+-]+/)+[\\w@.+-]*\\.(?:\\{[\\w,]+\\}|[A-Za-z][A-Za-z0-9]{0,5})(?::\\d+(?:-\\d+)?)?)',
    '(\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:\\{[\\w,]+\\}|cpp|cc|c|h|hpp|cs|js|mjs|cjs|ts|tsx|py|json|jsonl|md|png|jpg|webp|ini|txt|obj|lib|dll|exe|ps1|sh|gd|toml|ya?ml|log|sln|vcxproj|pdb)(?::\\d+(?:-\\d+)?)?\\b)',
    '\\b([0-9a-f]{7,40})\\b',
].join('|'), 'g');
const ASIDE_MIN = 24;
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|vs|etc|cf|approx|incl|no)\.$/i;

function chatTok(node, text, cls, title) {
    const t = el('span', 'tok' + (cls ? ' ' + cls : ''), text);
    if (title) t.title = title;
    node.append(t);
}
function chatPath(node, p) {
    const segs = p.split(/[\\/]/).filter(Boolean);
    if (segs.length <= 3) return chatTok(node, p, null, null);
    chatTok(node, '…/' + segs.slice(-2).join('/'), null, p);
}
// Where the parenthesis opened at `from` closes, ignoring code spans.
function closeParen(s, from) {
    let depth = 0, code = false;
    for (let i = from; i < s.length; i++) {
        const c = s[i];
        if (c === '`') code = !code;
        else if (code) continue;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
    }
    return -1;
}
function chatInline(node, s) {
    let i = 0;
    const text = (t) => { if (t) node.append(document.createTextNode(t)); };
    while (i < s.length) {
        CHAT_TOK.lastIndex = i;
        const m = CHAT_TOK.exec(s);
        const open = s.indexOf('(', i);
        const close = open >= 0 && (!m || open < m.index) ? closeParen(s, open) : -1;
        if (close > open) {
            text(s.slice(i, open));
            const inner = s.slice(open + 1, close);
            const host = inner.length >= ASIDE_MIN ? el('span', 'aside') : node;
            if (host !== node) node.append(host);
            host.append(document.createTextNode('('));
            chatInline(host, inner);
            host.append(document.createTextNode(')'));
            i = close + 1;
            continue;
        }
        if (!m) { text(s.slice(i)); break; }
        text(s.slice(i, m.index));
        if (m[1] != null) node.append(el('code', null, m[1]));
        else if (m[2] != null) { const b = el('strong'); chatInline(b, m[2]); node.append(b); }
        else if (m[3] != null || m[4] != null) chatPath(node, m[3] || m[4]);
        else if (m[5] != null) chatTok(node, m[5], null, null);
        else if (/\d/.test(m[6]) && /[a-f]/.test(m[6])) chatTok(node, m[6].slice(0, 12), 'sha', m[6]);
        else text(m[6]);
        i = m.index + m[0].length;
    }
}
// Sentence ends: terminal punctuation at paren depth zero, outside code,
// followed by space and something that can start a sentence.
function chatSentences(s) {
    const out = [];
    let depth = 0, code = false, from = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '`') { code = !code; continue; }
        if (code) continue;
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if ((c === '.' || c === '!' || c === '?') && depth === 0 && /\s/.test(s[i + 1] || '')) {
            const rest = s.slice(i + 1).replace(/^\s+/, '');
            if (!/^[A-Z0-9"“`(\[]/.test(rest) || ABBREV.test(s.slice(from, i + 1))) continue;
            out.push(s.slice(from, i + 1).trim());
            from = s.length - rest.length;
            i = from - 1;
        }
    }
    if (s.slice(from).trim()) out.push(s.slice(from).trim());
    return out;
}
// "… one of: (1) this; or (2) that" is a list the writer typed inline.
const ENUM = /(^|[\s:;,])\((\d{1,2}|[a-h])\)\s/g;
function chatSentence(node, s, lead) {
    const marks = [];
    ENUM.lastIndex = 0;
    let m;
    while ((m = ENUM.exec(s))) marks.push({ at: m.index + m[1].length, end: m.index + m[0].length, label: m[2] });
    const line = el('span', 's' + (lead ? ' lead' : ''));
    node.append(line);
    // The writer ended an item with a full stop, so the items arrive one
    // sentence each; a sentence that opens on its marker, or on "So: (1)", is
    // still an item.
    if (marks.length === 1 && marks[0].at === 0) {
        line.className = 'enum';
        line.append(el('i', null, marks[0].label));
        chatInline(line, s.slice(marks[0].end));
        return;
    }
    if (marks.length < 2 && !(marks.length === 1 && /:\s*$/.test(s.slice(0, marks[0].at)))) {
        chatInline(line, s);
        return;
    }
    chatInline(line, s.slice(0, marks[0].at).trim());
    marks.forEach((k, j) => {
        const item = el('span', 'enum');
        item.append(el('i', null, k.label));
        chatInline(item, s.slice(k.end, j + 1 < marks.length ? marks[j + 1].at : s.length).trim());
        line.append(item);
    });
}
function chatInto(node, text, names) {
    let src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    // "gui status: …" from gui, under a header that already says gui.
    for (const n of names || []) {
        if (!n) continue;
        const re = new RegExp('^\\s*' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s+(?:status|update|report))?:\\s*', 'i');
        if (re.test(src)) {
            src = src.replace(re, '');
            // "on the switch…" reads as a sentence again; "fedfcc8 lands…" is an id.
            if (/^[a-z]+\s/.test(src)) src = src.charAt(0).toUpperCase() + src.slice(1);
            break;
        }
    }
    const lines = src.split('\n');
    let para = [], lead = true;
    const flush = () => {
        const rows = para.filter((l) => l.trim());
        para = [];
        if (!rows.length) return;
        const p = el('div', 'para');
        let run = [];
        const prose = () => {
            if (!run.length) return;
            for (const sent of chatSentences(run.join(' '))) { chatSentence(p, sent, lead); lead = false; }
            run = [];
        };
        for (const l of rows) {
            const li = /^\s*([-*+]|\d{1,2}[.)])\s+(.*)$/.exec(l);
            if (!li) { run.push(l.trim()); continue; }
            prose();
            const item = el('span', 'enum');
            item.append(el('i', null, /\d/.test(li[1]) ? li[1].replace(/[.)]$/, '') : '•'));
            chatInline(item, li[2]);
            p.append(item);
            lead = false;
        }
        prose();
        node.append(p);
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {
            flush();
            const body = [];
            while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
            node.append(el('pre', null, body.join('\n')));
            lead = false;
            continue;
        }
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        if (h) { flush(); const d = el('div', 'para hd'); chatInline(d, h[1]); node.append(d); lead = false; continue; }
        if (!line.trim()) { flush(); continue; }
        para.push(line);
    }
    flush();
}
// END chat formatting

function card(title) {
    const box = el('div', 'card');
    box.append(el('h3', null, title));
    const body = el('div', title === 'tools' ? 'hist' : (title === 'definition' ? 'defwrap' : 'kv'));
    box.append(body);
    return { box, body };
}

function patchTail(slot, a) {
    let box = slot.firstChild;
    if (!box) { box = el('div', 'tail'); slot.append(box); }
    const d = details.get(a.agentId);
    const lines = [];
    if (d) {
        for (let i = d.turns.length - 1; i >= 0 && lines.length < TAIL_LINES; i--) {
            const t = d.turns[i];
            if (t.kind !== 'assistant') continue;
            for (let j = t.parts.length - 1; j >= 0 && lines.length < TAIL_LINES; j--) {
                const p = t.parts[j];
                if (p.t === 'tool') lines.push({ tool: p.name, text: p.input });
                else if (p.t === 'text') lines.push({ text: oneline(p.text) });
            }
        }
    }
    lines.reverse();
    // The cursor on the last line blinks on an infinite keyframe. Rebuilding an
    // unchanged tail restarts it mid-cycle, which is a visible stutter.
    const sig = lines.length
        ? lines.map((L) => (L.tool || '') + ' ' + (L.text || '')).join('')
        : '~' + (a.lastTool || '');
    if (box.__sig === sig) return;
    box.__sig = sig;
    box.textContent = '';
    if (!lines.length) {
        const l = el('div', 'tl now');
        l.append(el('span', null, a.lastTool || 'working'));
        box.append(l);
        return;
    }
    lines.forEach((L, i) => {
        const l = el('div', 'tl' + (i === lines.length - 1 ? ' now' : ''));
        if (L.tool) l.append(el('b', null, L.tool));
        l.append(el('span', null, (L.text || '').slice(0, 200)));
        box.append(l);
    });
}

// ------------------------------------------------------------- the transcript
/* A tool call and what it returned are one thing. The CLI writes them as two
 * consecutive turns — an assistant turn holding tool_use, then a user turn
 * holding only tool_result — so rendering turns verbatim labels every command's
 * output "input" and puts a rule through the middle of a single action. Folding
 * the results back onto the call that made them is what the rest of the layout
 * is built on. */
function foldTurns(turns) {
    const out = [];
    for (const t of turns) {
        if (t.kind === 'gap') { out.push({ kind: 'gap', ms: t.ms }); continue; }
        const parts = t.parts || [];
        const onlyResults = t.kind === 'user' && parts.length > 0 && parts.every((p) => p.t === 'result');
        const prev = out[out.length - 1];
        if (onlyResults && prev && prev.kind === 'assistant') {
            for (const p of parts) prev.results.push(p);
            continue;
        }
        out.push({ kind: t.kind, at: t.at, parts: parts, results: [] });
    }
    return out;
}

// Inline formatting for transcript prose: backtick spans and **bold**, which is
// what the CLI's own text actually uses. Everything else stays literal.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
function fmtInto(node, text) {
    const s = String(text == null ? '' : text);
    INLINE.lastIndex = 0;
    let last = 0, m;
    while ((m = INLINE.exec(s))) {
        if (m.index > last) node.append(document.createTextNode(s.slice(last, m.index)));
        if (m[1] != null) node.append(el('code', null, m[1]));
        else node.append(el('strong', null, m[2]));
        last = m.index + m[0].length;
    }
    if (last < s.length) node.append(document.createTextNode(s.slice(last)));
}

// "file_path: x, offset: 180" reads better with the keys stepped back.
const ARGSEP = /,\s(?=[a-z_]+:\s)/;
const ARGPAIR = /^([a-z_]+):\s([\s\S]*)$/;
function argsInto(node, input) {
    const s = String(input == null ? '' : input);
    if (!s) return;
    s.split(ARGSEP).forEach((seg, i) => {
        if (i) node.append(document.createTextNode('   '));
        const m = seg.match(ARGPAIR);
        if (m) { node.append(el('em', null, m[1] + ':')); node.append(document.createTextNode(' ' + m[2])); }
        else node.append(document.createTextNode(seg));
    });
}

const SHORT_OUT = 9;   // lines that fit without clamping
function outNode(p) {
    const text = String((p && p.text) || '');
    const box = el('div', 'cout' + (p && p.error ? ' err' : ''));
    box.append(el('pre', null, text));
    const short = text.split('\n').length <= SHORT_OUT && text.length < 620;
    if (short) box.classList.add('open');
    else {
        box.append(el('div', 'fade', 'show all'));
        box.addEventListener('click', () => {
            if (box.classList.contains('open')) return;
            const from = box.getBoundingClientRect().height;
            box.classList.add('open');
            const to = box.getBoundingClientRect().height;
            if (reduced() || !(to > from)) return;
            try {
                box.animate([{ maxHeight: from + 'px' }, { maxHeight: to + 'px' }],
                    { duration: MS(280), easing: 'cubic-bezier(.2,.85,.3,1)' });
            } catch (_) {}
        });
    }
    return box;
}

function callNode(name, input, result) {
    const box = el('div', 'call');
    const head = el('div', 'chead');
    head.append(el('b', null, name || 'tool'));
    const args = el('span', 'args');
    argsInto(args, input);
    head.append(args);
    box.append(head);
    if (result) box.append(outNode(result));
    return box;
}

function blockNode(b) {
    if (b.kind === 'gap') return el('div', 'seam', 'idle ' + dur(b.ms) + ' — stopped, then resumed');
    const n = el('div', 'blk ' + b.kind);
    const who = el('div', 'who');
    who.append(el('span', 'role', b.kind === 'assistant' ? 'agent' : 'input'), el('span', 'rule'));
    if (b.at) who.append(el('span', 'at', String(b.at).slice(11, 19)));
    n.append(who);

    let ri = 0;
    for (const p of b.parts) {
        if (p.t === 'text') { const t = el('div', 'txt'); fmtInto(t, p.text); n.append(t); }
        else if (p.t === 'thinking') { if (V.showThinking) { const t = el('div', 'txt think'); fmtInto(t, p.text); n.append(t); } }
        else if (p.t === 'tool') n.append(callNode(p.name, p.input, b.results[ri++]));
        else if (p.t === 'result') n.append(outNode(p));
    }
    // results with no call to hang off (a truncated head, usually)
    for (; ri < b.results.length; ri++) n.append(outNode(b.results[ri]));
    return n;
}

function patchTurns(st, d) {
    if (!d) {
        if (!st.pending) { st.pending = el('div', 'empty', 'reading transcript…'); st.turns.append(st.pending); }
        return;
    }
    if (st.pending) { st.pending.remove(); st.pending = null; }

    const blocks = foldTurns(d.turns);
    const dropped = d.dropped || 0;
    if (st.dropped !== dropped || blocks.length < st.blockLen) {
        st.dropped = dropped;
        st.blockLen = 0;
        st.tailNode = null;
        st.tailSig = null;
        st.turns.textContent = '';
        if (dropped) st.turns.append(el('div', 'seam', 'earlier ' + dropped + ' turns not shown'));
    }
    // The last block is still being written while an agent runs — a result can
    // still land on it — so it is re-rendered when its content changed and left
    // alone when it did not. Leaving it alone is what keeps an output the reader
    // has expanded expanded.
    const sig = blocks.length ? JSON.stringify(blocks[blocks.length - 1]) : null;
    if (st.tailNode && st.tailSig !== sig) {
        st.tailNode.remove();
        st.tailNode = null;
        st.blockLen = Math.max(0, st.blockLen - 1);
    }
    const firstFill = st.blockLen === 0;
    for (let i = st.blockLen; i < blocks.length; i++) {
        const node = blockNode(blocks[i]);
        if (firstFill && i < 9) { node.classList.add('in'); node.style.setProperty('--i', String(i)); }
        st.turns.append(node);
        if (i === blocks.length - 1) { st.tailNode = node; st.tailSig = sig; }
    }
    st.blockLen = blocks.length;
}

// ------------------------------------------------------------------ open/close
/* The sheet grows out of the row that was clicked rather than cutting to it:
 * a clip-path inset animated from the row's rect, mapped into the sheet's own
 * coordinate space. The content fades up behind it on a slight delay, so the
 * frame arrives first and the text settles into it. */
function openDetail(id, fromRow) {
    const rect = fromRow ? fromRow.getBoundingClientRect() : null;
    if (id !== detailId) clearChat();
    detailId = id;
    armedStop = null;
    if (!details.has(id)) loadDetail(id);
    loadChat(id);
    render();
    if (!sheetEl || reduced()) return;
    const s = sheetEl.getBoundingClientRect();
    if (!rect || !s.width) return;
    const top = Math.max(0, Math.min(s.height, rect.top - s.top));
    const left = Math.max(0, Math.min(s.width, rect.left - s.left));
    const right = Math.max(0, Math.min(s.width, s.right - rect.right));
    const bottom = Math.max(0, Math.min(s.height, s.bottom - rect.bottom));
    try {
        sheetEl.animate([
            { clipPath: 'inset(' + top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px round 11px)', opacity: 0.55 },
            { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
        ], { duration: MS(360), easing: 'cubic-bezier(.2,.85,.3,1)' });
    } catch (_) {}
}
function closeDetail() {
    if (detailId == null) return;
    const row = runEls.get(detailId) || doneEls.get(detailId);
    const s = sheetEl && sheetEl.getBoundingClientRect();
    const rect = row && row.getBoundingClientRect();
    const done = () => { clearChat(); detailId = null; armedStop = null; render(); };
    if (chatEl && !reduced()) chatEl.classList.add('leaving');
    if (!sheetEl || reduced() || !rect || !s || !s.width) {
        if (scrimEl && !reduced()) {
            scrimEl.classList.add('leaving');
            const t0 = setTimeout(done, MS(200) + 60);
            ctx.onDispose(() => clearTimeout(t0));
            return;
        }
        done();
        return;
    }
    const top = Math.max(0, Math.min(s.height, rect.top - s.top));
    const left = Math.max(0, Math.min(s.width, rect.left - s.left));
    const right = Math.max(0, Math.min(s.width, s.right - rect.right));
    const bottom = Math.max(0, Math.min(s.height, s.bottom - rect.bottom));
    if (scrimEl) scrimEl.classList.add('leaving');
    let anim = null;
    try {
        anim = sheetEl.animate([
            { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 },
            { clipPath: 'inset(' + top + 'px ' + right + 'px ' + bottom + 'px ' + left + 'px round 11px)', opacity: 0.4 },
        ], { duration: MS(240), easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' });
    } catch (_) {}
    // animationend does not fire in a backgrounded window, so a timer backstops
    // it — the panel must not be able to strand itself half-closed.
    let fired = false;
    const go = () => { if (fired) return; fired = true; done(); };
    if (anim) anim.onfinish = go;
    const t = setTimeout(go, MS(240) + 220);
    ctx.onDispose(() => clearTimeout(t));
}

function armStop(a) {
    if (armedStop === a.agentId) {
        clearTimeout(armedTimer);
        armedStop = null;
        if (V.mock) { lastErr = null; render(); return; }
        const local = (location.pathname.match(/local_[0-9a-f-]{36}/) || [null])[0];
        if (local) {
            cuimod.appInvoke(STOP_TASK, local, a.agentId)
                .then(refresh)
                .catch((e) => { lastErr = 'stop failed: ' + ((e && e.message) || e); render(); });
        }
        render();
        return;
    }
    armedStop = a.agentId;
    clearTimeout(armedTimer);
    armedTimer = setTimeout(() => { armedStop = null; render(); }, 3000);
    render();
}
ctx.onDispose(() => clearTimeout(armedTimer));

// ------------------------------------------------------------------ keys
ctx.track(window, 'keydown', (e) => {
    if (!V.enabled) return;
    if (e.key === V.hotkey && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        if (detailId != null) closeDetail();
        else { railOff = !railOff; render(); }
        return;
    }
    if (detailId != null && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDetail(); }
}, { capture: true });

// ------------------------------------------------------------------ ticks
let since = 0;
ctx.every(500, () => {
    if (!V.enabled) return;
    if (host) { dedupe(); place(); }
    since += 500;
    const period = detailId != null ? POLL_MS : POLL_MS * 2;
    if (since >= period) { since = 0; refresh(); }
});
ctx.track(window, 'resize', place, { passive: true });
ctx.track(document, 'visibilitychange', place);

cuimod.onSessionChange((id) => {
    if (id === cliSid) return;
    const keepShell = !railOff && (sessionGap || agents.length > 0 || detailId != null);
    cliSid = id;
    agents = []; showAll = false; detailId = null;
    details.clear(); clearChat();
    setSessionGap(keepShell);
    render();
    refresh();
});

// ------------------------------------------------------------------ settings
function apply(v) {
    const wasMock = V.mock;
    V = Object.assign({}, DEF, v || {});
    if (!V.enabled) { clearChat(); detailId = null; setSessionGap(false); teardown(); return; }
    if (V.mock !== wasMock) { agents = []; details.clear(); clearChat(); detailId = null; }
    restyle();
    refresh();
    render();
}

// ------------------------------------------------------------------ dashboard
function previewCss(v, sel) {
    return `
${sel} .sa {
    --acc: ${v.accent};
    --fg: hsl(var(--text-100, 60 14% 97%));
    --fg2: hsl(var(--text-300, 55 9% 74%));
    --fg3: hsl(var(--text-500, 48 5% 57%));
    --hair2: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 5%, transparent);
    --wash: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 6%, transparent);
    --accw: color-mix(in srgb, ${v.accent} 16%, transparent);
    width: ${Math.round(v.railWidth)}px; font-size: ${v.size}px; line-height: 1.4;
    color: var(--fg2);
}
${sel} .sa-cap { display: flex; align-items: center; gap: 7px; padding: 0 5px 8px;
    font-size: .68em; letter-spacing: .17em; text-transform: uppercase;
    color: ${v.accent}; opacity: .6; }
${sel} .sa-cap i { flex: 1; font-style: normal; }
${sel} .sa-cap u { text-decoration: none; color: var(--fg3); letter-spacing: .12em; opacity: .8; }
${sel} .sa-row { position: relative; display: grid; grid-template-columns: 7px 1fr auto; gap: 8px;
    align-items: baseline; padding: 4px 5px 5px; border-radius: 7px; }
${sel} .sa-row.child { margin-left: 14px; }
${sel} .sa-row.child::before { content: ''; position: absolute; left: -9px; top: -4px;
    width: 7px; height: 14px; border-left: 1px solid var(--hair2);
    border-bottom: 1px solid var(--hair2); border-bottom-left-radius: 3px; opacity: .8; }
${sel} .sa-dot { width: 5px; height: 5px; border-radius: 50%; align-self: start;
    margin-top: 5px; background: currentColor; opacity: .4; }
${sel} .sa-row.live .sa-dot { background: ${v.accent}; opacity: 1;
    box-shadow: 0 0 7px color-mix(in srgb, ${v.accent} 70%, transparent); }
${sel} .sa-nm { font-size: .92em; font-weight: 500; color: var(--fg2); line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${sel} .sa-row.live .sa-nm { font-weight: 600; color: var(--fg); }
${sel} .sa-when { font-size: .74em; color: var(--fg3); white-space: nowrap; }
${sel} .sa-row.live .sa-when { color: ${v.accent}; }
${sel} .sa-slot { grid-column: 1 / -1; min-width: 0; padding-left: 15px; }
${sel} .sa-doing { margin-top: 3px; font-size: .7em;
    font-family: var(--font-mono, ui-monospace, monospace); color: var(--fg3);
    display: flex; gap: 6px; overflow: hidden; white-space: nowrap; }
${sel} .sa-doing b { color: color-mix(in srgb, ${v.accent} 74%, var(--fg)); font-weight: 600; }
${sel} .sa-bar { margin: 6px 5px 0 0; height: 1px; background: var(--hair2); overflow: hidden; }
${sel} .sa-bar i { display: block; height: 100%; width: 30%;
    background: linear-gradient(90deg, transparent, ${v.accent}, transparent);
    animation: sa-sweep 2.6s cubic-bezier(.2,.85,.3,1) infinite; }
@keyframes sa-sweep { from { transform: translateX(-110%); } to { transform: translateX(400%); } }
${sel} .sa-ghosts { margin-top: 10px; }
${sel} .sa-row.ghost { opacity: .3; padding-top: 2px; padding-bottom: 2px; }
${sel} .sa-row.ghost .sa-nm { font-weight: 400; font-size: .86em; }
${sel} .sa-row.ghost .sa-when { font-size: .7em; }
${sel} .sa-more { margin: 5px 5px 0; font-size: .7em; letter-spacing: .1em;
    text-transform: uppercase; color: var(--fg3); opacity: .45; padding: 4px 0; }
`;
}

const spec = {
    plugin: 'subagents',
    title: 'Subagents',
    description: 'A HUD of this session’s agents beside the composer; click one for its transcript and controls.',
    defaults: DEF,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled', group: 'Rail' },
        { key: 'mock', type: 'toggle', label: 'Demo data', group: 'Rail',
          hint: 'Fabricated agents, three of them running, so the live state can be looked at without a session that happens to have one.' },
        { key: 'hotkey', type: 'combo', label: 'Toggle key', group: 'Rail',
          options: [{ value: 'F2', label: 'F2' }, { value: 'F3', label: 'F3' },
                    { value: 'F4', label: 'F4' }, { value: 'F8', label: 'F8' },
                    { value: 'Home', label: 'Home' }, { value: 'PageUp', label: 'Page Up' }] },
        { key: 'stoppedLimit', type: 'slider', label: 'Ghosts shown', min: 0, max: 40, step: 1, unit: '',
          hint: 'How many finished agents remain visible in the hierarchy. Parents of visible agents stay shown.', group: 'Rail' },
        { key: 'railTop', type: 'slider', label: 'Drop below the title', min: 0, max: 260, step: 4, unit: 'px', group: 'Rail' },
        { key: 'railWidth', type: 'slider', label: 'Width', min: 200, max: 360, step: 4, unit: 'px', group: 'Rail' },
        { key: 'showThinking', type: 'toggle', label: 'Show thinking', group: 'Look',
          hint: 'Include the agent’s thinking blocks in its transcript.' },
        { key: 'accent', type: 'color', label: 'Running color',
          hint: 'The only color in the view; everything else is the app’s own ramp.', group: 'Look' },
        { key: 'size', type: 'slider', label: 'Text size', min: 10, max: 18, step: 0.5, unit: 'px', group: 'Look' },
    ],
    apply,
    preview: {
        title: 'Preview — the rail',
        beforeLabel: 'plugin defaults',
        afterLabel: 'your settings',
        node() {
            const box = el('div', 'sa');
            const cap = el('div', 'sa-cap');
            cap.append(el('span', null, '2 agents running'), el('i'), el('u', null, 'demo'));
            box.append(cap);

            for (const r of [
                { nm: 'rv-physics', when: '14m 52s', tool: 'Bash', doing: 'smq.py xref 0x86C510' },
                { nm: 'rd-audio', when: '2m 28s', tool: 'Grep', doing: 'pattern: mixer_ring_push', child: true },
            ]) {
                const row = el('div', 'sa-row live' + (r.child ? ' child' : ''));
                const mid = el('div');
                mid.append(el('div', 'sa-nm', r.nm));
                const slot = el('div', 'sa-slot');
                const doing = el('div', 'sa-doing');
                doing.append(el('b', null, r.tool), el('span', null, r.doing));
                const bar = el('div', 'sa-bar');
                bar.append(el('i'));
                slot.append(doing, bar);
                row.append(el('span', 'sa-dot'), mid, el('div', 'sa-when', r.when), slot);
                box.append(row);
            }

            const gh = el('div', 'sa-ghosts');
            for (const r of [
                { nm: 'rd-mco', when: '11m 8s' },
                { nm: 'rd-keys', when: '9m 46s' },
                { nm: 'rd-net-phys', when: '11m 52s' },
                { nm: 'rv-parts', when: '24m 51s' },
            ]) {
                const row = el('div', 'sa-row ghost');
                const mid = el('div');
                mid.append(el('div', 'sa-nm', r.nm));
                row.append(el('span', 'sa-dot'), mid, el('div', 'sa-when', r.when));
                gh.append(row);
            }
            gh.append(el('div', 'sa-more', '+4 more'));
            box.append(gh);
            return box;
        },
        css(v, sel, which) { return previewCss(which === 'before' ? DEF : v, sel); },
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});
if (REG.subs.size === 0) apply(DEF);

// ------------------------------------------------------------------ boot
cliSid = cuimod.sessionId || null;
refresh();
