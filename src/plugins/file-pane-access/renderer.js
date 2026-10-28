'use strict';

const REGION = '[data-epitaxy-transcript-region]';
const ROW = '[data-testid="transcript-row"]';
const SESSION = /^\/epitaxy\/(local_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg']);
const READ_IMAGE = cuimod.eipc('claude.web', 'LocalSessions', 'readSessionImageAsDataUrl');

let disposed = false;
let screenPath = location.pathname;
let screenEpoch = 0;
let states = new WeakMap();
const regions = new Map();
const owned = new Set();

function screenSession() {
    const match = SESSION.exec(screenPath);
    return match ? match[1] : null;
}

function clearOwned() {
    for (const host of owned) {
        try { host.remove(); } catch (_) {}
    }
    owned.clear();
}

function syncRoute() {
    if (screenPath === location.pathname) return false;
    screenPath = location.pathname;
    screenEpoch++;
    states = new WeakMap();
    clearOwned();
    return true;
}

function imagePath(card, row) {
    const filePath = card.getAttribute('title');
    if (typeof filePath !== 'string' || !/^[a-z]:[\\/]/i.test(filePath)
        || /[\x00-\x1f]/.test(filePath) || filePath.slice(2).includes(':')) return null;
    const name = filePath.split(/[\\/]/).pop();
    const dot = name.lastIndexOf('.');
    if (dot < 1 || !IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())) return null;
    const label = card.querySelector('bdi');
    if (!label || label.textContent.trim() !== name) return null;

    // SendUserFile renders a Sent row followed by this titled attachment card.
    const status = card.parentElement?.previousElementSibling;
    if (status?.innerText?.trim() !== 'Sent') return null;
    if (row.querySelectorAll('img').length) return null;
    return { filePath, name };
}

function mount(card, row, filePath, name, dataUrl, owner) {
    if (disposed || owner.epoch !== screenEpoch || owner.path !== screenPath
        || !card.isConnected || !row.isConnected || card.getAttribute('title') !== filePath) return;
    if (typeof dataUrl !== 'string' || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(dataUrl)) return;
    if (row.querySelectorAll('img').length) return;
    const parent = card.parentElement;
    if (!parent || !parent.isConnected) return;

    const host = document.createElement('div');
    host.setAttribute('data-cuimod-inline-image', '');
    host.style.cssText = 'flex:0 0 100%;max-width:100%;';
    const image = document.createElement('img');
    image.alt = name;
    image.src = dataUrl;
    image.style.cssText = 'display:block;width:100%;max-width:100%;height:auto;max-height:none;object-fit:contain;';
    host.appendChild(image);
    parent.appendChild(host);
    owned.add(host);
}

function readCard(card, row, sessionId, info) {
    const previous = states.get(card);
    if (previous?.filePath === info.filePath && previous.epoch === screenEpoch) return;
    const owner = { epoch: screenEpoch, path: screenPath };
    states.set(card, { filePath: info.filePath, epoch: screenEpoch, pending: true });
    Promise.resolve().then(() => cuimod.appInvoke(READ_IMAGE, sessionId, info.filePath, true, { automatic: true }))
        .then(dataUrl => {
            if (disposed || owner.epoch !== screenEpoch || owner.path !== screenPath
                || !card.isConnected || card.getAttribute('title') !== info.filePath) return;
            const state = states.get(card);
            if (!state || state.filePath !== info.filePath || state.epoch !== owner.epoch) return;
            state.pending = false;
            state.failed = typeof dataUrl !== 'string';
            mount(card, row, info.filePath, info.name, dataUrl, owner);
        })
        .catch(() => {
            const state = states.get(card);
            if (state?.filePath === info.filePath && state.epoch === owner.epoch) {
                state.pending = false;
                state.failed = true;
            }
        });
}

function scan() {
    if (disposed) return;
    syncRoute();
    const sessionId = screenSession();
    if (!sessionId) return;
    for (const region of document.querySelectorAll(REGION)) {
        for (const row of region.querySelectorAll(ROW)) {
            for (const card of row.querySelectorAll('button[title]')) {
                const info = imagePath(card, row);
                if (info) readCard(card, row, sessionId, info);
            }
        }
    }
}

function attachRegions() {
    for (const [region, observer] of regions) {
        if (region.isConnected) continue;
        observer.disconnect();
        regions.delete(region);
    }
    for (const region of document.querySelectorAll(REGION)) {
        if (regions.has(region)) continue;
        regions.set(region, ctx.observe(region, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['title'],
        }, scan));
        scan();
    }
}

function onNavigation() {
    if (syncRoute()) scan();
}

ctx.track(window, 'popstate', onNavigation);
ctx.track(document, 'visibilitychange', () => { if (!document.hidden) scan(); });
ctx.every(500, onNavigation);
ctx.every(1000, attachRegions);
ctx.onDispose(() => {
    disposed = true;
    clearOwned();
    regions.clear();
});

attachRegions();
scan();
