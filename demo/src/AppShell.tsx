import React from 'react';
import { W, H, TITLEBAR, TITLE_H, REGION_TOP, SIDEBAR, COL_X, COL_W, COMPOSER_TOP, COMPOSER_H, FOOTER_H } from './layout';
import { USER_MSG, THINKING, ASSISTANT, CODE } from './mock';
import { Turn, ramp } from './story';

export type ComposerState = { text: string; editing: boolean; running: boolean; caret: boolean };
export type Footer = { model: string; effort: string; open: boolean };
export type Meta = { elapsed: string; tokens: string; chip: { label: string; kind: string } | null; tooltip: string | null };

const BUBBLE: React.CSSProperties = {
    maxWidth: '78%',
    background: 'hsl(var(--bg-000))',
    border: '1px solid rgba(255,255,255,.07)',
    borderRadius: 14,
    padding: '11px 14px',
    color: 'hsl(var(--text-200))',
};

/* A mock of the Claude Desktop window: shell title bar, session sidebar, the
 * claude.ai transcript column and the composer. It exists so the plugins have
 * the same anchors to attach to that they use in the real app — the sidebar's
 * right edge, the composer box, and the free middle of the footer row.
 */

const SESSIONS = [
    ['claude-ui-mod — asar integrity', 'now', true],
    ['task rail placement + tween', '2h'],
    ['usage meters from disk', '5h'],
    ['transcript typography tokens', 'Mon'],
    ['watcher: patch on app close', 'Mon'],
    ['live inject over CDP — dead end', 'Sun'],
];

// The plugin's own rules, with the author's real settings from .state.
function thinkingCss(styled: boolean) {
    if (!styled) {
        return `.mock-think {
            font-family: var(--font-ui); font-style: italic; font-size: 14px; line-height: 20px;
            color: hsl(var(--text-500)); white-space: pre-wrap; max-width: none; margin: 0;
            border-left: 0; padding-left: 0;
        }
        .mock-think::before { content: none; }`;
    }
    const size = 12, leading = 1.62, measure = 81, indent = 14, gap = 10;
    const color = '#c3c2b7', spineColor = '#97958d', spineAlpha = 0.3, spineWidth = 2;
    return `.mock-think {
        font-family: Verdana, Geneva, sans-serif;
        font-style: normal;
        font-size: ${size}px;
        line-height: ${leading};
        color: ${color};
        white-space: pre-wrap;
        max-width: calc(${measure}ch + ${indent}px);
        border-left: ${spineWidth}px solid color-mix(in srgb, ${spineColor} ${Math.round(spineAlpha * 100)}%, transparent);
        padding-left: ${indent}px;
        margin: ${gap}px 0 ${gap + 2}px;
        text-wrap: pretty;
    }
    .mock-think::before {
        content: "thinking";
        display: block;
        font-family: var(--font-ui);
        font-size: 10px; font-weight: 500;
        letter-spacing: .14em; text-transform: uppercase;
        color: ${spineColor};
        margin-bottom: 7px;
    }`;
}

export const AppShell: React.FC<{
    /** characters of the assistant turn revealed so far */
    chars: number;
    thinkingStyled: boolean;
    /** transcript-type: null = the app's own typography */
    type: { size: number; leading: number; face: string } | null;
    scroll: number;
    t: number;
    turns: Turn[];
    meta: Meta | null;
    composer: ComposerState;
    footer: Footer;
}> = ({ chars, thinkingStyled, type, scroll, t, turns, meta, composer, footer }) => {
    const body = type ? type.size : 15;
    const leading = type ? type.leading : 1.6;
    const face = type ? type.face : 'var(--font-ui)';

    return (
        <div
            className="app-root"
            style={{
                position: 'absolute',
                inset: 0,
                width: W,
                height: H,
                background: 'hsl(var(--bg-100))',
                color: 'hsl(var(--text-100))',
                fontFamily: 'var(--font-ui)',
                overflow: 'hidden',
            }}
        >
            <style dangerouslySetInnerHTML={{ __html: thinkingCss(thinkingStyled) }} />

            {/* shell title bar — the main window is a shell page; the UI is a view */}
            <div
                style={{
                    height: TITLEBAR,
                    background: 'hsl(var(--bg-300))',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 12px',
                    gap: 10,
                    borderBottom: '1px solid rgba(255,255,255,.06)',
                }}
            >
                <div style={{ display: 'flex', gap: 7 }}>
                    {['#3a3a3a', '#3a3a3a', '#3a3a3a'].map((c, i) => (
                        <div key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: c }} />
                    ))}
                </div>
                <div style={{ fontSize: 11.5, color: 'hsl(var(--text-400))', marginLeft: 6 }}>Claude</div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: 'hsl(var(--text-500))', fontSize: 12 }}>
                    <span>—</span>
                    <span>▫</span>
                    <span>✕</span>
                </div>
            </div>

            {/* session sidebar — the rail measures its right edge */}
            <div
                className="dframe-sidebar"
                style={{
                    position: 'absolute',
                    left: 0,
                    top: TITLEBAR,
                    bottom: 0,
                    width: SIDEBAR,
                    background: 'hsl(var(--bg-200))',
                    borderRight: '1px solid rgba(255,255,255,.06)',
                    padding: '14px 10px',
                }}
            >
                <div
                    style={{
                        fontSize: 10.5,
                        letterSpacing: '.09em',
                        textTransform: 'uppercase',
                        color: 'hsl(var(--text-500))',
                        padding: '0 8px 10px',
                    }}
                >
                    Code sessions
                </div>
                {SESSIONS.map(([title, when, on], i) => (
                    <div
                        key={i}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 9px',
                            borderRadius: 8,
                            background: on ? 'rgba(255,255,255,.06)' : 'transparent',
                            fontSize: 12,
                            color: on ? 'hsl(var(--text-100))' : 'hsl(var(--text-400))',
                        }}
                    >
                        <span
                            style={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: on ? 'hsl(var(--accent-100))' : 'hsl(var(--text-500))',
                                opacity: on ? 1 : 0.5,
                                flex: '0 0 auto',
                            }}
                        />
                        <span
                            style={{
                                flex: '1 1 auto',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {title as string}
                        </span>
                        <span style={{ fontSize: 10.5, color: 'hsl(var(--text-500))' }}>{when as string}</span>
                    </div>
                ))}
            </div>

            {/* the chat's own title: the subagent rail hangs from the bottom of this
                strip, so the mock needs one for it to hang from */}
            <div
                style={{
                    position: 'absolute',
                    left: SIDEBAR,
                    right: 0,
                    top: TITLEBAR,
                    height: TITLE_H,
                    zIndex: 3,
                    background: 'hsl(var(--bg-100))',
                    borderBottom: '1px solid rgba(255,255,255,.05)',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        left: COL_X - SIDEBAR,
                        top: 0,
                        height: TITLE_H,
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: 12.5,
                        fontWeight: 500,
                        color: 'hsl(var(--text-200))',
                    }}
                >
                    claude-ui-mod — asar integrity
                </div>
            </div>

            {/* transcript column */}
            <div
                style={{
                    position: 'absolute',
                    left: SIDEBAR,
                    right: 0,
                    top: REGION_TOP,
                    bottom: H - COMPOSER_TOP + 12,
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        left: COL_X - SIDEBAR,
                        width: COL_W,
                        top: 12 - scroll,
                        fontFamily: face,
                        fontSize: body,
                        lineHeight: leading,
                        color: 'hsl(var(--text-100))',
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22 }}>
                        <div style={BUBBLE}>{USER_MSG}</div>
                    </div>

                    <div className="mock-think">{THINKING}</div>

                    <div style={{ whiteSpace: 'pre-wrap', marginTop: 14 }}>
                        {renderMarkdown(ASSISTANT.slice(0, chars))}
                        {chars < ASSISTANT.length && (
                            <span
                                style={{
                                    display: 'inline-block',
                                    width: 7,
                                    height: body,
                                    marginLeft: 2,
                                    verticalAlign: '-2px',
                                    background: 'hsl(var(--text-300))',
                                }}
                            />
                        )}
                    </div>

                    {chars >= ASSISTANT.length && (
                        <pre
                            style={{
                                marginTop: 16,
                                padding: '12px 14px',
                                borderRadius: 10,
                                background: 'hsl(var(--bg-300))',
                                border: '1px solid rgba(255,255,255,.07)',
                                fontFamily: 'ui-monospace, Consolas, monospace',
                                fontSize: 11.5,
                                lineHeight: 1.55,
                                color: 'hsl(var(--text-300))',
                                overflow: 'hidden',
                            }}
                        >
                            {CODE}
                        </pre>
                    )}

                    {turns.map((turn, i) => {
                        const last = i === turns.length - 1;
                        const o = ramp(t, turn.userAt, turn.userAt + 0.2);
                        return (
                            <div key={i} style={{ marginTop: 26 }}>
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'flex-end',
                                        opacity: o,
                                        transform: `translateY(${(1 - o) * 6}px)`,
                                    }}
                                >
                                    <div style={BUBBLE}>{turn.user}</div>
                                </div>
                                {turn.chars > 0 && (
                                    <div style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>
                                        {renderMarkdown(turn.text.slice(0, turn.chars))}
                                    </div>
                                )}
                                {last && meta && turn.chars > 0 && <MetaStrip meta={meta} />}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* composer */}
            <div
                style={{
                    position: 'absolute',
                    left: COL_X,
                    top: COMPOSER_TOP,
                    width: COL_W,
                    height: COMPOSER_H,
                    borderRadius: 16,
                    background: 'hsl(var(--bg-000))',
                    border: '1px solid rgba(255,255,255,.09)',
                    boxShadow: '0 8px 30px rgba(0,0,0,.35)',
                    display: 'flex',
                    flexDirection: 'column',
                }}
            >
                <div
                    style={{
                        flex: '1 1 auto',
                        padding: '14px 16px',
                        fontSize: 13.5,
                        lineHeight: 1.5,
                        color: composer.text ? 'hsl(var(--text-100))' : 'hsl(var(--text-500))',
                        overflow: 'hidden',
                    }}
                >
                    {composer.text || 'Reply to Claude…'}
                    {composer.caret && (
                        <span
                            style={{
                                display: 'inline-block',
                                width: 1.5,
                                height: 16,
                                marginLeft: 1,
                                verticalAlign: '-3px',
                                background: 'hsl(var(--text-100))',
                            }}
                        />
                    )}
                </div>
                <div
                    style={{
                        height: FOOTER_H,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '0 12px 6px',
                        fontSize: 11,
                        color: 'hsl(var(--text-500))',
                    }}
                >
                    <span>＋</span>
                    <span>⌘</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 7,
                                padding: '3px 8px',
                                borderRadius: 8,
                                background: footer.open ? 'rgba(255,255,255,.08)' : 'transparent',
                                color: 'hsl(var(--text-300))',
                            }}
                        >
                            <span>{footer.model}</span>
                            {footer.effort && <span style={{ color: 'hsl(var(--text-500))' }}>{footer.effort}</span>}
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </span>
                        {composer.editing ? (
                            // The queue's own page rule: while a queued message is being edited
                            // the send control reads "update queued".
                            <span
                                style={{
                                    height: 24,
                                    padding: '0 10px',
                                    borderRadius: 12,
                                    background: 'color-mix(in srgb, #c96442 16%, transparent)',
                                    color: '#c96442',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    fontSize: 11.5,
                                    fontWeight: 600,
                                    letterSpacing: '.01em',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                update queued
                            </span>
                        ) : (
                            <span
                                style={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: '50%',
                                    background: 'hsl(var(--accent-100))',
                                    color: '#fff',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: 12,
                                }}
                            >
                                {composer.running ? (
                                    <span style={{ width: 9, height: 9, borderRadius: 2, background: '#fff' }} />
                                ) : (
                                    '↑'
                                )}
                            </span>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
};

/** Just enough markdown for the mock: `code` spans and paragraph breaks. */
function renderMarkdown(src: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    const re = /`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(src))) {
        out.push(src.slice(last, m.index));
        out.push(
            <code
                key={k++}
                style={{
                    fontFamily: 'ui-monospace, Consolas, monospace',
                    fontSize: '.9em',
                    padding: '1px 5px',
                    borderRadius: 5,
                    background: 'rgba(255,255,255,.07)',
                }}
            >
                {m[1]}
            </code>,
        );
        last = m.index + m[0].length;
    }
    out.push(src.slice(last));
    return out;
}

/** The app's streaming strip under the newest message: elapsed time, token
 *  count, and — appended by the throughput plugin, as a clone of the app's own
 *  chip — the rate. The separator glyph is the app's icon font; a middle dot
 *  stands in for it. */
const MetaStrip: React.FC<{ meta: Meta }> = ({ meta }) => {
    const sep = <span style={{ padding: '0 7px', opacity: 0.55 }}>·</span>;
    return (
        <div
            style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                marginTop: 10,
                fontSize: 12,
                lineHeight: '16px',
                color: 'hsl(var(--text-500))',
                fontVariantNumeric: 'tabular-nums',
                fontFamily: 'var(--font-ui)',
            }}
        >
            <span>{meta.elapsed}</span>
            {sep}
            <span>{meta.tokens}</span>
            {meta.chip && (
                <span data-cuimod-tps="1" style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {sep}
                    <span>{meta.chip.label}</span>
                </span>
            )}
            {meta.tooltip && (
                <div
                    style={{
                        position: 'absolute',
                        left: 150,
                        top: 26,
                        width: 'max-content',
                        maxWidth: 330,
                        padding: '5px 8px',
                        font: '12px/1.35 var(--font-ui)',
                        color: 'hsl(var(--text-100))',
                        background: 'hsl(0 0% 17%)',
                        border: '1px solid rgba(255,255,255,.14)',
                        borderRadius: 3,
                        boxShadow: '0 4px 14px rgba(0,0,0,.5)',
                        zIndex: 5,
                    }}
                >
                    {meta.tooltip}
                </div>
            )}
        </div>
    );
};
