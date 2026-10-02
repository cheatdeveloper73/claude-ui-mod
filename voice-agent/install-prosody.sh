#!/usr/bin/env bash
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/cuimod-prosody"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/cuimod-voice"
UNIT_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MODEL_ID="laion/voicenet-dimension-predictors-commercial"
MODEL_REVISION="cdafe5170561eaadb09f012ed5ae48e4f82b7b91"
MODEL_MANIFEST_SHA256="68a2dd45da915648f8fbdc3e244f723d1d70f0466e9abca19e7f8e2941ae276c"

if ! command -v python3 >/dev/null; then
    printf 'python3 is required\n' >&2
    exit 1
fi
mkdir -p "$ROOT/app" "$ROOT/model" "$CONFIG_ROOT" "$UNIT_ROOT"
python3 -m venv --clear "$ROOT/venv"
"$ROOT/venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
    -r "$SOURCE/requirements-prosody.txt"
install -m 0644 "$SOURCE/prosody_server.py" "$ROOT/app/"

if [[ ! -f "$CONFIG_ROOT/prosody.json" ]]; then
    cp "$SOURCE/prosody.example.json" "$CONFIG_ROOT/prosody.json"
fi
if [[ ! -f "$CONFIG_ROOT/token" ]]; then
    printf 'existing compute token is required at %s\n' "$CONFIG_ROOT/token" >&2
    exit 1
fi

"$ROOT/venv/bin/python" - "$ROOT/model" "$MODEL_ID" "$MODEL_REVISION" "$MODEL_MANIFEST_SHA256" <<'PY'
import hashlib, json, pathlib, sys
from huggingface_hub import snapshot_download
root = pathlib.Path(sys.argv[1])
snapshot_download(
    repo_id=sys.argv[2],
    revision=sys.argv[3],
    local_dir=root,
    allow_patterns=[
        'predict.py',
        'dimensions.py',
        'regression/*',
        'classification/*',
        'voiceclap_commercial/*',
    ],
)
paths = [root / 'predict.py', root / 'dimensions.py']
for group in ('regression', 'classification', 'voiceclap_commercial'):
    paths.extend(path for path in (root / group).rglob('*') if path.is_file() and '.cache' not in path.parts)
files = {
    path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(paths)
}
manifest = {
    'schemaVersion': 1,
    'model': sys.argv[2],
    'modelRevision': sys.argv[3],
    'files': files,
}
canonical = json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
digest = hashlib.sha256(canonical).hexdigest()
if digest != sys.argv[4]:
    raise RuntimeError(f'pinned model artifact digest mismatch: {digest}')
(root / 'artifact-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
PY

cat > "$UNIT_ROOT/cuimod-prosody.service" <<EOF
[Unit]
Description=Loopback VoiceNet prosody analysis for claude-ui-mod
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT/app
ExecStart=$ROOT/venv/bin/python $ROOT/app/prosody_server.py --config $CONFIG_ROOT/prosody.json
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

systemctl --user daemon-reload
systemctl --user enable --now cuimod-prosody.service
ready=0
for _ in {1..180}; do
    if "$ROOT/venv/bin/python" - "$CONFIG_ROOT/prosody.json" "$CONFIG_ROOT/token" 2>/dev/null <<'PY'
import json, sys, urllib.request
config = json.load(open(sys.argv[1], encoding='utf-8'))
token = open(sys.argv[2], encoding='utf-8').read().strip()
port = int(config.get('port', 8766))
request = urllib.request.Request(
    f'http://127.0.0.1:{port}/healthz',
    headers={'authorization': 'Bearer ' + token},
)
with urllib.request.urlopen(request, timeout=1) as response:
    value = json.load(response)
    raise SystemExit(0 if response.status == 200 and value.get('loaded') is True else 1)
PY
    then ready=1; break; fi
    sleep 1
done
if [[ "$ready" != 1 ]]; then
    systemctl --user status cuimod-prosody.service --no-pager >&2 || true
    exit 1
fi
printf 'Prosody service installed on loopback with pinned model revision %s.\n' "$MODEL_REVISION"
