import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { AppShell, Meta } from './AppShell';
import { TaskRail } from './TaskRail';
import { UsageBar } from './UsageBar';
import { Dashboard } from './Dashboard';
import { PickerMenu, TRIGGER, MENU_LEFT, MENU_TOP, MENU_W, tabCenter, rowCenter, rowCenterAt, stopX, SLIDER_Y } from './PickerMenu';
import { Subagents, sheetAgentAt, RAIL_X, RAIL_Y, RAIL_W } from './Subagents';
import { Queue } from './Queue';
import { Pointer, Waypoint, pointerAt, pressedAt } from './Pointer';
import { Sheets } from './theme';
import { W, H, COL_X, COL_W, COMPOSER_TOP } from './layout';
import { tasksAt, contextAt, ASSISTANT } from './mock';
import {
    ramp, PK, PK2, TAB_MODELS, Q, TURN2_SEND, PHASE_A, PHASE_B, TURN3, TP_OPEN, TP_CLOSE, SHEET_OPEN, SHEET_CLOSE,
    pickerAt, menuHeight, composerAt, turnsAt, followScroll, chipAt, CHIP_TITLE, EFFORTS, SCENE_END,
} from './story';

/* One timeline for everything. Every composition renders this same scene; the
 * crops differ only in which rectangle of it they show and where they start.
 *
 * Times are absolute seconds so a crop can be dropped anywhere on the tour
 * without rewriting the choreography.
 */

export const DURATION = SCENE_END;
export const CAPTION_H = 74;

// ---------------------------------------------------------------- timeline
export const RAIL_IN = 0.8;
export const STREAM_FROM = 1.0;
export const STREAM_TO = 7.4;
export const USAGE_IN = 3.0;
export const DASH_OPEN = 9.6;
export const DASH_SHOWN = 9.95;
export const MARK_AT = 12.35;
export const DRAG_FROM = 13.1;
export const DRAG_TO = 14.0;
export const DASH_CLOSE = 14.9;
export const DASH_GONE = 15.15;
export const TYPE_AT = 16.4;
export const COLLAPSE_AT = 18.4;
export const EXPAND_AT = 20.4;
export const DETAILS_AT = 22.0;

const CAPTIONS: [number, number, string][] = [
    [0.9, 3.2, 'task-rail — the live task list of the session this window is showing'],
    [3.4, 6.0, 'usage-bar — context in the empty middle of the composer footer, with the compaction mark where the CLI says it fires'],
    [6.2, 9.3, 'rows fade and the rail re-tweens as the agent flips a task'],
    [9.9, 12.2, 'Insert — the dashboard, with 1:1 before/after frames beside it'],
    [12.4, 14.7, 'a setting lands in the running app as it is changed'],
    [16.5, 18.1, 'transcript typography and thinking blocks, restyled through the app’s own tokens'],
    [18.6, 21.4, 'the rail minimises to the composer’s own height, and comes back'],
    [21.9, 24.2, 'descriptions fade in top-down as the box grows'],
    [25.6, 28.8, 'provider-picker — provider tabs inside the native model picker'],
    [28.9, 31.3, 'switch this conversation to a GPT model, then set its effort on the native slider'],
    [34.5, 37.3, 'throughput — live tokens per second, measured at the router, in the stream’s own strip'],
    [37.8, 40.4, 'subagents — who is running, on which tool, for how long; finished ones fade below'],
    [40.9, 45.6, 'click an agent for its full transcript, read from the CLI’s own per-agent files'],
    [48.2, 51.4, 'the dashboard readout: upstream hop, prefill (ttft) and generation, split per lane'],
    [51.6, 54.2, 'main session against each subagent, attributed from the CLI transcript'],
    [55.4, 60.0, 'queue — Enter mid-turn lands the message in a rail above the prompt'],
    [60.6, 66.0, 'edit pulls it back into the composer, steer injects it now, delete asks twice'],
    [66.9, 70.0, 'auto-send fires the head of the queue as the turn ends'],
    [72.9, 74.0, 'provider-picker — a fourth provider, Command Code, is one more tab in the same row'],
    [74.2, 77.6, 'eight models on its tab; one with no efforts takes the effort slider away'],
];

/** The tour plays the scene through these windows, in order. Crops play the
 *  scene straight, at their own offsets. */
export const TOUR_WINDOWS: [number, number][] = [
    [0, 25],
    [25.4, 31.8],
    [33.4, 43.4],
    [45.4, 46.6],
    [48.2, 54.2],
    [55.7, 70.3],
];
export const TOUR_SECONDS = TOUR_WINDOWS.reduce((s, [a, b]) => s + (b - a), 0);

export function tourTime(sec: number, windows = TOUR_WINDOWS): { t: number; local: number; index: number } {
    let acc = 0;
    for (let i = 0; i < windows.length; i++) {
        const [a, b] = windows[i];
        if (sec < acc + (b - a) || i === windows.length - 1) {
            const local = Math.min(sec - acc, b - a);
            return { t: a + local, local, index: i };
        }
        acc += b - a;
    }
    return { t: 0, local: 0, index: 0 };
}

export type SceneState = ReturnType<typeof stateAt>;

const clampInterp = (t: number, xs: number[], ys: number[]) =>
    interpolate(t, xs, ys, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

export function stateAt(t: number) {
    const usageOpen = ramp(t, DASH_OPEN, DASH_SHOWN) * (1 - ramp(t, DASH_CLOSE, DASH_GONE));
    const tpOpen = ramp(t, TP_OPEN, TP_OPEN + 0.35) * (1 - ramp(t, TP_CLOSE, TP_CLOSE + 0.3));
    const dashOpen = Math.max(usageOpen, tpOpen);
    const idle = interpolate(t, [DRAG_FROM, DRAG_TO], [0.55, 0.82], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    const markOff = t >= MARK_AT;

    // The "saved" tag flashes after each write; the store debounces at 250ms.
    const savedFlash = (at: number) =>
        interpolate(t, [at, at + 0.12, at + 1.1, at + 1.35], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });
    const saved = Math.max(savedFlash(MARK_AT + 0.25), savedFlash(DRAG_TO + 0.25));

    const collapse = ramp(t, COLLAPSE_AT, COLLAPSE_AT + 0.14) * (1 - ramp(t, EXPAND_AT, EXPAND_AT + 0.14));

    // Turn one scrolls with its own stream, then back up before the typography
    // change; from the second message on the view follows the newest turn.
    const follow = followScroll(t);
    const scroll =
        follow !== null
            ? follow
            : interpolate(t, [1.2, STREAM_TO, TYPE_AT - 1.2, TYPE_AT - 0.4], [0, 232, 232, 24], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
              });

    // The readout is taller than its page: it is scrolled to lanes, then to the
    // recent responses.
    const tpScroll = clampInterp(t, [50.0, 51.7, 52.3, 53.6], [0, 250, 250, 470]);

    return {
        t,
        tasks: tasksAt(t),
        railShow: t >= RAIL_IN,
        collapse,
        chars: Math.round(
            interpolate(t, [STREAM_FROM, STREAM_TO], [0, ASSISTANT.length], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
            }),
        ),
        scroll,
        usageShow: t >= USAGE_IN,
        tokens: contextAt(t),
        markOff,
        idle,
        dashOpen,
        dashPage: (t < 30 ? 'usage-bar' : 'throughput') as 'usage-bar' | 'throughput',
        tpScroll,
        saved,
        expanded: t >= DETAILS_AT,
        thinkingStyled: t >= TYPE_AT,
        type: t >= TYPE_AT ? { size: 14, leading: 1.35, face: 'Verdana, Geneva, sans-serif' } : null,
    };
}

// ---------------------------------------------------------------- pointer
const row = (y: number) => y;
void row;

const CC_H = menuHeight(8, true);

const STROKES: Waypoint[][] = [
    // the dashboard: rest, to the compaction-mark switch, click, down to the
    // idle-opacity slider, drag right, then away
    [
        [DASH_SHOWN, 980, 700],
        [MARK_AT - 0.55, 726, 441],
        [MARK_AT + 0.35, 726, 441],
        [DRAG_FROM - 0.1, 600, 585],
        [DRAG_TO, 644, 585],
        [DASH_CLOSE, 700, 520],
    ],
    // the model picker: trigger, OpenAI tab, GPT-6.1-Sol, the effort slider, away
    [
        [PK.CURSOR_IN, 1290, 640],
        [PK.OPEN - 0.1, TRIGGER.x, TRIGGER.y],
        [PK.OPEN + 0.25, TRIGGER.x, TRIGGER.y],
        [PK.TAB - 0.15, tabCenter(1).x, tabCenter(1).y],
        [PK.TAB + 0.2, tabCenter(1).x, tabCenter(1).y],
        [PK.PICK - 0.15, rowCenter(1).x, rowCenter(1).y],
        [PK.PICK + 0.3, rowCenter(1).x, rowCenter(1).y],
        [PK.DRAG_FROM - 0.1, stopX(0), SLIDER_Y],
        [PK.DRAG_TO, stopX(2), SLIDER_Y],
        [PK.CLOSE - 0.1, 640, 560],
        [PK.CLOSE + 0.2, 640, 560],
    ],
    // the same picker again: trigger, the Command Code tab, down its list to Kimi K3, away
    [
        [PK2.CURSOR_IN, 1290, 640],
        [PK2.OPEN - 0.1, TRIGGER.x, TRIGGER.y],
        [PK2.OPEN + 0.25, TRIGGER.x, TRIGGER.y],
        [PK2.TAB - 0.2, tabCenter(3).x, tabCenter(3).y],
        [PK2.TAB + 0.2, tabCenter(3).x, tabCenter(3).y],
        [PK2.TAB + 0.75, rowCenterAt(0, CC_H).x, rowCenterAt(0, CC_H).y],
        [PK2.TAB + 1.15, rowCenterAt(1, CC_H).x, rowCenterAt(1, CC_H).y],
        [PK2.TAB + 1.55, rowCenterAt(3, CC_H).x, rowCenterAt(3, CC_H).y],
        [PK2.PICK - 0.15, rowCenterAt(5, CC_H).x, rowCenterAt(5, CC_H).y],
        [PK2.PICK + 0.3, rowCenterAt(5, CC_H).x, rowCenterAt(5, CC_H).y],
        [PK2.CLOSE - 0.1, 640, 560],
        [PK2.CLOSE + 0.2, 640, 560],
    ],
    // the throughput chip: rest on it while its tooltip comes up
    [
        [34.6, 760, 330],
        [35.1, 612, 200],
        [37.0, 612, 200],
    ],
    // an agent row, the sheet it opens, and the way back
    [
        [38.6, 700, 420],
        [40.45, RAIL_X + 90, RAIL_Y + 44],
        [40.85, RAIL_X + 90, RAIL_Y + 44],
        [41.8, 900, 380],
        [45.0, 900, 380],
        [45.65, 500, 112],
        [46.05, 500, 112],
    ],
    // the queue: edit, steer, delete (twice)
    [
        [60.3, 1050, 560],
        [Q.EDIT_CLICK - 0.12, 1146, 639],
        [Q.EDIT_CLICK + 0.25, 1146, 639],
        [Q.EDIT_COMMIT - 0.4, 1000, 600],
        [Q.STEER_CLICK - 0.1, 1122, 676],
        [Q.STEER_CLICK + 0.3, 1122, 676],
        [Q.TRASH_ARM - 0.2, 1170, 713],
        [Q.TRASH_CONFIRM + 0.25, 1170, 713],
        [Q.TRASH_CONFIRM + 0.8, 1000, 560],
    ],
];

const PRESSES: [number, number][] = [
    [MARK_AT - 0.09, MARK_AT + 0.12],
    [DRAG_FROM, DRAG_TO],
    [PK.OPEN - 0.05, PK.OPEN + 0.12],
    [PK.TAB - 0.05, PK.TAB + 0.12],
    [PK.PICK - 0.05, PK.PICK + 0.12],
    [PK.DRAG_FROM, PK.DRAG_TO],
    [PK.CLOSE - 0.05, PK.CLOSE + 0.1],
    [PK2.OPEN - 0.05, PK2.OPEN + 0.12],
    [PK2.TAB - 0.05, PK2.TAB + 0.12],
    [PK2.PICK - 0.05, PK2.PICK + 0.12],
    [PK2.CLOSE - 0.05, PK2.CLOSE + 0.1],
    [SHEET_OPEN - 0.1, SHEET_OPEN + 0.1],
    [45.7, 45.88],
    [Q.EDIT_CLICK - 0.05, Q.EDIT_CLICK + 0.12],
    [Q.STEER_CLICK - 0.05, Q.STEER_CLICK + 0.12],
    [Q.TRASH_ARM - 0.05, Q.TRASH_ARM + 0.12],
    [Q.TRASH_CONFIRM - 0.05, Q.TRASH_CONFIRM + 0.12],
];

const strip = (t: number): Meta | null => {
    if (t < TURN2_SEND) return null;
    const start = t >= Q.AUTO_SEND + 0.1 ? Q.AUTO_SEND + 0.1 : t >= Q.STEER_CLICK + 0.3 ? Q.STEER_CLICK + 0.3 : TURN2_SEND;
    const win = t >= Q.AUTO_SEND + 0.1 ? TURN3 : t >= Q.STEER_CLICK + 0.3 ? PHASE_B : PHASE_A;
    // turn three's clock stops with the turn
    const secs = Math.max(0, Math.floor((start === Q.AUTO_SEND + 0.1 ? Math.min(t, TURN3[1] + 0.3) : t) - start));
    const tokens = Math.round(96 * Math.max(0, Math.min(t, win[1]) - win[0] - 0.6));
    const chip = chipAt(t);
    const tooltip = t >= 35.6 && t < 37.2 && chip ? CHIP_TITLE[chip.kind as keyof typeof CHIP_TITLE] : null;
    return {
        elapsed: secs + 's',
        tokens: tokens.toLocaleString() + ' tokens',
        chip,
        tooltip,
    };
};

export const Scene: React.FC<{
    offset?: number;
    captions?: boolean;
    tour?: boolean;
    windows?: [number, number][];
}> = ({ offset = 0, captions = false, tour = false, windows }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const tt = windows ? tourTime(frame / fps, windows) : tour ? tourTime(frame / fps) : null;
    const t = tt ? tt.t : offset + frame / fps;
    const s = stateAt(t);
    const picker = pickerAt(t);
    const composer = composerAt(t);
    const ptr = pointerAt(STROKES, t);
    const pressed = pressedAt(PRESSES, t);

    const hoverRow = (() => {
        if (!ptr || picker.open <= 0) return null;
        for (let i = 0; i < TAB_MODELS[picker.tab].length; i++) {
            const c = rowCenterAt(i, picker.h);
            if (ptr.x > MENU_LEFT && ptr.x < MENU_LEFT + MENU_W && Math.abs(ptr.y - c.y) < 17) return i;
        }
        return null;
    })();

    // The window dips from black at each cut in the tour.
    const cut = tt && tt.index > 0 ? 1 - ramp(tt.local, 0, 0.2) : 0;

    return (
        <AbsoluteFill style={{ background: '#000' }}>
            <Sheets />
            {/* The window box carries a transform so it is the containing block
                for the plugins' position:fixed — they anchor to the mock window,
                not to the video frame, which is what makes a caption strip (and
                every crop) possible at all. */}
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: W,
                    height: H,
                    overflow: 'hidden',
                    transform: 'translate(0px, 0px)',
                }}
            >
                <AppShell
                    chars={s.chars}
                    thinkingStyled={s.thinkingStyled}
                    type={s.type}
                    scroll={s.scroll}
                    t={t}
                    turns={turnsAt(t)}
                    meta={strip(t)}
                    composer={composer}
                    footer={{ model: picker.model, effort: picker.effort, open: picker.open > 0.5 }}
                />
                <TaskRail
                    t={t}
                    tasks={s.tasks}
                    show={s.railShow}
                    expanded={s.expanded}
                    collapsed={s.collapse > 0.5}
                    collapseProgress={s.collapse}
                />
                <UsageBar tokens={s.tokens} show={s.usageShow} mark={!s.markOff} opacity={s.idle} />
                <Subagents t={t} sheetAgent={sheetAgentAt(t)} />
                <Queue t={t} pointer={ptr} />
                <PickerMenu t={t} hoverRow={hoverRow} />
                <Dashboard
                    open={s.dashOpen}
                    page={s.dashPage}
                    mark={!s.markOff}
                    idle={s.idle}
                    saved={s.saved}
                    dragging={t >= DRAG_FROM && t <= DRAG_TO}
                    t={t}
                    scroll={s.tpScroll}
                />
                {ptr && <Pointer x={ptr.x} y={ptr.y} a={ptr.a} pressed={pressed} />}
                {cut > 0 && <div style={{ position: 'absolute', inset: 0, background: '#000', opacity: cut, zIndex: 2147483647 }} />}
            </div>
            {captions && <Caption t={t} />}
        </AbsoluteFill>
    );
};

const Caption: React.FC<{ t: number }> = ({ t }) => {
    const hit = CAPTIONS.find(([a, b]) => t >= a - 0.25 && t <= b + 0.3);
    const [a, b, text] = hit || [0, 0, ''];
    const o = hit ? Math.min(ramp(t, a - 0.25, a + 0.1), 1 - ramp(t, b, b + 0.3)) : 0;
    return (
        <div
            style={{
                position: 'absolute',
                left: 0,
                top: H,
                width: W,
                height: CAPTION_H,
                background: '#000',
                borderTop: '1px solid rgba(255,255,255,.07)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <div
                style={{
                    color: 'hsl(var(--text-200))',
                    font: '500 20px/1.3 var(--font-ui)',
                    letterSpacing: '.01em',
                    opacity: o,
                    transform: `translateY(${interpolate(o, [0, 1], [3, 0])}px)`,
                }}
            >
                {text}
            </div>
        </div>
    );
};

void rowCenter; void COL_X; void COL_W; void COMPOSER_TOP; void EFFORTS; void MENU_TOP; void SHEET_CLOSE; void RAIL_W;
