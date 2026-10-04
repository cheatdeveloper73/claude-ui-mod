# Supported Code frontend

The frontend pin is enabled by default and ships with the public mod. UI plugins
are supported against the entry named in `vendor/claude-code-frontend/release.json`.
The Desktop executable version and the Code frontend release are separate
compatibility boundaries: Desktop supplies Electron and IPC, while claude.ai
supplies the document and backend data.

## Install

Use the normal installation path. No personal settings file, browser cache,
asset download, additional server or separate pin installation is required.
Verify the bundled release before patching:

```bash
node scripts/verify-frontend.cjs
```

Then follow the [README installation instructions](../README.md#install).
The plugin defaults to enabled when `.state/settings.json` does not exist.
The update watcher preserves injection into new Desktop shell versions; the
frontend plugin separately holds the Code asset release.

For an existing running installation, saving the finalized plugin arms the
next full Code document load. It does not replace an already-loaded frontend.
The dashboard's **Frontend release gate** panel reports the entry and bundled
asset count. An unpinned loaded page displays a warning. Reload Code when it
is safe to replace that page; changing the toggle never reloads it by itself.

## What is bundled

The release manifest is the single source of truth for the entry, shared-frame,
shared-styles, app and utility stylesheets, and bootstrap flag overrides. Each
asset record includes its original filename, MIME type, uncompressed byte count,
SHA-256 and static dependency inventory.

`vendor/claude-code-frontend/assets/` contains losslessly gzip-compressed original
CDN bytes. This includes JavaScript chunks, stylesheets, fonts, images, Wasm and
JSON reached by the approved graph. The utility sheet is included separately
because the approved entry never shipped utility CSS of its own.

The main-process plugin fulfills asset requests from disk through CDP Fetch at
the **original HTTPS URL**. This preserves relative imports, worker URLs, origin
and CSP semantics. Anonymous cross-origin responses carry CORS and CORP headers;
Wasm keeps `application/wasm`. Dedicated workers' asset requests reach the
owning page's Fetch agent; the plugin never attaches or pauses worker targets.
The plugin checks bytes against the manifest before serving them and keeps a
bounded in-memory cache. It never falls back to the CDN for a missing or corrupt
manifest asset.

The Code document's entry and release stylesheet links, and the corresponding
`Link` response header, are rewritten before parsing. Live chunks' shared sheets
are mapped to the bundled twins; the renderer also corrects stylesheet links
satisfied from Chromium's cache. Inline document scripts remain byte-identical.
The two recorded GrowthBook flags stay off on pinned bootstrap responses.

## What remains live

This is an archived frontend asset graph, not an offline Claude service.

- The claude.ai document, its inline bootstrap prelude and CSP remain live.
- Authentication, account data, sessions, model catalogues and APIs remain live.
- The document build ID and bootstrap build-ID relationship remain live.
- Server-selected gated imports and runtime URLs outside the archived graph
  remain live. Their response bodies and account-specific bootstrap payloads
  are not included in the archive.
- Desktop's IPC implementation and Claude Code processes remain installed code.

Deletion of the archived CDN files does not remove the local copies. A future
backend, document or gated-import contract change can still require a repair.
A mounted composer alone does not certify every backend-dependent feature.

## Failure and recovery

A failed canary, malformed document, missing asset, corrupt bytes, debugger
conflict or missed mount is reported through the status RPC and an accessible
warning in Code. A document that was rewritten but cannot mount gets one
recovery reload on the server-selected frontend. That frontend is labelled
unsupported; fallback does not claim that the plugins are compatible with it.

For diagnostics, read `.state/frontend-pin-events.jsonl`. The bounded log records
navigation, document rewrites, flag overrides and failure reasons. It does not
persist bootstrap account payloads. Run the verifier to distinguish bundle
integrity problems from an upstream compatibility change.

Turning **Hold approved frontend** off detaches the gate immediately and leaves
the loaded page intact. The next full load uses the live frontend. Turning it
back on arms the next load. The frontend itself remains in the repository.

## Verification and maintenance

```bash
npm run check:frontend
```

The focused checks verify every archive hash and dependency record, fulfill every
manifest asset through the plugin with exact bytes and MIME, keep workers
unpaused, reject corrupt/missing bytes, and check warnings and disposal. They use
mocked Electron/WebContents, so passing them does not claim an authenticated
Desktop cold launch. `node selfcheck.js` also verifies the bundle. The public
export checks the resulting tree's own asset files, not the private checkout's.

A maintainer can recapture the approved graph into a new staging directory:

```bash
node scripts/capture-frontend.cjs --out <new-directory>
```

The current manifest supplies the release seeds. `--manifest <release.json>`
selects an explicitly reviewed candidate release; `--resume` resumes an
interrupted capture. The capture reads only public content-hashed assets from
the fixed CDN directory. It never captures a signed-in document or bootstrap.
Verify a candidate and its native plugin surfaces in isolation before replacing
both the manifest and assets. Keep the old approved release until acceptance
passes. This command is a maintainer operation, not a user installation step.

## Upstream ownership

The archived frontend is third-party code from Anthropic's public asset CDN.
Its original bytes and embedded notices are preserved. This project's MIT
license applies to the mod's original code; it does not relicense the archived
frontend or grant rights to Anthropic's code or trademarks.
