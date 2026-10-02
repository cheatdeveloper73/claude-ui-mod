/* claude-ui-mod :: model-probe-skip (main)
 *
 * Lets a live session switch to a routed model without Claude Code's API probe.
 *
 * CLI 2.1.284 answers a set_model control request by sending a real
 * max_tokens:1 "Hi" request for the target model (querySource
 * model_validation) under a hard 5000 ms deadline (`var si=5000` beside the
 * set_model handler). A routed model that is slower than that end to end --
 * GPT-6.1 Sol measured past it on 2026-09-30 -- is refused with
 * `Couldn't confirm model "..." with the API` and the session stays put.
 *
 * The probe is skipped for any id listed verbatim in the `modelPicker` setting
 * (`cde()?.picker.options.some(c => c.model.trim() === r)` in jIn), and that
 * setting is honoured from flag settings, which Desktop can change on a running
 * worker through query.applyFlagSettings. So the switch is preceded by one flag
 * patch naming the exact string query.setModel is about to send. Launch-time
 * picks never probe (isLaunchModelPick sets confirmWithServer:false), which is
 * why only live switches are wrapped.
 *
 * modelPicker is replaced wholesale on every patch, so each worker's list is
 * carried on its query object and grows by one id per new target.
 */
'use strict';

const OPTIONS = Symbol.for('cuimod.model-probe-skip.options');

module.exports = function (ctx) {
    // query -> { wrapper, original, own }
    const wrapped = new Map();

    function wrap(query) {
        const current = query.setModel;
        if (typeof current !== 'function' || typeof query.applyFlagSettings !== 'function') return;
        // A newer host generation's wrapper is already in place.
        if (current.__cuimodProbeSkip) return;
        const own = Object.hasOwn(query, 'setModel');
        const wrapper = async function (model, ...rest) {
            const id = typeof model === 'string' ? model.trim() : '';
            if (id && id.toLowerCase() !== 'default') {
                const options = query[OPTIONS] || [];
                if (!options.includes(id)) {
                    const next = [...options, id];
                    try {
                        await query.applyFlagSettings({ modelPicker: { options: next.map(m => ({ model: m })) } });
                        query[OPTIONS] = next;
                    } catch (error) {
                        // The switch still goes out; it just gets the CLI's probe.
                        ctx.log(`modelPicker patch failed for ${id}: ${error?.message || error}`);
                    }
                }
            }
            return current.apply(this, [model, ...rest]);
        };
        wrapper.__cuimodProbeSkip = true;
        query.setModel = wrapper;
        wrapped.set(query, { wrapper, original: current, own });
    }

    function unwrap(query, { wrapper, original, own }) {
        if (query.setModel !== wrapper) return;
        if (own) query.setModel = original;
        else delete query.setModel;
    }

    function attach() {
        const live = new Set();
        for (const module of Object.values(require.cache || {})) {
            const manager = module?.exports?.claudeCodeSessionManager;
            if (!manager?.sessions || typeof manager.sessions.values !== 'function') continue;
            for (const session of manager.sessions.values()) {
                const query = session?.query;
                if (!query) continue;
                live.add(query);
                wrap(query);
            }
        }
        // A respawned worker gets a new query; drop the dead ones.
        for (const query of wrapped.keys()) if (!live.has(query)) wrapped.delete(query);
    }

    attach();
    ctx.every(1000, attach);
    ctx.onDispose(() => {
        for (const [query, entry] of wrapped) unwrap(query, entry);
        wrapped.clear();
    });
};
