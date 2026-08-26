import React from 'react';
import { W, H, TITLEBAR, SIDEBAR, COL_X, COL_W, COMPOSER_TOP, COMPOSER_H, FOOTER_H } from './layout';
import { USER_MSG, THINKING, ASSISTANT, CODE } from './mock';

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
}> = ({ chars, thinkingStyled, type, scroll }) => {
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

            {/* transcript column */}
            <div
                style={{
                    position: 'absolute',
                    left: SIDEBAR,
                    right: 0,
                    top: TITLEBAR,
                    bottom: H - COMPOSER_TOP + 12,
                    overflow: 'hidden',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        left: COL_X - SIDEBAR,
                        width: COL_W,
                        top: 24 - scroll,
                        fontFamily: face,
                        fontSize: body,
                        lineHeight: leading,
                        color: 'hsl(var(--text-100))',
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 22 }}>
                        <div
                            style={{
                                maxWidth: '78%',
                                background: 'hsl(var(--bg-000))',
                                border: '1px solid rgba(255,255,255,.07)',
                                borderRadius: 14,
                                padding: '11px 14px',
                                color: 'hsl(var(--text-200))',
                            }}
                        >
                            {USER_MSG}
                        </div>
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
                        color: 'hsl(var(--text-500))',
                    }}
                >
                    Reply to Claude…
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
                        <span>Opus 5</span>
                        <span>high</span>
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
                            ↑
                        </span>
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
