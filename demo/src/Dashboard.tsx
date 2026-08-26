import React from 'react';
import { interpolate } from 'remotion';
import { UsageBarSample } from './UsageBarSample';

/* The settings overlay, in the plugin's own markup and stylesheet.
 *
 * The page shown is usage-bar's, so the preview frames beside the panel are
 * previewing the same control the viewer just watched in the composer footer:
 * flip Sparkline here and the meter in the footer grows a sparkline.
 */

const NAV = [
    ['dashboard', 3],
    ['task-rail', 5],
    ['thinking-default', 4],
    ['thinking-style', 6],
    ['transcript-type', 4],
    ['usage-bar', 9],
];

export const Dashboard: React.FC<{
    open: number;          // 0 closed .. 1 open
    spark: boolean;
    idle: number;          // the "Idle opacity" slider value
    saved: number;         // 0..1 opacity of the "saved" tag
    cursor?: { x: number; y: number } | null;
    pressed?: boolean;
    dragging?: boolean;
}> = ({ open, spark, idle, saved, cursor, pressed, dragging }) => {
    if (open <= 0) return null;

    const panelStyle: React.CSSProperties = {
        transform: `translateY(${interpolate(open, [0, 1], [10, 0])}px) scale(${interpolate(
            open,
            [0, 1],
            [0.985, 1],
        )})`,
        opacity: interpolate(open, [0, 1], [0.4, 1]),
    };

    const idlePct = ((idle - 0.15) / (1 - 0.15)) * 100;

    return (
        <div className="cui-dash">
            <div className="wrap show" style={{ opacity: open }}>
                <div className="panel" style={panelStyle}>
                    <div className="side">
                        <div className="side-hd">
                            <h1>Plugin dashboard</h1>
                            <p>
                                toggle with <span className="kbd">Insert</span>
                            </p>
                        </div>
                        <div className="side-list">
                            {NAV.map(([name, count]) => (
                                <div className={'nav' + (name === 'usage-bar' ? ' on' : '')} key={name as string}>
                                    <span className="dot" style={{ background: 'hsl(var(--cui-accent))' }} />
                                    <span className="nm">{name}</span>
                                    <span className="ct">{count}</span>
                                </div>
                            ))}
                        </div>
                        <div className="side-ft">.state\settings.json</div>
                    </div>

                    <div className="main">
                        <div className="main-hd">
                            <div className="tt">
                                <h2>usage-bar</h2>
                                <p>Context and rate limits, in the empty middle of the composer footer.</p>
                            </div>
                            <div className="saved" style={{ opacity: saved }}>
                                saved
                            </div>
                            <button className="btn">Reset</button>
                            <button className="btn close">✕</button>
                        </div>

                        <div className="scroll">
                            <div className="sect">Meters</div>
                            <div className="group">
                                <Row label="Enabled">
                                    <Switch on />
                                </Row>
                                <Row
                                    label="Hide the app’s usage band"
                                    hint="Its reset time is read off it first, then shown here."
                                >
                                    <Switch on />
                                </Row>
                                <Row
                                    label="Limit shown"
                                    hint="Auto shows whichever bucket sits closest to its ceiling."
                                >
                                    <div className="cb">
                                        <span className="lbl">Auto — whichever is highest</span>
                                        <span className="arw">▼</span>
                                    </div>
                                </Row>
                            </div>

                            <div className="sect">Look</div>
                            <div className="group">
                                <Row label="Track width">
                                    <Slider pct={62} />
                                    <div className="val">96 px</div>
                                </Row>
                                <Row label="Thickness">
                                    <Slider pct={33} />
                                    <div className="val">4 px</div>
                                </Row>
                                <Row label="Idle opacity" hint="Full opacity on hover, always.">
                                    <Slider pct={idlePct} active={dragging} />
                                    <div className="val">{idle.toFixed(2)}</div>
                                </Row>
                                <Row label="Sparkline" hint="30 days of history for the shown bucket.">
                                    <Switch on={spark} />
                                </Row>
                                <Row label="Glow">
                                    <Switch on={false} />
                                </Row>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="frames">
                    <Frame which="before" label="app default" i={0}>
                        <UsageBarSample spark={false} idle={0.55} />
                    </Frame>
                    <Frame which="after" label="your settings" i={1}>
                        <UsageBarSample spark={spark} idle={idle} />
                    </Frame>
                </div>

                {cursor && (
                    <div
                        style={{
                            position: 'fixed',
                            left: cursor.x,
                            top: cursor.y,
                            width: 18,
                            height: 18,
                            zIndex: 9,
                            pointerEvents: 'none',
                            transform: pressed ? 'scale(.88)' : 'none',
                        }}
                    >
                        <svg viewBox="0 0 12 18" width="18" height="26">
                            <path
                                d="M1 1 L1 15 L4.5 11.6 L7 17 L9.4 16 L6.9 10.8 L11 10.7 Z"
                                fill="#fff"
                                stroke="rgba(0,0,0,.65)"
                                strokeWidth="1"
                            />
                        </svg>
                    </div>
                )}
            </div>
        </div>
    );
};

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div className="row">
        <div className="lab">
            <b>{label}</b>
            {hint && <span>{hint}</span>}
        </div>
        <div className="ctl">{children}</div>
    </div>
);

const Switch: React.FC<{ on: boolean }> = ({ on }) => (
    <div className={'sw' + (on ? ' on' : '')}>
        <i style={{ transform: on ? 'translateX(16px)' : 'none' }} />
    </div>
);

// A real <input type=range> renders its own thumb, which cannot be positioned
// from React state without controlling the element; drawn instead.
const Slider: React.FC<{ pct: number; active?: boolean }> = ({ pct, active }) => (
    <div style={{ width: 148, height: 20, position: 'relative', flex: '0 0 auto' }}>
        <div
            style={{
                position: 'absolute',
                top: 8,
                left: 0,
                right: 0,
                height: 4,
                borderRadius: 2,
                background: 'color-mix(in srgb, hsl(var(--text-100)) 16%, transparent)',
            }}
        />
        <div
            style={{
                position: 'absolute',
                top: 8,
                left: 0,
                width: `${pct}%`,
                height: 4,
                borderRadius: 2,
                background: 'color-mix(in srgb, hsl(var(--cui-accent)) 70%, transparent)',
            }}
        />
        <div
            style={{
                position: 'absolute',
                top: 2,
                left: `calc(${pct}% - 8px)`,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: 'hsl(var(--cui-accent))',
                border: '2px solid hsl(var(--bg-000))',
                boxShadow: active
                    ? '0 1px 3px rgba(0,0,0,.5), 0 0 0 6px color-mix(in srgb, hsl(var(--cui-accent)) 18%, transparent)'
                    : '0 1px 3px rgba(0,0,0,.5)',
                transform: active ? 'scale(1.3)' : 'none',
            }}
        />
    </div>
);

const Frame: React.FC<{ which: string; label: string; i: number; children: React.ReactNode }> = ({
    which,
    label,
    i,
    children,
}) => (
    <div className={'frame ' + which} style={{ ['--i' as any]: i }}>
        <div className="fr-hd">
            <span className="d" />
            <span>
                {which} — {label}
            </span>
            <span className="hint">drag · dbl-click to reset</span>
        </div>
        <div className={'pv-stage pv-' + which}>{children}</div>
    </div>
);
