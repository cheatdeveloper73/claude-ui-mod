'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = process.argv[2] || path.join(__dirname, '../src/plugins/transcript-scroll/renderer.js');
const source = fs.readFileSync(file, 'utf8');
function setup({ withSizer = true } = {}) {
    const listeners = [], disposers = [], frames = new Map(), intervals = [], resizes = [], mutations = [];
    const counts = { reads: 0, writes: 0, callbacks: 0 };
    let next = 0, current = null;
    function element(values = {}) {
        const state = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100, ...values };
        const el = {
            isConnected: true, parentElement: null, children: [], overflowY: 'visible',
            getAttribute: () => 'true',
            contains(n) { for (; n; n = n.parentElement) if (n === el) return true; return false; },
            closest(selector) { return selector.startsWith('[data-testid=') ? current?.contains(el) ? current : null : null; },
            querySelector: () => el.sizer || null,
        };
        for (const key of ['scrollTop', 'scrollHeight', 'clientHeight']) Object.defineProperty(el, key, {
            get() { counts.reads++; return state[key]; },
            set(value) { if (key === 'scrollTop') counts.writes++; state[key] = value; },
        });
        return el;
    }
    const scroller = current = element();
    scroller.sizer = withSizer ? { parentElement: scroller, isConnected: true } : null;
    scroller.children = scroller.sizer ? [scroller.sizer] : [];
    const document = { querySelector: () => current, hidden: false };
    class Observer {
        constructor(fn, list) { this.fn = fn; this.nodes = new Map(); list.push(this); }
        observe(n, opts) { this.nodes.set(n, opts); }
        unobserve(n) { this.nodes.delete(n); }
        disconnect() { this.nodes.clear(); }
    }
    const ctx = {
        track: (target, type, fn, opts) => {
            const entry = { target, type, fn, opts }; listeners.push(entry);
            disposers.push(() => listeners.splice(listeners.indexOf(entry), 1));
        },
        every: (ms, fn) => { intervals.push(fn); disposers.push(() => intervals.splice(intervals.indexOf(fn), 1)); },
        observe: (target, opts, fn) => {
            const observer = new Observer(fn, mutations); observer.observe(target, opts);
            disposers.push(() => observer.disconnect()); return observer;
        },
        onDispose: fn => disposers.push(fn),
    };
    const scope = {
        document, ctx, cuimod: {},
        location: { pathname: '/epitaxy/local_test' },
        ResizeObserver: class extends Observer { constructor(fn) { super(fn, resizes); } },
        getComputedStyle: n => ({ overflowY: n.overflowY || 'visible', lineHeight: '20' }),
        requestAnimationFrame: fn => { frames.set(++next, fn); return next; },
        cancelAnimationFrame: id => frames.delete(id),
    };
    vm.runInNewContext(source, scope, { filename: file });
    function frame() {
        const batch = [...frames.values()]; frames.clear();
        for (const fn of batch) { counts.callbacks++; fn(); }
    }
    function resize(target = current?.sizer || current) {
        for (const observer of resizes) if (observer.nodes.has(target)) observer.fn([{ target }]);
    }
    function mutate(target = current) {
        for (const observer of mutations) if (observer.nodes.has(target)) observer.fn([{ target, type: 'childList' }]);
    }
    function event(type, extra = {}) {
        const e = { target: current, deltaX: 0, deltaY: 0, deltaMode: 0,
            cancelable: true, ctrlKey: false, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; },
            stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.stopped = true; }, ...extra };
        for (const l of [...listeners]) if (l.type === type) l.fn(e);
        return e;
    }
    function grow(amount) { current.scrollHeight += amount; resize(); }
    function settle() { resize(current); resize(); frame(); frame(); }
    function resetCounts() { for (const k of Object.keys(counts)) counts[k] = 0; }
    return { scroller, frame, event, grow, resize, mutate, settle, resetCounts, counts, frames, scope, resizes, mutations,
        interval: () => [...intervals].forEach(fn => fn()), element,
        replace: el => { current = el; },
        dispose: () => [...disposers].reverse().forEach(fn => fn()),
    };
}
let failed = 0, passed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + ': ' + e.message); }
}
check('unchanged busy transcript uses zero settled frames and geometry reads', () => {
    const h = setup(); h.settle(); h.resetCounts();
    for (let i = 0; i < 120; i++) { if (i % 15 === 0) h.interval(); h.frame(); }
    const actual = { ...h.counts, queued: h.frames.size }; h.dispose();
    console.log('IDLE_COUNTS ' + JSON.stringify(actual));
    assert.deepEqual(actual, { reads: 0, writes: 0, callbacks: 0, queued: 0 });
});
check('rapid growth stays at the tail even beyond the near-bottom band', () => {
    const h = setup(); h.grow(600); h.frame();
    assert.equal(h.scroller.scrollTop, 1500); h.dispose();
});
check('freewheel burst cancels compositor movement and coalesces one frame', () => {
    const h = setup(); h.scroller.scrollTop = 300;
    for (let i = 0; i < 100; i++) assert.equal(h.event('wheel', { deltaY: 0.5 }).prevented, true);
    assert.equal(h.frames.size, 1); assert.equal(h.scroller.scrollTop, 300); h.frame();
    assert.equal(h.scroller.scrollTop, 350); h.dispose();
});
check('upward input releases follow before growth and remains released', () => {
    const h = setup(); h.event('wheel', { deltaY: -80 }); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 820); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 820); h.dispose();
});
check('scrolling down to the tail resumes growth follow', () => {
    const h = setup(); h.event('wheel', { deltaY: -80 }); h.frame();
    h.event('wheel', { deltaY: 100 }); h.frame(); h.grow(400); h.frame();
    assert.equal(h.scroller.scrollTop, 1300); h.dispose();
});
check('zoom and horizontal wheel remain native; disposal cancels frames', () => {
    const h = setup(); assert.equal(h.event('wheel', { ctrlKey: true, deltaY: 100 }).prevented, false);
    assert.equal(h.event('wheel', { deltaX: 200, deltaY: 10 }).prevented, false);
    h.dispose(); assert.equal(h.frames.size, 0);
});
check('noncancelable wheel stays native and vertical wheel propagates', () => {
    const h = setup(); assert.equal(h.event('wheel', { deltaY: -100, cancelable: false }).prevented, false);
    const e = h.event('wheel', { deltaY: -20 });
    assert.equal(e.prevented, true); assert.equal(e.stopped, false); h.dispose();
});
check('line and page wheel retain their scale', () => {
    const h = setup(); h.event('wheel', { deltaY: -2, deltaMode: 1 }); h.frame();
    assert.equal(h.scroller.scrollTop, 860);
    h.event('wheel', { deltaY: -2, deltaMode: 2 }); h.frame();
    assert.equal(h.scroller.scrollTop, 660); h.dispose();
});
check('nested overflow retains wheel until its directional boundary', () => {
    const h = setup(), nested = h.element({ scrollTop: 40, scrollHeight: 200, clientHeight: 100 });
    nested.parentElement = h.scroller; nested.overflowY = 'auto';
    assert.equal(h.event('wheel', { target: nested, deltaY: -20 }).prevented, false);
    nested.scrollTop = 0;
    assert.equal(h.event('wheel', { target: nested, deltaY: -20 }).prevented, true);
    h.frame(); assert.equal(h.scroller.scrollTop, 880); h.dispose();
});
check('manual scrollbar and touch input unpin before growth', () => {
    for (const extra of [{}, { target: null, pointerType: 'touch' }]) {
        const h = setup(); if (extra.target === null) extra.target = { closest: () => h.scroller };
        h.event('pointerdown', extra); h.scroller.scrollTop = 500; h.grow(500); h.frame();
        assert.equal(h.scroller.scrollTop, 500); h.dispose();
    }
});
check('navigation keys unpin but editing controls retain their native path', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
        const h = setup(); h.event('keydown', { key }); h.grow(500); h.frame();
        assert.equal(h.scroller.scrollTop, 900); h.dispose();
    }
    const h = setup(), input = { closest: s => s.startsWith('[data-testid=') ? h.scroller : input };
    h.event('keydown', { key: 'Home', target: input }); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1400); h.dispose();
});
check('clicking transcript buttons does not unpin follow', () => {
    const h = setup(), button = { closest: () => h.scroller };
    h.event('pointerdown', { target: button, pointerType: 'mouse' }); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1400); h.dispose();
});
check('native jump-to-bottom rearms follow after manual release', () => {
    const h = setup(); h.event('pointerdown'); h.scroller.scrollTop = 500; h.event('scroll');
    h.scroller.scrollTop = 900; h.event('scroll'); h.grow(600); h.frame();
    assert.equal(h.scroller.scrollTop, 1500); h.dispose();
});
check('viewport resize and image-driven extent growth keep the tail', () => {
    const h = setup(); h.settle(); h.scroller.clientHeight = 200; h.resize(h.scroller); h.frame();
    assert.equal(h.scroller.scrollTop, 800); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1300); h.dispose();
});
check('route replacement discards old pending wheel and latch', () => {
    const h = setup(); h.event('wheel', { deltaY: -50 });
    h.scope.location.pathname = '/epitaxy/local_other'; h.interval(); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1400); h.dispose();
});
check('scroller replacement releases old observers and pending movement', () => {
    const h = setup(), old = h.scroller;
    h.event('wheel', { deltaY: -50 }); old.isConnected = false;
    const next = h.element(); next.sizer = { parentElement: next, isConnected: true };
    h.replace(next); h.interval(); next.scrollHeight = 1500; h.resize(next.sizer); h.frame();
    assert.equal(next.scrollTop, 1400); assert.equal(old.scrollTop, 900);
    for (const ro of h.resizes) assert.equal(ro.nodes.has(old), false); h.dispose();
});
check('sizer replacement rebinds before new content grows', () => {
    const h = setup(); h.settle(); const old = h.scroller.sizer;
    h.scroller.sizer = { parentElement: h.scroller, isConnected: true }; old.isConnected = false;
    h.mutate(); h.grow(700); h.frame(); assert.equal(h.scroller.scrollTop, 1600);
    for (const ro of h.resizes) assert.equal(ro.nodes.has(old), false); h.dispose();
});
check('hidden-to-visible recovery retains follow intent', () => {
    const h = setup(); h.settle(); h.scope.document.hidden = true;
    h.grow(500); h.scope.document.hidden = false; h.event('visibilitychange'); h.frame();
    assert.equal(h.scroller.scrollTop, 1400); h.dispose();
});
check('initial missing-sizer fallback follows; delayed sizer arrival stops busy polling', () => {
    const h = setup({ withSizer: false }); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1400); assert.equal(h.frames.size, 1);
    h.scroller.sizer = { parentElement: h.scroller, isConnected: true }; h.mutate(); h.grow(500); h.frame();
    assert.equal(h.scroller.scrollTop, 1900);
    h.settle(); h.resetCounts();
    for (let i = 0; i < 30; i++) { if (i % 15 === 0) h.interval(); h.frame(); }
    const actual = { ...h.counts, queued: h.frames.size }; h.dispose();
    console.log('DELAYED_SIZER_COUNTS ' + JSON.stringify(actual));
    assert.deepEqual(actual, { reads: 0, writes: 0, callbacks: 0, queued: 0 });
});
check('detached old scroller resize delivery never writes the replacement', () => {
    const h = setup(), old = h.scroller; h.settle(); old.isConnected = false;
    const next = h.element(); next.sizer = { parentElement: next, isConnected: true };
    h.replace(next); h.interval(); next.scrollHeight = 1500; h.resetCounts();
    for (const observer of h.resizes) observer.fn([{ target: old }]);
    assert.equal(h.counts.writes, 0); assert.equal(next.scrollTop, 900);
    h.resize(next.sizer); h.frame(); assert.equal(next.scrollTop, 1400); h.dispose();
});
check('unpinned resize does not read geometry or rearm follow', () => {
    const h = setup(); h.event('wheel', { deltaY: -50 }); h.frame(); h.resetCounts();
    h.resize(); h.resize(h.scroller); h.frame();
    assert.deepEqual(h.counts, { reads: 0, writes: 0, callbacks: 0 }); h.dispose();
});
check('native anchor drift is corrected while plugin follow is still latched', () => {
    const h = setup(); h.settle(); h.scroller.scrollTop = 850; h.event('scroll'); h.frame();
    assert.equal(h.scroller.scrollTop, 900); h.dispose();
});
check('disposal releases resize/mutation observers and queued callbacks', () => {
    const h = setup(); h.dispose();
    assert.equal(h.frames.size, 0);
    for (const observer of [...h.resizes, ...h.mutations]) assert.equal(observer.nodes.size, 0);
    h.resetCounts(); h.resize(); h.mutate(); h.interval(); h.frame();
    assert.deepEqual(h.counts, { reads: 0, writes: 0, callbacks: 0 });
});
console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
