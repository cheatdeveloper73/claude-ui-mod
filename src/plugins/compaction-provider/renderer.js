/* claude-ui-mod :: compaction-provider (renderer)
 *
 * Dashboard controls for GPT checkpoint compaction. Claude, Gemini and other
 * providers remain on Claude Code's native compaction path.
 */
'use strict';

const DEF = { strategy: 'codex', portableFallback: true, model: 'current' };
let V = { ...DEF };
let statusNode = null;
let statusBody = null;
let statusBusy = false;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function statusCard() {
    if (statusNode) return statusNode;
    statusNode = el('div', 'cc-card');
    const style = document.createElement('style');
    style.textContent = `
.cc-card { border-radius:10px; padding:12px 13px; background:color-mix(in srgb,hsl(var(--text-100)) 5%,transparent);
    border:1px solid color-mix(in srgb,hsl(var(--text-100)) 9%,transparent); color:hsl(var(--text-200)); }
.cc-top { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; }
.cc-dot { width:7px; height:7px; border-radius:50%; background:#7cbd8b; box-shadow:0 0 0 3px color-mix(in srgb,#7cbd8b 18%,transparent); }
.cc-grid { display:grid; grid-template-columns:max-content 1fr; gap:5px 12px; margin-top:11px; font-size:11px; }
.cc-grid .k { color:hsl(var(--text-500)); }
.cc-grid .v { color:hsl(var(--text-300)); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cc-empty { margin-top:9px; font-size:11px; line-height:1.45; color:hsl(var(--text-500)); }
`;
    const top = el('div', 'cc-top');
    top.append(el('span', 'cc-dot'), el('span', null, 'Codex checkpoint channel'));
    statusBody = el('div', 'cc-empty', 'Reading router status…');
    statusNode.append(style, top, statusBody);
    return statusNode;
}

function row(grid, key, value) {
    grid.append(el('div', 'k', key), el('div', 'v', value));
}

async function refreshStatus() {
    if (statusBusy || !statusBody) return;
    statusBusy = true;
    try {
        const value = await cuimod.rpc('compaction-provider.status', { sessionId: cuimod.sessionId });
        const latest = value?.checkpoints?.latest;
        statusBody.className = latest ? 'cc-grid' : 'cc-empty';
        statusBody.textContent = '';
        if (!latest) {
            statusBody.textContent = cuimod.sessionId
                ? 'No Codex checkpoint exists for this session yet.'
                : 'Open a Code session to see its checkpoint state.';
            return;
        }
        row(statusBody, 'Created', new Date(latest.createdAt).toLocaleString());
        row(statusBody, 'Model', latest.sourceModel || 'unknown');
        row(statusBody, 'Retained items', String(latest.retainedItems));
        row(statusBody, 'Encrypted state', Number(latest.encryptedBytes || 0).toLocaleString() + ' bytes');
        row(statusBody, 'Portable fallback', Number(latest.fallbackCharacters || 0).toLocaleString() + ' characters');
    } catch (_) {
        statusBody.className = 'cc-empty';
        statusBody.textContent = 'Router status is temporarily unavailable.';
    } finally { statusBusy = false; }
}

const spec = {
    plugin: 'compaction-provider',
    title: 'Context compaction',
    description: 'Native Codex checkpoints for GPT sessions. Other providers keep Claude Code compaction.',
    defaults: DEF,
    immediateSave: true,
    controls: [
        { key: 'strategy', type: 'combo', label: 'GPT compaction', group: 'Provider',
          hint: 'Codex V2 replaces Claude Code’s text-only summary for GPT sessions.',
          options: [
              { value: 'codex', label: 'Codex V2' },
              { value: 'native', label: 'Claude Code native' },
          ] },
        { key: 'model', type: 'combo', label: 'Compaction model', group: 'Provider',
          hint: 'Current preserves the session model. A fixed model isolates compaction quality from session choice.',
          options: [
              { value: 'current', label: 'Current GPT model' },
              { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
              { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
          ] },
        { key: 'portableFallback', type: 'toggle', label: 'Portable fallback', group: 'Continuity',
          hint: 'Stores a readable handoff beside the encrypted checkpoint so switching to Claude or Gemini remains safe.' },
        { key: 'checkpointStatus', type: 'custom', label: 'Current session', group: 'Checkpoint', wide: true,
          node: statusCard },
    ],
    apply(values) {
        V = { ...DEF, ...(values || {}) };
        refreshStatus();
    },
};

const REG = (globalThis.__cuimodReg || (globalThis.__cuimodReg = { specs: new Map(), subs: new Set() }));
REG.specs.set(spec.plugin, spec);
REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
ctx.onDispose(() => {
    REG.specs.delete(spec.plugin);
    REG.subs.forEach(fn => { try { fn(); } catch (_) {} });
});

cuimod.onSessionChange(refreshStatus);
ctx.every(3000, refreshStatus);
