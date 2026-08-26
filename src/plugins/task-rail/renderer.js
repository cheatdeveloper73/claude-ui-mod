/* claude-ui-mod :: task rail
 *
 * Runs in the preload's isolated world with the DOM of the claude.ai page.
 * Receives the `cuimod` bridge as its only argument.
 *
 * Edit this file and reload the window (Ctrl+R) to see changes — the preload
 * pulls this source over IPC at boot and only falls back to its baked copy if
 * the file is unreadable.
 */

const GAP = 12;
const WIDTH = 264;
const MIN_WIDTH = 190;

const FADE_MS = 100;     // per-row fade
const STAGGER_MS = 150;  // total stagger budget, whatever the row count
const STEP_MAX = 26;     // ms between neighbouring rows at small counts
const TWEEN_MS = 140;    // rail height tween
const EDGE = 14;         // scroll-clip fade, px
const TIP_CLAMP = 280;   // chars of description before "Show more"

// A row is "the same row" only if everything it renders is unchanged, so a
// status flip counts as a change and animates like any other.
function rowKey(t, expanded) {
    return [t.id, t.status, t.subject, t.activeForm, t.owner,
        (t.blockedBy || []).join(','), expanded ? t.description : ''].join('\u0000');
}

function stagger(n) { return n > 1 ? Math.min(STEP_MAX, STAGGER_MS / (n - 1)) : 0; }

const STATUS = {
    completed: { label: 'done', color: 'hsl(var(--success-100, 140 50% 40%))' },
    in_progress: { label: 'active', color: 'hsl(var(--accent-100, 210 71% 52%))' },
    pending: { label: 'pending', color: 'hsl(var(--text-400, 60 3% 45%))' },
};

const CSS = `
:host { all: initial; }
.rail {
    position: fixed;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    color: hsl(var(--text-100, 60 3% 15%));
    background: hsl(var(--bg-100, 48 33% 97%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 12%, transparent);
    border-radius: 12px;
    box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.08);
    overflow: hidden;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .12s ease, transform .12s ease;
    pointer-events: none;
}
.rail.show { opacity: 1; transform: none; pointer-events: auto; }
.hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 10px 9px 12px;
    border-bottom: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 10%, transparent);
    background: hsl(var(--bg-200, 48 25% 94%));
    flex: 0 0 auto;
}
.ttl { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
       color: hsl(var(--text-300, 60 3% 35%)); flex: 1 1 auto; }
.count { font-size: 11px; font-variant-numeric: tabular-nums; color: hsl(var(--text-400, 60 3% 45%)); }
.btn {
    all: unset; cursor: pointer; width: 18px; height: 18px; line-height: 18px;
    text-align: center; border-radius: 5px; font-size: 12px;
    color: hsl(var(--text-400, 60 3% 45%));
}
.btn:hover { background: hsl(var(--bg-300, 48 20% 90%)); color: hsl(var(--text-100, 60 3% 15%)); }
.body {
    overflow-y: auto; overscroll-behavior: contain; padding: 4px; flex: 1 1 auto;
    /* --ft/--fb are set from JS to the edges that are actually clipping, so a
       list that fits its box is not fogged at both ends for no reason. */
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft, 0px),
        #000 calc(100% - var(--fb, 0px)), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 var(--ft, 0px),
        #000 calc(100% - var(--fb, 0px)), transparent 100%);
    transition: -webkit-mask-image .12s ease;
    /* claude.ai sets scrollbar-color, which is inherited and makes Chromium
       ignore ::-webkit-scrollbar entirely (measured: 15px, rules dropped).
       Resetting it to auto hands styling back to the pseudo-elements. */
    scrollbar-color: auto;
}
.body, .foot { transition: opacity .1s ease; }
.body::-webkit-scrollbar { width: 3px; }
.body::-webkit-scrollbar-track { background: transparent; }
.body::-webkit-scrollbar-thumb { background: color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 22%, transparent); border-radius: 2px; }
.body::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 38%, transparent); }
.rail.collapsed .body, .rail.collapsed .foot { display: none; }
/* Collapsed, the rail is sized to the composer box, so the header stretches to
   fill it and its rule would double up with the rail's own bottom border. */
.rail.collapsed .hdr { flex: 1 1 auto; border-bottom: 0; }

.t { display: grid; grid-template-columns: 12px 1fr; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: default; }
.t:hover { background: hsl(var(--bg-200, 48 25% 94%)); }
.dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; margin-left: 2px; flex: 0 0 auto; }
.t.completed .dot { opacity: .45; }
.t.in_progress .dot { box-shadow: 0 0 0 3px hsl(var(--accent-100, 210 71% 52%) / .18); animation: pulse 1.8s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
.sub { font-size: 12.5px; line-height: 1.35; word-break: break-word; }
.t.completed .sub { color: hsl(var(--text-400, 60 3% 45%)); text-decoration: line-through; text-decoration-thickness: 1px; }
.meta { margin-top: 3px; font-size: 10.5px; color: hsl(var(--text-400, 60 3% 45%)); display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 1px 5px; border-radius: 4px; background: hsl(var(--bg-300, 48 20% 90%)); }
.tag.blocked { color: hsl(var(--danger-100, 5 60% 50%)); }
.desc { overflow: hidden; margin-top: 4px; font-size: 11px; line-height: 1.45; color: hsl(var(--text-300, 60 3% 35%)); white-space: pre-wrap; word-break: break-word; }
.empty { padding: 18px 12px; text-align: center; font-size: 11.5px; color: hsl(var(--text-400, 60 3% 45%)); }
.foot { flex: 0 0 auto; display: flex; gap: 6px; padding: 6px 8px; border-top: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 10%, transparent); }
.foot .sid { flex: 1 1 auto; font-size: 10px; font-family: ui-monospace, Consolas, monospace;
             color: hsl(var(--text-400, 60 3% 45%)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot .lnk { all: unset; cursor: pointer; font-size: 10px; color: hsl(var(--accent-100, 210 71% 52%)); }

.tip {
    position: fixed; z-index: 2147483001; box-sizing: border-box;
    max-width: 340px; width: max-content; padding: 8px 10px;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
    color: hsl(var(--text-100, 60 3% 15%));
    background: hsl(var(--bg-200, 48 25% 94%));
    border: 1px solid color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 12%, transparent);
    border-radius: 10px;
    box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 10px 30px rgba(0,0,0,.30);
    opacity: 0; transform: translateY(3px); pointer-events: none;
    transition: opacity .09s ease, transform .09s ease;
}
.tip.show { opacity: 1; transform: none; }
.tip .tid { display: block; margin-bottom: 4px; font-size: 10px;
            font-family: ui-monospace, Consolas, monospace;
            color: hsl(var(--text-400, 60 3% 45%)); }
.tip.show { pointer-events: auto; }
.tip { max-height: 60vh; overflow-y: auto; scrollbar-color: auto; }
.tip::-webkit-scrollbar { width: 3px; }
.tip::-webkit-scrollbar-track { background: transparent; }
.tip::-webkit-scrollbar-thumb { background: color-mix(in srgb, hsl(var(--text-100, 60 3% 15%)) 22%, transparent); border-radius: 2px; }
.tip .tsub { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 600; }
.tip .more {
    all: unset; display: inline-block; margin-top: 6px; cursor: pointer;
    padding: 2px 7px; border-radius: 6px; font-size: 10.5px; font-weight: 600;
    color: hsl(var(--accent-100, 210 71% 52%));
    background: color-mix(in srgb, hsl(var(--accent-100, 210 71% 52%)) 12%, transparent);
}
.tip .more:hover { background: color-mix(in srgb, hsl(var(--accent-100, 210 71% 52%)) 22%, transparent); }
`;

// ---------------------------------------------------------------- composer

function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 20 && r.bottom > 0 && r.top < innerHeight;
}

function findComposer() {
    const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
    if (!eds.length) return null;
    // The prompt input is the bottom-most editable region on the page.
    eds.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    let node = eds[0];
    const base = node.getBoundingClientRect();
    // Climb to the visual box the editor sits in: the nearest ancestor that has
    // a real rounded border and is not dramatically wider than the editor.
    for (let i = 0, p = node.parentElement; i < 6 && p; i++, p = p.parentElement) {
        const r = p.getBoundingClientRect();
        if (r.width > base.width * 1.8 || r.height > base.height + 240) break;
        const cs = getComputedStyle(p);
        if (parseFloat(cs.borderTopLeftRadius) >= 8) node = p;
    }
    return node;
}

function sidebarRight() {
    // The desktop shell's session sidebar. It is collapsible, so a hit that is
    // not a tall left-anchored panel is treated as "no sidebar".
    for (const el of document.querySelectorAll('.dframe-sidebar, aside, nav')) {
        const r = el.getBoundingClientRect();
        if (r.left > 2 || r.width < 100 || r.width > innerWidth * 0.5) continue;
        if (r.height < innerHeight * 0.5) continue;
        return r.right;
    }
    return 0;
}

// ---------------------------------------------------------------- render

function taskRow(t, expanded) {
    const st = STATUS[t.status] || STATUS.pending;
    const row = document.createElement('div');
    row.className = 't ' + (t.status || 'pending');

    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.background = st.color;
    row.appendChild(dot);

    const col = document.createElement('div');
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = (t.status === 'in_progress' && t.activeForm) ? t.activeForm : (t.subject || '(untitled)');
    col.appendChild(sub);

    const tags = [];
    if (t.owner) tags.push(['tag', '@' + t.owner]);
    if (Array.isArray(t.blockedBy) && t.blockedBy.length) tags.push(['tag blocked', 'blocked by #' + t.blockedBy.join(', #')]);
    if (tags.length) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        for (const [cls, text] of tags) {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            meta.appendChild(s);
        }
        col.appendChild(meta);
    }

    if (expanded && t.description) {
        const d = document.createElement('div');
        d.className = 'desc';
        d.textContent = t.description;
        col.appendChild(d);
    }

    row.appendChild(col);
    row.dataset.id = String(t.id);
    return row;
}

// ---------------------------------------------------------------- main

function install(cuimod, ctx) {
    // A stale host from a previous generation would double-render.
    const stale = document.getElementById('cuimod-host');
    if (stale) stale.remove();

    const host = document.createElement('div');
    host.id = 'cuimod-host';
    const shadow = host.attachShadow({ mode: 'open' });
    // Constructable stylesheets are not subject to the page's style-src CSP,
    // which matters when this runs in claude.ai's own world rather than the
    // preload's isolated one.
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
        const style = document.createElement('style');
        style.textContent = CSS;
        shadow.appendChild(style);
    }

    const rail = document.createElement('div');
    rail.className = 'rail';
    shadow.appendChild(rail);

    rail.innerHTML =
        '<div class="hdr">' +
        '<span class="ttl">Tasks</span><span class="count"></span>' +
        '<button class="btn" data-a="expand" title="Toggle descriptions">&#9776;</button>' +
        '<button class="btn" data-a="collapse" title="Collapse">&#8722;</button>' +
        '</div>' +
        '<div class="body"></div>' +
        '<div class="foot"><span class="sid"></span><button class="lnk" data-a="open">folder</button></div>';

    const elCount = rail.querySelector('.count');
    const elBody = rail.querySelector('.body');
    const elFoot = rail.querySelector('.foot');
    const elSid = rail.querySelector('.sid');

    let expanded = localStorage.getItem('cuimod.expanded') === '1';
    let collapsed = localStorage.getItem('cuimod.collapsed') === '1';
    let tasks = [];
    let sid = null;
    let keys = [];          // row keys currently in the DOM, in order
    let holdUntil = 0;      // keep the panel up until the close finishes
    let tweening = false;   // place() must not fight the height tween
    let outGen = 0;
    let tweenGen = 0;

    // One-shot timers, disposed with the plugin like every other resource.
    const timers = new Set();
    function after(ms, fn) {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
        return t;
    }
    ctx.onDispose(() => { for (const t of timers) clearTimeout(t); timers.clear(); });

    rail.addEventListener('click', (e) => {
        const a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'expand') toggleDetails();
        else if (a === 'collapse') toggleOpen();
        else if (a === 'open' && sid) { cuimod.openTasksDir(sid); }
    });

    function paintChrome() {
        rail.classList.toggle('collapsed', collapsed);
        rail.querySelector('[data-a="collapse"]').innerHTML = collapsed ? '&#43;' : '&#8722;';
        const open = tasks.filter((t) => t.status !== 'completed').length;
        elCount.textContent = tasks.length ? open + '/' + tasks.length : '';
        elSid.textContent = sid ? sid.slice(0, 8) : '';
    }

    // fadeIn: rows whose key was not on screen a moment ago come up from zero.
    function buildBody(fadeIn) {
        const prev = new Set(keys);
        const next = tasks.map((t) => rowKey(t, expanded));
        elBody.textContent = '';
        if (!tasks.length) {
            const e = document.createElement('div');
            e.className = 'empty';
            e.textContent = sid ? 'No tasks in this session.' : 'No session detected.';
            elBody.appendChild(e);
            keys = [];
            return;
        }
        const fresh = [];
        tasks.forEach((t, i) => {
            const el = taskRow(t, expanded);
            if (fadeIn && !prev.has(next[i])) { el.style.opacity = '0'; fresh.push(el); }
            elBody.appendChild(el);
        });
        keys = next;
        edges();
        if (!fresh.length) return;
        // Flush style synchronously rather than waiting a frame: rAF never runs
        // in a hidden window, which would strand these rows at opacity 0.
        elBody.getBoundingClientRect();
        const st = stagger(fresh.length);
        fresh.forEach((el, i) => {
            el.style.transition = 'opacity ' + FADE_MS + 'ms ease ' + Math.round(i * st) + 'ms';
            el.style.opacity = '1';
        });
    }

    // Only fog an edge that is actually clipping content.
    function edges() {
        const over = elBody.scrollHeight - elBody.clientHeight;
        const top = over > 1 && elBody.scrollTop > 1;
        const bot = over > 1 && elBody.scrollTop < over - 1;
        elBody.style.setProperty('--ft', top ? EDGE + 'px' : '0px');
        elBody.style.setProperty('--fb', bot ? EDGE + 'px' : '0px');
    }
    ctx.track(elBody, 'scroll', edges, { passive: true });

    function paint() { paintChrome(); buildBody(false); edges(); holdUntil = 0; }

    // Swap the body in and tween the rail between the two content heights.
    // Every state change that resizes the panel goes through here: content
    // swap, minimise, detail toggle. Caller has already mutated the DOM; this
    // pins the old height, lets place() compute the new one, and tweens.
    function tweenFrom(from, done) {
        place();
        const to = rail.getBoundingClientRect().height;
        if (Math.abs(to - from) < 1) { if (done) after(20, done); return; }
        const gen = ++tweenGen;
        tweening = true;
        rail.style.transition = 'none';
        rail.style.height = from + 'px';
        rail.getBoundingClientRect();   // commit `from` with nothing animating
        rail.style.transition = 'opacity .12s ease, transform .12s ease, height ' + TWEEN_MS + 'ms ease';
        rail.style.height = to + 'px';
        after(TWEEN_MS + 20, () => {
            if (gen !== tweenGen) return;
            rail.style.height = '';
            rail.style.transition = '';
            tweening = false;
            place();     // reasserts the height place() skipped during the tween
            if (done) done();
        });
    }

    function swap() {
        const from = rail.getBoundingClientRect().height;
        buildBody(true);
        tweenFrom(from);
    }

    // Minimise / restore. The body and foot fade before the box shrinks and
    // after it grows, so the frame is never seen resizing around live text.
    function toggleOpen() {
        const from = rail.getBoundingClientRect().height;
        hideTip();
        const store = () => localStorage.setItem('cuimod.collapsed', collapsed ? '1' : '0');
        if (!collapsed) {
            elBody.style.opacity = '0';
            elFoot.style.opacity = '0';
            after(FADE_MS, () => {
                collapsed = true; store();
                paintChrome();
                tweenFrom(from);
            });
        } else {
            collapsed = false; store();
            paintChrome();
            elBody.style.opacity = '0';
            elFoot.style.opacity = '0';
            tweenFrom(from);
            after(Math.round(TWEEN_MS / 2), () => {
                elBody.style.opacity = '1';
                elFoot.style.opacity = '1';
            });
        }
    }

    // Hamburger. Descriptions fade out bottom-up before the box shrinks, and
    // fade in top-down as it grows.
    function toggleDetails() {
        const from = rail.getBoundingClientRect().height;
        hideTip();
        const apply = () => {
            expanded = !expanded;
            localStorage.setItem('cuimod.expanded', expanded ? '1' : '0');
            buildBody(false);
            const fresh = Array.prototype.slice.call(elBody.querySelectorAll('.desc'));
            if (fresh.length) {
                for (const d of fresh) d.style.opacity = '0';
                elBody.getBoundingClientRect();
                const st = stagger(fresh.length);
                fresh.forEach((d, i) => {
                    d.style.transition = 'opacity ' + FADE_MS + 'ms ease ' + Math.round(i * st) + 'ms';
                    d.style.opacity = '1';
                });
            }
            edges();
            tweenFrom(from);
        };
        const going = Array.prototype.slice.call(elBody.querySelectorAll('.desc'));
        if (!going.length) { apply(); return; }
        const n = going.length;
        const st = stagger(n);
        going.forEach((d, i) => {
            d.style.transition = 'opacity ' + FADE_MS + 'ms ease ' + Math.round((n - 1 - i) * st) + 'ms';
            d.style.opacity = '0';
        });
        after(FADE_MS + Math.round((n - 1) * st), apply);
    }

    // Animated repaint, for when the data behind the rail changed. Rows on
    // their way out fade bottom-up: the last row goes first, index 0 goes last.
    function update() {
        paintChrome();
        hideTip();
        if (tasks.length) holdUntil = 0;   // tasks are back; nothing to hold for
        // Collapsed, the body is display:none — animating it would only delay
        // the swap behind a fade nobody can see, so an empty list just fades
        // the panel straight out.
        if (collapsed) { buildBody(false); place(); return; }
        const nextSet = new Set(tasks.map((t) => rowKey(t, expanded)));
        const rows = elBody.children;
        const leaving = [];
        keys.forEach((k, i) => { if (!nextSet.has(k) && rows[i]) leaving.push([rows[i], i]); });
        if (!leaving.length) { swap(); place(); return; }
        const n = keys.length;
        const st = stagger(n);
        let tail = 0;
        for (const pair of leaving) {
            const d = Math.round((n - 1 - pair[1]) * st);
            if (d > tail) tail = d;
            pair[0].style.transition = 'opacity ' + FADE_MS + 'ms ease ' + d + 'ms';
            pair[0].style.opacity = '0';
        }
        // Going empty: hold the panel up for the whole staged close — rows out,
        // then the box shrinks — and hide it the moment that deadline passes.
        if (!tasks.length) {
            const total = tail + FADE_MS + TWEEN_MS + 40;
            holdUntil = Date.now() + total;
            after(total, place);
        }
        place();
        const gen = ++outGen;
        after(tail + FADE_MS, () => { if (gen === outGen) swap(); });
    }

    // ---- hover card ----
    const tip = document.createElement('div');
    tip.className = 'tip';
    shadow.appendChild(tip);
    let tipRow = null;
    let tipTimer = null;
    let tipHover = false;

    function hideTip() {
        if (tipTimer) { clearTimeout(tipTimer); timers.delete(tipTimer); tipTimer = null; }
        tipRow = null;
        tipHover = false;
        tip.classList.remove('show');
        tip.style.height = '';
        tip.style.transition = '';
    }

    // Anchored to the row, preferring the space right of the rail and flipping
    // left when it would run off. Called again after "Show more" resizes it.
    function placeTip(row) {
        const rr = rail.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        const rowr = row.getBoundingClientRect();
        let x = rr.right + 8;
        if (x + tr.width > innerWidth - 8) x = rr.left - 8 - tr.width;
        if (x < 8) x = 8;
        let y = rowr.top - 6;
        if (y + tr.height > innerHeight - 8) y = innerHeight - 8 - tr.height;
        if (y < 8) y = 8;
        tip.style.left = Math.round(x) + 'px';
        tip.style.top = Math.round(y) + 'px';
    }

    function showTip(row) {
        const t = tasks.filter((x) => String(x.id) === row.dataset.id)[0];
        if (!t || !t.description) return;
        tip.textContent = '';
        tip.style.height = '';
        tip.style.transition = '';

        const id = document.createElement('span');
        id.className = 'tid';
        id.textContent = '#' + t.id + ' \u00b7 ' + (STATUS[t.status] || STATUS.pending).label;
        const sub = document.createElement('span');
        sub.className = 'tsub';
        sub.textContent = t.subject || '(untitled)';
        const body = document.createElement('span');
        const full = String(t.description);
        const long = full.length > TIP_CLAMP;
        body.textContent = long ? full.slice(0, TIP_CLAMP).replace(/\s+\S*$/, '') + '\u2026' : full;
        tip.appendChild(id);
        tip.appendChild(sub);
        tip.appendChild(body);

        if (long) {
            const more = document.createElement('button');
            more.className = 'more';
            more.textContent = 'Show more';
            more.addEventListener('click', () => {
                const from = tip.getBoundingClientRect().height;
                body.textContent = full;
                more.remove();
                tip.style.height = '';
                const to = tip.getBoundingClientRect().height;
                tip.style.transition = 'none';
                tip.style.height = from + 'px';
                tip.getBoundingClientRect();
                tip.style.transition = 'height ' + TWEEN_MS + 'ms ease';
                tip.style.height = to + 'px';
                after(TWEEN_MS + 20, () => {
                    tip.style.height = '';
                    tip.style.transition = '';
                    if (tipRow) placeTip(tipRow);
                });
            });
            tip.appendChild(more);
        }

        tip.style.left = '0px';
        tip.style.top = '0px';
        placeTip(row);
        tip.classList.add('show');
    }

    ctx.track(elBody, 'mouseover', (e) => {
        const row = e.target && e.target.closest ? e.target.closest('.t') : null;
        if (!row || row === tipRow) return;
        hideTip();
        tipRow = row;
        tipTimer = after(260, () => { tipTimer = null; if (tipRow === row) showTip(row); });
    });
    // The card is interactive, so leaving the list must not kill it instantly —
    // the pointer needs a moment to cross the gap and land on it.
    ctx.track(elBody, 'mouseleave', () => { after(140, () => { if (!tipHover) hideTip(); }); });
    ctx.track(elBody, 'scroll', hideTip, { passive: true });
    ctx.track(tip, 'mouseenter', () => { tipHover = true; });
    ctx.track(tip, 'mouseleave', () => { tipHover = false; hideTip(); });

    // ---- positioning ----
    let composer = null;
    let baseH = 0;   // composer height with an empty prompt

    function place() {
        // Re-find every pass. The app re-renders its composer, and the old node
        // can stay *connected* while no longer being the real input — caching on
        // isConnected parks the rail on a ghost with no way back.
        const found = findComposer();
        if (found !== composer) { composer = found; baseH = 0; }
        if (!composer) { rail.classList.remove('show'); return; }

        // A generation that failed to dispose would leave a second, frozen rail.
        const hosts = document.querySelectorAll('#cuimod-host');
        if (hosts.length > 1) for (const el of hosts) { if (el !== host) el.remove(); }
        const r = composer.getBoundingClientRect();
        if (r.width < 40) { rail.classList.remove('show'); return; }

        // Centre the rail in the gutter between the app sidebar and the composer.
        const gl = sidebarRight() + GAP;
        const gr = r.left - GAP;
        const avail = gr - gl;
        if (avail < MIN_WIDTH) { rail.classList.remove('show'); return; }
        const w = Math.min(WIDTH, avail);
        const left = Math.round(gl + (avail - w) / 2);

        // Bottom edge flush with the composer box. Collapsed, the rail takes the
        // composer's exact height so both boxes share top and bottom edges;
        // expanded it grows upward from that same bottom edge.
        // The composer grows upward as a prompt wraps. Collapsed, the rail
        // matches the *empty* composer instead of following it up the screen —
        // the smallest height seen since the last resize is that baseline.
        const ch = Math.round(r.height);
        if (ch >= 24 && (!baseH || ch < baseH)) baseH = ch;

        const bottom = Math.max(8, innerHeight - r.bottom);
        const h = collapsed ? (baseH || ch) : 0;
        const maxH = Math.min(460, innerHeight - bottom - 24);

        // expanded/collapsed live in localStorage and are untouched by hiding,
        // so the panel returns in the state it left in.
        rail.classList.toggle('show', tasks.length > 0 || Date.now() < holdUntil);

        const set = (prop, val) => { if (rail.style[prop] !== val) rail.style[prop] = val; };
        set('left', left + 'px');
        set('bottom', bottom + 'px');
        set('width', w + 'px');
        if (!tweening) {
            set('height', h ? h + 'px' : '');
            set('maxHeight', h ? '' : maxH + 'px');
        }
    }

    let raf = 0;
    function schedulePlace() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; place(); });
    }

    // All via ctx so a hot reload disposes them; leaking these into a
    // long-running window is what makes naive reloading unsafe.
    ctx.track(window, 'resize', () => { baseH = 0; schedulePlace(); }, { passive: true });
    ctx.track(window, 'scroll', schedulePlace, { passive: true, capture: true });
    // A hidden window throttles both rAF and timers, so its geometry goes stale;
    // re-place the moment it comes back rather than waiting for the next tick.
    ctx.track(document, 'visibilitychange', schedulePlace);
    ctx.observe(document.documentElement, { childList: true, subtree: true }, schedulePlace);
    // rAF is throttled to zero in a hidden/occluded window, so the periodic
    // tick calls place() directly rather than through the rAF coalescer.
    ctx.every(1000, place);
    ctx.onDispose(() => { if (raf) cancelAnimationFrame(raf); host.remove(); });

    // ---- data ----
    async function load() {
        if (!sid) { tasks = []; update(); return; }
        try { tasks = await cuimod.getTasks(sid); } catch (_) { tasks = []; }
        update();
        schedulePlace();
    }

    cuimod.onSessionChange((id) => { sid = id; load(); });
    cuimod.onTasksChange(load);

    document.documentElement.appendChild(host);
    paint();
    schedulePlace();
    load();
}

install(cuimod, ctx);

// ---------------------------------------------------------------- dashboard
// Live overrides, applied as an extra stylesheet inside the rail's own shadow
// root rather than by editing anything above: the rail attaches its shadow with
// mode 'open', so adoptedStyleSheets can simply be appended to. Order gives our
// sheet the last word, and width/max-height carry !important because place()
// writes those two inline on every frame.
(function dashboardPanel() {
    const sheet = new CSSStyleSheet();

    function railRoots() {
        return [...document.querySelectorAll('#cuimod-host')]
            .map((h) => h.shadowRoot)
            .filter((r) => r);
    }
    function attach() {
        for (const root of railRoots()) {
            if (!root.adoptedStyleSheets.includes(sheet)) {
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
            }
        }
    }
    function detach() {
        for (const root of railRoots()) {
            root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
        }
    }

    const INK = 'hsl(var(--text-100, 60 14% 97%))';

    // One generator for the live override and for the dashboard's stages, so the
    // preview box carries the same declarations the real rail gets. `live` adds
    // the !important that width/opacity need to beat what place() writes inline;
    // inside a preview stage there is no inline style to beat.
    function railRules(sel, v, live) {
        const imp = live ? ' !important' : '';
        return `
${sel} {
    ${v.enabled ? '' : 'display: none' + imp + ';'}
    width: ${v.width}px${imp};
    max-width: ${v.width}px${imp};
    border-radius: ${v.radius}px;
    opacity: ${v.opacity}${imp};
    background: color-mix(in srgb, hsl(var(--bg-100, 0 0% 8%)) ${Math.round(v.tint * 100)}%, transparent);
    border: 1px solid color-mix(in srgb, ${INK} ${Math.round(v.border * 100)}%, transparent);
    box-shadow: ${v.shadow ? '0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.08)' : 'none'};
}
`;
    }

    // The rail's inner chrome, which lives in its own shadow CSS and so has to be
    // restated for a stage outside it. Only the box properties above are the
    // real thing; these rows are a stand-in for the real task list.
    function mockChrome(sel) {
        return `
${sel} .pv-rail { display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    color: ${INK}; }
${sel} .pv-h { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px;
    background: hsl(var(--bg-200, 0 0% 6.7%));
    border-bottom: 1px solid color-mix(in srgb, ${INK} 10%, transparent); }
${sel} .pv-h b { flex: 1 1 auto; font-size: 11px; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: hsl(var(--text-300, 55 9% 74%)); }
${sel} .pv-h i { font-size: 11px; font-style: normal; color: hsl(var(--text-400, 48 5% 57%)); }
${sel} .pv-rows { padding: 4px; overflow: hidden; }
${sel} .pv-r { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px;
    font-size: 12px; color: hsl(var(--text-200, 55 9% 74%)); }
${sel} .pv-r em { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: currentColor; }
${sel} .pv-r.a { color: hsl(var(--accent-100, 210 71% 52%)); }
${sel} .pv-r.d { color: hsl(var(--text-500, 48 5% 57%)); text-decoration: line-through; }
`;
    }

    function apply(v) {
        sheet.replaceSync(railRules('.rail', v, true) + `
.rail:not(.show) { opacity: 0 !important; }
.body { max-height: ${v.maxHeight}px; }
`);
        attach();
    }

    // The rail's host is created once at install, but a reload can race it and
    // a future generation may rebuild it, so re-attach on a slow tick.
    ctx.every(2000, attach);
    ctx.onDispose(detach);

    const spec = {
        plugin: 'task-rail',
        title: 'Task rail',
        description: 'The task list pinned beside the composer.',
        defaults: {
            enabled: true, width: 264, radius: 12, opacity: 1,
            tint: 1, border: 0.12, shadow: true, maxHeight: 460,
        },
        controls: [
            { key: 'enabled', type: 'toggle', label: 'Show rail', group: 'Rail' },
            { key: 'width', type: 'slider', label: 'Width', min: 190, max: 460, step: 2, unit: 'px',
              hint: 'The rail still hides itself when the gutter is narrower than this.', group: 'Rail' },
            { key: 'maxHeight', type: 'slider', label: 'Max list height', min: 160, max: 900, step: 10, unit: 'px',
              group: 'Rail' },
            { key: 'radius', type: 'slider', label: 'Corner radius', min: 0, max: 24, step: 1, unit: 'px',
              group: 'Appearance' },
            { key: 'opacity', type: 'slider', label: 'Opacity', min: 0.2, max: 1, step: 0.01, group: 'Appearance' },
            { key: 'tint', type: 'slider', label: 'Background opacity', min: 0, max: 1, step: 0.01,
              hint: 'Below 1 the transcript shows through.', group: 'Appearance' },
            { key: 'border', type: 'slider', label: 'Border strength', min: 0, max: 0.5, step: 0.01,
              group: 'Appearance' },
            { key: 'shadow', type: 'toggle', label: 'Drop shadow', group: 'Appearance' },
        ],
        apply,
        preview: {
            title: 'Preview — task rail',
            // The rail is not something the stock app draws, so its left stage
            // is this plugin at its own defaults, not "the app without it".
            beforeLabel: 'plugin defaults (no stock equivalent)',
            layout: 'row',
            node() {
                const box = document.createElement('div');
                box.className = 'pv-rail';
                const h = document.createElement('div');
                h.className = 'pv-h';
                const b = document.createElement('b');
                b.textContent = 'tasks';
                const i = document.createElement('i');
                i.textContent = '2/6';
                h.append(b, i);
                const rows = document.createElement('div');
                rows.className = 'pv-rows';
                const items = [
                    ['d', 'Read the wire format'],
                    ['d', 'Confirm the struct offsets'],
                    ['a', 'Patch the client reader'],
                    ['', 'Add a round-trip test'],
                    ['', 'Check the tick math'],
                    ['', 'Land behind a flag'],
                ];
                for (const [cls, text] of items) {
                    const r = document.createElement('div');
                    r.className = 'pv-r' + (cls ? ' ' + cls : '');
                    const dot = document.createElement('em');
                    r.append(dot, text);
                    rows.append(r);
                }
                box.append(h, rows);
                return box;
            },
            css(v, sel, which) {
                const t = which === 'before' ? spec.defaults : v;
                return railRules(sel + ' .pv-rail', t, false) + mockChrome(sel) +
                    `${sel} .pv-rows { max-height: ${Math.max(0, t.maxHeight - 40)}px; }\n`;
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
})();
