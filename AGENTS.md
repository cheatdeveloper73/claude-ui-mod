# For AI agents

You were probably asked to install claude-ui-mod for someone, or to change it.
This file covers both. `CLAUDE.md` is the full repository contract; read it
before editing anything, and `docs/internals.md` before changing anything
structural.

## Installing it for a user

Every step below is a plain command. Nothing needs a GUI except quitting and
starting Claude Desktop.

1. Check the preconditions. All three must hold, or stop and tell the user.
   - Windows.
   - `node -v` prints v18 or newer.
   - Claude Desktop is installed under `%LOCALAPPDATA%\AnthropicClaude`.
2. Have the user quit Claude Desktop fully, from the tray icon. Windows keeps
   `app.asar` memory-mapped while the app runs, so a running app cannot be
   patched. `tasklist /FI "IMAGENAME eq claude.exe"` must list nothing.
3. Install and patch:

   ```bash
   npm ci
   node patch.js apply
   node patch.js status
   ```

   `status` must show `patched=yes  backup=yes` on the newest `app-<version>`.
4. Optional: keep the mod across app updates with a logon watcher.

   ```bash
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

5. The user starts Claude Desktop. **Insert** opens the dashboard with every
   plugin's settings. While the app runs, the local router answers
   `curl -i http://127.0.0.1:8789/healthz` with `200` and the header
   `x-cuimod-router-supervisor: 1`.

### Providers

Claude works with nothing further. The others are opt-in:

- **OpenAI:** install the Codex CLI and run `codex login` on a ChatGPT plan
  that includes Codex. The router uses that login, with no API key.
- **Command Code** (DeepSeek, GLM, Kimi, Qwen, MiniMax): write the key to
  `.state/provider-secrets.json` as `{ "command-code": "<key>" }`, or set
  `COMMAND_CODE_API_KEY`. It is read per request, so no restart is needed.
- **Other Anthropic-Messages backends:** add a catalogue entry. See
  `docs/provider-adapters.md`.

Never put a key anywhere but `.state/provider-secrets.json` or the
environment. `.state/` is ignored by git.

### Voice agent

The voice agent is optional and has its own install, on a Windows companion
plus a compute host. Follow `voice-agent/README.md`.

### Removing it

```bash
node patch.js revert
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

`revert` restores `app.asar` and `claude.exe` from the backups made on first
apply.

## Changing it

- Every file under `src/plugins/`, `src/runtime/` and `router/` reloads live.
  Only `src/main-hook.js` and `src/preload-hook.js` need `node patch.js apply`
  and an app restart. `CLAUDE.md` has the full table.
- After every edit, run `node selfcheck.js`. A runtime compile error is silent:
  the app keeps the previous version and nothing changes on screen. Before
  committing, run `npm run check`.
- A new plugin is a new directory in `src/plugins/` with a `main.js` and/or a
  `renderer.js`. See `docs/plugin-api.md`, and copy `examples/probe-plugin/`
  to start one. Take every timer, watcher and listener through a `ctx` helper.
- Router edits go live as a health-gated worker swap. Never edit a watched
  `router/*.mjs` file in place. Stage the complete file elsewhere, run
  `node scripts/router-canary.mjs --router-dir <staged-dir>`, then replace it.
- Never write under `src/` from plugin code; the watcher would reload the host
  in a loop. Persist to `.state/`.
