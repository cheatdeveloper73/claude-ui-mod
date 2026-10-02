/* claude-ui-mod :: voice-agent (renderer)
 *
 * The app's dictation button starts a cloud relay on pointer-down. This plugin
 * wins that event in capture phase and hands the same control to the local
 * companion. Audio never enters the renderer or claude.ai: the companion owns
 * WASAPI capture, durable spooling and the SSH-bound compute service.
 */
'use strict';

const DEF = {
    enabled: true,
    wakeEnabled: true,
    wakeAction: 'send',
    continuousJournal: false,
    emotionEnabled: true,
    cueEnabled: true,
    ttsEnabled: true,
    ttsVoice: 'af_heart',
    ttsSpeed: 1,
    retentionDays: 30,
    wakePhrase: 'hey agent',
    stopPhrase: 'green apple',
    companionPort: 18764,
    accent: '#c96442',
};

let V = Object.assign({}, DEF);
let status = null;
let recording = false;
let busy = false;
let flash = '';
let flashUntil = 0;
let lastActivation = 0;

const DESKTOP = /local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RECORD_LABEL = 'Press and hold to record';
const SETTINGS_LABEL = 'Dictation settings';
const ATTR = 'data-cuimod-voice';
const LAYOUT_EVENT = 'cuimod:voice-layout';
// Renderer hot reload replaces this module while the isolated document survives.
// The delivery token therefore follows the effective page route, not the module.
const ROUTE_SHARED = Symbol.for('claude-ui-mod.voice-agent.renderer-route');
const route = globalThis[ROUTE_SHARED] || (globalThis[ROUTE_SHARED] = {
    key: '',
    desktop: null,
    freshViewId: null,
});

function desktopSessionId() {
    const match = DESKTOP.exec(location.pathname + location.search);
    return match ? match[0].toLowerCase() : null;
}

function newViewId() {
    return 'fresh-' + (typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
}

function setRoute(desktop) {
    const key = location.pathname;
    const priorKey = route.key;
    const priorDesktop = route.desktop;
    const changed = key !== priorKey || desktop !== priorDesktop;
    if (desktop) {
        route.freshViewId = null;
    } else if (!route.freshViewId || priorDesktop || (priorKey && key !== priorKey)) {
        route.freshViewId = newViewId();
    }
    route.key = key;
    route.desktop = desktop;
    return { desktop, changed };
}

function syncRoute() {
    return setRoute(desktopSessionId());
}

function focusedTarget(value) {
    const match = typeof value === 'string' ? DESKTOP.exec(value) : null;
    const desktop = match ? match[0].toLowerCase() : null;
    setRoute(desktop);
    return { desktopSessionId: desktop, cliSessionId: desktop ? cuimod.sessionId : null,
        viewId: desktop ? null : route.freshViewId, fresh: !desktop, focused: true };
}

function target(focused = document.hasFocus()) {
    const { desktop } = syncRoute();
    return {
        desktopSessionId: desktop,
        cliSessionId: desktop ? cuimod.sessionId : null,
        viewId: desktop ? null : route.freshViewId,
        fresh: !desktop,
        focused,
    };
}

function bind(value = target()) {
    cuimod.rpc('voice-agent.bind', value).catch(() => {});
}

ctx.onDispose(cuimod.observeInvoke((channel, args) => {
    if (typeof channel !== 'string' || !channel.includes('_$_setFocusedSession')) return;
    bind(focusedTarget(args?.[0]));
}));

function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
}

function buttonFor(node) {
    const button = node?.closest?.('button[aria-label]');
    if (!button) return null;
    const label = button.getAttribute('aria-label');
    return label === RECORD_LABEL || label === SETTINGS_LABEL ? button : null;
}

async function control(action) {
    if (busy) return;
    const value = target();
    busy = true;
    paint();
    try {
        await cuimod.rpc('voice-agent.control', { ...value, action });
        if (action === 'start') recording = true;
        if (action === 'stop' || action === 'cancel') recording = false;
        show(action === 'start' ? 'Listening'
            : action === 'cancel' ? 'Stopped' : 'Finishing', 1200);
    } catch (error) {
        show(String(error?.message || error), 5000);
    } finally {
        busy = false;
        paint();
    }
}

function activate(event) {
    if (V.enabled === false) return;
    const button = buttonFor(event.target);
    if (!button) return;
    swallow(event);
    const label = button.getAttribute('aria-label');
    if (label === SETTINGS_LABEL) {
        if (event.type === 'click' || event.type === 'keydown') show('Voice Agent settings are in the Insert panel', 3500);
        return;
    }

    let trigger = event.type === 'pointerdown';
    if (event.type === 'mousedown' && typeof PointerEvent === 'undefined') trigger = true;
    if (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ')) trigger = true;
    if (!trigger) return;
    const now = Date.now();
    if (now - lastActivation < 350) return;
    lastActivation = now;
    control(recording ? 'stop' : 'start');
}

for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'keydown', 'keyup'])
    ctx.track(window, type, activate, true);
ctx.track(window, 'keydown', (event) => {
    if (V.enabled !== false && recording && event.key === 'Escape') {
        swallow(event);
        control('cancel');
    }
}, true);
ctx.track(window, 'focus', bind);
ctx.track(document, 'visibilitychange', bind);
cuimod.onSessionChange(bind);

const pageStyle = document.createElement('style');
pageStyle.id = 'cuimod-voice-agent-page';
(document.head || document.documentElement).appendChild(pageStyle);
ctx.onDispose(() => { try { pageStyle.remove(); } catch (_) {} });
ctx.onDispose(() => { try { document.documentElement.removeAttribute(ATTR); } catch (_) {} });

function pageRules() {
    return `
html[${ATTR}="recording"] button[aria-label="${RECORD_LABEL}"],
html[${ATTR}="busy"] button[aria-label="${RECORD_LABEL}"] {
    color: ${V.accent};
}
html[${ATTR}="recording"] button[aria-label="${RECORD_LABEL}"] {
    background: color-mix(in srgb, ${V.accent} 12%, transparent);
    animation: cuimodVoicePulse 1.35s ease-in-out infinite;
}
html[${ATTR}="busy"] button[aria-label="${RECORD_LABEL}"] { opacity: .68; }
@keyframes cuimodVoicePulse {
    0%, 100% { opacity: .72; }
    50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
    html[${ATTR}="recording"] button[aria-label="${RECORD_LABEL}"] { animation: none; }
}
`;
}

const host = document.createElement('div');
host.id = 'cuimod-voice-agent';
host.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;left:-9999px;top:-9999px';
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>
:host { all: initial; --voice-accent: #c96442; }
.pill {
    box-sizing: border-box; max-width: 100%; height: 20px; padding: 0 5px;
    display: flex; align-items: center; gap: 6px;
    border-radius: 5px; border: 0;
    background: transparent;
    color: hsl(var(--text-400, 48 6% 56%));
    font: 500 10px/1 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    letter-spacing: .005em; white-space: nowrap;
    /* Voice state updates while hidden; a transition can freeze the pill invisible. */
    opacity: 0; transition: none;
}
.pill.on { opacity: 1; }
.orb { width: 5px; height: 5px; flex: 0 0 5px; border-radius: 50%; background: #67b88a; }
.meter { height: 11px; display: flex; align-items: center; gap: 1px; color: hsl(var(--text-300, 48 8% 73%)); }
.meter i { display: block; width: 1.5px; height: var(--h); border-radius: 1px; background: currentColor; opacity: .14; transform: scaleY(.4); transition: opacity 80ms linear, transform 80ms linear; }
.meter i.lit { opacity: .8; transform: scaleY(1); }
.pill.recording, .pill.active, .pill.busy {
    color: var(--voice-accent); background: color-mix(in srgb, var(--voice-accent) 8%, transparent);
}
.pill.recording .orb, .pill.active .orb { background: var(--voice-accent); animation: cuimodVoiceOrb 1.1s ease-in-out infinite; }
.pill.warning { color: #d49a55; background: color-mix(in srgb, #d49a55 8%, transparent); }
.pill.error { color: hsl(var(--danger-100, 0 76% 70%)); background: color-mix(in srgb, hsl(var(--danger-100, 0 76% 70%)) 8%, transparent); }
.pill.error .orb, .pill.warning .orb { background: currentColor; }
@keyframes cuimodVoiceOrb { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pill { transition-duration: 1ms; } .pill .orb { animation: none; } }
</style><div class="pill"><span class="orb"></span><span class="meter" aria-hidden="true">
${[3, 5, 8, 10, 8, 6, 4, 3].map(height => `<i style="--h:${height}px"></i>`).join('')}
</span></div>`;
const pill = shadow.querySelector('.pill');
const meterBars = [...shadow.querySelectorAll('.meter i')];
let lastLayoutKey = '';
function notifyLayout() {
    const key = [host.style.left, host.style.top, host.style.maxWidth,
        pill.classList.contains('on') ? 'on' : 'off'].join('|');
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    try { window.dispatchEvent(new Event(LAYOUT_EVENT)); } catch (_) {}
}
(document.body || document.documentElement).appendChild(host);
ctx.onDispose(() => { try { host.remove(); } catch (_) {} });

const fallbackHost = document.createElement('div');
fallbackHost.id = 'cuimod-voice-fallback';
fallbackHost.style.cssText = 'position:fixed;inset:0;z-index:2147483600;pointer-events:none';
const fallbackShadow = fallbackHost.attachShadow({ mode: 'open' });
fallbackShadow.innerHTML = `<style>
:host { all: initial; }
.toast {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483600;
    box-sizing: border-box; width: min(380px, calc(100vw - 40px));
    padding: 11px 14px; border-radius: 11px;
    color: hsl(var(--text-100, 60 14% 97%));
    background: hsl(var(--bg-200, 0 0% 6.7%));
    border: 1px solid color-mix(in srgb, #d49a55 48%, transparent);
    box-shadow: 0 3px 8px rgba(0,0,0,.18), 0 16px 44px rgba(0,0,0,.28);
    font: 12px/1.45 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    opacity: 0; transform: translateY(8px); pointer-events: none;
    transition: opacity .16s ease, transform .16s ease;
}
.toast.show { opacity: 1; transform: none; pointer-events: auto; }
.title { display: block; color: #e5ad68; font-weight: 650; margin-bottom: 3px; }
.detail { color: hsl(var(--text-300, 48 8% 73%)); }
.toast.failed .title { color: hsl(var(--danger-100, 0 76% 70%)); }
@media (prefers-reduced-motion: reduce) { .toast { transition-duration: 1ms; } }
</style><div class="toast" role="alert" aria-live="assertive"><span class="title"></span><span class="detail"></span></div>`;
const fallbackToast = fallbackShadow.querySelector('.toast');
const fallbackTitle = fallbackShadow.querySelector('.title');
const fallbackDetail = fallbackShadow.querySelector('.detail');
let fallbackTimer = null;
let lastFallbackId = null;
function showFallback(value) {
    const copied = value?.copied === true;
    fallbackTitle.textContent = copied ? 'Voice prompt copied to clipboard' : 'Voice prompt delivery failed';
    fallbackDetail.textContent = copied
        ? 'The original chat target disappeared before send. Paste the prompt into the chat you want.'
        : 'Clipboard copy also failed. The recording and transcript remain in the local archive.';
    fallbackToast.className = 'toast show' + (copied ? '' : ' failed');
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => fallbackToast.classList.remove('show'), 10000);
}
ctx.track(fallbackToast, 'click', () => {
    clearTimeout(fallbackTimer);
    fallbackToast.classList.remove('show');
});
(document.body || document.documentElement).appendChild(fallbackHost);
ctx.onDispose(() => {
    clearTimeout(fallbackTimer);
    try { fallbackHost.remove(); } catch (_) {}
});

const statusNode = document.createElement('div');
statusNode.style.cssText = 'font:12px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;color:hsl(var(--text-300,48 8% 73%));white-space:pre-wrap';

function show(text, duration) {
    flash = String(text || '');
    flashUntil = Date.now() + duration;
    paint();
}

function stateText() {
    if (Date.now() < flashUntil && flash) return { text: flash, kind: recording ? 'recording' : '' };
    if (status?.error) return { text: 'Voice offline', kind: 'error' };
    if (status?.dispatchError) return { text: 'Delivery waiting', kind: 'error' };
    const fallbackAge = Date.now() - Date.parse(status?.fallback?.at || '');
    if (Number.isFinite(fallbackAge) && fallbackAge < 15000) return status.fallback.copied
        ? { text: 'Prompt copied to clipboard', kind: 'warning' }
        : { text: 'Clipboard fallback failed', kind: 'error' };
    if (status?.uncertain?.length) return { text: 'Delivery needs review', kind: 'error' };
    const service = status?.service;
    const capture = service?.capture;
    const telemetry = capture?.telemetry;
    const transcriber = service?.transcriber;
    if (telemetry?.processorFaulted || telemetry?.processorAlive === false)
        return { text: 'Audio processor recovering', kind: 'error' };
    if (!capture?.ready) return { text: 'Waiting for microphone', kind: 'error' };
    if (Number(telemetry?.inputAgeMs) > 1200 || Number(telemetry?.processedAgeMs) > 1200)
        return { text: 'Audio stalled', kind: 'error' };
    if (telemetry?.warningAgeMs != null && Number(telemetry.warningAgeMs) < 5000)
        return { text: 'Capture warning', kind: 'warning' };
    if (Number(telemetry?.backlogBlocks) >= 8)
        return { text: 'Catching up', kind: 'warning' };
    if (status?.dispatching) return { text: status.dispatching.phase === 'delivering'
        ? 'Sending' : 'Checking target', kind: 'busy' };
    if (telemetry?.speechActive) {
        const seconds = Math.max(0, Number(telemetry.activeMs) || 0) / 1000;
        return { text: 'Listening · ' + seconds.toFixed(1) + 's', kind: 'active' };
    }
    if (transcriber?.inFlight || Number(transcriber?.queuedJobs) > 0)
        return { text: 'Transcribing' + (transcriber.queuedJobs
            ? ' · ' + transcriber.queuedJobs + ' queued' : ''), kind: 'busy' };
    if (Number(transcriber?.pendingJobs) > 0)
        return { text: 'Saving captured audio', kind: 'warning' };
    if (Number(transcriber?.wakeRetryJobs) > 0)
        return { text: 'Retrying saved audio', kind: 'warning' };
    if (transcriber?.commandPending) return { text: transcriber.graceRemainingMs != null
        ? 'Holding for more' : 'Command held', kind: 'busy' };
    if (recording) return { text: busy ? 'Finishing' : 'Listening', kind: 'recording' };
    if (capture?.state?.armed) return { text: 'Waiting for command', kind: 'recording' };
    const emotion = transcriber?.lastEmotion;
    if (emotion?.reliable === true && Number(transcriber?.lastEmotionAgeMs) < 5000)
        return { text: emotion.label + ' · ' + Math.round(Number(emotion.confidence) * 100) + '% tone', kind: '' };
    if (!service?.compute) return { text: 'Compute reconnecting', kind: 'warning' };
    return { text: 'Voice ready', kind: '' };
}

function paint() {
    pageStyle.textContent = pageRules();
    host.style.setProperty('--voice-accent', String(V.accent || DEF.accent));
    const connected = status?.connected === true;
    const attr = V.enabled === false ? null : busy ? 'busy' : recording ? 'recording' : connected ? 'ready' : null;
    if (attr) document.documentElement.setAttribute(ATTR, attr);
    else document.documentElement.removeAttribute(ATTR);
    const view = V.enabled === false ? { text: '', kind: '' } : stateText();
    const telemetry = status?.service?.capture?.telemetry;
    const peak = Math.max(-60, Math.min(-8, Number(telemetry?.levelPeakDb) || -60));
    const lit = Math.ceil(((peak + 60) / 52) * meterBars.length);
    meterBars.forEach((bar, index) => bar.classList.toggle('lit', index < lit));
    pill.className = 'pill' + (view.text ? ' on' : '') + (view.kind ? ' ' + view.kind : '');

    const service = status?.service;
    const capture = service?.capture;
    const compute = service?.compute;
    const lines = [];
    if (V.enabled === false) lines.push('Desktop interception is disabled. The app’s native dictation button is untouched.');
    else if (status?.error) lines.push('Companion: offline — ' + status.error);
    else lines.push('Companion: connected');
    if (capture) {
        lines.push('Capture: ' + (capture.ready ? 'ready' : 'waiting for microphone') + ' · VAD ' + capture.vad);
        const telemetry = capture.telemetry;
        if (telemetry) {
            lines.push('Audio: ' + telemetry.inputBlocks + ' in · ' + telemetry.processedBlocks
                + ' processed · ' + telemetry.inputOverflows + ' input overflows · '
                + (Number(telemetry.droppedPcmBlocks) || 0) + ' queue drops · queue ' + telemetry.backlogBlocks);
            lines.push('Signal: ' + Number(telemetry.levelDb).toFixed(1) + ' dB · VAD '
                + Number(telemetry.vadProbability).toFixed(3) + (telemetry.speechActive
                    ? ' · speech ' + (Number(telemetry.activeMs) / 1000).toFixed(1) + 's' : ''));
            if (telemetry.lastWarning) lines.push('Last capture warning: ' + telemetry.lastWarning);
            if (telemetry.lastProcessorError) lines.push('Last processor recovery: ' + telemetry.lastProcessorError);
        }
    }
    const transcriber = service?.transcriber;
    if (transcriber) lines.push('Transcriber: ' + (transcriber.inFlight ? 'active' : 'idle')
        + ' · ' + transcriber.queuedJobs + ' queued · ' + transcriber.retryJobs + ' saved retries · '
        + (Number(transcriber.pendingJobs) || 0) + ' waiting to save');
    if (compute) {
        lines.push('Compute: ' + (compute.ok ? 'ready' : 'unavailable') + ' · ASR ' + (compute.asr?.model || 'unknown'));
        if (compute.emotion) lines.push('Emotion: ' + (compute.emotion.enabled
            ? compute.emotion.loaded ? 'ready' : 'loads on first speech' : 'disabled')
            + ' · ' + (compute.emotion.model || 'unknown'));
    }
    if (service?.transport?.configured) lines.push('SSH tunnel: ' + (service.transport.running ? 'running' : 'reconnecting'));
    if (service?.cues) lines.push('Cues: ' + (service.cues.enabled && service.cues.startReady
        && service.cues.acceptedReady ? 'ready' : service.cues.enabled ? 'audio files missing' : 'disabled'));
    if (status?.dispatchError) lines.push('Delivery: waiting — ' + status.dispatchError);
    if (status?.fallback) lines.push('Last delivery fallback: ' + (status.fallback.copied
        ? 'prompt copied to clipboard' : 'clipboard copy failed') + ' · event ' + status.fallback.id);
    if (status?.uncertain?.length) lines.push('At-most-once hold: ' + status.uncertain.length + ' delivery outcome(s) uncertain');
    statusNode.textContent = lines.join('\n');
}

function place() {
    const button = document.querySelector(`button[aria-label="${RECORD_LABEL}"]`);
    const settings = document.querySelector(`button[aria-label="${SETTINGS_LABEL}"]`);
    const prompt = document.querySelector('.epitaxy-prompt-input');
    const view = pill.classList.contains('on');
    if (!button || !settings || !prompt || !view) {
        host.style.left = '-9999px';
        notifyLayout();
        return;
    }
    const promptRect = prompt.getBoundingClientRect();
    let row = button.parentElement;
    while (row) {
        const rect = row.getBoundingClientRect();
        if (rect.width >= promptRect.width && rect.height <= 40) break;
        row = row.parentElement;
    }
    const rowRect = row?.getBoundingClientRect();
    const settingsRect = settings.getBoundingClientRect();
    const children = row ? [...row.children].map(node => ({ node, rect: node.getBoundingClientRect() })) : [];
    const right = children.filter(entry => entry.rect.width > 0 && entry.rect.left > settingsRect.right + 20)
        .sort((a, b) => a.rect.left - b.rect.left)[0] || null;
    let leftEdge = rowRect?.left || settingsRect.right;
    for (const entry of children) {
        if (entry === right) break;
        if (entry.rect.width > 0) leftEdge = Math.max(leftEdge, entry.rect.right);
    }
    const left = leftEdge + 8;
    const rightEdge = right?.rect.left || promptRect.right;
    const available = rightEdge - left - 8;
    if (rowRect && available >= 120) {
        host.style.maxWidth = available + 'px';
        host.style.left = left + 'px';
        host.style.top = rowRect.top + Math.max(0, (rowRect.height - pill.getBoundingClientRect().height) / 2) + 'px';
        notifyLayout();
        return;
    }
    host.style.maxWidth = Math.min(260, promptRect.width) + 'px';
    const width = pill.getBoundingClientRect().width;
    host.style.left = Math.max(8, promptRect.right - width) + 'px';
    host.style.top = Math.max(8, promptRect.top - pill.getBoundingClientRect().height - 6) + 'px';
    notifyLayout();
}

async function refreshStatus() {
    try {
        status = await cuimod.rpc('voice-agent.status', {});
        recording = status?.service?.capture?.state?.mode === 'dictation';
        const fallback = status?.fallback;
        if (Number.isInteger(fallback?.id) && fallback.id !== lastFallbackId) {
            lastFallbackId = fallback.id;
            const age = Date.now() - Date.parse(fallback.at || '');
            if (Number.isFinite(age) && age < 60000) showFallback(fallback);
        }
    } catch (error) {
        status = { connected: false, error: String(error?.message || error) };
    }
    paint();
    place();
}

ctx.every(250, refreshStatus);
ctx.every(250, place);
ctx.every(100, () => { if (syncRoute().changed) bind(); });
ctx.every(1000, bind);
bind();
refreshStatus();

const SPEC = {
    plugin: 'voice-agent',
    title: 'Local Voice Agent',
    defaults: DEF,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Replace native dictation', group: 'Desktop',
            hint: 'Capture-phase interception prevents the app’s cloud speech relay from opening.' },
        { key: 'wakeEnabled', type: 'toggle', label: 'Listen for wake phrase', group: 'Wake' },
        { key: 'wakePhrase', type: 'text', label: 'Wake phrase', group: 'Wake' },
        { key: 'stopPhrase', type: 'text', label: 'Spoken stop phrase', group: 'Wake',
            hint: 'Ends manual dictation immediately. In wake mode it activates after the wake phrase is recognized or armed.' },
        { key: 'wakeAction', type: 'combo', label: 'After a voice command', group: 'Wake', options: [
            { value: 'send', label: 'Send to active chat' },
            { value: 'draft', label: 'Draft in composer' },
        ] },
        { key: 'continuousJournal', type: 'toggle', label: 'Continuous audio journal', group: 'Archive',
            hint: 'Includes silence in durable rolling WAV chunks. Spoken utterances are retained either way.' },
        { key: 'retentionDays', type: 'number', label: 'Audio retention (days)', min: 0, max: 3650, group: 'Archive',
            hint: 'Zero keeps audio until you remove it.' },
        { key: 'emotionEnabled', type: 'toggle', label: 'Acoustic delivery context', group: 'Recognition',
            hint: 'Local models add detailed speaker-relative prosody and gated coarse emotion metadata.' },
        { key: 'cueEnabled', type: 'toggle', label: 'Start and accepted sounds', group: 'Speech',
            hint: 'Licensed local cues play on this workstation and never leave it.' },
        { key: 'ttsEnabled', type: 'toggle', label: 'Local spoken summaries', group: 'Speech' },
        { key: 'ttsVoice', type: 'text', label: 'Kokoro voice', group: 'Speech' },
        { key: 'ttsSpeed', type: 'slider', label: 'Speech speed', min: 0.6, max: 1.6, step: 0.05, decimals: 2, group: 'Speech' },
        { key: 'companionPort', type: 'number', label: 'Companion port', min: 1024, max: 65535, group: 'Connection' },
        { key: 'status', type: 'custom', label: 'Live status', wide: true, group: 'Connection', node: () => statusNode },
    ],
    apply(values) {
        V = Object.assign({}, DEF, values || {});
        paint();
        cuimod.rpc('voice-agent.configure', V).then(refreshStatus).catch((error) => {
            status = { connected: false, error: String(error?.message || error) };
            paint();
        });
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set('voice-agent', SPEC);
REG.subs.forEach((fn) => fn());
ctx.onDispose(() => {
    if (REG.specs.get('voice-agent') === SPEC) REG.specs.delete('voice-agent');
    REG.subs.forEach((fn) => fn());
});
