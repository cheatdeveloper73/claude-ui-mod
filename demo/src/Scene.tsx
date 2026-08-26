import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { AppShell } from './AppShell';
import { TaskRail } from './TaskRail';
import { UsageBar } from './UsageBar';
import { Dashboard } from './Dashboard';
import { Sheets } from './theme';
import { W, H, SIDEBAR, TITLEBAR } from './layout';
import { tasksAt, contextAt, ASSISTANT } from './mock';

/* One timeline for everything. Every composition renders this same scene; the
 * crops differ only in which rectangle of it they show and where they start.
 *
 * Times are absolute seconds so a crop can be dropped anywhere on the tour
 * without rewriting the choreography.
 */

export const DURATION = 25;
export const CAPTION_H = 74;

const ramp = (t: number, a: number, b: number) =>
    interpolate(t, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

// ---------------------------------------------------------------- timeline
export const RAIL_IN = 0.8;
export const STREAM_FROM = 1.0;
export const STREAM_TO = 7.4;
export const USAGE_IN = 3.0;
export const DASH_OPEN = 9.6;
export const DASH_SHOWN = 9.95;
export const SPARK_AT = 12.35;
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
    [3.4, 6.0, 'usage-bar — context and rate limits, in the empty middle of the composer footer'],
    [6.2, 9.3, 'rows fade and the rail re-tweens as the agent flips a task'],
    [9.9, 12.2, 'Insert — the dashboard, with 1:1 before/after frames beside it'],
    [12.4, 14.7, 'a setting lands in the running app as it is changed'],
    [16.5, 18.1, 'transcript typography and thinking blocks, restyled through the app’s own tokens'],
    [18.6, 21.4, 'the rail minimises to the composer’s own height, and comes back'],
    [21.9, 23.2, 'descriptions fade in top-down as the box grows'],
    [23.4, 24.8, 'all of it hot — save the file, the change is live, nothing restarts'],
];

export type SceneState = ReturnType<typeof stateAt>;

export function stateAt(t: number) {
    const dashOpen = ramp(t, DASH_OPEN, DASH_SHOWN) * (1 - ramp(t, DASH_CLOSE, DASH_GONE));
    const idle = interpolate(t, [DRAG_FROM, DRAG_TO], [0.55, 0.82], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    const spark = t >= SPARK_AT;

    // The "saved" tag flashes after each write; the store debounces at 250ms.
    const savedFlash = (at: number) =>
        interpolate(t, [at, at + 0.12, at + 1.1, at + 1.35], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        });
    const saved = Math.max(savedFlash(SPARK_AT + 0.25), savedFlash(DRAG_TO + 0.25));

    const collapse = ramp(t, COLLAPSE_AT, COLLAPSE_AT + 0.14) * (1 - ramp(t, EXPAND_AT, EXPAND_AT + 0.14));

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
        // Scrolls with the stream, then back up before the typography change —
        // the thinking block is above the fold by then and it is the point.
        scroll: interpolate(t, [1.2, STREAM_TO, TYPE_AT - 1.2, TYPE_AT - 0.4], [0, 232, 232, 24], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
        }),
        usageShow: t >= USAGE_IN,
        tokens: contextAt(t),
        spark,
        idle,
        dashOpen,
        saved,
        expanded: t >= DETAILS_AT,
        thinkingStyled: t >= TYPE_AT,
        type: t >= TYPE_AT ? { size: 14, leading: 1.35, face: 'Verdana, Geneva, sans-serif' } : null,
    };
}

// The pointer path through the dashboard: rest, to the Sparkline switch, click,
// down to the Idle opacity slider, drag right, then away.
function cursorAt(t: number) {
    if (t < DASH_SHOWN || t > DASH_CLOSE) return null;
    const pts: [number, number, number][] = [
        [DASH_SHOWN, 980, 700],
        [SPARK_AT - 0.55, 746, 610],
        [SPARK_AT + 0.35, 746, 610],
        [DRAG_FROM - 0.1, 615, 559],
        [DRAG_TO, 663, 559],
        [DASH_CLOSE, 720, 500],
    ];
    for (let i = 0; i < pts.length - 1; i++) {
        const [t0, x0, y0] = pts[i];
        const [t1, x1, y1] = pts[i + 1];
        if (t >= t0 && t <= t1) {
            const k = interpolate(t, [t0, t1], [0, 1]);
            const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            return { x: x0 + (x1 - x0) * e, y: y0 + (y1 - y0) * e };
        }
    }
    return { x: pts[pts.length - 1][1], y: pts[pts.length - 1][2] };
}

const pressedAt = (t: number) =>
    (t > SPARK_AT - 0.09 && t < SPARK_AT + 0.12) || (t >= DRAG_FROM && t <= DRAG_TO);

export const Scene: React.FC<{ offset?: number; captions?: boolean }> = ({ offset = 0, captions = false }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = offset + frame / fps;
    const s = stateAt(t);

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
                <AppShell chars={s.chars} thinkingStyled={s.thinkingStyled} type={s.type} scroll={s.scroll} />
                <TaskRail
                    t={t}
                    tasks={s.tasks}
                    show={s.railShow}
                    expanded={s.expanded}
                    collapsed={s.collapse > 0.5}
                    collapseProgress={s.collapse}
                />
                <UsageBar tokens={s.tokens} show={s.usageShow} spark={s.spark} opacity={s.idle} />
                <Dashboard
                    open={s.dashOpen}
                    spark={s.spark}
                    idle={s.idle}
                    saved={s.saved}
                    cursor={cursorAt(t)}
                    pressed={pressedAt(t)}
                    dragging={t >= DRAG_FROM && t <= DRAG_TO}
                />
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
                    font: '500 15px/1.3 var(--font-ui)',
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
