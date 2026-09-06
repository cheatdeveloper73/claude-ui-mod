# Adding a provider

The router points every Claude Code session at one endpoint and picks the
backend per request, from `body.model`. That is the whole trick: a session's
endpoint is fixed at spawn — it is an environment variable — so switching
provider mid-conversation is impossible at the transport layer. Making the
endpoint uniform and dispatching on the model instead turns a provider switch
into a *model* switch, which the CLI accepts live over its `set_model` control
request.

So "adding a provider" means teaching the router to claim some model ids.

There are two ways, and the first one is not code.

| | catalogue entry | adapter |
|---|---|---|
| backend speaks | Anthropic Messages | anything |
| you write | one JSON object | one JS module |
| reload | next request | router worker restart |
| gets you | routing, streaming, exact token accounting, cost | all of that, plus quota meters, native token counting, a live model list |

## Route 1: the catalogue

If your backend already exposes `POST /v1/messages` speaking Anthropic Messages
— most self-hosted gateways and several commercial APIs do — you write no code.

Add an entry to `src/plugins/provider-picker/catalogue.json`:

```json
{
    "id": "my-model-1",
    "name": "My Model",
    "provider": "my-backend",
    "efforts": ["low", "high"],
    "context": 200000,
    "maxOutput": 32000,
    "backend": {
        "protocol": "anthropic-messages",
        "baseUrl": "https://api.example.com/v1",
        "apiKeyHeader": "x-api-key",
        "secret": "my-backend"
    }
}
```

Put the key in `.state/provider-secrets.json`, which is gitignored and is the
only place a credential belongs:

```json
{ "my-backend": { "apiKey": "..." } }
```

That is the whole change. The catalogue and the secrets file are both read per
request, so the model appears in the picker and starts routing without a
restart. A malformed edit to either keeps the last parsed value rather than
taking the router down with it.

Constraints worth knowing before you hit them:

- `baseUrl` must be HTTPS, or HTTP on loopback. Anything else is refused at
  parse time.
- `apiKeyHeader` is `x-api-key` or `authorization`. With `authorization` the key
  is sent as `Bearer <key>`.
- Every model naming the same `provider` must agree on the same `backend` block.
- `efforts` selects reasoning behaviour through a model variant (`my-model-1:high`).
  Claude Code's own effort fields are stripped on this arm, because they belong
  to a different model and would otherwise survive a model switch and silently
  change the variant.
- An unknown model id fails closed. It is never quietly forwarded to Anthropic
  and answered as Claude under your label.

## Route 2: an adapter

Write one when the catalogue is not enough: the backend does not speak Anthropic
Messages, or it has quotas you want metered, or a native token counter, or a
model list that changes without a redeploy.

An adapter is a directory under `router/adapters/` with an `index.mjs` that
default-exports a factory. The registry discovers it at boot, calls the factory
once with the kit, and asks the result which models it claims. Nothing else
registers it. Zero adapters is a supported and default state.

### A complete one

```js
// router/adapters/my-backend/index.mjs
import { DROP_RES, NO_STATUS_RETRY, fetchResilient, pipeAnthropicBody, pipeBody, prepareProviderBody } from '../../relay.mjs';
import { readProviderSettings } from '../../settings.mjs';
import { applyPromptPolicy, promptPolicyHeaders, resolvePromptPolicy } from '../../prompt-policy.mjs';
import { isSubagentRequest } from '../../throughput.mjs';

const BASE = process.env.MY_BACKEND_URL || 'https://api.example.com/v1';
const MODELS = [
    { id: 'my-model-1', name: 'My Model', efforts: ['low', 'high'], defaultEffort: 'low', context: 200000 },
];

export default function createAdapter(kit)
{
    const claims = (model) => typeof model === 'string' && /^(claude-)?my-model/i.test(model);

    async function handle(req, res, body)
    {
        const gone = () => res.writableEnded || res.destroyed;
        const clientModel = body.model;
        const sessionId = req.headers['x-claude-code-session-id'] || null;
        const selection = resolvePromptPolicy(body, 'my-backend', readProviderSettings(), sessionId);

        // Strip the client-identity system blocks, then apply the user's policy.
        // That order matters: a policy replacement is the user's prompt, not a
        // new chance for the client identity to leak back in.
        let prepared = prepareProviderBody(body);
        prepared.model = String(clientModel).replace(/^claude-/i, '').replace(/\[1m\]/ig, '');
        prepared = applyPromptPolicy(prepared, selection);

        const rate = kit.throughput.begin({
            provider: 'my-backend', sessionId, requestedModel: clientModel,
            subagent: isSubagentRequest(body), streaming: !!body.stream,
        }, res);

        const recordUsage = (sample) => {
            kit.recordUsage({ provider: 'my-backend', sessionId, requestedModel: clientModel,
                source: 'my-backend.message.usage', exact: true, ...sample });
            rate.complete(sample);
        };

        const upstream = await fetchResilient(`${BASE}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': readKey() },
            body: JSON.stringify(prepared),
        }, 'my-backend', gone, NO_STATUS_RETRY, kit.log);
        rate.upstream();
        if (gone()) { rate.end(); return; }

        const headers = {};
        upstream.headers.forEach((value, name) => { if (!DROP_RES.has(name.toLowerCase())) headers[name] = value; });
        res.writeHead(upstream.status, { ...headers, ...promptPolicyHeaders(selection) });

        if (!upstream.ok) { rate.end(); await pipeBody(upstream, res); return; }
        try { await pipeAnthropicBody(upstream, res, clientModel, !!body.stream, recordUsage, event => rate.anthropic(event)); }
        finally { rate.end(); }
    }

    return {
        id: 'my-backend',
        provider: 'my-backend',
        limitKey: 'my-backend',
        models: MODELS,
        claims,
        handle,
        health: () => ({ backend: BASE, keyOk: keyReadable() }),
    };
}
```

### The kit

The kit is the only channel into the router process, and it is deliberately
small:

```
kit.log(message)         append to the router log
kit.stateDir             router state directory
kit.accountingDir        permanent accounting root
kit.recordUsage(sample)  write an exact token record
kit.throughput           generation-rate ledger
```

Everything else you import directly: `relay.mjs` for transport, `settings.mjs`,
`prompt-policy.mjs`, `prompt-capture.mjs`, `throughput.mjs`, `pricing.mjs`.

**Never import `../index.mjs`.** The registry is loaded *by* the router, so an
import in that direction is a cycle. If you find yourself wanting something from
it, that thing belongs in `relay.mjs`.

### Optional methods

`count(req, res, body)` — serve `/v1/messages/count_tokens` natively. Without
it the router answers 501 for your models and the client falls back to its own
estimate, which is more honest than a count produced by the wrong tokenizer.

`modelIds()` — live ids for `/v1/models`. The Agent tool validates a custom
agent's model against that list before spawning, so a model missing from it
kills a subagent client-side while a top-level request on the same model works
fine. Return `[]` when the backend is unreachable; the list still serves.

`limits(force)` — a quota snapshot, placed under `limitKey` in `/limitsz` and
`/usage/api`. Return an `accounts` array and the dashboard renders per-account
meters plus a pool average with no further work. Carry your meter policy in the
same object, because only you know the backend:

```js
{
    source: 'my-backend.quota',
    observedAt: new Date().toISOString(),
    poolLabel: 'My pool',                 // "My pool · 3 accounts"
    poolScope: 'schedulable pool average',
    trackedQuotas: ['my-quota-a'],        // the ids that actually move
    modelAliases: ['flash', 'pro'],       // bridges served model to quota name
    accounts: [{ id, name, status, schedulable, exact, quotas: { 'my-quota-a': { utilization, remainingFraction, resetTime } } }],
}
```

`health()` — merged into `/healthz` under `adapters.loaded`. Report whether a
credential reads, never the credential.

`usage(value)` — decorate the `/usage/api` payload with accounting your backend
exposes and the router does not.

`registerRates()` from `pricing.mjs` — call at module scope to price your
provider. Without it your traffic is counted as unpriced, which reads as a gap
in the bill rather than as free.

### Rules that are load-bearing

- **Credentials stay in the process.** Read them from a file at request time
  rather than caching, so reprovisioning does not need a restart. They must
  never appear in `/healthz`, `/limitsz`, `/usage/api`, the log, or renderer RPC.
- **Do not retry a backend that already fails over internally.** Pass
  `NO_STATUS_RETRY`. In front of an account pool that already tried every
  account before answering, a 429 means the pool is exhausted, not that this
  attempt was unlucky — retrying turns a soft rate limit into a hard outage.
  Measured, and the reason that parameter is a parameter.
- **Claim narrowly.** If your backend's model list also carries names belonging
  to another provider, do not claim those, or you will silently bill that
  provider's traffic to your backend.
- **You cannot take the router down.** Import failures, factory throws, a
  throwing `claims()`, a dead backend during `limits()` or `modelIds()` — all
  isolated, recorded, and reported under `adapters.errors` in `/healthz`. This
  is tested in `tests/provider-adapter-registry.test.mjs`.

### Verifying

```bash
node selfcheck.js
npm run check:public
node scripts/router-canary.mjs --router-dir router
```

Then check `/healthz`: your adapter should be in `adapters.loaded` and
`adapters.errors` should be empty. The router logs `adapter loaded: <id>` at
startup and names the loaded set in its listen line.

Write your tests beside the public ones if the adapter ships with the tree.

If it does not — because the backend is yours alone, or is not something you can
publish — keep the adapter directory out of your published tree and keep its
tests out of `npm run check:public`. That is the arrangement this repository
itself uses, and it is why the public suite sets `MODEL_ROUTER_ADAPTER_DIR` to
an empty directory: the tests that ship have to pass in a tree that carries no
adapter at all.
