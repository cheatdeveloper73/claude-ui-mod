// fast-mode.mjs -- the session's own fast switch, read per request.
//
// Claude Code reads fast mode once per turn: a switch flipped while a turn runs
// reaches the next turn, not the next request (measured on CLI 2.1.284 with a
// two-call turn; the call after the flip still went standard). The Desktop
// fast-mode plugin records each session's switch in .state/fast-mode.json,
// indexed by the Claude Code session id this router sees in
// x-claude-code-session-id, so the OpenAI arm can follow the switch on the
// very next request instead.
//
// The switch is the orchestrator's alone. A subagent inherits the parent's
// fast flag in the CLI (measured: a fast parent's GPT and Opus subagents both
// sent speed:"fast"), which ties the two together. So a subagent's
// body.speed is ignored, and it runs priority only when its launch prompt
// opens with a line reading #fast. The marker is found in every request that
// agent makes, because its first message is always the launch prompt: three
// <system-reminder> blocks, then the prompt as its own text block (CLI
// 2.1.284). It is stripped before the model sees it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stateFile = () => process.env.MODEL_ROUTER_FAST_MODE_FILE
    || fileURLToPath(new URL('../.state/fast-mode.json', import.meta.url));
const cacheFile = () => process.env.CODEX_MODELS_CACHE
    || path.join(os.homedir(), '.codex', 'models_cache.json');

// The models cache is ~400 KB, so it is parsed again only when it changes.
let slugs = { key: null, value: new Set() };
function priorityModels()
{
    try
    {
        const stat = fs.statSync(cacheFile());
        const key = `${stat.size}:${stat.mtimeMs}`;
        if (slugs.key === key) return slugs.value;
        const models = JSON.parse(fs.readFileSync(cacheFile(), 'utf8').replace(/^\uFEFF/, '')).models;
        const value = new Set((Array.isArray(models) ? models : [])
            .filter(m => typeof m?.slug === 'string' && Array.isArray(m.service_tiers) && m.service_tiers.some(t => t?.id === 'priority'))
            .map(m => m.slug.toLowerCase()));
        slugs = { key, value };
        return value;
    }
    catch (_) { return slugs.value; }
}

function sessionSwitch(sessionId)
{
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    try
    {
        const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).cli?.[sessionId.toLowerCase()];
        return typeof value === 'boolean' ? value : undefined;
    }
    catch (_) { return undefined; }
}

const MARKER = /^#fast[ \t]*(?:\r?\n|$)/;

// The launch prompt's text block: the first one in the first user message
// that is not a <system-reminder>.
function promptBlock(body)
{
    const first = Array.isArray(body?.messages) ? body.messages[0] : null;
    if (first?.role !== 'user') return null;
    if (typeof first.content === 'string') return { index: -1, text: first.content };
    if (!Array.isArray(first.content)) return null;
    for (let index = 0; index < first.content.length; index++)
    {
        const block = first.content[index];
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        if (block.text.trimStart().startsWith('<system-reminder>')) continue;
        return { index, text: block.text };
    }
    return null;
}

export function hasFastMarker(body)
{
    const found = promptBlock(body);
    return !!found && MARKER.test(found.text.trimStart());
}

// The body the model should see: the marker line removed, nothing else moved.
export function stripFastMarker(body)
{
    const found = promptBlock(body);
    if (!found || !MARKER.test(found.text.trimStart())) return body;
    const text = found.text.trimStart().replace(MARKER, '');
    const first = body.messages[0];
    const content = found.index === -1 ? text
        : first.content.map((block, i) => (i === found.index ? { ...block, text } : block));
    return { ...body, messages: [{ ...first, content }, ...body.messages.slice(1)] };
}

// true: send the priority tier. `model` is the bare Codex slug.
export function fastTier({ body, model, sessionId, subagent })
{
    const priority = () => priorityModels().has(String(model).toLowerCase());
    if (subagent === true) return hasFastMarker(body) && priority();
    const set = sessionSwitch(sessionId);
    if (set === undefined) return body?.speed === 'fast';
    return set && priority();
}
