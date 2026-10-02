import React from 'react';
import { RAIL_CSS, DASH_CSS, USAGE_CSS, TP_CSS, SA_CSS, Q_CSS } from './generated-css.js';

/* claude.ai's own token values, dark theme, as measured in the running app and
 * recorded in docs/internals.md. The plugin sheets read these, so getting them
 * right is what makes the mock render the same colours the real thing does.
 *
 * The --border ramp really is near-white on this build — it is reproduced here
 * rather than corrected, because "do not use the border ramp" is exactly the
 * kind of thing the demo should not quietly paper over.
 */
export const TOKENS = `
:root, .app-root {
    --bg-000: 60 1.5873% 12.3529%;
    --bg-100: 0 0% 8.2353%;
    --bg-200: 0 0% 6.6667%;
    --bg-300: 0 0% 5.098%;
    --bg-400: 0 0% 4%;
    --bg-500: 0 0% 3%;
    --text-000: 60 14% 99%;
    --text-100: 60 14.2857% 97.2549%;
    --text-200: 60 10% 88%;
    --text-300: 55 9% 74%;
    --text-400: 48 4.5872% 57.2549%;
    --text-500: 48 5% 45%;
    --border-100: 52.5 11.7647% 86.6667%;
    --border-200: 52.5 11.7647% 86.6667%;
    --border-300: 52.5 11.7647% 86.6667%;
    --border-400: 52.5 11.7647% 86.6667%;
    --accent-100: 14 62% 60%;
    --accent-200: 14 62% 52%;
    --success-100: 140 45% 45%;
    --danger-100: 5 60% 55%;
    --oncolor-100: 0 0% 100%;
    --cui-accent: 14 62% 60%;
    --font-ui: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    --font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
`;

export const RESET = `
* { box-sizing: border-box; }
body { margin: 0; background: #000; }
`;

export const Sheets: React.FC = () => (
    <style
        dangerouslySetInnerHTML={{
            __html: TOKENS + RESET + RAIL_CSS + USAGE_CSS + DASH_CSS + TP_CSS + SA_CSS + Q_CSS,
        }}
    />
);
