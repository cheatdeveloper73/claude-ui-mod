/* claude-ui-mod :: thinking-default (renderer)
 *
 * No UI of its own. Its job is to ask the main half to check this window, since
 * only the main process can reach the page-world store that holds transcript
 * mode, and to hand it the mode the dashboard currently has selected.
 *
 * The trigger has to be a poll: transcript mode is keyed by the *desktop*
 * session id and changes on tile switches and pane opens that never move
 * cuimod.sessionId, and the app navigates by pushState, which fires no event.
 * The call is a single small eval and a no-op once every visible session has
 * been handled.
 */
'use strict';

let settings = { enabled: true, target: 'thinking', interval: 1500 };
let inFlight = false;
let timer = null;

async function tick() {
    if (inFlight || !settings.enabled) return;
    inFlight = true;
    try { await cuimod.rpc('thinking-default.apply', { target: settings.target }); }
    catch (_) { /* host reloading; the next tick retries */ }
    finally { inFlight = false; }
}

function retime() {
    clearInterval(timer);
    timer = setInterval(tick, Math.max(300, settings.interval));
}
ctx.onDispose(() => clearInterval(timer));

cuimod.onSessionChange(tick);
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) tick(); });

const spec = {
    plugin: 'thinking-default',
    title: 'Default transcript view',
    description: 'Forces a transcript view the first time a session appears in a window.',
    defaults: { enabled: true, target: 'thinking', interval: 1500 },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled',
          hint: 'Off leaves every session on whatever the app restores.', group: 'Behaviour' },
        { key: 'target', type: 'combo', label: 'View', group: 'Behaviour',
          hint: 'Applied once per session, so switching by hand still sticks.',
          options: [
              { value: 'thinking', label: 'Thinking' },
              { value: 'normal', label: 'Normal' },
              { value: 'verbose', label: 'Verbose' },
              { value: 'summary', label: 'Summary' },
          ] },
        { key: 'interval', type: 'slider', label: 'Check interval', min: 400, max: 5000, step: 100, unit: 'ms',
          hint: 'How long a new session can show the old view before it flips.', group: 'Behaviour' },
    ],
    apply(v) {
        const modeChanged = v.target !== settings.target;
        settings = v;
        retime();
        // A mode change should land now, not on the next session.
        if (modeChanged || v.enabled) tick();
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});

retime();
tick();
