# Features

**419 features**: 161 in the 33 plugins and 258 in the router and its tooling, with 193 settings live in the dashboard.

A feature here is one thing you can see, use or rely on. A group of settings that tunes one thing counts once, and two unrelated behaviours in one plugin count twice. Each row was traced to the source line that implements it when this list was compiled for 1.2.0.

| outcome | features |
|---|---|
| [Models & providers](#models--providers) | 83 |
| [Agents & automation](#agents--automation) | 48 |
| [Usage, limits & context](#usage-limits--context) | 141 |
| [Composer & session](#composer--session) | 29 |
| [Transcript & appearance](#transcript--appearance) | 31 |
| [Desktop bug fixes](#desktop-bug-fixes) | 12 |
| [Unlocks](#unlocks) | 10 |
| [Router & reliability](#router--reliability) | 65 |

## Models & providers

| feature | what it does | where |
|---|---|---|
| Provider tabs in the model menu | Adds a tab strip to the composer model menu that filters the model list by provider, with keyboard navigation and an optional resize animation. | `provider-picker` |
| Routed models in native model list | Extends the app's own available-models push so catalogued non-Anthropic models appear and are selectable in the native selector. | `provider-picker` |
| Effort stops for routed models | Gives each catalogued model its own reasoning-effort options and default, using the Codex model cache for OpenAI models when it is present. | `provider-picker` |
| Fast switch on GPT models | Shows the composer's Fast switch for GPT models whose Codex model cache lists a priority speed tier. | `provider-picker` |
| OpenAI GPT-6 models | Lists GPT-6-Astra, GPT-6.1-Sol and GPT-6-Luna with 1.05M-token context and low-to-max effort stops under the OpenAI tab. | `provider-picker` |
| Meta Muse Spark models | Lists the standard and contributor Muse Spark 1.3 variants, sent as Anthropic Messages to api.meta.ai with a key read from ignored local state. | `provider-picker` |
| Command Code models | Lists DeepSeek V4/V4.1, GLM 5.3, Kimi K3, Qwen 3.8 Max and MiniMax M3 under a Command Code tab. | `provider-picker` |
| Claude Opus 4.6 thinking entry | Adds a Claude Opus 4.6 thinking row with low, medium and high effort and a 250k window to the Claude tab. | `provider-picker` |
| OpenAI account manager | Lists stored OpenAI logins in the dashboard with actions to switch the active one, sign in to another through the Codex CLI, or remove one. | `provider-picker` |
| Reasoning on/off for GPT requests | Asks OpenAI to skip reasoning on the next model call when off, and keeps each model's selected effort when on. | `provider-picker` |
| GPT reasoning summary and text | Chooses whether reasoning summaries are requested as auto, detailed or off, and optionally shows reasoning_text when OpenAI supplies it. | `provider-picker` |
| Fast switch applies to GPT live | Pushes the fast-mode capability to a running worker before setting fast so a GPT turn is sent at priority speed on the next request. | `fast-mode` |
| Local credential for routed models | Answers the Code session credential request with a local-only token when the session's model is a catalogued routed model, so it starts without a Claude OAuth token. | `unlock-code` |
| Routes each request by model name | One local endpoint dispatches every request on its model id, so switching provider mid-session is just a model switch. | `router` |
| GPT models on ChatGPT subscription | Translates Anthropic Messages to the OpenAI Responses API and sends them to chatgpt.com on the sign-in the Codex CLI already holds, with no metered API key. | `router` |
| GPT catalogue with per-model effort tiers | Lists GPT-6.1 Sol, GPT-6 Astra, Sol and Luna, GPT-5.6 Sol, Terra and Luna, GPT-5.5 and GPT-5.4, each with the reasoning tiers it accepts. | `router` |
| Effort from model suffix or picker | Reads reasoning effort from a name like gpt-5.6-sol:xhigh or from the native effort value, strips the claude- prefix and [1m] tag, and still routes unlisted gpt slugs. | `router` |
| Unsupported reasoning effort returns 400 | A tier the chosen model does not accept is rejected with an error naming the model and tier instead of being silently changed. | `router` |
| Codex login refresh without logging out | Refreshes the rotating ChatGPT token under a file lock and writes the new refresh token back so the Codex CLI stays signed in. | `router` |
| Reasoning carried across tool turns | Encrypted reasoning items ride in each thinking block's signature and are replayed on the next request, so the router keeps no per-conversation state. | `router` |
| Reasoning summary setting | A setting picks auto, detailed or off for the reasoning summary that appears as thinking text. | `router` |
| Provider reasoning text display | A setting shows provider-supplied reasoning text inside the thinking block, labelled as OpenAI-supplied, when the provider sends it. | `router` |
| Reasoning off mode | With reasoning disabled the router sends effort none, requests no encrypted reasoning and emits no thinking block. | `router` |
| Upstream model identity logging | Logs the requested and provider-reported model and effort for each response so a silent substitution shows in the log. | `router` |
| Fast service tier follows session switch | Sends the priority tier when the session's fast switch is on and the model supports it, reading the switch on every request instead of once per turn. | `router` |
| Speed stamped into transcript usage | The tier the router sent is written as usage.speed fast or standard on every GPT response. | `router` |
| Claude Code tools usable by GPT | Function tools, tool_choice any, none or named, and parallel tool calls map onto Responses so Read, Edit, Bash and Task work unchanged. | `router` |
| Images in tool results reach GPT | An image returned by a tool is moved into a sibling image part instead of being dropped. | `router` |
| Harness context keeps developer authority | A system message that follows the user turn is sent with the developer role so the model does not answer it as a new request. | `router` |
| Anthropic web search on GPT | The Anthropic web_search tool maps to OpenAI hosted web search, including allowed_domains and approximate user location. | `router` |
| Web search results with citations | Searches return as server_tool_use and web_search_tool_result blocks followed by the answer text, with URL citations de-duplicated. | `router` |
| Web search max_uses enforced locally | The router counts searches itself because the endpoint rejects max_uses, and a turn that exceeds the limit fails with a clear error. | `router` |
| Web search blocked_domains refused | A request with blocked_domains returns 400 because the Responses API cannot enforce it. | `router` |
| Claude identity text removed for GPT | The billing-header line and the 'You are a Claude agent' line are stripped from the system prompt sent to non-Anthropic backends. | `router` |
| Stable prompt cache key per conversation | A hash of the instructions and the first user message keeps one prompt-cache key across a conversation's turns. | `router` |
| Cache namespace follows prompt policy | A policy that changes the system prompt or tool text gets its own cache namespace so it cannot read a prefix built under another policy. | `router` |
| Subagents get separate cache threads | Each conversation and subagent is sent on its own stable backend thread so parallel workers stop evicting one another's prompt cache. | `router` |
| Safety refusals shown natively | A provider cybersecurity flag comes back as a refusal stop with its category so Claude Code shows its own notice. | `router` |
| Non-streaming GPT requests supported | A caller that does not stream gets one assembled Message with usage, tool calls and refusal details. | `router` |
| Add a provider with a catalogue entry | A backend that already speaks Anthropic Messages is routed by a catalogue entry and a stored key, with no code. | `router` |
| Catalogue and key edits apply live | The catalogue and secrets files are re-read per request, and a malformed edit keeps the last good value. | `router` |
| Provider keys never exposed in health | Health reports only whether a key is ready, and file errors are reduced to fixed messages that cannot quote a credential. | `router` |
| HTTPS or loopback provider URLs only | A catalogue backend must use HTTPS or loopback HTTP, and all models of one provider must agree on its backend. | `router` |
| Unknown request fields dropped for providers | An allowlist removes Anthropic fields a compatible provider would reject, keeping the cache_control type, so a new client field cannot break a session. | `router` |
| Effort-suffixed catalogue model names | A catalogue model accepts :effort suffixes listed on its entry, matched case-insensitively. | `router` |
| Effort fields not forwarded to providers | output_config and thinking are deleted from compatible requests so a model switch cannot change the selected variant. | `router` |
| Retired Qwen aliases fail with 503 | A session still pinned to a removed Qwen alias gets a hard 503 instead of being answered by Claude under that label. | `router` |
| Provider adapter extension point | A directory under router/adapters exporting a factory can claim models, handle requests, count tokens and report limits and health. | `router` |
| Adapters own the models they claim | An adapter that claims a model handles every request for it, so a non-Anthropic model is never answered from Anthropic. | `router` |
| count_tokens 501 without adapter support | An adapter with no native counting answers 501 so the client falls back to its own estimate. | `router` |
| Shared relay kit for adapters | Retry policy, header filtering, the SSE relay, stream idle timeout and duplicate tool-call suppression are importable by adapters from relay.mjs. | `router` |
| Tool-result images hoisted for backends | An image inside a tool result is moved to a sibling image block with a note, for backends that silently drop it. | `router` |
| Adapter account pin endpoint | /poolpinz lets an adapter that offers it pin an account or return to automatic selection, and answers 501 when none does. | `router` |
| Model list includes routed models | /v1/models merges Anthropic's list with GPT, adapter and catalogue ids, including effort-suffixed spellings, so the Agent tool accepts a subagent on any of them. | `router` |
| Single-model lookups answered locally | GET /v1/models/{id} returns a synthetic entry for any routed model without asking Anthropic. | `router` |
| Anthropic requests pass through | Any model the router does not own goes to api.anthropic.com, with the request bytes unchanged unless a prompt policy rewrites the body. | `router` |
| Opus 4.6 thinking listed by hand | The thinking variant of Claude Opus 4.6 is added to the model list because Anthropic's list omits it. | `router` |
| Prompt policy profiles | A profile can append to or replace the system prompt, wrap the last user message, and prefix or suffix every tool description. | `router` |
| Prompt policy per provider and session | The active policy resolves from a session binding first, then a provider-scoped default, then the global default. | `router` |
| Prompt policy on every Messages route | The same policy transform runs on Anthropic passthrough, GPT, compatible providers and adapters that call it. | `router` |
| Policy edits apply without restart | Settings are read at request start, so an approved policy edit needs no patch or restart and does not alter a stream in flight. | `router` |
| Policy id and generation response headers | Each routed response carries X-Cuimod-Prompt-Policy-Id and -Generation so the policy that shaped it is visible. | `router` |
| Tool-less control requests never rewritten | Requests without tools resolve to the preserve policy, so only agent turns are changed. | `router` |
| Prompt policy version history retained | Up to 32 profiles, 128 retired versions and 256 session bindings are kept, and a replace policy with empty text is treated as preserve. | `router` |
| Prompt capture snapshot | A local snapshot keeps the incoming and the policy-applied system prompt and tools for the latest 24 sessions so the original is never lost. | `router` |
| Routes Command Code open-weight models | Sends DeepSeek V4.1 Flash, V4 Flash and V4 Pro, GLM 5.3 and 5.3 Flash, Kimi K3, Qwen 3.8 Max and MiniMax M3 to the Command Code API, each with a 1M-class context window. | `command-code` |
| Accepts several spellings of each model | Matches bare ids, upstream ids, claude- prefixed names, :effort suffixes and the [1m] tag, and claims any id starting deepseek or command-code. | `command-code` |
| Messages to Chat Completions translation | Converts system text, messages, tool_use and tool_result blocks and tools into OpenAI Chat Completions format with the model's upstream id. | `command-code` |
| Streaming reasoning, text and tool calls | Rebuilds the Anthropic event stream with a thinking block, then text, then tool_use blocks, closing each in order whatever order the provider interleaves them. | `command-code` |
| Non-streaming responses converted | A single Chat Completions reply becomes one Message with thinking, text and tool_use content and the matching stop reason. | `command-code` |
| Missing key answers 401 with setup hint | Without a key the adapter returns an authentication error naming COMMAND_CODE_API_KEY and the secrets entry, without exposing a path. | `command-code` |
| Key from environment or secrets file | Reads COMMAND_CODE_API_KEY first, then the command-code entry in the ignored provider secrets file. | `command-code` |
| Malformed keys treated as absent | A key containing spaces or control characters is rejected up front so it cannot leak through a header error into logs or responses. | `command-code` |
| Zero-data-retention header | Requests send x-cmd-zdr except for the one model listed as not supporting it. | `command-code` |
| Prompt policy and capture applied | Command Code requests honour the active prompt policy, return its headers, and are included in prompt capture. | `command-code` |
| Show the captured agent prompt | show prints the latest captured prompt, or the one for a given session, as JSON. | `prompt-policy.mjs` |
| Create an append or replace policy | apply writes a validated policy profile from a text file, optionally scoped to one provider or bound to one session. | `prompt-policy.mjs` |
| Restore the preserve policy | preserve resets the global, one provider or one session back to the unmodified prompt. | `prompt-policy.mjs` |
| Empty policy text refused | apply rejects an empty system file so a policy cannot silently erase the prompt. | `prompt-policy.mjs` |
| Sync catalogue limits from the registry | Rewrites a NanoGPT entry's context window and output cap from the registry the provider publishes and records its upstream id. | `nanogpt-sync.mjs` |
| Check-only mode | --check lists the changes it would make without writing the catalogue. | `nanogpt-sync.mjs` |
| Ambiguous registry match refused | A bare id matching more than one vendored deployment is left unmatched rather than syncing the wrong numbers. | `nanogpt-sync.mjs` |
| Nonzero exit on drift | Unmatched entries or pricing findings set a failing exit code so they are not skimmed past. | `nanogpt-sync.mjs` |

## Agents & automation

| feature | what it does | where |
|---|---|---|
| Subagent rail beside the transcript | Lists the session's agents in the gutter with name, elapsed time and the tool each running agent is using, and hides itself when the gutter is too narrow; the toggle key shows or hides it. | `subagents` |
| Finished agents kept as ghost rows | Finished and stopped agents stay in the rail as dimmed rows up to a limit, with a "+N more" toggle for the rest. | `subagents` |
| Nested agent hierarchy tree | Agents spawned by other agents are drawn indented under their parent, and a finished parent stays visible while one of its children runs. | `subagents` |
| Running state read from transcripts | Decides whether an agent is running, finished or stopped from its own transcript and the parent's task-notification records instead of an idle timer. | `subagents` |
| Stop an agent from its row | Hovering a running row shows a stop control that needs a second click to confirm before the agent is stopped through the app. | `subagents` |
| Agent detail sheet with full transcript | Clicking a row opens a sheet over the transcript with the agent's turns, each tool call folded together with its output and long output expandable; Escape or the toggle key closes it. | `subagents` |
| Stop-and-resume seam in transcript | A long idle gap in an agent's transcript is drawn as a labelled seam, so a stopped and resumed agent reads as one transcript. | `subagents` |
| Live tail for running agents | A running agent's sheet shows its last few actions as a tail with a blinking cursor. | `subagents` |
| At-a-glance, tools and definition cards | The sheet's side cards show state, timings, output and cache tokens, a tool-use histogram and the agent definition's description. | `subagents` |
| Agent definition model and effort shown | Shows the model and effort pinned in an agent's definition file beside its type name, read from the definition rather than the transcript. | `subagents` |
| Parent-to-agent message chat panel | Draws the assignment, SendMessage traffic in both directions and the final report between an agent and its parent as a chat column beside the transcript, with delivery status and paging of older messages. | `subagents` |
| Copy agent ID and reveal transcript | Sheet buttons copy the agent id to the clipboard and show the agent's transcript file in Explorer. | `subagents` |
| Demo data mode | Drives the rail and sheet from fabricated agents, three of them running, so the live state can be inspected without a session that has one. | `subagents` |
| Campaigns panel and draft creation | A dashboard workspace for drafting a campaign from an owner objective, workspace, workflow template, reference files, agent profiles, concurrency and attempt limits, and write and shell permissions. | `campaigns` |
| Attach a campaign to the current chat | Makes the open Desktop chat the campaign root by installing the campaign tools and hooks at an idle boundary and refreshing its CLI while keeping the same transcript. | `campaigns` |
| Campaign tools for native agents | Exposes get, plan, claim, resume, checkpoint, submit, prepare_check, verify and review tools to the root chat and its agents through an in-process MCP server. | `campaigns` |
| Tool-use guard on campaign agents | Checks every tool call to deny writes outside claimed roots, reads outside the approved workspace, shell use the owner did not allow, and worktree, cron and workflow tools. | `campaigns` |
| Source-bound candidate submission | Freezes a submitted candidate against the Git head, index, working tree and untracked files of its source roots plus evidence hashes, so later edits invalidate it. | `campaigns` |
| Revision-bound verification runs | Prepares build, test, inspection, integration or performance checks as exact native tool calls and records exit code, output and required completion markers, leaving a run without them incomplete. | `campaigns` |
| Independent review and owner acceptance | A package is accepted only by an assigned independent reviewer or the owner, against the current revision and with the required checks passed; a producer cannot accept its own work. | `campaigns` |
| Owner pause, resume and stop | The panel pauses, resumes or stops a campaign (stop asks for a second click) and cancels active native tasks, and stopping or interrupting the root chat pauses the campaign. | `campaigns` |
| Verbatim owner corrections | Corrections are stored as immutable text and move affected packages and their dependents to a new requirements version with acceptance cleared. | `campaigns` |
| Resume interrupted assignments | An interrupted assignment keeps its source ownership until the owner records a reconciliation, and can then be resumed in the same native agent through a reserved SendMessage. | `campaigns` |
| Agent completion read from receipts | Tracks native agent finish, failure and cancellation from task-notification receipts in the root transcript, and marks launch failures and closed transports as unknown or interrupted. | `campaigns` |
| Work packages with dependency gating | Plans packages with implementation and acceptance dependencies, rejects cycles, enforces the concurrency and attempt limits and refuses overlapping write roots. | `campaigns` |
| Package cards and evidence links | Each package card shows requirements, dependencies, roots, latest candidate, verification records, reviews and assignments, and evidence files open directly only for inert types and are otherwise revealed in Explorer. | `campaigns` |
| Legacy campaigns kept read-only | Earlier session-based campaigns are shown read-only with their preserved results and evidence and cannot be started or resumed. | `campaigns` |
| Re-read instructions after compaction | After a context compaction the root and its agents must read campaign.get again before further tool calls are allowed. | `campaigns` |
| Goal band above the composer | Shows the armed goal, a check-in count and the evaluator's latest verdict in a band above the composer, coloured for armed, met and failed. | `goal` |
| Full check-in verdict history | Expanding the band lists every evaluator verdict newest first, with iterations, duration and tokens for each. | `goal` |
| Goal outcome display and re-arm | Shows met, impossible, cleared and error outcomes for a configurable time and can offer a one-click re-arm or re-arm automatically after an error clear. | `goal` |
| Spoken chat summary read aloud | Saying "summarize this chat" sends the recent transcript to a local text model and speaks the result with a local text-to-speech voice, and the microphone button stops playback. | `voice-agent` |
| Spoken "stop the agent" command | Saying "stop the agent" interrupts the current turn of the targeted Desktop session. | `voice-agent` |
| Task rail beside the composer | Pins the session's task list in the gutter beside the composer with status dots, an open/total count, owner and blocked-by tags, and hides when the gutter is too narrow. | `task-rail` |
| Hover card with full task description | Hovering a task opens a card with its full description and a "Show more" control for long text. | `task-rail` |
| Collapse rail and toggle descriptions | Header buttons minimize the rail to the composer's height or show descriptions inline, and both choices persist. | `task-rail` |
| Open the session's tasks folder | A footer link shows the session id and opens the folder holding that session's task files. | `task-rail` |
| Cheap-tier default for subagents | Points subagents that name no model at Sonnet 5.5 on Claude sessions and GPT-5.6 Luna on GPT sessions unless the launch environment already sets one. | `provider-routing` |
| Windows Computer Use switch | Turns the native Windows Computer Use backend on or off live, with Background or Full Control capture and auto-unhide of minimized windows, persisted to claude_desktop_config.json. | `computer-use` |
| Subagent #fast launch marker | A subagent runs on the priority tier only when its launch prompt starts with a #fast line, which is removed before the model sees it. | `router` |
| Deferred tools loaded without cache loss | Tools marked defer_loading stay out of tools[] and are loaded in the input through additional_tools when a message references them. | `router` |
| Withdrawn tools announced to the model | A removed deferred tool is announced as no longer available instead of rewriting earlier history and breaking the cache. | `router` |
| Auto-mode classifier follows session model | A tool-less security-monitor request inherits the session agent's non-Anthropic model instead of reverting to Claude. | `router` |
| Reset-credit state endpoint | GET /resetz reports the credit count, whether a window is exhausted, the last redemption and recent attempts. | `router` |
| Reset credit spent only on exhaustion | POST /resetz redeems a credit only when a window is at its limit and a credit exists unless force=1, and the router never redeems on its own. | `router` |
| Reset redemption is idempotent | The idempotency key derives from the exhausted window and a journal survives worker swaps, so a burst of 429s cannot spend two credits, and a five-minute cooldown adds a second guard. | `router` |
| Main and subagent lanes separated | Requests are labelled main or subagent from the billing header so rates and summaries can be split by lane. | `router` |
| Per-agent rate lanes | Joins router response ids to the CLI transcript so each rate is attributed to the main session or to the named subagent that produced it, rolled up per lane. | `throughput` |

## Usage, limits & context

| feature | what it does | where |
|---|---|---|
| Per-account weekly usage meters | Shows each OpenAI account's weekly usage percentage, a progress bar and its reset time, cached for five minutes. | `provider-picker` |
| Automatic OpenAI account switching | Moves the next GPT request to the account with the lowest weekly usage once the active account passes a configurable threshold, checked every five minutes. | `provider-picker` |
| 1M token ceiling on launched workers | Sets every launched worker's maximum context tokens to 1,000,000 so catalogued long-context models are not held to Claude Code's default guard. | `provider-routing` |
| Codex checkpoint compaction for GPT | Replaces Claude Code's text-only summary with Codex V2 encrypted checkpoints on GPT sessions, with a choice of the current model or a fixed GPT model to compact. | `compaction-provider` |
| Portable compaction fallback | Stores a readable handoff beside each encrypted checkpoint so a session can switch to another provider after compaction. | `compaction-provider` |
| Checkpoint status card | Shows the latest checkpoint's creation time, source model, retained items, encrypted size and fallback size for the open session. | `compaction-provider` |
| Codex context management channel | Master switch for Codex notes, history and window resets on GPT sessions, with a ceiling on tool output size applied by the backend before encryption. | `context-management` |
| Server-side notes scratchpad | Gives the model notes tools whose contents survive a window reset and stay encrypted, so they never reach this machine. | `context-management` |
| Context budget guidance | Injects reminders that budget against the earlier of the auto-compact trigger and the model ceiling, minus Codex's fallback buffer. | `context-management` |
| Context window reset | Lets the model call new_context and applies manual, automatic and exhausted-window resets without summarizing. | `context-management` |
| Transcript archive and search | Asks OpenAI to ingest and index the thread and gives the model four tools to search it; off by default because the transcript is kept on their servers. | `context-management` |
| Context window status card | Shows the session's window id, resets and their causes, tool calls, remaining budget and recent model notes, plus a warning when the Codex client version has drifted. | `context-management` |
| Auto-compact for new workers | Sets whether newly launched workers auto-compact, and removes the DISABLE_COMPACT and DISABLE_AUTO_COMPACT environment gates so a session can opt in or out live. | `auto-compact` |
| Compaction window per model | Sets the launch compaction window from 200k to 1M tokens per model, with a fallback slider, using a table of every catalogued and native model. | `auto-compact` |
| Precompute compaction summaries | Requests Claude Code's precomputed compaction summaries on or off at launch, or leaves its default. | `auto-compact` |
| Live worker state and window override | Reads the displayed worker's reported compaction state and offers controls to change its auto-compact switch or window without a restart. | `auto-compact` |
| Native token counts for catalogue providers | Count requests go to the provider's own count_tokens endpoint, are cached for five minutes, and carry headers naming the source and whether the count is exact. | `router` |
| Catalogue providers feed accounting | Each completed compatible-provider response records exact token usage and generation rate like every other route. | `router` |
| Adapters register their own pricing | An adapter can add dated per-model rates at load so its traffic is priced in the same table. | `router` |
| Adapter limits and health in router payloads | Each adapter's quota snapshot appears under its own key in /limitsz and its readiness in /healthz, with one adapter's error kept to its own slot. | `router` |
| Anthropic usage and rate recorded | Passthrough responses write exact token usage and generation rate under the claude provider. | `router` |
| Router markers stripped on model switch | Compaction and context-reset markers are removed before a request reaches Anthropic, an adapter or a compatible provider. | `router` |
| Codex-style remote compaction for GPT | Claude Code's compaction request is answered by the provider's compaction endpoint and stored as an opaque checkpoint. | `router` |
| Checkpoint markers restore full history | A marker in the transcript is swapped back for the stored checkpoint on later requests, and an unknown marker only loses its text. | `router` |
| Portable fallback summary | Compaction also renders a plain-text handoff so the conversation can continue on a model that cannot read the checkpoint. | `router` |
| Recent user messages retained | Up to 64,000 tokens of the newest user messages are kept beside the checkpoint, truncated to fit. | `router` |
| Compaction strategy and model settings | Settings choose the Codex or native strategy, a portable-fallback toggle, and the current model or a named GPT model for compaction. | `router` |
| Native summary fallback on 400 or 404 | If the provider's compaction endpoint is unavailable, Claude Code's own summary path runs instead. | `router` |
| Compaction fails closed on protocol errors | A malformed or empty successful compaction response returns 502 instead of replacing context with an empty result. | `router` |
| /compactionz checkpoint status | Returns compaction settings and, per session, the checkpoint count and the latest checkpoint's size and model. | `router` |
| Compaction spend recorded | The remote compaction and fallback responses are written to accounting with their exact usage. | `router` |
| Codex context management for Claude Code | Runs Codex's notes, history and context-window features from the router so a GPT session can carry state across windows. | `router` |
| Model-only notes and history tools | Nine notes and history tools are offered to the model, executed by the router and hidden from Claude Code. | `router` |
| Model-started new context window | A new_context tool lets the model start a fresh window, and the router drops history up to a digest-checked anchor message. | `router` |
| Compaction becomes a window reset | With window reset on, manual and automatic compaction start a new window without asking a model to summarize. | `router` |
| Budget reminder near window end | When remaining tokens fall under the reminder threshold the model gets a one-time reminder to save notes and start a new window. | `router` |
| Last-round prompt, then forced reset | After the base limit the model gets one last prompt to save notes, and at the force limit the router rotates the window before the last user message. | `router` |
| Budget follows Claude auto-compact window | Limits use the earlier of the model window and the configured auto-compact window less Claude Code's fixed reserve. | `router` |
| Window size read from live models list | The usable context size comes from the provider's models list at 95 percent by default, falling back to the built-in catalogue. | `router` |
| Thread hint shown to the model | The one plaintext notes route is fetched and placed in the window message so the model sees what it saved. | `router` |
| Secrecy text removed, disclosure permitted | Upstream instructions to hide notes from the user are stripped and a message tells the model it may discuss them when asked. | `router` |
| Opt-in history ingestion | With history tools on, turn metadata asks the backend to ingest and index the thread so four history tools can search it. | `router` |
| Separate context management switches | Enabled, notes, history, reminders, window reset and a 1,000 to 100,000 byte tool-output limit are set independently, with enabled, window reset and history off by default. | `router` |
| Notes isolated per agent | Subagent requests skip context management and legacy mixed stores are quarantined so notes belong to one root agent. | `router` |
| Model-only tool round cap | After eight model-only rounds in one turn the last round is served without those tools so the model must answer. | `router` |
| Upstream drift warning | A changed budget field set, a missing token_budget block or a concealment pass that matched nothing is reported as drift. | `router` |
| /contextz window status | Returns context settings, window ids and reset counts by cause, the thread hint, drift and the last error for a session. | `router` |
| Local token count for GPT | count_tokens is answered by a local o200k_base estimate because the OAuth endpoint exposes no count, labelled by a response header. | `router` |
| Image-aware token sizing | Screenshots in tool results are sized from PNG, JPEG, GIF or WebP dimensions using the current GPT vision rules. | `router` |
| Counts reflect the active window cut | The estimate uses the same post-reset transcript inference will send, so a reset does not immediately trigger another compaction. | `router` |
| Large counts sampled, not frozen | Text over 64 KB is sampled and chunked so a huge count request cannot stall every stream. | `router` |
| Usage Atlas dashboard | A local page at /usage/ shows quota meters, forecasts, token totals, API-equivalent spend and rates from the router's own records. | `router` |
| Dashboard served loopback with strict CSP | The dashboard is served only to local clients with a default-deny content security policy, no framing and no referrer. | `router` |
| Atlas provider filter | Filter buttons are built from whichever providers appear in the payload, and a filter whose provider vanishes resets to All. | `router` |
| Atlas time range selector | A picker switches the totals between today, 7, 30 and 90 days, and all time. | `router` |
| Atlas projection horizon selector | A picker sets how far ahead the forecast cards project, using the horizons the payload provides. | `router` |
| Atlas summary cards | Five cards show providers with data, exact tokens, next exhaustion, cache-read tokens and API-equivalent spend for the selected range. | `router` |
| Atlas quota forecast cards | Each live meter shows percent used, burn rate, projected use, outlook, confidence, sample count, age and the tokens-per-percent estimate. | `router` |
| Atlas utilization sparklines | Meters draw a utilization history line with a hover crosshair and an expandable table of the underlying values. | `router` |
| Atlas per-model token bars | Bars rank models by exact input-context plus output tokens, with response count and cost beside each. | `router` |
| Atlas daily token timeline | A column chart of daily tokens with tooltips and a table of daily values, on UTC dates. | `router` |
| Atlas data source freshness | Lists each provider's quota source, how old its snapshot is, and any error it reported. | `router` |
| Atlas API-equivalent spend breakdown | Shows spend by provider and by model, split into input, cache read, cache write and output, and marks unpriced responses instead of counting them as free. | `router` |
| Atlas rate card | Lists every published rate period per model with its in-force dates and the price table fingerprint. | `router` |
| Atlas upstream attempts panel | When an adapter reports its own billing, a table shows requests, tokens and spend the provider counted, including retries and cancelled requests. | `router` |
| Atlas account pool control panel | When an adapter exposes account pinning, the page offers Auto and per-account buttons and shows whether the choice was verified. | `router` |
| Atlas accounts and windows table | Lists every quota window with account, status, used and remaining percent, rate, reset time, tokens per percent and freshness. | `router` |
| Atlas window search and compact rows | A search box filters windows by account, model or quota, and a toggle switches the table between comfortable and compact rows. | `router` |
| Atlas recent response audit trail | A collapsible table shows recent exact responses with time, provider, model, session, input context, output, reasoning and source. | `router` |
| Atlas copy as TSV or JSON | Spend, accounts and audit data can be copied as TSV or JSON, and the whole snapshot or a single row can be copied too. | `router` |
| Atlas refresh and R shortcut | The page reloads every 60 seconds, and Refresh upstream or the R key forces a fresh provider read. | `router` |
| Atlas keeps last snapshot on failure | A failed or timed-out refresh shows a notice and keeps the last good snapshot marked stale. | `router` |
| Atlas range note on import and backups | Notes whether earlier records are still importing, any accounting error, and when backups share the store's volume. | `router` |
| Atlas keyboard and reduced-motion support | Pickers are keyboard-navigable listboxes, a skip link is provided, and animation is disabled for reduced-motion users. | `router` |
| Atlas polling preserves focus and scroll | Updates patch the page in place so focus, scroll position and expanded sections survive each poll. | `router` |
| /usage/api combined snapshot | Joins quota meters, forecasts, token usage, pricing and, for a range, accounting totals into one JSON payload. | `router` |
| Range-scoped usage totals | The range parameter of today, 7d, 30d, 90d or all, with a timezone offset, replaces totals, cost, models and daily timeline from the permanent store. | `router` |
| Live usage snapshot skips the archive | A request with no range returns current limits without scanning the accounting archive, so the in-app bar stays cheap. | `router` |
| Claude-only usage scope | scope=claude returns the Claude plan meters without any provider call. | `router` |
| /usagez exact token ledger | Returns exact per-model and per-session token totals and recent responses, optionally for one session. | `router` |
| /limitsz provider quota snapshot | Returns sanitized ChatGPT plan windows plus every adapter's limits, cached for 60 seconds unless force=1. | `router` |
| ChatGPT plan windows and credits | Reads primary and secondary windows, additional per-feature limits, reset-credit count and credit balance from the plan's usage endpoint. | `router` |
| Quota burn-rate forecasts | Derives rate, projections at 5 to 120 minutes and an exhaustion estimate versus reset from observed meter movement, with a confidence grade. | `router` |
| Forecast ignores previous windows | Samples from before a detected or provider-stated window reset are cut so a reset does not read as negative burn. | `router` |
| Tokens-per-percent calibration | Matches exact token records to quota movement to estimate how many tokens one percent of a window costs. | `router` |
| Claude plan meters with reset times | Reads Desktop's plan usage history for the five-hour, weekly, per-model and extra-usage buckets and attaches reset times from a separate file. | `router` |
| Per-model weekly Claude limits | Scoped weekly limits for a model appear as their own meters and inherit the weekly reset time. | `router` |
| Account meters and pool averages | Any provider whose limits carry an accounts array gets per-account meters plus a pool average per model. | `router` |
| Bounded quota history for forecasts | Recent observations are kept in a capped file with a five-minute heartbeat for unchanged values, and versioned quota units never mix. | `router` |
| Generation-rate ledger | Each completed response is recorded with clocks and token counts only, never prompts or credentials. | `router` |
| First-byte, first-token and stream timing | Records time to headers, time to first content and generation time separately, plus output and end-to-end tokens per second. | `router` |
| Live in-flight stream rates | /throughputz lists streams in progress with observed or character-calibrated estimated tokens per second beside completed-response summaries. | `router` |
| Throughput history query | /throughput/api filters records by session, provider, model, lane and time range and summarizes them as p50, p90 and sustained rates. | `router` |
| Truncated streams leave no rate | A response that never reached terminal usage records nothing, so a disconnect is not measured as a slow model. | `router` |
| Exact usage ledger per response | Writes one durable record of provider-reported terminal usage per response, deduplicated by provider and response id. | `router` |
| Cache-write lifetime and reasoning split | Token records keep the 5-minute versus 1-hour cache-write split and reasoning versus visible output tokens when the provider reports them. | `router` |
| Permanent usage accounting | Raw daily segments of token events and quota observations are kept, with rollups and indexes derived from them. | `router` |
| No content or credentials in accounting | An allowlist keeps only token counts, ids and quota fields, so provider additions are dropped rather than persisted. | `router` |
| Importing older ledgers | The v1 usage and limit ledgers and Claude's plan history are imported incrementally by byte cursor and absorbed by deduplication. | `router` |
| Range queries from rollups | Today, 7-day, 30-day, 90-day and all-time windows use daily rollups and scan only the partial start day. | `router` |
| Quota history across ranges | Daily quota aggregates with min, max, last value and reset counts feed the meter sparklines for wide ranges. | `router` |
| Accounting storage status | Reports migration progress, first and last record, spooled and repaired counts, last error and whether backups share the store's volume. | `router` |
| Compressed ledger archives replay transparently | Rotated gzip archives sit beside the active JSONL file and are read oldest first, so rotation changes storage only. | `router` |
| API-equivalent cost from a rate table | Prices recorded tokens at published per-million rates for OpenAI, Anthropic and catalogue models, recomputed on every read and never stored. | `router` |
| Dated rate windows | Each rate carries the dates it was in force, so an older record is priced at its own date's rate. | `router` |
| Cache-write pricing by lifetime | Cache writes are priced at the 5-minute or 1-hour rate, with unsplit records priced at the provider's measured default. | `router` |
| Unpriced models shown as a gap | A model with no rate is counted as unpriced instead of contributing zero cost. | `router` |
| Dated model ids price as family | A -YYYYMMDD snapshot suffix is dropped when looking up a rate, and an unrecognised model is left unpriced. | `router` |
| Price table fingerprint | A short hash of the rate table is shown beside spend so a price edit is identifiable. | `router` |
| Exact usage recorded per response | Provider-reported prompt, completion, cached and reasoning tokens are written to accounting as exact usage. | `command-code` |
| Generation rate recorded | Each response feeds the throughput ledger with first-byte, first-token and completion timing. | `command-code` |
| Command Code plan limits in /limitsz | Reads credits, five-hour and weekly windows, subscription period and org spend limits and exposes only sanitized fields. | `command-code` |
| Credit balance summed by source | Monthly, purchased and free credits are reported separately and as a total remaining. | `command-code` |
| Limits tolerate a failed sub-request | If identity, credits or subscription lookups fail, the rest still returns with an errors map naming what failed. | `command-code` |
| Market rates registered for pricing | Per-million input, cache-read and output rates for each routed model are added to the API-equivalent rate table. | `command-code` |
| Character-based token estimate | count_tokens returns an estimate of roughly one token per 3.5 characters, labelled with a command-code.estimate source header. | `command-code` |
| Pricing drift report | Compares registry rates with the router's rate table and prints the exact block to apply for an unpriced or drifted model. | `nanogpt-sync.mjs` |
| Verify sealed segments | verify hashes each sealed day against its manifest and reports missing segments and mismatches, read-only. | `provider-accounting.mjs` |
| Rebuild derived indexes | rebuild regenerates dedupe indexes and rollups from the raw segments under the accounting lock. | `provider-accounting.mjs` |
| Seal finished days and back them up | seal writes a hash manifest for every closed UTC day and copies segments, seals and rollups to the backup root. | `provider-accounting.mjs` |
| Migrate legacy ledgers | migrate imports the v1 ledgers and Claude plan history, and --dry-run previews the counts without importing. | `provider-accounting.mjs` |
| Export a range's totals | export writes one range's totals, providers, models and daily timeline to a JSON file. | `provider-accounting.mjs` |
| Recover closed segments from backup | recover restores a missing or corrupt closed segment, quarantines the live copy it replaces, and refuses the active day. | `provider-accounting.mjs` |
| Accounting status and JSON output | status prints the response count, first record and whether the backup is on another drive, and --json emits machine-readable output. | `provider-accounting.mjs` |
| Raw segments never deleted | No subcommand deletes raw segments, so every derived store can be rebuilt from them. | `provider-accounting.mjs` |
| Adapters can add billing to usage payload | An adapter that holds its own upstream billing can decorate the ranged usage payload, which the Atlas shows as an extra table. | `router` |
| Context size reports one prompt, not rounds | Terminal input usage is the current context snapshot, with hidden model-only rounds accounted separately so one prompt is not shown as several times larger. | `router` |
| Final usage replaces provisional zero input | Exact input usage is sent in the closing message_delta, so the transcript does not keep claiming a GPT prompt cost no input. | `router` |
| Cached tokens reported as cache reads | OpenAI cached input tokens are mapped to cache_read_input_tokens and subtracted from input, with reasoning tokens kept as thinking tokens. | `router` |
| Provider-aware native usage ring | Recolours and refills the app's own usage ring and its aria label from the selected model's account quota (Claude plan, OpenAI, or an adapter's pool) instead of the stock reading. | `usage-bar` |
| Per-model limit rows in usage popover | Replaces the usage popover's plan bars with progress rows for the selected model's windows, including model-scoped weekly limits read from the page's live state, and hides the popover's duplicate context block. | `usage-bar` |
| Burn-rate and ETA under each limit | Each limit row shows the router's forecast as percent per minute, time until exhaustion or 'reset wins', and tokens per 1 percent of quota. | `usage-bar` |
| Open Usage Atlas link | A link in the usage popover header opens the router's /usage/ analytics page in the default browser. | `usage-bar` |
| Composer context meter | A small bar in the composer footer shows context used against the model's window from the CLI's own usage reply, colour-tiered by fill and with a mark where auto-compact fires; its length, thickness, spacing, idle opacity, thresholds and colours are configurable. | `usage-bar` |
| Per-session auto-compact toggle | A button beside the context meter turns auto-compact on or off for the current session through the auto-compact worker and reports when the worker confirms the change. | `usage-bar` |
| Hide the app's usage band | An optional toggle that hides the app's own usage-limit banner above the composer (hide-usage-band is the separate keyword-driven version of the same idea). | `usage-bar` |
| Heavy-context warning pill | A floating pill that only exists once the session carries 300k tokens, escalates to a pulsing critical tier at 500k, and can be dismissed until context grows by a set step; thresholds, wording, corner, size and colours are configurable. | `context-pill` |
| Generation-rate readout panel | A dashboard panel showing live tokens per second for in-flight streams, recent responses and per-model rollups, with in-flight estimates marked est and exact provider-count rates for finished responses. | `throughput` |
| Show ledger in folder button | A footer button in the throughput panel reveals the router's throughput ledger file in the file manager. | `throughput` |
| Claude plan-limit capture | Observes the app's own plan-usage response and persists each window's reset time, utilisation and per-model weekly limits to .state/claude-plan-resets.json, which the router's analytics read for the quota meter and forecasts. | `plan-usage-capture` |
| Usage banner cleaner | Hides, collapses, dims or strips the action button from weekly, session and general usage-limit banners above the composer, matched by wording or custom keywords; ships off. | `hide-usage-band` |

## Composer & session

| feature | what it does | where |
|---|---|---|
| Set, edit and clear a goal mid-turn | The band's editor sends /goal as a steer at next priority, so a goal can be set, edited or cleared without interrupting the running turn. | `goal` |
| Take over /goal in the composer | Pressing Enter on /goal routes it through the band, and a bare /goal opens the band or an empty editor. | `goal` |
| Enter queues messages mid-turn | While a turn is running, Enter moves the composer text into a send queue instead of steering the model immediately. | `queue` |
| Send button queues mid-turn | The composer's send button queues the message while a turn is running, using the same rule as Enter. | `queue` |
| Queue rail above the composer | A rail above the prompt box lists queued messages in order with a queued counter and image counts, and narrows to avoid the side chat. | `queue` |
| Auto-send at turn end | Releases the first queued message once the turn has fully ended, after a grace delay, from the main process regardless of window focus. | `queue` |
| Steer a queued message now | A queued message can be injected into the running turn immediately, backgrounding a running Bash or Agent call or ending the turn where it stands so the steer is read at once. | `queue` |
| Edit a queued message in the composer | Loads a queued message back into the composer for editing, relabels the send control "update queued", and commits or drops it on Enter. | `queue` |
| Two-click remove for queued items | The trash control on a queued row arms on the first click and removes the item on a second click within three seconds. | `queue` |
| Queue persists across restarts | Keeps each session's queue on disk with atomic writes, shares it between windows and flushes a sent item at once so it is not sent twice after a crash. | `queue` |
| Images queued with text | Up to five png, jpeg, gif or webp images are queued with a message and restored to the composer attachment shelf on edit or send. | `queue` |
| Host slash commands bypass the queue | Commands the app handles itself, such as /model, /btw and /config, run in place instead of being queued as literal prompt text. | `queue` |
| Local dictation replaces native dictation | Captures the app's microphone button before its cloud speech relay can start and hands it to a local companion; click to start and stop, Escape cancels. | `voice-agent` |
| Dictated segments appended to composer | Completed dictation segments are inserted into the main composer as they arrive, with spacing and line breaks preserved. | `voice-agent` |
| Wake phrase voice commands | Saying the wake phrase followed by a prompt submits it to the most recently focused Claude Code session, with the wake phrase configurable. | `voice-agent` |
| Send or draft after a voice command | Chooses whether a wake command is sent to the active chat immediately or left as a draft in the composer. | `voice-agent` |
| Spoken stop phrase | A configurable phrase, "green apple" by default, ends dictation or a wake command at the first word of the phrase and drops the phrase and what follows. | `voice-agent` |
| Acoustic delivery context on prompts | Optionally attaches a short non-instructional note of speaker-relative delivery and gated coarse emotion, inferred from the audio, to voice prompts and dictation. | `voice-agent` |
| Start and accepted sound cues | Plays optional local start and accepted sounds without pausing capture. | `voice-agent` |
| Durable audio archive and retention | Keeps spoken utterances and optional continuous journal chunks, ships verified FLAC to the compute host's archive, and prunes local audio after a retention period. | `voice-agent` |
| Voice status pill and live panel | A compact indicator beside the microphone shows health, listening state and a level meter, and the settings panel shows live capture, transcriber and compute status. | `voice-agent` |
| At-most-once voice delivery | Persists a delivery cursor and holds an outcome that crossed a process boundary as uncertain instead of sending the same voice prompt twice. | `voice-agent` |
| Clipboard fallback for lost targets | A voice prompt whose chat disappeared before send is copied to the clipboard with the system alert sound and an in-app toast. | `voice-agent` |
| Voice prompts into a fresh chat | A wake command spoken in a new-chat view is typed into that composer and submitted there, and is not delivered to an unrelated existing session. | `voice-agent` |
| Local speech recognition with fallback | Transcribes with a local Whisper model, rechecks low-confidence results with a smaller model, and runs a separate lightweight lane for wake and stop detection while capture continues. | `voice-agent` |
| Companion service connection | The plugin talks to the local companion over an authenticated loopback port, which supervises an SSH tunnel to the compute service; the port is configurable. | `voice-agent` |
| Crash-safe capture and retry | A separate recorder process spools raw audio to disk, crash leftovers are wrapped into WAV files at startup, and failed recognition jobs are retried from durable files. | `voice-agent` |
| Microphone device selection | Uses the operating system default microphone through WASAPI, with a device list command and an inputDevice setting to choose another. | `voice-agent` |
| Workstation and compute installers | Installer scripts set up the workstation companion as a scheduled task and the compute and prosody services as user systemd units. | `voice-agent` |

## Transcript & appearance

| feature | what it does | where |
|---|---|---|
| Readable formatting of agent messages | Splits agent-to-agent messages into sentences, turns inline numbered runs into lists, dims long asides and shortens long paths and commit ids with the full text on hover. | `subagents` |
| Show agent thinking blocks | Optionally includes the agent's thinking blocks in its transcript view. | `subagents` |
| Copy transcript button and hotkey | A corner button and Alt+Shift+C put the whole session on the clipboard as one role-tagged block, strip control characters that would truncate a Windows paste, and report entries and size in a toast. | `transcript-copy` |
| Copy delta since the previous export | A second button and Alt+Shift+D copy only entries after the previous export, found by lining the clipboard transcript up against the session or from a stored mark, and refuse rather than copy everything when neither aligns. | `transcript-copy` |
| Delta hover peek | Hovering the delta button shows how many new entries and bytes it would copy and dims the button when nothing is new. | `transcript-copy` |
| Thinking and tool traffic in export | Includes the reasoning blocks and the full tool calls and results that the app's own copy leaves out. | `transcript-copy` |
| Injected context tagged separately | Marks skill bodies, system reminders and harness bookkeeping as system context rather than as the user's words, and leaves them out by default. | `transcript-copy` |
| Subagent transcripts appended to export | Optionally appends each agent that ran under the session, in spawn order, as its own block with its name. | `transcript-copy` |
| Image handling in export | Images appear as a note with size, as full base64 data URIs, or are left out. | `transcript-copy` |
| Tag or markdown export format | Chooses tag or markdown formatting and toggles the legend line, timestamps and model and effort labels. | `transcript-copy` |
| Length caps and tail limit | Caps tool input, tool result and message length and can keep only the last N entries. | `transcript-copy` |
| Sample output preview | The settings panel shows the formatter's output for a fixed seven-line transcript so option changes can be judged. | `transcript-copy` |
| Atlas light and dark theme | A toggle switches theme and remembers the choice in the browser. | `router` |
| tok/s chip in streaming strip | Adds a tokens-per-second chip beside the app's own elapsed and token counts while a turn runs, holding the last response's exact rate between tool calls. | `throughput` |
| Default transcript view per session | Switches a session to the chosen transcript view (Thinking by default) the first time it appears in a window, once per session so a manual switch afterwards sticks. | `thinking-default` |
| Thinking block typography and framing | Restyles thinking blocks with a chosen typeface, size, line height, measure, left spine, indent, brightened first line and a small 'thinking' label, following theme colours or custom ones. | `thinking-style` |
| Inline Markdown in thinking blocks | Renders inline code, fenced code, bold, italic, strikethrough and HTTPS links inside thinking text without changing the block's layout. | `thinking-style` |
| Transcript typeface and size | Sets the typeface, size and line height of normal transcript text by redefining the app's own chat typography tokens so derived sizes stay consistent. | `transcript-type` |
| Model name in waiting status | Rewrites the native 'Waiting for Claude...' status to name the main session's selected model while a turn waits for inference. | `waiting-label` |
| Spark marks replaced with helmet art | Replaces the app's Spark marks, static and animated, with a bundled helmet SVG whose accent colour is a live setting. | `branding` |
| Page icon replaced with helmet | Points every link rel=icon in the page at the recoloured helmet and restores the originals when disabled. | `branding` |
| New-session composer scene art | Draws a bundled scene SVG above the right end of the composer on the new-session screen. | `branding` |
| Branding art reloads on SVG edit | Saving either bundled SVG validates it and reloads the renderer so the new art appears without a restart. | `branding` |
| Insert-key settings overlay | Pressing Insert opens a settings overlay for every plugin that registers a panel, and Insert, Esc or a click on the dim area closes it while the app's shortcuts stay blocked underneath. | `dashboard` |
| Plugin sidebar and grouped pages | A scrolling sidebar lists each registered plugin with its control count, and each plugin's page lays its controls out in titled groups with hints. | `dashboard` |
| In-panel toggle, slider, combo, text controls | Toggles, sliders, keyboard-navigable dropdowns and text or number fields are drawn inside the panel rather than as OS-drawn popups, and plugins can also supply their own custom control node. | `dashboard` |
| HSV colour picker | Colour settings open a saturation, hue and hex-field picker that updates the live setting as it is dragged. | `dashboard` |
| Copy and paste menus in settings | Right-clicking a colour swatch or a text field shows a styled copy and paste menu that reads and writes the clipboard through the main process, and the app's own context menu is suppressed in the overlay. | `dashboard` |
| Draggable before/after preview frames | A plugin's page can show floating before and after frames rendered with the plugin's own live CSS, draggable by title bar with positions remembered and a Preview button to collapse them. | `dashboard` |
| Two-click reset to defaults | A per-plugin Reset defaults button arms on the first click and only deletes that plugin's saved settings on a second click within three seconds. | `dashboard` |
| Persistent settings store | Every plugin's settings are saved as debounced, atomic writes to .state/settings.json, applied live on edit, and acknowledged with a brief 'saved' tag. | `dashboard` |

## Desktop bug fixes

| feature | what it does | where |
|---|---|---|
| Goal stays visible through interrupts | Reads the goal from the CLI transcript instead of the app's stream state, so interrupting a turn no longer makes the goal look cleared. | `goal` |
| Block the app's plan-pane auto-open | Pre-marks each session in the app's own store so the Plan pane no longer opens itself on a session's first task, while opening it by hand still works. | `task-rail` |
| Fast switch restored for Opus 5.5 | Adds the Fast switch to claude-opus-5-5, which the server's model list omits even though the CLI supports fast mode for it. | `provider-picker` |
| Compacting indicator stays visible | Moves the Code UI's five-minute pending-response cap out of the way for a compact turn so the Compacting session row does not vanish while the worker is still running. | `compaction-provider` |
| Session model and effort lock | Refuses the app's automatic write that resets a provider session to the account's stored Claude model or effort, while picker changes and /model still pass. | `model-lock` |
| Live model switch without CLI probe | Names the target model in modelPicker before a live switch so Claude Code skips its five-second validation probe, which slow routed models fail. | `model-probe-skip` |
| Per-session fast switch | Records each session's fast value, restores it into the composer switch when that session is shown, and keeps the draft composer's value for the next new session. | `fast-mode` |
| Correct assistant message ages | Replaces the relative time on assistant rows with the age from each message's own CLI transcript record, because the app otherwise dates a merged entry from its latest background task event. | `message-time` |
| Classic outlined stop mark | Restores the quiet outlined stop glyph inside the Code composer's stop button while the app keeps the button and the interrupt action. | `classic-stop` |
| Open files outside session roots | When the file pane's read handler answers notFound for an absolute path that exists on disk, answers with the shell's own response shape so the file renders, refusing UNC and device paths and capping reads at 10 MB. | `file-pane-access` |
| Resolve bare and relative file links | Finds files named by a bare name, an editor-style :line suffix or a path relative to a parent directory by trying the granted roots, the newest absolute mention in the session transcript, the roots' ancestors, and finally git-tracked files. | `file-pane-access` |
| Composer ghost-text suggestions off | Sets the CLI's own kill switch for every future worker and patches running workers so Claude Code stops spending a second full-context request on predicted composer text. | `prompt-suggestions-off` |

## Unlocks

| feature | what it does | where |
|---|---|---|
| Max 20x capability spoof | Adds Claude Code and Max capabilities and the default_claude_max_20x tier to the account record the page holds, so the Code view and gated controls open. | `unlock-code` |
| Upgrade-locked models enabled | Clears the upgrade-required disabled state and upgrade notice from model selector rows. | `unlock-code` |
| Paywall takeover modal hidden | Hides the marketing discovery takeover modal with a stylesheet rule. | `unlock-code` |
| Upsell banners and popups hidden | Hides the overage upsell skeleton, upsell banners and the free-limit Pro offer with a stylesheet rule. | `unlock-code` |
| Agent-to-agent SendMessage unbanned | Neutralises the registry-level ban and the call-site deny on SendMessage so the tool appears and works between agents. | `patch.js` |
| Live injector self-test | selftest exercises signal, attach, evaluate and inspector close on a throwaway node process and touches nothing else. | `live-inject.js` |
| Read-only probe of the running app | probe finds the Electron main process and reports versions, app path and claude.ai views without changing anything. | `live-inject.js` |
| Inject and remove live without patching | apply evaluates the live driver in the running main process over CDP and stop removes it, but only against a Claude started with --inspect. | `live-inject.js` |
| Inspector closed after use | The target is asked to close its inspector once the session ends so the debug port does not stay open. | `live-inject.js` |
| Agent-to-agent SendMessage unlocked | Removes Desktop's blanket SendMessage ban at both layers, the disallowedTools append and the PreToolUse deny, through patch.js on the next launch and through a hot patch of already-running sessions so in-flight agents survive. | `sendmessage-unban` |

## Router & reliability

| feature | what it does | where |
|---|---|---|
| OpenAI response identity logging | Records the requested and response-reported model and effort in bridge.log without prompt text or credentials. | `provider-picker` |
| Sessions routed through local router | Rewrites the spawn of every Claude Code worker so its Anthropic base URL points at the local router on port 8789. | `provider-routing` |
| Router auto-start and keepalive | Probes the router supervisor every ten seconds and launches it hidden when it is not answering. | `provider-routing` |
| WebFetch without Anthropic preflight | Skips the Anthropic domain-reputation lookup before WebFetch and removes the CCR proxy variables so WebFetch and WebSearch run locally. | `provider-routing` |
| A broken adapter is skipped | An adapter that fails to import, throws or lacks claims or handle is listed in health and skipped while every other route keeps working. | `router` |
| Model list survives an Anthropic outage | The upstream list request is capped at three seconds so routed providers stay listed when Anthropic is unreachable. | `router` |
| Transient network failures retried | Up to three attempts with backoff before upstream headers arrive, while HTTP error statuses pass straight through in the public arms. | `router` |
| HTTP/2 transport for GPT calls | Responses calls use HTTP/2 with bounded retries on resets, GOAWAY and header timeouts. | `router` |
| Heartbeat pings on GPT streams | An Anthropic ping event goes out after 30 seconds of silence so long reasoning does not look like a dead stream. | `router` |
| Stalled GPT stream times out | A GPT stream that produces no event for 60 seconds fails with a named error instead of hanging. | `router` |
| Finished tool call survives transport loss | If the connection drops after a tool call completed, the turn closes as tool_use instead of replaying the request and running the tool twice. | `router` |
| Empty GPT completion treated as error | A completed stream with no assistant content raises a typed error rather than returning a blank message. | `router` |
| GPT rate limits pass through with Retry-After | A GPT error status returns with retry-after and request id headers and is not retried by the router, leaving the wait to the client SDK. | `router` |
| Upstream failures answered 502 | Network failures return 502 so the Anthropic SDK treats them as retryable. | `router` |
| One in-flight request per session agent | A second /v1/messages for a session agent that already has one running gets 429 with Retry-After 2. | `router` |
| 64 MiB request body limit | A request body over 64 MiB is refused with 413 and the connection is closed. | `router` |
| Long model streams never time out | Node's request and socket timeouts are disabled so a long stream is not cut mid-flight. | `router` |
| Blue-green router reload | A saved router source file boots a candidate worker on a private port and switches new requests to it only once it is healthy. | `router` |
| Reload gated by health and canary | A candidate must answer /healthz and pass the semantic canary in a fresh process within 10 seconds before it receives traffic. | `router` |
| Failed reload keeps last good worker | A syntax error, failed health check or failed canary rejects the candidate and the current worker keeps serving. | `router` |
| Warm standby for instant rollback | After a swap the previous worker stays warm as a standby for a rollback window of two minutes by default. | `router` |
| Manual rollback endpoint | POST /rollbackz restores the warm standby generation immediately and answers 409 when none exists. | `router` |
| Automatic rollback when worker exits | If the current worker exits, the supervisor promotes the standby, or starts a replacement when there is none. | `router` |
| Retired workers drain active requests | A replaced worker keeps serving its in-flight responses and is stopped when they finish or after a one-hour deadline. | `router` |
| Supervisor liveness endpoint | GET /supervisorz reports the current and standby generations and the rollback and drain windows without touching the worker. | `router` |
| Generation header on every response | Proxied responses carry x-cuimod-router-generation and x-cuimod-router-supervisor so the serving worker is identifiable. | `router` |
| Retryable 503 while worker reloads | With no healthy worker the supervisor answers 503 with Retry-After 1 instead of dropping the connection. | `router` |
| Degraded /healthz when worker is busy | If the worker has not answered a health probe within one second, the supervisor replies 200 with a degraded flag. | `router` |
| Reload debounce and coalescing | Rapid source saves are debounced, and a reload superseded mid-boot is discarded in favour of the newer one. | `router` |
| Duplicate router instances fail fast | The supervisor binds the public port before starting a worker, so a second contender loses immediately. | `router` |
| Watches router sources except supervisor | Any .mjs change under router/ triggers a reload, but supervisor.mjs is excluded because it is the stable listener. | `router` |
| Workers start without console windows | Worker and canary processes are spawned with windowsHide, so a reload never opens a window. | `router` |
| Browser-origin request guard | Requests whose Host is not a loopback name, whose Origin is not loopback, or that carry a cross-site Sec-Fetch-Site are refused before any body is read. | `router` |
| Guard rejection reveals nothing | A refused request gets a fixed 403 message and the offending header values are never echoed back. | `router` |
| /healthz worker diagnostics | Reports routes, adapters, compatible providers, settings, usage and throughput file status, context and compaction state, and uptime. | `router` |
| ChatGPT credential readiness in health | /healthz says whether the Codex sign-in is readable and how many seconds the access token has left, without refreshing it. | `router` |
| Accounting never blocks a stream | When another process holds the writer lock, a record goes to its own spool file and is merged later instead of waiting. | `router` |
| Safe overlap of router generations | A cross-process lock with stale-owner reclaim guards every mutation while two workers overlap. | `router` |
| Self-repairing derived accounting indexes | A day whose segment grew past its recorded size is recomputed from raw events, so a crash between writes cannot skew totals. | `router` |
| Upstream errors passed through unretried | A non-success reply is relayed with its status and body and is not retried, so quota errors reach the client intact. | `command-code` |
| Adapter health report | Reports the backend URL, whether a key is readable, and the model ids it serves. | `command-code` |
| Apply the mod to Claude Desktop | Appends the preload and main hooks to the newest app-<version> asar and reads it back to confirm the marker landed before swapping it in. | `patch.js` |
| Patch every installed build | --all patches every app-<version> directory, and --rebuild re-injects ones already patched. | `patch.js` |
| Pristine backup and clean re-apply | The original asar is saved once and every apply injects into those pristine bytes, so re-running never double-appends. | `patch.js` |
| Integrity hash repointed in claude.exe | The asar header hash baked into claude.exe is rewritten before the asar is swapped, so the two never mismatch on disk. | `patch.js` |
| Revert to the original install | revert restores both the asar and claude.exe from their backups and refuses while Claude is running. | `patch.js` |
| Status of installed builds | status prints the install root, whether Claude is running, and for each build whether it is patched and has a backup. | `patch.js` |
| Refuses to patch a running app | apply stops with a clear message while Claude is running, and --force skips the guard. | `patch.js` |
| Build-specific eipc prefix lifted at patch time | The per-build channel uuid is read from that build's own preload instead of being hardcoded. | `patch.js` |
| Audited-build gate for the unban | The patch asserts exactly one match per ban site and accepts zero only for builds whose header hash was audited, so a reshaped Desktop fails loudly. | `patch.js` |
| Auto-patch after a Desktop update | Watches the install root and patches a newly laid-down app-<version> directory as soon as it appears. | `watch.js` |
| Patches the moment Desktop closes | A 1.5-second probe patches the running version as soon as the app is fully closed, so quit and reopen is enough. | `watch.js` |
| Tells Desktop from CLI processes | Distinguishes the Desktop app's claude.exe from Claude Code CLI agents by path, and assumes the app is up when unsure. | `watch.js` |
| Rotating watcher log | Writes watch.log and rotates it to watch.log.1 past 512 KB. | `watch.js` |
| Register the watcher at logon | Creates the ClaudeUiMod-Watcher scheduled task for the current user, starts it, and restarts it up to three times if it fails. | `install.ps1` |
| Watcher launches with no window | A wscript stub runs node watch.js with window style hidden so nothing appears at logon. | `install.ps1` |
| Uninstall the watcher task | -Uninstall removes the scheduled task and reports when none exists. | `install.ps1` |
| Compile check of the hot tree | Compiles the baked hooks, runtime host and bridge, and every plugin's main and renderer source without touching the app. | `selfcheck.js` |
| Host load with a fake Electron | Constructs the real host, lists its methods and plugins, and builds the renderer bundle to catch wiring faults. | `selfcheck.js` |
| Detects plugins that fail at load | A plugin whose main.js throws is reported as a failure even though the host tolerates it at runtime. | `selfcheck.js` |
| Interval and watcher leak check | Counts timers and watchers created by the host and fails if any survive dispose. | `selfcheck.js` |
| eipc prefix check against the installed asar | Confirms the build's channel prefix can be found in the installed or backed-up asar, and skips cleanly without an install. | `selfcheck.js` |
| Semantic router canary | Replays a fixture through the Responses translator and checks message lifecycle, block balance, reasoning signatures, tool use, refusals and recovery. | `router-canary.mjs` |
| Canary runs against a staged router | --router-dir points the canary at a candidate directory so a change can be checked before it is deployed. | `router-canary.mjs` |
| Canary covers compaction and heartbeat | Also asserts the wrapped compaction prompt is recognised, the checkpoint item is preserved and pings parse as valid events. | `router-canary.mjs` |
