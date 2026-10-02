import React from 'react';
import { FOOTER_Y, USAGE_LEFT, USAGE_RIGHT, FOOTER_H } from './layout';
import { CONTEXT_MAX, COMPACT_AT } from './mock';
import { USAGE_DEFAULTS } from './generated-css.js';

/* The composer's context meter, in the plugin's own markup and stylesheet.
 *
 * The plugin used to float a second meter beside this one (the plan's rolling
 * limit); it now lives on the app's own usage ring, so the composer carries
 * context alone plus the auto-compact switch. Context comes from the CLI's own
 * getContextUsage reply; the compaction mark is drawn where the CLI says it
 * fires.
 *
 * .wrap's geometry is the plugin's place(): left edge of the free middle of the
 * footer row + 14, to the right group - 14, BAR_H 22 tall, centred on the row.
 */
const BAR_H = 22;

function short(n: number) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
}

const colour = (f: number) =>
    f >= USAGE_DEFAULTS.danger ? USAGE_DEFAULTS.ctxHot : f >= USAGE_DEFAULTS.warn ? USAGE_DEFAULTS.ctxWarn : USAGE_DEFAULTS.ctxCalm;

export const UsageBar: React.FC<{
    tokens: number;
    show: boolean;
    opacity?: number;
    mark?: boolean;
}> = ({ tokens, show, opacity = USAGE_DEFAULTS.idle, mark = true }) => {
    const frac = Math.max(0, Math.min(1, tokens / CONTEXT_MAX));
    return (
        <div className="cui-usage">
            <div
                className={'wrap' + (show ? ' show' : '')}
                style={{
                    left: USAGE_LEFT,
                    top: Math.round(FOOTER_Y + (FOOTER_H - BAR_H) / 2),
                    width: USAGE_RIGHT - USAGE_LEFT,
                    height: BAR_H,
                    opacity: show ? 1 : 0,
                    transform: 'none',
                }}
            >
                <div className="bar" style={{ opacity }}>
                    <div className="meter" style={{ ['--c' as any]: colour(frac) }}>
                        <span className="label">Context</span>
                        <span className="track">
                            <i className="fill" style={{ width: (frac * 100).toFixed(2) + '%' }} />
                            <b
                                className="compact"
                                style={{ left: ((COMPACT_AT / CONTEXT_MAX) * 100).toFixed(2) + '%', opacity: mark ? 1 : 0 }}
                            />
                        </span>
                        <span className="value">{Math.round(frac * 100)}%</span>
                        <span className="sub">
                            {short(tokens)} / {short(CONTEXT_MAX)}
                        </span>
                    </div>
                    <button className="compact-toggle on" type="button">
                        ⟳
                    </button>
                </div>
            </div>
        </div>
    );
};
