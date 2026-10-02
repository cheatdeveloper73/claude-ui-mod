/* The scripted half of the scene: everything the new features show that is
 * not a stylesheet. Each export is a pure function of scene time, so a crop
 * that starts at second 48 sees exactly what the tour sees at second 48.
 *
 * The numbers here are invented; the shapes are not. Agent rows carry the
 * fields the subagents rail reads (name, type, tool, brief, spawn/end), the
 * throughput rows carry the fields the panel formats (ttft, hop, stream, out
 * tokens), and the queue rows carry the text, line count and enter/leave times
 * that decide which class the real stylesheet sees.
 */
import { interpolate } from 'remotion';

export const ramp = (t: number, a: number, b: number) =>
    interpolate(t, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const typed = (text: string, t: number, a: number, b: number) =>
    text.slice(0, Math.round(ramp(t, a, b) * text.length));

// ---------------------------------------------------------------- timeline
export const PK = {
    CURSOR_IN: 25.0,
    OPEN: 25.9,
    TAB: 27.45,
    PICK: 28.95,
    DRAG_FROM: 29.75,
    DRAG_TO: 30.65,
    CLOSE: 31.45,
};
export const TURN2_TYPE = [31.7, 33.2] as const;
export const TURN2_SEND = 33.3;
// A second visit to the picker, after the scene proper has settled: from the GPT
// model of the first visit to the Command Code tab and one of its models.
export const PK2 = {
    CURSOR_IN: 72.0,
    OPEN: 72.8,
    TAB: 74.1,
    PICK: 76.5,
    CLOSE: 77.7,
};
export const PHASE_A = [33.9, 37.4] as const;
export const AGENTS_IN = 37.6;
export const SHEET_OPEN = 40.7;
export const SHEET_CLOSE = 45.9;
export const TP_OPEN = 48.0;
export const TP_CLOSE = 54.4;
export const Q = {
    A_TYPE: [55.2, 56.6] as const,
    A_ENTER: 56.8,
    B_TYPE: [57.3, 58.5] as const,
    B_ENTER: 58.7,
    C_TYPE: [59.0, 59.9] as const,
    C_ENTER: 60.1,
    EDIT_CLICK: 60.95,
    EDIT_TYPE: [61.5, 62.7] as const,
    EDIT_COMMIT: 63.0,
    STEER_CLICK: 63.8,
    TRASH_ARM: 64.8,
    TRASH_CONFIRM: 65.6,
    TURN_END: 66.6,
    AUTO_SEND: 66.95,
};
export const PHASE_B = [64.5, 66.4] as const;
export const TURN3 = [67.4, 70.0] as const;
export const SCENE_END = 79.4;
export const SCENE_SETTLE = 71.0;

// ---------------------------------------------------------------- picker
export type Model = { id: string; name: string };
export const CLAUDE_MODELS: Model[] = [
    { id: 'opus-5-5', name: 'Opus 5.5' },
    { id: 'sonnet-5-5', name: 'Sonnet 5.5' },
    { id: 'haiku-4-5', name: 'Haiku 4.5' },
];
// Names and order are the shipped catalogue's (src/plugins/provider-picker/catalogue.json,
// and catalogue.private.json for the Command Code route).
export const GPT_MODELS: Model[] = [
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
    { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
];
export const META_MODELS: Model[] = [
    { id: 'muse-spark-1.3', name: 'Muse Spark 1.3' },
    { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
];
export const COMMAND_CODE_MODELS: Model[] = [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { id: 'glm-5.3', name: 'GLM 5.3' },
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max' },
    { id: 'minimax-m3', name: 'MiniMax M3' },
];
export const PROVIDERS = ['Claude', 'OpenAI', 'Meta', 'Command Code'];
export const TAB_MODELS: Model[][] = [CLAUDE_MODELS, GPT_MODELS, META_MODELS, COMMAND_CODE_MODELS];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABEL = ['Low', 'Medium', 'High', 'Extra high', 'Max'];

// Menu geometry. The popup is drawn by hand (see PickerMenu), so these are the
// mock's own numbers; they live here because the menu's height at a given time
// is part of the scripted state the pointer has to aim at.
export const PAD = 6;
export const STRIP_H = 38;
export const ROW_H = 34;
export const DIV_H = 13;
export const EFFORT_H = 84;
export const menuHeight = (rows: number, effort: boolean) =>
    PAD + STRIP_H + rows * ROW_H + (effort ? DIV_H + EFFORT_H : 0) + PAD;

const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
// The plugin animates the menu's height over 170ms on a tab change with
// cubic-bezier(.22,.8,.28,1), which is close to an ease-out cubic.
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const RESIZE = 0.17;

export function pickerAt(t: number) {
    const open =
        Math.max(
            ramp(t, PK.OPEN, PK.OPEN + 0.12) * (1 - ramp(t, PK.CLOSE, PK.CLOSE + 0.12)),
            ramp(t, PK2.OPEN, PK2.OPEN + 0.12) * (1 - ramp(t, PK2.CLOSE, PK2.CLOSE + 0.12)),
        );

    // First visit: Opus on high; a freshly picked GPT-6.1-Sol starts on its
    // catalogue default, low, until the native slider is dragged.
    if (t < PK2.OPEN - 1) {
        const picked = t >= PK.PICK;
        const pos = !picked ? 2 : 2 * ease(ramp(t, PK.DRAG_FROM, PK.DRAG_TO));
        const stop = Math.round(pos);
        return {
            open,
            tab: t >= PK.TAB ? 1 : 0,
            picked,
            pos,
            stop,
            model: picked ? 'GPT-6.1-Sol' : 'Opus 5.5',
            effort: EFFORTS[stop],
            hasEffort: true,
            h: menuHeight(3, true),
            dragging: t >= PK.DRAG_FROM && t <= PK.DRAG_TO,
        };
    }

    // Second visit: the menu opens on GPT-6.1-Sol's tab, on high. A Command Code
    // model declares no efforts, and page.js only gives a model a `thinking`
    // block when it has some, so the native selector has no effort section to
    // draw once one is checked: the menu loses the slider and the footer its label.
    const picked = t >= PK2.PICK;
    const h3 = menuHeight(3, true);
    const hCc = menuHeight(8, true);
    const hCcBare = menuHeight(8, false);
    const h = picked
        ? hCc + (hCcBare - hCc) * easeOut(ramp(t, PK2.PICK, PK2.PICK + RESIZE))
        : h3 + (hCc - h3) * easeOut(ramp(t, PK2.TAB, PK2.TAB + RESIZE));
    return {
        open,
        tab: t >= PK2.TAB ? 3 : 1,
        picked,
        pos: 2,
        stop: 2,
        model: picked ? 'Kimi K3' : 'GPT-6.1-Sol',
        effort: picked ? '' : EFFORTS[2],
        hasEffort: !picked,
        h,
        dragging: false,
    };
}

// ---------------------------------------------------------------- composer
export const USER2 = 'Now check the patcher against the next Squirrel layout. Split it up and run the pieces in parallel.';
export const Q_A = 'Also check that the watcher survives an app update mid-session.';
export const Q_A_ADD = ' Include the manual-update path, where the user installs over a running app.';
export const Q_B = 'Run the full selfcheck before you report back.';
export const Q_C = 'Skip the voice-agent files.';

export function composerAt(t: number) {
    let text = '';
    let editing = false;
    if (t >= TURN2_TYPE[0] && t < TURN2_SEND) text = typed(USER2, t, TURN2_TYPE[0], TURN2_TYPE[1]);
    else if (t >= Q.A_TYPE[0] && t < Q.A_ENTER) text = typed(Q_A, t, Q.A_TYPE[0], Q.A_TYPE[1]);
    else if (t >= Q.B_TYPE[0] && t < Q.B_ENTER) text = typed(Q_B, t, Q.B_TYPE[0], Q.B_TYPE[1]);
    else if (t >= Q.C_TYPE[0] && t < Q.C_ENTER) text = typed(Q_C, t, Q.C_TYPE[0], Q.C_TYPE[1]);
    else if (t >= Q.EDIT_CLICK && t < Q.EDIT_COMMIT) {
        editing = true;
        text = Q_A + typed(Q_A_ADD, t, Q.EDIT_TYPE[0], Q.EDIT_TYPE[1]);
    }
    const running = (t >= 33.4 && t < Q.TURN_END) || (t >= TURN3[0] && t < TURN3[1] + 0.3);
    const typing = text.length > 0 && (t < TURN2_SEND || (t >= 55 && t < Q.EDIT_COMMIT + 0.05));
    return { text, editing, running, caret: typing && Math.floor(t * 2.2) % 2 === 0 };
}

// ---------------------------------------------------------------- transcript
export const ASSIST_A = `Three independent concerns: the header repoint, the Squirrel directory layout, and the watcher's patch-on-close path. One agent for each, running now.`;
export const ASSIST_B = `All three agree. The repoint is length-preserving, the layout assumption holds for \`app-<version>\`, and the watcher patches a freshly downloaded version before it first launches.`;
export const ASSIST_C = `On it. The watcher already patches on download, so the mid-session case reduces to the file lock on \`app.asar\`.`;

export type Turn = { user: string; userAt: number; text: string; chars: number; final?: boolean };

export function turnsAt(t: number): Turn[] {
    const out: Turn[] = [];
    if (t >= TURN2_SEND) {
        out.push({
            user: USER2,
            userAt: TURN2_SEND,
            text: ASSIST_A,
            chars: Math.round(ramp(t, PHASE_A[0], PHASE_A[1]) * ASSIST_A.length),
        });
    }
    if (t >= Q.STEER_CLICK + 0.3) {
        out.push({
            user: Q_B,
            userAt: Q.STEER_CLICK + 0.3,
            text: ASSIST_B,
            chars: Math.round(ramp(t, PHASE_B[0], PHASE_B[1]) * ASSIST_B.length),
        });
    }
    if (t >= Q.AUTO_SEND + 0.1) {
        out.push({
            user: Q_A + Q_A_ADD,
            userAt: Q.AUTO_SEND + 0.1,
            text: ASSIST_C,
            chars: Math.round(ramp(t, TURN3[0], TURN3[1]) * ASSIST_C.length),
        });
    }
    return out;
}

/** Transcript scroll offset. Turn one's own tuning lives in Scene; from the new
 *  message on, the view follows the newest turn the way the app does. */
export function followScroll(t: number): number | null {
    if (t < TURN2_SEND) return null;
    const a = ramp(t, TURN2_SEND, TURN2_SEND + 0.45);
    const b = ramp(t, Q.STEER_CLICK + 0.3, Q.STEER_CLICK + 0.75);
    const c = ramp(t, Q.AUTO_SEND + 0.1, Q.AUTO_SEND + 0.55);
    // Once the last turn is done the view settles higher, so the second picker
    // visit opens over empty transcript rather than over the last line of text.
    const settle = ramp(t, SCENE_SETTLE, SCENE_SETTLE + 0.4);
    return 24 + 478 * ease(a) + 0 * b + 0 * c + 110 * ease(settle);
}

// ---------------------------------------------------------------- agents
export type Agent = {
    id: string;
    name: string;
    type: string;
    parent?: string;
    spawn: number;        // scene seconds at which it started (may precede the scene)
    end: number | null;   // scene seconds at which it finished
    stopped?: boolean;
    tools: [string, string][];
    toolOffset: number;
    last: string;
};

export const AGENTS: Agent[] = [
    {
        id: 'a1', name: 'rv-asar', type: 'reviewer',
        spawn: AGENTS_IN - 214, end: 62.0,
        toolOffset: 0,
        tools: [
            ['Read', 'file_path: src/patch/asar.js, offset: 120, limit: 60'],
            ['Grep', 'pattern: repointExeIntegrity, output_mode: content'],
            ['Read', 'file_path: src/patch/pe.js'],
            ['Bash', 'node selfcheck.js'],
            ['Read', 'file_path: docs/internals.md, offset: 40, limit: 80'],
        ],
        last: 'Header repoint is length-preserving; no PE relocation involved.',
    },
    {
        id: 'a2', name: 'rd-squirrel', type: 'reader', parent: 'a1',
        spawn: AGENTS_IN - 64, end: 50.5,
        toolOffset: 2,
        tools: [
            ['Grep', 'pattern: app-<version>, output_mode: content'],
            ['Read', 'file_path: src/watcher.js, offset: 1, limit: 80'],
            ['Bash', 'ls %LOCALAPPDATA%\\AnthropicClaude'],
            ['Read', 'file_path: install.ps1'],
        ],
        last: 'Each update lands in a fresh app-<version> directory.',
    },
    {
        id: 'a3', name: 'wk-watcher', type: 'worker', parent: 'a2',
        spawn: AGENTS_IN - 21, end: 42.0,
        toolOffset: 1,
        tools: [
            ['Bash', 'node patch.js apply --dry-run'],
            ['Edit', 'file_path: src/watcher.js'],
            ['Bash', 'node selfcheck.js'],
        ],
        last: 'Patch-on-download path verified, selfcheck clean.',
    },
];

export const dur = (ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

/** The rail repaints on its own poll, not on a clock: every 4s with no sheet
 *  open, every 2s with one. Row text is therefore stepped, not continuous. */
export const stepped = (t: number, every: number) => Math.floor(t / every) * every;

export function agentView(a: Agent, t: number, every = 4) {
    const live = t >= a.spawn && (a.end === null || t < a.end) && t >= AGENTS_IN - 0.01;
    const finished = a.end !== null && t >= a.end;
    const k = Math.floor(t / every);
    const [tool, what] = a.tools[(k + a.toolOffset) % a.tools.length];
    const since = stepped(t, every);
    const elapsed = live ? (since - a.spawn) * 1000 : a.end !== null ? (a.end - a.spawn) * 1000 : 0;
    return { live, finished, tool, what, elapsedLabel: dur(elapsed) };
}

export const liveCount = (t: number) => AGENTS.filter((a) => agentView(a, t).live).length;

// ---------------------------------------------------------------- throughput
const wob = (t: number, amp: number, f: number, ph = 0) => amp * Math.sin(t * f + ph);

/** What each live response is doing at time t. Mirrors the router's live rows:
 *  observedTps is present once the provider has reported a count. */
export type LiveRow = {
    key: string;
    title: string;
    tag: string;
    main: boolean;
    elapsedMs: number;
    ttftMs: number;
    tokens: number | null;
    tps: number;
    est: boolean;
    hue: number;
};

const HUE = { claude: 24, openai: 152 };

export function liveRowsAt(t: number): LiveRow[] {
    const rows: LiveRow[] = [];
    const mainA = t >= PHASE_A[0] + 0.2 && t < PHASE_A[1] + 0.3;
    const mainB = t >= PHASE_B[0] && t < PHASE_B[1] + 0.3;
    const mainC = t >= TURN3[0] && t < TURN3[1] + 0.3;
    if (mainA || mainB || mainC) {
        const start = mainA ? PHASE_A[0] : mainB ? PHASE_B[0] : TURN3[0];
        const el = (t - start) * 1000 + 600;
        const est = t - start < 1.1;
        const tps = 95.8 + wob(t, 3.1, 2.3);
        rows.push({
            key: 'main', title: 'gpt-6.1-sol', tag: 'main', main: true,
            elapsedMs: el, ttftMs: 640, tokens: est ? null : Math.round(tps * (el / 1000 - 0.6)),
            tps: est ? 108.4 : tps, est, hue: HUE.openai,
        });
    }
    for (const a of AGENTS) {
        const v = agentView(a, t, 4);
        if (!v.live) continue;
        const base = a.id === 'a1' ? 71.2 : a.id === 'a2' ? 64.5 : 58.9;
        const turnStart = stepped(t + 0.0, 5) - 0.3;
        const el = (t - turnStart) * 1000;
        rows.push({
            key: a.id, title: a.id === 'a1' ? 'claude-sonnet-5-5' : a.id === 'a2' ? 'claude-sonnet-5-5' : 'claude-sonnet-5-5',
            tag: a.name, main: false,
            elapsedMs: el, ttftMs: 410 + (a.id === 'a1' ? 90 : 0), tokens: Math.round((base * Math.max(0, el - 410)) / 1000),
            tps: base + wob(t, 2.6, 1.7, a.id.charCodeAt(1)), est: false, hue: HUE.claude,
        });
    }
    return rows;
}

/** The chip in the app's streaming strip: the live streams summed, a tilde
 *  while any of them is still on a calibrated estimate, and the last completed
 *  response's rate once nothing is streaming. */
export function chipAt(t: number): { label: string; kind: 'est' | 'exact' | 'settled' } | null {
    if (t < 34.3) return null;
    const rows = liveRowsAt(t);
    const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(0) : v.toFixed(1));
    if (!rows.length) return { label: fmt(91.4) + ' tok/s', kind: 'settled' };
    const sum = rows.reduce((s, r) => s + r.tps, 0);
    const est = rows.some((r) => r.est);
    return {
        label: (est ? '~' : '') + fmt(sum) + ' tok/s' + (rows.length > 1 ? ' ×' + rows.length : ''),
        kind: est ? 'est' : 'exact',
    };
}

export const CHIP_TITLE = {
    est: 'Estimated from measured chars per token for this model (38 responses). The provider reports its own count at the end of the stream.',
    exact: 'Exact: provider-reported tokens over this router’s clocks',
    settled: 'Last completed response: 812 tokens, 640ms to first token. Exact.',
};

export type PanelRow = { key: string; title: string; sub: string; tag: string; main: boolean; value: string; unit: string; hue: number; flow?: boolean; est?: boolean };

export const LANES: PanelRow[] = [
    { key: 'l1', title: 'Main session', sub: '9 resp · 6.9k out · ttft p50 590ms', tag: 'gpt-6.1-sol', main: true, value: '96.4', unit: 'sustained', hue: HUE.openai },
    { key: 'l2', title: 'rv-asar', sub: '5 resp · 11k out · ttft p50 480ms', tag: 'claude-sonnet-5-5', main: false, value: '71.0', unit: 'sustained', hue: HUE.claude },
    { key: 'l3', title: 'rd-squirrel', sub: '4 resp · 8.2k out · ttft p50 430ms', tag: 'claude-sonnet-5-5', main: false, value: '64.8', unit: 'sustained', hue: HUE.claude },
    { key: 'l4', title: 'wk-watcher', sub: '3 resp · 3.1k out · ttft p50 410ms', tag: 'claude-sonnet-5-5', main: false, value: '59.2', unit: 'sustained', hue: HUE.claude },
];

export const MODELS: PanelRow[] = [
    { key: 'm1', title: 'GPT-6.1-Sol', sub: '9 resp · 6.9k out · p90 104 · ttft p50 590ms', tag: 'openai', main: false, value: '96.4', unit: 'sustained', hue: HUE.openai },
    { key: 'm2', title: 'Sonnet 5.5', sub: '12 resp · 22k out · p90 78 · ttft p50 450ms', tag: 'claude', main: false, value: '68.1', unit: 'sustained', hue: HUE.claude },
];

export const RECENT: PanelRow[] = [
    { key: 'r1', title: 'gpt-6.1-sol', sub: '812 out (310 thinking) · ttft 640ms · gen 5.4s', tag: 'main', main: true, value: '150', unit: 'tok/s', hue: HUE.openai },
    { key: 'r2', title: 'claude-sonnet-5-5', sub: '1.3k out · ttft 410ms · gen 19s', tag: 'wk-watcher', main: false, value: '68.4', unit: 'tok/s', hue: HUE.claude },
    { key: 'r3', title: 'claude-sonnet-5-5', sub: '964 out · ttft 480ms · gen 13s', tag: 'rd-squirrel', main: false, value: '74.1', unit: 'tok/s', hue: HUE.claude },
    { key: 'r4', title: 'gpt-6.1-sol', sub: '604 out · ttft 570ms · gen 6.2s', tag: 'main', main: true, value: '97.4', unit: 'tok/s', hue: HUE.openai },
];

// ---------------------------------------------------------------- queue
export type QRow = {
    id: string;
    text: string;
    lines: number;
    enter: number;
    editing: boolean;
    exit: number | null;      // when it leaves the list
    kind: 'sent' | 'going' | null;
    armed: boolean;
};

const lineCount = (s: string) => (s.length > 92 ? 2 : 1);

export function queueAt(t: number): { rows: QRow[]; railIn: number; railOut: number | null; bumps: number[] } {
    const aText = t >= Q.EDIT_COMMIT ? Q_A + Q_A_ADD : Q_A;
    const rows: QRow[] = [
        {
            id: 'A', text: aText, lines: lineCount(aText), enter: Q.A_ENTER,
            editing: t >= Q.EDIT_CLICK && t < Q.EDIT_COMMIT,
            exit: Q.AUTO_SEND, kind: null, armed: false,
        },
        { id: 'B', text: Q_B, lines: 1, enter: Q.B_ENTER, editing: false, exit: Q.STEER_CLICK, kind: 'sent', armed: false },
        {
            id: 'C', text: Q_C, lines: 1, enter: Q.C_ENTER, editing: false,
            exit: Q.TRASH_CONFIRM, kind: 'going',
            armed: t >= Q.TRASH_ARM && t < Q.TRASH_CONFIRM,
        },
    ];
    return {
        rows: rows.filter((r) => t >= r.enter),
        railIn: Q.A_ENTER,
        railOut: Q.AUTO_SEND,
        bumps: [Q.A_ENTER, Q.B_ENTER, Q.C_ENTER, Q.STEER_CLICK, Q.TRASH_CONFIRM],
    };
}

/** Real row heights in the rail (padding 7+7, a 22px action cell or the
 *  clamped text, 1px rule between rows), measured against the shipped CSS. */
export const rowHeight = (lines: number, first: boolean) => 14 + Math.max(22, lines * 17.75) + (first ? 0 : 1);
