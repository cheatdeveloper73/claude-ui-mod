// Exact DeepSeek V4.1 Flash prompt counts for Fireworks' Anthropic Messages endpoint.
//
// Fireworks has no count_tokens endpoint, but with raw_output it returns the
// prompt it built and its ids, and usage.input_tokens + cache_read_input_tokens
// always equals that id count. This module rebuilds the same prompt locally and
// tokenizes it with the model's own tokenizer.json. The prompt format is
// DeepSeek's encoding.py (thinking mode, numeric effort, DSML tool calls);
// everything about how an Anthropic body reaches that format is Fireworks'
// adapter, and every rule below was read off a raw_output capture, not off
// documentation. tests/deepseek-v41-count.test.mjs replays those captures.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { imageDimensions } from './count-tokens.mjs';

const TOKENIZER_FILE = process.env.MODEL_ROUTER_DEEPSEEK_V41_TOKENIZER
    || fileURLToPath(new URL('../vendor/tokenizers/deepseek-v4.1-flash/tokenizer.json', import.meta.url));

const BOS = '<｜begin▁of▁sentence｜>';
const EOS = '<｜end▁of▁sentence｜>';
const SYSTEM = '<｜System｜>';
const USER = '<｜User｜>';
const ASSISTANT = '<｜Assistant｜>';
const THINK = '<think>';
const END_THINK = '</think>';
const DSML = '｜DSML｜';
const IMAGE = '<｜deepseek_image｜>';
const IMAGE_TOKEN_ID = 129264;
// Fireworks' mapping of a request onto encoding.py's 1-100 budget, read off
// raw_output: reasoning_effort takes an integer or a name, "none" (or thinking
// disabled) selects chat mode, output_config.effort takes the Anthropic names,
// and a request that sets none of them gets 75.
const EFFORT_NAMES = { low: 50, medium: 75, high: 75, xhigh: 100, max: 100 };
const DEFAULT_EFFORT = 75;

function budgetOf(value)
{
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    if (Number.isInteger(value) && value >= 1 && value <= 100) return value;
    const named = EFFORT_NAMES[String(value).toLowerCase()];
    if (named) return named;
    const error = new Error(`invalid reasoning effort ${JSON.stringify(value)}`);
    error.status = 400;
    throw error;
}

// The budget the prompt carries; null is chat mode, with no effort header and
// no thinking.
export function deepSeekV41Effort(body)
{
    if (body.reasoning_effort !== undefined)
        return String(body.reasoning_effort).toLowerCase() === 'none' ? null : budgetOf(body.reasoning_effort);
    if (body.thinking?.type === 'disabled') return null;
    if (body.output_config?.effort !== undefined) return budgetOf(body.output_config.effort);
    return DEFAULT_EFFORT;
}

const TOOLS_TEMPLATE = (schemas) => `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${DSML} calls>" block like the following:

<${DSML} calls>
<${DSML} invoke name="$TOOL_NAME">
<${DSML} parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${DSML} parameter>
...
</${DSML} invoke>
<${DSML} invoke name="$TOOL_NAME2">
...
</${DSML} invoke>
</${DSML} calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${THINK}), you MUST output your complete reasoning inside ${THINK}...${END_THINK} BEFORE any tool calls or final response.

Otherwise, output directly after ${END_THINK} with tool calls or final response.

### Available Tool Schemas

${schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;

// Fireworks' own dispatcher, appended when it takes over deferred tool loading.
export const TOOL_USE_TOOL = {
    name: 'tool_use_tool',
    description: 'Dispatch a call to one of your other available tools. Pass `tool` (the target tool\'s name — one of the tools you discovered via tool_search) and `arguments` (that tool\'s own arguments, exactly as its schema describes them). This is a wrapper, not a new capability: calling tool_use_tool with tool: "read_file" is the same as calling read_file directly. Only tools you are already allowed to use can be named here.',
    parameters: {
        type: 'object',
        properties: {
            tool: { type: 'string', description: 'The target tool\'s name — one of the tools discovered via tool_search.' },
            arguments: { type: 'object', description: 'The target tool\'s own arguments, exactly as its schema describes them.', additionalProperties: true },
        },
        required: ['tool', 'arguments'],
        additionalProperties: false,
    },
};

// Python's float repr. Only magnitudes below 1e-4 differ from JS (1e-05 vs
// 0.00001); a non-integral double is never as large as 1e16.
function pyNumber(x)
{
    if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : x < 0 ? '-Infinity' : 'NaN';
    if (Number.isInteger(x)) return String(x);
    if (Math.abs(x) >= 1e-4) return String(x);
    const [mantissa, exp] = x.toExponential().split('e');
    const e = Number(exp);
    return `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

// json.dumps(ensure_ascii=False). JSON.parse cannot tell 1 from 1.0, so every
// integral number renders as an int; Claude Code serializes through JS and
// never sends a 1.0 literal.
function pyJson(value, compact = false)
{
    const comma = compact ? ',' : ', ';
    const colon = compact ? ':' : ': ';
    const walk = (v) => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') return pyNumber(v);
        if (typeof v === 'string') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(walk).join(comma) + ']';
        let keys = Object.keys(v).filter(k => v[k] !== undefined);
        if (compact) keys = keys.sort();
        return '{' + keys.map(k => JSON.stringify(k) + colon + walk(v[k])).join(comma) + '}';
    };
    return walk(value);
}

const isEmptyObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
const sortedObject = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));

// Fireworks rewrites additionalProperties: {} to false. It walks the schema
// root, `properties` maps and `items` only (anyOf and $defs are left alone),
// and every node on the path to a rewrite comes back key-sorted while the rest
// keeps its order.
export function normalizeSchema(node)
{
    if (!node || typeof node !== 'object' || Array.isArray(node)) return [node, false];
    let out = node;
    let changed = false;
    const edit = () => { if (out === node) out = { ...node }; changed = true; };
    if (isEmptyObject(node.additionalProperties)) { edit(); out.additionalProperties = false; }
    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties))
    {
        let props = node.properties;
        let any = false;
        for (const [key, child] of Object.entries(node.properties))
        {
            const [next, hit] = normalizeSchema(child);
            if (hit) { if (!any) props = { ...props }; props[key] = next; any = true; }
        }
        if (any) { edit(); out.properties = sortedObject(props); }
    }
    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items))
    {
        const [next, hit] = normalizeSchema(node.items);
        if (hit) { edit(); out.items = next; }
    }
    return [changed ? sortedObject(out) : node, changed];
}

export const isToolSearch = (tool) => typeof tool?.name === 'string' && tool.name.replace(/_/g, '').toLowerCase() === 'toolsearch';

function toolPlan(tools)
{
    const all = Array.isArray(tools) ? tools : [];
    const deferredMode = all.some(isToolSearch) && all.some(t => t?.defer_loading === true);
    const deferred = new Set(deferredMode ? all.filter(t => t?.defer_loading === true).map(t => t.name) : []);
    const byName = new Map(all.map(t => [t?.name, t]));
    const listed = all.filter(t => !deferred.has(t?.name)).map(t => {
        const fn = { name: t.name };
        if (typeof t.description === 'string') fn.description = t.description;
        fn.parameters = normalizeSchema(t.input_schema)[0];
        return fn;
    });
    if (deferredMode) listed.push(TOOL_USE_TOOL);
    return { listed, deferred, byName };
}

function referenceText(block, plan)
{
    const tool = plan.byName.get(block.tool_name);
    if (!tool) return String(block.tool_name ?? '');
    const value = { name: tool.name, input_schema: tool.input_schema };
    if (typeof tool.description === 'string') value.description = tool.description;
    return pyJson(value, true);
}

function unsupported(type)
{
    const error = new Error(`DeepSeek V4.1 on Fireworks does not accept ${type} content blocks`);
    error.status = 400;
    return error;
}

// Text-only content collapses to one string joined by "\n". Content with an
// image stays a block list, which encoding.py joins with "\n\n".
function userContent(blocks)
{
    if (blocks.every(b => b.type === 'text')) return blocks.map(b => b.text ?? '').join('\n');
    return blocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
        if (b.type === 'image') return { type: 'image', source: b.source };
        throw unsupported(b.type);
    });
}

function toolContent(block, plan)
{
    const error = block.is_error === true;
    if (typeof block.content === 'string' || block.content == null)
        return (error ? 'Error: ' : '') + (block.content ?? '');
    const blocks = block.content;
    if (blocks.every(b => b.type === 'text' || b.type === 'tool_reference'))
        return (error ? 'Error: ' : '') + blocks.map(b => b.type === 'text' ? b.text ?? '' : referenceText(b, plan)).join('\n');
    const out = blocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
        if (b.type === 'image') return { type: 'image', source: b.source };
        if (b.type === 'tool_reference') return { type: 'text', text: referenceText(b, plan) };
        return { type: 'text', text: `[Unsupported ${b.type}]` };
    });
    return error ? [{ type: 'text', text: 'Error: ' }, ...out] : out;
}

const textOf = (content) => typeof content === 'string' ? content
    : (content || []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');

// Anthropic body -> the OpenAI-shaped message list Fireworks feeds encoding.py.
function toMessages(body, plan)
{
    const messages = [];
    const system = textOf(body.system);
    if (system || plan.listed.length) messages.push({ role: 'system', content: system, tools: plan.listed });

    for (const message of body.messages || [])
    {
        if (message.role === 'assistant')
        {
            const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
            messages.push({
                role: 'assistant',
                reasoning: blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('\n'),
                content: blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
                calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
            });
        }
        else if (message.role === 'system')
        {
            // A mid-conversation system message joins the user text before it
            // with "\n"; anywhere else it opens a user message of its own.
            const text = `<system>${textOf(message.content)}</system>`;
            const last = messages[messages.length - 1];
            if (last?.role === 'user' && typeof last.content === 'string') last.content += '\n' + text;
            else messages.push({ role: 'user', content: text });
        }
        else if (typeof message.content === 'string') messages.push({ role: 'user', content: message.content });
        else
        {
            const blocks = message.content || [];
            for (const block of blocks.filter(b => b.type === 'tool_result'))
                messages.push({ role: 'tool', id: block.tool_use_id, content: toolContent(block, plan) });
            const rest = blocks.filter(b => b.type !== 'tool_result');
            if (rest.length) messages.push({ role: 'user', content: userContent(rest) });
        }
    }
    return messages;
}

// encoding.py merge_tool_messages + sort_tool_results_by_call_order: tool
// results and consecutive user messages fold into one user turn of blocks.
function mergeTurns(messages)
{
    const merged = [];
    let order = new Map();
    for (const message of messages)
    {
        if (message.role === 'assistant')
        {
            order = new Map(message.calls.map((call, index) => [call.id, index]));
            merged.push(message);
            continue;
        }
        if (message.role === 'system') { merged.push(message); continue; }
        const blocks = message.role === 'tool'
            ? [{ type: 'tool_result', id: message.id, content: message.content }]
            : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
        const last = merged[merged.length - 1];
        if (last?.role === 'user') last.blocks.push(...blocks);
        else merged.push({ role: 'user', blocks: [...blocks], order });
    }
    for (const turn of merged)
    {
        if (turn.role !== 'user') continue;
        const results = turn.blocks.filter(b => b.type === 'tool_result');
        if (results.length < 2 || !turn.order.size) continue;
        const sorted = [...results].sort((a, b) => (turn.order.get(a.id) ?? 0) - (turn.order.get(b.id) ?? 0));
        let next = 0;
        turn.blocks = turn.blocks.map(b => b.type === 'tool_result' ? sorted[next++] : b);
    }
    return merged;
}

function renderCalls(calls, plan)
{
    const invokes = calls.map(call => {
        let name = call.name;
        let args = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : { arguments: call.input };
        if (plan.deferred.has(name)) { args = { tool: name, arguments: args }; name = 'tool_use_tool'; }
        const params = Object.entries(args).map(([key, value]) => typeof value === 'string'
            ? `<${DSML} parameter name="${key}" string="true">${value}</${DSML} parameter>`
            : `<${DSML} parameter name="${key}" string="false">${pyJson(value)}</${DSML} parameter>`);
        return `<${DSML} invoke name="${name}">\n${params.join('\n')}\n</${DSML} invoke>`;
    });
    return `\n\n<${DSML} calls>\n${invokes.join('\n')}\n</${DSML} calls>`;
}

function renderBlocks(blocks, images)
{
    return blocks.map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'image') { images.push(block.source); return IMAGE; }
        const content = typeof block.content === 'string' ? block.content : renderBlocks(block.content, images);
        return `<tool_result>${content}</tool_result>`;
    }).join('\n\n');
}

// Returns the prompt text plus the image sources in prompt order; each image
// is one placeholder here and expands to its grid at tokenization.
export function renderDeepSeekV41Prompt(body)
{
    const effort = deepSeekV41Effort(body);
    const thinkingMode = effort !== null;
    const plan = toolPlan(body.tools);
    const turns = mergeTurns(toMessages(body, plan));
    const dropThinking = plan.listed.length === 0;
    let lastUser = -1;
    turns.forEach((turn, index) => { if (turn.role === 'user') lastUser = index; });

    const images = [];
    // In thinking mode the effort header opens a system turn whether or not the
    // request has one; in chat mode only a leading system message opens it.
    let prompt = BOS + (thinkingMode
        ? SYSTEM + `Reasoning Effort: ${effort} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`
        : '');
    turns.forEach((turn, index) => {
        if (turn.role === 'system')
        {
            if (!thinkingMode) prompt += SYSTEM;
            prompt += turn.content;
            if (turn.tools.length) prompt += '\n\n' + TOOLS_TEMPLATE(turn.tools.map(t => pyJson(t)).join('\n'));
            return;
        }
        if (turn.role === 'user')
        {
            prompt += USER + renderBlocks(turn.blocks, images);
            if (index + 1 < turns.length && turns[index + 1].role !== 'assistant') return;
            prompt += ASSISTANT + (thinkingMode && (!dropThinking || index >= lastUser) ? THINK : END_THINK);
            return;
        }
        const thinking = thinkingMode && (!dropThinking || index > lastUser) ? turn.reasoning + END_THINK : '';
        prompt += thinking + turn.content + (turn.calls.length ? renderCalls(turn.calls, plan) : '') + EOS;
    });
    return { prompt, images };
}

// inference/image_processor.py plan_image_grid with config.json's vision
// settings: 14 px patches, 3x3 aligner, 1024-token cap, 295936 px floor.
const PATCH = 14;
const DOWNSAMPLE = 3;
const MAX_TOKENS = 1024;
const MIN_PIXELS = 295936;
const gridTokens = (h, w) => h * (w + 1) + 2;
const llmGrid = (bh, bw) => [Math.ceil(Math.floor(bh / PATCH) / DOWNSAMPLE), Math.ceil(Math.floor(bw / PATCH) / DOWNSAMPLE)];

export function deepSeekV41ImageGrid(width, height)
{
    if (width * height > 0 && width * height < MIN_PIXELS)
    {
        const ratio = Math.pow(MIN_PIXELS / (width * height), 0.5);
        width = Math.trunc(width * ratio);
        height = Math.trunc(height * ratio);
    }
    let bw = Math.ceil(width / PATCH) * PATCH;
    let bh = Math.ceil(height / PATCH) * PATCH;
    let [nh, nw] = llmGrid(bh, bw);
    if (gridTokens(nh, nw) > MAX_TOKENS)
    {
        const r = height / width;
        const maxW = Math.sqrt((MAX_TOKENS - 2) / r + 0.25) - 0.5;
        const maxH = maxW * r;
        const cell = PATCH * DOWNSAMPLE;
        if (maxW < 1.0) [bh, bw] = [Math.floor((MAX_TOKENS - 2) / 2) * cell, cell];
        else if (maxH < 1.0) [bh, bw] = [cell, (MAX_TOKENS - 3) * cell];
        else
        {
            const beta = Math.min(Math.floor(maxW) * cell / width, Math.floor(maxH) * cell / height);
            [bh, bw] = [Math.floor(height * beta / PATCH) * PATCH, Math.floor(width * beta / PATCH) * PATCH];
        }
        [nh, nw] = llmGrid(bh, bw);
    }
    return { rows: nh, columns: nw, tokens: gridTokens(nh, nw) };
}

export const deepSeekV41ImageTokens = (width, height) => deepSeekV41ImageGrid(width, height).tokens;

function imageSourceTokens(source)
{
    if (source?.type !== 'base64' || typeof source.data !== 'string')
    {
        const error = new Error('only base64 image sources can be counted locally');
        error.status = 400;
        throw error;
    }
    const { width, height } = imageDimensions(Buffer.from(source.data, 'base64'));
    return deepSeekV41ImageTokens(width, height);
}

let tokenizer = null;
let loadError = null;

// tokenizers 1.0 (napi) runs the model's own tokenizer.json. Encoding a
// near-full 1M-token prompt measured 16 ms, so counts run inline; the one
// expensive step is the load, which the worker does before it takes traffic.
function encoder()
{
    if (tokenizer) return tokenizer;
    try
    {
        if (!fs.existsSync(TOKENIZER_FILE)) throw new Error(`tokenizer.json missing at ${TOKENIZER_FILE}`);
        const { PipelineTokenizer } = createRequire(import.meta.url)('tokenizers');
        tokenizer = PipelineTokenizer.fromFile(TOKENIZER_FILE);
        loadError = null;
        return tokenizer;
    }
    catch (error) { loadError = String(error?.message || error); throw error; }
}

export const warmDeepSeekV41 = () => { encoder(); };
export const deepSeekV41Status = () => ({ file: TOKENIZER_FILE, loaded: !!tokenizer, error: loadError });

export function deepSeekV41TokenIds(prompt)
{
    return encoder().encode(prompt, { addSpecialTokens: false });
}

export function countDeepSeekV41(body)
{
    const { prompt, images } = renderDeepSeekV41Prompt(body);
    let tokens = deepSeekV41TokenIds(prompt).length;
    // Every placeholder id expands to that image's grid, START/NEWLINE/END included.
    for (const source of images) tokens += imageSourceTokens(source) - 1;
    return tokens;
}

// Text that merely mentions a DeepSeek control token must not become one.
// Fireworks rejects any request whose text contains <｜deepseek_image｜> (a
// session that once read such a file 400s on every later turn), and it
// tokenizes <｜User｜>, <｜System｜>, ｜DSML｜ and the rest as live control ids,
// so a file can inject turn structure. Rewriting the fullwidth bars to ASCII
// keeps the text readable and makes it ordinary tokens. Applied to system and
// message strings only; tool schemas and image data are left alone.
const SPECIAL = /<｜([^｜<>\n]{1,48})｜>|｜DSML｜/g;
const neutralize = (text) => text.replace(SPECIAL, (match, name) => name === undefined ? '|DSML|' : `<|${name}|>`);

function neutralizeValue(value, key)
{
    if (typeof value === 'string') return key === 'data' || key === 'signature' ? value : neutralize(value);
    if (Array.isArray(value)) return value.map(v => neutralizeValue(v));
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'image') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, neutralizeValue(v, k)]));
}

export function neutralizeDeepSeekV41Text(body)
{
    const out = { ...body };
    if (body.system !== undefined) out.system = neutralizeValue(body.system);
    if (Array.isArray(body.messages)) out.messages = body.messages.map(m => ({ ...m, content: neutralizeValue(m.content) }));
    return out;
}

// Claude Code declares a deferred tool with defer_loading and loads it where a
// message says so: a tool_reference in a ToolSearch result, or a tool_addition
// (by name or inline definition) in a system message; tool_removal unloads it.
// Fireworks never lists a deferred tool. It shows the reference as schema JSON
// in the tool result and offers its own tool_use_tool dispatcher, while
// ToolSearch tells the model the tool is now "callable exactly like any tool
// defined at the top of the prompt". DeepSeek only writes invoke names from
// its tool list, so it re-ran ToolSearch or emitted placeholder calls to other
// tools instead (replayed: 0 of 8 direct calls). encoding.py has nowhere but
// the system turn to declare a tool, so a loaded tool is listed there like any
// other. The listed prefix then changes when a tool loads, which is one cache
// miss per load. A deferred tool that is not loaded stays invisible, as on
// Anthropic, and with none left Fireworks drops tool_use_tool.
export function listLoadedDeepSeekV41Tools(body)
{
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (!tools.some(t => t?.defer_loading === true)) return body;
    const declared = new Map(tools.filter(t => t?.name).map(t => [t.name, t]));
    const loaded = new Map();
    const load = (def) => {
        if (!def?.name) return;
        const top = declared.get(def.name);
        if (top && top.defer_loading !== true) return;
        loaded.set(def.name, top || def);
    };
    for (const message of body.messages || [])
    {
        if (!Array.isArray(message?.content)) continue;
        for (const block of message.content)
        {
            if (block?.type === 'tool_result' && Array.isArray(block.content))
            {
                for (const ref of block.content)
                    if (ref?.type === 'tool_reference') load(declared.get(ref.tool_name));
            }
            else if (block?.type === 'tool_addition')
                load(block.tool?.type === 'tool_definition' ? block.tool.definition : declared.get(block.tool?.name));
            else if (block?.type === 'tool_removal' && block.tool?.name)
                loaded.delete(block.tool.name);
        }
    }
    const strip = ({ defer_loading, ...tool }) => tool;
    const listed = tools.filter(t => t?.defer_loading !== true || loaded.has(t.name)).map(t => t?.defer_loading === true ? strip(t) : t);
    for (const def of loaded.values()) if (!declared.has(def.name)) listed.push(strip(def));
    return { ...body, tools: listed };
}

export { IMAGE_TOKEN_ID, TOKENIZER_FILE };
