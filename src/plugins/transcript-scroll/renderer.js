/* claude-ui-mod :: transcript-scroll
 * Keep follow intent across token bursts. Wheel movement shares a frame with the
 * virtualizer instead of leaving Chromium's animated wheel target behind each
 * resize. Native listeners still receive the input and update their anchors.
 */
'use strict';

const SELECTOR = '[data-testid="epitaxy-virtual-transcript"]';
const SIZER = '[data-testid="transcript-sizer"]';
let node = null;
let sizer = null;
let route = null;
let following = false;
let pending = 0;
let frame = 0;
let disposed = false;

function atBottom() {
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
}
function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(tick);
}
function observeSizer() {
    const next = node?.querySelector(SIZER) || null;
    if (next === sizer) return;
    if (sizer) resize.unobserve(sizer);
    sizer = next;
    if (sizer) resize.observe(sizer, { box: 'border-box' });
}
function discover() {
    const next = document.querySelector(SELECTOR);
    const key = location.pathname;
    if (next === node && key === route) return;
    resize.disconnect();
    children.disconnect();
    node = next;
    sizer = null;
    route = key;
    pending = 0;
    following = !!node && atBottom();
    if (node) {
        resize.observe(node);
        observeSizer();
        children.observe(node, { childList: true });
    }
    if (following) schedule();
}
function follow() {
    // A moving target must not go through a smooth-scroll animation. Follow
    // is a latch, not a distance check after the content has already grown.
    const bottom = Math.max(0, node.scrollHeight - node.clientHeight);
    if (Math.abs(node.scrollTop - bottom) > 1) node.scrollTop = bottom;
}
function tick() {
    frame = 0;
    if (!node || !node.isConnected || disposed) return;
    if (pending) {
        node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + pending));
        pending = 0;
        following = atBottom();
    } else if (following) {
        follow();
    }
    // Keep the old fallback only while the native content extent is unavailable.
    if (following && !sizer && node.getAttribute('aria-busy') === 'true') schedule();
}
// The native sizer carries the virtualized extent. Resize delivery follows layout
// and precedes paint, so growth is corrected without a perpetual busy-frame read
// or a frame of lag. Pending wheel input still belongs to its single rAF write.
const resize = new ResizeObserver(entries => {
    if (disposed || document.hidden) return;
    discover();
    if (node?.isConnected && following && !pending
        && entries.some(e => e.target === node || e.target === sizer)) follow();
});
ctx.onDispose(() => resize.disconnect());
const children = ctx.observe(document, { childList: true }, () => {
    if (disposed) return;
    discover();
    observeSizer();
    if (following) schedule();
});
function transcript(e) {
    return e.target?.closest?.(SELECTOR) === node;
}
function nestedWheel(e) {
    for (let n = e.target; n && n !== node; n = n.parentElement) {
        if (n.scrollHeight <= n.clientHeight + 1) continue;
        const overflow = getComputedStyle(n).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll')
            && (e.deltaY > 0 ? n.scrollTop < n.scrollHeight - n.clientHeight - 1 : n.scrollTop > 0)) return true;
    }
    return false;
}
ctx.track(document, 'wheel', e => {
    discover();
    if (!node || !transcript(e) || e.ctrlKey || !e.cancelable
        || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || nestedWheel(e)) return;
    e.preventDefault();
    following = false;
    const scale = e.deltaMode === 2 ? node.clientHeight
        : e.deltaMode === 1 ? parseFloat(getComputedStyle(node).lineHeight) || 20 : 1;
    pending += e.deltaY * scale;
    schedule();
}, { capture: true, passive: false });
ctx.track(document, 'scroll', e => {
    if (e.target !== node || pending) return;
    if (atBottom()) following = true;
    if (following) schedule();
}, { capture: true, passive: true });
ctx.track(document, 'pointerdown', e => {
    if (!node || !transcript(e)) return;
    // The scrollbar and touch gestures belong to the user. Buttons/links in the
    // transcript retain native behavior and can still invoke jump-to-latest.
    if (e.target === node || e.pointerType === 'touch') following = false;
}, { capture: true, passive: true });
ctx.track(document, 'keydown', e => {
    if (!node || !transcript(e) || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) following = false;
}, { capture: true });
ctx.track(document, 'visibilitychange', () => {
    if (document.hidden) return;
    discover();
    if (following || pending) schedule();
});
ctx.every(250, () => {
    discover();
    if (following && !sizer) schedule();
});
ctx.onDispose(() => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
});
discover();
