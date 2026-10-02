import React from 'react';
import { USAGE_DEFAULTS } from './generated-css.js';

/* The same bar, laid out inline instead of floating — this is what the preview
 * frames stage at 1:1, and it is the plugin's own preview node: a 470px hold, a
 * context meter at 35%, the compaction mark at 92%. A preview that reflowed to
 * fit the panel would not be a preview.
 */
export const UsageBarSample: React.FC<{ idle: number }> = ({ idle }) => (
    <div className="cui-usage" style={{ display: 'block' }}>
        <div style={{ width: 470 }}>
            <div className="bar" style={{ opacity: idle }}>
                <div className="meter" style={{ ['--c' as any]: USAGE_DEFAULTS.ctxCalm }}>
                    <span className="label">Context</span>
                    <span className="track">
                        <i className="fill" style={{ width: '35%' }} />
                        <b className="compact" style={{ left: '92%' }} />
                    </span>
                    <span className="value">35%</span>
                    <span className="sub">347k / 1M</span>
                </div>
                <button className="compact-toggle on" type="button">
                    ⟳
                </button>
            </div>
        </div>
    </div>
);
