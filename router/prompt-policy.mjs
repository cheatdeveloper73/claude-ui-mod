// Prompt policies are local request transforms for every Messages route. The
// active default or session binding is resolved from hot settings on each request
// so an approved edit takes effect without patching or restarting Claude Code.

export const PRESERVE_POLICY_ID = 'preserve';
const MAX_PROFILES = 32;
const MAX_HISTORY = 128;
const MAX_SESSION_BINDINGS = 256;
const MAX_PROVIDERS = 8;
const MAX_TEXT = 100000;

const modes = new Set(['preserve', 'append', 'replace']);
const text = (value) => typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
const id = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : null;
const providerId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value) ? value.toLowerCase() : null;
const generation = (value) => Number.isSafeInteger(value) && value > 0 ? value : 1;

export function preservePolicy()
{
    return {
        id: PRESERVE_POLICY_ID,
        name: 'Preserve',
        generation: 1,
        enabled: false,
        providers: [],
        systemMode: 'preserve',
        systemText: '',
        userPrefix: '',
        userSuffix: '',
        toolDescriptionPrefix: '',
        toolDescriptionSuffix: '',
    };
}

export function normalizePolicy(value)
{
    const profileId = id(value?.id);
    if (!profileId || profileId === PRESERVE_POLICY_ID) return preservePolicy();
    const systemText = text(value?.systemText);
    let systemMode = modes.has(value?.systemMode) ? value.systemMode : 'preserve';
    if (systemMode === 'replace' && !systemText.trim()) systemMode = 'preserve';
    const providers = [];
    for (const provider of Array.isArray(value?.providers) ? value.providers : [])
    {
        const scope = providerId(provider);
        if (!scope || providers.includes(scope)) continue;
        providers.push(scope);
        if (providers.length >= MAX_PROVIDERS) break;
    }
    return {
        id: profileId,
        name: text(value?.name).trim().slice(0, 80) || profileId,
        generation: generation(value?.generation),
        enabled: value?.enabled !== false,
        providers,
        systemMode,
        systemText,
        userPrefix: text(value?.userPrefix),
        userSuffix: text(value?.userSuffix),
        toolDescriptionPrefix: text(value?.toolDescriptionPrefix),
        toolDescriptionSuffix: text(value?.toolDescriptionSuffix),
    };
}

function distinctProfiles(values)
{
    const seen = new Set([PRESERVE_POLICY_ID]);
    const profiles = [preservePolicy()];
    for (const value of Array.isArray(values) ? values : [])
    {
        const profile = normalizePolicy(value);
        if (profile.id === PRESERVE_POLICY_ID || seen.has(profile.id)) continue;
        seen.add(profile.id);
        profiles.push(profile);
        if (profiles.length >= MAX_PROFILES + 1) break;
    }
    return profiles;
}

export function normalizePromptPolicySettings(value)
{
    const profiles = distinctProfiles(value?.promptPolicies);
    const profileKeys = new Set(profiles.map((profile) => `${profile.id}:${profile.generation}`));
    const history = [];
    const seen = new Set(profileKeys);

    for (const entry of Array.isArray(value?.promptPolicyVersions) ? value.promptPolicyVersions : [])
    {
        const profile = normalizePolicy(entry);
        const key = `${profile.id}:${profile.generation}`;
        if (profile.id === PRESERVE_POLICY_ID || seen.has(key)) continue;
        seen.add(key);
        history.push(profile);
        if (history.length >= MAX_HISTORY) break;
    }

    const requested = id(value?.activePromptPolicyId);
    const activePromptPolicyId = profiles.some((profile) => profile.id === requested)
        ? requested
        : PRESERVE_POLICY_ID;
    const activePromptPolicyIds = {};
    const activeByProvider = value?.activePromptPolicyIds;
    if (activeByProvider && typeof activeByProvider === 'object' && !Array.isArray(activeByProvider))
    {
        let count = 0;
        for (const [provider, profileId] of Object.entries(activeByProvider))
        {
            const scope = providerId(provider);
            if (!scope || !profiles.some((profile) => profile.id === profileId)) continue;
            activePromptPolicyIds[scope] = profileId;
            if (++count >= MAX_PROVIDERS) break;
        }
    }
    const promptPolicySessionBindings = {};
    const bindings = value?.promptPolicySessionBindings;
    if (bindings && typeof bindings === 'object' && !Array.isArray(bindings))
    {
        let count = 0;
        for (const [sessionId, profileId] of Object.entries(bindings))
        {
            if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !profiles.some((profile) => profile.id === profileId)) continue;
            promptPolicySessionBindings[sessionId] = profileId;
            if (++count >= MAX_SESSION_BINDINGS) break;
        }
    }

    return { promptPolicies: profiles, promptPolicyVersions: history, activePromptPolicyId, activePromptPolicyIds, promptPolicySessionBindings };
}

export function isPromptPolicyRequest(body)
{
    return Array.isArray(body?.tools) && body.tools.length > 0;
}

export function resolvePromptPolicy(body, provider, settings, sessionId)
{
    if (!isPromptPolicyRequest(body))
    {
        const profile = preservePolicy();
        return { profile, id: profile.id, generation: profile.generation, requestKind: 'control' };
    }

    const normalized = normalizePromptPolicySettings(settings);
    const scope = providerId(provider);
    const selectedId = typeof sessionId === 'string' && normalized.promptPolicySessionBindings[sessionId]
        ? normalized.promptPolicySessionBindings[sessionId]
        : (scope && normalized.activePromptPolicyIds[scope]) || normalized.activePromptPolicyId;
    let profile = normalized.promptPolicies.find((value) => value.id === selectedId) || preservePolicy();
    if (profile.providers.length && (!scope || !profile.providers.includes(scope))) profile = preservePolicy();

    return {
        profile,
        id: profile.id,
        generation: profile.generation,
        requestKind: 'agent',
    };
}

function cloneContent(content)
{
    if (Array.isArray(content)) return content.slice();
    return [{ type: 'text', text: String(content ?? '') }];
}

function hasDirectText(content)
{
    if (typeof content === 'string') return true;
    return Array.isArray(content) && content.some((block) => block?.type === 'text');
}

function appendSystem(system, addition)
{
    if (!addition) return system;
    if (Array.isArray(system)) return system.concat([{ type: 'text', text: addition }]);
    if (!system) return addition;
    return `${system}\n\n${addition}`;
}

function changeSystem(system, profile)
{
    if (profile.systemMode === 'replace') return profile.systemText;
    if (profile.systemMode === 'append') return appendSystem(system, profile.systemText);
    return system;
}

export function policyChangesCachePrefix(profile)
{
    if (!profile?.enabled) return false;
    return profile.systemMode === 'replace'
        || (profile.systemMode === 'append' && !!profile.systemText)
        || !!profile.toolDescriptionPrefix
        || !!profile.toolDescriptionSuffix;
}

export function applyPromptPolicy(body, selection)
{
    const profile = selection?.profile || selection;
    if (!profile?.enabled) return body;

    const systemChanges = profile.systemMode === 'replace' || (profile.systemMode === 'append' && !!profile.systemText);
    const userChanges = !!profile.userPrefix || !!profile.userSuffix;
    const toolChanges = !!profile.toolDescriptionPrefix || !!profile.toolDescriptionSuffix;
    if (!systemChanges && !userChanges && !toolChanges) return body;

    const out = { ...body };
    if (systemChanges) {
        const system = changeSystem(body.system, profile);
        if (profile.systemMode === 'replace' && !system) delete out.system;
        else out.system = system;
    }

    if (userChanges && Array.isArray(body.messages))
    {
        let target = -1;
        for (let index = body.messages.length - 1; index >= 0; index--)
        {
            const message = body.messages[index];
            if (message?.role === 'user' && hasDirectText(message.content)) { target = index; break; }
        }
        if (target !== -1)
        {
            const messages = body.messages.slice();
            const content = cloneContent(messages[target].content);
            if (profile.userPrefix) content.unshift({ type: 'text', text: profile.userPrefix });
            if (profile.userSuffix) content.push({ type: 'text', text: profile.userSuffix });
            messages[target] = { ...messages[target], content };
            out.messages = messages;
        }
    }

    if (toolChanges && Array.isArray(body.tools))
    {
        out.tools = body.tools.map((tool) => tool && typeof tool === 'object'
            ? { ...tool, description: profile.toolDescriptionPrefix + String(tool.description || '') + profile.toolDescriptionSuffix }
            : tool);
    }

    return out;
}

export function promptPolicyHeaders(selection)
{
    return {
        'X-Cuimod-Prompt-Policy-Id': selection.id,
        'X-Cuimod-Prompt-Policy-Generation': String(selection.generation),
    };
}
