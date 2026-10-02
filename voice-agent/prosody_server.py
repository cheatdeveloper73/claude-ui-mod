from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import io
import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_AUDIO_SECONDS = 30
MODEL_ID = 'laion/voicenet-dimension-predictors-commercial'
MODEL_REVISION = 'cdafe5170561eaadb09f012ed5ae48e4f82b7b91'
MODEL_MANIFEST_SHA256 = '68a2dd45da915648f8fbdc3e244f723d1d70f0466e9abca19e7f8e2941ae276c'
EXPECTED_DIMENSIONS = frozenset({
    'AGEV', 'AROU', 'ARSH', 'ATCK', 'BKGN', 'BRGT', 'CHNK', 'CLRT', 'COGL', 'DARC',
    'DFLU', 'EMPH', 'ESTH', 'EXPL', 'FOCS', 'FULL', 'GEND', 'HARM', 'METL', 'RANG',
    'RCQL', 'REGS', 'RESP', 'ROUG', 'R_CHST', 'R_HEAD', 'R_MASK', 'R_MIXD', 'R_NASL',
    'R_ORAL', 'R_THRT', 'SMTH', 'STNC', 'STRU', 'S_ASMR', 'S_AUTH', 'S_CART', 'S_CASU',
    'S_CONV', 'S_DRAM', 'S_FORM', 'S_MONO', 'S_NARR', 'S_NEWS', 'S_PLAY', 'S_RANT',
    'S_STRY', 'S_TECH', 'S_WHIS', 'TEMP', 'TENS', 'VALN', 'VALS', 'VFLX', 'VOLT',
    'VULN', 'WARM',
})
PROFILE_DIMENSIONS = frozenset({
    'AROU', 'ATCK', 'CLRT', 'EMPH', 'RANG', 'SMTH', 'STNC', 'TEMP', 'TENS', 'VALN',
    'VOLT', 'S_AUTH', 'S_CASU', 'S_CONV', 'S_DRAM', 'S_PLAY', 'S_RANT', 'S_STRY',
    'S_WHIS',
})


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_model_artifacts(root: Path) -> str:
    manifest_path = root / 'artifact-manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError) as error:
        raise RuntimeError('pinned prosody artifact manifest is missing or invalid') from error
    canonical = json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
    manifest_digest = hashlib.sha256(canonical).hexdigest()
    if not hmac.compare_digest(manifest_digest, MODEL_MANIFEST_SHA256):
        raise RuntimeError('pinned prosody artifact manifest identity does not match')
    if manifest.get('schemaVersion') != 1 or manifest.get('model') != MODEL_ID \
            or manifest.get('modelRevision') != MODEL_REVISION:
        raise RuntimeError('pinned prosody artifact manifest metadata does not match')
    files = manifest.get('files')
    if not isinstance(files, dict) or not files:
        raise RuntimeError('pinned prosody artifact manifest contains no files')
    for relative, expected in files.items():
        if not isinstance(relative, str) or not isinstance(expected, str) \
                or not hmac.compare_digest(_sha256(root / relative), expected):
            raise RuntimeError(f'pinned prosody artifact failed verification: {relative}')
    return manifest_digest


@dataclass
class Config:
    host: str
    port: int
    token_file: Path
    model_dir: Path
    baseline_file: Path
    device: str
    model_id: str
    model_revision: str

    @classmethod
    def load(cls, path: Path) -> 'Config':
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        return cls(
            host=str(raw.get('host', '127.0.0.1')),
            port=int(raw.get('port', 8766)),
            token_file=Path(raw.get('tokenFile', path.parent / 'token')).expanduser(),
            model_dir=Path(raw.get('modelDir', '~/.local/share/cuimod-prosody/model')).expanduser(),
            baseline_file=Path(raw.get('baselineFile', path.parent / 'prosody-baseline.json')).expanduser(),
            device=str(raw.get('device', 'cpu')),
            model_id=str(raw.get('model', MODEL_ID)),
            model_revision=str(raw.get('modelRevision', MODEL_REVISION)),
        )


class VoiceNet:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.predictor: Any = None
        self.lock = threading.Lock()
        self.loaded_at: str | None = None
        self.artifact_digest: str | None = None
        self.baseline_digest: str | None = None
        self.baseline_sample_count = 0
        self.baseline: dict[str, dict[str, float]] = {}

    def _load_baseline(self) -> None:
        path = self.config.baseline_file
        if not path.is_file():
            return
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError) as error:
            raise RuntimeError('prosody baseline is missing or invalid') from error
        dimensions = value.get('dimensions') if isinstance(value, dict) else None
        if value.get('schemaVersion') != 1 or value.get('model') != MODEL_ID \
                or value.get('modelRevision') != MODEL_REVISION \
                or not isinstance(value.get('sampleCount'), int) or value['sampleCount'] < 100 \
                or not isinstance(dimensions, dict) or not PROFILE_DIMENSIONS.issubset(dimensions):
            raise RuntimeError('prosody baseline metadata does not match the model')
        baseline: dict[str, dict[str, float]] = {}
        for code in PROFILE_DIMENSIONS:
            row = dimensions.get(code)
            median = row.get('median') if isinstance(row, dict) else None
            spread = row.get('robustSpread') if isinstance(row, dict) else None
            if isinstance(median, bool) or not isinstance(median, (int, float)) \
                    or not math.isfinite(float(median)) or isinstance(spread, bool) \
                    or not isinstance(spread, (int, float)) or not math.isfinite(float(spread)) \
                    or float(spread) < 0.25:
                raise RuntimeError(f'prosody baseline contains invalid values for {code}')
            baseline[code] = {'median': float(median), 'spread': float(spread)}
        self.baseline = baseline
        self.baseline_sample_count = value['sampleCount']
        self.baseline_digest = _sha256(path)

    def load(self) -> None:
        if self.predictor is not None:
            return
        if self.config.model_id != MODEL_ID or self.config.model_revision != MODEL_REVISION:
            raise RuntimeError('prosody model identity does not match the audited revision')
        root = self.config.model_dir
        self.artifact_digest = verify_model_artifacts(root)
        self._load_baseline()
        predictor_path = root / 'predict.py'
        if not predictor_path.is_file():
            raise RuntimeError(f'pinned prosody model is missing: {predictor_path}')
        import torch
        if self.config.device.startswith('cuda') and not torch.cuda.is_available():
            raise RuntimeError('CUDA prosody device requested but CUDA is unavailable')
        torch.set_float32_matmul_precision('high')
        module_name = 'cuimod_voicenet_predictor'
        spec = importlib.util.spec_from_file_location(module_name, predictor_path)
        if spec is None or spec.loader is None:
            raise RuntimeError('could not load pinned VoiceNet predictor')
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(root))
        try:
            spec.loader.exec_module(module)
        finally:
            try:
                sys.path.remove(str(root))
            except ValueError:
                pass
        predictor = module.VoiceNetPredictor(root=str(root), device=self.config.device)
        predictor.predict((torch.zeros(16_000), 16_000))
        self.predictor = predictor
        self.loaded_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    def analyze(self, audio: bytes) -> dict[str, Any]:
        if not audio:
            raise ValueError('audio body is empty')
        if audio[:4] != b'RIFF':
            raise ValueError('prosody input must be a WAV file')
        import torchaudio
        started = time.perf_counter()
        waveform, sample_rate = torchaudio.load(io.BytesIO(audio), format='wav')
        if sample_rate != 16_000 or waveform.ndim != 2 or waveform.shape[0] != 1:
            raise ValueError('prosody input must be mono 16 kHz audio')
        if waveform.shape[1] > MAX_AUDIO_SECONDS * sample_rate:
            raise ValueError('prosody input exceeds 30 seconds')
        with self.lock:
            dimensions = self.predictor.predict((waveform, sample_rate))
        if not isinstance(dimensions, dict) or set(dimensions) != EXPECTED_DIMENSIONS:
            raise RuntimeError('VoiceNet returned an unexpected dimension schema')
        profile: dict[str, dict[str, float]] = {}
        for code, row in dimensions.items():
            if not isinstance(row, dict):
                raise RuntimeError(f'VoiceNet returned an invalid row for {code}')
            score = row.get('reg_score')
            confidence = row.get('confidence')
            bucket = row.get('cls_bucket')
            levels = row.get('n_levels')
            if isinstance(score, bool) or not isinstance(score, (int, float)) \
                    or not math.isfinite(float(score)) or isinstance(confidence, bool) \
                    or not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1 \
                    or isinstance(bucket, bool) or not isinstance(bucket, int) \
                    or isinstance(levels, bool) or not isinstance(levels, int) \
                    or levels < 2 or not 0 <= bucket < levels:
                raise RuntimeError(f'VoiceNet returned invalid values for {code}')
            if code in PROFILE_DIMENSIONS and self.baseline:
                baseline = self.baseline[code]
                z_score = (float(score) - baseline['median']) / baseline['spread']
                profile[code] = {
                    'score': round(float(score), 3),
                    'z': round(max(-6.0, min(6.0, z_score)), 3),
                }
        return {
            'schemaVersion': 1,
            'model': self.config.model_id,
            'modelRevision': self.config.model_revision,
            'artifactDigest': self.artifact_digest,
            'baselineDigest': self.baseline_digest,
            'baselineSampleCount': self.baseline_sample_count,
            'elapsedMs': round((time.perf_counter() - started) * 1000, 3),
            'profile': profile,
            'dimensions': dimensions,
        }


class Service:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.token = config.token_file.read_text(encoding='utf-8').strip()
        if len(self.token) < 32:
            raise RuntimeError('token file must contain at least 32 characters')
        self.model = VoiceNet(config)
        self.model.load()
        self.admission = threading.BoundedSemaphore(1)
        self.started_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    def authorized(self, candidate: str | None) -> bool:
        if not candidate or not candidate.startswith('Bearer '):
            return False
        return hmac.compare_digest(candidate[7:], self.token)

    def health(self) -> dict[str, Any]:
        return {
            'ok': True,
            'startedAt': self.started_at,
            'model': self.config.model_id,
            'modelRevision': self.config.model_revision,
            'artifactDigest': self.model.artifact_digest,
            'baselineReady': bool(self.model.baseline),
            'baselineDigest': self.model.baseline_digest,
            'baselineSampleCount': self.model.baseline_sample_count,
            'modelLoadedAt': self.model.loaded_at,
            'device': self.config.device,
            'loaded': self.model.predictor is not None,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = 'CuimodProsody/1'

    @property
    def service(self) -> Service:
        return self.server.service  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print('%s - %s' % (self.address_string(), fmt % args), flush=True)

    def _json(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _body(self) -> bytes:
        length = int(self.headers.get('content-length', '0'))
        if length < 0 or length > MAX_AUDIO_BYTES:
            raise ValueError('request body is too large')
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError('request body ended early')
        return body

    def _authorize(self) -> bool:
        if self.service.authorized(self.headers.get('authorization')):
            return True
        self._json(401, {'ok': False, 'error': 'unauthorized'})
        return False

    def do_GET(self) -> None:
        if not self._authorize():
            return
        if urlparse(self.path).path == '/healthz':
            self._json(200, self.service.health())
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self) -> None:
        if not self._authorize():
            return
        if urlparse(self.path).path != '/v1/analyze':
            self._json(404, {'ok': False, 'error': 'not found'})
            return
        try:
            deadline = float(self.headers.get('x-cuimod-deadline-ms', 'inf')) / 1000
        except ValueError:
            self._json(400, {'ok': False, 'error': 'invalid request deadline'})
            return
        if time.time() >= deadline:
            self._json(408, {'ok': False, 'error': 'request deadline expired'})
            return
        if not self.service.admission.acquire(blocking=False):
            self._json(503, {'ok': False, 'error': 'prosody analyzer busy'})
            return
        try:
            audio = self._body()
            if time.time() >= deadline:
                self._json(408, {'ok': False, 'error': 'request deadline expired'})
                return
            self._json(200, self.service.model.analyze(audio))
        except ValueError as error:
            self._json(400, {'ok': False, 'error': str(error)[:500]})
        except Exception as error:
            self._json(500, {'ok': False, 'error': f'{type(error).__name__}: {error}'[:500]})
        finally:
            self.service.admission.release()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Loopback VoiceNet prosody service')
    parser.add_argument('--config', type=Path, default=Path('~/.config/cuimod-voice/prosody.json').expanduser())
    parser.add_argument('--check', action='store_true')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = Config.load(args.config)
    if config.host not in {'127.0.0.1', '::1', 'localhost'}:
        raise RuntimeError('prosody service must bind loopback')
    service = Service(config)
    if args.check:
        print(json.dumps(service.health(), indent=2))
        return
    server = ThreadingHTTPServer((config.host, config.port), Handler)
    server.service = service  # type: ignore[attr-defined]
    print(json.dumps({'listening': f'{config.host}:{config.port}', **service.health()}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
