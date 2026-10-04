'use strict';
/* transcript-copy: the delta export.
 *
 * Everything here runs against a synthetic jsonl in a fake HOME, because the
 * whole feature is about which lines of a real transcript file end up in the
 * clipboard and which do not. The clipboard is stubbed as a string, so the
 * assertions can read exactly what a paste would have carried.
 *
 * Two rules the suite is protecting:
 *
 *   Nothing is written into an export to make the next delta possible. The
 *   alignment tests deliberately mangle the clipboard -- reflow it, truncate
 *   it, change its format, cut its head off -- and still expect the right cut.
 *
 *   A delta either resumes at a point it can prove, or it copies nothing.
 *   Silently re-sending a whole session into a chat window that was expecting
 *   three turns is the failure that matters.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SID = '11111111-2222-3333-4444-555555555555';
const PLUGIN = path.join(__dirname, '..', 'src', 'plugins', 'transcript-copy', 'main.js');

// One rig per test: a fake home holding the transcript, a fake plugin directory
// three levels above a .state the plugin will write its marks into, and a
// clipboard that is just a variable.
function rig() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcdelta-'));
    process.env.USERPROFILE = root;
    process.env.HOME = root;
    assert.equal(os.homedir(), root, 'homedir override did not take');

    const proj = path.join(root, '.claude', 'projects', 'C--fake');
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, SID + '.jsonl');

    const dir = path.join(root, 'mod', 'src', 'plugins', 'transcript-copy');
    fs.mkdirSync(dir, { recursive: true });

    const methods = new Map();
    const state = { clip: '' };
    // main.js caches the projects scan and the mark file in module-and-closure
    // state, so each rig needs its own instance of the factory.
    delete require.cache[require.resolve(PLUGIN)];
    require(PLUGIN)({
        boot: { MOD_DIR: path.join(root, 'mod') },
        dir,
        log: () => {},
        method: (m, fn) => methods.set(m, fn),
        onDispose: () => {},
        every: () => {},
        watch: () => {},
        electron: { clipboard: { writeText: (s) => { state.clip = s; }, readText: () => state.clip } },
    });

    let u = 0;
    const uuid = () => { u++; return '00000000-0000-4000-8000-' + String(u).padStart(12, '0'); };

    return {
        root, file, state,
        marks: path.join(root, 'mod', '.state', 'transcript-delta.json'),
        copy: (o) => methods.get('copy')({ cliSid: SID, options: o || {} }),
        delta: (o) => methods.get('copyDelta')({ cliSid: SID, options: o || {} }),
        peek: (o) => methods.get('deltaPeek')({ cliSid: SID, options: o || {} }),
        user: (text) => JSON.stringify({ type: 'user', uuid: uuid(), promptSource: 'sdk', cwd: 'C:\\fake',
            gitBranch: 'main', timestamp: '2026-09-06T10:00:00.000Z', message: { role: 'user', content: text } }),
        assistant: (think, text) => JSON.stringify({ type: 'assistant', uuid: uuid(),
            timestamp: '2026-09-06T10:00:30.000Z', message: { role: 'assistant', model: 'claude-opus-5',
                content: [{ type: 'thinking', thinking: think }, { type: 'text', text }] } }),
        append: (...lines) => fs.appendFileSync(file, lines.join('\n') + '\n'),
        cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
    };
}

const Q1 = 'First question, about the packet header and its fourth field alignment problem.';
const A1 = 'The client reads a u16 where the server writes a u32, so it lands one short.';
const Q2 = 'Second question, this time about the tick counter wrapping at sixteen bits.';
const A2 = 'Compare with a wrapped difference instead of a direct less-than comparison.';
const Q3 = 'Third question, asked after the first export had already been pasted elsewhere.';
const A3 = 'Only this reply is new, and it is the one the delta has to carry across.';
const Q4 = 'Fourth question, asked after the delta itself had been pasted into that window.';

// Bodies long enough to identify a turn. Anything under 40 characters is
// deliberately unmatchable, so the fixtures do not lean on short ones.
function seed(r) {
    r.append(
        r.user(Q1),
        r.assistant('Read the struct before guessing at the tick math or anything else here.', A1),
        r.user(Q2),
        r.assistant('Tick math wraps at 65536 and the comparison is signed, which is the bug.', A2));
}
function extend(r) {
    r.append(r.user(Q3),
        r.assistant('This block is new and must be the only assistant reasoning in the delta.', A3));
}

test('a full export carries the session and writes no machine anchor into it', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    assert.equal(r.copy().ok, true);
    assert.equal((r.state.clip.match(/^<user /gm) || []).length, 2);
    assert.equal((r.state.clip.match(/^<assistant /gm) || []).length, 2);
    assert.equal(/anchor/i.test(r.state.clip), false, 'the export is text a human reads, not a protocol');
    assert.equal(fs.existsSync(r.marks), true, 'the copy still remembers where it ended, privately');
});

test('a delta with nothing new refuses and leaves the clipboard intact', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    const before = r.state.clip;
    const out = r.delta();
    assert.equal(out.ok, false);
    assert.equal(out.empty, true);
    assert.equal(r.state.clip, before);
    assert.equal(r.peek().empty, true);
});

test('a delta lines up against the export sitting on the clipboard', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    extend(r);

    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(out.how, 'clipboard');
    assert.ok(out.matched >= 2, 'the cut must rest on a run, not a single hit');
    assert.equal(out.entries, 3);                       // prompt, thinking, reply
    assert.match(r.state.clip, /part="delta"/);
    assert.match(r.state.clip, /Continuation of a Claude Code transcript/);
    assert.equal(r.state.clip.includes(Q1), false);
    assert.equal(r.state.clip.includes(Q3), true);
});

test('a transcript this plugin never wrote still lines up', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    extend(r);
    // No header, no tags, no anchor: just the turns, as another tool or a
    // person might have pasted them.
    r.state.clip = [Q1, A1, Q2, A2].join('\n\n');

    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(out.how, 'clipboard');
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q1), false);
});

test('reflowed and re-indented text lines up', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    const mangled = r.state.clip.replace(/ /g, '\n      ').replace(/\n{2,}/g, '\n');
    extend(r);

    r.state.clip = mangled;
    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(out.how, 'clipboard');
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q2), false);
});

test('only the tail of an export on the clipboard still lines up', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    // Everything before the second turn cut away, the way a paste that was
    // trimmed to fit a context window would arrive.
    const tail = r.state.clip.slice(r.state.clip.indexOf(Q2));
    extend(r);

    r.state.clip = tail;
    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q2), false);
});

test('an export made in the other format lines up', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy({ format: 'markdown' });
    extend(r);

    const out = r.delta({ format: 'tags' });
    assert.equal(out.ok, true);
    assert.equal(out.how, 'clipboard');
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q1), false);
});

test('an export made with different toggles lines up across the gap', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy({ thinking: false });          // the earlier export carried no reasoning
    extend(r);

    const out = r.delta({ thinking: true });
    assert.equal(out.ok, true);
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q2), false);
});

test('an export truncated by a tighter length cap lines up', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy({ textMax: 50 });              // every body cut mid-sentence
    extend(r);

    const out = r.delta({ textMax: 0 });
    assert.equal(out.ok, true);
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q2), false);
});

test('deltas chain: the second lines up against the first', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    extend(r);
    r.delta();                            // clipboard now holds a mid-session window
    r.append(r.user(Q4));

    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(out.how, 'clipboard');
    assert.equal(out.entries, 1);
    assert.equal(r.state.clip.includes(Q4), true);
    assert.equal(r.state.clip.includes(Q3), false);
});

test('the remembered end of the last copy carries the delta when the clipboard has moved on', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();
    extend(r);
    r.state.clip = 'something else entirely, copied from a different window since then';

    const out = r.delta();
    assert.equal(out.ok, true);
    assert.equal(out.how, 'mark');
    assert.equal(r.state.clip.includes(Q3), true);
    assert.equal(r.state.clip.includes(Q1), false);
});

test('one coincidental line of overlap is not an alignment', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    extend(r);
    // A single turn of this session quoted inside an unrelated document. Taking
    // it as the cut would silently drop everything before it.
    r.state.clip = 'notes from somewhere else\n\n' + A1 + '\n\nand more unrelated writing after it';

    const out = r.delta({ deltaAnchor: 'clipboard' });
    assert.equal(out.ok, false, 'a lone hit must lose to no alignment at all');
});

test('another session on the clipboard is refused, not guessed at', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.state.clip = '<transcript session="99999999-9999-4999-8999-999999999999">\n<user>\n'
        + 'A completely different conversation about shader compilation and nothing else.\n</user>\n</transcript>';
    const out = r.delta({ deltaAnchor: 'clipboard' });
    assert.equal(out.ok, false);
});

test('with nothing to line up against, the default refuses rather than sending everything', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.state.clip = 'unrelated text';

    const out = r.delta();
    assert.equal(out.ok, false);
    assert.equal(out.empty, undefined);
    assert.equal(r.state.clip, 'unrelated text', 'a refusal must not touch the clipboard');

    const fallback = r.delta({ deltaFallback: 'full' });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.how, 'full');
    assert.equal(r.state.clip.includes(Q1), true);
    assert.equal(/part="delta"/.test(r.state.clip), false, 'a whole session must not claim to be a continuation');
});

test('the clipboard wins over the remembered end when they disagree', (t) => {
    const r = rig(); t.after(r.cleanup);
    seed(r);
    r.copy();                             // mark and clipboard agree: end of turn 2
    extend(r);
    r.delta();                            // mark moves to the end of turn 3
    r.append(r.user(Q4));

    // Back to the older export: the other window only ever saw the first two
    // turns, so that is what the delta must resume from.
    r.state.clip = [Q1, A1, Q2, A2].join('\n\n');
    const out = r.delta();
    assert.equal(out.how, 'clipboard');
    assert.equal(r.state.clip.includes(Q3), true, 'the window that got the old paste needs turn three again');
    assert.equal(r.state.clip.includes(Q4), true);
});
