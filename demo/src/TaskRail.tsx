import React from 'react';
import { interpolate } from 'remotion';
import { RAIL_X, RAIL_W, RAIL_BOTTOM, RAIL_MAX_H } from './layout';
import { Task, rowSince, SESSION_ID } from './mock';

/* The rail, rendered with the plugin's own class names against the plugin's own
 * stylesheet (see gen-css.mjs). Only the timing is re-implemented: the sheet's
 * transitions are frozen for rendering, so each frame computes the opacity the
 * transition would have had at that instant.
 *
 * FADE_MS 100, STAGGER_MS 150, STEP_MAX 26 are the plugin's constants.
 */
const FADE = 0.1;
const STAGGER_BUDGET = 0.15;
const STEP_MAX = 0.026;

const STATUS_COLOR: Record<string, string> = {
    completed: 'hsl(var(--success-100))',
    in_progress: 'hsl(var(--accent-100))',
    pending: 'hsl(var(--text-400))',
};

export const TaskRail: React.FC<{
    t: number;
    tasks: Task[];
    show: boolean;
    expanded?: boolean;
    collapsed?: boolean;
    collapseProgress?: number;   // 0 open .. 1 collapsed, for the height tween
}> = ({ t, tasks, show, expanded = false, collapsed = false, collapseProgress = 0 }) => {
    const open = tasks.filter((x) => x.status !== 'completed').length;

    // Rows that arrived in the same beat share a stagger budget, exactly as
    // stagger(n) spends it.
    const fresh = tasks.filter((x) => t - rowSince(x.id, x.status) < FADE + STAGGER_BUDGET);
    const step = fresh.length > 1 ? Math.min(STEP_MAX, STAGGER_BUDGET / (fresh.length - 1)) : 0;

    const showT = interpolate(t, [0, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

    // Collapsed, the rail takes the composer's own height so the two boxes
    // share a top and bottom edge.
    const collapsedH = 124;
    const style: React.CSSProperties = {
        left: RAIL_X,
        bottom: RAIL_BOTTOM,
        width: RAIL_W,
        maxHeight: collapseProgress > 0 ? undefined : RAIL_MAX_H,
        height: collapseProgress > 0 ? undefined : undefined,
        opacity: show ? showT : 0,
        transform: show ? 'none' : 'translateY(4px)',
    };
    if (collapseProgress > 0) {
        // Height is tweened by hand between the two content heights.
        style.height = interpolate(collapseProgress, [0, 1], [RAIL_MAX_H, collapsedH]);
        style.overflow = 'hidden';
    }

    const bodyOpacity = collapseProgress > 0.15 ? 0 : 1;

    return (
        <div className="cui-rail">
            <div className={'rail' + (show ? ' show' : '') + (collapsed ? ' collapsed' : '')} style={style}>
                <div className="hdr">
                    <span className="ttl">Tasks</span>
                    <span className="count">{tasks.length ? `${open}/${tasks.length}` : ''}</span>
                    <button className="btn" title="Toggle descriptions">
                        {'☰'}
                    </button>
                    <button className="btn" title="Collapse">
                        {collapsed ? '+' : '−'}
                    </button>
                </div>
                {/* --ft/--fb are the scroll-clip fade; the plugin sets them from
                    JS to the edges that are actually clipping, so a list that
                    fits its box is not fogged at both ends for no reason. */}
                <div
                    className="body"
                    style={{ opacity: bodyOpacity, ['--fb' as any]: expanded ? '14px' : '0px' }}
                >
                    {tasks.length === 0 ? (
                        <div className="empty">No tasks in this session.</div>
                    ) : (
                        tasks.map((task) => {
                            const since = rowSince(task.id, task.status);
                            const idx = fresh.indexOf(task);
                            const delay = idx >= 0 ? idx * step : 0;
                            const o = interpolate(t, [since + delay, since + delay + FADE], [0, 1], {
                                extrapolateLeft: 'clamp',
                                extrapolateRight: 'clamp',
                            });
                            // .t.in_progress .dot pulses at 1.8s; the sheet's own
                            // animation is frozen, so it is computed here.
                            const pulse =
                                task.status === 'in_progress'
                                    ? 0.725 + 0.275 * Math.cos((t / 1.8) * Math.PI * 2)
                                    : 1;
                            return (
                                <div className={'t ' + task.status} key={task.id} style={{ opacity: o }}>
                                    <div
                                        className="dot"
                                        style={{
                                            background: STATUS_COLOR[task.status],
                                            opacity: task.status === 'completed' ? 0.45 : pulse,
                                            boxShadow:
                                                task.status === 'in_progress'
                                                    ? '0 0 0 3px hsl(var(--accent-100) / .18)'
                                                    : undefined,
                                        }}
                                    />
                                    <div>
                                        <div className="sub">
                                            {task.status === 'in_progress' ? task.activeForm : task.subject}
                                        </div>
                                        {(task.owner || task.blockedBy?.length) && (
                                            <div className="meta">
                                                {task.owner && <span className="tag">@{task.owner}</span>}
                                                {task.blockedBy?.length && (
                                                    <span className="tag blocked">
                                                        blocked by #{task.blockedBy.join(', #')}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {expanded && task.description && (
                                            <div className="desc">{task.description}</div>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
                <div className="foot" style={{ opacity: bodyOpacity }}>
                    <span className="sid">{SESSION_ID.slice(0, 8)}</span>
                    <button className="lnk">folder</button>
                </div>
            </div>
        </div>
    );
};
