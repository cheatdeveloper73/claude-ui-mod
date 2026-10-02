/* claude-ui-mod :: waiting-label (renderer)
 *
 * Replaces the native loading status only while it says that it is waiting for
 * the model. React owns the row and can replace its text on every state change,
 * so the observer reapplies the label instead of taking ownership of the node.
 */
'use strict';

const NATIVE_LABEL = 'Waiting for Claude…';
const DEFAULTS = { enabled: true };
const ROW = 'div[data-perf-row="marker"]';

let enabled = DEFAULTS.enabled;
let modelLabel = null;
let nativeBusy = false;
let disposed = false;
const touched = new Set();
const records = new WeakMap();

function targetLabel() {
    const label = typeof modelLabel === 'string' ? modelLabel.trim() : '';
    return label ? 'Waiting for ' + label + '…' : null;
}

function forget(node) {
    records.delete(node);
    touched.delete(node);
}

function restoreTouched() {
    for (const node of [...touched]) {
        const record = records.get(node);
        if (!record) { touched.delete(node); continue; }
        if (node.isConnected && node.textContent === record.applied) node.textContent = record.original;
        forget(node);
    }
}

function rewrite() {
    const wanted = enabled ? targetLabel() : null;

    for (const node of [...touched]) {
        const record = records.get(node);
        if (!record) { touched.delete(node); continue; }
        if (!node.isConnected || node.textContent !== record.applied) {
            forget(node);
            continue;
        }
        if (!wanted) {
            node.textContent = record.original;
            forget(node);
        } else if (record.applied !== wanted) {
            record.applied = wanted;
            node.textContent = wanted;
        }
    }

    if (!wanted) return;
    for (const row of document.querySelectorAll(ROW)) {
        for (const node of row.querySelectorAll('span')) {
            if (node.children.length !== 0 || node.textContent !== NATIVE_LABEL) continue;
            records.set(node, { original: NATIVE_LABEL, applied: wanted });
            touched.add(node);
            node.textContent = wanted;
        }
    }
}

async function refreshModel() {
    if (disposed || !enabled || nativeBusy) return;
    nativeBusy = true;
    try {
        const value = await cuimod.rpc('waiting-label.native');
        if (disposed) return;
        const next = typeof value?.label === 'string' && value.label.trim()
            ? value.label.trim() : null;
        if (next === modelLabel) return;
        modelLabel = next;
        rewrite();
    } catch (_) {
        // The page can be between renderer generations while the app reloads.
    } finally {
        nativeBusy = false;
    }
}

const unsubscribe = cuimod.onSessionChange(() => {
    modelLabel = null;
    restoreTouched();
    refreshModel();
});
ctx.onDispose(() => {
    disposed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
    restoreTouched();
});

ctx.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
}, rewrite);
ctx.every(1000, () => { rewrite(); refreshModel(); });
refreshModel();

const REG = (globalThis.__cuimodReg ||= { specs: new Map(), subs: new Set() });
const spec = {
    plugin: 'waiting-label',
    title: 'Waiting label',
    description: 'Shows a compact main-session model name in the native loading status while a turn waits for inference.',
    defaults: DEFAULTS,
    immediateSave: true,
    controls: [
        { key: 'enabled', type: 'toggle', label: 'Show model in waiting status', group: 'Transcript',
          hint: 'Changes “Waiting for Claude…” to a compact model name, such as “Waiting for Sol…”, from the main session’s selected model.' },
    ],
    apply(values) {
        enabled = { ...DEFAULTS, ...values }.enabled !== false;
        if (!enabled) restoreTouched();
        else { rewrite(); refreshModel(); }
    },
};
REG.specs.set(spec.plugin, spec);
REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach((fn) => { try { fn(); } catch (_) {} });
});
if (!REG.subs.size) spec.apply(DEFAULTS);
