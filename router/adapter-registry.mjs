// Provider adapters: the extension point for backends the router does not ship.
//
// The router has three arms compiled into it -- Anthropic passthrough, the
// OpenAI Responses translation, and the catalogue-driven compatible-provider
// forwarder. Anything else is an adapter: a directory under `router/adapters/`
// exporting a factory. The registry discovers them at boot, hands each one the
// kit below, and asks the resulting objects which models they claim.
//
// Zero adapters is a fully supported state and the default. Nothing in the
// router requires this directory to contain anything, which is what lets a
// deployment carry a backend the published tree does not.
//
// The full interface, with a worked example, is docs/provider-adapters.md.
//
//   export default function createAdapter(kit)
//   {
//       return {
//           id:       'my-backend',     // unique, used in logs and /healthz
//           provider: 'my-backend',     // ledger + prompt-policy provider label
//           limitKey: 'my-backend',     // optional: key under /limitsz
//           models:   [ { id, name, efforts, defaultEffort, context } ],
//
//           claims(model),              // does this adapter own this model id?
//           async handle(req, res, body),
//           async count(req, res, body),   // optional /v1/messages/count_tokens
//           async modelIds(),              // optional live ids for /v1/models
//           async limits(force),           // optional quota snapshot
//           health(),                      // optional /healthz fragment
//       };
//   }
//
// The kit is the only channel into the router process. An adapter that reaches
// past it -- importing index.mjs, say -- creates an import cycle, because the
// registry is loaded *by* index.mjs.
//
//   kit.log(message)             append to the router log
//   kit.stateDir                 router state directory
//   kit.accountingDir            permanent accounting root
//   kit.recordUsage(sample)      write an exact token record
//   kit.throughput               generation-rate ledger
//
// Everything else an adapter needs -- the retry policy, the SSE relay, body
// reshaping -- is in ./relay.mjs, which it imports directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_DIR = process.env.MODEL_ROUTER_ADAPTER_DIR
    || fileURLToPath(new URL('./adapters', import.meta.url));

// A directory is an adapter when it has an index.mjs. Everything else in here
// -- the README, a notes file, a leftover directory -- is skipped in silence so
// the extension point can be documented in place.
function discover(dir)
{
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return []; }

    const found = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
    {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'index.mjs');
        if (fs.existsSync(file)) found.push({ name: entry.name, file });
    }
    return found;
}

export class AdapterRegistry
{
    constructor(adapters = [], errors = [])
    {
        this.adapters = adapters;
        this.errors = errors;
    }

    // One bad adapter must not take the router with it. A module that fails to
    // import, a factory that throws, or an object missing the two methods that
    // make it useful is recorded and skipped -- the router still serves every
    // other arm, and /healthz names what was rejected.
    static async load(kit, dir = ADAPTER_DIR)
    {
        const adapters = [];
        const errors = [];

        for (const { name, file } of discover(dir))
        {
            try
            {
                const module = await import(pathToFileURL(file).href);
                const factory = module.default || module.createAdapter;
                if (typeof factory !== 'function') throw new Error('no default export function');
                const adapter = await factory(kit);
                if (typeof adapter?.claims !== 'function' || typeof adapter?.handle !== 'function')
                    throw new Error('adapter must implement claims() and handle()');
                adapter.id = adapter.id || name;
                adapter.provider = adapter.provider || adapter.id;
                adapters.push(adapter);
                kit.log?.(`adapter loaded: ${adapter.id} (${(adapter.models || []).length} models)`);
            }
            catch (error)
            {
                const message = String(error?.message || error).slice(0, 240);
                errors.push({ adapter: name, error: message });
                kit.log?.(`adapter ${name} failed to load: ${message}`);
            }
        }

        return new AdapterRegistry(adapters, errors);
    }

    resolve(model)
    {
        if (typeof model !== 'string' || !model) return null;
        for (const adapter of this.adapters)
        {
            try { if (adapter.claims(model)) return adapter; }
            catch (_) {}
        }
        return null;
    }

    // Static catalogue entries, for the effort-suffixed spellings /v1/models has
    // to list before the Agent tool will spawn a subagent naming a tier.
    modelEntries()
    {
        return this.adapters.flatMap(adapter => adapter.models || []);
    }

    // Live ids, for backends whose model list is not knowable at build time. A
    // backend that is down contributes nothing rather than failing the list.
    async modelIds()
    {
        const settled = await Promise.allSettled(
            this.adapters.map(adapter => adapter.modelIds ? adapter.modelIds() : []));
        return settled.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
    }

    // Quota snapshots, keyed the way the dashboard expects to find them. An
    // adapter that cannot reach its backend reports the error in its own slot
    // instead of emptying the whole payload.
    async limitSnapshots(force)
    {
        const withLimits = this.adapters.filter(adapter => typeof adapter.limits === 'function');
        const settled = await Promise.allSettled(withLimits.map(adapter => adapter.limits(force)));
        const out = {};
        for (const [index, result] of settled.entries())
        {
            const adapter = withLimits[index];
            out[adapter.limitKey || adapter.provider] = result.status === 'fulfilled'
                ? result.value
                : { error: String(result.reason?.message || result.reason) };
        }
        return out;
    }

    // /healthz fragments. Never credential values -- an adapter reports whether
    // its credential is readable, not what it is.
    health()
    {
        const adapters = this.adapters.map(adapter => {
            let value = null;
            try { value = adapter.health ? adapter.health() : null; }
            catch (error) { value = { error: String(error?.message || error).slice(0, 240) }; }
            return { id: adapter.id, provider: adapter.provider, models: (adapter.models || []).map(m => m.id), ...value };
        });
        return { dir: ADAPTER_DIR, loaded: adapters, errors: this.errors };
    }
}

export { ADAPTER_DIR, discover };
