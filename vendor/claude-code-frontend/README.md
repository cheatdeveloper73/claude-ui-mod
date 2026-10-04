# Archived Code frontend

`release.json` names the supported frontend entry, its shared/app/utility
stylesheets, UI flag overrides and the exact SHA-256 of every archived asset.
`assets/` contains gzip-compressed original public CDN bytes. The mod serves the
uncompressed bytes at their original URLs through the Code view's CDP Fetch
interceptor. Installation never downloads this archive.

Run `node scripts/verify-frontend.cjs` from the repository root to check all
files and the recorded dependency closure. `node selfcheck.js` and the public
export run the same check. The normal patcher refuses an invalid archive before
touching the app's files.

This is third-party Anthropic frontend code, not code relicensed under this
project's MIT license. Original bytes and embedded notices are preserved.
Authentication, APIs, live document/bootstrap data and server-selected gated
imports are outside the archive. Source maps are not runtime dependencies and
are not captured. See [the public runbook](../../docs/frontend-pin.md).
