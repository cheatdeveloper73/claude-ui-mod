import React from 'react';
import { LIMIT_LABEL, LIMIT_PCT, LIMIT_SERIES } from './mock';

/* The same bar, laid out inline instead of floating — this is what the preview
 * frames stage at 1:1. A preview that reflowed to fit the panel would not be a
 * preview.
 */

function sparkPath(series: number[], w: number, h: number) {
    const max = Math.max(100, ...series);
    const step = w / (series.length - 1);
    const y = (n: number) => h - (n / max) * (h - 1) - 0.5;
    let d = `M0 ${y(series[0]).toFixed(2)}`;
    for (let i = 1; i < series.length; i++) d += ` L${(i * step).toFixed(2)} ${y(series[i]).toFixed(2)}`;
    return { line: d, area: d + ` L${w} ${h} L0 ${h} Z` };
}

export const UsageBarSample: React.FC<{ spark: boolean; idle: number }> = ({ spark, idle }) => {
    const path = spark ? sparkPath(LIMIT_SERIES, 46, 11) : null;
    return (
        <div className="cui-usage" style={{ display: 'block' }}>
            <div className="bar" style={{ opacity: idle, width: 480 }}>
                <div className="m ctx calm" style={{ ['--c' as any]: '#8ecae6' }}>
                    <span className="k">context</span>
                    <span className="tr">
                        <i style={{ width: '24.40%' }} />
                        <b style={{ left: '96.70%', opacity: 1 }} />
                    </span>
                    <span className="v">24%</span>
                    <span className="sub">244k / 1M</span>
                </div>
                <div className="sep" />
                <div className="m lim calm" style={{ ['--c' as any]: '#9fd8a8' }}>
                    <span className="k">{LIMIT_LABEL}</span>
                    <span className="tr">
                        <i style={{ width: LIMIT_PCT + '%' }} />
                    </span>
                    <span className="v">{LIMIT_PCT}%</span>
                    <svg className="spark" width={path ? 46 : 0} height={11} viewBox="0 0 46 11">
                        <path className="area" d={path ? path.area : ''} />
                        <path d={path ? path.line : ''} />
                    </svg>
                    <span className="sub">Aug 31, 9:00 AM</span>
                </div>
            </div>
        </div>
    );
};
