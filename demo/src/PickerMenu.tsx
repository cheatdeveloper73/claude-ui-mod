import React from 'react';
import { COL_X, COL_W, COMPOSER_BOTTOM, FOOTER_H } from './layout';
import { PROVIDERS, TAB_MODELS, EFFORT_LABEL, pickerAt, PAD, STRIP_H, ROW_H, DIV_H, EFFORT_H, menuHeight } from './story';

/* The native model picker with the provider strip the plugin adds to it.
 *
 * Real: the strip itself. Its element structure and every inline style below
 * are copied from decorate() in src/plugins/provider-picker/renderer.js — the
 * column of rows, the 4px gaps, the tab padding, the selected tab's
 * `color-mix(currentColor 10%)` fill. The model names and their order are the
 * shipped catalogue's.
 *
 * Drawn by hand: everything around it. The popup shell, its rows and the effort
 * slider belong to claude.ai's frontend, which is not in this repository, so
 * they are an approximation of the app's look, sized so the geometry (and
 * therefore the pointer path) is fixed.
 */
export const MENU_W = 296;
export const MENU_RIGHT = COL_X + COL_W - 40;
export const MENU_LEFT = MENU_RIGHT - MENU_W;
export const MENU_BOTTOM = COMPOSER_BOTTOM - FOOTER_H - 6;
// The three-row menu (Claude and OpenAI tabs, effort slider showing).
export const MENU_H = menuHeight(3, true);
export const MENU_TOP = MENU_BOTTOM - MENU_H;

// The strip is a single row of four tabs: the plugin groups tabs four to a row
// (TAB_COLUMNS), so the fourth provider does not wrap. Each tab takes its
// content width (`flex: 1 1 auto; min-width: max-content`) plus an equal share
// of what is left of the 272px the 296px menu gives the strip. These centres,
// measured from the menu's left edge, are those tabs as Chromium lays them out
// at 12px in this font stack (Claude 54px, OpenAI 58px, Meta 45px, Command Code
// 104px wide, 4px gaps).
const TAB_X = [39.0, 98.8, 154.0, 232.2];
export const tabCenter = (i: number) => ({ x: MENU_LEFT + TAB_X[i], y: MENU_TOP + PAD + 5 + 13 });
export const menuTop = (h: number) => MENU_BOTTOM - h;
export const rowCenterAt = (i: number, h: number) => ({
    x: MENU_LEFT + 90,
    y: menuTop(h) + PAD + STRIP_H + ROW_H * i + ROW_H / 2,
});
export const rowCenter = (i: number) => rowCenterAt(i, MENU_H);
const TRACK_L = MENU_LEFT + 34;
const TRACK_W = 228;
export const stopX = (pos: number) => TRACK_L + (pos / 4) * TRACK_W;
export const SLIDER_Y = MENU_TOP + PAD + STRIP_H + 3 * ROW_H + DIV_H + 42;
export const TRIGGER = { x: COL_X + COL_W - 12 - 24 - 12 - 54, y: COMPOSER_BOTTOM - 18 };

const TAB_GAP = 4;

export const PickerMenu: React.FC<{
    t: number;
    hoverRow: number | null;
}> = ({ t, hoverRow }) => {
    const p = pickerAt(t);
    if (p.open <= 0) return null;

    const models = TAB_MODELS[p.tab];
    const checkedName = p.model;
    const stopPct = p.pos / 4;

    return (
        <div
            style={{
                position: 'absolute',
                left: MENU_LEFT,
                top: menuTop(p.h),
                width: MENU_W,
                height: p.h,
                overflow: 'hidden',
                boxSizing: 'border-box',
                padding: PAD,
                borderRadius: 14,
                background: 'hsl(var(--bg-000))',
                border: '1px solid rgba(255,255,255,.1)',
                boxShadow: '0 14px 44px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35)',
                opacity: p.open,
                transform: `translateY(${(1 - p.open) * 6}px)`,
                zIndex: 40,
                color: 'hsl(var(--text-100))',
                fontFamily: 'var(--font-ui)',
                userSelect: 'none',
            }}
        >
            {/* ---- the plugin's strip, inline styles verbatim ---- */}
            <div
                role="tablist"
                aria-label="Model provider"
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    rowGap: TAB_GAP,
                    padding: '5px 6px 7px',
                    height: STRIP_H,
                    boxSizing: 'border-box',
                }}
            >
                <div style={{ display: 'flex', gap: TAB_GAP, width: '100%' }}>
                    {PROVIDERS.map((label, i) => {
                        const on = i === p.tab;
                        return (
                            <button
                                key={label}
                                type="button"
                                role="tab"
                                aria-selected={on}
                                style={{
                                    flex: '1 1 auto',
                                    minWidth: 'max-content',
                                    whiteSpace: 'nowrap',
                                    textAlign: 'center',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    border: 0,
                                    borderRadius: 7,
                                    padding: '5px 6px',
                                    font: 'inherit',
                                    fontSize: 12,
                                    lineHeight: '16px',
                                    userSelect: 'none',
                                    background: on ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
                                    color: on ? 'hsl(var(--text-100))' : 'hsl(var(--text-400))',
                                }}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ---- native rows ---- */}
            <div>
                {models.map((m, i) => {
                    const checked = m.name === checkedName;
                    return (
                        <div
                            key={m.id}
                            role="menuitemradio"
                            aria-checked={checked}
                            style={{
                                height: ROW_H,
                                boxSizing: 'border-box',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 10px',
                                borderRadius: 8,
                                fontSize: 13,
                                background: hoverRow === i ? 'rgba(255,255,255,.07)' : 'transparent',
                            }}
                        >
                            <span style={{ flex: '1 1 auto' }}>{m.name}</span>
                            {checked && (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--accent-100))" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                                </svg>
                            )}
                        </div>
                    );
                })}
            </div>

            {p.hasEffort && (<>
            <div style={{ height: DIV_H, display: 'flex', alignItems: 'center', padding: '0 4px' }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.08)' }} />
            </div>

            {/* ---- the native effort slider ---- */}
            <div style={{ height: EFFORT_H, boxSizing: 'border-box', padding: '10px 14px 0', position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center', height: 16, fontSize: 12 }}>
                    <span style={{ color: 'hsl(var(--text-300))' }}>Effort</span>
                    <span style={{ marginLeft: 'auto', color: 'hsl(var(--text-100))', fontWeight: 500 }}>
                        {EFFORT_LABEL[p.stop]}
                    </span>
                </div>
                {/* positions are absolute to the menu so the pointer path can aim at them */}
                <div style={{ position: 'absolute', left: TRACK_L - MENU_LEFT - PAD - 1, top: 40, width: TRACK_W, height: 4 }}>
                    <div style={{ position: 'absolute', inset: 0, borderRadius: 2, background: 'color-mix(in srgb, hsl(var(--text-100)) 16%, transparent)' }} />
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${stopPct * 100}%`, borderRadius: 2, background: 'hsl(var(--accent-100))' }} />
                    {[0, 1, 2, 3, 4].map((k) => (
                        <div
                            key={k}
                            style={{
                                position: 'absolute',
                                left: `calc(${k * 25}% - 2px)`,
                                top: 0,
                                width: 4,
                                height: 4,
                                borderRadius: '50%',
                                background: k <= p.stop ? 'hsl(var(--bg-000))' : 'color-mix(in srgb, hsl(var(--text-100)) 30%, transparent)',
                                opacity: k <= p.stop ? 0.55 : 1,
                            }}
                        />
                    ))}
                    <div
                        style={{
                            position: 'absolute',
                            left: `calc(${stopPct * 100}% - 8px)`,
                            top: -6,
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: 'hsl(var(--text-100))',
                            boxShadow: p.dragging
                                ? '0 1px 3px rgba(0,0,0,.5), 0 0 0 6px color-mix(in srgb, hsl(var(--accent-100)) 24%, transparent)'
                                : '0 1px 3px rgba(0,0,0,.5)',
                            transform: p.dragging ? 'scale(1.12)' : 'none',
                        }}
                    />
                </div>
                <div
                    style={{
                        position: 'absolute',
                        left: TRACK_L - MENU_LEFT - PAD - 1 - 20,
                        top: 62,
                        width: TRACK_W + 40,
                        height: 14,
                        fontSize: 10.5,
                        color: 'hsl(var(--text-500))',
                    }}
                >
                    {EFFORT_LABEL.map((label, k) => (
                        <span
                            key={label}
                            style={{
                                position: 'absolute',
                                left: 20 + (k / 4) * TRACK_W,
                                transform: 'translateX(-50%)',
                                whiteSpace: 'nowrap',
                                color: k === p.stop ? 'hsl(var(--text-200))' : undefined,
                            }}
                        >
                            {k === 3 ? 'xHigh' : label}
                        </span>
                    ))}
                </div>
            </div>
            </>)}
        </div>
    );
};
