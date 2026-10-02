import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizePromptPolicySettings } from './prompt-policy.mjs';

export const PROVIDER_DEFAULTS = Object.freeze({
    reasoningEnabled: true,
    reasoningSummary: 'auto',
    showReasoningText: false,
    logUpstreamIdentity: true,
    animateTabs: true,
});

export const COMPACTION_DEFAULTS = Object.freeze({
    strategy: 'codex',
    portableFallback: true,
    model: 'current',
});

const settingsFile = () => process.env.MODEL_ROUTER_SETTINGS_FILE
    || fileURLToPath(new URL('../.state/settings.json', import.meta.url));

function readDashboardSettings()
{
    try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '')); }
    catch (_) { return {}; }
}

// The dashboard remains the only settings store. Read it at request start, so
// a settings change neither requires a restart nor alters an in-flight stream.
export function readProviderSettings() {
    const saved = readDashboardSettings()['provider-picker'];
    return {
        reasoningEnabled: typeof saved?.reasoningEnabled === 'boolean' ? saved.reasoningEnabled : PROVIDER_DEFAULTS.reasoningEnabled,
        reasoningSummary: ['auto', 'detailed', 'off'].includes(saved?.reasoningSummary) ? saved.reasoningSummary : PROVIDER_DEFAULTS.reasoningSummary,
        showReasoningText: saved?.showReasoningText === true,
        logUpstreamIdentity: saved?.logUpstreamIdentity !== false,
        animateTabs: saved?.animateTabs !== false,
        ...normalizePromptPolicySettings(saved),
    };
}

export function readCompactionSettings()
{
    const saved = readDashboardSettings()['compaction-provider'];
    return {
        strategy: ['native', 'codex'].includes(saved?.strategy) ? saved.strategy : COMPACTION_DEFAULTS.strategy,
        portableFallback: saved?.portableFallback !== false,
        model: typeof saved?.model === 'string' && (saved.model === 'current' || /^gpt-[a-z0-9.-]+$/.test(saved.model))
            ? saved.model : COMPACTION_DEFAULTS.model,
    };
}

export const CONTEXT_DEFAULTS = Object.freeze({
    enabled: false,
    notesTools: true,
    historyTools: false,
    reminders: true,
    windowReset: false,
    truncationBytes: 10000,
});

// Split deliberately rather than shipped as one switch.
//
// `notesTools` is additive: the model gains a scratchpad and nothing else about
// the turn changes. `windowReset` changes what this router sends upstream, so it
// is a separate, deliberate yes.
//
// `historyTools` is one switch for two things, because neither half is useful
// alone: it asks the backend to ingest and index this thread, and it exposes the
// four tools that search the index. Notes are what the model chose to write;
// history is the whole transcript, on OpenAI's servers, so it is off by default
// and stated plainly in the dashboard.
export function readContextSettings()
{
    const saved = readDashboardSettings()['context-management'];
    const bytes = Number(saved?.truncationBytes);
    return {
        enabled: saved?.enabled === true,
        notesTools: saved?.notesTools !== false,
        historyTools: saved?.historyTools === true,
        reminders: saved?.reminders !== false,
        windowReset: saved?.windowReset === true,
        truncationBytes: Number.isFinite(bytes) && bytes >= 1000 && bytes <= 100000
            ? Math.round(bytes) : CONTEXT_DEFAULTS.truncationBytes,
    };
}

function bareModel(value)
{
    return String(value || '').trim().toLowerCase()
        .replace(/\[[^\]]*\]$/, '')
        .replace(/:(low|medium|high|xhigh|max)$/, '')
        .replace(/^claude-/, '');
}

function configuredWindow(value)
{
    const number = Number(value);
    return Number.isFinite(number) && number >= 100000 && number <= 1000000
        ? Math.round(number) : null;
}

// This is the launch/live policy the Claude Code worker resolves, not a model
// limit. Context management needs it because Codex budgets against the earlier
// of the client's auto-compact scope and the provider's full context window.
export function readAutoCompactBudget(model, sessionId)
{
    const saved = readDashboardSettings()['auto-compact'];
    const overrides = saved?.sessionOverrides && typeof saved.sessionOverrides === 'object'
        && !Array.isArray(saved.sessionOverrides) ? saved.sessionOverrides : {};
    const override = typeof sessionId === 'string' ? overrides[sessionId] : null;
    const enabled = typeof override?.enabled === 'boolean' ? override.enabled : saved?.enabled === true;
    const perModel = saved?.perModel && typeof saved.perModel === 'object' && !Array.isArray(saved.perModel)
        ? saved.perModel : {};
    const sessionWindow = configuredWindow(override?.window);
    const modelWindow = configuredWindow(perModel[bareModel(model)]);
    const defaultWindow = configuredWindow(saved?.defaultWindow);
    return {
        enabled,
        window: sessionWindow ?? modelWindow ?? defaultWindow,
        source: sessionWindow !== null ? 'session' : modelWindow !== null ? 'model' : defaultWindow !== null ? 'default' : 'auto',
    };
}
