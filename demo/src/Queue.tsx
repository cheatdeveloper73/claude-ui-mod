import React from 'react';
import { H, COL_X, COL_W, COMPOSER_TOP } from './layout';
import { QRow, queueAt, ramp, rowHeight } from './story';

/* The send queue's rail, in the plugin's own markup and stylesheet (the
 * shadow-root tree built by build()/paintRowBody() in
 * src/plugins/queue/renderer.js).
 *
 * Placement is place(): left edge and width of the composer, bottom edge `gap`
 * (10px) above the top of the composer stack. Its entrances and exits are the
 * stylesheet's own keyframes — railIn, rowIn, rowSent, rowOut, bump — frozen in
 * the sheet and replayed here from the frame clock with the same durations.
 *
 * Re-timed row geometry: a leaving row is taken out of flow at its current
 * offset the moment it goes (the plugin does this too), so the remaining rows
 * close up instantly while it fades. Row heights are the measured ones.
 */
const ICONS = {
    steer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
};

const GAP = 10;
export const HEADER_H = 34;
export const RAIL_BOTTOM_Y = COMPOSER_TOP - GAP;           // window y of the rail's bottom edge
const D3 = 0.28;
const D2 = 0.2;

export const Queue: React.FC<{ t: number; pointer: { x: number; y: number } | null }> = ({ t, pointer }) => {
    const q = queueAt(t);
    if (t < q.railIn) return null;
    const railLeaveAt = q.railOut as number;
    if (t > railLeaveAt + D2) return null;

    // Rows still present, and rows on their way out.
    const live = q.rows.filter((r) => r.exit === null || t < r.exit || r.kind === null);
    const leaving = q.rows.filter((r) => r.kind !== null && r.exit !== null && t >= r.exit && t < r.exit + (r.kind === 'sent' ? D3 : D2));

    // Rail entrance / exit. The last row never plays its own exit: the empty
    // branch removes the whole rail.
    const inK = ramp(t, q.railIn, q.railIn + D3);
    const outK = ramp(t, railLeaveAt, railLeaveAt + D2);
    const railO = Math.min(inK, 1 - outK);
    const railT = (1 - inK) * 8 + outK * 6;
    const railS = 0.985 + 0.015 * inK - 0.01 * outK;

    const heights = live.map((r, i) => rowHeight(r.lines, i === 0));
    const total = heights.reduce((s, h) => s + h, 0);
    const railH = HEADER_H + total + 2;
    // .wrap is a flex column with a 6px gap, and the (empty) toasts box still takes
    // that gap, so the rail ends 6px above the nominal bottom.
    const railTop = RAIL_BOTTOM_Y - 6 - railH;

    // Where the pointer is, in rail coordinates, for the hover states.
    const hoverRow = (() => {
        if (!pointer) return -1;
        if (pointer.x < COL_X || pointer.x > COL_X + COL_W) return -1;
        let y = railTop + 1 + HEADER_H;
        for (let i = 0; i < live.length; i++) {
            if (pointer.y >= y && pointer.y < y + heights[i]) return i;
            y += heights[i];
        }
        return -1;
    })();
    const rightEdge = COL_X + COL_W - 1 - 8;
    const hoverBtn = (i: number): number => {
        // 0 steer, 1 edit, 2 trash, -1 none
        if (!pointer || hoverRow !== i) return -1;
        const rel = rightEdge - pointer.x;
        if (rel >= 48 && rel <= 70) return 0;
        if (rel >= 24 && rel < 48) return 1;
        if (rel >= 0 && rel < 24) return 2;
        return -1;
    };

    // The count chip bumps on every change to the queue.
    const bump = (() => {
        for (const b of q.bumps) {
            const k = (t - b) / D3;
            if (k >= 0 && k <= 1) {
                const peak = k < 0.35 ? k / 0.35 : 1 - (k - 0.35) / 0.65;
                return { scale: 1 + 0.28 * peak, peak };
            }
        }
        return { scale: 1, peak: 0 };
    })();

    const rowStyle = (r: QRow): React.CSSProperties => {
        const k = ramp(t, r.enter, r.enter + D3);
        const e = 1 - Math.pow(1 - k, 3);
        return { opacity: e, transform: `translateX(${(1 - e) * -6}px)` };
    };

    const btnStyle = (on: boolean): React.CSSProperties => (on ? { opacity: 1 } : {});

    return (
        <div
            className="cui-q"
            style={{ position: 'fixed', left: COL_X, bottom: H - RAIL_BOTTOM_Y, width: COL_W, zIndex: 50, pointerEvents: 'none' }}
        >
            <div className="wrap">
                <div
                    className="rail"
                    style={{ opacity: railO, transform: `translateY(${railT}px) scale(${railS})` }}
                >
                    <div className="hd">
                        <div className="cnt">
                            <span
                                className="n"
                                style={{
                                    transform: `scale(${bump.scale})`,
                                    background: bump.peak
                                        ? `color-mix(in srgb, #c96442 ${26 + 34 * bump.peak}%, transparent)`
                                        : undefined,
                                }}
                            >
                                {live.length}
                            </span>
                            <span>queued</span>
                        </div>
                        <div className="spacer" />
                        <div className="auto on">
                            <span className="dot" />
                            <span>auto-send at turn end</span>
                        </div>
                    </div>
                    <div className="rows" style={{ height: total }}>
                        {live.map((r, i) => {
                            const bi = hoverBtn(i);
                            return (
                                <div
                                    className={'row' + (r.editing ? ' editing' : '')}
                                    key={r.id}
                                    style={rowStyle(r)}
                                >
                                    <div className="ord">{i + 1}</div>
                                    <div className="body">
                                        <div className="txt">{r.text}</div>
                                    </div>
                                    <div className="acts">
                                        <div
                                            className="b steer"
                                            style={{
                                                ...btnStyle(hoverRow === i),
                                                ...(bi === 0
                                                    ? { color: '#c96442', background: 'color-mix(in srgb, hsl(var(--text-100)) 12%, transparent)' }
                                                    : {}),
                                            }}
                                            dangerouslySetInnerHTML={{ __html: ICONS.steer }}
                                        />
                                        <div
                                            className={'b edit' + (r.editing ? ' on' : '')}
                                            style={{
                                                ...btnStyle(hoverRow === i),
                                                ...(bi === 1 && !r.editing
                                                    ? { color: 'hsl(var(--text-100))', background: 'color-mix(in srgb, hsl(var(--text-100)) 12%, transparent)' }
                                                    : {}),
                                            }}
                                            dangerouslySetInnerHTML={{ __html: ICONS.edit }}
                                        />
                                        <div
                                            className={'b trash' + (r.armed ? ' arm' : '')}
                                            style={{
                                                ...btnStyle(hoverRow === i),
                                                ...(bi === 2 && !r.armed
                                                    ? { color: '#f5949a', background: 'color-mix(in srgb, hsl(var(--text-100)) 12%, transparent)' }
                                                    : {}),
                                            }}
                                            dangerouslySetInnerHTML={{ __html: ICONS.trash }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                        {leaving.map((r) => {
                            // Out of flow at the offset it had, over the rows that closed up.
                            const before = q.rows.filter((x) => x.enter < r.enter || (x.enter === r.enter && x.id < r.id));
                            const idx = before.length;
                            const top = q.rows
                                .slice(0, idx)
                                .map((x, i) => rowHeight(x.lines, i === 0))
                                .reduce((s, h) => s + h, 0);
                            const sent = r.kind === 'sent';
                            const k = ramp(t, r.exit as number, (r.exit as number) + (sent ? D3 : D2));
                            let style: React.CSSProperties;
                            if (sent) {
                                const bg = k < 0.3 ? 26 * (k / 0.3) : 26;
                                const o = k < 0.3 ? 1 : 1 - (k - 0.3) / 0.7;
                                style = {
                                    opacity: o,
                                    transform: `translateY(${-10 * k}px)`,
                                    background: `color-mix(in srgb, #c96442 ${bg}%, transparent)`,
                                };
                            } else {
                                style = { opacity: 1 - k, transform: `translateX(${14 * k}px)` };
                            }
                            return (
                                <div
                                    className={'row ' + (sent ? 'sent' : 'going')}
                                    key={'x' + r.id}
                                    style={{ position: 'absolute', top, left: 0, right: 0, ...style }}
                                >
                                    <div className="ord">{idx + 1}</div>
                                    <div className="body">
                                        <div className="txt">{r.text}</div>
                                    </div>
                                    <div className="acts">
                                        <div className="b steer" dangerouslySetInnerHTML={{ __html: ICONS.steer }} />
                                        <div className="b edit" dangerouslySetInnerHTML={{ __html: ICONS.edit }} />
                                        <div className="b trash" dangerouslySetInnerHTML={{ __html: ICONS.trash }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div className="toasts" />
            </div>
        </div>
    );
};

