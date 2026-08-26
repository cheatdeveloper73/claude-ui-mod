## What this changes

<!-- One change per PR. Say what it does from the user's side. -->

## Tested against

- Claude Desktop version:
- Node version:

## Checks

- [ ] `node selfcheck.js` passes (paste the output below)
- [ ] Every timer / watcher / listener / observer is taken through a `ctx` helper
- [ ] Nothing writes under `src/` at runtime
- [ ] No new runtime dependencies
- [ ] If a baked loader (`src/main-hook.js`, `src/preload-hook.js`) changed, the
      PR says why the logic cannot live in `host.js` or a plugin

```
paste selfcheck output here
```

## What you observed in the running app

<!-- Not what should happen — what you saw. Reload counts, duplicate hosts or
     not, whether disposal actually fired. Evidence from a probe plugin is
     ideal. -->
