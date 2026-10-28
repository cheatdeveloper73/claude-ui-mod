'use strict';
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();

// Substitute only the admitted invocation's dispatch body. All native policy,
// origin, clipboard, input-attribution and post-action checks still surround it.
async function nativeCall(options, label, operation) {
    const { tabId, getTab, identity, validate, invoke, signal, before } = options;
    const tab = getTab(), cdp = tab?.cdpTools;
    const slot = options.plan?.slot || 'evaluate';
    if (!cdp || typeof cdp[slot] !== 'function') throw Error('native browser CDP contract unavailable');
    const captured = identity(), token = randomUUID();
    const description = String(label).replaceAll('*/', '* /');
    const text = (options.code || 'throw new Error("Codex native dispatch unavailable; do not replay");')
        + '\n/* Codex browser backend ' + description + ' ' + token + ' */';
    const expressions = new Set(['{' + text + '\n}', '(async()=>{\n' + text + '\n})()']);
    const plan = options.plan || { tool: 'javascript_tool', input: { action: 'javascript_exec', tabId, text } };
    const original = cdp[slot], hadOwn = Object.hasOwn(cdp, slot);
    let called = false, value;
    function check() {
        if (signal?.aborted) throw Error('browser operation cancelled; it was not retried');
        validate();
        if (getTab() !== tab || identity() !== captured) throw Error('browser tab changed during native approval');
    }
    async function wrapper(...args) {
        if (scope.getStore() !== token || (!options.plan && !expressions.has(args[0])))
            return Reflect.apply(original, this, args);
        check();
        if (called) throw Error('native browser operation cannot be replayed');
        if (before) { await before(cdp, tab); check(); }
        called = true;
        value = await operation(cdp, tab, check);
        return undefined;
    }
    check();
    cdp[slot] = wrapper;
    try {
        const result = await scope.run(token, () => invoke(plan.tool, plan.input, { expected: plan.expected, signal }));
        if (result?.isError) {
            const message = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
            throw Error((message || 'native browser operation refused') + (called ? '\nAn operation was dispatched; do not replay it.' : ''));
        }
        if (!called) throw Error('native browser dispatch contract changed; outcome is uncertain, do not replay');
        if (signal?.aborted) throw Error('browser operation cancelled; completion is uncertain and it was not retried');
        return value;
    } finally {
        if (cdp[slot] === wrapper) {
            if (hadOwn) cdp[slot] = original;
            else delete cdp[slot];
        }
    }
}

async function guardedNativeAction({ object, slot, validate, getTab, signal, invoke }) {
    const original = object?.[slot], tab = getTab(), token = randomUUID();
    if (typeof original !== 'function' || !tab) throw Error('native navigation contract unavailable');
    validate();
    if (signal?.aborted) throw Error('browser navigation cancelled before dispatch');
    const hadOwn = Object.hasOwn(object, slot);
    let dispatched = false;
    function wrapper(...args) {
        if (scope.getStore() !== token) return Reflect.apply(original, this, args);
        validate();
        if (signal?.aborted || getTab() !== tab) throw Error('browser navigation cancelled before dispatch');
        if (dispatched) throw Error('native browser navigation cannot be replayed');
        dispatched = true;
        return Reflect.apply(original, this, args);
    }
    object[slot] = wrapper;
    try {
        const result = await scope.run(token, invoke);
        if (result?.isError) throw Error((result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'native navigation refused')
            + (dispatched ? '\nNavigation was dispatched; do not replay it.' : ''));
        if (!dispatched) throw Error('native navigation outcome was not observed; do not replay');
        return result;
    } finally {
        if (object[slot] === wrapper) {
            if (hadOwn) object[slot] = original;
            else delete object[slot];
        }
    }
}

module.exports = { nativeCall, guardedNativeAction };
