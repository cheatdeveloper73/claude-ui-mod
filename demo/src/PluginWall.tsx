import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { TOKENS, RESET } from './theme';

/* A title card, not a plugin render: the plugin list as a wall, one labelled
 * group per kind of thing the mod does, building up to the total.
 *
 * Nothing here is drawn from a plugin's stylesheet. It borrows the demo's own
 * look: the same dark tokens (theme.tsx), the same system and mono faces, the
 * plugins' ease-out curve (the dashboard's --e-out) and, for the six accents,
 * colours the shipped sheets already use rather than a palette of its own
 * (the seventh group, the router and tooling, takes the neutral text-300 token):
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
export const WALL_W = 1160;
export const WALL_H = 896;

type Item = readonly [name: string, features: number];
type Group = { label: string; accent: string; items: Item[] };

const GROUPS: Group[] = [
    {
        label: 'Bug fixes',
        accent: '#7cbd8b',
        items: [['file-pane-access', 2], ['fast-mode', 2], ['model-lock', 1], ['model-probe-skip', 1], ['message-time', 1], ['sendmessage-unban', 1], ['prompt-suggestions-off', 1], ['classic-stop', 1]],
    },
    { label: 'Unlocks', accent: 'hsl(var(--accent-100))', items: [['unlock-code', 5], ['computer-use', 1]] },
    {
        label: 'Providers & routing',
        accent: '#a9a0f0',
        items: [['provider-picker', 15], ['provider-routing', 5], ['compaction-provider', 4], ['context-management', 6], ['auto-compact', 4]],
    },
    {
        label: 'Agents & automation',
        accent: '#8ecae6',
        items: [['subagents', 15], ['campaigns', 15], ['goal', 6], ['queue', 10], ['voice-agent', 19], ['task-rail', 5]],
    },
    {
        label: 'Usage & context',
        accent: '#cf8ef5',
        items: [['usage-bar', 7], ['context-pill', 1], ['throughput', 4], ['plan-usage-capture', 1], ['hide-usage-band', 1]],
    },
    {
        label: 'Transcript & appearance',
        accent: '#e58b83',
        items: [['thinking-default', 1], ['thinking-style', 2], ['transcript-type', 1], ['transcript-copy', 10], ['waiting-label', 1], ['branding', 4], ['dashboard', 8]],
    },
    {
        label: 'Router & tooling',
        accent: 'hsl(var(--text-300))',
        items: [['router', 193], ['command-code', 19], ['patch.js', 10], ['provider-accounting', 8], ['selfcheck', 5], ['nanogpt-sync', 5], ['watch.js', 4], ['live-inject', 4], ['prompt-policy', 4], ['install.ps1', 3], ['router-canary', 3]],
    },
];

const groupFeatures = (g: Group) => g.items.reduce((n, [, f]) => n + f, 0);
export const FEATURE_TOTAL = GROUPS.reduce((n, g) => n + groupFeatures(g), 0);
// the router group is tooling, not a plugin; the other six hold the 33 plugin chips
export const PLUGIN_TOTAL = GROUPS.slice(0, -1).reduce((n, g) => n + g.items.length, 0);
const ROUTER_FEATURES = groupFeatures(GROUPS[GROUPS.length - 1]);
const SETTINGS = 193;

// ---------------------------------------------------------------- timeline
const FIRST_GROUP = 0.7;
const GROUP_EVERY = 1.12;     // seconds from one group's label to the next
const LABEL_LEAD = 0.18;      // chips start this long after their label
const CHIP_STEP = 0.058;      // stagger inside a group
const CHIP_FADE = 0.3;
const GROUP_FADE = 0.42;
const RAMP_BASE = 0.3;        // a chip's count climbs over this, plus RAMP_PER seconds per feature
const RAMP_PER = 0.006;
export const WALL_SECONDS = FIRST_GROUP + (GROUPS.length - 1) * GROUP_EVERY + LABEL_LEAD + 10 * CHIP_STEP + CHIP_FADE + 3.2;

const out = Easing.bezier(0.2, 0.85, 0.3, 1);
const rise = (t: number, at: number, dur: number) =>
    out(interpolate(t, [at, at + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));

const groupStart = (gi: number) => FIRST_GROUP + gi * GROUP_EVERY;
const chipStart = (gi: number, ci: number) => groupStart(gi) + LABEL_LEAD + ci * CHIP_STEP;
const ramp = (f: number) => RAMP_BASE + f * RAMP_PER;
/** features a chip has contributed so far: a smooth climb, so a 193 reads as a sweep, not a jump */
const chipCount = (t: number, gi: number, ci: number) => {
    const f = GROUPS[gi].items[ci][1];
    return f * rise(t, chipStart(gi, ci), ramp(f));
};
const groupCount = (t: number, gi: number) => GROUPS[gi].items.reduce((n, _, ci) => n + chipCount(t, gi, ci), 0);

// ---------------------------------------------------------------- layout
const PAD_X = 32;
const LABEL_W = 190;
const LABEL_GAP = 20;
const COLS = 4;
const CHIP_W = 216;
const CHIP_H = 30;
const CHIP_GAP = 8;
const MONO = 'var(--font-mono)';

const BAR_GAP = 4;

const Chip: React.FC<{ name: string; features: number; accent: string; o: number }> = ({ name, features, accent, o }) => (
    <div
        style={{
            width: CHIP_W,
            height: CHIP_H,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 7px 0 15px',
            borderRadius: 8,
            background: `color-mix(in srgb, ${accent} 9%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            boxShadow: `inset 3px 0 0 color-mix(in srgb, ${accent} 78%, transparent)`,
            color: 'hsl(var(--text-100))',
            font: `400 12.5px/1 ${MONO}`,
            letterSpacing: 0,
            whiteSpace: 'nowrap',
            opacity: o,
            transform: `translateY(${(1 - o) * 7}px)`,
        }}
    >
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>{name}</span>
        <span
            style={{
                flex: '0 0 auto',
                minWidth: 22,
                boxSizing: 'border-box',
                padding: '0 6px',
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                borderRadius: 9,
                background: `color-mix(in srgb, ${accent} 18%, transparent)`,
                color: `color-mix(in srgb, ${accent} 70%, hsl(var(--text-000)))`,
                font: `500 11px/1 ${MONO}`,
                fontVariantNumeric: 'tabular-nums',
            }}
        >
            {features}
        </span>
    </div>
);

export const PluginWall: React.FC = () => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const t = frame / fps;

    const counts = GROUPS.map((_, gi) => groupCount(t, gi));
    const total = Math.round(counts.reduce((n, c) => n + c, 0));

    const barW = WALL_W - PAD_X * 2;
    const usable = barW - BAR_GAP * (GROUPS.length - 1);

    return (
        <AbsoluteFill style={{ background: 'hsl(var(--bg-100))', color: 'hsl(var(--text-100))', fontFamily: 'var(--font-ui)' }}>
            <style dangerouslySetInnerHTML={{ __html: TOKENS + RESET }} />

            {/* ---- header: the running total, what it is made of, and the segmented bar ---- */}
            <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 40 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
                    <span
                        style={{
                            display: 'inline-block',
                            minWidth: 128,
                            font: '600 76px/1 var(--font-ui)',
                            letterSpacing: '-.02em',
                            fontVariantNumeric: 'tabular-nums',
                            color: 'hsl(var(--text-000))',
                        }}
                    >
                        {total}
                    </span>
                    <span style={{ font: '500 28px/1 var(--font-ui)', color: 'hsl(var(--text-300))' }}>features</span>
                    <span style={{ marginLeft: 'auto', font: `400 13px/1 ${MONO}`, color: 'hsl(var(--text-500))' }}>claude-ui-mod</span>
                </div>
                <div style={{ marginTop: 14, font: '400 16px/1 var(--font-ui)', color: 'hsl(var(--text-400))', opacity: rise(t, 0.35, 0.6) }}>
                    {PLUGIN_TOTAL} plugins · {SETTINGS} settings · {ROUTER_FEATURES} in the router and tooling
                </div>

                <div style={{ display: 'flex', gap: BAR_GAP, marginTop: 22 }}>
                    {GROUPS.map((g, gi) => {
                        const gf = groupFeatures(g);
                        const w = (usable * gf) / FEATURE_TOTAL;
                        const fill = counts[gi] / gf;
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
            <div style={{ position: 'absolute', left: PAD_X, right: PAD_X, top: 176 }}>
                {GROUPS.map((g, gi) => {
                    const lo = rise(t, groupStart(gi), GROUP_FADE);
                    const n = Math.round(counts[gi]);
                    return (
                        <div
                            key={g.label}
                            style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: LABEL_GAP, padding: '16px 0' }}
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
                                <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    <span style={{ font: '600 13.5px/1 var(--font-ui)', color: 'hsl(var(--text-100))', whiteSpace: 'nowrap' }}>{g.label}</span>
                                    <span
                                        style={{
                                            font: '500 11.5px/1 var(--font-ui)',
                                            fontVariantNumeric: 'tabular-nums',
                                            color: 'hsl(var(--text-500))',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {n} features
                                    </span>
                                </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, ${CHIP_W}px)`, gap: CHIP_GAP }}>
                                {g.items.map(([name, features], ci) => (
                                    <Chip key={name} name={name} features={features} accent={g.accent} o={rise(t, chipStart(gi, ci), CHIP_FADE)} />
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </AbsoluteFill>
    );
};
