/* claude-ui-mod :: transcript-copy (renderer)
 *
 * One button, one toast. The work is all in main.js; this decides where the
 * button sits, what the toast says, and which settings the dashboard offers.
 *
 * The button is fixed to a viewport corner rather than anchored to anything the
 * app draws. That is deliberate: every selector into the Code UI is a silent
 * breakage waiting for the next claude.ai deploy, and this button has no reason
 * to know where the composer is. The default corner is the right gutter, which
 * is empty at every width the app lays out (the composer column ends well short
 * of it, the task rail lives in the LEFT gutter, and the app's own toast lane is
 * lower still at bottom-right).
 */
'use strict';

const HOST_ID = 'cuimod-tcopy';

let values = null;          // last applied settings
let sampleBox = null;       // dashboard <pre>, when the panel is open
let sampleTimer = null;
let busy = false;

// ------------------------------------------------------------------ chrome
const host = document.createElement('div');
host.id = HOST_ID;
const root = host.attachShadow({ mode: 'open' });

const style = document.createElement('style');
root.append(style);

const pill = document.createElement('button');
pill.className = 'pill';
pill.type = 'button';

const glyph = document.createElement('span');
glyph.className = 'ic';
glyph.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
    + '<rect x="5.2" y="2.2" width="8.6" height="11.6" rx="1.6"/>'
    + '<path d="M10.8 2.2H3.8A1.6 1.6 0 0 0 2.2 3.8v8.4"/></svg>';

const label = document.createElement('span');
label.className = 'lb';
label.textContent = 'Copy transcript';

pill.append(glyph, label);

const toast = document.createElement('div');
toast.className = 'toast';

root.append(pill, toast);
document.documentElement.appendChild(host);
ctx.onDispose(() => { try { host.remove(); } catch (_) {} });

function css(v) {
    const bottom = v.corner.indexOf('bottom') === 0;
    const right = v.corner.indexOf('right') !== -1;
    return `
:host { all: initial; }
.pill, .toast {
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    box-sizing: border-box;
}
.pill {
    position: fixed;
    ${bottom ? 'bottom' : 'top'}: ${v.offsetY}px;
    ${right ? 'right' : 'left'}: ${v.offsetX}px;
    z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 7px;
    padding: ${v.compact ? '7px' : '7px 12px 7px 10px'};
    border-radius: 999px;
    font-size: ${v.fontSize}px; font-weight: 500; line-height: 1;
    color: hsl(var(--text-200, 55 9% 74%));
    background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) ${Math.round(v.tint * 100)}%, transparent);
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) ${Math.round(v.border * 100)}%, transparent);
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 22px rgba(0,0,0,.10);
    opacity: ${v.opacity};
    cursor: pointer;
    transition: opacity .12s ease, transform .12s ease, color .12s ease;
    -webkit-app-region: no-drag;
}
.pill:hover { opacity: 1; color: hsl(var(--text-100, 60 14% 97%)); }
.pill:active { transform: scale(.97); }
.pill[disabled] { opacity: ${(v.opacity * 0.45).toFixed(2)}; cursor: default; }
.pill.hide { display: none; }
.pill.work .ic { animation: spin .7s linear infinite; }
.pill.ok { color: hsl(var(--accent-secondary-100, 140 50% 45%)); }
.pill.err { color: hsl(var(--danger-100, 0 60% 60%)); }
.lb { display: ${v.compact ? 'none' : 'inline'}; white-space: nowrap; }
.ic { display: inline-flex; }
@keyframes spin { to { transform: rotate(360deg); } }

.toast {
    position: fixed;
    ${bottom ? 'bottom' : 'top'}: ${v.offsetY + 42}px;
    ${right ? 'right' : 'left'}: ${v.offsetX}px;
    z-index: 2147483000;
    max-width: 340px;
    padding: 9px 12px;
    border-radius: 10px;
    font-size: 12px; line-height: 1.45;
    color: hsl(var(--text-100, 60 14% 97%));
    background: hsl(var(--bg-200, 0 0% 6.7%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
    box-shadow: 0 2px 6px rgba(0,0,0,.12), 0 14px 40px rgba(0,0,0,.22);
    opacity: 0; transform: translateY(${bottom ? '6px' : '-6px'});
    pointer-events: none;
    transition: opacity .16s ease, transform .16s ease;
}
.toast.show { opacity: 1; transform: none; pointer-events: auto; }
.toast b { display: block; font-weight: 600; margin-bottom: 2px; }
.toast i { font-style: normal; color: hsl(var(--text-400, 48 5% 57%)); }
.toast.err b { color: hsl(var(--danger-100, 0 60% 60%)); }
`;
}

// ------------------------------------------------------------------ toast
let toastTimer = null;
function flash(title, detail, bad) {
    toast.className = 'toast show' + (bad ? ' err' : '');
    toast.textContent = '';
    const b = document.createElement('b');
    b.textContent = title;
    toast.append(b);
    if (detail) {
        const i = document.createElement('i');
        i.textContent = detail;
        toast.append(i);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.classList.remove('show'); }, bad ? 5200 : 3400);
}
toast.addEventListener('click', () => { clearTimeout(toastTimer); toast.classList.remove('show'); });
ctx.onDispose(() => clearTimeout(toastTimer));

function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
const n = (x) => Number(x || 0).toLocaleString('en-US');

// ------------------------------------------------------------------ the copy
let stateTimer = null;
async function copy() {
    if (busy) return;
    const sid = cuimod.sessionId;
    if (!sid) { flash('No session on screen', 'Open a Code session first.', true); return; }

    busy = true;
    pill.classList.remove('ok', 'err');
    pill.classList.add('work');
    clearTimeout(stateTimer);

    let r = null;
    try { r = await cuimod.rpc('transcript-copy.copy', { cliSid: sid, options: values || {} }); }
    catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }

    busy = false;
    pill.classList.remove('work');

    if (!r || !r.ok) {
        pill.classList.add('err');
        flash('Copy failed', (r && r.reason) || 'unknown error', true);
    } else {
        pill.classList.add('ok');
        const c = r.counts || {};
        const bits = [n(r.entries) + ' entries', size(r.bytes)];
        if (c.thinking) bits.push(n(c.thinking) + ' thinking');
        if (c.tool) bits.push(n(c.tool) + ' tools');
        if (c.image) bits.push(n(c.image) + ' images');
        if (r.agents) bits.push(n(r.agents) + ' subagents');
        if (r.dropped) bits.push(n(r.dropped) + ' older entries left out');
        flash('Transcript copied', bits.join('  ·  '));
    }
    stateTimer = setTimeout(() => pill.classList.remove('ok', 'err'), 1600);
}
ctx.onDispose(() => clearTimeout(stateTimer));

// Clicking the button must not pull focus out of the composer: a half-typed
// prompt loses its caret otherwise, and copying is not a reason to interrupt.
pill.addEventListener('mousedown', (e) => e.preventDefault());
pill.addEventListener('click', copy);

// The hotkey is registered on window in the isolated world, so it fires before
// the page sees the key. Alt+Shift avoids every editing chord the composer owns.
ctx.track(window, 'keydown', (e) => {
    if (!values || !values.hotkey || !values.enabled) return;
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code !== 'KeyC') return;
    e.preventDefault();
    e.stopPropagation();
    copy();
}, { capture: true });

// A view with no session (the new-chat screen) has nothing to copy, so the
// button goes away rather than sitting there failing.
function syncVisible() {
    const on = !!(values && values.enabled) && !!cuimod.sessionId;
    pill.classList.toggle('hide', !on);
    if (!on) toast.classList.remove('show');
}
cuimod.onSessionChange(syncVisible);
ctx.every(1500, syncVisible);

// ------------------------------------------------------------------ dashboard
function refreshSample() {
    if (!sampleBox) return;
    clearTimeout(sampleTimer);
    sampleTimer = setTimeout(() => {
        const box = sampleBox;
        cuimod.rpc('transcript-copy.sample', { options: values || {} })
            .then((r) => { if (box === sampleBox && r && r.text) box.textContent = r.text; })
            .catch(() => {});
    }, 140);
}
ctx.onDispose(() => clearTimeout(sampleTimer));

function apply(v) {
    values = v;
    style.textContent = css(v);
    syncVisible();
    refreshSample();
}

const spec = {
    plugin: 'transcript-copy',
    title: 'Copy transcript',
    description: 'One button that puts the whole session on the clipboard, tagged by role.',
    defaults: {
        enabled: true,
        hotkey: true,
        corner: 'bottom-right',
        offsetX: 24,
        offsetY: 132,
        fontSize: 12,
        compact: false,
        opacity: 0.8,
        tint: 1,
        border: 0.12,

        format: 'tags',
        legend: true,
        timestamps: true,
        models: true,
        thinking: true,
        toolCalls: true,
        toolResults: true,
        system: false,
        attachments: false,
        subagents: false,
        images: 'placeholder',

        toolInputMax: 2000,
        toolResultMax: 4000,
        textMax: 0,
        tailEntries: 0,
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Show button', group: 'Button' },
        { key: 'hotkey', type: 'toggle', label: 'Alt+Shift+C', hint: 'Copies without reaching for the button.', group: 'Button' },
        { key: 'corner', type: 'combo', label: 'Corner', group: 'Button', options: [
            { value: 'bottom-right', label: 'Bottom right' },
            { value: 'bottom-left', label: 'Bottom left' },
            { value: 'top-right', label: 'Top right' },
            { value: 'top-left', label: 'Top left' },
        ] },
        { key: 'offsetX', type: 'slider', label: 'Side offset', min: 8, max: 600, step: 2, unit: 'px', group: 'Button' },
        { key: 'offsetY', type: 'slider', label: 'Vertical offset', min: 8, max: 600, step: 2, unit: 'px',
          hint: 'The app draws its own toasts in the bottom-right corner; the default clears them.', group: 'Button' },
        { key: 'compact', type: 'toggle', label: 'Icon only', group: 'Button' },
        { key: 'fontSize', type: 'slider', label: 'Label size', min: 10, max: 16, step: 0.5, unit: 'px', group: 'Button' },
        { key: 'opacity', type: 'slider', label: 'Resting opacity', min: 0.2, max: 1, step: 0.01,
          hint: 'Hover always takes it to full.', group: 'Button' },
        { key: 'tint', type: 'slider', label: 'Background opacity', min: 0, max: 1, step: 0.01, group: 'Button' },
        { key: 'border', type: 'slider', label: 'Border strength', min: 0, max: 0.5, step: 0.01, group: 'Button' },

        { key: 'thinking', type: 'toggle', label: 'Thinking', hint: 'The reasoning blocks the transcript view collapses.', group: 'What gets copied' },
        { key: 'toolCalls', type: 'toggle', label: 'Tool calls', hint: 'Name and full input, as JSON.', group: 'What gets copied' },
        { key: 'toolResults', type: 'toggle', label: 'Tool results', group: 'What gets copied' },
        { key: 'system', type: 'toggle', label: 'Injected context',
          hint: 'Skill bodies and system-reminders. They arrive on the user role but nobody typed them, so they are tagged <system>.',
          group: 'What gets copied' },
        { key: 'attachments', type: 'toggle', label: 'Attachment records',
          hint: 'The harness bookkeeping lines: token reminders, file-edit records, queued commands. Verbose.', group: 'What gets copied' },
        { key: 'subagents', type: 'toggle', label: 'Subagent transcripts',
          hint: 'Appends each agent that ran under this session, in spawn order. A busy session adds megabytes.',
          group: 'What gets copied' },
        { key: 'images', type: 'combo', label: 'Images', group: 'What gets copied', options: [
            { value: 'placeholder', label: 'Note the image and its size' },
            { value: 'dataurl', label: 'Full base64 data URI' },
            { value: 'omit', label: 'Leave them out' },
        ], hint: 'A data URI is the real bytes: one screenshot is typically 30-300 KB of text.' },

        { key: 'format', type: 'combo', label: 'Format', group: 'Shape', options: [
            { value: 'tags', label: 'Tags — <user> <thinking> <tool>' },
            { value: 'markdown', label: 'Markdown headings' },
        ] },
        { key: 'legend', type: 'toggle', label: 'Legend line', hint: 'Three lines at the top saying what the tags mean.', group: 'Shape' },
        { key: 'timestamps', type: 'toggle', label: 'Timestamps', group: 'Shape' },
        { key: 'models', type: 'toggle', label: 'Model and effort', group: 'Shape' },

        { key: 'toolInputMax', type: 'slider', label: 'Tool input cap', min: 0, max: 20000, step: 250, unit: ' chars',
          hint: '0 copies every tool input in full.', group: 'Limits' },
        { key: 'toolResultMax', type: 'slider', label: 'Tool result cap', min: 0, max: 40000, step: 500, unit: ' chars',
          hint: '0 copies every tool result in full.', group: 'Limits' },
        { key: 'textMax', type: 'slider', label: 'Message cap', min: 0, max: 40000, step: 500, unit: ' chars',
          hint: 'Applies to replies, prompts and thinking. 0 is uncapped.', group: 'Limits' },
        { key: 'tailEntries', type: 'slider', label: 'Keep last', min: 0, max: 2000, step: 10, unit: ' entries',
          hint: '0 copies the whole session. An entry is one message, one tool call or one result.', group: 'Limits' },

        { key: '_now', type: 'custom', label: 'Copy now', hint: 'Uses the session the window is showing.', group: 'Limits',
          node() {
              const b = document.createElement('div');
              b.textContent = 'Copy to clipboard';
              b.style.cssText = 'padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;'
                  + 'border:1px solid color-mix(in srgb, hsl(var(--text-100)) 14%, transparent);'
                  + 'background:color-mix(in srgb, hsl(var(--text-100)) 6%, transparent);';
              b.addEventListener('click', () => copy());
              return b;
          } },

        { key: '_sample', type: 'custom', label: 'Sample output', wide: true, group: 'Sample',
          hint: 'The same formatter, on a seven-line stand-in transcript.',
          node() {
              const pre = document.createElement('pre');
              // The dashboard's shared scroller styling; without it this box
              // draws the OS scrollbar inside a styled card.
              pre.className = 'cui-scroll';
              pre.style.cssText = 'margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;'
                  + 'font-family:var(--font-mono, ui-monospace, Consolas, monospace);font-size:11px;line-height:1.5;'
                  + 'padding:10px 12px;border-radius:10px;color:hsl(var(--text-200));'
                  + 'background:color-mix(in srgb, hsl(var(--text-100)) 5%, transparent);'
                  + 'border:1px solid color-mix(in srgb, hsl(var(--text-100)) 10%, transparent);';
              pre.textContent = 'building…';
              sampleBox = pre;
              refreshSample();
              return pre;
          } },
    ],
    apply,
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
    sampleBox = null;
});

// Stand alone if the dashboard is not loaded: nothing else would ever call apply.
if (REG.subs.size === 0) apply(spec.defaults);
