# Agents and model mixing

Every Claude Code session in Desktop, and every subagent it spawns, sends its
requests to the same local router on `127.0.0.1:8789`. The router picks the
backend per request from the model id. So one conversation can run a Claude
orchestrator, a few GPT readers and a DeepSeek worker at the same time. Each
agent bills its own provider, and all of them use the native Agent tool, the
subagent HUD and the usage meters.

Nothing about this needs a special mode. An agent definition names a model, and
the request for that agent goes wherever that model lives.

## How a request finds its provider

For every `/v1/messages` request the router checks, in order:

1. **A provider adapter** that claims the model, for example
   `router/adapters/command-code/` for `deepseek-v4.1-flash`, `kimi-k3` and the
   rest of its list. A claimed model never falls through to another arm.
2. **A catalogue entry** with a `backend`, for any Anthropic-Messages provider
   you add to `src/plugins/provider-picker/catalogue.json`.
3. **The OpenAI arm**, for any id starting `gpt-` or `claude-gpt-`. It runs on
   your Codex (ChatGPT plan) login.
4. **Anthropic passthrough**, for everything else, byte-identical.

Model ids can carry decoration that the router strips before dispatch:

- **A `claude-` prefix** makes an id look like a Claude model to Claude Code.
- **A `[1m]` tag** makes Claude Code assume a 1M-token context. It changes local
  context accounting only, so use it only for a backend whose real context is
  at least 1M.
- **A `:effort` suffix** (`:low`, `:high`, `:xhigh`, …) sets reasoning effort
  when nothing else does.

## Writing an agent definition

Agents are markdown files in `~/.claude/agents/` (or `.claude/agents/` in a
project), with the model in the frontmatter:

```markdown
---
name: gpt-reader
description: GPT-6 Luna source reader for parallel file reading.
model: claude-gpt-6-luna[1m]
effort: high
tools: Read, Grep, Glob, Bash
---

Read the files named in the brief in full and answer with file:line citations.
```

```markdown
---
name: deepseek-worker
description: DeepSeek V4.1 Flash for tightly bounded edits.
model: deepseek-v4.1-flash
---

Make the change the brief describes, run its check, and report the result.
```

The spelling in `model:` matters:

| provider | write `model:` as | why |
|---|---|---|
| Claude | `claude-sonnet-5-5`, `claude-opus-5-5`, … or `inherit` | Anthropic passthrough |
| OpenAI | `claude-gpt-6-luna[1m]`, `claude-gpt-6.1-sol[1m]`, … | the spelling the picker and the router's own defaults use; `[1m]` matches the real window |
| an adapter's models (Command Code) | the bare id: `deepseek-v4.1-flash`, `kimi-k3`, `glm-5.3`, … | a `claude-` prefix trips Claude Code's unknown-Claude-model guard, which was measured capping the window at 180k instead of the configured one |

Set effort with the `effort:` line, or with a suffix on the id
(`claude-gpt-6-luna[1m]:high`).

## Agents that do not pin a model

Claude Code picks a subagent's model in this order:

1. the Agent tool's `model` argument;
2. the definition's `model:` (`inherit` means the parent's model);
3. with no `model:` at all, `CLAUDE_CODE_SUBAGENT_MODEL`, and the parent's model
   only when that is unset.

The built-in general-purpose agent and any definition without `model:` land on
step 3. `provider-routing` sets `CLAUDE_CODE_SUBAGENT_MODEL` per session at
launch, from the session's own model, so an unconsidered spawn lands on a cheap
tier of the same provider instead of copying an expensive root:

| the session runs on | unpinned subagents get |
|---|---|
| Claude | `claude-sonnet-5-5` |
| OpenAI | `claude-gpt-5.6-luna[1m]:high` |
| any other routed provider | `routedSubagentModel` from `src/plugins/provider-routing/defaults.private.json`; without that file they inherit the session's model |

A value already in the launching environment wins over all of these. The tier
is fixed when the session starts: switching the session's model later keeps
it. To route other providers' unpinned subagents somewhere specific, create the
defaults file:

```json
{ "routedSubagentModel": "deepseek-v4.1-flash", "helperModel": "claude-sonnet-5-5" }
```

`helperModel` is the model a routed session hands Claude Code's small helper
calls to: titles, WebFetch summaries, permission checks. A native Claude
session always keeps Desktop's own helper. Without the file, routed sessions
keep it too.

## Why the Agent tool accepts non-Claude models

The Agent tool validates a custom agent's model against `/v1/models` before it
spawns anything. Anthropic's list has only Anthropic models, so the router adds
every model an adapter, the catalogue or the OpenAI arm can serve. Without that,
a GPT or DeepSeek subagent would fail client-side with "model may not exist",
even though the same model works for the main conversation.

## Per-agent behaviour worth knowing

- **Fast mode is per agent.** The composer's fast switch applies to the main
  conversation. A GPT subagent runs on OpenAI's priority tier only when its
  launch prompt opens with a line reading `#fast`. The router strips the line
  before the model sees it, and ignores the speed flag a subagent inherits from
  its parent.
- **Each agent gets its own GPT prompt-cache thread**, so parallel GPT agents do
  not evict each other's cache.
- **One request at a time per agent.** The router refuses a second concurrent
  `/v1/messages` from the same session agent with a retryable 429. Other
  agents and sessions are unaffected.
- **An agent's model is fixed at spawn.** Editing its definition affects the
  next spawn, not the running one.

## Watching a mixed team

- **subagents** — the HUD under the chat title lists every agent with the tool
  it is on and how long it has run. Click one for its transcript sheet, which
  shows the model and effort its definition pins.
- **throughput** — tokens per second, attributed to the main session or to the
  named subagent that produced them.
- **usage-bar** and the **Usage Atlas** (`http://127.0.0.1:8789/usage/`) —
  each provider's quota and spend, so you can see which provider a team is
  burning.

## A mixed team, end to end

One way to spread a large change across providers:

- **orchestrator:** the main session on Claude Opus. It plans and reviews.
- **`gpt-reader` × 3:** read different subsystems in parallel on the ChatGPT
  plan's quota.
- **`deepseek-worker`:** makes the mechanical edits on Command Code credits.
- **`reviewer` on `claude-sonnet-5-5`:** checks the diff before the
  orchestrator accepts it.

Each agent runs on its own provider's quota, the HUD shows all of them, and the
orchestrator never leaves the Desktop Code tab.

See [docs/FEATURES.md](FEATURES.md) for the router features behind this, and
[docs/provider-adapters.md](provider-adapters.md) to add a provider of your own.
