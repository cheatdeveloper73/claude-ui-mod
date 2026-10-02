/* claude-ui-mod :: fast-mode (renderer)
 *
 * Puts the on-screen session's own fast value into the composer switch.
 *
 * The pinned switch reads one global `fastMode` from Desktop's epitaxyPrefs
 * bucket and re-renders when main broadcasts AppPreferences.preferencesChanged
 * (shared-common-5: pm() via onPreferencesChanged). Writing the bucket through
 * the same setPreference IPC the page uses is therefore enough to move the
 * switch without touching React. The URL's local_<uuid> is the authority for
 * which session is on screen.
 */
'use strict';
const GET = cuimod.eipc('claude.settings', 'AppPreferences', 'getPreferences');
const SET = cuimod.eipc('claude.settings', 'AppPreferences', 'setPreference');
const CHANGED = cuimod.eipc('claude.settings', 'AppPreferences', 'preferencesChanged');
const SESSION = /^\/epitaxy\/(local_[0-9a-f-]{36})(?:[/?#]|$)/i;
// A session's value can change without a view change: the session tool,
// Desktop's credits turn-off, or a worker's first report.
const RECHECK_MS = 3000;

let disposed = false;
let busy = false;
let view = null;
let lastSync = 0;
let draftSince = 0;

function currentView() {
    if (!location.pathname.startsWith('/epitaxy')) return null;
    const match = SESSION.exec(location.pathname);
    return match ? match[1] : 'draft';
}

async function sync() {
    const key = currentView();
    if (busy || disposed || key === null) return;
    busy = true;
    try {
        const want = key === 'draft'
            ? await cuimod.rpc('fast-mode.draft', {})
            : await cuimod.rpc('fast-mode.desired', { sessionId: key });
        if (disposed || key !== currentView()) return;
        if (typeof want === 'boolean') {
            const prefs = await cuimod.appInvoke(GET);
            const bucket = prefs?.epitaxyPrefs && typeof prefs.epitaxyPrefs === 'object' ? prefs.epitaxyPrefs : {};
            if (bucket.fastMode !== want && !disposed && key === currentView())
                await cuimod.appInvoke(SET, 'epitaxyPrefs', { ...bucket, fastMode: want });
        }
        if (key === 'draft' && view !== 'draft') draftSince = Date.now();
        view = key;
        lastSync = Date.now();
    } catch (err) {
        cuimod.log('fast-mode sync: ' + (err?.message || err));
    } finally { busy = false; }
}

// A switch flipped on the draft composer never reaches setFastMode: there is no
// session yet. Its only trace is the bucket write, so record that as the draft.
const unsubscribe = cuimod.appOn(CHANGED, (_event, prefs) => {
    const value = prefs?.epitaxyPrefs?.fastMode;
    if (disposed || busy || view !== 'draft' || currentView() !== 'draft' || typeof value !== 'boolean') return;
    if (Date.now() - draftSince < 500) return;
    cuimod.rpc('fast-mode.draft', { value }).catch(() => {});
});
ctx.onDispose(() => { disposed = true; unsubscribe?.(); });

ctx.every(250, () => {
    if (currentView() !== view || Date.now() - lastSync >= RECHECK_MS) sync();
});
sync();
