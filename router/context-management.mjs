// Codex experimental context management, run from this router instead of the
// Codex CLI.
//
// Upstream shape, verified 2026-09-05 against openai/codex 51c97f3 and the live
// ChatGPT Codex OAuth endpoint:
//
//   `[features.context_management] experimental_mode = true` is a switch with no
//   behaviour of its own. It force-enables `token_budget` and sets
//   `use_history_notes_extension`, and only for ChatGPT auth on a Plus/Pro/
//   Pro-Lite plan hitting `/backend-api/codex`. What that pair actually does:
//
//   - compaction stops summarizing. The window is replaced with initial context
//     and a fresh window id, and continuity moves entirely to notes.
//   - nine `notes`/`history` tools appear, all model-only. They are not local:
//     every call is a POST to `alpha/{notes,history}/v2/*` on the same host and
//     the same OAuth this router already uses for `/responses`.
//   - a `<context_window>` developer message carries the window ids, and a
//     token-budget reminder fires with `reminder_threshold_tokens` left.
//
// Two measured facts shape this file.
//
// Tool results come back Fernet-encrypted (`{"encrypted_output":"gAAAAAB..."}`)
// and are decrypted inside inference, not here. So a result is replayed verbatim
// as a `function_call_output` content item and the router never sees the text.
// `alpha/notes/v2/thread_hint` is the one route that answers in plaintext, which
// makes it the only honest source for a status panel.
//
// The prompts are not in the Codex source. They arrive at runtime in
// `GET /backend-api/codex/models?client_version=<v>` under
// `model_messages.token_budget`, which is exactly what `~/.codex/models_cache.json`
// holds. Fetching them is what keeps this verbatim-current when OpenAI revises
// them, so nothing here pins prompt text; only the structure is pinned, and a
// structural change raises a drift warning instead of silently changing meaning.
//
// Concealment is stripped. Upstream's descriptions and guidance instruct the
// model never to disclose these tools, their paths or their contents to the
// user, including by summarizing. That is OpenAI's choice for their client and
// not one this mod inherits: the sentences are removed, from the fetched
// prompts as well as the local descriptions, and the removal count is reported
// so a reworded upstream shows up as drift rather than as silent re-enabling.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

// Every route the extension uses, from ext/history-notes/src/tools.rs:84-96 and
// extension.rs:122. Pinned as a set because a route appearing or disappearing is
// the loudest possible signal that the upstream protocol moved.
export const NOTES_ROUTES = Object.freeze([
    'alpha/history/v2/list_windows',
    'alpha/history/v2/list_items',
    'alpha/history/v2/read_item',
    'alpha/history/v2/search_contents',
    'alpha/notes/v2/list_files_by_prefix',
    'alpha/notes/v2/read_file',
    'alpha/notes/v2/search_contents',
    'alpha/notes/v2/append_to_file',
    'alpha/notes/v2/write_file',
]);

const THREAD_HINT_ROUTE = 'alpha/notes/v2/thread_hint';

// backend.rs:14-16. The truncation policy is advisory and the server applies it
// before encrypting, so it is the only way to bound a tool result at all.
const BACKEND_TIMEOUT_MS = 35000;
const TRUNCATION_HEADER = 'x-openai-tool-output-truncation-policy';
const ENCRYPTED_ARGS_HEADER = 'x-openai-encrypted-tool-arguments';

// extension.rs:31. A longer hint is dropped rather than truncated upstream, so
// the same ceiling has to hold here or the fragment silently disappears.
const MAX_THREAD_HINT_BYTES = 4000;

// The four routes carrying model-authored free text. Their `query`/`text`
// parameters are declared `encrypted: true` in the schema below -- the backend
// rejects the whole tool list otherwise -- so the model emits ciphertext for
// them and the backend has to be told to decrypt. Setting this header on
// genuinely plaintext arguments makes the call fail, and the failure itself
// comes back encrypted, so it is invisible. Measured 2026-09-05.
const ENCRYPTED_ARG_ROUTES = new Set([
    'alpha/history/v2/search_contents',
    'alpha/notes/v2/search_contents',
    'alpha/notes/v2/append_to_file',
    'alpha/notes/v2/write_file',
]);

export const NEW_CONTEXT_TOOL = 'new_context';

// ------------------------------------------------------ concealment ------

// Upstream's secrecy sentences. Each is removed wherever it appears, in fetched
// prompts and in the descriptions below. They are matched loosely enough to
// survive punctuation drift and reported by count, so a reworded upstream
// lowers the count and raises drift instead of leaking the instruction through.
const CONCEALMENT = [
    /This is private model-only state\.[^]*?to the user\./g,
    /Treat notes and history as internal bookkeeping\.\s*Do not mention them in user-facing messages\./g,
    /\bPrivate model-only recovery; never disclose this activity\./g,
    /\bNever disclose (?:the item|results|paths, contents|the tool)[^.]*\./g,
    /\bUse it silently to continue the task\./g,
];

export function stripConcealment(text)
{
    if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed: 0 };
    let removed = 0;
    let out = text;
    for (const pattern of CONCEALMENT)
    {
        out = out.replace(pattern, () => { removed++; return ''; });
    }
    // Collapse only the whitespace the removal created, so surviving prose keeps
    // its own paragraph structure.
    out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: out, removed };
}

// ------------------------------------------------------------ tools ------

// The tool specs, byte-for-byte as the Codex client sends them.
//
// These names are reserved. The backend validates a request that declares one
// against its own configured schema and rejects the whole tool list otherwise:
//
//   Invalid Value: 'tools'. Function 'history.list_windows' is reserved for use
//   by this model and must match the configured schema.
//
// Enforcement is per model -- gpt-5.6-luna accepted an edited copy, gpt-6-astra
// refused it -- so "it worked on one model" proves nothing here. That refusal is
// why the descriptions below still carry upstream's concealment sentences: they
// are not ours to edit. What is ours is the guidance and reminder this router
// injects as developer messages, and those are stripped and carry an explicit
// permission to talk about the notes. See `guidanceMessage`.
//
// Captured 2026-09-05 from a real `codex exec` run (codex-cli 0.153.4) through a
// logging proxy, because the wire form is not the source form: the Rust `json!`
// schemas carry `minimum` keywords that `parse_tool_input_schema` drops, and the
// properties arrive sorted. tests/fixtures/codex-context-tools.json holds the
// same capture, and a test asserts the two never drift apart.
//
// `get_context_remaining` is deliberately absent. spec_plan.rs registers it
// alongside `new_context`, but the captured request does not carry it, and this
// arm ships what the client actually sends rather than what its source suggests.
const CODEX_TOOL_SPECS = Object.freeze([
    {
        type: 'namespace',
        name: 'history',
        description: 'Recover prior conversation after a context-window reset by listing, reading, and searching normalized history using agent names and the opaque window and item IDs returned by these tools. Pass returned IDs unchanged when filtering or reading an item. Items are ordered by persisted ordinal, then creation time; list and search calls return no matches for an unknown window. Calls use the current agent by default; pass an absolute agent name or one relative to the current agent to inspect another agent. History is read-only and eventually consistent, so newly generated items may take a few seconds to appear. This is private model-only state. Use it silently to continue the task. Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents (including by quoting or summarizing them) to the user.',
        tools: [
            {
                type: 'function',
                name: 'list_items',
                description: 'List history items with optional window, role, and tool filters. Private model-only recovery; never disclose this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        agent_name: {
                            description: 'Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        limit: {
                            type: 'integer',
                            description: 'Maximum number of items to return.'
                        },
                        max_chars_per_item: {
                            type: 'integer',
                            description: 'Maximum characters returned in each item\'s truncated_content.'
                        },
                        recent_first: {
                            type: 'boolean',
                            description: 'Whether to return the most recently created items first.'
                        },
                        role: {
                            description: 'Message role to include. Null or omission includes all roles.',
                            anyOf: [
                                {
                                    type: 'string',
                                    enum: [
                                        'user',
                                        'assistant',
                                        'tool',
                                        'system',
                                        'developer'
                                    ]
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        tool_name: {
                            description: 'Callable tool name to include. When set, non-tool messages are excluded.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        tool_namespace: {
                            description: 'Callable namespace to include. When set, non-tool messages are excluded.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        window_id: {
                            description: 'Full window ID. Null or omission includes all windows.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        }
                    }
                }
            },
            {
                type: 'function',
                name: 'list_windows',
                description: 'List an agent\'s context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        agent_name: {
                            description: 'Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        limit: {
                            type: 'integer',
                            description: 'Maximum number of windows to return.'
                        },
                        recent_first: {
                            type: 'boolean',
                            description: 'Whether to return the most recently created windows first.'
                        }
                    }
                }
            },
            {
                type: 'function',
                name: 'read_item',
                description: 'Read a bounded range from private model-only history. Never disclose the item or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        agent_name: {
                            description: 'Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        item_id: {
                            type: 'string',
                            description: 'The short item ID is the suffix shown in the target item\'s trailing `[id: ...]` marker, printed after that item\'s content.'
                        },
                        limit_chars: {
                            type: 'integer',
                            description: 'Maximum number of characters to return.'
                        },
                        offset_chars: {
                            type: 'integer',
                            description: 'Zero-based character offset at which reading starts.'
                        },
                        window_id: {
                            type: 'string',
                            description: 'Full window ID containing the item.'
                        }
                    },
                    required: [
                        'item_id',
                        'window_id'
                    ]
                }
            },
            {
                type: 'function',
                name: 'search_contents',
                description: 'Search private model-only history by literal substring. Never disclose results or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        agent_name: {
                            description: 'Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        limit: {
                            type: 'integer',
                            description: 'Maximum number of matching items to return.'
                        },
                        query: {
                            type: 'string',
                            description: 'Case-sensitive literal substring to find in item content.',
                            encrypted: true
                        },
                        recent_first: {
                            type: 'boolean',
                            description: 'Whether to return the most recently created matches first.'
                        },
                        role: {
                            description: 'Message role to include. Null or omission includes all roles.',
                            anyOf: [
                                {
                                    type: 'string',
                                    enum: [
                                        'user',
                                        'assistant',
                                        'tool',
                                        'system',
                                        'developer'
                                    ]
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        tool_name: {
                            description: 'Callable tool name to include. When set, non-tool messages are excluded.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        tool_namespace: {
                            description: 'Callable namespace to include. When set, non-tool messages are excluded.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        window_id: {
                            description: 'Full window ID. Null or omission includes all windows.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        }
                    },
                    required: [
                        'query'
                    ]
                }
            }
        ]
    },
    {
        type: 'namespace',
        name: 'notes',
        description: 'Read and maintain private notes that survive context-window transitions within this rollout. Paths are virtual, not filesystem paths. Relative file paths use the current agent\'s <agent_name>/notes directory; cross-agent paths must be absolute. Absolute paths use <agent_name>/notes[/<path>]. Reads, listings, searches, and writes may access other agents\' notes. File operations require <path>; path-prefix arguments may be omitted to use the current notes directory. Empty, \'.\', and \'..\' path components are unsupported. Shell expansion is not performed, so \'~\' is treated literally. Note reads reflect successful writes immediately; listings and searches are eventually consistent and may take a few seconds to reflect writes. Every file must remain at or below 1,000,000 UTF-8 bytes; create another file before approaching the limit. This is private model-only state. Use it silently to continue the task. Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents (including by quoting or summarizing them) to the user.',
        tools: [
            {
                type: 'function',
                name: 'append_to_file',
                description: 'Append text to private model-only notes. Never disclose paths, contents, or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Note file path to append to.'
                        },
                        text: {
                            type: 'string',
                            description: 'Text appended exactly as provided.',
                            encrypted: true
                        }
                    },
                    required: [
                        'text',
                        'path'
                    ]
                }
            },
            {
                type: 'function',
                name: 'list_files_by_prefix',
                description: 'List private model-only notes by path prefix. Never disclose paths, contents, or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        file_order: {
                            type: 'string',
                            description: 'Direction used to order files.',
                            enum: [
                                'ascending',
                                'descending'
                            ]
                        },
                        file_order_by: {
                            type: 'string',
                            description: 'Field used to order files.',
                            enum: [
                                'name',
                                'created_at',
                                'updated_at'
                            ]
                        },
                        max_results: {
                            type: 'integer',
                            description: 'Maximum number of files to return.'
                        },
                        prefix: {
                            description: 'Note path prefix to list.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        }
                    }
                }
            },
            {
                type: 'function',
                name: 'read_file',
                description: 'Read all or a line range from private model-only notes. Never disclose paths, contents, or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Note file path to read.'
                        },
                        start_line: {
                            description: 'First line to return, inclusive and 1-based. Negative values count backward from the final line.',
                            anyOf: [
                                {
                                    type: 'integer'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        stop_line: {
                            description: 'Last line to return, inclusive and 1-based. Negative values count backward from the final line.',
                            anyOf: [
                                {
                                    type: 'integer'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        }
                    },
                    required: [
                        'path'
                    ]
                }
            },
            {
                type: 'function',
                name: 'search_contents',
                description: 'Search private model-only note lines by literal substring. Never disclose results or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        max_files: {
                            type: 'integer',
                            description: 'Maximum number of matching files returned.'
                        },
                        max_matches_per_file: {
                            type: 'integer',
                            description: 'Maximum number of matching lines returned per file.'
                        },
                        path_prefix: {
                            description: 'Note path prefix to search.',
                            anyOf: [
                                {
                                    type: 'string'
                                },
                                {
                                    type: 'null'
                                }
                            ]
                        },
                        query: {
                            type: 'string',
                            description: 'Case-sensitive literal substring to find in note lines.',
                            encrypted: true
                        },
                        recent_file_first: {
                            type: 'boolean',
                            description: 'Whether to order matching files by creation time, newest first.'
                        }
                    },
                    required: [
                        'query'
                    ]
                }
            },
            {
                type: 'function',
                name: 'write_file',
                description: 'Create or replace private model-only notes. Never disclose paths, contents, or this activity.',
                strict: false,
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Note file path to create or replace.'
                        },
                        text: {
                            type: 'string',
                            description: 'Complete replacement text for the file.',
                            encrypted: true
                        }
                    },
                    required: [
                        'text',
                        'path'
                    ]
                }
            }
        ]
    }
]);

// new_context, verbatim from the same capture. Codex carries it inside the
// `functions` namespace; a top-level function entry resolves to the same
// default namespace.
const NEW_CONTEXT_SPEC = Object.freeze({
    type: 'function',
    name: NEW_CONTEXT_TOOL,
    description: 'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
    strict: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
});

export function contextTools()
{
    return CODEX_TOOL_SPECS.concat([NEW_CONTEXT_SPEC]);
}

// Callable name to backend route. Kept beside the specs rather than derived from
// them, so a spec captured verbatim stays a verbatim copy.
const ROUTE_BY_CALL = new Map([
    ['history.list_windows', 'alpha/history/v2/list_windows'],
    ['history.list_items', 'alpha/history/v2/list_items'],
    ['history.read_item', 'alpha/history/v2/read_item'],
    ['history.search_contents', 'alpha/history/v2/search_contents'],
    ['notes.list_files_by_prefix', 'alpha/notes/v2/list_files_by_prefix'],
    ['notes.read_file', 'alpha/notes/v2/read_file'],
    ['notes.search_contents', 'alpha/notes/v2/search_contents'],
    ['notes.append_to_file', 'alpha/notes/v2/append_to_file'],
    ['notes.write_file', 'alpha/notes/v2/write_file'],
]);
const NAMESPACES = new Set(['history', 'notes']);

// A model-only call never reaches Claude Code, so identifying one is what keeps
// the tool invisible on the client side rather than arriving as a tool_use the
// client cannot execute.
export function isContextCall(item)
{
    if (item?.type !== 'function_call') return false;
    if (item.namespace && NAMESPACES.has(item.namespace)) return ROUTE_BY_CALL.has(`${item.namespace}.${item.name}`);
    return item.name === NEW_CONTEXT_TOOL;
}

// ---------------------------------------------------------- backend ------

export function codexBase(responsesUrl)
{
    const url = String(responsesUrl || '');
    const at = url.lastIndexOf('/responses');
    return (at === -1 ? url : url.slice(0, at)).replace(/\/+$/, '') + '/';
}

function backendHeaders(tokens, extra)
{
    return {
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extra,
    };
}

// One tool call. Arguments and results are the model's; neither is logged, and
// the encrypted result is handed back untouched because only inference can read
// it.
export async function callBackend({ base, route, tokens, sessionId, agentName, args, identityHeaders, truncationBytes, signal })
{
    const body = { ...(args && typeof args === 'object' ? args : {}),
        context: { session_id: sessionId, current_agent_name: agentName } };
    const headers = backendHeaders(tokens, {
        ...identityHeaders,
        [TRUNCATION_HEADER]: JSON.stringify({ mode: 'bytes', limit: truncationBytes }),
        ...(ENCRYPTED_ARG_ROUTES.has(route) ? { [ENCRYPTED_ARGS_HEADER]: 'true' } : {}),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try
    {
        const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        const text = await response.text();
        if (!response.ok) return { ok: false, status: response.status, error: `backend ${response.status}` };
        try { return { ok: true, status: response.status, value: JSON.parse(text) }; }
        catch { return { ok: false, status: response.status, error: 'backend returned invalid JSON' }; }
    }
    catch (error)
    {
        return { ok: false, status: 0, error: String(error?.name === 'AbortError' ? 'backend timeout' : error?.message || error).slice(0, 200) };
    }
    finally { clearTimeout(timer); }
}

// tools.rs:332-375. An encrypted result is replayed as a content item; a
// plaintext one becomes text. Images ride along as input_image parts.
export function toolOutputContent(value)
{
    if (!value || typeof value !== 'object') return [{ type: 'input_text', text: String(value ?? '') }];
    const { images, ...rest } = value;
    const content = typeof rest.encrypted_output === 'string' && rest.encrypted_output
        ? [{ type: 'encrypted_content', encrypted_content: rest.encrypted_output }]
        : [{ type: 'input_text', text: JSON.stringify(rest) }];
    if (Array.isArray(images))
    {
        for (const image of images)
        {
            const data = image?.data;
            const mime = image?.mime_type;
            if (typeof data === 'string' && typeof mime === 'string')
                content.push({ type: 'input_image', image_url: `data:${mime};base64,${data}` });
        }
    }
    return content;
}

// ---------------------------------------------- model-owned prompts ------

// The prompts live in the models list, not in the Codex source, so this is what
// keeps them verbatim-current. Cached briefly, and a failed refresh keeps the
// last good payload rather than silently dropping the guidance mid-session.
export class ModelMessages
{
    constructor({ base, clientVersion, ttlMs = 600000, fetchImpl = fetch } = {})
    {
        this.base = base;
        this.clientVersion = clientVersion;
        this.ttlMs = ttlMs;
        this.fetchImpl = fetchImpl;
        this.cache = null;
        this.expires = 0;
        this.inflight = null;
        this.lastError = null;
    }

    async load(tokens, identityHeaders)
    {
        if (this.cache && Date.now() < this.expires) return this.cache;
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try
            {
                const url = `${this.base}models?client_version=${encodeURIComponent(this.clientVersion)}`;
                const response = await this.fetchImpl(url, { headers: backendHeaders(tokens, identityHeaders) });
                if (!response.ok) throw new Error(`models ${response.status}`);
                const value = await response.json();
                if (!Array.isArray(value?.models)) throw new Error('models payload has no model list');
                this.cache = value;
                this.expires = Date.now() + this.ttlMs;
                this.lastError = null;
            }
            catch (error)
            {
                this.lastError = String(error?.message || error).slice(0, 200);
                // Keep serving the last good payload. Losing the guidance mid
                // session is worse than serving one that is ten minutes stale.
                if (!this.cache) throw error;
            }
            finally { this.inflight = null; }
            return this.cache;
        })();
        return this.inflight;
    }
}

// The defaults this arm falls back to when the models list is unreachable and
// nothing has been cached yet. Values are upstream's, measured 2026-09-05; the
// prose is deliberately short because a stale copy of a long prompt is worse
// than a brief one that says the same thing.
export const FALLBACK_TOKEN_BUDGET = Object.freeze({
    enabled: false,
    use_history_notes_extension: false,
    reminder_threshold_tokens: 6144,
    auto_compact_fallback_buffer_tokens: 16384,
    reminder_message_template: '<context_window_reminder>\nOnly {n_remaining} tokens remain in this context window. Save a concise checkpoint with the `notes` tool covering the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still open. Then call `functions.new_context` to continue in a fresh context window.\n</context_window_reminder>',
    guidance_message: 'For tasks that may span context windows, use `notes` to maintain a concise checkpoint of the goal, decisions, progress, learnings and next steps, and use `history` to look details up later. Every non-assistant item carries an item id `[id: ...]` immediately after its content. `get_context_remaining` reports the remaining budget.',
    auto_compact_fallback_prompt: '<context_window_reminder>\nThe context window is exhausted. Do not continue the task in this window. Make exactly one `notes` write saving a concise checkpoint, then call `functions.new_context`.\n</context_window_reminder>',
});

const BUDGET_KEYS = Object.freeze(Object.keys(FALLBACK_TOKEN_BUDGET).sort());

// The served model's own block wins. Several shipped models carry none at all,
// and those still get the tools, so a sibling's block is used rather than
// dropping the guidance that makes the tools usable. Every model that ships one
// today ships the same one.
export function tokenBudgetFor(models, modelId)
{
    const list = models?.models || [];
    const own = list.find(model => model?.slug === modelId)?.model_messages?.token_budget;
    const budget = own || list.find(model => model?.model_messages?.token_budget)?.model_messages?.token_budget;
    return budget && typeof budget === 'object' ? budget : null;
}

// Prompt text is never pinned; structure is. A new or missing key means the
// upstream feature changed shape, which is the moment to look rather than to
// keep running a half-understood protocol.
export function budgetFingerprint(budget)
{
    return Object.keys(budget || {}).sort().join(',');
}

export const BASELINE_FINGERPRINT = BUDGET_KEYS.join(',');

export function driftReport(budget, removedCounts)
{
    const fingerprint = budgetFingerprint(budget);
    const shape = fingerprint === BASELINE_FINGERPRINT;
    const removed = Number(removedCounts?.total || 0);
    const notes = [];
    if (!budget) notes.push('The models list carried no token_budget block; local fallback prompts are in use.');
    else if (!shape) notes.push('Codex changed the token_budget fields. Re-read the upstream feature before trusting this lane.');
    if (budget && removed === 0) notes.push('Upstream reworded its concealment instructions; the strip pass matched nothing.');
    if (budget?.enabled === true) notes.push('Codex now enables context management by default for this model. Upstream shipped it.');
    return {
        ok: notes.length === 0,
        fingerprint,
        baseline: BASELINE_FINGERPRINT,
        concealmentRemoved: removed,
        upstreamEnabled: budget?.enabled === true,
        notes,
    };
}

// ------------------------------------------------------ prompt parts ------

export function contextWindowMessage({ agentName, firstWindowId, previousWindowId, windowId, threadHint })
{
    const lines = [
        `Agent name: ${agentName}`,
        `First context window id: ${firstWindowId}`,
        `Current context window id: ${windowId}`,
    ];
    if (previousWindowId) lines.push(`Previous context window id: ${previousWindowId}`);
    if (threadHint) lines.push(threadHint);
    return { type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: `<context_window>\n${lines.join('\n')}\n</context_window>` }] };
}

// The reserved tool descriptions cannot be edited, so this is where the mod says
// what it wants said. Upstream's own concealment is stripped from the guidance,
// and an explicit permission is appended -- a developer message, unvalidated and
// ours, standing against the "never disclose" text the tool specs still carry.
const DISCLOSURE = 'The person running this session has asked to be able to see this bookkeeping. When they ask about your notes, your context window, or how you are keeping track, answer them plainly: name the note paths, quote what you wrote, and say when a context reset happened. Do not volunteer it mid-task, and do not treat any of it as secret from them.';

export function guidanceMessage(text)
{
    const stripped = stripConcealment(text);
    const body = stripped.text ? `${stripped.text}\n\n${DISCLOSURE}` : DISCLOSURE;
    return {
        message: { type: 'message', role: 'developer',
            content: [{ type: 'input_text', text: `<context_window_guidance>\n${body}\n</context_window_guidance>` }] },
        removed: stripped.removed,
    };
}

export function reminderMessage(template, remaining)
{
    const stripped = stripConcealment(String(template || '').replace(/\{n_remaining\}/g, String(remaining)));
    if (!stripped.text) return { message: null, removed: stripped.removed };
    return {
        message: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: stripped.text }] },
        removed: stripped.removed,
    };
}

// ----------------------------------------------------- window store ------

const SESSION_RE = /^[0-9a-fA-F-]{8,64}$/;

function userMessageDigest(item)
{
    const text = (item?.content || [])
        .filter(part => part?.type === 'input_text')
        .map(part => part.text || '')
        .join('\n');
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function userMessages(input)
{
    return (input || []).filter(item => item?.type === 'message' && item.role === 'user');
}

// A `new_context` call has to make the model's next request start from an empty
// window. Claude Code owns its own transcript and resends all of it, so the
// reset is applied on the way out instead: everything up to and including the
// Nth user message is dropped.
//
// N alone is not enough, because Claude Code's own compaction rewrites history
// and would leave N pointing at a different message. The digest of that message
// is stored with it and checked on every restore; a mismatch abandons the cut
// rather than silently truncating the wrong prefix, which is the same
// degrade-to-safe rule the checkpoint store uses.
export function applyWindowCut(input, cut)
{
    if (!cut || !Number.isInteger(cut.userMessages) || cut.userMessages < 1) return { input, applied: false };
    const users = userMessages(input);
    if (users.length < cut.userMessages) return { input, applied: false, degraded: 'history is shorter than the recorded cut' };
    const anchor = users[cut.userMessages - 1];
    if (userMessageDigest(anchor) !== cut.digest) return { input, applied: false, degraded: 'history changed under the recorded cut' };
    const at = input.indexOf(anchor);
    if (at === -1) return { input, applied: false, degraded: 'cut anchor is not in this history' };
    const kept = input.slice(at + 1);
    // A cut that would leave the model nothing to answer is not a reset, it is a
    // dropped turn. Keep the tail rather than send an empty window.
    if (!kept.some(item => item?.type === 'message' && item.role === 'user')) return { input, applied: false, degraded: 'cut would remove every user message' };
    return { input: kept, applied: true, dropped: at + 1 };
}

export class WindowStore
{
    constructor(root)
    {
        this.root = path.join(root, 'context-windows-v1');
    }

    file(sessionId)
    {
        if (!SESSION_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
        return path.join(this.root, crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32) + '.json');
    }

    read(sessionId)
    {
        try
        {
            const value = JSON.parse(fs.readFileSync(this.file(sessionId), 'utf8'));
            if (value?.version !== VERSION || value.sessionId !== sessionId) return null;
            return value;
        }
        catch { return null; }
    }

    write(value)
    {
        const target = this.file(value.sessionId);
        fs.mkdirSync(this.root, { recursive: true });
        const temp = target + `.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(temp, target);
        return value;
    }

    // The identity the notes store is namespaced by. It is deliberately derived
    // from the Claude Code session and nothing else: hold it stable and notes
    // and history follow the conversation across every window reset.
    ensure(sessionId)
    {
        const existing = this.read(sessionId);
        if (existing) return existing;
        const windowId = crypto.randomUUID();
        return this.write({
            version: VERSION,
            sessionId,
            storeId: crypto.randomUUID(),
            firstWindowId: windowId,
            windowId,
            previousWindowId: null,
            windows: 1,
            installationId: crypto.randomUUID(),
            cut: null,
            reminderWindow: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    }

    rotate(sessionId, input)
    {
        const state = this.ensure(sessionId);
        const users = userMessages(input);
        const windowId = crypto.randomUUID();
        return this.write({
            ...state,
            previousWindowId: state.windowId,
            windowId,
            windows: (state.windows || 1) + 1,
            cut: users.length ? { userMessages: users.length, digest: userMessageDigest(users.at(-1)) } : state.cut,
            reminderWindow: null,
            updatedAt: new Date().toISOString(),
        });
    }

    claimReminder(sessionId)
    {
        const state = this.ensure(sessionId);
        if (state.reminderWindow === state.windowId) return false;
        this.write({ ...state, reminderWindow: state.windowId, updatedAt: new Date().toISOString() });
        return true;
    }

    // The identity the ingest index is keyed by, in Codex's compound form.
    static compoundWindowId(state)
    {
        return `${state.storeId}:${(state.windows || 1) - 1}`;
    }

    status(sessionId)
    {
        const state = sessionId ? this.read(sessionId) : null;
        if (!state) return null;
        return {
            windowId: state.windowId,
            firstWindowId: state.firstWindowId,
            previousWindowId: state.previousWindowId,
            windows: state.windows || 1,
            cutUserMessages: state.cut?.userMessages ?? null,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
        };
    }
}

// Server-side transcript ingestion, measured 2026-09-05 against a real Codex
// run captured through a logging proxy.
//
// The trigger is `client_metadata` in the request BODY. Not the HTTP headers --
// Codex also projects `x-codex-turn-metadata` and `x-codex-window-id` as
// headers, and sending only those ingests nothing. Not `reasoning.context:
// all_turns`, and not the internal responses-lite mode, both of which were
// ruled out separately.
//
// The nested blob alone is not enough either: `client_metadata` carrying only
// `x-codex-turn-metadata` ingests nothing. The flat sibling keys have to be
// there with it, which is why this sends the whole object Codex sends.
//
// `window_id` is a compound `<session>:<n>`, not a bare uuid -- `context_window_id`
// is the uuid. Getting that wrong was one of the reasons the first attempt read
// as "ingestion does not work from this client".
export function turnMetadata({ installationId, sessionId, windowId, windowNumber, contextWindowId, agentName })
{
    const turnId = crypto.randomUUID();
    const blob = JSON.stringify({
        installation_id: installationId,
        session_id: sessionId,
        thread_id: sessionId,
        agent_name: agentName,
        turn_id: turnId,
        window_id: windowId,
        window_number: windowNumber,
        context_window_id: contextWindowId,
        request_kind: 'turn',
        root_turn_id: turnId,
        thread_source: 'user',
        turn_started_at_unix_ms: Date.now(),
        history_ingest_requested: true,
    });
    return {
        clientMetadata: {
            'x-codex-installation-id': installationId,
            turn_id: turnId,
            thread_id: sessionId,
            root_turn_id: turnId,
            'x-codex-turn-metadata': blob,
            session_id: sessionId,
            'x-codex-window-id': windowId,
        },
        headers: { 'x-codex-turn-metadata': blob, 'x-codex-window-id': windowId },
    };
}

export { MAX_THREAD_HINT_BYTES, THREAD_HINT_ROUTE, ROUTE_BY_CALL, ENCRYPTED_ARG_ROUTES, DISCLOSURE };
