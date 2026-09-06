/* claude-ui-mod :: context-pill (renderer)
 *
 * A pill that appears once the session is carrying 300k tokens or more, and
 * does not exist before that. The usage-bar meter is always on and easy to stop
 * seeing; this is the opposite — it only draws in the range where context
 * hygiene actually matters, so its appearance IS the signal.
 *
 * The number is the CLI's, not a guess: LocalSessions.getContextUsage(sessionId)
 * forwards to the CLI as `get_context_usage` and replies with totalTokens /
 * rawMaxTokens / autoCompactThreshold for the session's currently selected
 * model. That is the same call the app's own composer ring makes and the same
 * one usage-bar makes — see that plugin's header for the full reply shape. Two
 * callers, one source, so the pill and the meter cannot disagree.
 *
 * The channel takes the DESKTOP session id (local_<uuid>, the one in the URL),
 * not the cliSessionId the task store uses.
 *
 * Position is viewport-fixed rather than anchored to a composer node. usage-bar
 * has to measure the footer every frame because it must fit an exact gap
 * between two React-owned clusters; a pill has no such constraint, and a fixed
 * corner cannot be broken by a re-render or by the sidebar opening.
 *
 * Dismiss is a snooze, not an off switch: hiding it parks the current token
 * count, and it returns once context has grown by `snoozeStep` past that or has
 * crossed into the critical tier. A dismissal that lasted forever would destroy
 * the one property the pill has — that not seeing it means something.
 */
'use strict';

const HOST_ID = 'cuimod-context-pill';

let cfg = null;
let usage = null;
let host = null, shadow = null, wrap = null, pill = null, sheet = null;
let timer = null;
let snoozedAt = null;   // totalTokens when dismissed; null when not snoozed
let shownTier = null;   // tier the pill is currently painted as

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function short(n) {
    if (!isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

// ------------------------------------------------------------------ styling
// Shared by the live pill and the preview stage, so a slider moves both.
function pillCss(p, v) {
    return `
${p}.pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: ${v.padY}px ${v.padY + 4}px ${v.padY}px ${v.padY + 2}px;
    border-radius: 999px;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: ${v.size}px; line-height: 1;
    white-space: nowrap; user-select: none;
    color: hsl(var(--text-200, 51 8% 84%));
    background: color-mix(in srgb, var(--c) ${Math.round(13 * v.weight)}%,
                          hsl(var(--bg-200, 60 3% 11%)));
    border: 1px solid color-mix(in srgb, var(--c) ${Math.round(42 * v.weight)}%, transparent);
    box-shadow: 0 2px 10px rgba(0,0,0,.28)${v.glow
        ? `, 0 0 ${(10 * v.weight).toFixed(1)}px color-mix(in srgb, var(--c) ${Math.round(26 * v.weight)}%, transparent)`
        : ''};
    transition: background 500ms ease, border-color 500ms ease, box-shadow 500ms ease;
}
${p}.pill .dot {
    width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
    background: var(--c);
    box-shadow: 0 0 6px color-mix(in srgb, var(--c) 60%, transparent);
    transition: background 500ms ease;
}
/* Only the critical tier animates. A pill that pulses from the moment it
 * appears has nothing left to escalate with. */
${p}.pill.critical .dot { animation: cp-pulse 1.6s ease-in-out infinite; }
@keyframes cp-pulse { 0%, 100% { opacity: 1; transform: scale(1); }
                      50% { opacity: .45; transform: scale(.82); } }

${p}.pill .num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--c); }
${p}.pill .of {
    color: hsl(var(--text-500, 48 5% 57%)); font-variant-numeric: tabular-nums;
    font-size: ${(v.size - 1).toFixed(1)}px;
}
${p}.pill .hint {
    color: hsl(var(--text-400, 48 5% 57%));
    font-size: ${(v.size - 1).toFixed(1)}px;
}
${p}.pill .of:empty, ${p}.pill .hint:empty { display: none; }
${p}.pill .x {
    margin-left: 2px; padding: 0 3px; border-radius: 6px;
    color: hsl(var(--text-500, 48 5% 57%));
    font-size: ${(v.size + 2).toFixed(1)}px; line-height: 1;
    cursor: pointer; background: none; border: 0; font-family: inherit;
    transition: color 160ms ease, background 160ms ease;
}
${p}.pill .x:hover {
    color: hsl(var(--text-100, 60 14% 97%));
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 12%, transparent);
}
`;
}

const HOST_CSS = (v) => `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
    position: fixed; z-index: 50;
    display: flex; pointer-events: none;
    opacity: 0;
    transition: opacity 260ms cubic-bezier(.2,.85,.3,1),
                transform 260ms cubic-bezier(.2,.85,.3,1);
}
.wrap.top { top: ${v.offset}px; left: 0; right: 0; justify-content: center;
            transform: translateY(-8px); }
.wrap.tr  { top: ${v.offset}px; right: ${v.offset}px; transform: translateY(-8px); }
.wrap.br  { bottom: ${v.offset}px; right: ${v.offset}px; transform: translateY(8px); }
.wrap.bl  { bottom: ${v.offset}px; left: ${v.offset}px; transform: translateY(8px); }
.wrap.show { opacity: 1; transform: none; }
.wrap.show .pill { pointer-events: auto; }
@media (prefers-reduced-motion: reduce) {
    .wrap { transition-duration: 1ms; }
    .pill .dot { animation: none !important; }
}
${pillCss('', v)}
`;

// ------------------------------------------------------------------ tiers
// Absolute token counts, not a fraction of the window. 300k is heavy on a 200k
// model and unremarkable on a 1M one, but what is being watched here is the
// size of what has to be re-read every turn, and that is absolute.
function tierOf(tokens, v) {
    if (tokens >= v.criticalAt) return 'critical';
    if (tokens >= v.warnAt) return 'warn';
    return null;
}

function title(u, v) {
    const NL = String.fromCharCode(10);
    const lines = [
        (u.model || 'session') + ' — ' + u.totalTokens.toLocaleString()
            + ' of ' + u.rawMaxTokens.toLocaleString() + ' tokens',
    ];
    lines.push(cuimod.contextCountInfo(u).description);
    if (u.isAutoCompactEnabled && u.autoCompactThreshold) {
        lines.push('auto-compacts at ' + u.autoCompactThreshold.toLocaleString());
    }
    lines.push('warn ' + short(v.warnAt) + ' · critical ' + short(v.criticalAt));
    lines.push('× snoozes until +' + short(v.snoozeStep));
    return lines.join(NL);
}

// ------------------------------------------------------------------ paint
function paint() {
    if (!pill || !cfg) return;
    const v = cfg;
    const u = usage;
    const have = !!(u && typeof u.totalTokens === 'number' && u.rawMaxTokens);
    const tokens = have ? u.totalTokens : 0;
    const tier = have && v.enabled ? tierOf(tokens, v) : null;

    // A snooze parked at 310k must not survive the jump into critical, and it
    // has to clear once context falls back under the warn line — after a
    // compaction, the next crossing is new information again.
    if (snoozedAt != null) {
        const grew = tokens >= snoozedAt + v.snoozeStep;
        const escalated = tier === 'critical' && shownTier !== 'critical';
        if (tier === null || grew || escalated) snoozedAt = null;
    }

    if (!tier || snoozedAt != null) {
        wrap.classList.remove('show');
        if (!tier) shownTier = null;
        return;
    }

    shownTier = tier;
    pill.className = 'pill ' + tier;
    pill.style.setProperty('--c', tier === 'critical' ? v.criticalColor : v.warnColor);
    pill.querySelector('.num').textContent = (cuimod.contextCountInfo(u).exact ? '' : '~') + short(tokens);
    pill.querySelector('.of').textContent = v.showTotal
        ? '/ ' + short(u.rawMaxTokens) + '  ' + Math.round(clamp01(tokens / u.rawMaxTokens) * 100) + '%'
        : '';
    pill.querySelector('.hint').textContent = tier === 'critical' ? v.criticalText : v.warnText;
    pill.title = title(u, v);

    wrap.className = 'wrap ' + v.position + ' show';
}

// ------------------------------------------------------------------ data
const CTX_CHANNEL = cuimod.eipc('claude.web', 'LocalSessions', 'getContextUsage');

function desktopSessionId() {
    const m = (location.pathname + location.search)
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? 'local_' + m[0].toLowerCase() : null;
}

let pulling = false;
async function refresh() {
    if (pulling || !cfg) return;
    pulling = true;
    try {
        const id = cfg.enabled ? desktopSessionId() : null;
        usage = id ? await cuimod.appInvoke(CTX_CHANNEL, id) : null;
    } catch (_) {
        usage = null;   // window between reloads; the next tick retries
    }
    // Guarded: a throw in paint() would strand `pulling` true and silently end
    // every later refresh.
    try { paint(); } finally { pulling = false; }
}

function retime() {
    clearInterval(timer);
    timer = setInterval(refresh, Math.max(1000, cfg.interval));
}
ctx.onDispose(() => clearInterval(timer));

// A different session is a different budget, so its snooze is not ours.
cuimod.onSessionChange(() => {
    snoozedAt = null; shownTier = null; usage = null;
    paint(); refresh();
});
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) refresh(); });

// ------------------------------------------------------------------ build
function buildPill(root) {
    const p = el('div', 'pill warn');
    p.append(el('span', 'dot'), el('span', 'num', '—'), el('span', 'of', ''), el('span', 'hint', ''));
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Snooze');
    p.append(x);
    root.append(p);
    return p;
}

function apply(v) {
    cfg = v;

    // A generation that failed to dispose leaves a dead host in the page: its JS
    // is gone, so it freezes at a stale token count that never updates and never
    // hides, which reads as the pill being stuck rather than as a leak.
    /* A detached host is no host. The dedupe below removes every #cuimod-context-pill that is
     * not ours — and during a hot reload the generation running it can be the
     * stale one, because the dashboard holds every apply() until dashboard.load
     * resolves. It then orphans the live host and leaves `host` pointing at the
     * node it just removed, so `if (!host)` is false forever and this never
     * mounts again. Silent, too: applySpec swallows throws and there is no
     * throw. The goal band vanished exactly this way. */
    if (host && !host.isConnected) { host = null; shadow = null; sheet = null; wrap = null; pill = null; }

    for (const e of document.querySelectorAll('#' + HOST_ID)) { if (e !== host) e.remove(); }

    if (!host) {
        host = el('div');
        host.id = HOST_ID;
        shadow = host.attachShadow({ mode: 'open' });
        sheet = new CSSStyleSheet();
        shadow.adoptedStyleSheets = [sheet];
        wrap = el('div', 'wrap');
        shadow.append(wrap);
        pill = buildPill(wrap);
        pill.querySelector('.x').addEventListener('click', (ev) => {
            ev.stopPropagation();
            snoozedAt = usage && usage.totalTokens ? usage.totalTokens : 0;
            wrap.classList.remove('show');
        });
        document.documentElement.appendChild(host);
        ctx.onDispose(() => { try { host.remove(); } catch (_) {} host = null; });
    }

    sheet.replaceSync(HOST_CSS(v));
    retime();
    paint();
    refresh();
}

// ------------------------------------------------------------------ panel
const spec = {
    plugin: 'context-pill',
    title: 'Context warning',
    description: 'A pill that appears once the session is carrying a lot of context, and nothing before that.',
    defaults: {
        enabled: true,
        warnAt: 300000,
        criticalAt: 500000,
        snoozeStep: 50000,
        warnText: 'context is getting heavy',
        criticalText: 'wrap up or /compact',
        showTotal: true,
        position: 'top',
        offset: 56,
        size: 11.5,
        padY: 6,
        weight: 1,
        glow: true,
        warnColor: '#f3cb8a',
        criticalColor: '#f5949a',
        interval: 6000,
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled', group: 'Thresholds' },
        { key: 'warnAt', type: 'slider', label: 'Warn at', min: 50000, max: 900000, step: 10000,
          unit: ' tok', hint: 'Absolute tokens in context, not a share of the window.',
          group: 'Thresholds' },
        { key: 'criticalAt', type: 'slider', label: 'Critical at', min: 100000, max: 950000, step: 10000,
          unit: ' tok', hint: 'Past this the pill warms and the dot pulses.', group: 'Thresholds' },
        { key: 'snoozeStep', type: 'slider', label: 'Snooze until +', min: 10000, max: 200000, step: 5000,
          unit: ' tok', hint: 'How much more context has to arrive before a dismissed pill returns.',
          group: 'Thresholds' },
        { key: 'interval', type: 'slider', label: 'Check every', min: 1000, max: 30000, step: 500,
          unit: 'ms', group: 'Thresholds' },

        { key: 'warnText', type: 'text', label: 'Warn message', group: 'Wording' },
        { key: 'criticalText', type: 'text', label: 'Critical message', group: 'Wording' },
        { key: 'showTotal', type: 'toggle', label: 'Show window and percent',
          hint: 'Off leaves just the token count.', group: 'Wording' },

        { key: 'position', type: 'combo', label: 'Corner', group: 'Placement',
          options: [
              { value: 'top', label: 'Top, centred' },
              { value: 'tr', label: 'Top right' },
              { value: 'br', label: 'Bottom right' },
              { value: 'bl', label: 'Bottom left' },
          ] },
        { key: 'offset', type: 'slider', label: 'Edge offset', min: 8, max: 200, step: 2, unit: 'px',
          group: 'Placement' },

        { key: 'size', type: 'slider', label: 'Text size', min: 9, max: 18, step: 0.5, unit: 'px',
          group: 'Look' },
        { key: 'padY', type: 'slider', label: 'Padding', min: 2, max: 14, step: 1, unit: 'px',
          group: 'Look' },
        { key: 'weight', type: 'slider', label: 'Tint weight', min: 0.2, max: 1, step: 0.01,
          hint: 'How far the fill and border pull toward the tier color.', group: 'Look' },
        { key: 'glow', type: 'toggle', label: 'Glow', group: 'Look' },
        { key: 'warnColor', type: 'color', label: 'Warn color', group: 'Look' },
        { key: 'criticalColor', type: 'color', label: 'Critical color', group: 'Look' },
    ],
    apply,
    preview: {
        title: 'Preview — both tiers',
        beforeLabel: 'warn tier',
        afterLabel: 'critical tier',
        layout: 'row',
        // Both stages are the live builder with the live css(), so a slider moves
        // the preview exactly as it moves the real pill. "before" is the warn
        // tier rather than the stock app, because the app draws nothing here at
        // all — there is no before state to show.
        node(which) {
            const box = el('div', 'pv-hold');
            const p = buildPill(box);
            p.className = 'pill ' + (which === 'after' ? 'critical' : 'warn');
            p.querySelector('.num').textContent = which === 'after' ? '640k' : '312k';
            p.querySelector('.of').textContent = which === 'after' ? '/ 1M  64%' : '/ 1M  31%';
            // The message text comes from css(), not from here: value edits
            // restyle the stages, they do not rebuild them, so a message typed
            // into the panel would not otherwise show up until a tab switch.
            return box;
        },
        css(v, sel, which) {
            const crit = which === 'after';
            const text = (crit ? v.criticalText : v.warnText) || '';
            return pillCss(sel + ' ', v) + `
${sel} .pv-hold { display: flex; justify-content: center; padding: 16px 12px; }
${sel} .pill { --c: ${crit ? v.criticalColor : v.warnColor}; }
${sel} .pill .of { ${v.showTotal ? '' : 'display: none;'} }
${sel} .pill .hint { display: inline; }
${sel} .pill .hint::after { content: ${JSON.stringify(text)}; }
`;
        },
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((f) => { try { f(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((f) => { try { f(); } catch (_) {} });
});

if (REG.subs.size === 0) apply(spec.defaults);
