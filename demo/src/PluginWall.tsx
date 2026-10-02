import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { TOKENS, RESET } from './theme';

/* A title card, not a plugin render: the plugin list as a wall, one labelled
 * group per kind of thing the mod does, building up to the total.
 *
 * Nothing here is drawn from a plugin's stylesheet. It borrows the demo's own
 * look: the same dark tokens (theme.tsx), the same system and mono faces, the
 * plugins' ease-out curve (the dashboard's --e-out) and, for the six accents,
 * colours the shipped sheets already use rather than a palette of its own:
 *   green       #7cbd8b   auto-compact / usage-bar compaction toggle
 *   terracotta  --accent-100, the app's own accent
 *   violet      #a9a0f0   usage-bar context ramp, warn
 *   blue        #8ecae6   usage-bar context ramp, calm
 *   magenta     #cf8ef5   usage-bar context ramp, hot
 *   coral       #e58b83   the delete/danger tint in the queue and subagent sheets
 *
 * The wall's layout is fixed before anything appears (every chip exists at
 * opacity 0 from frame 0), so nothing shifts as groups land: only opacity and a
 * few pixels of rise are animated, from the frame clock.
 */
export const WALL_W = 1096;
export const WALL_H = 752;

type Group = { label: string; accent: string; names: string[] };

const GROUPS: Group[] = [
    {
        label: 'Bug fixes',
        accent: '#7cbd8b',
        names: ['file-pane-access', 'fast-mode', 'model-lock', 'model-probe-skip', 'message-time', 'sendmessage-unban', 'prompt-suggestions-off', 'classic-stop'],
    },
    { label: 'Unlocks', accent: 'hsl(var(--accent-100))', names: ['unlock-code', 'computer-use'] },
    {
        label: 'Providers & routing',
        accent: '#a9a0f0',
        names: ['provider-picker', 'provider-routing', 'compaction-provider', 'context-management', 'auto-compact'],
    },
    {
        label: 'Agents & automation',
        accent: '#8ecae6',
        names: ['subagents', 'campaigns', 'goal', 'queue', 'voice-agent', 'task-rail'],
    },
    {
        label: 'Usage & context',
        accent: '#cf8ef5',
        names: ['usage-bar', 'context-pill', 'throughput', 'plan-usage-capture', 'hide-usage-band'],
    },
    {
        label: 'Transcript & appearance',
        accent: '#e58b83',
        names: ['thinking-default', 'thinking-style', 'transcript-type', 'transcript-copy', 'waiting-label', 'branding', 'dashboard'],
    },
];

export const PLUGIN_TOTAL = GROUPS.reduce((n, g) => n + g.names.length, 0);

// ---------------------------------------------------------------- timeline
const FIRST_GROUP = 0.7;
const GROUP_EVERY = 1.12;     // seconds from one group's label to the next
const LABEL_LEAD = 0.18;      // chips start this long after their label
const CHIP_STEP = 0.058;      // stagger inside a group
const CHIP_FADE = 0.3;
const GROUP_FADE = 0.42;
export const WALL_SECONDS = FIRST_GROUP + (GROUPS.length - 1) * GROUP_EVERY + LABEL_LEAD + 7 * CHIP_STEP + CHIP_FADE + 2.9;

const out = Easing.bezier(0.2, 0.85, 0.3, 1);
const rise = (t: number, at: number, dur: number) =>
    out(interpolate(t, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));

const groupStart = (gi: number) => FIRST_GROUP + gi * GROUP_EVERY;
const chipStart = (gi: number, ci: number) => groupStart(gi) + LABEL_LEAD + ci * CHIP_STEP;
const landed = (t: number, gi: number) => GROUPS[gi].names.filter((_, ci) => t >= chipStart(gi, ci)).length;

// ---------------------------------------------------------------- layout
const PAD_X = 32;
const LABEL_W = 200;
const COLS = 4;
const CHIP_W = 196;
const CHIP_H = 30;
const CHIP_GAP = 8;
const MONO = 'var(--font-mono)';

const BAR_GAP = 4;

const Chip: React.FC<{ name: string; accent: string; o: number }> = ({ name, accent, o }) => (
    <div
        style={{
            width: CHIP_W,
            height: CHIP_H,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            borderRadius: 8,
            background: `color-mix(in srgb, ${accent} 9%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            boxShadow: `inset 3px 0 0 color-mix(in srgb, ${accent} 78%, transparent)`,
            color: 'hsl(var(--text-100))',
            font: `400 13px/1 ${MONO}`,
            letterSpacing: 0,
            whiteSpace: 'nowrap',
            opacity: o,
            transform: `translateY(${(1 - o) * 7}px)`,
        }}
    >
        <span style={{ paddingLeft: 3 }}>{name}</span>
    </div>
);

export const PluginWall: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = frame / fps;

    let total = 0;
    for (let gi = 0; gi < GROUPS.length; gi++) total += landed(t, gi);

    const barW = WALL_W - PAD_X * 2;
    const usable = barW - BAR_GAP * (GROUPS.length - 1);

    return (
        <AbsoluteFill style={{ background: 'hsl(var(--bg-100))', color: 'hsl(var(--text-100))', fontFamily: 'var(--font-ui)' }}>
            <style dangerouslySetInnerHTML={{ __html: TOKENS + RESET }} />

            {/* ---- header: the running total and the segmented bar ---- */}
            <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 40 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                    <span
                        style={{
                            display: 'inline-block',
                            minWidth: 86,
                            font: '600 76px/1 var(--font-ui)',
                            letterSpacing: '-.02em',
                            fontVariantNumeric: 'tabular-nums',
                            color: 'hsl(var(--text-000))',
                        }}
                    >
                        {total}
                    </span>
                    <span style={{ font: '500 28px/1 var(--font-ui)', color: 'hsl(var(--text-300))' }}>plugins</span>
                    <span style={{ marginLeft: 'auto', font: `400 13px/1 ${MONO}`, color: 'hsl(var(--text-500))' }}>claude-ui-mod</span>
                </div>

                <div style={{ display: 'flex', gap: BAR_GAP, marginTop: 26 }}>
                    {GROUPS.map((g, gi) => {
                        const w = (usable * g.names.length) / PLUGIN_TOTAL;
                        const fill = landed(t, gi) / g.names.length;
                        return (
                            <div
                                key={g.label}
                                style={{ width: w, height: 4, borderRadius: 2, background: 'color-mix(in srgb, hsl(var(--text-100)) 8%, transparent)', overflow: 'hidden' }}
                            >
                                <div style={{ width: `${fill * 100}%`, height: '100%', background: g.accent, borderRadius: 2 }} />
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ---- the groups ---- */}
            <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 150 }}>
                {GROUPS.map((g, gi) => {
                    const lo = rise(t, groupStart(gi), GROUP_FADE);
                    const n = landed(t, gi);
                    return (
                        <div
                            key={g.label}
                            style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 24, padding: '16px 0' }}
                        >
                            <div
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    top: 0,
                                    height: 1,
                                    background: 'color-mix(in srgb, hsl(var(--text-100)) 8%, transparent)',
                                    opacity: lo,
                                }}
                            />
                            <div
                                style={{
                                    width: LABEL_W,
                                    flex: '0 0 auto',
                                    height: CHIP_H,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 9,
                                    opacity: lo,
                                    transform: `translateY(${(1 - lo) * 8}px)`,
                                }}
                            >
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.accent, flex: '0 0 auto' }} />
                                <span style={{ font: '600 13.5px/1.2 var(--font-ui)', color: 'hsl(var(--text-100))', flex: '1 1 auto', minWidth: 0 }}>
                                    {g.label}
                                </span>
                                <span
                                    style={{
                                        font: '500 12px/1 var(--font-ui)',
                                        fontVariantNumeric: 'tabular-nums',
                                        color: 'hsl(var(--text-500))',
                                        minWidth: 14,
                                        textAlign: 'right',
                                    }}
                                >
                                    {n}
                                </span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, ${CHIP_W}px)`, gap: CHIP_GAP }}>
                                {g.names.map((name, ci) => (
                                    <Chip key={name} name={name} accent={g.accent} o={rise(t, chipStart(gi, ci), CHIP_FADE)} />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </AbsoluteFill>
    );
};
