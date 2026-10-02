from __future__ import annotations

import argparse
import hashlib
import hmac
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
import importlib.util
import io
import json
import math
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from common import SAMPLE_RATE, normalize_space, read_json, utc_now, validate_word_timestamps

MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 4 * 1024 * 1024


@dataclass
class Config:
    host: str
    port: int
    token_file: Path
    model: str
    model_dir: Path
    fallback_model: str
    fallback_confidence: float
    fallback_margin: float
    wake_model: str
    wake_model_dir: Path
    wake_device: str
    wake_device_index: int
    wake_compute_type: str
    wake_cpu_threads: int
    device: str
    compute_type: str
    cpu_threads: int
    language: str
    beam_size: int
    patience: float
    temperature: float
    secondary_vad: bool
    glossary: list[str]
    emotion: bool
    emotion_model: str
    emotion_model_dir: Path
    emotion_confidence: float
    emotion_margin: float
    prosody: bool
    prosody_url: str
    prosody_tail_ms: int
    prosody_request_timeout: float
    llm_url: str
    llm_model: str
    llm_timeout: float
    tts_voice: str
    tts_speed: float
    archive_dir: Path
    archive_min_free_gb: float

    @classmethod
    def load(cls, path: Path) -> 'Config':
        raw = read_json(path, {})
        if not isinstance(raw, dict):
            raw = {}
        return cls(
            host=str(raw.get('host', '127.0.0.1')),
            port=int(raw.get('port', 8765)),
            token_file=Path(raw.get('tokenFile', path.parent / 'token')).expanduser(),
            model=str(raw.get('model', 'medium.en')),
            model_dir=Path(raw.get('modelDir', path.parent / 'models')).expanduser(),
            fallback_model=str(raw.get('fallbackModel', 'small.en')),
            fallback_confidence=max(0.0, min(1.0, float(raw.get('fallbackConfidence', 0.50)))),
            fallback_margin=max(0.0, min(1.0, float(raw.get('fallbackMargin', 0.10)))),
            wake_model=str(raw.get('wakeModel', 'distil-small.en')),
            wake_model_dir=Path(raw.get('wakeModelDir', path.parent / 'wake-models')).expanduser(),
            wake_device=str(raw.get('wakeDevice', raw.get('device', 'cpu'))),
            wake_device_index=max(0, int(raw.get('wakeDeviceIndex', 0))),
            wake_compute_type=str(raw.get('wakeComputeType', raw.get('computeType', 'int8'))),
            wake_cpu_threads=max(1, int(raw.get('wakeCpuThreads', min(8, int(raw.get(
                'cpuThreads', max(1, (os.cpu_count() or 4) // 2))))))),
            device=str(raw.get('device', 'cpu')),
            compute_type=str(raw.get('computeType', 'int8')),
            cpu_threads=max(1, int(raw.get('cpuThreads', max(1, (os.cpu_count() or 4) // 2)))),
            language=str(raw.get('language', 'en')),
            beam_size=max(1, min(10, int(raw.get('beamSize', 5)))),
            patience=max(1.0, min(3.0, float(raw.get('patience', 1.0)))),
            temperature=max(0.0, min(1.0, float(raw.get('temperature', 0.0)))),
            secondary_vad=raw.get('secondaryVad', True) is not False,
            glossary=[normalize_space(item) for item in raw.get('glossary', []) if normalize_space(item)],
            emotion=raw.get('emotion', True) is not False,
            emotion_model=str(raw.get('emotionModel', 'emotion2vec/emotion2vec_plus_large')),
            emotion_model_dir=Path(raw.get('emotionModelDir', path.parent / 'emotion-models')).expanduser(),
            emotion_confidence=max(0.0, min(1.0, float(raw.get('emotionConfidence', 0.90)))),
            emotion_margin=max(0.0, min(1.0, float(raw.get('emotionMargin', 0.20)))),
            prosody=raw.get('prosody', False) is True,
            prosody_url=str(raw.get('prosodyUrl', 'http://127.0.0.1:8766')).rstrip('/'),
            prosody_tail_ms=max(0, min(500, int(raw.get('prosodyTailMs', 150)))),
            prosody_request_timeout=max(1.0, min(30.0, float(raw.get('prosodyRequestTimeoutSeconds', 8)))),
            llm_url=str(raw.get('llmUrl', 'http://127.0.0.1:8080')).rstrip('/'),
            llm_model=str(raw.get('llmModel', 'local')),
            llm_timeout=max(1.0, float(raw.get('llmTimeoutSeconds', 18))),
            tts_voice=str(raw.get('ttsVoice', 'af_heart')),
            tts_speed=max(0.5, min(2.0, float(raw.get('ttsSpeed', 1.0)))),
            archive_dir=Path(raw.get('archiveDir', '~/.local/share/cuimod-voice/archive')).expanduser(),
            archive_min_free_gb=max(0.0, float(raw.get('archiveMinFreeGb', 20))),
        )


class LazyAsr:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.model: Any = None
        self.fallback_model: Any = None
        self.lock = threading.Lock()

    def _load(self) -> Any:
        if self.model is not None:
            return self.model
        from faster_whisper import WhisperModel
        self.config.model_dir.mkdir(parents=True, exist_ok=True)
        self.model = WhisperModel(
            self.config.model,
            device=self.config.device,
            compute_type=self.config.compute_type,
            cpu_threads=self.config.cpu_threads,
            download_root=str(self.config.model_dir),
        )
        return self.model

    def _load_fallback(self) -> Any:
        if self.config.fallback_model == self.config.model:
            return self._load()
        if self.fallback_model is not None:
            return self.fallback_model
        from faster_whisper import WhisperModel
        self.config.model_dir.mkdir(parents=True, exist_ok=True)
        self.fallback_model = WhisperModel(
            self.config.fallback_model,
            device=self.config.device,
            compute_type=self.config.compute_type,
            cpu_threads=self.config.cpu_threads,
            download_root=str(self.config.model_dir),
        )
        return self.fallback_model

    def _decode(self, model: Any, model_name: str, path: str) -> dict[str, Any]:
        segments, info = model.transcribe(
            path,
            language=self.config.language or None,
            beam_size=self.config.beam_size,
            patience=self.config.patience,
            temperature=self.config.temperature,
            vad_filter=self.config.secondary_vad,
            condition_on_previous_text=False,
            initial_prompt=', '.join(self.config.glossary) if self.config.glossary else None,
            word_timestamps=False,
        )
        materialized = list(segments)
        text = normalize_space(' '.join(segment.text for segment in materialized))
        probabilities = [math.exp(segment.avg_logprob) for segment in materialized
                         if isinstance(segment.avg_logprob, (int, float))]
        return {
            'text': text,
            'language': getattr(info, 'language', self.config.language),
            'languageProbability': getattr(info, 'language_probability', None),
            'confidence': sum(probabilities) / len(probabilities) if probabilities else None,
            'duration': getattr(info, 'duration', None),
            'model': model_name,
        }

    def transcribe(self, audio: bytes) -> dict[str, Any]:
        if not audio:
            raise ValueError('audio body is empty')
        suffix = '.wav' if audio[:4] == b'RIFF' else '.pcm'
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                handle.write(audio)
                temporary = handle.name
            with self.lock:
                primary = self._decode(self._load(), self.config.model, temporary)
                primary_confidence = primary.get('confidence')
                evaluate = bool(self.config.fallback_model) and (
                    primary_confidence is None
                    or primary_confidence < self.config.fallback_confidence
                )
                fallback = self._decode(
                    self._load_fallback(), self.config.fallback_model, temporary
                ) if evaluate else None
            fallback_confidence = fallback.get('confidence') if fallback else None
            use_fallback = bool(fallback and fallback.get('text')) and (
                not primary.get('text')
                or primary_confidence is None
                or isinstance(fallback_confidence, (int, float))
                and fallback_confidence >= primary_confidence + self.config.fallback_margin
            )
            selected = fallback if use_fallback else primary
            return {
                **selected,
                'fallback': {
                    'evaluated': evaluate,
                    'used': use_fallback,
                    'primaryModel': self.config.model,
                    'primaryConfidence': primary_confidence,
                    'fallbackModel': self.config.fallback_model,
                    'fallbackConfidence': fallback_confidence,
                },
            }
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


class LazyWakeAsr:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.model: Any = None
        self.cpu_model: Any = None
        self.cpu_fallbacks = 0
        self.last_gpu_error = ''
        self.lock = threading.Lock()

    def _load(self) -> Any:
        if self.model is not None:
            return self.model
        from faster_whisper import WhisperModel
        self.config.wake_model_dir.mkdir(parents=True, exist_ok=True)
        self.model = WhisperModel(
            self.config.wake_model,
            device=self.config.wake_device,
            device_index=self.config.wake_device_index,
            compute_type=self.config.wake_compute_type,
            cpu_threads=self.config.wake_cpu_threads,
            download_root=str(self.config.wake_model_dir),
        )
        return self.model

    def _load_cpu(self) -> Any:
        if self.cpu_model is None:
            from faster_whisper import WhisperModel
            self.cpu_model = WhisperModel(
                self.config.wake_model,
                device='cpu',
                compute_type='int8',
                cpu_threads=self.config.wake_cpu_threads,
                download_root=str(self.config.wake_model_dir),
            )
        return self.cpu_model

    def _decode(self, model: Any, path: str) -> list[Any]:
        segments, _info = model.transcribe(
            path,
            language=self.config.language or None,
            beam_size=1,
            temperature=0.0,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=True,
        )
        return list(segments)

    def _decode_with_fallback(self, path: str) -> list[Any]:
        if self.config.wake_device == 'cpu':
            return self._decode(self._load(), path)
        # The wake card is shared with local-inference experiments, which can
        # fill it. A CUDA allocation failure then surfaces here (at load, or
        # lazily while segments are iterated) and used to become an HTTP 500
        # per probe. CPU decode is ~7x slower (456 ms vs 68 ms on a 3 s window)
        # but keeps the wake and stop-phrase path alive; the GPU is retried on
        # every request so it recovers as soon as the card has room again.
        try:
            return self._decode(self._load(), path)
        except RuntimeError as error:
            self.cpu_fallbacks += 1
            self.last_gpu_error = f'{type(error).__name__}: {error}'[:300]
            return self._decode(self._load_cpu(), path)

    def transcribe(self, audio: bytes) -> dict[str, Any]:
        if not audio:
            raise ValueError('audio body is empty')
        suffix = '.wav' if audio[:4] == b'RIFF' else '.pcm'
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                handle.write(audio)
                temporary = handle.name
            with self.lock:
                materialized = self._decode_with_fallback(temporary)
                text = normalize_space(' '.join(segment.text for segment in materialized))
                word_rows: list[dict[str, Any]] = []
                words_available = bool(materialized)
                for segment in materialized:
                    values = getattr(segment, 'words', None)
                    if values is None:
                        words_available = False
                        break
                    try:
                        for word in values:
                            row: dict[str, Any] = {
                                'word': getattr(word, 'word', None),
                                'start': getattr(word, 'start', None),
                                'end': getattr(word, 'end', None),
                            }
                            probability = getattr(word, 'probability', None)
                            if probability is not None:
                                row['probability'] = probability
                            word_rows.append(row)
                    except TypeError:
                        words_available = False
                        break
                words = validate_word_timestamps(word_rows) if words_available else []
                if words is None:
                    words = []
            return {'text': text, 'model': self.config.wake_model, 'words': words}
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


class LazyEmotion:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.model: Any = None
        self.lock = threading.Lock()

    def _load(self) -> Any:
        if self.model is not None:
            return self.model
        from funasr import AutoModel
        self.config.emotion_model_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault('HF_HOME', str(self.config.emotion_model_dir))
        self.model = AutoModel(
            model=self.config.emotion_model,
            hub='hf',
            device='cpu',
            disable_update=True,
        )
        return self.model

    @staticmethod
    def _label(value: Any) -> str:
        label = normalize_space(value).lower().rsplit('/', 1)[-1]
        return 'unknown' if label in {'<unk>', 'unk'} else label

    def analyze(self, audio: bytes) -> dict[str, Any]:
        if not audio:
            raise ValueError('audio body is empty')
        suffix = '.wav' if audio[:4] == b'RIFF' else '.pcm'
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                handle.write(audio)
                temporary = handle.name
            with self.lock:
                result = self._load().generate(
                    input=temporary,
                    granularity='utterance',
                    extract_embedding=False,
                    disable_pbar=True,
                )
            row = result[0] if isinstance(result, list) and result else {}
            labels = row.get('labels') if isinstance(row, dict) else None
            values = row.get('scores') if isinstance(row, dict) else None
            if not isinstance(labels, list) or not isinstance(values, list) or len(labels) != len(values):
                raise RuntimeError('emotion model returned invalid scores')
            scores = {
                self._label(label): max(0.0, min(1.0, float(score)))
                for label, score in zip(labels, values)
            }
            ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
            if not ranked:
                raise RuntimeError('emotion model returned no scores')
            label, confidence = ranked[0]
            runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
            margin = confidence - runner_up
            reliable = label not in {'other', 'unknown'} \
                and confidence >= self.config.emotion_confidence \
                and margin >= self.config.emotion_margin
            return {
                'label': label,
                'confidence': confidence,
                'margin': margin,
                'reliable': reliable,
                'confidenceThreshold': self.config.emotion_confidence,
                'marginThreshold': self.config.emotion_margin,
                'scores': scores,
                'model': self.config.emotion_model,
            }
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


PROSODY_MODEL = 'laion/voicenet-dimension-predictors-commercial'
PROSODY_REVISION = 'cdafe5170561eaadb09f012ed5ae48e4f82b7b91'
PROSODY_DIMENSIONS = frozenset({
    'AGEV', 'AROU', 'ARSH', 'ATCK', 'BKGN', 'BRGT', 'CHNK', 'CLRT', 'COGL', 'DARC',
    'DFLU', 'EMPH', 'ESTH', 'EXPL', 'FOCS', 'FULL', 'GEND', 'HARM', 'METL', 'RANG',
    'RCQL', 'REGS', 'RESP', 'ROUG', 'R_CHST', 'R_HEAD', 'R_MASK', 'R_MIXD', 'R_NASL',
    'R_ORAL', 'R_THRT', 'SMTH', 'STNC', 'STRU', 'S_ASMR', 'S_AUTH', 'S_CART', 'S_CASU',
    'S_CONV', 'S_DRAM', 'S_FORM', 'S_MONO', 'S_NARR', 'S_NEWS', 'S_PLAY', 'S_RANT',
    'S_STRY', 'S_TECH', 'S_WHIS', 'TEMP', 'TENS', 'VALN', 'VALS', 'VFLX', 'VOLT',
    'VULN', 'WARM',
})
PROSODY_PROFILE_DIMENSIONS = frozenset({
    'AROU', 'ATCK', 'CLRT', 'EMPH', 'RANG', 'SMTH', 'STNC', 'TEMP', 'TENS', 'VALN',
    'VOLT', 'S_AUTH', 'S_CASU', 'S_CONV', 'S_DRAM', 'S_PLAY', 'S_RANT', 'S_STRY',
    'S_WHIS',
})


class ProsodyClient:
    def __init__(self, config: Config) -> None:
        self.config = config
        parsed = urlparse(config.prosody_url)
        if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', '::1', 'localhost'} \
                or parsed.username is not None or parsed.password is not None:
            raise RuntimeError('prosody URL must be unauthenticated loopback HTTP')
        self.token = config.token_file.read_text(encoding='utf-8').strip()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='voice-prosody')
        self.lock = threading.Lock()
        self.in_flight: Future[dict[str, Any]] | None = None
        self.attempts = 0
        self.ready = 0
        self.busy = 0
        self.timeouts = 0
        self.errors = 0
        self.last_status = 'disabled' if not config.prosody else 'idle'
        self.last_error = ''
        self.last_elapsed_ms: float | None = None

    @staticmethod
    def _digest(value: Any) -> bool:
        return isinstance(value, str) and len(value) == 64 \
            and all(character in '0123456789abcdef' for character in value)

    @staticmethod
    def _number(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        number = float(value)
        return number if math.isfinite(number) else None

    def _validate(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or value.get('schemaVersion') != 1 \
                or value.get('model') != PROSODY_MODEL or value.get('modelRevision') != PROSODY_REVISION \
                or not self._digest(value.get('artifactDigest')) \
                or not self._digest(value.get('baselineDigest')) \
                or not isinstance(value.get('baselineSampleCount'), int) \
                or value['baselineSampleCount'] < 100:
            raise RuntimeError('prosody service returned mismatched metadata')
        profile = value.get('profile')
        dimensions = value.get('dimensions')
        if not isinstance(profile, dict) or set(profile) != PROSODY_PROFILE_DIMENSIONS \
                or not isinstance(dimensions, dict) or set(dimensions) != PROSODY_DIMENSIONS:
            raise RuntimeError('prosody service returned an unexpected schema')
        clean_profile: dict[str, dict[str, float]] = {}
        for code, row in profile.items():
            score = self._number(row.get('score')) if isinstance(row, dict) else None
            z_score = self._number(row.get('z')) if isinstance(row, dict) else None
            if score is None or z_score is None or not -6 <= z_score <= 6:
                raise RuntimeError(f'prosody service returned invalid profile values for {code}')
            clean_profile[code] = {'score': round(score, 3), 'z': round(z_score, 3)}
        clean_dimensions: dict[str, dict[str, float | int]] = {}
        for code, row in dimensions.items():
            score = self._number(row.get('reg_score')) if isinstance(row, dict) else None
            confidence = self._number(row.get('confidence')) if isinstance(row, dict) else None
            bucket = row.get('cls_bucket') if isinstance(row, dict) else None
            levels = row.get('n_levels') if isinstance(row, dict) else None
            if score is None or confidence is None or not 0 <= confidence <= 1 \
                    or isinstance(bucket, bool) or not isinstance(bucket, int) \
                    or isinstance(levels, bool) or not isinstance(levels, int) \
                    or levels < 2 or not 0 <= bucket < levels:
                raise RuntimeError(f'prosody service returned invalid dimension values for {code}')
            clean_dimensions[code] = {
                'score': round(score, 3),
                'bucket': bucket,
                'confidence': round(confidence, 3),
                'levels': levels,
            }
        elapsed = self._number(value.get('elapsedMs'))
        return {
            'schemaVersion': 1,
            'status': 'ready',
            'model': PROSODY_MODEL,
            'modelRevision': PROSODY_REVISION,
            'artifactDigest': value['artifactDigest'],
            'baselineDigest': value['baselineDigest'],
            'baselineSampleCount': value['baselineSampleCount'],
            'elapsedMs': round(max(0.0, elapsed or 0.0), 3),
            'profile': clean_profile,
            'dimensions': clean_dimensions,
        }

    def _request(self, audio: bytes) -> dict[str, Any]:
        deadline = time.time() + self.config.prosody_request_timeout
        request = urllib.request.Request(
            self.config.prosody_url + '/v1/analyze',
            data=audio,
            headers={
                'authorization': 'Bearer ' + self.token,
                'content-type': 'audio/wav',
                'x-cuimod-deadline-ms': str(round(deadline * 1000)),
            },
            method='POST',
        )
        with urllib.request.urlopen(request, timeout=self.config.prosody_request_timeout) as response:
            body = response.read(MAX_JSON_BYTES + 1)
            if len(body) > MAX_JSON_BYTES:
                raise RuntimeError('prosody response is too large')
        return self._validate(json.loads(body))

    def _finished(self, future: Future[dict[str, Any]]) -> None:
        with self.lock:
            if self.in_flight is future:
                self.in_flight = None

    def submit(self, audio: bytes) -> Future[dict[str, Any]] | dict[str, Any]:
        if not self.config.prosody:
            return {'schemaVersion': 1, 'status': 'disabled'}
        with self.lock:
            if self.in_flight is not None and not self.in_flight.done():
                self.busy += 1
                self.last_status = 'busy'
                return {'schemaVersion': 1, 'status': 'busy'}
            self.attempts += 1
            future = self.executor.submit(self._request, audio)
            self.in_flight = future
        future.add_done_callback(self._finished)
        return future

    def resolve(self, ticket: Future[dict[str, Any]] | dict[str, Any]) -> dict[str, Any]:
        if isinstance(ticket, dict):
            return ticket
        try:
            value = ticket.result(timeout=self.config.prosody_tail_ms / 1000)
        except FutureTimeout:
            with self.lock:
                self.timeouts += 1
                self.last_status = 'timeout'
            return {'schemaVersion': 1, 'status': 'timeout'}
        except Exception as error:
            message = f'{type(error).__name__}: {error}'[:240]
            with self.lock:
                self.errors += 1
                self.last_status = 'error'
                self.last_error = message
            return {'schemaVersion': 1, 'status': 'error', 'error': message}
        with self.lock:
            self.ready += 1
            self.last_status = 'ready'
            self.last_error = ''
            self.last_elapsed_ms = value['elapsedMs']
        return value

    def health(self) -> dict[str, Any]:
        with self.lock:
            return {
                'enabled': self.config.prosody,
                'url': self.config.prosody_url,
                'tailMs': self.config.prosody_tail_ms,
                'requestTimeoutSeconds': self.config.prosody_request_timeout,
                'inFlight': self.in_flight is not None and not self.in_flight.done(),
                'attempts': self.attempts,
                'ready': self.ready,
                'busy': self.busy,
                'timeouts': self.timeouts,
                'errors': self.errors,
                'lastStatus': self.last_status,
                'lastError': self.last_error,
                'lastElapsedMs': self.last_elapsed_ms,
            }


class LocalLlm:
    def __init__(self, config: Config) -> None:
        self.config = config

    def summarize(self, transcript: str) -> str:
        transcript = str(transcript or '').strip()
        if not transcript:
            raise ValueError('transcript is empty')
        body = json.dumps({
            'model': self.config.llm_model,
            'temperature': 0.2,
            'max_tokens': 768,
            'chat_template_kwargs': {'enable_thinking': False},
            'messages': [
                {'role': 'system', 'content': 'Give a concise spoken status summary of this Claude Code conversation. State what was completed, what is running, blockers, and the next decision. Use plain prose. Do not mention hidden reasoning or tool internals.'},
                {'role': 'user', 'content': transcript[-100_000:]},
            ],
        }).encode('utf-8')
        request = urllib.request.Request(
            self.config.llm_url + '/v1/chat/completions',
            data=body,
            headers={'content-type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(request, timeout=max(self.config.llm_timeout, 45)) as response:
            result = json.loads(response.read(MAX_JSON_BYTES))
        text = normalize_space(result['choices'][0]['message']['content'])
        if not text:
            raise ValueError('summarizer returned no text')
        return text


class LazyTts:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.pipeline: Any = None
        self.lock = threading.Lock()

    def _load(self) -> Any:
        if self.pipeline is None:
            from kokoro import KPipeline
            self.pipeline = KPipeline(lang_code='a')
        return self.pipeline

    def synthesize(self, text: str, voice: str | None = None, speed: float | None = None) -> bytes:
        text = normalize_space(text)
        if not text:
            raise ValueError('text is empty')
        voice = normalize_space(voice) or self.config.tts_voice
        speed = self.config.tts_speed if speed is None else max(0.5, min(2.0, float(speed)))
        import numpy as np
        with self.lock:
            pipeline = self._load()
            parts = [np.asarray(audio, dtype=np.float32) for _graphemes, _phonemes, audio in pipeline(
                text,
                voice=voice,
                speed=speed,
                split_pattern=r'\n+',
            )]
        if not parts:
            raise ValueError('TTS produced no audio')
        audio = np.concatenate(parts)
        pcm = np.clip(audio, -1.0, 1.0)
        pcm = (pcm * 32767.0).astype('<i2').tobytes()
        output = io.BytesIO()
        with wave.open(output, 'wb') as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(24_000)
            target.writeframes(pcm)
        return output.getvalue()


ARCHIVE_NAME = re.compile(r'raw-(\d{4})(\d{2})(\d{2})T\d{9}Z')
ARCHIVE_COLLECTIONS = frozenset({'utterances', 'events', 'deferred', 'recovery'})
ARCHIVE_SEGMENT = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}')


class ArchiveFull(RuntimeError):
    pass


class Archive:
    """Permanent home of the workstation's audio and voice evidence.

    The workstation deletes its copy only after this returns, so a reply means
    the FLAC on disk has been decoded back to the uploaded samples and fsynced
    under its final name. FLAC measured 18% of WAV on real 16 kHz room audio.
    """

    def __init__(self, root: Path, min_free_bytes: int) -> None:
        self.root = root
        self.min_free_bytes = max(0, int(min_free_bytes))
        self.lock = threading.Lock()
        self.stored = 0
        self.stored_bytes = 0
        self.last_error: str | None = None

    @staticmethod
    def _decode(path: Path) -> bytes:
        import soundfile
        samples, rate = soundfile.read(str(path), dtype='int16')
        if rate != SAMPLE_RATE or samples.ndim != 1:
            raise RuntimeError(f'{path.name} is not 16 kHz mono')
        return samples.tobytes()

    @staticmethod
    def _fsync(path: Path) -> None:
        if path.is_dir():
            # Windows cannot open a directory for flushing; the compute host is Linux.
            if os.name == 'nt':
                return
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            return
        with path.open('r+b') as handle:
            os.fsync(handle.fileno())

    def store(self, name: str, sha256: str, body: bytes) -> dict[str, Any]:
        match = ARCHIVE_NAME.fullmatch(str(name))
        if not match:
            raise ValueError('archive name is invalid')
        return self._store(self.root / match[1] / match[2] / match[3], f'{name}.wav', sha256, body,
                           require_audio=True)

    def store_file(self, collection: str, relative: str, sha256: str, body: bytes) -> dict[str, Any]:
        """Utterances, sidecars, event segments and other evidence leaving the workstation."""
        if collection not in ARCHIVE_COLLECTIONS:
            raise ValueError('archive collection is not accepted')
        parts = str(relative).split('/')
        if not 1 <= len(parts) <= 4 or any(not ARCHIVE_SEGMENT.fullmatch(part) for part in parts):
            raise ValueError('archive path is invalid')
        return self._store(self.root.joinpath(collection, *parts[:-1]), parts[-1], sha256, body,
                           require_audio=False)

    @staticmethod
    def _speech_pcm(body: bytes) -> bytes | None:
        try:
            with wave.open(io.BytesIO(body), 'rb') as source:
                if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
                    return None
                return source.readframes(source.getnframes())
        except (EOFError, wave.Error):
            return None

    def _store(self, directory: Path, filename: str, sha256: str, body: bytes,
               require_audio: bool) -> dict[str, Any]:
        digest = hashlib.sha256(body).hexdigest()
        if not hmac.compare_digest(digest, str(sha256).lower()):
            raise ValueError('archive checksum does not match the upload')
        # 16 kHz speech WAV becomes FLAC checked sample for sample; anything
        # else is kept byte for byte.
        pcm = self._speech_pcm(body) if filename.endswith('.wav') else None
        if pcm is None and require_audio:
            raise ValueError('archive audio must be a 16 kHz mono 16-bit PCM WAV')
        stem, extension = (filename[:-4], '.flac') if pcm is not None else os.path.splitext(filename)
        stored = pcm if pcm is not None else body
        with self.lock:
            # A resend after a lost reply is the same file; a different body under
            # the same name is kept beside it rather than chosen between.
            for final in (directory / f'{stem}{extension}', directory / f'{stem}.{digest[:16]}{extension}'):
                if not final.exists():
                    break
                existing = self._decode(final) if pcm is not None else final.read_bytes()
                if existing == stored:
                    return self._reply(final, pcm, digest, duplicate=True)
            else:
                raise RuntimeError(f'{filename} already has two different archived bodies')
            directory.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(directory).free - len(body) < self.min_free_bytes:
                self.last_error = 'archive volume is below its free-space floor'
                raise ArchiveFull(self.last_error)
            temporary = directory / f'.{final.name}.tmp'
            try:
                if pcm is not None:
                    import numpy
                    import soundfile
                    soundfile.write(str(temporary), numpy.frombuffer(pcm, dtype='<i2'), SAMPLE_RATE,
                                    format='FLAC', subtype='PCM_16')
                    if self._decode(temporary) != pcm:
                        raise RuntimeError('FLAC round trip changed the audio')
                else:
                    temporary.write_bytes(body)
                    if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                        raise RuntimeError('archived bytes do not match the upload')
                self._fsync(temporary)
                os.replace(temporary, final)
                self._fsync(directory)
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
            self.stored += 1
            self.stored_bytes += final.stat().st_size
            self.last_error = None
            return self._reply(final, pcm, digest, duplicate=False)

    @staticmethod
    def _reply(final: Path, pcm: bytes | None, digest: str, duplicate: bool) -> dict[str, Any]:
        reply = {
            'ok': True,
            'path': str(final),
            'sha256': digest,
            'bytes': final.stat().st_size,
            'duplicate': duplicate,
        }
        if pcm is not None:
            reply['samples'] = len(pcm) // 2
        return reply

    def health(self) -> dict[str, Any]:
        try:
            free = shutil.disk_usage(self.root if self.root.exists() else self.root.parent).free
        except OSError:
            free = None
        return {
            'dir': str(self.root),
            'stored': self.stored,
            'storedBytes': self.stored_bytes,
            'freeBytes': free,
            'minFreeBytes': self.min_free_bytes,
            'lastError': self.last_error,
        }


class Service:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.asr = LazyAsr(config)
        self.wake_asr = LazyWakeAsr(config)
        self.emotion = LazyEmotion(config)
        self.prosody = ProsodyClient(config)
        self.llm = LocalLlm(config)
        self.tts = LazyTts(config)
        self.archive = Archive(config.archive_dir, int(config.archive_min_free_gb * 1024 ** 3))
        self.started_at = utc_now()
        self.token = config.token_file.read_text(encoding='utf-8').strip()
        if len(self.token) < 32:
            raise RuntimeError('token file must contain at least 32 characters')

    def authorized(self, candidate: str | None) -> bool:
        if not candidate or not candidate.startswith('Bearer '):
            return False
        return hmac.compare_digest(candidate[7:], self.token)

    def transcribe(self, audio: bytes, include_emotion: bool = True,
                   include_prosody: bool = True) -> dict[str, Any]:
        prosody_ticket = self.prosody.submit(audio) if include_prosody \
            else {'schemaVersion': 1, 'status': 'disabled'}
        raw = self.asr.transcribe(audio)
        emotion = None
        emotion_error = None
        if self.config.emotion and include_emotion:
            try:
                emotion = self.emotion.analyze(audio)
            except Exception as error:
                emotion_error = f'{type(error).__name__}: {error}'[:240]
        prosody = self.prosody.resolve(prosody_ticket)
        return {
            **raw,
            'rawText': raw['text'],
            'text': raw['text'],
            'refined': False,
            'refineError': None,
            'emotion': emotion,
            'emotionError': emotion_error,
            'prosody': prosody,
        }

    def health(self) -> dict[str, Any]:
        return {
            'ok': True,
            'startedAt': self.started_at,
            'asr': {
                'package': importlib.util.find_spec('faster_whisper') is not None,
                'loaded': self.asr.model is not None,
                'model': self.config.model,
                'fallbackModel': self.config.fallback_model,
                'fallbackLoaded': self.asr.fallback_model is not None,
                'fallbackConfidence': self.config.fallback_confidence,
                'fallbackMargin': self.config.fallback_margin,
                'device': self.config.device,
                'computeType': self.config.compute_type,
                'beamSize': self.config.beam_size,
                'patience': self.config.patience,
                'temperature': self.config.temperature,
                'secondaryVad': self.config.secondary_vad,
            },
            'wakeAsr': {
                'package': importlib.util.find_spec('faster_whisper') is not None,
                'loaded': self.wake_asr.model is not None,
                'model': self.config.wake_model,
                'device': self.config.wake_device,
                'deviceIndex': self.config.wake_device_index,
                'computeType': self.config.wake_compute_type,
                'cpuThreads': self.config.wake_cpu_threads,
                'beamSize': 1,
                'secondaryVad': True,
                'cpuFallbacks': self.wake_asr.cpu_fallbacks,
                'lastGpuError': self.wake_asr.last_gpu_error,
            },
            'emotion': {
                'enabled': self.config.emotion,
                'package': importlib.util.find_spec('funasr') is not None,
                'loaded': self.emotion.model is not None,
                'model': self.config.emotion_model,
                'confidenceThreshold': self.config.emotion_confidence,
                'marginThreshold': self.config.emotion_margin,
            },
            'prosody': self.prosody.health(),
            'summarizer': {'url': self.config.llm_url},
            'archive': self.archive.health(),
            'tts': {
                'package': importlib.util.find_spec('kokoro') is not None,
                'loaded': self.tts.pipeline is not None,
                'voice': self.config.tts_voice,
            },
        }


class Handler(BaseHTTPRequestHandler):
    server_version = 'CuimodVoiceCompute/1'

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

    def _bytes(self, status: int, value: bytes, content_type: str) -> None:
        try:
            self.send_response(status)
            self.send_header('content-type', content_type)
            self.send_header('content-length', str(len(value)))
            self.end_headers()
            self.wfile.write(value)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _body(self, limit: int) -> bytes:
        length = int(self.headers.get('content-length', '0'))
        if length < 0 or length > limit:
            raise ValueError('request body is too large')
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError('request body ended early')
        return body

    def _payload(self) -> dict[str, Any]:
        value = json.loads(self._body(MAX_JSON_BYTES))
        if not isinstance(value, dict):
            raise ValueError('JSON object required')
        return value

    def _authorize(self) -> bool:
        if self.service.authorized(self.headers.get('authorization')):
            return True
        self._json(401, {'ok': False, 'error': 'unauthorized'})
        return False

    def do_GET(self) -> None:
        if not self._authorize():
            return
        route = urlparse(self.path).path
        if route == '/healthz':
            self._json(200, self.service.health())
        else:
            self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self) -> None:
        if not self._authorize():
            return
        route = urlparse(self.path)
        try:
            if route.path == '/v1/wake':
                self._json(200, self.service.wake_asr.transcribe(self._body(MAX_AUDIO_BYTES)))
            elif route.path == '/v1/transcribe':
                audio = self._body(MAX_AUDIO_BYTES)
                query = parse_qs(route.query)
                self._json(200, self.service.transcribe(
                    audio,
                    include_emotion=query.get('emotion', ['1'])[0] != '0',
                    include_prosody=query.get('prosody', ['1'])[0] != '0',
                ))
            elif route.path == '/v1/archive':
                query = parse_qs(route.query)
                self._json(200, self.service.archive.store(
                    query.get('name', [''])[0], query.get('sha256', [''])[0], self._body(MAX_AUDIO_BYTES)))
            elif route.path == '/v1/archive/file':
                query = parse_qs(route.query)
                self._json(200, self.service.archive.store_file(
                    query.get('collection', [''])[0], query.get('path', [''])[0],
                    query.get('sha256', [''])[0], self._body(MAX_AUDIO_BYTES)))
            elif route.path == '/v1/summarize':
                payload = self._payload()
                self._json(200, {'text': self.service.llm.summarize(str(payload.get('transcript', '')))})
            elif route.path == '/v1/tts':
                payload = self._payload()
                wav = self.service.tts.synthesize(str(payload.get('text', '')), payload.get('voice'), payload.get('speed'))
                self._bytes(200, wav, 'audio/wav')
            else:
                self._json(404, {'ok': False, 'error': 'not found'})
        except (ValueError, json.JSONDecodeError) as error:
            self._json(400, {'ok': False, 'error': str(error)[:500]})
        except ArchiveFull as error:
            self._json(507, {'ok': False, 'error': str(error)[:500]})
        except Exception as error:
            self._json(500, {'ok': False, 'error': f'{type(error).__name__}: {error}'[:500]})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Loopback speech compute service')
    parser.add_argument('--config', type=Path, default=Path('~/.config/cuimod-voice/compute.json').expanduser())
    parser.add_argument('--check', action='store_true')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = Config.load(args.config)
    service = Service(config)
    if args.check:
        print(json.dumps(service.health(), indent=2))
        return
    if config.host not in {'127.0.0.1', '::1', 'localhost'}:
        raise RuntimeError('compute service must bind loopback')
    server = ThreadingHTTPServer((config.host, config.port), Handler)
    server.service = service  # type: ignore[attr-defined]
    print(json.dumps({'listening': f'{config.host}:{config.port}', **service.health()}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
