# Provider adapters

Drop a directory in here with an `index.mjs` and the router will route to your
backend. Nothing else registers it — no list to edit, no build step, no restart
of anything but the router worker.

An empty directory is the normal state. The router ships three arms compiled in
(Anthropic passthrough, the OpenAI Responses translation, and the
catalogue-driven compatible-provider forwarder) and needs no adapter to work.

**Before you write one, check whether you need one.** If your backend already
speaks Anthropic Messages at `POST /v1/messages`, add a catalogue entry instead
and write no code at all. See [docs/provider-adapters.md](../../docs/provider-adapters.md),
which covers both routes and has a complete worked example of each.

## The shape

```js
export default function createAdapter(kit)
{
    return {
        id: 'my-backend',
        provider: 'my-backend',
        models: [{ id: 'my-model-1', name: 'My Model', efforts: ['low', 'high'], defaultEffort: 'low' }],

        claims: (model) => /^(claude-)?my-model/i.test(String(model)),
        handle: async (req, res, body) => { /* ... */ },
    };
}
```

`claims` and `handle` are required. Everything else — `count`, `modelIds`,
`limits`, `health`, `usage`, `limitKey` — is optional and documented in
[`../adapter-registry.mjs`](../adapter-registry.mjs).

## Rules that are load-bearing

- **Never import `../index.mjs`.** The registry is loaded *by* the router, so an
  import back is a cycle. Everything shared lives in [`../relay.mjs`](../relay.mjs):
  the retry policy, header filtering, the Anthropic SSE relay, body reshaping.
- **Credentials never leave the process.** `health()` reports whether a
  credential reads, not what it is. Read keys from a file at request time rather
  than caching them, so reprovisioning does not require a restart.
- **A backend that fails over internally must not be retried here.** Pass
  `NO_STATUS_RETRY` to `fetchResilient`. Retrying in front of a pool that
  already failed over turns a soft rate limit into an exhausted pool — measured,
  and the reason that parameter exists.
- **One broken adapter cannot take the router down.** The registry isolates
  import failures, factory throws, and per-request errors, and `/healthz` names
  what it rejected. Do not defeat this by throwing at module scope in a way that
  matters — you will simply not be loaded.

## Checking your work

```bash
node selfcheck.js
npm run check:public
node scripts/router-canary.mjs --router-dir router
```

Then `GET /healthz` and look under `adapters`: `loaded` should name yours and
`errors` should be empty.
