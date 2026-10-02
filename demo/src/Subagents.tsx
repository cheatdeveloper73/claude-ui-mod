import React from 'react';

import { SIDEBAR, REGION_TOP, COMPOSER_TOP, W, COL_W } from './layout';
import { AGENTS, AGENTS_IN, Agent, SHEET_OPEN, SHEET_CLOSE, agentView, liveCount, ramp } from './story';

/* The subagent HUD, in the plugin's own markup and stylesheet (the shadow-root
 * tree built by makeRow/patchRow/openSheet in src/plugins/subagents/renderer.js).
 *
 * Placement is the plugin's place(): centred in the gutter between the sidebar's
 * right edge and the composer, GAP 12, RAIL_MIN 196, railWidth 268 clamped to
 * what is available, and the top is the transcript region's top + railTop 72.
 *
 * Re-timed: the rail repaints on its own poll, so durations and the current tool
 * step every 4s (every 2s with a sheet open) rather than ticking. The breathing
 * dot and the sweep under a running row are the sheet's own animations, frozen
 * and recomputed here from the frame clock.
 */
const GAP = 12;
const COMPOSER_LEFT = (W - SIDEBAR - COL_W) / 2 + SIDEBAR;
const AVAIL = COMPOSER_LEFT - GAP - (SIDEBAR + GAP);
export const RAIL_W = Math.min(268, AVAIL);
export const RAIL_X = Math.round(SIDEBAR + GAP + (AVAIL - RAIL_W) / 2);
export const RAIL_Y = REGION_TOP + 72;
export const SHEET = { left: SIDEBAR, top: REGION_TOP, width: W - SIDEBAR, height: COMPOSER_TOP - 12 - REGION_TOP };

const INDENT = 14;
const depthOf = (a: Agent): number => (a.parent ? 1 + depthOf(AGENTS.find((x) => x.id === a.parent)!) : 0);

// Tree order: a parent immediately above its children.
const TREE: Agent[] = (() => {
    const out: Agent[] = [];
    const visit = (a: Agent) => {
        out.push(a);
        AGENTS.filter((c) => c.parent === a.id).forEach(visit);
    };
    AGENTS.filter((a) => !a.parent).forEach(visit);
    return out;
})();

const breathe = (t: number) => 0.69 + 0.31 * Math.cos((t / 2.1) * Math.PI * 2);
const sweep = (t: number) => {
    const p = (t % 2.6) / 2.6;
    const e = 1 - Math.pow(1 - p, 3);
    return -110 + 510 * e;
};

const Row: React.FC<{ a: Agent; t: number; sel: boolean; every: number }> = ({ a, t, sel, every }) => {
    const v = agentView(a, t, every);
    const depth = depthOf(a);
    const cls = ['row', depth ? 'child' : '', v.live ? 'live' : 'ghost', sel ? 'sel' : ''].filter(Boolean).join(' ');
    const born = a.spawn > -1e6 ? ramp(t, AGENTS_IN, AGENTS_IN + 0.2) : 1;
    return (
        <div
            className={cls}
            data-depth={depth}
            style={{
                ['--tree-indent' as any]: depth * INDENT + 'px',
                ['--tree-guide' as any]: '9px',
                opacity: v.live ? born : undefined,
            }}
        >
            <span className="dot" style={v.live ? { opacity: breathe(t) } : undefined} />
            <div className="mid">
                <div className="nm">{a.name}</div>
            </div>
            <div className="rt">
                <div className="when">{v.elapsedLabel}</div>
                <button className="kstop" type="button" style={{ display: v.live ? '' : 'none' }}>
                    stop
                </button>
            </div>
            <div className="slot">
                {v.live && (
                    <>
                        <div className="doing">
                            <b>{v.tool}</b>
                            <span>{v.what.slice(0, 140)}</span>
                        </div>
                        <div className="bar">
                            <i style={{ transform: `translateX(${sweep(t + a.toolOffset * 0.7)}%)` }} />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export const Subagents: React.FC<{ t: number; sheetAgent: string | null }> = ({ t, sheetAgent }) => {
    if (t < AGENTS_IN) return null;
    const sheetOn = t >= SHEET_OPEN && t < SHEET_CLOSE + 0.3;
    const every = sheetOn ? 2 : 4;
    const live = liveCount(t);
    const rail = ramp(t, AGENTS_IN, AGENTS_IN + 0.32);

    return (
        <div
            className="cui-sa"
            style={{ position: 'fixed', left: 0, top: 0, width: 0, height: 0, zIndex: sheetOn ? 2147483500 : 50, pointerEvents: 'none' }}
        >
            <div className="wrap">
                {sheetOn && <Scrim t={t} />}
                <div
                    className="rail"
                    style={{
                        left: RAIL_X,
                        top: RAIL_Y,
                        width: RAIL_W,
                        maxHeight: 558,
                        opacity: rail,
                        transform: `translateY(${(1 - rail) * -5}px)`,
                    }}
                >
                    <div className="cap">
                        <span className={live > 0 ? 'n' : ''}>
                            {live > 0 ? live + (live === 1 ? ' agent running' : ' agents running') : 'subagents'}
                        </span>
                        <span className="sp" />
                        <span className="demo" style={{ display: 'none' }}>
                            demo
                        </span>
                    </div>
                    <div className="rbody">
                        <div className="runs">
                            {TREE.map((a) => (
                                <Row key={a.id} a={a} t={t} sel={sheetOn && sheetAgent === a.id} every={every} />
                            ))}
                        </div>
                    </div>
                </div>
                {sheetOn && sheetAgent && <Sheet t={t} agent={AGENTS.find((a) => a.id === sheetAgent)!} />}
            </div>
        </div>
    );
};

const Scrim: React.FC<{ t: number }> = ({ t }) => {
    const o = 0.93 * Math.min(ramp(t, SHEET_OPEN, SHEET_OPEN + 0.32), 1 - ramp(t, SHEET_CLOSE, SHEET_CLOSE + 0.2));
    return (
        <div
            className="scrim"
            style={{ left: SIDEBAR, top: SHEET.top + SHEET.height - 12, right: 0, bottom: 0, opacity: o }}
        />
    );
};

// ------------------------------------------------------------------ sheet
const ease = (k: number) => 1 - Math.pow(1 - k, 3);

const TURNS: { at: string; text: React.ReactNode; tool: string; args: [string, string][]; out: string; open?: boolean }[] = [
    {
        at: '14:02:11',
        text: (
            <>
                Starting with the header repoint. The hash is taken over the header JSON bytes only, so the archive data can
                stay where it is.
            </>
        ),
        tool: 'Read',
        args: [['file_path:', 'src/patch/asar.js'], ['offset:', '120'], ['limit:', '60']],
        out: `function repointExeIntegrity(exe, headerHash, backup) {
    const buf = fs.readFileSync(exe);
    const at = buf.indexOf(Buffer.from(oldHash, 'ascii'));
    if (at < 0) throw new Error('integrity field not found');
    buf.write(headerHash, at, 'ascii');          // same length, no relocation
    return fs.writeFileSync(exe, buf);
}`,
    },
    {
        at: '14:02:58',
        text: (
            <>
                <code>repointExeIntegrity</code> overwrites the 64-character field in place, so the PE layout is untouched.
            </>
        ),
        tool: 'Grep',
        args: [['pattern:', 'repointExeIntegrity'], ['output_mode:', 'content']],
        out: `src/patch/asar.js:118:function repointExeIntegrity(exe, headerHash, backup) {
patch.js:204:    const r = asar.repointExeIntegrity(a.exe, newHash, a.exeBackup);`,
    },
];

const Sheet: React.FC<{ t: number; agent: Agent }> = ({ t, agent }) => {
    const open = ease(ramp(t, SHEET_OPEN, SHEET_OPEN + 0.36));
    const close = ramp(t, SHEET_CLOSE, SHEET_CLOSE + 0.24);
    const k = open * (1 - close);
    // The sheet opens out of the row that was clicked: a clip-path inset from
    // that row's rectangle to the whole sheet (Web Animations in the plugin).
    const row = { l: RAIL_X - SHEET.left, t: RAIL_Y + 19 - SHEET.top, r: SHEET.left + SHEET.width - (RAIL_X + RAIL_W), b: SHEET.top + SHEET.height - (RAIL_Y + 19 + 46) };
    const inset = (v: number) => v * (1 - k);
    const v = agentView(agent, t, 2);
    const col = COL_W;
    const tail: [string, string][] = [
        ['Read', 'file_path: src/patch/asar.js, offset: 120, limit: 60'],
        ['Grep', 'pattern: repointExeIntegrity, output_mode: content'],
        ['Read', 'file_path: src/patch/pe.js'],
        ['Bash', 'node selfcheck.js'],
        ['Read', 'file_path: docs/internals.md, offset: 40, limit: 80'],
    ];
    const n = Math.floor(t / 2);
    const lines = [0, 1, 2, 3, 4].map((i) => tail[(n + i) % tail.length]);
    return (
        <div
            className="sheet wide"
            style={{
                left: SHEET.left,
                top: SHEET.top,
                width: SHEET.width,
                height: SHEET.height,
                ['--col' as any]: col + 'px',
                overflow: 'hidden',
                clipPath: `inset(${inset(row.t)}px ${inset(row.r)}px ${inset(row.b)}px ${inset(row.l)}px round ${12 * (1 - k)}px)`,
                opacity: 0.55 + 0.45 * k,
            }}
        >
            <div className="inner">
                <div className="shd">
                    <div className="in">
                        <div className="crumb">
                            <svg viewBox="0 0 24 24" fill="none">
                                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>all agents</span>
                        </div>
                        <div className="title">
                            <h2>{agent.name}</h2>
                            <div className="badge">
                                <i style={{ opacity: breathe(t) }} />
                                <span>running</span>
                            </div>
                            <div className="sp" />
                            <div className="acts">
                                <div className="act danger">stop</div>
                                <div className="act">copy id</div>
                                <div className="act">reveal file</div>
                                <div className="act">close</div>
                            </div>
                        </div>
                        <div className="subline">
                            <span>
                                {agent.type}
                                <span className="pin">({agent.pin})</span>
                            </span>
                            <span>
                                <b>model </b>
                                {agent.model}
                            </span>
                            {agent.effort && (
                                <span>
                                    <b>effort </b>
                                    {agent.effort}
                                </span>
                            )}
                            <span>
                                <b>running </b>
                                {v.elapsedLabel}
                            </span>
                            <span>
                                <b>started </b>13:59
                            </span>
                        </div>
                    </div>
                </div>

                <div className="grid">
                    <div className="main">
                        <div className="brief">
                            Read the asar header repoint in src/patch against the integrity check in claude.exe. Report
                            anything that depends on the current build’s layout.
                        </div>
                        <div className="tailslot">
                            <div className="tail">
                                {lines.map(([tool, what], i) => (
                                    <div className={'tl' + (i === lines.length - 1 ? ' now' : '')} key={i}>
                                        <b>{tool}</b>
                                        <span>{what}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="turns">
                            {TURNS.map((b, i) => (
                                <div className="blk assistant" key={i}>
                                    <div className="who">
                                        <span className="role">agent</span>
                                        <span className="rule" />
                                        <span className="at">{b.at}</span>
                                    </div>
                                    <div className="txt">{b.text}</div>
                                    <div className="call">
                                        <div className="chead">
                                            <b>{b.tool}</b>
                                            <span className="args">
                                                {b.args.map(([key, val], j) => (
                                                    <React.Fragment key={key}>
                                                        {j > 0 && '   '}
                                                        <em>{key}</em> {val}
                                                    </React.Fragment>
                                                ))}
                                            </span>
                                        </div>
                                        <div className="cout">
                                            <pre>{b.out}</pre>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="side">
                        <div className="card">
                            <h3>at a glance</h3>
                            <div className="kv">
                                {[
                                    ['state', 'running'],
                                    ['running', v.elapsedLabel],
                                    ['started', '13:59'],
                                    ['output', '4.1k tok'],
                                    ['cache read', '212k'],
                                    ['turns', String(14 + Math.floor((t - SHEET_OPEN) / 2))],
                                ].map(([key, val]) => (
                                    <div key={key}>
                                        <span className="k">{key}</span>
                                        <span className="v">{val}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="card">
                            <h3>tools</h3>
                            <div className="hist">
                                {[['Read', 9], ['Grep', 5], ['Bash', 3], ['Edit', 1]].map(([name, c]) => (
                                    <div key={name as string}>
                                        <span className="hn">{name}</span>
                                        <div className="hb">
                                            <i style={{ width: `${((c as number) / 9) * 100}%` }} />
                                        </div>
                                        <span className="hv">{c}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const sheetAgentAt = (t: number): string | null => (t >= SHEET_OPEN && t < SHEET_CLOSE + 0.3 ? 'a1' : null);
