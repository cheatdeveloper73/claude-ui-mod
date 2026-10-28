// Exact GLM 5.3 prompt counts for Fireworks' Anthropic Messages endpoint.
//
// Same method as deepseek-v41.mjs: Fireworks has no count_tokens, but with
// raw_output it returns the prompt ids it built, and input_tokens +
// cache_read_input_tokens always equals their count. Fireworks feeds GLM's own
// chat_template.jinja; how an Anthropic body reaches that template is
// Fireworks' adapter. Every rule below was read off a raw_output capture;
// tests/glm-53-count.test.mjs replays them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isToolSearch, normalizeSchema, TOOL_USE_TOOL } from './deepseek-v41.mjs';

const TOKENIZER_FILE = process.env.MODEL_ROUTER_GLM53_TOKENIZER
    || fileURLToPath(new URL('../vendor/tokenizers/glm-5.3/tokenizer.json', import.meta.url));

// A prompt is a list of parts: control tokens the template itself writes, and
// text runs. Fireworks tokenizes text runs with no added-token matching, so
// "<think>" in a message is ordinary text and cannot open a turn.
const SPECIAL_IDS = {
    '[gMASK]': 154822, '<sop>': 154824, '<|system|>': 154826, '<|user|>': 154827,
    '<|assistant|>': 154828, '<|observation|>': 154829, '<think>': 154841, '</think>': 154842,
    '<tool_call>': 154843, '</tool_call>': 154844, '<tool_response>': 154845, '</tool_response>': 154846,
    '<arg_key>': 154847, '</arg_key>': 154848, '<arg_value>': 154849, '</arg_value>': 154850,
};

const TOOLS_HEAD = '\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n'
    + 'You are provided with function signatures within <tools></tools> XML tags:\n<tools>\n';
const TOOLS_TAIL = '\n</tools>\n\nFor each function call, output the function name and arguments within the following XML format:\n';

function badRequest(message)
{
    const error = new Error(message);
    error.status = 400;
    return error;
}

// Fireworks' ReasoningEffort enum, onto the template's three headers. An integer
// is accepted and ignored; a request that sets nothing gets Max. reasoning_effort
// wins over output_config.effort. GLM 5.3 is thinking-only: "none" or
// thinking disabled is a 400.
const EFFORTS = { minimal: 'Low', low: 'Low', medium: 'High', high: 'High', xhigh: 'Max', max: 'Max' };

export function glm53Effort(body)
{
    if (body.thinking?.type === 'disabled') throw badRequest('GLM-5.3 is a thinking-only model');
    const value = body.reasoning_effort !== undefined ? body.reasoning_effort : body.output_config?.effort;
    if (value === undefined || Number.isInteger(value)) return 'Max';
    if (value === 'none') throw badRequest('GLM-5.3 is a thinking-only model');
    const header = EFFORTS[value];
    if (!header) throw badRequest(`invalid reasoning effort ${JSON.stringify(value)}`);
    return header;
}

// Python float repr: shortest round-trip digits, exponent form outside
// [1e-4, 1e16) with a sign and at least two exponent digits.
function pyFloat(x)
{
    if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : x < 0 ? '-Infinity' : 'NaN';
    const abs = Math.abs(x);
    if (abs !== 0 && (abs < 1e-4 || abs >= 1e16))
    {
        const [mantissa, exp] = x.toExponential().split('e');
        const e = Number(exp);
        return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    }
    return Number.isInteger(x) ? `${x}.0` : String(x);
}

// Claude Code writes every number with JSON.stringify, so the literal Fireworks
// parses is String(x) for integers below 1e21.
const sentInteger = (x) => Number.isInteger(x) && Math.abs(x) < 1e21;

// Tool-call arguments reach the template as Python objects with unbounded ints.
const argNumber = (x) => sentInteger(x) ? String(x) : pyFloat(x);

// Tool schemas pass through serde_json first: an integer literal that fits i64
// or u64 stays an int, anything else becomes a float.
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;
function schemaNumber(x)
{
    if (sentInteger(x))
    {
        const n = BigInt(String(x));
        if (n >= I64_MIN && n <= U64_MAX) return String(x);
    }
    return pyFloat(x);
}

// json.dumps(ensure_ascii=False) with Python's default separators.
function pyJson(value, number)
{
    const walk = (v) => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return number(v);
        if (typeof v === 'string') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(walk).join(', ') + ']';
        return '{' + Object.keys(v).filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ': ' + walk(v[k])).join(', ') + '}';
    };
    return walk(value);
}

// A tool_reference is compact, key-sorted JSON built from the request's own
// literals: numbers as sent and the schema before any rewrite.
function compactSorted(v)
{
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(compactSorted).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + compactSorted(v[k])).join(',') + '}';
}

// Python str.strip(): str.isspace() whitespace, which differs from JS trim() at
// \x1c-\x1f, \x85 and ﻿.
const PY_SPACE = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const pyStrip = (s) => s.replace(PY_STRIP, '');

// Fireworks lists every tool except the deferred ones when a tool search tool
// is present, then appends its own dispatcher. A missing description is null.
function toolPlan(tools)
{
    const all = Array.isArray(tools) ? tools : [];
    const deferredMode = all.some(isToolSearch) && all.some(t => t?.defer_loading === true);
    const deferred = new Set(deferredMode ? all.filter(t => t?.defer_loading === true).map(t => t.name) : []);
    const byName = new Map(all.map(t => [t?.name, t]));
    const listed = all.filter(t => !deferred.has(t?.name)).map(t => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : null,
        parameters: normalizeSchema(t.input_schema)[0],
    }));
    if (deferredMode) listed.push(TOOL_USE_TOOL);
    return { listed, deferred, byName };
}

function referenceText(block, plan)
{
    const tool = plan.byName.get(block.tool_name);
    if (!tool) return String(block.tool_name ?? '');
    const value = { name: tool.name, input_schema: tool.input_schema };
    if (typeof tool.description === 'string') value.description = tool.description;
    return compactSorted(value);
}

function rejectBlock(type)
{
    if (type === 'image') return badRequest('This model does not support image inputs');
    return badRequest(`GLM-5.3 on Fireworks does not accept ${type} content blocks`);
}

// Empty text blocks are dropped before every "\n" join.
const joinText = (parts) => parts.filter(t => t !== '').join('\n');

function textOf(content)
{
    if (typeof content === 'string') return content;
    return joinText((content || []).filter(b => b?.type === 'text').map(b => b.text ?? ''));
}

function toolContent(block, plan)
{
    const prefix = block.is_error === true ? 'Error: ' : '';
    if (typeof block.content === 'string' || block.content == null) return prefix + (block.content ?? '');
    return prefix + joinText(block.content.map(b => {
        if (b.type === 'text') return b.text ?? '';
        if (b.type === 'tool_reference') return referenceText(b, plan);
        throw rejectBlock(b.type);
    }));
}

// Anthropic body -> the turn list GLM's template walks. Tool results lead
// their message as tool turns; consecutive tool turns form one observation,
// sorted by the latest assistant's call order with unknown ids last.
function toTurns(body, plan)
{
    const turns = [];
    let callOrder = new Map();
    for (const message of body.messages || [])
    {
        if (message.role === 'assistant')
        {
            const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
            const calls = blocks.filter(b => b.type === 'tool_use');
            for (const call of calls)
                if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input))
                    throw badRequest(`tool_use input for ${call.name} must be a JSON object`);
            callOrder = new Map(calls.map((call, index) => [call.id, index]));
            turns.push({
                role: 'assistant',
                reasoning: joinText(blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '')),
                content: pyStrip(blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')),
                calls,
            });
            continue;
        }
        if (message.role === 'system')
        {
            const text = textOf(message.content);
            if (text === '') continue;
            const wrapped = `<system>${text}</system>`;
            const last = turns[turns.length - 1];
            if (last?.role === 'user') last.content += '\n' + wrapped;
            else turns.push({ role: 'user', content: wrapped });
            continue;
        }
        if (typeof message.content === 'string') { turns.push({ role: 'user', content: message.content }); continue; }
        const blocks = message.content || [];
        const results = blocks.filter(b => b.type === 'tool_result');
        if (results.length)
        {
            const last = turns[turns.length - 1];
            const observation = last?.role === 'tool' ? last : { role: 'tool', results: [], order: callOrder };
            if (observation !== last) turns.push(observation);
            for (const block of results) observation.results.push({ id: block.tool_use_id, content: toolContent(block, plan) });
        }
        const rest = blocks.filter(b => b.type !== 'tool_result');
        for (const block of rest) if (block.type !== 'text') throw rejectBlock(block.type);
        // Only a message of nothing but tool results opens no user turn; an
        // empty content list still does.
        if (rest.length || !results.length) turns.push({ role: 'user', content: joinText(rest.map(b => b.text ?? '')) });
    }
    for (const turn of turns)
    {
        if (turn.role !== 'tool') continue;
        const rank = (r) => turn.order.has(r.id) ? turn.order.get(r.id) : Infinity;
        turn.results = turn.results.map((r, i) => [r, i]).sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1])).map(([r]) => r);
    }
    return turns;
}

// Returns the prompt as parts: { special } for template control tokens and
// strings for text runs.
export function renderGlm53Parts(body)
{
    const effort = glm53Effort(body);
    const plan = toolPlan(body.tools);
    const turns = toTurns(body, plan);
    const parts = [];
    const special = (token) => parts.push({ special: token });
    const text = (value) => {
        if (value === '') return;
        if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += value;
        else parts.push(value);
    };

    special('[gMASK]'); special('<sop>'); special('<|system|>');
    text(`Reasoning Effort: ${effort}`);
    if (plan.listed.length)
    {
        special('<|system|>');
        text(TOOLS_HEAD + plan.listed.map(t => pyJson(t, schemaNumber)).join('\n') + TOOLS_TAIL);
        special('<tool_call>'); text('{function-name}');
        for (const n of [1, 2])
        {
            special('<arg_key>'); text(`{arg-key-${n}}`); special('</arg_key>');
            special('<arg_value>'); text(`{arg-value-${n}}`); special('</arg_value>');
        }
        text('...'); special('</tool_call>');
    }
    const system = textOf(body.system);
    if (system) { special('<|system|>'); text(system); }

    for (const turn of turns)
    {
        if (turn.role === 'user') { special('<|user|>'); text(turn.content); continue; }
        if (turn.role === 'tool')
        {
            special('<|observation|>');
            for (const result of turn.results) { special('<tool_response>'); text(result.content); special('</tool_response>'); }
            continue;
        }
        special('<|assistant|>');
        special('<think>'); text(turn.reasoning); special('</think>');
        text(turn.content);
        for (const call of turn.calls)
        {
            let name = call.name;
            let args = call.input;
            if (plan.deferred.has(name)) { args = { tool: name, arguments: args }; name = 'tool_use_tool'; }
            special('<tool_call>'); text(name);
            for (const [key, value] of Object.entries(args))
            {
                if (value === undefined) continue;
                special('<arg_key>'); text(key); special('</arg_key>');
                special('<arg_value>'); text(typeof value === 'string' ? value : pyJson(value, argNumber)); special('</arg_value>');
            }
            special('</tool_call>');
        }
    }
    if (turns[turns.length - 1]?.role !== 'assistant') { special('<|assistant|>'); special('<think>'); }
    return parts;
}

export const renderGlm53Prompt = (body) => renderGlm53Parts(body).map(p => typeof p === 'string' ? p : p.special).join('');

let tokenizer = null;
let loadError = null;
let textFile = null;

// The pinned tokenizers binding loads only from a file and always matches added
// tokens. Text runs need pure BPE, so a copy without added_tokens is derived
// once per vendored file, keyed by its hash, outside every watched tree.
function encoder()
{
    if (tokenizer) return tokenizer;
    try
    {
        if (!fs.existsSync(TOKENIZER_FILE)) throw new Error(`tokenizer.json missing at ${TOKENIZER_FILE}`);
        const raw = fs.readFileSync(TOKENIZER_FILE);
        const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
        textFile = path.join(os.tmpdir(), `cuimod-glm53-text-${hash}.json`);
        if (!fs.existsSync(textFile))
        {
            const json = JSON.parse(raw.toString('utf8'));
            json.added_tokens = [];
            const temp = `${textFile}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(json));
            fs.renameSync(temp, textFile);
        }
        const { PipelineTokenizer } = createRequire(import.meta.url)('tokenizers');
        tokenizer = PipelineTokenizer.fromFile(textFile);
        loadError = null;
        return tokenizer;
    }
    catch (error) { loadError = String(error?.message || error); throw error; }
}

export const warmGlm53 = () => { encoder(); };
export const glm53Status = () => ({ file: TOKENIZER_FILE, textFile, loaded: !!tokenizer, error: loadError });

export function glm53TokenIds(parts)
{
    const ids = [];
    for (const part of parts)
    {
        if (typeof part === 'string') for (const id of encoder().encode(part, { addSpecialTokens: false })) ids.push(id);
        else ids.push(SPECIAL_IDS[part.special]);
    }
    return ids;
}

export function countGlm53(body)
{
    let tokens = 0;
    for (const part of renderGlm53Parts(body))
        tokens += typeof part === 'string' ? encoder().encode(part, { addSpecialTokens: false }).length : 1;
    return tokens;
}

export { TOKENIZER_FILE };
