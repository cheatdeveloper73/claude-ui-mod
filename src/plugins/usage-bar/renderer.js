/* claude-ui-mod :: usage-bar (renderer)
 *
 * Fills the empty middle of the composer footer — between the mode buttons and
 * the model buttons — with two meters: context in play, and whichever rate-limit
 * bucket is closest to its ceiling.
 *
 * It renders into its own shadow root and is positioned over that gap rather
 * than inserted into it. The footer is React-owned and re-renders constantly; a
 * child injected there would be gone on the next render, and a class added to it
 * would be clobbered. Measuring and floating is the only stable option, which is
 * the same reason the task rail does it.
 *
 * CONTEXT COMES FROM THE CLI, NOT FROM A TABLE. The app exposes its session
 * bridge over eipc, and LocalSessions.getContextUsage(sessionId) forwards to the
 * CLI as subtype `get_context_usage`. Its reply carries, for the session's
 * currently selected model:
 *
 *   totalTokens          tokens in context right now
 *   rawMaxTokens         the model's maximum context  <- the number we wanted
 *   percentage           the app's own rounded figure
 *   autoCompactThreshold absolute token count where auto-compaction fires
 *   model, categories[], messageBreakdown, apiUsage
 *
 * That is the same call the app's own composer ring uses (it renders
 * `used / rawMaxTokens`), so switching model or session updates the maximum with
 * no per-model knowledge anywhere in this mod, and a model released tomorrow
 * works without an edit.
 *
 * The app's own "Approaching weekly usage limit" band says less than these
 * meters do, so it is tagged by text (an attribute, never a class) and hidden by
 * a stylesheet — but only after its reset time has been read off it, since that
 * string exists nowhere on disk.
 *
 * "Low key when not needed" is literal: the bar sits at a low opacity and cool
 * colour until a bucket crosses the warn threshold, then it warms and brightens,
 * and only pulses once past danger.
 */
'use strict';

const HOST_ID = 'cuimod-usage';
const BAR_H = 22;
const GAP = 14;
const MIN_W = 190;

let cfg = null;
let data = { plan: null, ctx: null };
let resetsText = null;
let host = null, shadow = null, bar = null, sheet = null;
let timer = null;

// ------------------------------------------------------------------ styling
function barCss(p, v) {
    const idle = v.idle;
    return `
${p}.bar {
    display: flex; align-items: center; gap: ${v.gap}px;
    /* The gap between the mode cluster and the model cluster is the whole
     * budget: content must truncate inside it, never spill over either. */
    max-width: 100%; overflow: hidden;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 10px; line-height: 1;
    color: hsl(var(--text-400, 48 5% 57%));
    opacity: ${idle};
    transition: opacity 240ms cubic-bezier(.2,.85,.3,1);
    user-select: none; white-space: nowrap;
}
${p}.bar:hover { opacity: 1; }
${p}.bar.alert { opacity: ${Math.min(1, idle + 0.35)}; }

${p}.m { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; }
${p}.m.ctx { flex-shrink: 1; }
${p}.k { flex: 0 0 auto; }
${p}.v { flex: 0 0 auto; }
${p}.k {
    font-size: 9px; letter-spacing: .1em; text-transform: uppercase;
    color: hsl(var(--text-500, 48 5% 57%));
    transition: color 400ms ease;
}
${p}.m.hot .k { color: var(--c); }

${p}.tr {
    position: relative; height: ${v.thickness}px; width: ${v.width}px; flex: 0 0 auto;
    border-radius: ${v.thickness}px; overflow: hidden;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 11%, transparent);
}
${p}.tr i {
    position: absolute; inset: 0 auto 0 0; display: block; border-radius: inherit;
    background: linear-gradient(90deg,
        color-mix(in srgb, var(--c) ${Math.round(55 * v.intensity + 20)}%, transparent) 0%,
        color-mix(in srgb, var(--c) ${Math.round(100 * v.intensity)}%, transparent) 100%);
    ${v.glow ? `box-shadow: 0 0 ${(5 * v.intensity).toFixed(1)}px color-mix(in srgb, var(--c) ${Math.round(34 * v.intensity)}%, transparent);` : ''}
    transition: width 420ms cubic-bezier(.2,.85,.3,1), background 600ms ease,
                box-shadow 600ms ease, opacity 600ms ease;
}
/* The compaction line, drawn on the track rather than described in text. */
${p}.tr b {
    position: absolute; top: -1px; bottom: -1px; width: 1px; border-radius: 0;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 40%, transparent);
    transition: left 420ms cubic-bezier(.2,.85,.3,1), opacity 300ms ease;
}
${p}.m.danger .tr i { animation: pulse 2.1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .66; } }

${p}.v {
    font-variant-numeric: tabular-nums; font-size: 10px; min-width: 26px; text-align: right;
    color: hsl(var(--text-300, 55 9% 74%));
    transition: color 400ms ease;
}
${p}.m.hot .v { color: var(--c); }
${p}.sub {
    font-size: 9.5px; color: hsl(var(--text-500, 48 5% 57%));
    white-space: nowrap; flex: 0 0 auto;
}
${p}.sep {
    width: 1px; height: 11px; flex: 0 0 auto;
    background: color-mix(in srgb, hsl(var(--text-100, 60 14% 97%)) 13%, transparent);
}
${p}.spark { display: block; overflow: visible; opacity: .75; }
${p}.spark path { fill: none; stroke: var(--c); stroke-width: 1.25; stroke-linejoin: round;
                  stroke-linecap: round; transition: stroke 600ms ease; }
${p}.spark path.area { fill: color-mix(in srgb, var(--c) 16%, transparent); stroke: none; }
`;
}

const HOST_CSS = (v) => `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
    position: fixed; z-index: 2147482900;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    opacity: 0; transform: translateY(3px);
    transition: opacity 220ms cubic-bezier(.2,.85,.3,1), transform 220ms cubic-bezier(.2,.85,.3,1);
}
.wrap.show { opacity: 1; transform: none; pointer-events: auto; }
${barCss('', v)}
`;

// ------------------------------------------------------------------ helpers
const clamp01 = (n) => Math.max(0, Math.min(1, n));
function short(n) {
    if (!isFinite(n)) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
}
// "Mon, Aug 31, 9:00 AM" -> "Mon 9:00 AM". The date is already implied by the
// weekday for anything inside a week, and the space is worth more.
function shortReset(t) {
    const m = String(t).match(/^([A-Za-z]{3})[^,]*,\s*[^,]+,\s*(.+)$/);
    return m ? m[1] + ' ' + m[2] : String(t);
}

// The reply carries a full category breakdown; the bar has no room for it, a
// tooltip does.
function ctxTitle(c) {
    const head = (c.model || 'session') + ' — ' + c.totalTokens.toLocaleString()
        + ' of ' + c.rawMaxTokens.toLocaleString()
        + (c.isAutoCompactEnabled && c.autoCompactThreshold
            ? '; compacts at ' + c.autoCompactThreshold.toLocaleString() : '');
    const cats = (c.categories || [])
        .filter((x) => x && x.tokens > 0 && x.name !== 'Free space')
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 6)
        .map((x) => x.name + ' ' + x.tokens.toLocaleString());
    const NL = String.fromCharCode(10);
    return cats.length ? head + NL + cats.join(NL) : head;
}

function severity(pct, v) {
    if (pct >= v.danger) return 'danger';
    if (pct >= v.warn) return 'warn';
    return 'calm';
}
// Context and limits get separate hue families. Under one palette a context
// meter at 68% and a plan meter at 67% render identically, and the two stop
// being tellable apart at a glance — which is the point of having both.
function colorFor(sev, v, family) {
    const p = family === 'ctx' ? [v.ctxCalm, v.ctxWarn, v.ctxHot] : [v.limCalm, v.limWarn, v.limHot];
    return sev === 'danger' ? p[2] : sev === 'warn' ? p[1] : p[0];
}

// Whichever bucket is nearest its ceiling is the one worth the space.
function pickBucket(plan, v) {
    if (!plan || !plan.latest) return null;
    const entries = Object.entries(plan.latest)
        .filter(([k, n]) => typeof n === 'number' && plan.buckets && plan.buckets[k]);
    if (!entries.length) return null;
    if (v.bucket !== 'auto') {
        const hit = entries.find(([k]) => plan.buckets[k].id === v.bucket);
        if (hit) return { key: hit[0], pct: hit[1] };
    }
    entries.sort((a, b) => b[1] - a[1]);
    return { key: entries[0][0], pct: entries[0][1] };
}

function sparkPath(series, w, h) {
    const pts = (series || []).filter((n) => typeof n === 'number');
    if (pts.length < 2) return null;
    const max = Math.max(100, ...pts);
    const step = w / (pts.length - 1);
    const y = (n) => h - (n / max) * (h - 1) - 0.5;
    let d = `M0 ${y(pts[0]).toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) d += ` L${(i * step).toFixed(2)} ${y(pts[i]).toFixed(2)}`;
    return { line: d, area: d + ` L${w} ${h} L0 ${h} Z` };
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}
function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, val] of Object.entries(attrs || {})) n.setAttribute(k, val);
    return n;
}

// ------------------------------------------------------------------ the bar
function buildBar(root, v) {
    const b = el('div', 'bar');

    const ctx1 = el('div', 'm ctx');
    ctx1.append(el('span', 'k', 'context'));
    const t1 = el('span', 'tr');
    t1.append(el('i'), el('b'));
    ctx1.append(t1, el('span', 'v', '—'), el('span', 'sub', ''));

    const sep = el('div', 'sep');

    const lim = el('div', 'm lim');
    lim.append(el('span', 'k', '—'));
    const t2 = el('span', 'tr');
    t2.append(el('i'));
    lim.append(t2, el('span', 'v', '—'));
    const spark = svgEl('svg', { class: 'spark', width: v.spark ? 46 : 0, height: 11, viewBox: '0 0 46 11' });
    spark.append(svgEl('path', { class: 'area', d: '' }), svgEl('path', { d: '' }));
    lim.append(spark, el('span', 'sub', ''));

    b.append(ctx1, sep, lim);
    root.append(b);
    return b;
}

function paint() {
    if (!bar || !cfg) return;
    const v = cfg;

    // ---- context (CLI numbers; nothing here is derived from a model table)
    const c = data.ctx;
    const ctxEl = bar.querySelector('.ctx');
    const have = !!(c && c.rawMaxTokens);
    const frac = have ? clamp01(c.totalTokens / c.rawMaxTokens) : 0;
    const sev = severity(frac, v);
    ctxEl.className = 'm ctx ' + sev + (sev !== 'calm' ? ' hot' : '');
    ctxEl.style.setProperty('--c', colorFor(sev, v, 'ctx'));
    ctxEl.querySelector('i').style.width = (frac * 100).toFixed(2) + '%';

    // The compaction mark sits where the CLI says it fires, not at a guess.
    const mark = ctxEl.querySelector('b');
    const compactAt = have && c.isAutoCompactEnabled && c.autoCompactThreshold
        ? clamp01(c.autoCompactThreshold / c.rawMaxTokens) : null;
    mark.style.left = ((compactAt || 0) * 100).toFixed(2) + '%';
    mark.style.opacity = v.showCompaction && compactAt ? '1' : '0';

    ctxEl.querySelector('.v').textContent = have ? Math.round(frac * 100) + '%' : '—';
    const csub = ctxEl.querySelector('.sub');
    csub.textContent = have ? short(c.totalTokens) + ' / ' + short(c.rawMaxTokens) : 'no session';
    csub.title = have ? ctxTitle(c) : '';

    // ---- limits
    const limEl = bar.querySelector('.lim');
    const plan = data.plan;
    const pick = pickBucket(plan, v);
    const pct = pick ? clamp01(pick.pct / 100) : 0;
    const lsev = severity(pct, v);
    limEl.className = 'm lim ' + lsev + (lsev !== 'calm' ? ' hot' : '');
    limEl.style.setProperty('--c', colorFor(lsev, v, 'lim'));
    limEl.querySelector('i').style.width = (pct * 100).toFixed(2) + '%';
    const meta = pick && plan.buckets[pick.key];
    limEl.querySelector('.k').textContent = meta ? meta.label : '—';
    limEl.querySelector('.v').textContent = pick ? Math.round(pick.pct) + '%' : '—';
    const subEl = limEl.querySelector('.sub');
    subEl.textContent = resetsText && v.showResets ? shortReset(resetsText) : '';
    subEl.title = resetsText ? 'resets ' + resetsText : '';
    limEl.title = meta ? meta.title + ' — ' + Math.round(pick.pct) + '%' : '';

    const spark = limEl.querySelector('.spark');
    const series = pick && plan.series ? plan.series[pick.key] : null;
    const path = v.spark ? sparkPath(series, 46, 11) : null;
    spark.setAttribute('width', path ? 46 : 0);
    spark.querySelector('path.area').setAttribute('d', path ? path.area : '');
    spark.querySelector('path:not(.area)').setAttribute('d', path ? path.line : '');

    bar.classList.toggle('alert', sev !== 'calm' || lsev !== 'calm');
}

// ------------------------------------------------------------------ placing
// The row is found from the model/effort cluster, which is the only part of the
// footer with a stable shape: an ml-auto flex group inside the composer width.
function findRow() {
    for (const g of document.querySelectorAll('.epitaxy-composer-width [class*="ml-auto"]')) {
        const row = g.parentElement;
        if (!row) continue;
        const r = row.getBoundingClientRect();
        if (r.height < 12 || r.height > 52 || r.width < 220) continue;
        return { row, right: g, rowRect: r, rightRect: g.getBoundingClientRect() };
    }
    return null;
}

function place() {
    if (!host || !cfg) return;
    // A generation that failed to dispose leaves its host in the page. Its JS is
    // gone, so it freezes with stale numbers at a stale position and reads as a
    // rendering bug — and getElementById would hand it to anything looking us up.
    const all = document.querySelectorAll('#' + HOST_ID);
    if (all.length > 1) for (const e of all) { if (e !== host) e.remove(); }
    const wrap = shadow.querySelector('.wrap');
    if (!cfg.enabled) { wrap.classList.remove('show'); return; }
    const found = findRow();
    if (!found) { wrap.classList.remove('show'); return; }

    // Left edge is whatever the last control before the model cluster ends at,
    // so the bar never overlaps the mode button however wide it gets.
    let leftEdge = found.rowRect.left;
    for (const child of found.row.children) {
        if (child === found.right) break;
        const r = child.getBoundingClientRect();
        if (r.width > 0) leftEdge = Math.max(leftEdge, r.right);
    }
    const left = Math.round(leftEdge + GAP);
    const width = Math.round(found.rightRect.left - GAP - left);
    if (width < MIN_W) { wrap.classList.remove('show'); return; }

    const top = Math.round(found.rowRect.top + (found.rowRect.height - BAR_H) / 2);
    const set = (k, val) => { if (wrap.style[k] !== val) wrap.style[k] = val; };
    set('left', left + 'px');
    set('top', top + 'px');
    set('width', width + 'px');
    set('height', BAR_H + 'px');
    wrap.classList.add('show');
}

let raf = 0;
function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; place(); });
}
ctx.onDispose(() => { if (raf) cancelAnimationFrame(raf); });

// ------------------------------------------------------------------ banner
// Tagged by text because the icon changes with severity, and by attribute
// because React owns className on that node.
const docStyle = document.createElement('style');
docStyle.id = 'cuimod-usage-banner';
(document.head || document.documentElement).appendChild(docStyle);
ctx.onDispose(() => {
    try { docStyle.remove(); } catch (_) {}
    for (const e of document.querySelectorAll('[data-cuimod-usage]')) e.removeAttribute('data-cuimod-usage');
});

function scanBands() {
    let found = null;
    for (const band of document.querySelectorAll('.epitaxy-composer-band')) {
        const t = band.textContent || '';
        if (!/usage limit/i.test(t)) {
            if (band.hasAttribute('data-cuimod-usage')) band.removeAttribute('data-cuimod-usage');
            continue;
        }
        band.setAttribute('data-cuimod-usage', '1');
        const m = t.match(/Resets\s+(.+?)(?:Get more usage|$)/i);
        if (m) found = m[1].trim();
    }
    if (found && found !== resetsText) { resetsText = found; paint(); }
}

// ------------------------------------------------------------------ data
// The channel takes the DESKTOP session id (local_<uuid>) — the one in the URL —
// not the cliSessionId the task store uses.
const CTX_CHANNEL = cuimod.eipc('claude.web', 'LocalSessions', 'getContextUsage');
function desktopSessionId() {
    const m = (location.pathname + location.search).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? 'local_' + m[0].toLowerCase() : null;
}

let pulling = false;
async function refresh() {
    if (pulling) return;
    pulling = true;
    try {
        const plan = await cuimod.rpc('usage-bar.plan');
        if (plan) data.plan = plan;
    } catch (_) { /* host reloading */ }
    try {
        const id = desktopSessionId();
        data.ctx = id ? await cuimod.appInvoke(CTX_CHANNEL, id) : null;
    } catch (_) { data.ctx = null; }
    paint();
    pulling = false;
}

function retime() {
    clearInterval(timer);
    timer = setInterval(() => { scanBands(); refresh(); }, Math.max(1000, cfg.interval));
}
ctx.onDispose(() => clearInterval(timer));

// ------------------------------------------------------------------ apply
function apply(v) {
    cfg = v;

    for (const e of document.querySelectorAll('#' + HOST_ID)) { if (e !== host) e.remove(); }

    if (!host) {
        host = el('div');
        host.id = HOST_ID;
        shadow = host.attachShadow({ mode: 'open' });
        sheet = new CSSStyleSheet();
        shadow.adoptedStyleSheets = [sheet];
        const wrap = el('div', 'wrap');
        shadow.append(wrap);
        bar = buildBar(wrap, v);
        document.documentElement.appendChild(host);
        ctx.onDispose(() => { try { host.remove(); } catch (_) {} host = null; });
    }

    sheet.replaceSync(HOST_CSS(v));
    docStyle.textContent = v.hideBanner
        ? '[data-cuimod-usage="1"] { display: none !important; }'
        : '';

    // The spark element only exists at build time, so a toggle needs a rebuild.
    const spark = bar.querySelector('.spark');
    if (spark) spark.setAttribute('width', v.spark ? 46 : 0);

    retime();
    scanBands();
    paint();
    schedule();
    refresh();
}

ctx.track(window, 'resize', schedule, { passive: true });
ctx.track(window, 'scroll', schedule, { passive: true, capture: true });
ctx.track(document, 'visibilitychange', schedule);
ctx.observe(document.documentElement, { childList: true, subtree: true }, () => { schedule(); scanBands(); });
ctx.every(1000, place);
cuimod.onSessionChange(refresh);

// ------------------------------------------------------------------ panel
const spec = {
    plugin: 'usage-bar',
    title: 'Usage meters',
    description: 'Context and rate-limit meters in the empty middle of the composer bar.',
    defaults: {
        enabled: true,
        hideBanner: true,
        bucket: 'auto',
        showCompaction: true,
        showResets: false,
        spark: false,
        width: 96,
        thickness: 4,
        gap: 12,
        idle: 0.55,
        intensity: 1,
        glow: false,
        warn: 0.6,
        danger: 0.85,
        ctxCalm: '#8ecae6',
        ctxWarn: '#a9a0f0',
        ctxHot: '#cf8ef5',
        limCalm: '#9fd8a8',
        limWarn: '#f3cb8a',
        limHot: '#f5949a',
        interval: 8000,
    },
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Enabled', group: 'Meters' },
        { key: 'hideBanner', type: 'toggle', label: 'Hide the app’s usage band',
          hint: 'Its reset time is read off it first, then shown here.', group: 'Meters' },
        { key: 'bucket', type: 'combo', label: 'Limit shown', group: 'Meters',
          hint: 'Auto shows whichever bucket sits closest to its ceiling.',
          options: [
              { value: 'auto', label: 'Auto — whichever is highest' },
              { value: 'five_hour', label: 'Session (5 hour)' },
              { value: 'seven_day', label: 'Weekly (7 day)' },
              { value: 'seven_day_opus', label: 'Weekly, Opus' },
              { value: 'seven_day_sonnet', label: 'Weekly, Sonnet' },
          ] },
        { key: 'interval', type: 'slider', label: 'Refresh', min: 1000, max: 30000, step: 500, unit: 'ms',
          group: 'Meters' },

        { key: 'width', type: 'slider', label: 'Track length', min: 40, max: 240, step: 2, unit: 'px', group: 'Shape' },
        { key: 'thickness', type: 'slider', label: 'Track thickness', min: 2, max: 12, step: 1, unit: 'px', group: 'Shape' },
        { key: 'gap', type: 'slider', label: 'Spacing', min: 4, max: 30, step: 1, unit: 'px', group: 'Shape' },
        { key: 'spark', type: 'toggle', label: 'Sparkline',
          hint: '30 days of samples are on disk; this draws the recent slope.', group: 'Shape' },
        { key: 'showCompaction', type: 'toggle', label: 'Compaction mark',
          hint: 'Drawn where the CLI says auto-compaction fires.', group: 'Shape' },
        { key: 'showResets', type: 'toggle', label: 'Show reset time', group: 'Shape' },

        { key: 'idle', type: 'slider', label: 'Idle opacity', min: 0.1, max: 1, step: 0.01,
          hint: 'Full opacity on hover regardless.', group: 'Colour' },
        { key: 'intensity', type: 'slider', label: 'Fill weight', min: 0.2, max: 1, step: 0.01,
          hint: '1 reaches the full colour; lower mixes toward the track, which reads darker.',
          group: 'Colour' },
        { key: 'glow', type: 'toggle', label: 'Glow', group: 'Colour' },
        { key: 'warn', type: 'slider', label: 'Warn at', min: 0, max: 1, step: 0.01, group: 'Colour' },
        { key: 'danger', type: 'slider', label: 'Danger at', min: 0, max: 1, step: 0.01,
          hint: 'Past this the fill pulses.', group: 'Colour' },
        { key: 'ctxCalm', type: 'color', label: 'Context — calm', group: 'Context colour' },
        { key: 'ctxWarn', type: 'color', label: 'Context — warn', group: 'Context colour' },
        { key: 'ctxHot', type: 'color', label: 'Context — danger', group: 'Context colour' },
        { key: 'limCalm', type: 'color', label: 'Limit — calm', group: 'Limit colour' },
        { key: 'limWarn', type: 'color', label: 'Limit — warn', group: 'Limit colour' },
        { key: 'limHot', type: 'color', label: 'Limit — danger', group: 'Limit colour' },
    ],
    apply,
    preview: {
        title: 'Preview — composer meters',
        beforeLabel: 'stock app band',
        node(which) {
            if (which === 'after') {
                // Static sample numbers; everything that the controls govern —
                // colour, size, spacing, marks — comes from css() below, so the
                // stage reacts to a slider the same way the live bar does.
                const box = el('div', 'pv-hold');
                const b = buildBar(box, spec.defaults);
                b.querySelector('.ctx .v').textContent = '35%';
                b.querySelector('.ctx .sub').textContent = '347k / 1M';
                b.querySelector('.lim .k').textContent = '7d';
                b.querySelector('.lim .v').textContent = '67%';
                b.querySelector('.lim .sub').textContent = 'resets Mon, Aug 31, 9:00 AM';
                const series = [51, 53, 54, 56, 57, 59, 60, 60, 62, 63, 64, 66, 66, 67, 67];
                const path = sparkPath(series, 46, 11);
                b.querySelector('.spark path.area').setAttribute('d', path.area);
                b.querySelector('.spark path:not(.area)').setAttribute('d', path.line);
                return box;
            }
            {
                const b = el('div', 'pv-band');
                b.append(el('span', 'pv-i', '◔'), el('span', null, 'Approaching weekly usage limit'),
                         el('span', 'pv-m', 'Resets Mon, Aug 31, 9:00 AM'), el('span', 'pv-btn', 'Get more usage'));
                return b;
            }
        },
        css(v, sel, which) {
            if (which === 'before') {
                return `
${sel} .pv-band {
    display: flex; align-items: center; gap: 10px; width: 470px;
    padding: 9px 12px; border-radius: 10px; font-size: 12px;
    background: color-mix(in srgb, hsl(var(--text-100)) 5%, transparent);
    color: hsl(var(--text-200));
}
${sel} .pv-i { color: hsl(var(--text-500)); }
${sel} .pv-m { color: hsl(var(--text-500)); font-size: 11px; margin-left: auto; }
${sel} .pv-btn { padding: 3px 8px; border-radius: 6px; font-size: 11px;
    background: color-mix(in srgb, hsl(var(--text-100)) 9%, transparent); }
`;
            }
            return `${sel} .pv-hold { width: 470px; }\n` + barCss(sel + ' ', v);
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
