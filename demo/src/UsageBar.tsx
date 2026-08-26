import React from 'react';
import { FOOTER_Y, USAGE_LEFT, USAGE_RIGHT, FOOTER_H } from './layout';
import { CONTEXT_MAX, COMPACT_AT, LIMIT_LABEL, LIMIT_PCT, LIMIT_SERIES, RESETS } from './mock';

/* The meters, in the plugin's own markup and stylesheet. Numbers come from the
 * same places the plugin reads them: context from the CLI's own getContextUsage
 * reply, the plan percentage from plan-usage-history.json, the reset string
 * scraped off the app's band before it is hidden.
 */

const PALETTE = {
    ctx: ['#8ecae6', '#a9a0f0', '#cf8ef5'],
    lim: ['#9fd8a8', '#f3cb8a', '#f5949a'],
};
const WARN = 0.6;
const DANGER = 0.85;

const sev = (f: number) => (f >= DANGER ? 2 : f >= WARN ? 1 : 0);
const sevName = ['calm', 'warn', 'danger'];

function short(n: number) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
}

function shortReset(t: string) {
    const m = t.match(/^([A-Za-z]{3})[^,]*,\s*[^,]+,\s*(.+)$/);
    return m ? m[1] + ' ' + m[2] : t;
}

function sparkPath(series: number[], w: number, h: number) {
    const max = Math.max(100, ...series);
    const step = w / (series.length - 1);
    const y = (n: number) => h - (n / max) * (h - 1) - 0.5;
    let d = `M0 ${y(series[0]).toFixed(2)}`;
    for (let i = 1; i < series.length; i++) d += ` L${(i * step).toFixed(2)} ${y(series[i]).toFixed(2)}`;
    return { line: d, area: d + ` L${w} ${h} L0 ${h} Z` };
}

export const UsageBar: React.FC<{
    tokens: number;
    show: boolean;
    opacity?: number;
    spark?: boolean;
    showResets?: boolean;
}> = ({ tokens, show, opacity = 0.55, spark = false, showResets = true }) => {
    const frac = Math.max(0, Math.min(1, tokens / CONTEXT_MAX));
    const cs = sev(frac);
    const ls = sev(LIMIT_PCT / 100);
    const path = spark ? sparkPath(LIMIT_SERIES, 46, 11) : null;

    return (
        <div className="cui-usage">
            {/* .wrap's own rules live in the plugin's HOST_CSS, which is built
                per-window rather than from a literal; its geometry is restated
                here instead of extracted. */}
            <div
                className={'wrap' + (show ? ' show' : '')}
                style={{
                    position: 'fixed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 2147482900,
                    left: USAGE_LEFT,
                    top: FOOTER_Y,
                    width: USAGE_RIGHT - USAGE_LEFT,
                    height: FOOTER_H,
                    opacity: show ? 1 : 0,
                }}
            >
                <div
                    className={'bar' + (cs || ls ? ' alert' : '')}
                    style={{ opacity: cs || ls ? Math.min(1, opacity + 0.35) : opacity }}
                >
                    <div
                        className={'m ctx ' + sevName[cs] + (cs ? ' hot' : '')}
                        style={{ ['--c' as any]: PALETTE.ctx[cs] }}
                    >
                        <span className="k">context</span>
                        <span className="tr">
                            <i style={{ width: (frac * 100).toFixed(2) + '%' }} />
                            <b style={{ left: ((COMPACT_AT / CONTEXT_MAX) * 100).toFixed(2) + '%', opacity: 1 }} />
                        </span>
                        <span className="v">{Math.round(frac * 100)}%</span>
                        <span className="sub">
                            {short(tokens)} / {short(CONTEXT_MAX)}
                        </span>
                    </div>

                    <div className="sep" />

                    <div
                        className={'m lim ' + sevName[ls] + (ls ? ' hot' : '')}
                        style={{ ['--c' as any]: PALETTE.lim[ls] }}
                    >
                        <span className="k">{LIMIT_LABEL}</span>
                        <span className="tr">
                            <i style={{ width: LIMIT_PCT.toFixed(2) + '%' }} />
                        </span>
                        <span className="v">{LIMIT_PCT}%</span>
                        <svg className="spark" width={path ? 46 : 0} height={11} viewBox="0 0 46 11">
                            <path className="area" d={path ? path.area : ''} />
                            <path d={path ? path.line : ''} />
                        </svg>
                        <span className="sub">{showResets ? shortReset(RESETS) : ''}</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
