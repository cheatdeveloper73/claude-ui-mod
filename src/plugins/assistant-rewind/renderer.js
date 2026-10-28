'use strict';

const CLASS = 'cuimod-assistant-rewind';
const buttons = new Set();
let pending = null;
let dialogSession = null;
let working = false;
let disposed = false;
let epoch = 0;

const sheet = document.createElement('style');
sheet.textContent = `
[data-testid="transcript-row"][data-perf-row="assistant_text"] > [data-epitaxy-entry],
[data-cuimod-rewind-text] { position: relative; }
[data-cuimod-rewind-text] > .${CLASS} { right: -28px; }
.${CLASS} {
    position: absolute; right: 6px; top: 0; display: inline-flex;
    align-items: center; justify-content: center; width: 24px; height: 24px;
    border: 0; border-radius: 5px; background: transparent;
    color: hsl(var(--text-400, 48 5% 57%)); cursor: pointer;
    opacity: 0; transition: opacity .12s; -webkit-app-region: no-drag;
}
[data-testid="transcript-row"]:hover .${CLASS}, .${CLASS}:focus-visible { opacity: 1; }
.${CLASS}:hover { color: hsl(var(--text-100, 60 14% 97%)); background: rgba(128,128,128,.12); }
@media (hover: none) { .${CLASS} { opacity: 1; } }
`;
document.documentElement.append(sheet);
const host = document.createElement('div');
host.id = 'cuimod-assistant-rewind';
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = `<style>
:host { all: initial; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: hsl(var(--text-100,60 14% 97%)); }
.backdrop { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; background: rgba(0,0,0,.5); padding: 16px; }
.backdrop[hidden] { display: none; }
.dialog { width: min(440px, calc(100vw - 32px)); box-sizing: border-box; border-radius: 12px; padding: 22px;
    background: hsl(var(--bg-100,0 0% 8%)); border: 1px solid rgba(128,128,128,.3); box-shadow: 0 16px 64px rgba(0,0,0,.35); }
h2 { margin: 0 0 12px; font-size: 17px; font-weight: 600; }
p { margin: 12px 0; color: hsl(var(--text-200,55 9% 74%)); }
.preview { padding: 10px 12px; border-left: 2px solid rgba(128,128,128,.4); white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 150px; overflow: auto; color: hsl(var(--text-200,55 9% 74%)); }
.error { color: hsl(var(--danger-100,0 65% 65%)); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
button { border-radius: 7px; border: 1px solid rgba(128,128,128,.3); padding: 7px 12px; cursor: pointer; font: inherit;
    background: transparent; color: inherit; }
button:disabled { opacity: .5; cursor: default; }
.confirm { background: hsl(var(--text-100,60 14% 97%)); color: hsl(var(--bg-100,0 0% 8%)); }
</style><div class="backdrop" hidden><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="title">
<h2 id="title">Rewind after this reply?</h2><div class="preview"></div>
<p>The selected assistant message stays. Later conversation is removed from this session. Any running turn will stop.</p>
<p>Files stay unchanged. Your composer draft stays unchanged.</p>
<p class="error" role="alert" hidden></p><div class="actions"><button class="cancel" type="button">Cancel</button>
<button class="confirm" type="button">Rewind here</button></div></section></div>`;
document.documentElement.append(host);
const backdrop = root.querySelector('.backdrop');
const title = root.querySelector('h2');
const preview = root.querySelector('.preview');
const error = root.querySelector('.error');
const confirm = root.querySelector('.confirm');
const cancel = root.querySelector('.cancel');
let returnFocus = null;

function close() {
    if (working) return;
    epoch++;
    pending = null;
    dialogSession = null;
    backdrop.hidden = true;
    returnFocus?.focus();
    returnFocus = null;
}

function failure(message) {
    error.textContent = message;
    error.hidden = false;
}

async function prepare(button, row) {
    if (working || !backdrop.hidden) return;
    const sessionId = cuimod.desktopSessionId;
    if (!sessionId) return;
    const token = ++epoch;
    dialogSession = sessionId;
    returnFocus = button;
    backdrop.hidden = false;
    title.textContent = 'Loading rewind point…';
    preview.textContent = '';
    error.hidden = true;
    confirm.disabled = true;
    cancel.disabled = false;
    cancel.textContent = 'Cancel';
    cancel.focus();
    try {
        const target = await cuimod.rpc('assistant-rewind.prepare', {
            sessionId, index: Number(row.getAttribute('data-index')),
            entryKey: row.querySelector('[data-epitaxy-entry]')?.getAttribute('data-epitaxy-entry'),
            itemIndex: row.querySelector('[data-epitaxy-entry]')?.getAttribute('data-epitaxy-item-index'),
            textItemId: button.parentElement?.getAttribute('data-cuimod-rewind-text') || undefined,
        });
        if (disposed || token !== epoch || cuimod.desktopSessionId !== sessionId) return;
        pending = target;
        preview.textContent = target.preview;
        title.textContent = 'Rewind after this reply?';
        confirm.disabled = false;
    } catch (e) {
        if (disposed || token !== epoch) return;
        title.textContent = 'Rewind unavailable';
        failure(e.message || String(e));
    }
}

ctx.track(root, 'click', async event => {
    if (event.target === cancel || event.target === backdrop) { close(); return; }
    if (event.target !== confirm || !pending || working) return;
    if (cuimod.desktopSessionId !== pending.sessionId) { close(); return; }
    working = true;
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.textContent = 'Rewinding…';
    try {
        const result = await cuimod.rpc('assistant-rewind.rewind', pending);
        if (disposed) return;
        if (!result?.ok) {
            title.textContent = result?.applied ? 'History rewound' : 'Rewind failed';
            failure(result?.error || 'Desktop refused this checkpoint.');
            pending = null;
            cancel.textContent = 'Close';
        } else {
            working = false;
            close();
        }
    } catch (e) {
        if (!disposed) {
            title.textContent = 'Rewind failed';
            failure(e.message || String(e));
            pending = null;
            cancel.textContent = 'Close';
        }
    } finally {
        working = false;
        if (!disposed) {
            cancel.disabled = false;
            confirm.textContent = 'Rewind here';
            if (!backdrop.hidden) cancel.focus();
        }
    }
});
ctx.track(root, 'keydown', event => {
    if (backdrop.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
        const choices = [cancel, confirm].filter(button => !button.disabled);
        if (!choices.length) { event.preventDefault(); return; }
        const index = choices.indexOf(root.activeElement);
        const next = (index + (event.shiftKey ? -1 : 1) + choices.length) % choices.length;
        event.preventDefault();
        choices[next].focus();
    }
});
ctx.track(document, 'click', event => {
    const button = event.target.closest?.('.' + CLASS);
    if (!button || !buttons.has(button)) return;
    const row = button.closest('[data-testid="transcript-row"]');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    prepare(button, row);
}, true);

function syncControls() {
    for (const button of buttons) {
        const kind = button.closest('[data-testid="transcript-row"]')?.getAttribute('data-perf-row');
        const itemTarget = (kind === 'assistant' || kind === 'assistant_thinking')
            && button.parentElement?.hasAttribute('data-cuimod-rewind-text');
        if (!button.isConnected || (kind !== 'assistant_text' && !itemTarget)) {
            button.remove();
            buttons.delete(button);
        }
    }
    const anchors = [...document.querySelectorAll('[data-testid="transcript-row"][data-perf-row="assistant_text"]')]
        .map(row => row.querySelector('[data-epitaxy-entry]'));
    // A completed/grouped turn contains several status updates. Each native
    // text or thinking item gets its own control; the entry UUID can represent
    // the whole turn instead of the individual persisted checkpoint.
    anchors.push(...[...document.querySelectorAll('[data-cuimod-rewind-text]')]
        .filter(node => ['assistant', 'assistant_thinking'].includes(
            node.closest('[data-testid="transcript-row"]')?.getAttribute('data-perf-row'))));
    for (const anchor of anchors) {
        if (!anchor || anchor.querySelector('.' + CLASS)) continue;
        const button = document.createElement('button');
        button.className = CLASS;
        button.type = 'button';
        button.title = 'Rewind after this assistant message';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3 1.8 6 5 9M2 6h7a4 4 0 0 1 0 8H6"/></svg>';
        anchor.append(button);
        buttons.add(button);
    }
}
let discovering = false;
let discoveryError = null;
function sync() {
    if (disposed) return;
    if (dialogSession && dialogSession !== cuimod.desktopSessionId && !working) close();
    if (!/^local_/.test(cuimod.desktopSessionId || '')) return;
    syncControls();
    if (discovering || !document.querySelector('[data-testid="transcript-row"][data-perf-row^="assistant"]')) return;
    discovering = true;
    const sessionId = cuimod.desktopSessionId;
    cuimod.rpc('assistant-rewind.discover', { sessionId }).then(() => {
        discoveryError = null;
        if (!disposed && cuimod.desktopSessionId === sessionId) syncControls();
    }).catch(error => {
        if (!disposed && discoveryError !== error.message) cuimod.log?.('assistant-rewind discovery: ' + error.message);
        discoveryError = error.message;
    }).finally(() => { discovering = false; });
}
ctx.every(750, sync);
ctx.onDispose(() => {
    disposed = true;
    epoch++;
    for (const button of buttons) button.remove();
    buttons.clear();
    for (const node of document.querySelectorAll('[data-cuimod-rewind-text]')) node.removeAttribute('data-cuimod-rewind-text');
    sheet.remove();
    host.remove();
});
sync();
