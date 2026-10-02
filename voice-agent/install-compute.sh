#!/usr/bin/env bash
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cuimod-voice"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/cuimod-voice"
UNIT_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if ! command -v python3 >/dev/null; then
    printf 'python3 is required\n' >&2
    exit 1
fi
if ! command -v espeak-ng >/dev/null; then
    printf 'espeak-ng is required by Kokoro. Install it with your OS package manager, then rerun.\n' >&2
    exit 1
fi

mkdir -p "$ROOT/app" "$ROOT/models" "$CONFIG_ROOT" "$UNIT_ROOT"
python3 -m venv "$ROOT/venv"
"$ROOT/venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir -r "$SOURCE/requirements-compute.txt"
install -m 0644 "$SOURCE/common.py" "$SOURCE/compute_server.py" "$ROOT/app/"

if [[ ! -f "$CONFIG_ROOT/compute.json" ]]; then
    cp "$SOURCE/compute.example.json" "$CONFIG_ROOT/compute.json"
fi
if [[ ! -f "$CONFIG_ROOT/token" ]]; then
    "$ROOT/venv/bin/python" -c 'import secrets,sys; open(sys.argv[1], "w", encoding="utf-8").write(secrets.token_urlsafe(48)+"\n")' "$CONFIG_ROOT/token"
    chmod 0600 "$CONFIG_ROOT/token"
fi

cat > "$UNIT_ROOT/cuimod-voice.service" <<EOF
[Unit]
Description=Loopback speech compute for claude-ui-mod
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT/app
ExecStart=$ROOT/venv/bin/python $ROOT/app/compute_server.py --config $CONFIG_ROOT/compute.json
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$ROOT $CONFIG_ROOT

[Install]
WantedBy=default.target
EOF

# Restart=always does not cover an explicit stop. Compute experiments on this
# box stop services wholesale, and on 2026-09-23 that left voice dead for a day
# with nothing surfaced. Starting an active unit is a no-op, so this only acts
# after something stopped voice; stop the timer first to keep voice down.
cat > "$UNIT_ROOT/cuimod-voice-keepalive.service" <<EOF
[Unit]
Description=Restart claude-ui-mod speech services after an explicit stop

[Service]
Type=oneshot
ExecStart=-/usr/bin/systemctl --user start cuimod-voice.service
ExecStart=-/usr/bin/systemctl --user start cuimod-prosody.service
EOF

cat > "$UNIT_ROOT/cuimod-voice-keepalive.timer" <<EOF
[Unit]
Description=Keep claude-ui-mod speech services running

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now cuimod-voice.service
systemctl --user enable --now cuimod-voice-keepalive.timer
ready=0
for _ in {1..20}; do
    if "$ROOT/venv/bin/python" - "$CONFIG_ROOT/compute.json" "$CONFIG_ROOT/token" <<'PY'
import json, sys, urllib.request
config = json.load(open(sys.argv[1], encoding='utf-8'))
value = open(sys.argv[2], encoding='utf-8').read().strip()
port = int(config.get('port', 8765))
request = urllib.request.Request(f'http://127.0.0.1:{port}/healthz', headers={'authorization': 'Bearer ' + value})
with urllib.request.urlopen(request, timeout=1) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
    then ready=1; break; fi
    sleep 0.5
done
if [[ "$ready" != 1 ]]; then
    systemctl --user status cuimod-voice.service --no-pager >&2 || true
    exit 1
fi
printf 'Compute service installed on loopback.\n'
printf 'Configuration: %s\n' "$CONFIG_ROOT/compute.json"
printf 'Token: %s (copy this file to the workstation state directory; do not paste it into source or logs)\n' "$CONFIG_ROOT/token"
printf 'For boot without an interactive login, an administrator must run: loginctl enable-linger %s\n' "$USER"
