/* claude-ui-mod :: classic-stop (renderer)
 *
 * Restores the quiet outlined stop mark that the Code composer used before the
 * icon-font glyph changed. The app still owns the button and interrupt action;
 * this sheet replaces only the decorative glyph inside it.
 */
'use strict';

const style = document.createElement('style');
style.id = 'cuimod-classic-stop';
style.textContent = `
button[data-testid="code-prompt-stop"] [data-cds="Icon"] {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 16px !important;
    height: 16px !important;
    font-size: 0 !important;
}
button[data-testid="code-prompt-stop"] [data-cds="Icon"]::before {
    content: '\\e0ea';
    font-family: 'Anthropicons-Variable';
    font-size: 16px;
    font-weight: 533.3;
    line-height: 16px;
    color: var(--cds-text-secondary);
}
`;
(document.head || document.documentElement).appendChild(style);
ctx.onDispose(() => { try { style.remove(); } catch (_) {} });
