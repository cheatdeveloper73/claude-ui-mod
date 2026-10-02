import React from 'react';
import { interpolate } from 'remotion';
import { UsageBarSample } from './UsageBarSample';
import { ThroughputPanel } from './ThroughputPanel';
import { USAGE_DEFAULTS } from './generated-css.js';

/* The settings overlay, in the plugin's own markup and stylesheet.
 *
 * Two pages are shown. usage-bar's, so the preview frames beside the panel are
 * previewing the same control the viewer just watched in the composer footer:
 * switch the compaction mark off here and it leaves the meter in the footer.
 * And throughput's, whose readout is a plugin-built node dropped into a wide
 * custom row, with the preview frames collapsed the way the real dashboard
 * collapses them for a page that has none.
 *
 * The sidebar counts are the number of controls each plugin's spec declares.
 */

const NAV: [string, number][] = [
    ['provider-picker', 11],
    ['queue', 11],
    ['subagents', 9],
    ['task-rail', 9],
    ['thinking-default', 3],
    ['thinking-style', 17],
    ['throughput', 9],
    ['transcript-type', 4],
    ['usage-bar', 13],
];

export type DashPage = 'usage-bar' | 'throughput';

export const Dashboard: React.FC<{
    open: number;          // 0 closed .. 1 open
    page: DashPage;
    mark: boolean;         // "Compaction mark"
    idle: number;          // the "Idle opacity" slider value
    saved: number;         // 0..1 opacity of the "saved" tag
    dragging?: boolean;
    t: number;
    scroll?: number;       // throughput page: how far the readout has been scrolled
}> = ({ open, page, mark, idle, saved, dragging, t, scroll = 0 }) => {
    if (open <= 0) return null;

    const panelStyle: React.CSSProperties = {
        transform: `translateY(${interpolate(open, [0, 1], [10, 0])}px) scale(${interpolate(
            open,
            [0, 1],
            [0.985, 1],
        )})`,
        opacity: interpolate(open, [0, 1], [0.4, 1]),
    };

    const idlePct = ((idle - 0.1) / (1 - 0.1)) * 100;
    const pct = (v: number, lo: number, hi: number) => ((v - lo) / (hi - lo)) * 100;

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
                        <div className="side-wrap">
                        <div className="side-list">
                            {/* the one indicator that travels to the active row */}
                            <div className="nav-ind on" style={{ top: 4 + 36 * Math.max(0, NAV.findIndex(([n]) => n === page)), height: 34 }} />
                            {NAV.map(([name, count]) => (
                                <div className={'nav' + (name === page ? ' on' : '')} key={name}>
                                    <span className="dot" style={{ background: 'hsl(var(--cui-accent))' }} />
                                    <span className="nm">{name}</span>
                                    <span className="ct">{count}</span>
                                </div>
                            ))}
                        </div>
                        <div className="side-mark" />
                        </div>
                        <div className="side-ft">.state\settings.json</div>
                    </div>

                    <div className="main">
                        <div className="main-hd">
                            <div className="tt">
                                {page === 'usage-bar' ? (
                                    <>
                                        <h2>Native usage ring</h2>
                                        <p>
                                            Provider-aware account limits in Claude Desktop’s usage ring and popover. Context
                                            lives in the composer only.
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <h2>Generation rate</h2>
                                        <p>
                                            Exact tokens per second per response, per provider, per agent — measured at the
                                            router and joined to the CLI transcript that names which agent produced it.
                                        </p>
                                    </>
                                )}
                            </div>
                            <div className="saved" style={{ opacity: saved }}>
                                saved
                            </div>
                            <button className="btn">Reset</button>
                            <button className="btn close">✕</button>
                        </div>

                        {page === 'usage-bar' ? (
                            <div className="scroll">
                                <div className="sect">Usage</div>
                                <div className="group">
                                    <Row label="Provider-aware native usage ring">
                                        <Switch on />
                                    </Row>
                                    <Row label="Keep composer context meter">
                                        <Switch on />
                                    </Row>
                                    <Row label="Hide the app’s usage band">
                                        <Switch on={false} />
                                    </Row>
                                </div>

                                <div className="sect">Composer context</div>
                                <div className="group">
                                    <Row label="Compaction mark">
                                        <Switch on={mark} />
                                    </Row>
                                    <Row label="Track length">
                                        <Slider pct={pct(USAGE_DEFAULTS.width, 40, 240)} />
                                        <div className="val">{USAGE_DEFAULTS.width} px</div>
                                    </Row>
                                    <Row label="Track thickness">
                                        <Slider pct={pct(USAGE_DEFAULTS.thickness, 2, 12)} />
                                        <div className="val">{USAGE_DEFAULTS.thickness} px</div>
                                    </Row>
                                    <Row label="Idle opacity">
                                        <Slider pct={idlePct} active={dragging} />
                                        <div className="val">{idle.toFixed(2)}</div>
                                    </Row>
                                    <Row label="Warn at">
                                        <Slider pct={pct(USAGE_DEFAULTS.warn, 0, 1)} />
                                        <div className="val">{USAGE_DEFAULTS.warn.toFixed(2)}</div>
                                    </Row>
                                </div>
                            </div>
                        ) : (
                            <div
                                className="scroll"
                                style={{ overflow: 'hidden', ['--fb' as any]: '26px', ['--ft' as any]: scroll > 4 ? '20px' : '0px' }}
                            >
                                <div style={{ transform: `translateY(${-scroll}px)` }}>
                                    <div className="sect">Live</div>
                                    <div className="group">
                                        <div className="row wide">
                                            <div className="lab">
                                                <b>Throughput</b>
                                                <span>
                                                    Exact rates come from the provider’s own terminal token count over this
                                                    router’s clocks. An in-flight stream with no count yet is marked est.
                                                </span>
                                            </div>
                                            <div className="ctl">
                                                <ThroughputPanel t={t} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {page === 'usage-bar' ? (
                    <div className="frames">
                        <Frame which="before" label="app default" i={0}>
                            <UsageBarSample idle={USAGE_DEFAULTS.idle} />
                        </Frame>
                        <Frame which="after" label="your settings" i={1}>
                            <UsageBarSample idle={idle} />
                        </Frame>
                    </div>
                ) : (
                    <div className="frames off" />
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
