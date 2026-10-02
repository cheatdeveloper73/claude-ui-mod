from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, urlparse

PROCESS_STARTED = time.monotonic()

from common import (
    ContinuousJournal,
    EventStore,
    FrameReader,
    PcmSpool,
    Recognition,
    SAMPLE_RATE,
    VoiceState,
    atomic_json,
    audio_listing,
    hold_audio_residency,
    match_stop_phrase_words,
    normalize_space,
    prune_audio,
    read_json,
    recover_spools,
    resolve_input_device,
    safe_target,
    utc_now,
)

MAX_JSON_BYTES = 4 * 1024 * 1024


class RuntimeConfig:
    DEFAULTS: dict[str, Any] = {
        'host': '127.0.0.1',
        'port': 18764,
        'recorderPort': 18766,
        'computeUrl': 'http://127.0.0.1:18765',
        'computeTokenFile': '',
        'sshHost': '',
        'sshUser': '',
        'sshPort': 22,
        'sshIdentity': '',
        'computeRemotePort': 8765,
        'inputDevice': None,
        'wakeEnabled': True,
        'wakePhrases': ['hey agent'],
        'stopPhrase': 'green apple',
        'armSeconds': 25,
        'vadThreshold': 0.5,
        'energyThreshold': 0.012,
        'silenceMs': 700,
        'preRollMs': 960,
        'minimumSpeechMs': 224,
        'segmentSeconds': 25,
        'commandGraceMs': 1200,
        'continuousJournal': False,
        'journalChunkSeconds': 60,
        'retentionDays': 30,
        'emotionEnabled': True,
        'cueEnabled': True,
        'ttsEnabled': True,
        'ttsVoice': 'af_heart',
        'ttsSpeed': 1.0,
    }

    def __init__(self, path: Path, state_root: Path) -> None:
        self.path = path
        self.state_root = state_root
        self.lock = threading.RLock()
        self.values = dict(self.DEFAULTS)
        loaded = read_json(path, {})
        stale_keys = False
        if isinstance(loaded, dict):
            self.values.update({key: loaded[key] for key in self.DEFAULTS if key in loaded})
            stale_keys = any(key not in self.DEFAULTS for key in loaded)
        if not self.values.get('computeTokenFile'):
            self.values['computeTokenFile'] = str(state_root / 'compute-token')
        self.values['stopPhrase'] = normalize_space(self.values.get('stopPhrase')).lower() or 'green apple'
        if stale_keys:
            atomic_json(self.path, self.values)

    def get(self, key: str) -> Any:
        with self.lock:
            return self.values.get(key)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.values)

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            'wakeEnabled', 'wakePhrases', 'stopPhrase', 'armSeconds', 'vadThreshold', 'energyThreshold',
            'silenceMs', 'preRollMs', 'minimumSpeechMs', 'segmentSeconds', 'commandGraceMs',
            'continuousJournal', 'journalChunkSeconds', 'retentionDays',
            'emotionEnabled', 'cueEnabled', 'ttsEnabled', 'ttsVoice', 'ttsSpeed', 'inputDevice',
        }
        with self.lock:
            for key, value in patch.items():
                if key in allowed:
                    self.values[key] = value
            self.values['stopPhrase'] = normalize_space(self.values.get('stopPhrase')).lower() or 'green apple'
            atomic_json(self.path, self.values)
            return dict(self.values)


class Tunnel:
    def __init__(self, config: RuntimeConfig, events: EventStore) -> None:
        self.config = config
        self.events = events
        self.process: subprocess.Popen[bytes] | None = None
        self.lock = threading.Lock()
        self.last_error = ''

    def ensure(self) -> None:
        host = normalize_space(self.config.get('sshHost'))
        if not host:
            return
        with self.lock:
            if self.process and self.process.poll() is None:
                return
            user = normalize_space(self.config.get('sshUser'))
            destination = f'{user}@{host}' if user else host
            local_port = urlparse(str(self.config.get('computeUrl'))).port or 18765
            remote_port = int(self.config.get('computeRemotePort'))
            args = [
                'ssh', '-N', '-T',
                '-o', 'BatchMode=yes',
                '-o', 'ExitOnForwardFailure=yes',
                '-o', 'ServerAliveInterval=15',
                '-o', 'ServerAliveCountMax=3',
                '-p', str(int(self.config.get('sshPort'))),
                '-L', f'127.0.0.1:{local_port}:127.0.0.1:{remote_port}',
            ]
            identity = str(self.config.get('sshIdentity') or '').strip()
            if identity:
                args.extend(['-i', os.path.expandvars(os.path.expanduser(identity))])
            args.append(destination)
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            try:
                self.process = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    creationflags=flags,
                )
                self.last_error = ''
                self.events.append('transport.started', {'destination': host, 'localPort': local_port})
            except OSError as error:
                self.last_error = str(error)
                self.events.append('transport.failed', {'error': self.last_error[:500]})
                raise

    def stop(self) -> None:
        with self.lock:
            process, self.process = self.process, None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()

    def status(self) -> dict[str, Any]:
        return {
            'configured': bool(normalize_space(self.config.get('sshHost'))),
            'running': bool(self.process and self.process.poll() is None),
            'error': self.last_error or None,
        }


class ComputeClient:
    def __init__(self, config: RuntimeConfig, tunnel: Tunnel) -> None:
        self.config = config
        self.tunnel = tunnel

    def _token(self) -> str:
        path = Path(str(self.config.get('computeTokenFile'))).expanduser()
        token = path.read_text(encoding='utf-8').strip()
        if len(token) < 32:
            raise RuntimeError('compute token is missing or too short')
        return token

    def request(self, method: str, route: str, body: bytes | None = None,
                content_type: str = 'application/json', timeout: float = 120) -> tuple[bytes, str]:
        self.tunnel.ensure()
        request = urllib.request.Request(
            str(self.config.get('computeUrl')).rstrip('/') + route,
            data=body,
            method=method,
            headers={
                'authorization': 'Bearer ' + self._token(),
                'content-type': content_type,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(64 * 1024 * 1024), response.headers.get('content-type', '')
        except Exception:
            if self.tunnel.process and self.tunnel.process.poll() is not None:
                self.tunnel.stop()
            raise

    def health(self) -> dict[str, Any]:
        body, _ = self.request('GET', '/healthz', timeout=3)
        return json.loads(body)

    def wake(self, wav: bytes) -> dict[str, Any]:
        body, _ = self.request('POST', '/v1/wake', wav, 'audio/wav', timeout=15)
        value = json.loads(body)
        if not isinstance(value, dict):
            raise RuntimeError('compute service returned an invalid wake transcript')
        return value

    def transcribe(self, wav: bytes) -> dict[str, Any]:
        acoustic = '1' if self.config.get('emotionEnabled') else '0'
        body, _ = self.request(
            'POST', f'/v1/transcribe?emotion={acoustic}&prosody={acoustic}',
            wav, 'audio/wav', timeout=180,
        )
        value = json.loads(body)
        if not isinstance(value, dict):
            raise RuntimeError('compute service returned an invalid transcript')
        return value

    def archive(self, name: str, sha256: str, wav: bytes) -> dict[str, Any]:
        body, _ = self.request('POST', f'/v1/archive?name={name}&sha256={sha256}', wav, 'audio/wav', timeout=120)
        value = json.loads(body)
        if not isinstance(value, dict):
            raise RuntimeError('compute service returned an invalid archive reply')
        return value

    def archive_file(self, collection: str, relative: str, sha256: str, body: bytes) -> dict[str, Any]:
        route = (f'/v1/archive/file?collection={quote(collection, safe="")}'
                 f'&path={quote(relative, safe="")}&sha256={sha256}')
        reply, _ = self.request('POST', route, body, 'application/octet-stream', timeout=120)
        value = json.loads(reply)
        if not isinstance(value, dict):
            raise RuntimeError('compute service returned an invalid archive reply')
        return value

    def summarize(self, transcript: str) -> str:
        body = json.dumps({'transcript': transcript}).encode('utf-8')
        result, _ = self.request('POST', '/v1/summarize', body, timeout=90)
        value = json.loads(result)
        text = normalize_space(value.get('text') if isinstance(value, dict) else '')
        if not text:
            raise RuntimeError('compute service returned an empty summary')
        return text

    def tts(self, text: str) -> bytes:
        body = json.dumps({
            'text': text,
            'voice': self.config.get('ttsVoice'),
            'speed': self.config.get('ttsSpeed'),
        }).encode('utf-8')
        result, content_type = self.request('POST', '/v1/tts', body, timeout=180)
        if 'audio/wav' not in content_type or result[:4] != b'RIFF':
            raise RuntimeError('compute service returned invalid speech audio')
        return result


class Playback:
    def __init__(self, compute: ComputeClient, events: EventStore,
                 root: Path, config: RuntimeConfig) -> None:
        self.compute = compute
        self.events = events
        self.root = root
        self.config = config
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='voice-playback')
        self.lock = threading.Lock()
        self.playing = False

    def speak(self, text: str, kind: str = 'speech') -> None:
        text = normalize_space(text)
        if not text:
            return
        self.executor.submit(self._speak, text, kind)

    def cue(self, kind: str, blocking: bool = False) -> bool:
        if self.config.get('cueEnabled') is not True or kind not in {'start', 'accepted'}:
            return False
        path = self.root / 'cues' / f'{kind}.wav'
        if not path.is_file():
            return False
        future = self.executor.submit(self._cue, path, kind)
        if blocking:
            try:
                return future.result(timeout=3)
            except Exception:
                return False
        return True

    def _cue(self, path: Path, kind: str) -> bool:
        try:
            import numpy as np
            import sounddevice as sd
            with wave.open(str(path), 'rb') as source:
                rate = source.getframerate()
                channels = source.getnchannels()
                width = source.getsampwidth()
                frames = source.readframes(source.getnframes())
            if width != 2:
                raise RuntimeError('only 16-bit cue audio is supported')
            audio = np.frombuffer(frames, dtype='<i2').reshape(-1, channels)
            self.events.append('cue.started', {'cueKind': kind})
            sd.play(audio, rate, blocking=True)
            self.events.append('cue.finished', {'cueKind': kind})
            return True
        except Exception as error:
            self.events.append('cue.failed', {
                'cueKind': kind,
                'error': f'{type(error).__name__}: {error}'[:500],
            })
            return False

    def _speak(self, text: str, kind: str) -> None:
        try:
            wav = self.compute.tts(text)
            import numpy as np
            import sounddevice as sd
            with wave.open(io.BytesIO(wav), 'rb') as source:
                rate = source.getframerate()
                channels = source.getnchannels()
                width = source.getsampwidth()
                frames = source.readframes(source.getnframes())
            if width != 2:
                raise RuntimeError('only 16-bit TTS output is supported')
            audio = np.frombuffer(frames, dtype='<i2').reshape(-1, channels)
            with self.lock:
                self.playing = True
            self.events.append('speech.started', {'speechKind': kind, 'text': text})
            sd.play(audio, rate, blocking=True)
            self.events.append('speech.finished', {'speechKind': kind})
        except Exception as error:
            self.events.append('speech.failed', {'speechKind': kind, 'error': f'{type(error).__name__}: {error}'[:500]})
        finally:
            with self.lock:
                self.playing = False

    def stop(self) -> None:
        try:
            import sounddevice as sd
            sd.stop()
        except Exception:
            pass
        with self.lock:
            self.playing = False

    def close(self) -> None:
        self.stop()
        self.executor.shutdown(wait=False, cancel_futures=True)


class WakeProbe:
    def __init__(self, compute: ComputeClient, state: VoiceState,
                 events: EventStore, playback: Playback,
                 stop_callback: Callable[[str, int], Any] | None = None) -> None:
        self.compute = compute
        self.state = state
        self.events = events
        self.playback = playback
        self.stop_callback = stop_callback
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='voice-wake-probe')
        self.lock = threading.Lock()
        self.closed = False
        self.generation = 0
        self.active_id: str | None = None
        self.route: dict[str, Any] = {}
        self.wake_acknowledged = False
        self.wake_boundary_sample: int | None = None
        self.stop_acknowledged = False
        self.acknowledged = False
        self.in_flight = False
        self.attempts = 0
        self.detections = 0
        self.stop_detections = 0
        self.stale_results = 0
        self.last_latency_ms: int | None = None
        self.last_error: str | None = None
        self.last_error_at = 0.0

    def set_stop_callback(self, callback: Callable[[str, int], Any] | None) -> None:
        with self.lock:
            self.stop_callback = callback

    def begin(self, audio_id: str, route: dict[str, Any] | None = None) -> None:
        with self.lock:
            self.generation += 1
            self.active_id = audio_id
            self.route = dict(route) if isinstance(route, dict) else self.state.snapshot()
            self.wake_acknowledged = False
            self.wake_boundary_sample = None
            self.stop_acknowledged = False
            self.acknowledged = False

    def ready(self, audio_id: str) -> bool:
        with self.lock:
            return not self.closed and self.active_id == audio_id \
                and not self.stop_acknowledged and not self.in_flight

    def interval_ms(self) -> int:
        with self.lock:
            stopping = self.route.get('mode') == 'dictation' or self.route.get('armed') is True \
                or self.route.get('commandPending') is True or self.wake_acknowledged
        # Tighten only an active interaction. ready() still permits one ASR
        # request at a time; background wake listening keeps its old cadence.
        return 200 if stopping or self.state.has_pending_command() else 500

    def submit(self, audio_id: str, wav: bytes, snapshot_start: int | None = None,
               snapshot_end: int | None = None) -> bool:
        with self.lock:
            if self.closed or self.active_id != audio_id or self.stop_acknowledged or self.in_flight:
                return False
            self.in_flight = True
            generation = self.generation
            self.attempts += 1
        try:
            self.executor.submit(self._run, generation, audio_id, wav, snapshot_start, snapshot_end)
            return True
        except RuntimeError:
            with self.lock:
                self.in_flight = False
            return False

    def _run(self, generation: int, audio_id: str, wav: bytes,
             snapshot_start: int | None, snapshot_end: int | None) -> None:
        started = time.monotonic()
        try:
            result = self.compute.wake(wav)
            value = result if isinstance(result, dict) else {}
            text = normalize_space(value.get('text'))
            with self.lock:
                route = dict(self.route)
                prior_wake_ack = self.wake_acknowledged
                prior_wake_boundary = self.wake_boundary_sample
            command_pending = route.get('commandPending') is True or self.state.has_pending_command()
            wake_phrase, _command = self.state.match_wake(text) \
                if route.get('mode') == 'wake' else (None, None)
            wake_word = match_stop_phrase_words(value.get('words'), wake_phrase) \
                if wake_phrase is not None else None
            try:
                start_sample = int(snapshot_start) if snapshot_start is not None else None
                end_sample = int(snapshot_end) if snapshot_end is not None else None
                valid_window = start_sample is not None and end_sample is not None \
                    and end_sample > start_sample
            except (TypeError, ValueError, OverflowError):
                start_sample = None
                end_sample = None
                valid_window = False
            stop_after = None
            if route.get('mode') == 'wake' and route.get('armed') is not True \
                    and not command_pending:
                if prior_wake_ack and valid_window and prior_wake_boundary is not None:
                    stop_after = max(0.0, (prior_wake_boundary - start_sample) / SAMPLE_RATE)
                elif wake_word is not None:
                    stop_after = float(wake_word['phraseEnd'])
                else:
                    stop_after = float('inf')
            stop_word = match_stop_phrase_words(
                value.get('words'), route.get('stopPhrase')
                or getattr(self.state, 'stop_phrase', 'green apple'), stop_after)
            boundary = None
            if stop_word is not None and valid_window:
                duration = (end_sample - start_sample) / SAMPLE_RATE
                stop_start = float(stop_word['start'])
                stop_end = float(stop_word['phraseEnd'])
                if 0 <= stop_start < stop_end <= duration:
                    boundary = start_sample + round(stop_start * SAMPLE_RATE)
            wake_boundary = None
            if valid_window and wake_phrase is not None:
                wake_boundary = end_sample if wake_word is None else max(start_sample, min(end_sample,
                    start_sample + round(float(wake_word['phraseEnd']) * SAMPLE_RATE)))
            latency_ms = round((time.monotonic() - started) * 1000)
            with self.lock:
                self.last_latency_ms = latency_ms
                self.last_error = None
                if self.closed or generation != self.generation or self.active_id != audio_id:
                    self.stale_results += 1
                    return
                wake_ack = route.get('mode') == 'wake' and wake_phrase is not None \
                    and not self.wake_acknowledged
                # Each VAD/hard-length segment starts a fresh probe. A pending
                # command still owns its continuation even after armed clears.
                stop_allowed = route.get('mode') == 'dictation' or route.get('armed') is True \
                    or command_pending or self.wake_acknowledged or wake_ack
                stop_ack = boundary is not None and stop_allowed and not self.stop_acknowledged
                callback = self.stop_callback if stop_ack else None
                if wake_ack:
                    self.wake_acknowledged = True
                    self.wake_boundary_sample = wake_boundary
                    self.acknowledged = True
                    self.detections += 1
                if stop_ack:
                    self.stop_acknowledged = True
                    self.stop_detections += 1
            if wake_ack:
                try:
                    self.events.append('wake.partial.detected', {
                        'audioId': audio_id,
                        'wakePhrase': wake_phrase,
                        'latencyMs': latency_ms,
                        'model': value.get('model'),
                    })
                except Exception:
                    pass
                self.playback.cue('start')
            if stop_ack:
                try:
                    self.events.append('wake.partial.stop.detected', {
                        'audioId': audio_id,
                        'boundarySample': boundary,
                        'snapshotStartSample': snapshot_start,
                        'snapshotEndSample': snapshot_end,
                        'latencyMs': latency_ms,
                        'model': value.get('model'),
                    })
                except Exception:
                    pass
                if callback is not None:
                    callback(audio_id, boundary)
        except Exception as error:
            message = f'{type(error).__name__}: {error}'[:500]
            now = time.monotonic()
            with self.lock:
                self.last_error = message
                report = now - self.last_error_at >= 30
                if report:
                    self.last_error_at = now
            if report:
                self.events.append('wake.partial.failed', {'error': message})
        finally:
            with self.lock:
                self.in_flight = False

    def finish(self, audio_id: str) -> bool:
        with self.lock:
            if self.active_id != audio_id:
                return False
            acknowledged = self.wake_acknowledged
            self.generation += 1
            self.active_id = None
            self.route = {}
            self.wake_acknowledged = False
            self.wake_boundary_sample = None
            self.stop_acknowledged = False
            self.acknowledged = False
            return acknowledged

    def abandon(self, audio_id: str | None = None) -> None:
        with self.lock:
            if audio_id is not None and self.active_id != audio_id:
                return
            self.generation += 1
            self.active_id = None
            self.route = {}
            self.wake_acknowledged = False
            self.wake_boundary_sample = None
            self.stop_acknowledged = False
            self.acknowledged = False

    def telemetry(self) -> dict[str, Any]:
        with self.lock:
            return {
                'active': self.active_id is not None,
                'inFlight': self.in_flight,
                'acknowledged': self.wake_acknowledged,
                'wakeAcknowledged': self.wake_acknowledged,
                'stopPhraseDetected': self.stop_acknowledged,
                'attempts': self.attempts,
                'detections': self.detections,
                'stopDetections': self.stop_detections,
                'staleResults': self.stale_results,
                'lastLatencyMs': self.last_latency_ms,
                'lastError': self.last_error,
            }

    def drain(self, callback: Callable[[], Any]) -> None:
        self.executor.submit(callback)

    def close(self) -> None:
        with self.lock:
            self.closed = True
            self.generation += 1
            self.active_id = None
            self.route = {}
            self.wake_acknowledged = False
            self.wake_boundary_sample = None
            self.stop_acknowledged = False
            self.acknowledged = False
        self.executor.shutdown(wait=False, cancel_futures=True)


class Transcriber:
    WAKE_MAX_AGE_SECONDS = 120
    MAX_PENDING_JOBS = 64

    def __init__(self, root: Path, compute: ComputeClient, state: VoiceState,
                 events: EventStore, playback: Playback | None = None,
                 command_grace_ms: int = 1200) -> None:
        self.root = root
        self.compute = compute
        self.state = state
        self.events = events
        self.playback = playback
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='voice-transcribe')
        self.closed = False
        self.queued: set[Path] = set()
        self.retry_jobs: set[Path] = set()
        # job path -> createdAt; only fresh entries may hold a pending command
        self.retry_wake_jobs: dict[Path, Any] = {}
        self.pending_jobs: dict[Path, dict[str, Any]] = {}
        self.pending_wake_jobs: set[Path] = set()
        self.pending_job_drops = 0
        self.orphan_rescan_needed = False
        self.in_flight: Path | None = None
        self.last_emotion: dict[str, Any] | None = None
        self.last_emotion_at: float | None = None
        self.last_prosody: dict[str, Any] | None = None
        self.last_prosody_at: float | None = None
        self.queued_lock = threading.Lock()
        self.job_io_lock = threading.Lock()
        self.audio_active = False
        self.idle_since: float | None = time.monotonic()
        self.command_grace_seconds = max(0.2, min(5.0, float(command_grace_ms) / 1000))
        self.flush_generation = 0
        self.command_timer: threading.Timer | None = None
        self.command_deadline: float | None = None
        listing = audio_listing(self.root)
        for directory, files in listing:
            for name in files:
                if not name.endswith('.wav.job.json'):
                    continue
                job_path = directory / name
                self.retry_jobs.add(job_path)
                job = read_json(job_path, {})
                if isinstance(job, dict) and isinstance(job.get('route'), dict) \
                        and job['route'].get('mode') == 'wake':
                    self.retry_wake_jobs[job_path] = job.get('createdAt')
        self._recover_orphan_audio(listing)
        self.retry_thread = threading.Thread(target=self._retry_loop, name='voice-retry', daemon=True)
        self.retry_thread.start()

    @staticmethod
    def _job_path(audio_path: Path) -> Path:
        return audio_path.with_suffix(audio_path.suffix + '.job.json')

    def _retire_job(self, job_path: Path) -> None:
        with self.job_io_lock:
            with self.queued_lock:
                job_path.unlink(missing_ok=True)
                self.pending_jobs.pop(job_path, None)
                self.pending_wake_jobs.discard(job_path)
                self.retry_jobs.discard(job_path)
                self.retry_wake_jobs.pop(job_path, None)

    @staticmethod
    def _age_seconds(value: Any) -> float:
        try:
            parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())
        except (TypeError, ValueError):
            return float('inf')

    def _fresh_wake_retries_locked(self) -> list[Path]:
        # An expired wake job can only be archived (see _run), so it never
        # completes a command. Letting it gate the flush turned a day-long
        # compute outage into 1,167 stale jobs that held every new command
        # until each one had been re-transcribed.
        return [path for path, created in self.retry_wake_jobs.items()
                if self._age_seconds(created) <= self.WAKE_MAX_AGE_SECONDS]

    def _cancel_command_timer_locked(self) -> None:
        self.flush_generation += 1
        self.command_deadline = None
        if self.command_timer is not None:
            self.command_timer.cancel()
            self.command_timer = None

    def telemetry(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.queued_lock:
            return {
                'audioActive': self.audio_active,
                'queuedJobs': max(0, len(self.queued) - (1 if self.in_flight in self.queued else 0)),
                'inFlight': self.in_flight is not None,
                'retryJobs': len(self.retry_jobs),
                'wakeRetryJobs': len(self.retry_wake_jobs),
                'pendingJobs': len(self.pending_jobs),
                'pendingWakeJobs': len(self.pending_wake_jobs),
                'pendingJobDrops': self.pending_job_drops,
                'commandPending': self.state.has_pending_command(),
                'graceRemainingMs': max(0, round((self.command_deadline - now) * 1000))
                    if self.command_deadline is not None else None,
                'lastEmotion': self.last_emotion,
                'lastEmotionAgeMs': round((now - self.last_emotion_at) * 1000)
                    if self.last_emotion_at is not None else None,
                'lastProsody': self.last_prosody,
                'lastProsodyAgeMs': round((now - self.last_prosody_at) * 1000)
                    if self.last_prosody_at is not None else None,
            }

    def accepting_audio(self) -> bool:
        with self.queued_lock:
            return len(self.pending_jobs) < self.MAX_PENDING_JOBS

    def activity(self) -> None:
        with self.queued_lock:
            self.audio_active = True
            self.idle_since = None
            self._cancel_command_timer_locked()

    def idle(self) -> None:
        with self.queued_lock:
            if self.audio_active or self.idle_since is None:
                self.idle_since = time.monotonic()
            self.audio_active = False
        self._maybe_schedule_command()

    def _maybe_schedule_command(self) -> None:
        with self.queued_lock:
            if self.closed or self.audio_active or self.queued or self._fresh_wake_retries_locked() or self.pending_wake_jobs \
                    or self.command_timer is not None:
                return
            if not self.state.has_pending_command():
                return
            self.flush_generation += 1
            generation = self.flush_generation
            # ASR runs while capture is already idle. Only the unelapsed part
            # of the continuation grace belongs after recognition, not another
            # full grace period. Active audio and unfinished jobs still gate it.
            now = time.monotonic()
            self.command_deadline = (self.idle_since if self.idle_since is not None else now) \
                + self.command_grace_seconds
            remaining = max(0.0, self.command_deadline - now)
            timer = threading.Timer(remaining, self._command_timer_fired, (generation,))
            timer.daemon = True
            self.command_timer = timer
            timer.start()

    def _command_timer_fired(self, generation: int) -> None:
        with self.queued_lock:
            if generation != self.flush_generation:
                return
            self.command_timer = None
            self.command_deadline = None
            if self.closed or self.audio_active or self.queued or self._fresh_wake_retries_locked() or self.pending_wake_jobs:
                return
        try:
            self.executor.submit(self._flush_command, generation)
        except RuntimeError:
            pass

    def _flush_command(self, generation: int) -> None:
        with self.queued_lock:
            if generation != self.flush_generation or self.closed or self.audio_active \
                    or self.queued or self._fresh_wake_retries_locked() or self.pending_wake_jobs:
                return
            self.state.flush_pending()

    def submit(self, audio: dict[str, Any], route: dict[str, Any]) -> None:
        path = Path(audio['path'])
        job = {
            'version': 1,
            'audio': audio,
            'route': route,
            'createdAt': utc_now(),
            'attempts': 0,
            'error': None,
        }
        job_path = self._job_path(path)
        try:
            with self.job_io_lock:
                atomic_json(job_path, job)
        except OSError:
            with self.queued_lock:
                if job_path not in self.pending_jobs and len(self.pending_jobs) >= self.MAX_PENDING_JOBS:
                    self.pending_job_drops += 1
                    self.orphan_rescan_needed = True
                    return
                self.pending_jobs[job_path] = job
                if route.get('mode') == 'wake':
                    self.pending_wake_jobs.add(job_path)
        self._enqueue(job_path)

    def _enqueue(self, job_path: Path) -> bool:
        with self.queued_lock:
            if job_path in self.queued:
                return False
            self.queued.add(job_path)
            self._cancel_command_timer_locked()
        self.executor.submit(self._run_owned, job_path)
        return True

    def _run_owned(self, job_path: Path) -> None:
        with self.queued_lock:
            self.in_flight = job_path
        try:
            self._run(job_path)
        finally:
            with self.queued_lock:
                if self.in_flight == job_path:
                    self.in_flight = None
                self.queued.discard(job_path)
            self._maybe_schedule_command()

    def drain(self, callback: Callable[[], Any]) -> None:
        self.executor.submit(callback)

    def _run(self, job_path: Path) -> None:
        with self.queued_lock:
            pending_job = self.pending_jobs.get(job_path)
        job = read_json(job_path, None)
        if not isinstance(job, dict):
            job = pending_job
        if not isinstance(job, dict):
            self._retire_job(job_path)
            return
        audio = job.get('audio') if isinstance(job.get('audio'), dict) else {}
        audio_path = Path(str(audio.get('path', '')))
        if not audio_path.exists():
            self._retire_job(job_path)
            return
        transcript_path = audio_path.with_suffix(audio_path.suffix + '.transcript.json')
        if transcript_path.exists():
            route = job.get('route') if isinstance(job.get('route'), dict) else {}
            if route.get('mode') == 'wake' and route.get('stopPhraseDetected') is True:
                self.state.finish_stopped_command()
            self._retire_job(job_path)
            return
        try:
            result = self.compute.transcribe(audio_path.read_bytes())
            raw = normalize_space(result.get('rawText', result.get('text', '')))
            text = normalize_space(result.get('text')) or raw
            evidence = {
                **audio,
                'raw': raw,
                'text': text,
                'language': result.get('language'),
                'confidence': result.get('confidence'),
                'model': result.get('model'),
                'asrFallback': result.get('fallback'),
                'emotion': result.get('emotion'),
                'emotionError': result.get('emotionError'),
                'prosody': result.get('prosody'),
                'refined': result.get('refined') is True,
                'refineError': result.get('refineError'),
                'completedAt': utc_now(),
            }
            atomic_json(transcript_path, evidence)
            emotion = result.get('emotion') if isinstance(result.get('emotion'), dict) else None
            if emotion is not None:
                with self.queued_lock:
                    self.last_emotion = emotion
                    self.last_emotion_at = time.monotonic()
            prosody = result.get('prosody') if isinstance(result.get('prosody'), dict) else None
            if prosody is not None:
                with self.queued_lock:
                    self.last_prosody = {
                        'status': prosody.get('status'),
                        'elapsedMs': prosody.get('elapsedMs'),
                        'modelRevision': prosody.get('modelRevision'),
                    }
                    self.last_prosody_at = time.monotonic()
            route = job.get('route') if isinstance(job.get('route'), dict) else {}
            if route.get('mode') == 'wake' and self._age_seconds(job.get('createdAt')) > self.WAKE_MAX_AGE_SECONDS:
                route = { **route, 'mode': 'archive' }
            emitted = self.state.accept(Recognition(
                raw=raw,
                text=text,
                language=result.get('language'),
                confidence=result.get('confidence'),
                emotion=emotion,
                prosody=prosody,
            ), audio, route)
            if route.get('mode') == 'wake' and route.get('stopPhraseDetected') is True:
                self.state.finish_stopped_command()
            self._retire_job(job_path)
            if self.playback and route.get('wakeCueAcknowledged') is not True \
                    and any(event['kind'] == 'wake.detected' for event in emitted):
                self.playback.cue('start')
        except Exception as error:
            job['attempts'] = int(job.get('attempts', 0)) + 1
            job['error'] = f'{type(error).__name__}: {error}'[:500]
            job['lastAttemptAt'] = utc_now()
            with self.job_io_lock:
                atomic_json(job_path, job)
            with self.queued_lock:
                self.retry_jobs.add(job_path)
                route = job.get('route')
                if isinstance(route, dict) and route.get('mode') == 'wake':
                    self.retry_wake_jobs[job_path] = job.get('createdAt')
            self.events.append('transcript.failed', {
                'audio': audio,
                'attempts': job['attempts'],
                'error': job['error'],
            })

    @staticmethod
    def _orphan_evidence(path: Path) -> dict[str, Any] | None:
        try:
            with wave.open(str(path), 'rb') as source:
                if source.getnchannels() != 1 or source.getsampwidth() != 2 \
                        or source.getframerate() != SAMPLE_RATE:
                    return None
                samples = source.getnframes()
            started = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat().replace('+00:00', 'Z')
            return {
                'audioId': path.stem,
                'path': str(path),
                'startedAt': started,
                'samples': samples,
                'durationMs': round(samples * 1000 / SAMPLE_RATE),
            }
        except (OSError, EOFError, wave.Error):
            return None

    def _recover_orphan_audio(self, listing: list[tuple[Path, dict[str, Any]]] | None = None) -> None:
        for directory, files in listing if listing is not None else audio_listing(self.root):
            for name in files:
                if not (name.startswith('utterance-') and name.endswith('.wav')) \
                        or name + '.transcript.json' in files or name + '.job.json' in files:
                    continue
                self._recover_orphan(directory / name)

    def _recover_orphan(self, audio_path: Path) -> None:
        # The listing is a snapshot; recheck the few candidates it leaves.
        job_path = self._job_path(audio_path)
        with self.queued_lock:
            pending = job_path in self.pending_jobs
        if pending or audio_path.with_suffix(audio_path.suffix + '.transcript.json').exists() \
                or job_path.exists():
            return
        evidence = self._orphan_evidence(audio_path)
        if evidence is not None:
            self.submit(evidence, {'mode': 'archive', 'target': safe_target({})})

    def _persist_pending_jobs(self) -> None:
        with self.queued_lock:
            pending = list(self.pending_jobs.items())
        for job_path, job in pending:
            enqueue = False
            with self.job_io_lock:
                try:
                    atomic_json(job_path, job)
                except OSError:
                    continue
                with self.queued_lock:
                    if self.pending_jobs.get(job_path) is not job:
                        job_path.unlink(missing_ok=True)
                    else:
                        self.pending_jobs.pop(job_path, None)
                        self.pending_wake_jobs.discard(job_path)
                        enqueue = job_path not in self.queued
            if enqueue:
                self._enqueue(job_path)

    def _retry_loop(self) -> None:
        while not self.closed:
            time.sleep(5)
            if self.closed:
                break
            self._retry_pass()

    def _retry_pass(self) -> None:
        self._persist_pending_jobs()
        with self.queued_lock:
            rescan = self.orphan_rescan_needed and len(self.pending_jobs) < self.MAX_PENDING_JOBS
            if rescan:
                self.orphan_rescan_needed = False
        if rescan:
            self._recover_orphan_audio()
        # A wake job may have aged out since the last pass, releasing a command.
        self._maybe_schedule_command()
        # The worker is single-threaded and FIFO, so a retry enqueued ahead of
        # live speech delays it by a full transcription. Retries go in one at a
        # time and only into an idle worker; fresh wake retries go first
        # because they are the only ones that can still complete a command.
        with self.queued_lock:
            if self.closed or self.audio_active or self.queued:
                return
            fresh = set(self._fresh_wake_retries_locked())
            candidates = list(self.retry_jobs)
        # retry_jobs is seeded by the startup scan and kept by every failure and
        # retirement. Walking the evidence tree here instead held the GIL for
        # ~3 s every 5 s and starved the microphone callback.
        jobs: list[tuple[bool, float, Path]] = []
        for job in candidates:
            try:
                jobs.append((job not in fresh, job.stat().st_mtime, job))
            except OSError:
                with self.queued_lock:
                    self.retry_jobs.discard(job)
                    self.retry_wake_jobs.pop(job, None)
        for _stale, last, job in sorted(jobs):
            if self.closed:
                break
            value = read_json(job, None)
            if not isinstance(value, dict):
                continue
            attempts = int(value.get('attempts', 0))
            delay = min(300, 5 * (2 ** min(attempts, 6)))
            if time.time() - last >= delay and job.exists():
                self._enqueue(job)
                return

    def close(self) -> None:
        with self.queued_lock:
            self.closed = True
            self._cancel_command_timer_locked()
        self.executor.shutdown(wait=False, cancel_futures=False)


class Vad:
    def __init__(self, config: RuntimeConfig, events: EventStore) -> None:
        self.config = config
        self.events = events
        self.model: Any = None
        self.torch: Any = None
        self.numpy: Any = None
        self.mode = 'energy'
        try:
            import numpy as np
            import torch
            from silero_vad import load_silero_vad
            self.numpy = np
            self.torch = torch
            self.model = load_silero_vad(onnx=True)
            self.mode = 'silero'
        except Exception as error:
            self.events.append('vad.fallback', {'error': f'{type(error).__name__}: {error}'[:500]})

    def speech(self, pcm: bytes) -> tuple[bool, float]:
        if self.model is not None:
            values = self.numpy.frombuffer(pcm, dtype='<i2').astype(self.numpy.float32) / 32768.0
            with self.torch.no_grad():
                probability = float(self.model(self.torch.from_numpy(values), SAMPLE_RATE).item())
            return probability >= float(self.config.get('vadThreshold')), probability
        count = len(pcm) // 2
        if not count:
            return False, 0.0
        samples = memoryview(pcm).cast('h')
        rms = math.sqrt(sum(float(value) * value for value in samples) / count) / 32768.0
        return rms >= float(self.config.get('energyThreshold')), rms


class CaptureBacklog:
    MAX_CONTROLS = 16

    def __init__(self, capacity: int) -> None:
        self.capacity = max(1, int(capacity))
        self.items: deque[bytes | tuple[str, str]] = deque()
        self.data_items = 0
        self.pcm_items = 0
        self.status_items = 0
        self.condition = threading.Condition()
        self.input_blocks = 0
        self.input_statuses = 0
        self.callback_dropped_pcm = 0
        self.callback_dropped_status = 0
        self.recovery_dropped_pcm = 0
        self.recovery_dropped_status = 0
        self.last_input_monotonic: float | None = None
        self.last_warning: str | None = None
        self.last_warning_monotonic: float | None = None
        self.input_overflows = 0

    @staticmethod
    def _is_status(item: bytes | tuple[str, str]) -> bool:
        return isinstance(item, tuple) and item[0] == 'status'

    @classmethod
    def _is_data(cls, item: bytes | tuple[str, str]) -> bool:
        return isinstance(item, bytes) or cls._is_status(item)

    def _discard_item_locked(self, item: bytes | tuple[str, str], recovery: bool) -> None:
        self.data_items -= 1
        if isinstance(item, bytes):
            self.pcm_items -= 1
            if recovery:
                self.recovery_dropped_pcm += 1
            else:
                self.callback_dropped_pcm += 1
        else:
            self.status_items -= 1
            if recovery:
                self.recovery_dropped_status += 1
            else:
                self.callback_dropped_status += 1

    def _discard_oldest_data_locked(self) -> None:
        for index, item in enumerate(self.items):
            if not self._is_data(item):
                continue
            del self.items[index]
            self._discard_item_locked(item, recovery=False)
            return
        raise RuntimeError('backlog data count lost queue ownership')

    def _offer_data(self, item: bytes | tuple[str, str]) -> bool:
        if not self.condition.acquire(blocking=False):
            if isinstance(item, bytes):
                self.callback_dropped_pcm += 1
            else:
                self.callback_dropped_status += 1
            return False
        try:
            if self.data_items >= self.capacity:
                self._discard_oldest_data_locked()
            self.items.append(item)
            self.data_items += 1
            if isinstance(item, bytes):
                self.pcm_items += 1
            else:
                self.status_items += 1
            self.condition.notify()
            return True
        finally:
            self.condition.release()

    def offer_pcm(self, pcm: bytes) -> bool:
        self.input_blocks += 1
        self.last_input_monotonic = time.monotonic()
        return self._offer_data(pcm)

    def offer_status(self, warning: str, input_overflow: bool) -> bool:
        self.input_statuses += 1
        self.last_warning = warning[:500]
        self.last_warning_monotonic = time.monotonic()
        if input_overflow:
            self.input_overflows += 1
        return self._offer_data(('status', warning))

    def reset_input(self) -> None:
        self.last_input_monotonic = None

    def put_control(self, action: str, value: str = '') -> None:
        with self.condition:
            if action == 'capture-failed' and any(
                    isinstance(item, tuple) and item[0] == action for item in self.items):
                return
            if self.items and self.items[-1] == (action, value):
                return
            controls = sum(1 for item in self.items if not self._is_data(item))
            if controls >= self.MAX_CONTROLS - 1:
                return
            self.items.append((action, value))
            self.condition.notify()

    def put_stop_phrase(self, value: str) -> None:
        with self.condition:
            self.items = deque(item for item in self.items
                               if not (isinstance(item, tuple) and item[0] == 'stop-phrase'))
            self.items.append(('stop-phrase', value))
            self.condition.notify()

    def put_close(self) -> None:
        with self.condition:
            while self.items:
                item = self.items.popleft()
                if not self._is_data(item):
                    continue
                self.data_items -= 1
                if isinstance(item, bytes):
                    self.pcm_items -= 1
                else:
                    self.status_items -= 1
            self.items.append(('close', ''))
            self.condition.notify()

    def get(self) -> bytes | tuple[str, str]:
        with self.condition:
            while not self.items:
                self.condition.wait()
            item = self.items.popleft()
            if self._is_data(item):
                self.data_items -= 1
                if isinstance(item, bytes):
                    self.pcm_items -= 1
                else:
                    self.status_items -= 1
            return item

    def discard_data(self) -> dict[str, int]:
        dropped_pcm = 0
        dropped_status = 0
        with self.condition:
            retained: deque[bytes | tuple[str, str]] = deque()
            while self.items:
                item = self.items.popleft()
                if not self._is_data(item):
                    retained.append(item)
                    continue
                self._discard_item_locked(item, recovery=True)
                if isinstance(item, bytes):
                    dropped_pcm += 1
                else:
                    dropped_status += 1
            self.items = retained
        return {'pcm': dropped_pcm, 'status': dropped_status}

    def telemetry(self) -> dict[str, Any]:
        with self.condition:
            return {
                'inputBlocks': self.input_blocks,
                'inputStatuses': self.input_statuses,
                'inputOverflows': self.input_overflows,
                'droppedPcmBlocks': self.callback_dropped_pcm + self.recovery_dropped_pcm,
                'droppedStatusItems': self.callback_dropped_status + self.recovery_dropped_status,
                'recoveryDroppedPcmBlocks': self.recovery_dropped_pcm,
                'recoveryDroppedStatusItems': self.recovery_dropped_status,
                'backlogBlocks': self.pcm_items,
                'backlogPcmBlocks': self.pcm_items,
                'backlogStatusItems': self.status_items,
                'backlogControls': len(self.items) - self.data_items,
                'lastInputMonotonic': self.last_input_monotonic,
                'lastWarning': self.last_warning,
                'lastWarningMonotonic': self.last_warning_monotonic,
            }


class RecorderLink:
    """Connects to the recorder process, starting it when nothing answers.

    The recorder is started detached and, where the scheduled task's job allows
    it, outside that job, so ending the task to restart the companion leaves the
    microphone recording.
    """
    CONNECT_SECONDS = 20.0

    def __init__(self, root: Path, config: RuntimeConfig) -> None:
        self.root = root
        self.config = config
        self.spawned = 0
        self.detached: bool | None = None
        self.last_spawn_error: str | None = None

    def _token(self) -> str:
        return (self.root / 'token').read_text(encoding='utf-8').strip()

    def _spawn(self) -> None:
        command = [sys.executable, str(Path(__file__).with_name('recorder.py')),
                   '--state-root', str(self.root), '--config', str(self.config.path),
                   '--port', str(int(self.config.get('recorderPort')))]
        options: dict[str, Any] = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL,
                                   'stderr': subprocess.DEVNULL, 'close_fds': True,
                                   'cwd': str(Path(__file__).parent)}
        if os.name != 'nt':
            subprocess.Popen(command, start_new_session=True, **options)
            self.detached = True
            self.spawned += 1
            return
        detached_process, new_group, breakaway = 0x00000008, 0x00000200, 0x01000000
        try:
            subprocess.Popen(command, creationflags=detached_process | new_group | breakaway, **options)
            self.detached = True
        except OSError as error:
            # The task's job forbids breakaway; the recorder then ends with the task.
            self.last_spawn_error = f'{type(error).__name__}: {error}'[:300]
            subprocess.Popen(command, creationflags=detached_process | new_group, **options)
            self.detached = False
        self.spawned += 1

    def connect(self) -> socket.socket:
        port = int(self.config.get('recorderPort'))
        deadline = time.monotonic() + self.CONNECT_SECONDS
        spawned = False
        while True:
            try:
                connection = socket.create_connection(('127.0.0.1', port), timeout=1.0)
            except OSError:
                if not spawned:
                    self._spawn()
                    spawned = True
                if time.monotonic() > deadline:
                    raise RuntimeError('recorder process did not start')
                time.sleep(0.2)
                continue
            connection.sendall(self._token().encode('utf-8') + b'\n')
            connection.settimeout(0.25)
            return connection

    def status(self) -> dict[str, Any]:
        return {'spawned': self.spawned, 'detached': self.detached, 'lastSpawnError': self.last_spawn_error}


class Capture:
    BLOCK_SAMPLES = 512
    INPUT_STALL_SECONDS = 2.0
    MAX_BACKLOG_BLOCKS = math.ceil(INPUT_STALL_SECONDS * SAMPLE_RATE / BLOCK_SAMPLES)
    PROCESSOR_RECOVERY_SECONDS = 0.1
    WAKE_PROBE_START_MS = 1400
    WAKE_PROBE_INTERVAL_MS = 500
    WAKE_PROBE_WINDOW_MS = 3000

    def __init__(self, root: Path, config: RuntimeConfig, state: VoiceState,
                 transcriber: Transcriber, wake_probe: WakeProbe,
                 playback: Playback, events: EventStore) -> None:
        self.root = root
        self.config = config
        self.state = state
        self.transcriber = transcriber
        self.wake_probe = wake_probe
        self.playback = playback
        self.events = events
        self.blocks = CaptureBacklog(self.MAX_BACKLOG_BLOCKS)
        self.link = RecorderLink(root, config)
        self.recorder_telemetry: dict[str, Any] = {}
        set_stop_callback = getattr(self.wake_probe, 'set_stop_callback', None)
        if callable(set_stop_callback):
            set_stop_callback(self._queue_stop_phrase)
        self.closed = False
        self.stream: Any = None
        self.current_device: dict[str, Any] | None = None
        self.telemetry_lock = threading.Lock()
        self.telemetry_values: dict[str, Any] = {
            'processedBlocks': 0,
            'lastProcessedMonotonic': None,
            'vadProbability': 0.0,
            'levelDb': -96.0,
            'levelPeakDb': -96.0,
            'speechActive': False,
            'activeMs': 0,
            'trailingSilenceMs': 0,
            'segmentsFinalized': 0,
            'lastFinalizedAt': None,
            'processorFaulted': False,
            'processorRecoveries': 0,
            'lastProcessorError': None,
            'lastProcessorErrorMonotonic': None,
            'lastRecoveryDroppedPcmBlocks': 0,
            'lastRecoveryDroppedStatusItems': 0,
        }
        self.vad = Vad(config, events)
        self.processor = threading.Thread(target=self._process, name='voice-capture-process', daemon=True)
        self.capture = threading.Thread(target=self._capture, name='voice-capture-device', daemon=True)
        self.processor.start()
        self.capture.start()

    def _safe_event(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        try:
            self.events.append(kind, payload)
        except Exception:
            pass

    def _queue_audio(self, pcm: bytes) -> None:
        if not self.closed:
            self.blocks.offer_pcm(pcm)

    def _queue_status(self, warning: str, input_overflow: bool) -> None:
        if not self.closed:
            self.blocks.offer_status(warning, input_overflow)

    def _queue_stop_phrase(self, audio_id: str, boundary: int) -> None:
        if self.closed or not isinstance(audio_id, str):
            return
        try:
            boundary = int(boundary)
        except (TypeError, ValueError):
            return
        self.blocks.put_stop_phrase(json.dumps({
            'audioId': audio_id,
            'boundary': boundary,
        }, separators=(',', ':')))

    def _processor_status(self) -> tuple[bool, bool]:
        processor = getattr(self, 'processor', None)
        alive = bool(processor and processor.is_alive())
        with self.telemetry_lock:
            faulted = self.telemetry_values.get('processorFaulted') is True
        return alive, faulted

    def processor_live(self) -> bool:
        alive, faulted = self._processor_status()
        return alive and not faulted and not self.closed

    def ready(self) -> bool:
        return self.input_live() and self.processor_live()

    def telemetry(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.telemetry_lock:
            value = dict(self.telemetry_values)
            self.telemetry_values['levelPeakDb'] = self.telemetry_values['levelDb']
        queue_value = self.blocks.telemetry()
        input_at = queue_value.pop('lastInputMonotonic')
        warning_at = queue_value.pop('lastWarningMonotonic')
        processed_at = value.pop('lastProcessedMonotonic')
        processor_error_at = value.pop('lastProcessorErrorMonotonic')
        alive, _faulted = self._processor_status()
        value.update(queue_value)
        value['processorAlive'] = alive
        value['inputAgeMs'] = round((now - input_at) * 1000) if input_at is not None else None
        value['processedAgeMs'] = round((now - processed_at) * 1000) if processed_at is not None else None
        value['warningAgeMs'] = round((now - warning_at) * 1000) if warning_at is not None else None
        value['processorErrorAgeMs'] = round((now - processor_error_at) * 1000) \
            if processor_error_at is not None else None
        recorder = dict(getattr(self, 'recorder_telemetry', {}) or {})
        value['rawRecording'] = recorder.pop('rawRecording', None)
        value['recorder'] = recorder or None
        return value

    def input_live(self, now: float | None = None) -> bool:
        if self.stream is None:
            return False
        now = time.monotonic() if now is None else now
        last_input = self.blocks.telemetry()['lastInputMonotonic']
        return last_input is not None and now - last_input <= self.INPUT_STALL_SECONDS

    def _input_stalled(self, opened_at: float, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        last_input = self.blocks.telemetry()['lastInputMonotonic']
        reference = last_input if last_input is not None and last_input >= opened_at else opened_at
        return now - reference > self.INPUT_STALL_SECONDS

    def _set_processor_fault(self, message: str) -> None:
        with self.telemetry_lock:
            self.telemetry_values['processorFaulted'] = True
            self.telemetry_values['processorRecoveries'] = \
                int(self.telemetry_values.get('processorRecoveries', 0)) + 1
            self.telemetry_values['lastProcessorError'] = message
            self.telemetry_values['lastProcessorErrorMonotonic'] = time.monotonic()

    def _clear_processor_fault(self, dropped: dict[str, int]) -> None:
        with self.telemetry_lock:
            self.telemetry_values['processorFaulted'] = False
            self.telemetry_values['lastRecoveryDroppedPcmBlocks'] = dropped['pcm']
            self.telemetry_values['lastRecoveryDroppedStatusItems'] = dropped['status']

    def _set_speech_inactive(self) -> None:
        with self.telemetry_lock:
            self.telemetry_values['speechActive'] = False
            self.telemetry_values['activeMs'] = 0
            self.telemetry_values['trailingSilenceMs'] = 0

    def _resolve_device(self, sounddevice: Any) -> Any:
        return resolve_input_device(sounddevice, self.config.get('inputDevice'))

    def _capture(self) -> None:
        backoff = 1.0
        while not self.closed:
            try:
                connection = self.link.connect()
                self.stream = connection
                reader = FrameReader(connection)
                opened_at = time.monotonic()
                self.blocks.reset_input()
                backoff = 1.0
                while not self.closed:
                    frame = reader.read()
                    if frame is None:
                        # Checked only once the socket is drained: after a companion
                        # stall the queued blocks arrive in a burst and are not a gap.
                        if self._input_stalled(opened_at):
                            raise RuntimeError('microphone input stalled at the recorder')
                        continue
                    kind, payload = frame
                    if kind == b'P':
                        self._queue_audio(payload)
                    elif kind == b'S':
                        status = json.loads(payload)
                        self._queue_status(str(status.get('warning', '')), status.get('inputOverflow') is True)
                    elif kind == b'T':
                        self.recorder_telemetry = json.loads(payload)
                    elif kind == b'R':
                        self.current_device = json.loads(payload)
                        opened_at = time.monotonic()
                        self.blocks.reset_input()
                        self._safe_event('capture.ready', {
                            'device': self.current_device,
                            'sampleRate': SAMPLE_RATE,
                            'vad': self.vad.mode,
                            'recorder': self.link.status(),
                        })
                    elif kind == b'F':
                        failure = json.loads(payload)
                        self.current_device = None
                        opened_at = time.monotonic()
                        self._safe_event('capture.failed', failure)
                        self.blocks.put_control('capture-failed', str(failure.get('error', ''))[:500])
            except Exception as error:
                self.stream = None
                self.current_device = None
                if self.closed:
                    break
                message = f'{type(error).__name__}: {error}'[:500]
                self._safe_event('capture.failed', {'error': message})
                self.blocks.put_control('capture-failed', message)
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    @staticmethod
    def _force_close_spool(spool: PcmSpool) -> None:
        try:
            spool.force_close()
            return
        except Exception:
            pass
        try:
            spool.handle.close()
        except Exception:
            pass
        try:
            spool.closed = True
        except Exception:
            pass

    def _process(self) -> None:
        pre_roll: Any = deque()
        active: PcmSpool | None = None
        active_route: dict[str, Any] | None = None
        speech_samples = 0
        silence_samples = 0
        next_wake_probe_samples: int | None = None
        suppress_until_silence = False
        continuous: ContinuousJournal | None = None
        last_status = ''
        last_status_at = 0.0

        def recover(error: Exception) -> None:
            nonlocal active, active_route, speech_samples, silence_samples, next_wake_probe_samples
            nonlocal suppress_until_silence, continuous, last_status, last_status_at
            message = f'{type(error).__name__}: {error}'[:500]
            self._set_processor_fault(message)
            spool, active = active, None
            active_route = None
            next_wake_probe_samples = None
            suppress_until_silence = False
            if spool is not None:
                try:
                    abandon = getattr(self.wake_probe, 'abandon', None)
                    if callable(abandon):
                        abandon(spool.id)
                    else:
                        self.wake_probe.finish(spool.id)
                except Exception:
                    pass
                try:
                    spool.abandon()
                except Exception:
                    self._force_close_spool(spool)
            journal, continuous = continuous, None
            if journal is not None:
                try:
                    journal.abandon()
                except Exception:
                    current = getattr(journal, 'current', None)
                    if current is not None:
                        self._force_close_spool(current)
            pre_roll.clear()
            speech_samples = 0
            silence_samples = 0
            last_status = ''
            last_status_at = 0.0
            self._set_speech_inactive()
            try:
                self.transcriber.idle()
            except Exception:
                pass
            dropped = self.blocks.discard_data()
            time.sleep(self.PROCESSOR_RECOVERY_SECONDS)
            delayed = self.blocks.discard_data()
            dropped['pcm'] += delayed['pcm']
            dropped['status'] += delayed['status']
            self._clear_processor_fault(dropped)
            self._safe_event('capture.processing.failed', {
                'error': message,
                'droppedPcmBlocks': dropped['pcm'],
                'droppedStatusItems': dropped['status'],
            })

        def finish() -> None:
            nonlocal active, active_route, speech_samples, silence_samples, next_wake_probe_samples
            if active is None:
                return
            spool, route = active, active_route or self.state.snapshot()
            acknowledged = self.wake_probe.finish(spool.id) if next_wake_probe_samples is not None else False
            if acknowledged:
                route = {**route, 'wakeCueAcknowledged': True}
            next_wake_probe_samples = None
            evidence = spool.finish()
            active = None
            active_route = None
            minimum = int(float(self.config.get('minimumSpeechMs')) * SAMPLE_RATE / 1000)
            if speech_samples >= minimum:
                self.transcriber.submit(evidence, route)
                self._safe_event('audio.finalized', evidence)
                with self.telemetry_lock:
                    self.telemetry_values['segmentsFinalized'] += 1
                    self.telemetry_values['lastFinalizedAt'] = utc_now()
            else:
                Path(evidence['path']).unlink(missing_ok=True)
            self._set_speech_inactive()
            self.transcriber.idle()
            speech_samples = 0
            silence_samples = 0

        while True:
            item = self.blocks.get()
            close_requested = False
            try:
                if isinstance(item, tuple):
                    action, value = item
                    if action == 'status' and (value != last_status or time.monotonic() - last_status_at > 30):
                        self.events.append('capture.warning', {'warning': value[:500]})
                        last_status, last_status_at = value, time.monotonic()
                    elif action == 'capture-failed':
                        finish()
                    elif action == 'stop':
                        try:
                            finish()
                        finally:
                            self.transcriber.drain(self.state.stop_dictation)
                    elif action == 'stop-phrase':
                        try:
                            value = json.loads(value)
                        except (TypeError, ValueError, json.JSONDecodeError):
                            value = {}
                        if active is not None and isinstance(value, dict) \
                                and value.get('audioId') == active.id:
                            try:
                                boundary = int(value.get('boundary'))
                            except (TypeError, ValueError):
                                boundary = None
                            if boundary is not None:
                                active.truncate(boundary)
                                stopped_route = {
                                    **(active_route or self.state.snapshot()),
                                    'stopPhraseDetected': True,
                                    'stopPhrase': (active_route or {}).get('stopPhrase')
                                        or self.state.stop_phrase,
                                }
                                active_route = stopped_route
                                speech_samples = min(speech_samples, active.samples)
                                pre_roll.clear()
                                suppress_until_silence = True
                                finish()
                                if stopped_route.get('mode') == 'dictation':
                                    self.transcriber.drain(self.state.stop_dictation)
                    elif action == 'cancel':
                        # Retire the interaction before queuing the active spool. Its
                        # audio and transcript remain recoverable, but a late result
                        # cannot be inserted into the composer after Escape.
                        self.state.cancel_dictation()
                        finish()
                    elif action == 'close':
                        close_requested = True
                        finish()
                else:
                    pcm = item
                    samples = memoryview(pcm).cast('h')
                    rms = math.sqrt(sum(float(value) * value for value in samples) / max(1, len(samples))) / 32768.0
                    level_db = 20 * math.log10(max(rms, 1e-6))
                    level_db = max(-96.0, min(0.0, level_db))
                    with self.telemetry_lock:
                        self.telemetry_values['processedBlocks'] += 1
                        self.telemetry_values['lastProcessedMonotonic'] = time.monotonic()
                        self.telemetry_values['levelDb'] = level_db
                        self.telemetry_values['levelPeakDb'] = max(
                            self.telemetry_values['levelPeakDb'], level_db
                        )
                    journal_enabled = self.config.get('continuousJournal') is True
                    if journal_enabled and continuous is None:
                        continuous = ContinuousJournal(self.root, int(self.config.get('journalChunkSeconds')))
                        self.events.append('journal.started')
                    elif not journal_enabled and continuous is not None:
                        completed = continuous.close()
                        continuous = None
                        self.events.append('journal.stopped', {'audio': completed})
                    if continuous is not None:
                        for evidence in continuous.write(pcm):
                            self.events.append('journal.chunk', {'audio': evidence})

                    if self.playback.playing:
                        pre_roll.clear()
                        continue

                    is_speech, probability = self.vad.speech(pcm)
                    with self.telemetry_lock:
                        self.telemetry_values['vadProbability'] = probability
                    if active is None:
                        if suppress_until_silence:
                            pre_roll.clear()
                            if is_speech:
                                silence_samples = 0
                            else:
                                silence_samples += self.BLOCK_SAMPLES
                            endpoint = int(float(self.config.get('silenceMs')) * SAMPLE_RATE / 1000)
                            if silence_samples >= endpoint:
                                suppress_until_silence = False
                                silence_samples = 0
                            continue
                        max_pre_blocks = max(1, round(float(self.config.get('preRollMs')) / (
                            self.BLOCK_SAMPLES * 1000 / SAMPLE_RATE)))
                        pre_roll.append(pcm)
                        while len(pre_roll) > max_pre_blocks:
                            pre_roll.popleft()
                        if not is_speech:
                            continue
                        accepting = getattr(self.transcriber, 'accepting_audio', None)
                        if callable(accepting) and not accepting():
                            pre_roll.clear()
                            continue
                        self.transcriber.activity()
                        active = PcmSpool(self.root)
                        active_route = self.state.snapshot()
                        for block in pre_roll:
                            active.write(block)
                        pre_roll.clear()
                        probe_enabled = active_route.get('mode') == 'dictation' \
                            or (active_route.get('mode') == 'wake' and self.state.wake_enabled)
                        if probe_enabled:
                            try:
                                self.wake_probe.begin(active.id, active_route)
                            except TypeError:
                                self.wake_probe.begin(active.id)
                            next_wake_probe_samples = round(self.WAKE_PROBE_START_MS * SAMPLE_RATE / 1000)
                        else:
                            next_wake_probe_samples = None
                        speech_samples = self.BLOCK_SAMPLES
                        silence_samples = 0
                        with self.telemetry_lock:
                            self.telemetry_values['speechActive'] = True
                            self.telemetry_values['activeMs'] = round(active.samples * 1000 / SAMPLE_RATE)
                            self.telemetry_values['trailingSilenceMs'] = 0
                        continue

                    active.write(pcm)
                    if is_speech:
                        speech_samples += self.BLOCK_SAMPLES
                        silence_samples = 0
                    else:
                        silence_samples += self.BLOCK_SAMPLES
                    with self.telemetry_lock:
                        self.telemetry_values['speechActive'] = True
                        self.telemetry_values['activeMs'] = round(active.samples * 1000 / SAMPLE_RATE)
                        self.telemetry_values['trailingSilenceMs'] = round(silence_samples * 1000 / SAMPLE_RATE)
                    if next_wake_probe_samples is not None and active.samples >= next_wake_probe_samples \
                            and self.wake_probe.ready(active.id):
                        window = min(active.samples, round(self.WAKE_PROBE_WINDOW_MS * SAMPLE_RATE / 1000))
                        snapshot_start = active.samples - window
                        snapshot_end = active.samples
                        snapshot = active.snapshot(window)
                        try:
                            submitted = self.wake_probe.submit(
                                active.id, snapshot, snapshot_start, snapshot_end)
                        except TypeError:
                            submitted = self.wake_probe.submit(active.id, snapshot)
                        if submitted:
                            interval_ms = getattr(self.wake_probe, 'interval_ms',
                                lambda: self.WAKE_PROBE_INTERVAL_MS)()
                            interval = round(interval_ms * SAMPLE_RATE / 1000)
                            next_wake_probe_samples = active.samples + interval
                    endpoint = int(float(self.config.get('silenceMs')) * SAMPLE_RATE / 1000)
                    maximum = int(float(self.config.get('segmentSeconds')) * SAMPLE_RATE)
                    if silence_samples >= endpoint or active.samples >= maximum:
                        finish()
            except Exception as error:
                recover(error)
            if close_requested:
                break

        if continuous is not None:
            try:
                completed = continuous.close()
                self.events.append('journal.stopped', {'audio': completed})
            except Exception as error:
                recover(error)

    def stop_dictation(self) -> None:
        self.blocks.put_control('stop')

    def cancel_dictation(self) -> None:
        self.blocks.put_control('cancel')

    def close(self) -> None:
        self.closed = True
        try:
            if self.stream is not None:
                self.stream.close()
        except Exception:
            pass
        self.blocks.put_close()
        self.processor.join(timeout=3)
        self.capture.join(timeout=3)
        self.wake_probe.close()


class ArchiveShipper:
    """Moves audio and voice evidence to the compute host's permanent archive.

    The workstation keeps only what the archive has not yet confirmed: a file is
    deleted after the archive reports the same checksum, and for speech audio the
    same sample count, for a copy it has verified and fsynced. The open raw
    .pcm.part is never touched. Transcribed utterances and rotated event history
    reach the archive through outbox/<collection>/, which mirrors its layout.
    """
    INTERVAL_SECONDS = 5.0
    BACKOFF_SECONDS = 30.0
    OUTBOX_BUDGET_SECONDS = 60.0
    # A finished utterance is left alone this long after its last write.
    SETTLE_SECONDS = 120.0
    ROTATE_SECONDS = 3600.0

    def __init__(self, root: Path, compute: Any, events: EventStore, start: bool = True) -> None:
        self.root = root
        self.directory = root / 'raw'
        self.outbox = root / 'outbox'
        self.outbox_shipped = 0
        self.outbox_pending = 0
        self.collected = 0
        self.last_rotation = 0.0
        self.compute = compute
        self.events = events
        self.shipped = 0
        self.pending = 0
        self.pending_bytes = 0
        self.last_error: str | None = None
        self.last_shipped_at: str | None = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, name='voice-archive', daemon=True)
        if start:
            self.thread.start()

    def _finished_chunks(self) -> list[Path]:
        chunks: list[Path] = []
        if not self.directory.is_dir():
            return chunks
        with os.scandir(self.directory) as days:
            for day in days:
                if not day.is_dir():
                    continue
                with os.scandir(day.path) as entries:
                    chunks.extend(Path(entry.path) for entry in entries
                                  if entry.name.startswith('raw-') and entry.name.endswith('.wav'))
        return sorted(chunks, key=lambda path: path.name)

    def ship_once(self) -> int:
        chunks = self._finished_chunks()
        self.pending = len(chunks)
        self.pending_bytes = sum(path.stat().st_size for path in chunks)
        shipped = 0
        for path in chunks:
            if self.stop.is_set():
                break
            body = path.read_bytes()
            digest = hashlib.sha256(body).hexdigest()
            with wave.open(io.BytesIO(body), 'rb') as source:
                samples = source.getnframes()
            reply = self.compute.archive(path.stem, digest, body)
            if reply.get('ok') is not True or reply.get('sha256') != digest or reply.get('samples') != samples:
                raise RuntimeError(f'archive did not confirm {path.name}: {json.dumps(reply)[:300]}')
            path.unlink()
            shipped += 1
            self.shipped += 1
            self.pending -= 1
            self.pending_bytes -= len(body)
            self.last_shipped_at = utc_now()
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        with os.scandir(self.directory) as days:
            for day in days:
                # The recorder creates today's folder on demand; leave it in place.
                if day.is_dir() and day.name < today:
                    try:
                        os.rmdir(day.path)
                    except OSError:
                        pass
        return shipped

    def collect_utterances(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        audio = self.root / 'audio'
        moved = 0
        for directory, files in audio_listing(self.root):
            if directory == audio:
                continue
            target = self.outbox.joinpath('utterances', *directory.relative_to(audio).parts)
            for name, entry in files.items():
                wav = name.removesuffix('.transcript.json')
                if not name.endswith('.wav.transcript.json') or wav + '.job.json' in files:
                    continue
                if wav in files:
                    if not wav.startswith('utterance-'):
                        continue
                    try:
                        if now - files[wav].stat().st_mtime < self.SETTLE_SECONDS:
                            continue
                    except OSError:
                        continue
                target.mkdir(parents=True, exist_ok=True)
                try:
                    # Audio first: an interruption leaves a transcript without its
                    # WAV, which the next pass moves, never a WAV without one.
                    if wav in files:
                        os.replace(directory / wav, target / wav)
                    os.replace(directory / name, target / name)
                    moved += 1
                except OSError:
                    continue
        self.collected += moved
        return moved

    def ship_outbox(self, deadline: float) -> int:
        files: list[Path] = []
        for directory, _subdirectories, names in os.walk(self.outbox):
            files.extend(Path(directory) / name for name in names if not name.endswith(('.tmp', '.part')))
        files.sort()
        self.outbox_pending = len(files)
        shipped = 0
        for path in files:
            if self.stop.is_set() or time.monotonic() > deadline:
                break
            parts = path.relative_to(self.outbox).parts
            if len(parts) < 2:
                continue
            body = path.read_bytes()
            digest = hashlib.sha256(body).hexdigest()
            samples = None
            if path.name.endswith('.wav'):
                try:
                    with wave.open(io.BytesIO(body), 'rb') as source:
                        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, SAMPLE_RATE):
                            samples = source.getnframes()
                except (EOFError, wave.Error):
                    samples = None
            reply = self.compute.archive_file(parts[0], '/'.join(parts[1:]), digest, body)
            confirmed = reply.get('ok') is True and reply.get('sha256') == digest and (
                reply.get('samples') == samples if samples is not None else reply.get('bytes') == len(body))
            if not confirmed:
                raise RuntimeError(f'archive did not confirm {path.name}: {json.dumps(reply)[:300]}')
            path.unlink()
            shipped += 1
            self.outbox_shipped += 1
            self.outbox_pending -= 1
        for directory, _subdirectories, _names in sorted(os.walk(self.outbox), key=lambda item: -len(item[0])):
            if Path(directory) != self.outbox:
                try:
                    os.rmdir(directory)
                except OSError:
                    pass
        return shipped

    def _pass(self) -> None:
        self.ship_once()
        if time.monotonic() - self.last_rotation > self.ROTATE_SECONDS:
            self.events.rotate(self.outbox / 'events')
            self.last_rotation = time.monotonic()
        self.collect_utterances()
        self.ship_outbox(time.monotonic() + self.OUTBOX_BUDGET_SECONDS)

    def _run(self) -> None:
        while not self.stop.wait(self.INTERVAL_SECONDS):
            try:
                self._pass()
                self.last_error = None
            except Exception as error:
                message = f'{type(error).__name__}: {error}'[:500]
                if message != self.last_error:
                    try:
                        self.events.append('archive.failed', {'error': message, 'pendingChunks': self.pending})
                    except Exception:
                        pass
                self.last_error = message
                self.stop.wait(self.BACKOFF_SECONDS)

    def telemetry(self) -> dict[str, Any]:
        return {
            'shippedChunks': self.shipped,
            'pendingChunks': self.pending,
            'pendingBytes': self.pending_bytes,
            'lastShippedAt': self.last_shipped_at,
            'outboxShipped': self.outbox_shipped,
            'outboxPending': self.outbox_pending,
            'collectedUtterances': self.collected,
            'lastError': self.last_error,
        }

    def close(self) -> None:
        self.stop.set()
        if self.thread.is_alive():
            self.thread.join(timeout=10)


class Companion:
    def __init__(self, config_path: Path, state_root: Path) -> None:
        # Phase times from process start, so a slow cold restart names its cause.
        self.startup: dict[str, Any] = {'phasesMs': {}, 'captureReadyMs': None}

        def mark(phase: str) -> None:
            self.startup['phasesMs'][phase] = round((time.monotonic() - PROCESS_STARTED) * 1000)

        mark('companion')
        self.residency = hold_audio_residency()
        self.root = state_root
        self.root.mkdir(parents=True, exist_ok=True)
        self.token_path = self.root / 'token'
        if not self.token_path.exists():
            self.token_path.write_text(secrets.token_urlsafe(48) + '\n', encoding='utf-8')
            try:
                os.chmod(self.token_path, 0o600)
            except OSError:
                pass
        self.token = self.token_path.read_text(encoding='utf-8').strip()
        if len(self.token) < 32:
            raise RuntimeError('companion token must contain at least 32 characters')
        self.config = RuntimeConfig(config_path, state_root)
        self.events = EventStore(state_root)
        mark('events')
        self.events.append('process.residency', self.residency)
        for recovered in recover_spools(state_root):
            self.events.append('audio.recovered', {'audio': recovered})
        mark('recovery')
        self.state = VoiceState(self.events, self.config.get('wakePhrases'), self.config.get('armSeconds'),
                                self.config.get('stopPhrase'))
        self.state.wake_enabled = self.config.get('wakeEnabled') is True
        self.tunnel = Tunnel(self.config, self.events)
        self.compute = ComputeClient(self.config, self.tunnel)
        self.playback = Playback(self.compute, self.events, state_root, self.config)
        self.transcriber = Transcriber(state_root, self.compute, self.state, self.events, self.playback,
                                       int(self.config.get('commandGraceMs')))
        mark('transcriber')
        self.wake_probe = WakeProbe(self.compute, self.state, self.events, self.playback)
        self.capture = Capture(state_root, self.config, self.state, self.transcriber,
                               self.wake_probe, self.playback, self.events)
        mark('capture')
        self.archive = ArchiveShipper(state_root, self.compute, self.events)
        mark('serving')
        self.transcriber.idle()
        self.started_at = utc_now()
        self.last_compute: dict[str, Any] | None = None
        self.last_compute_error = ''
        self.compute_failures = 0
        self.maintenance = threading.Thread(target=self._maintenance, name='voice-maintenance', daemon=True)
        self.closed = False
        self.maintenance.start()

    def authorized(self, header: str | None) -> bool:
        import hmac
        return bool(header and header.startswith('Bearer ') and hmac.compare_digest(header[7:], self.token))

    def _maintenance(self) -> None:
        last_prune = 0.0
        while not self.closed:
            try:
                self.last_compute = self.compute.health()
                self.last_compute_error = ''
                self.compute_failures = 0
            except Exception as error:
                self.last_compute = None
                self.last_compute_error = f'{type(error).__name__}: {error}'[:500]
                self.compute_failures += 1
                # An SSH process can remain alive after its forwarding channel has
                # wedged. Process liveness is not transport health; recycle it after
                # three failed loopback probes and let the next probe recreate it.
                if self.compute_failures >= 3 and self.tunnel.status()['configured']:
                    self.tunnel.stop()
                    self.compute_failures = 0
                    self.events.append('transport.recycled', {'reason': 'compute health failed three times'})
            if time.time() - last_prune > 3600:
                removed = prune_audio(self.root, int(self.config.get('retentionDays')))
                if removed:
                    self.events.append('retention.pruned', {'files': removed})
                last_prune = time.time()
            time.sleep(5)

    def health(self) -> dict[str, Any]:
        capture_telemetry = self.capture.telemetry()
        capture_ready = self.capture.ready()
        if capture_ready and self.startup['captureReadyMs'] is None:
            self.startup['captureReadyMs'] = round((time.monotonic() - PROCESS_STARTED) * 1000)
        return {
            'ok': True,
            'startedAt': self.started_at,
            'startup': self.startup,
            'residency': self.residency,
            'archive': self.archive.telemetry(),
            'capture': {
                'ready': capture_ready,
                'device': self.capture.current_device,
                'vad': self.capture.vad.mode,
                'state': self.state.snapshot(),
                'telemetry': capture_telemetry,
                'continuousJournal': self.config.get('continuousJournal') is True,
            },
            'transcriber': self.transcriber.telemetry(),
            'wakeProbe': {
                **self.wake_probe.telemetry(),
                'startMs': self.capture.WAKE_PROBE_START_MS,
                'intervalMs': self.capture.WAKE_PROBE_INTERVAL_MS,
                'windowMs': self.capture.WAKE_PROBE_WINDOW_MS,
            },
            'compute': self.last_compute,
            'computeError': self.last_compute_error or None,
            'transport': self.tunnel.status(),
            'cues': {
                'enabled': self.config.get('cueEnabled') is True,
                'startReady': (self.root / 'cues' / 'start.wav').is_file(),
                'acceptedReady': (self.root / 'cues' / 'accepted.wav').is_file(),
            },
            'tts': {'enabled': self.config.get('ttsEnabled') is True, 'playing': self.playback.playing},
            'eventCursor': self.events.next_id - 1,
        }

    def configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        previous_device = self.config.get('inputDevice')
        values = self.config.update(patch)
        phrases = values.get('wakePhrases')
        if isinstance(phrases, list):
            normalized = [normalize_space(phrase).lower() for phrase in phrases if normalize_space(phrase)]
            if normalized:
                self.state.wake_phrases = normalized
        self.state.configure_stop_phrase(values.get('stopPhrase'))
        self.state.arm_seconds = max(5, int(values.get('armSeconds', 25)))
        self.state.wake_enabled = values.get('wakeEnabled') is True
        self.transcriber.command_grace_seconds = max(0.2, min(5.0,
            float(values.get('commandGraceMs', 1200)) / 1000))
        return {'values': values, 'restartRequired': previous_device != values.get('inputDevice')}

    def control(self, action: str, target: Any) -> dict[str, Any]:
        self.state.update_target(target)
        if action == 'bind':
            return self.state.snapshot()
        if action == 'start':
            self.playback.stop()
            self.playback.cue('start', blocking=True)
            return self.state.start_dictation(target)
        if action == 'stop':
            self.capture.stop_dictation()
            return self.state.snapshot()
        if action == 'cancel':
            self.capture.cancel_dictation()
            return self.state.snapshot()
        if action == 'barge-in':
            self.playback.stop()
            return self.state.snapshot()
        if action == 'accepted':
            self.playback.cue('accepted')
            return self.state.snapshot()
        raise ValueError('unknown control action')

    def speak(self, text: str, kind: str = 'speech') -> None:
        if self.config.get('ttsEnabled') is not True:
            raise ValueError('TTS is disabled')
        self.playback.speak(text, kind)

    def summarize(self, transcript: str, target: Any) -> None:
        def work() -> None:
            try:
                text = self.compute.summarize(transcript)
                self.events.append('summary.ready', {'text': text, 'target': safe_target(target)})
                if self.config.get('ttsEnabled') is True:
                    self.playback.speak(text, 'summary')
            except Exception as error:
                self.events.append('summary.failed', {
                    'error': f'{type(error).__name__}: {error}'[:500],
                    'target': safe_target(target),
                })
        threading.Thread(target=work, name='voice-summary', daemon=True).start()

    def close(self) -> None:
        self.closed = True
        self.capture.close()
        self.archive.close()
        self.transcriber.close()
        self.playback.close()
        self.tunnel.stop()


class Handler(BaseHTTPRequestHandler):
    server_version = 'CuimodVoiceWorkstation/1'

    @property
    def companion(self) -> Companion:
        return self.server.companion  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _json(self, status: int, value: Any) -> None:
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('cache-control', 'no-store')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _authorize(self) -> bool:
        if self.companion.authorized(self.headers.get('authorization')):
            return True
        self._json(401, {'ok': False, 'error': 'unauthorized'})
        return False

    def _payload(self) -> dict[str, Any]:
        length = int(self.headers.get('content-length', '0'))
        if length < 0 or length > MAX_JSON_BYTES:
            raise ValueError('request body is too large')
        value = json.loads(self.rfile.read(length)) if length else {}
        if not isinstance(value, dict):
            raise ValueError('JSON object required')
        return value

    def do_GET(self) -> None:
        if not self._authorize():
            return
        route = urlparse(self.path)
        try:
            if route.path == '/healthz':
                self._json(200, self.companion.health())
            elif route.path == '/events':
                query = parse_qs(route.query)
                after = int(query.get('after', ['0'])[0])
                events = self.companion.events.after(after)
                self._json(200, {'events': events, 'cursor': self.companion.events.next_id - 1})
            else:
                self._json(404, {'ok': False, 'error': 'not found'})
        except (ValueError, TypeError) as error:
            self._json(400, {'ok': False, 'error': str(error)[:500]})

    def do_POST(self) -> None:
        if not self._authorize():
            return
        route = urlparse(self.path).path
        try:
            payload = self._payload()
            if route == '/control':
                value = self.companion.control(str(payload.get('action', '')), payload.get('target'))
                self._json(200, {'ok': True, 'state': value})
            elif route == '/configure':
                self._json(200, {'ok': True, **self.companion.configure(payload)})
            elif route == '/speak':
                self.companion.speak(str(payload.get('text', '')), str(payload.get('kind', 'speech')))
                self._json(202, {'ok': True})
            elif route == '/summary':
                transcript = str(payload.get('transcript', ''))
                if not transcript or len(transcript) > 2_000_000:
                    raise ValueError('transcript must contain 1..2000000 characters')
                self.companion.summarize(transcript, payload.get('target'))
                self._json(202, {'ok': True})
            elif route == '/shutdown':
                self._json(202, {'ok': True})
                threading.Thread(target=self.server.shutdown, name='voice-shutdown', daemon=True).start()
            else:
                self._json(404, {'ok': False, 'error': 'not found'})
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._json(400, {'ok': False, 'error': str(error)[:500]})
        except Exception as error:
            self._json(500, {'ok': False, 'error': f'{type(error).__name__}: {error}'[:500]})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Local microphone and speech companion')
    default_root = Path(__file__).resolve().parent.parent / '.state' / 'voice-agent'
    parser.add_argument('--state-root', type=Path, default=default_root)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--log', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--list-devices', action='store_true')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list_devices:
        import sounddevice as sd
        print(sd.query_devices())
        return
    state_root = args.state_root.resolve()
    if args.log:
        log_path = args.log.resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = log_path.open('a', encoding='utf-8', buffering=1)
        sys.stdout = log
        sys.stderr = log
    config_path = (args.config or (state_root / 'workstation.json')).resolve()
    companion = Companion(config_path, state_root)
    config = companion.config.snapshot()
    if args.check:
        print(json.dumps(companion.health(), indent=2))
        companion.close()
        return
    host = str(config['host'])
    if host not in {'127.0.0.1', '::1', 'localhost'}:
        companion.close()
        raise RuntimeError('workstation API must bind loopback')
    server = ThreadingHTTPServer((host, int(config['port'])), Handler)
    server.companion = companion  # type: ignore[attr-defined]
    print(json.dumps({'listening': f"{host}:{config['port']}", **companion.health()}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        companion.close()


if __name__ == '__main__':
    main()
