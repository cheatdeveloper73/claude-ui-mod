from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import socket
import struct
import threading
import time
import uuid
import wave
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
CHANNELS = 1
DESKTOP_SESSION = re.compile(r'^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
CLI_SESSION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        with path.open('r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return fallback


def normalize_space(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def match_wake_phrase(text: str, phrases: Iterable[str]) -> tuple[str | None, str | None]:
    normalized = normalize_space(text)
    lower = normalized.lower()
    for phrase in phrases:
        phrase = normalize_space(phrase).lower()
        if not phrase:
            continue
        words = phrase.split()
        # Partial and final Whisper can disagree on agent/agents for the same
        # wake. Accept that default-phrase variant without loosening boundaries
        # or pluralizing an owner's custom wake phrase.
        suffix = r's?' if phrase == 'hey agent' else ''
        wake_pattern = r'(?<!\w)' + r'[\s,.:;!?-]+'.join(re.escape(word) for word in words) + suffix + r'(?!\w)'
        match = re.search(wake_pattern, lower)
        if match:
            return phrase, normalize_space(normalized[match.end():].lstrip(' ,.:;!?-'))
    return None, None


def split_stop_phrase(text: str, phrase: str) -> tuple[str, bool]:
    words = normalize_space(phrase).split()
    if not words:
        return text, False
    pattern = r'(?<!\w)' + r'[\s,.:;!?-]+'.join(re.escape(word) for word in words) + r'(?!\w)'
    match = re.search(pattern, text, re.I)
    return (normalize_space(text[:match.start()]), True) if match else (text, False)


def _word_key(value: Any) -> str:
    text = normalize_space(value).casefold()
    return re.sub(r'^[^\w]+|[^\w]+$', '', text)


def _phrase_words(phrase: Any) -> list[str]:
    return [key for key in (_word_key(part) for part in normalize_space(phrase).split()) if key]


def validate_word_timestamps(words: Any) -> list[dict[str, Any]] | None:
    if words is None:
        return None
    if not isinstance(words, list):
        return None
    validated: list[dict[str, Any]] = []
    previous_start = 0.0
    previous_end = 0.0
    for item in words:
        if not isinstance(item, dict) or not isinstance(item.get('word'), str):
            return None
        try:
            start = float(item.get('start'))
            end = float(item.get('end'))
        except (TypeError, ValueError):
            return None
        # Whisper can align a word to a point, including a stop word or an
        # unrelated tail word. Preserve it; the whole matched phrase must span
        # positive time before it can stop capture.
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            return None
        if validated and (start < previous_start or end < previous_end):
            return None
        word = normalize_space(item['word'])
        if not word:
            return None
        value: dict[str, Any] = {'word': word, 'start': start, 'end': end}
        probability = item.get('probability')
        if probability is not None:
            try:
                probability = float(probability)
            except (TypeError, ValueError):
                return None
            if not math.isfinite(probability):
                return None
            value['probability'] = probability
        validated.append(value)
        previous_start, previous_end = start, end
    return validated


def match_stop_phrase_words(words: Any, phrase: Any, after: float | None = None) -> dict[str, Any] | None:
    validated = validate_word_timestamps(words)
    phrase_words = _phrase_words(phrase)
    if not validated or not phrase_words or len(validated) < len(phrase_words):
        return None
    keys = [_word_key(item['word']) for item in validated]
    for index in range(len(keys) - len(phrase_words) + 1):
        if keys[index:index + len(phrase_words)] == phrase_words \
                and validated[index + len(phrase_words) - 1]['end'] > validated[index]['start'] \
                and (after is None or validated[index]['start'] >= after):
            return {
                **validated[index],
                'index': index,
                'phraseEnd': validated[index + len(phrase_words) - 1]['end'],
            }
    return None


def safe_target(value: Any) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    desktop = value.get('desktopSessionId')
    cli = value.get('cliSessionId')
    web_contents = value.get('webContentsId')
    view_id = value.get('viewId')
    return {
        'desktopSessionId': desktop if isinstance(desktop, str) and DESKTOP_SESSION.fullmatch(desktop) else None,
        'cliSessionId': cli if isinstance(cli, str) and CLI_SESSION.fullmatch(cli) else None,
        'webContentsId': web_contents if isinstance(web_contents, int) and web_contents > 0 else None,
        'viewId': view_id if isinstance(view_id, str) and re.fullmatch(r'fresh-[0-9a-z-]{8,80}', view_id, re.I) else None,
    }


class EventStore:
    def __init__(self, root: Path, memory_limit: int = 4_000) -> None:
        self.root = root
        self.path = root / 'events.jsonl'
        self.state_path = root / 'event-state.json'
        self.memory_limit = memory_limit
        self.lock = threading.RLock()
        self.events: deque[dict[str, Any]] = deque(maxlen=memory_limit)
        self.next_id = 1
        self.root.mkdir(parents=True, exist_ok=True)
        self._load()

    def _tail_lines(self) -> list[bytes]:
        # Only the last memory_limit events are kept, and ids only grow, so the
        # tail is all a restart needs. Parsing the whole 134 MB journal took 3.5 s.
        try:
            with self.path.open('rb') as handle:
                handle.seek(0, os.SEEK_END)
                position = handle.tell()
                data = b''
                while position > 0 and data.count(b'\n') <= self.memory_limit:
                    step = min(1 << 20, position)
                    position -= step
                    handle.seek(position)
                    data = handle.read(step) + data
        except OSError:
            return []
        lines = data.split(b'\n')
        if position > 0:
            lines = lines[1:]
        return [line for line in lines if line.strip()][-(self.memory_limit + 1):]

    def _load(self) -> None:
        highest = 0
        for line in self._tail_lines():
            try:
                event = json.loads(line)
            except (ValueError, TypeError):
                continue
            event_id = event.get('id') if isinstance(event, dict) else None
            if not isinstance(event_id, int) or event_id < 1:
                continue
            highest = max(highest, event_id)
            self.events.append(event)
        saved = read_json(self.state_path, {})
        saved_next = saved.get('nextId') if isinstance(saved, dict) else None
        self.next_id = max(highest + 1, saved_next if isinstance(saved_next, int) else 1)

    def append(self, kind: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if not isinstance(kind, str) or not kind or len(kind) > 80:
            raise ValueError('event kind is required')
        with self.lock:
            event = {
                'id': self.next_id,
                'at': utc_now(),
                'kind': kind,
                **(payload or {}),
            }
            encoded = json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n'
            with self.path.open('a', encoding='utf-8', newline='\n') as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            self.next_id += 1
            self.events.append(event)
            atomic_json(self.state_path, {'nextId': self.next_id})
            return event

    ROTATE_BYTES = 32 * 1024 * 1024

    def rotate(self, outbox: Path, threshold: int | None = None) -> list[Path]:
        """Move journal history into compressed outbox segments.

        The journal grew to 134 MB on the workstation. Past the threshold it is
        renamed aside under the lock and replaced by the retained window, so
        restarts and caught-up polls read the same events as before. Successive
        segments overlap by that window.
        """
        threshold = self.ROTATE_BYTES if threshold is None else threshold
        with self.lock:
            try:
                size = self.path.stat().st_size
            except OSError:
                size = 0
            if size > threshold:
                os.replace(self.path, self.root / f'events.rotating-{time.time_ns()}.jsonl')
                with self.path.open('w', encoding='utf-8', newline='\n') as handle:
                    for event in self.events:
                        handle.write(json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n')
                    handle.flush()
                    os.fsync(handle.fileno())
        # Leftovers from an interrupted rotation are compressed here too.
        return [self._compress_segment(path, outbox) for path in sorted(self.root.glob('events.rotating-*.jsonl'))]

    @staticmethod
    def _compress_segment(source: Path, outbox: Path) -> Path:
        outbox.mkdir(parents=True, exist_ok=True)
        temporary = outbox / (source.stem + '.jsonl.gz.tmp')
        original = hashlib.sha256()
        first = last = b''
        with source.open('rb') as reader, gzip.open(temporary, 'wb', compresslevel=6) as writer:
            for line in reader:
                original.update(line)
                writer.write(line)
                first = first or line
                last = line
        restored = hashlib.sha256()
        with gzip.open(temporary, 'rb') as reader:
            while block := reader.read(1 << 20):
                restored.update(block)
        if restored.digest() != original.digest():
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f'compressed {source.name} does not match its source')
        try:
            name = f"events-{int(json.loads(first)['id']):09d}-{int(json.loads(last)['id']):09d}.jsonl.gz"
        except (ValueError, TypeError, KeyError):
            name = source.stem + '.jsonl.gz'
        final = outbox / name
        if final.exists():
            final = outbox / f'{final.name[:-9]}.{original.hexdigest()[:16]}.jsonl.gz'
        os.replace(temporary, final)
        source.unlink()
        return final

    def after(self, event_id: int, limit: int = 100) -> list[dict[str, Any]]:
        event_id = event_id if isinstance(event_id, int) and event_id >= 0 else 0
        limit = max(1, min(int(limit), 500))
        with self.lock:
            # The memory window is contiguous, so a cursor inside it is answered
            # there even when nothing is newer. Only a cursor older than the
            # window may read the journal, which grows without bound.
            if self.events and event_id >= self.events[0]['id'] - 1:
                return [event for event in self.events if event['id'] > event_id][:limit]
        result: list[dict[str, Any]] = []
        try:
            with self.path.open('r', encoding='utf-8') as handle:
                for line in handle:
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(event.get('id'), int) and event['id'] > event_id:
                        result.append(event)
                        if len(result) >= limit:
                            break
        except OSError:
            pass
        return result


class PcmSpool:
    def __init__(self, root: Path, prefix: str = 'utterance') -> None:
        day = datetime.now().strftime('%Y-%m-%d')
        self.directory = root / 'audio' / day
        self.directory.mkdir(parents=True, exist_ok=True)
        self.id = str(uuid.uuid4())
        self.started_at = utc_now()
        self.part = self.directory / f'{prefix}-{self.id}.pcm.part'
        self.final = self.directory / f'{prefix}-{self.id}.wav'
        self.handle = self.part.open('xb')
        self.samples = 0
        self.last_sync = time.monotonic()
        self.closed = False

    def write(self, pcm: bytes) -> None:
        if self.closed:
            raise RuntimeError('spool is closed')
        if len(pcm) % (SAMPLE_WIDTH * CHANNELS):
            raise ValueError('PCM block is not sample-aligned')
        self.handle.write(pcm)
        self.samples += len(pcm) // (SAMPLE_WIDTH * CHANNELS)
        now = time.monotonic()
        if now - self.last_sync >= 1.0:
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.last_sync = now

    def snapshot(self, max_samples: int | None = None) -> bytes:
        if self.closed:
            raise RuntimeError('spool is closed')
        self.handle.flush()
        frame_bytes = SAMPLE_WIDTH * CHANNELS
        available = self.samples
        take_samples = available if max_samples is None else min(available, max(1, int(max_samples)))
        offset = (available - take_samples) * frame_bytes
        with self.part.open('rb') as source:
            source.seek(offset)
            pcm = source.read(take_samples * frame_bytes)
        output = io.BytesIO()
        with wave.open(output, 'wb') as target:
            target.setnchannels(CHANNELS)
            target.setsampwidth(SAMPLE_WIDTH)
            target.setframerate(SAMPLE_RATE)
            target.writeframes(pcm)
        return output.getvalue()

    def truncate(self, end_sample: int) -> int:
        if self.closed:
            raise RuntimeError('spool is closed')
        try:
            end_sample = int(end_sample)
        except (TypeError, ValueError):
            raise ValueError('truncate sample boundary is invalid')
        end_sample = max(0, min(self.samples, end_sample))
        frame_bytes = SAMPLE_WIDTH * CHANNELS
        self.handle.flush()
        self.handle.seek(end_sample * frame_bytes)
        self.handle.truncate()
        self.handle.seek(0, os.SEEK_END)
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.samples = end_sample
        self.last_sync = time.monotonic()
        return end_sample

    def finish(self) -> dict[str, Any]:
        if not self.closed:
            self.handle.flush()
            os.fsync(self.handle.fileno())
            self.handle.close()
            self.closed = True
        temporary = self.final.with_name(self.final.name + '.tmp')
        with wave.open(str(temporary), 'wb') as target, self.part.open('rb') as source:
            target.setnchannels(CHANNELS)
            target.setsampwidth(SAMPLE_WIDTH)
            target.setframerate(SAMPLE_RATE)
            while block := source.read(1024 * 1024):
                target.writeframesraw(block)
        os.replace(temporary, self.final)
        self.part.unlink(missing_ok=True)
        return {
            'audioId': self.id,
            'path': str(self.final),
            'startedAt': self.started_at,
            'samples': self.samples,
            'durationMs': round(self.samples * 1000 / SAMPLE_RATE),
        }

    def force_close(self) -> None:
        if self.closed:
            return
        try:
            self.handle.close()
        except (OSError, ValueError):
            pass
        finally:
            self.closed = True

    def abandon(self) -> None:
        if self.closed:
            return
        try:
            self.handle.flush()
            os.fsync(self.handle.fileno())
        finally:
            self.force_close()


def audio_listing(root: Path, before_day: str | None = None) -> list[tuple[Path, dict[str, os.DirEntry[str]]]]:
    """Every directory under audio/ with its file entries, from one listing.

    A Windows DirEntry carries size and mtime from the listing itself, so no
    caller pays a system call per file. Globbing and checking 17,704 utterance
    WAVs one exists() at a time took 70 s of a restart. before_day limits the
    walk to YYYY-MM-DD folders older than that day, which is all retention needs.
    """
    listing: list[tuple[Path, dict[str, os.DirEntry[str]]]] = []
    audio = root / 'audio'
    pending = [audio]
    while pending:
        directory = pending.pop()
        files: dict[str, os.DirEntry[str]] = {}
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        if before_day is None or directory != audio or entry.name < before_day:
                            pending.append(Path(entry.path))
                    else:
                        files[entry.name] = entry
        except OSError:
            continue
        listing.append((directory, files))
    return listing


def recover_spools(root: Path) -> list[dict[str, Any]]:
    recovered: list[dict[str, Any]] = []
    parts = [directory / name for directory, files in audio_listing(root)
             for name in files if name.endswith('.pcm.part')]
    for part in parts:
        try:
            size = part.stat().st_size
            if size < SAMPLE_WIDTH * CHANNELS:
                part.unlink(missing_ok=True)
                continue
            final = part.with_name(part.name.removesuffix('.pcm.part') + '.recovered.wav')
            temporary = final.with_name(final.name + '.tmp')
            with wave.open(str(temporary), 'wb') as target, part.open('rb') as source:
                target.setnchannels(CHANNELS)
                target.setsampwidth(SAMPLE_WIDTH)
                target.setframerate(SAMPLE_RATE)
                while block := source.read(1024 * 1024):
                    target.writeframesraw(block)
            os.replace(temporary, final)
            part.unlink(missing_ok=True)
            recovered.append({
                'path': str(final),
                'samples': size // (SAMPLE_WIDTH * CHANNELS),
                'durationMs': round(size * 1000 / (SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS)),
            })
        except OSError:
            continue
    return recovered


class ContinuousJournal:
    def __init__(self, root: Path, chunk_seconds: int = 60) -> None:
        self.root = root
        self.chunk_samples = max(10, int(chunk_seconds)) * SAMPLE_RATE
        self.current: PcmSpool | None = None

    def write(self, pcm: bytes) -> list[dict[str, Any]]:
        completed: list[dict[str, Any]] = []
        offset = 0
        frame_bytes = SAMPLE_WIDTH * CHANNELS
        while offset < len(pcm):
            if self.current is None:
                self.current = PcmSpool(self.root, 'journal')
            remaining_samples = self.chunk_samples - self.current.samples
            take = min(len(pcm) - offset, remaining_samples * frame_bytes)
            self.current.write(pcm[offset:offset + take])
            offset += take
            if self.current.samples >= self.chunk_samples:
                completed.append(self.current.finish())
                self.current = None
        return completed

    def close(self) -> dict[str, Any] | None:
        if self.current is None:
            return None
        current = self.current
        self.current = None
        if current.samples:
            return current.finish()
        current.abandon()
        current.part.unlink(missing_ok=True)
        return None

    def abandon(self) -> None:
        current, self.current = self.current, None
        if current is None:
            return
        try:
            current.abandon()
        except (OSError, ValueError):
            current.force_close()


def _wrap_pcm(part: Path, final: Path) -> None:
    temporary = final.with_name(final.name + '.tmp')
    with wave.open(str(temporary), 'wb') as target, part.open('rb') as source:
        target.setnchannels(CHANNELS)
        target.setsampwidth(SAMPLE_WIDTH)
        target.setframerate(SAMPLE_RATE)
        while block := source.read(1024 * 1024):
            target.writeframesraw(block)
    os.replace(temporary, final)
    part.unlink(missing_ok=True)


class RawRecorder:
    """Every captured block, on disk, independent of speech processing.

    The capture callback only appends to an unbounded deque, which is atomic
    under the GIL and never waits on this writer. A slow disk or a failed write
    grows memory (32 KB/s) instead of discarding audio. Chunk names carry the
    UTC arrival time of their first block, so audio is found by wall clock.
    """
    CHUNK_SECONDS = 300
    GAP_SECONDS = 2.0
    POLL_SECONDS = 0.05
    RETRY_SECONDS = 1.0

    def __init__(self, root: Path) -> None:
        self.directory = root / 'raw'
        self.pending: deque[tuple[float, bytes]] = deque()
        self.handle: Any = None
        self.part: Path | None = None
        self.chunk_started = 0.0
        self.chunk_samples = 0
        self.last_sync = 0.0
        self.recorded_blocks = 0
        self.last_error: str | None = None
        self.closed = False
        self.thread = threading.Thread(target=self._run, name='voice-raw-recorder', daemon=True)
        self.thread.start()

    def append(self, pcm: bytes) -> None:
        self.pending.append((time.time(), pcm))

    def _open_chunk(self, started: float) -> None:
        stamp = datetime.fromtimestamp(started, timezone.utc)
        directory = self.directory / stamp.strftime('%Y-%m-%d')
        directory.mkdir(parents=True, exist_ok=True)
        part = directory / f"raw-{stamp.strftime('%Y%m%dT%H%M%S')}{stamp.microsecond // 1000:03d}Z.pcm.part"
        self.handle = part.open('ab')
        self.part = part
        self.chunk_started = started
        self.chunk_samples = 0
        self.last_sync = time.monotonic()

    def _finish_chunk(self) -> None:
        handle, part = self.handle, self.part
        if handle is None or part is None:
            return
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        self.handle = None
        self.part = None
        _wrap_pcm(part, part.with_name(part.name.removesuffix('.pcm.part') + '.wav'))

    def _abandon_chunk(self) -> None:
        # The .pcm.part stays on disk; recover_raw wraps it at the next start.
        handle, self.handle, self.part = self.handle, None, None
        if handle is not None:
            try:
                handle.close()
            except (OSError, ValueError):
                pass

    def _drain(self) -> None:
        frame_bytes = SAMPLE_WIDTH * CHANNELS
        while self.pending:
            arrived, pcm = self.pending[0]
            started = arrived - len(pcm) / frame_bytes / SAMPLE_RATE
            if self.handle is not None and (
                    self.chunk_samples >= self.CHUNK_SECONDS * SAMPLE_RATE
                    or started > self.chunk_started + self.chunk_samples / SAMPLE_RATE + self.GAP_SECONDS):
                self._finish_chunk()
            if self.handle is None:
                self._open_chunk(started)
            self.handle.write(pcm)
            self.chunk_samples += len(pcm) // frame_bytes
            self.pending.popleft()
            self.recorded_blocks += 1
        if self.handle is not None:
            self.handle.flush()
            if time.monotonic() - self.last_sync >= 1.0:
                os.fsync(self.handle.fileno())
                self.last_sync = time.monotonic()

    def _run(self) -> None:
        while True:
            closing = self.closed
            try:
                self._drain()
                if closing:
                    self._finish_chunk()
                    return
            except Exception as error:
                self.last_error = f'{type(error).__name__}: {error}'[:500]
                self._abandon_chunk()
                if closing:
                    return
                time.sleep(self.RETRY_SECONDS)
                continue
            time.sleep(self.POLL_SECONDS)

    def telemetry(self) -> dict[str, Any]:
        part = self.part
        return {
            'recordedBlocks': self.recorded_blocks,
            'pendingBlocks': len(self.pending),
            'chunk': part.name.removesuffix('.pcm.part') if part is not None else None,
            'writerAlive': self.thread.is_alive(),
            'lastError': self.last_error,
        }

    def close(self) -> None:
        self.closed = True
        self.thread.join(timeout=10)


def recover_raw(root: Path) -> int:
    recovered = 0
    raw = root / 'raw'
    if not raw.exists():
        return recovered
    for part in raw.rglob('*.pcm.part'):
        try:
            if part.stat().st_size < SAMPLE_WIDTH * CHANNELS:
                part.unlink(missing_ok=True)
                continue
            _wrap_pcm(part, part.with_name(part.name.removesuffix('.pcm.part') + '.wav'))
            recovered += 1
        except OSError:
            continue
    return recovered


FRAME_HEADER = struct.Struct('!cI')
MAX_FRAME_BYTES = 1024 * 1024


def encode_frame(kind: bytes, payload: bytes) -> bytes:
    return FRAME_HEADER.pack(kind, len(payload)) + payload


class FrameReader:
    """Reads recorder frames: a one-byte kind, a length, then the payload."""

    def __init__(self, connection: socket.socket) -> None:
        self.connection = connection
        self.buffer = bytearray()

    def read(self) -> tuple[bytes, bytes] | None:
        while True:
            if len(self.buffer) >= FRAME_HEADER.size:
                kind, length = FRAME_HEADER.unpack_from(self.buffer)
                if length > MAX_FRAME_BYTES:
                    raise ValueError('recorder frame is too large')
                end = FRAME_HEADER.size + length
                if len(self.buffer) >= end:
                    payload = bytes(self.buffer[FRAME_HEADER.size:end])
                    del self.buffer[:end]
                    return kind, payload
            try:
                chunk = self.connection.recv(65536)
            except socket.timeout:
                return None
            if not chunk:
                raise ConnectionError('recorder closed the stream')
            self.buffer.extend(chunk)


def resolve_input_device(sounddevice: Any, configured: Any) -> Any:
    if configured not in {'', None}:
        return configured
    if os.name != 'nt':
        return None
    devices = sounddevice.query_devices()
    host_apis = sounddevice.query_hostapis()
    try:
        default_index = int(sounddevice.default.device[0])
        default_name = str(devices[default_index]['name']).lower()
    except (IndexError, KeyError, TypeError, ValueError):
        default_name = ''
    candidates: list[int] = []
    for index, device in enumerate(devices):
        try:
            host_name = str(host_apis[device['hostapi']]['name'])
            if device['max_input_channels'] > 0 and 'WASAPI' in host_name:
                candidates.append(index)
        except (IndexError, KeyError, TypeError):
            continue
    for index in candidates:
        name = str(devices[index]['name']).lower()
        if default_name and (name.startswith(default_name) or default_name.startswith(name)):
            return index
    for host_api in host_apis:
        if 'WASAPI' not in str(host_api.get('name', '')):
            continue
        index = host_api.get('default_input_device')
        if isinstance(index, int) and index >= 0:
            return index
    return candidates[0] if candidates else None


def hold_audio_residency(min_working_set: int = 512 * 1024 * 1024) -> dict[str, Any]:
    """Keep the capture process in RAM under system memory pressure.

    Task Scheduler's default task priority starts this process below normal with
    memory priority 2, the first pages Windows repurposes, and I/O priority Low.
    Trimmed to 43 MB of 1.2 GB, the PortAudio callback hard-faulted for seconds
    while a second capture client on the same device lost nothing; with the
    working set held, every thread still parked for up to 5 s behind Low-priority
    I/O, and a cold start spent two minutes loading DLLs at that priority. The
    hard working-set floor needs SeIncreaseWorkingSetPrivilege, which standard
    users hold by default.
    """
    result: dict[str, Any] = {'error': None}
    if os.name != 'nt':
        return result
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetPriorityClass.argtypes = [wintypes.HANDLE]
    kernel32.GetPriorityClass.restype = wintypes.DWORD
    kernel32.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.GetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.SetProcessWorkingSetSizeEx.argtypes = [wintypes.HANDLE, ctypes.c_size_t, ctypes.c_size_t, wintypes.DWORD]
    kernel32.GetProcessWorkingSetSizeEx.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t),
        ctypes.POINTER(wintypes.DWORD)]
    ntdll = ctypes.WinDLL('ntdll')
    ntdll.NtSetInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG]
    ntdll.NtQueryInformationProcess.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    process_memory_priority = 0
    process_io_priority = 33
    io_priority_normal = 2
    normal_priority_class = 0x20
    memory_priority_normal = 5
    hardws_min_enable = 0x1
    hardws_max_disable = 0x8

    process = kernel32.GetCurrentProcess()
    errors: list[str] = []
    if not kernel32.SetPriorityClass(process, normal_priority_class):
        errors.append(f'SetPriorityClass {ctypes.get_last_error()}')
    priority = wintypes.ULONG(memory_priority_normal)
    if not kernel32.SetProcessInformation(process, process_memory_priority,
                                          ctypes.byref(priority), ctypes.sizeof(priority)):
        errors.append(f'SetProcessInformation {ctypes.get_last_error()}')
    io_priority = wintypes.ULONG(io_priority_normal)
    status = ntdll.NtSetInformationProcess(process, process_io_priority,
                                           ctypes.byref(io_priority), ctypes.sizeof(io_priority))
    if status:
        errors.append(f'NtSetInformationProcess 0x{status & 0xffffffff:08x}')
    minimum = max(1, int(min_working_set))
    if not kernel32.SetProcessWorkingSetSizeEx(process, minimum, minimum * 4,
                                               hardws_min_enable | hardws_max_disable):
        errors.append(f'SetProcessWorkingSetSizeEx {ctypes.get_last_error()}')

    # Report what the kernel holds, not what was requested.
    readback = wintypes.ULONG(0)
    kernel32.GetProcessInformation(process, process_memory_priority,
                                   ctypes.byref(readback), ctypes.sizeof(readback))
    io_readback = wintypes.ULONG(0)
    ntdll.NtQueryInformationProcess(process, process_io_priority, ctypes.byref(io_readback),
                                    ctypes.sizeof(io_readback), None)
    low, high, flags = ctypes.c_size_t(0), ctypes.c_size_t(0), wintypes.DWORD(0)
    kernel32.GetProcessWorkingSetSizeEx(process, ctypes.byref(low), ctypes.byref(high), ctypes.byref(flags))
    result.update({
        'priorityClass': kernel32.GetPriorityClass(process),
        'memoryPriority': readback.value,
        'ioPriority': io_readback.value,
        'workingSetMinBytes': low.value,
        'workingSetMinHard': bool(flags.value & hardws_min_enable),
        'error': '; '.join(errors) or None,
    })
    return result


def prune_audio(root: Path, retention_days: int) -> int:
    if retention_days <= 0:
        return 0
    cutoff = time.time() - retention_days * 86_400
    removed = 0
    audio = root / 'audio'
    # Day folders are named by local date; the day after the cutoff's date may
    # still hold expired files, so it is included and each file checks mtime.
    listing = audio_listing(root, datetime.fromtimestamp(cutoff + 86_400).strftime('%Y-%m-%d'))
    for directory, files in listing:
        for name, entry in files.items():
            if not name.endswith('.wav') or name + '.job.json' in files:
                continue
            try:
                if entry.stat().st_mtime >= cutoff:
                    continue
                os.unlink(entry.path)
                (directory / (name + '.transcript.json')).unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
    for directory, _files in sorted(listing, key=lambda item: len(item[0].parts), reverse=True):
        if directory == audio:
            continue
        try:
            directory.rmdir()
        except OSError:
            pass
    return removed


@dataclass
class Recognition:
    raw: str
    text: str
    language: str | None = None
    confidence: float | None = None
    emotion: dict[str, Any] | None = None
    prosody: dict[str, Any] | None = None


class VoiceState:
    SUMMARY = re.compile(r'^(?:please\s+)?(?:summari[sz]e|give me (?:a )?summary of)\b', re.I)
    CANCEL = re.compile(r'^(?:please\s+)?(?:stop|cancel|interrupt)(?:\s+(?:the )?(?:agent|turn))?[.!?]?$', re.I)

    def __init__(self, events: EventStore, wake_phrases: Iterable[str], arm_seconds: int = 25,
                 stop_phrase: str = 'green apple') -> None:
        phrases = [normalize_space(value).lower() for value in wake_phrases if normalize_space(value)]
        self.events = events
        self.wake_phrases = phrases or ['hey agent']
        self.stop_phrase = normalize_space(stop_phrase).lower() or 'green apple'
        self.arm_seconds = max(5, int(arm_seconds))
        self.wake_enabled = True
        self.lock = threading.RLock()
        self.mode = 'wake'
        self.armed_until = 0.0
        self.armed_target: dict[str, Any] = safe_target({})
        self.target: dict[str, Any] = safe_target({})
        self.interaction_id: str | None = None
        self.dictation_segments: list[str] = []
        self.dictation_emotions: list[dict[str, Any]] = []
        self.dictation_prosodies: list[dict[str, Any]] = []
        self.pending_path = events.root / 'pending-command.json'
        self.pending_command = self._load_pending()

    def _load_pending(self) -> dict[str, Any] | None:
        pending = read_json(self.pending_path, None)
        valid = isinstance(pending, dict) and isinstance(pending.get('commandId'), str)
        for key in ('rawParts', 'textParts', 'commandParts', 'audioSegments', 'confidences'):
            valid = valid and isinstance(pending.get(key), list)
        if not valid or not pending['commandParts']:
            self.pending_path.unlink(missing_ok=True)
            return None
        if not isinstance(pending.get('emotionParts'), list):
            pending['emotionParts'] = []
        if not isinstance(pending.get('prosodyParts'), list):
            pending['prosodyParts'] = []
        if any(event.get('kind') == 'command.final'
               and event.get('commandId') == pending['commandId'] for event in self.events.events):
            self.pending_path.unlink(missing_ok=True)
            return None
        pending['target'] = safe_target(pending.get('target'))
        return pending

    def _save_pending_locked(self) -> None:
        if self.pending_command is not None:
            atomic_json(self.pending_path, self.pending_command)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                'mode': self.mode,
                'armed': self.armed_until > time.monotonic(),
                'interactionId': self.interaction_id,
                'commandPending': self.pending_command is not None,
                'stopPhrase': self.stop_phrase,
                'target': self.target,
            }

    def start_dictation(self, target: Any) -> dict[str, Any]:
        with self.lock:
            if self.mode == 'dictation':
                return self.snapshot()
            self.mode = 'dictation'
            self.armed_until = 0
            self.armed_target = safe_target({})
            self.target = safe_target(target)
            self.interaction_id = str(uuid.uuid4())
            self.dictation_segments = []
            self.dictation_emotions = []
            self.dictation_prosodies = []
            self.events.append('dictation.started', {
                'interactionId': self.interaction_id,
                'target': self.target,
            })
            return self.snapshot()

    def stop_dictation(self) -> dict[str, Any]:
        with self.lock:
            if self.mode != 'dictation':
                return self.snapshot()
            interaction_id = self.interaction_id
            text = normalize_space(' '.join(self.dictation_segments))
            emotion = self._aggregate_emotion(self.dictation_emotions)
            prosody = self._aggregate_prosody(self.dictation_prosodies)
            target = self.target
            self.mode = 'wake'
            self.interaction_id = None
            self.dictation_segments = []
            self.dictation_emotions = []
            self.dictation_prosodies = []
            self.events.append('dictation.final', {
                'interactionId': interaction_id,
                'text': text,
                'emotion': emotion,
                'prosody': prosody,
                'target': target,
            })
            return self.snapshot()

    def cancel_dictation(self) -> dict[str, Any]:
        with self.lock:
            if self.mode == 'dictation':
                self.events.append('dictation.cancelled', {
                    'interactionId': self.interaction_id,
                    'target': self.target,
                })
            self.mode = 'wake'
            self.interaction_id = None
            self.dictation_segments = []
            self.dictation_emotions = []
            self.dictation_prosodies = []
            return self.snapshot()

    def update_target(self, target: Any) -> None:
        with self.lock:
            value = safe_target(target)
            if any(value.values()):
                self.target = value

    def match_wake(self, text: str) -> tuple[str | None, str | None]:
        with self.lock:
            return match_wake_phrase(text, self.wake_phrases)

    def configure_stop_phrase(self, value: Any) -> str:
        with self.lock:
            normalized = normalize_space(value).lower()
            self.stop_phrase = normalized or 'green apple'
            return self.stop_phrase

    @classmethod
    def _intent(cls, command: str) -> str:
        if cls.SUMMARY.search(command):
            return 'summary'
        if cls.CANCEL.fullmatch(command):
            return 'cancel'
        return 'prompt'

    @staticmethod
    def _aggregate_emotion(parts: list[dict[str, Any]]) -> dict[str, Any] | None:
        totals: dict[str, float] = {}
        total_weight = 0.0
        model = None
        confidence_threshold = 0.90
        margin_threshold = 0.20
        for part in parts:
            emotion = part.get('emotion') if isinstance(part, dict) else None
            scores = emotion.get('scores') if isinstance(emotion, dict) else None
            if not isinstance(scores, dict):
                continue
            audio = part.get('audio') if isinstance(part.get('audio'), dict) else {}
            weight = max(1.0, float(audio.get('durationMs', 1)))
            accepted = False
            for label, score in scores.items():
                if not isinstance(label, str) or not isinstance(score, (int, float)):
                    continue
                totals[label] = totals.get(label, 0.0) + max(0.0, min(1.0, float(score))) * weight
                accepted = True
            if not accepted:
                continue
            total_weight += weight
            model = emotion.get('model') or model
            confidence_threshold = float(emotion.get('confidenceThreshold', confidence_threshold))
            margin_threshold = float(emotion.get('marginThreshold', margin_threshold))
        if not totals or total_weight <= 0:
            return None
        scores = {label: value / total_weight for label, value in totals.items()}
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        label, confidence = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
        margin = confidence - runner_up
        return {
            'label': label,
            'confidence': confidence,
            'margin': margin,
            'reliable': label not in {'other', 'unknown'}
                and confidence >= confidence_threshold and margin >= margin_threshold,
            'scores': scores,
            'model': model,
        }

    @staticmethod
    def _aggregate_prosody(parts: list[dict[str, Any]]) -> dict[str, Any] | None:
        totals: dict[str, dict[str, float]] = {}
        total_weight = 0.0
        analyzed_weight = 0.0
        metadata: dict[str, Any] | None = None
        for part in parts:
            audio = part.get('audio') if isinstance(part, dict) and isinstance(part.get('audio'), dict) else {}
            try:
                weight = max(1.0, float(audio.get('durationMs', 1)))
            except (TypeError, ValueError):
                weight = 1.0
            if not math.isfinite(weight):
                weight = 1.0
            total_weight += weight
            prosody = part.get('prosody') if isinstance(part, dict) else None
            profile = prosody.get('profile') if isinstance(prosody, dict) \
                and prosody.get('status') == 'ready' else None
            if not isinstance(profile, dict) or not profile:
                continue
            identity = {
                'model': prosody.get('model'),
                'modelRevision': prosody.get('modelRevision'),
                'artifactDigest': prosody.get('artifactDigest'),
                'baselineDigest': prosody.get('baselineDigest'),
                'baselineSampleCount': prosody.get('baselineSampleCount'),
            }
            if metadata is not None and identity != metadata:
                continue
            metadata = identity
            accepted = False
            for code, row in profile.items():
                if not isinstance(code, str) or not isinstance(row, dict):
                    continue
                score = row.get('score')
                z_score = row.get('z')
                if isinstance(score, bool) or not isinstance(score, (int, float)) \
                        or isinstance(z_score, bool) or not isinstance(z_score, (int, float)) \
                        or not math.isfinite(float(score)) or not math.isfinite(float(z_score)):
                    continue
                value = totals.setdefault(code, {'score': 0.0, 'z': 0.0})
                value['score'] += float(score) * weight
                value['z'] += max(-6.0, min(6.0, float(z_score))) * weight
                accepted = True
            if accepted:
                analyzed_weight += weight
        if metadata is None or analyzed_weight <= 0 or total_weight <= 0:
            return None
        profile = {
            code: {
                'score': round(value['score'] / analyzed_weight, 3),
                'z': round(value['z'] / analyzed_weight, 3),
            }
            for code, value in totals.items()
        }
        coverage = analyzed_weight / total_weight
        return {
            'schemaVersion': 1,
            'status': 'ready' if coverage >= 0.999 else 'partial',
            **metadata,
            'coverage': round(max(0.0, min(1.0, coverage)), 4),
            'totalDurationMs': round(total_weight),
            'analyzedDurationMs': round(analyzed_weight),
            'profile': profile,
        }

    def has_pending_command(self) -> bool:
        with self.lock:
            return self.pending_command is not None

    def _flush_pending_locked(self) -> list[dict[str, Any]]:
        pending = self.pending_command
        if pending is None:
            return []
        command = normalize_space(' '.join(pending['commandParts']))
        if not command:
            self.pending_command = None
            self.pending_path.unlink(missing_ok=True)
            return []
        confidence = [value for value in pending['confidences'] if isinstance(value, (int, float))]
        event = self.events.append('command.final', {
            'commandId': pending['commandId'],
            'raw': normalize_space(' '.join(pending['rawParts'])),
            'text': normalize_space(' '.join(pending['textParts'])),
            'language': pending['language'],
            'confidence': sum(confidence) / len(confidence) if confidence else None,
            'emotion': self._aggregate_emotion(pending['emotionParts']),
            'prosody': self._aggregate_prosody(pending['prosodyParts']),
            'audio': pending['audioSegments'][0],
            'audioSegments': pending['audioSegments'],
            'command': command,
            'intent': self._intent(command),
            'target': pending['target'],
        })
        self.pending_command = None
        self.pending_path.unlink(missing_ok=True)
        return [event]

    def flush_pending(self) -> list[dict[str, Any]]:
        with self.lock:
            return self._flush_pending_locked()

    def finish_stopped_command(self) -> list[dict[str, Any]]:
        with self.lock:
            self.armed_until = 0
            self.armed_target = safe_target({})
            return self._flush_pending_locked()

    def accept(self, recognition: Recognition, audio: dict[str, Any], route: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        raw = normalize_space(recognition.raw)
        text = normalize_space(recognition.text) or raw
        if not text:
            return []
        evidence = {
            'raw': raw,
            'text': text,
            'language': recognition.language,
            'confidence': recognition.confidence,
            'emotion': recognition.emotion,
            'prosody': recognition.prosody,
            'audio': audio,
        }
        emitted: list[dict[str, Any]] = []
        with self.lock:
            self.events.append('transcript.archived', evidence)
            routed_mode = route.get('mode') if isinstance(route, dict) else self.mode
            if routed_mode == 'archive':
                emitted.append(self.events.append('transcript.recovered', {
                    **evidence,
                    'target': safe_target(route.get('target')) if isinstance(route, dict) else self.target,
                }))
                return emitted
            if routed_mode == 'dictation':
                interaction_id = route.get('interactionId') if isinstance(route, dict) else self.interaction_id
                target = safe_target(route.get('target')) if isinstance(route, dict) else self.target
                if interaction_id != self.interaction_id:
                    emitted.append(self.events.append('dictation.recovered', {
                        **evidence,
                        'interactionId': interaction_id,
                        'target': target,
                    }))
                    return emitted
                stop_phrase = route.get('stopPhrase') if isinstance(route, dict) else None
                text, stopped = split_stop_phrase(text, stop_phrase or self.stop_phrase)
                if not text:
                    if stopped:
                        self.stop_dictation()
                    return emitted
                self.dictation_segments.append(text)
                self.dictation_emotions.append({'emotion': recognition.emotion, 'audio': audio})
                self.dictation_prosodies.append({'prosody': recognition.prosody, 'audio': audio})
                emitted.append(self.events.append('dictation.segment', {
                    **evidence,
                    'interactionId': interaction_id,
                    'segmentIndex': len(self.dictation_segments) - 1,
                    'target': target,
                    'text': text,
                }))
                if stopped:
                    self.stop_dictation()
                return emitted

            routed_target = safe_target(route.get('target')) if isinstance(route, dict) else self.target
            if not self.wake_enabled:
                return emitted
            now = time.monotonic()
            wake_phrase, command = match_wake_phrase(text, self.wake_phrases)

            if wake_phrase is not None:
                self.armed_until = now + self.arm_seconds
                self.armed_target = routed_target
                emitted.append(self.events.append('wake.detected', {
                    **evidence,
                    'wakePhrase': wake_phrase,
                    'target': routed_target,
                }))
                if not command:
                    if isinstance(route, dict) and route.get('stopPhraseDetected') is True:
                        return emitted
                    emitted.append(self.events.append('wake.armed', {
                        'until': time.time() + self.arm_seconds,
                        'target': routed_target,
                    }))
                    return emitted
            elif self.pending_command is not None:
                command = text
                routed_target = self.pending_command['target']
            elif self.armed_until > now:
                command = text
                if self.armed_until > now:
                    routed_target = self.armed_target
            else:
                return emitted

            self.armed_until = 0
            self.armed_target = safe_target({})
            # Final ASR is the fallback when an in-flight partial result was
            # stale or missed the phrase. Keep archived evidence intact while
            # excluding the stop phrase and its tail from delivered text.
            stop_phrase = route.get('stopPhrase') if isinstance(route, dict) else None
            command, stopped = split_stop_phrase(command, stop_phrase or self.stop_phrase)
            if not command:
                if stopped:
                    emitted.extend(self._flush_pending_locked())
                return emitted
            if self.pending_command is not None and self.pending_command['target'] != routed_target:
                emitted.extend(self._flush_pending_locked())
            if self.pending_command is None:
                self.pending_command = {
                    'commandId': str(uuid.uuid4()),
                    'rawParts': [],
                    'textParts': [],
                    'commandParts': [],
                    'audioSegments': [],
                    'confidences': [],
                    'emotionParts': [],
                    'prosodyParts': [],
                    'language': recognition.language,
                    'target': routed_target,
                }
            self.pending_command['rawParts'].append(raw)
            self.pending_command['textParts'].append(text)
            self.pending_command['commandParts'].append(command)
            self.pending_command['audioSegments'].append(audio)
            self.pending_command['confidences'].append(recognition.confidence)
            self.pending_command['emotionParts'].append({'emotion': recognition.emotion, 'audio': audio})
            self.pending_command['prosodyParts'].append({'prosody': recognition.prosody, 'audio': audio})
            self._save_pending_locked()
            emitted.append(self.events.append('command.pending', {
                **evidence,
                'segmentCount': len(self.pending_command['commandParts']),
                'target': routed_target,
            }))
            if stopped:
                emitted.extend(self._flush_pending_locked())
        return emitted
