"""Microphone recorder: the only process that touches the capture device.

It holds the WASAPI stream, writes every 16 kHz block to the raw spool, and
streams the same blocks to the companion over authenticated loopback. It is a
separate, small process because the companion is not: on 2026-09-25, with
torch, a dozen threads and heavy disk I/O, the companion lost up to 48% of the
microphone to multi-second whole-process stalls while a minimal capture
process on the same device lost nothing. The recorder also outlives companion
restarts, so restarting the companion no longer drops audio.

One instance per state root: the loopback port is bound before the device or
the spool is touched, so a duplicate launch exits without recording twice.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import socket
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from common import (
    SAMPLE_RATE,
    RawRecorder,
    encode_frame,
    hold_audio_residency,
    read_json,
    recover_raw,
    resolve_input_device,
)

BLOCK_SAMPLES = 512


class Recorder:
    # A companion that stops reading gets at most this much live audio when it
    # resumes; the raw spool keeps everything regardless.
    LIVE_BLOCKS = 60 * SAMPLE_RATE // BLOCK_SAMPLES
    INPUT_STALL_SECONDS = 2.0
    IDLE_EXIT_SECONDS = 900.0

    def __init__(self, root: Path, config_path: Path, port: int) -> None:
        self.root = root
        self.config_path = config_path
        self.port = port
        self.token = (root / 'token').read_text(encoding='utf-8').strip()
        self.live: deque[bytes] = deque(maxlen=self.LIVE_BLOCKS)
        self.live_dropped = 0
        self.input_blocks = 0
        self.input_statuses = 0
        self.input_overflows = 0
        self.last_input: float | None = None
        self.device: dict[str, Any] | None = None
        self.last_error: str | None = None
        self.recovered = 0
        self.recorder: RawRecorder | None = None
        self.listener: socket.socket | None = None
        self.client: socket.socket | None = None
        self.client_lock = threading.Lock()
        self.last_client = time.monotonic()
        self.stream: Any = None
        self.closed = False
        self.residency: dict[str, Any] | None = None

    def bind(self) -> int:
        # Bind first: a second instance fails here before it can open the device
        # or wrap the first instance's open chunk.
        listener = socket.create_server(('127.0.0.1', self.port))
        listener.settimeout(1.0)
        self.listener = listener
        self.port = listener.getsockname()[1]
        self.recovered = recover_raw(self.root)
        self.recorder = RawRecorder(self.root)
        return self.port

    def on_block(self, pcm: bytes) -> None:
        self.input_blocks += 1
        self.last_input = time.monotonic()
        self.recorder.append(pcm)
        if len(self.live) == self.LIVE_BLOCKS:
            self.live_dropped += 1
        self.live.append(encode_frame(b'P', pcm))

    def on_status(self, warning: str, input_overflow: bool) -> None:
        self.input_statuses += 1
        if input_overflow:
            self.input_overflows += 1
        self._control(b'S', {'warning': warning[:500], 'inputOverflow': input_overflow})

    def _control(self, kind: bytes, value: dict[str, Any]) -> None:
        self.live.append(encode_frame(kind, json.dumps(value).encode('utf-8')))

    def telemetry(self) -> dict[str, Any]:
        now = time.monotonic()
        return {
            'pid': os.getpid(),
            'device': self.device,
            'inputBlocks': self.input_blocks,
            'inputStatuses': self.input_statuses,
            'inputOverflows': self.input_overflows,
            'inputAgeMs': round((now - self.last_input) * 1000) if self.last_input is not None else None,
            'liveBacklogBlocks': len(self.live),
            'liveDroppedBlocks': self.live_dropped,
            'recoveredChunks': self.recovered,
            'rawRecording': self.recorder.telemetry() if self.recorder is not None else None,
            'residency': self.residency,
            'lastError': self.last_error,
        }

    def _capture(self) -> None:
        backoff = 1.0
        while not self.closed:
            try:
                import sounddevice as sd
                configured = read_json(self.config_path, {}).get('inputDevice')
                device = resolve_input_device(sd, configured)
                details = sd.query_devices(device, 'input') if device is not None else sd.query_devices(kind='input')
                host_api = sd.query_hostapis(details['hostapi'])
                try:
                    sd.check_input_settings(device=device, channels=1, dtype='int16', samplerate=SAMPLE_RATE)
                    device_rate = SAMPLE_RATE
                except Exception:
                    device_rate = max(SAMPLE_RATE, round(float(details['default_samplerate'])))
                converted = bytearray()
                resampler = None
                if device_rate != SAMPLE_RATE:
                    import numpy as np
                    import soxr
                    resampler = soxr.ResampleStream(device_rate, SAMPLE_RATE, 1, dtype='int16', quality='HQ')

                def callback(indata: Any, _frames: int, _time: Any, status: Any) -> None:
                    if status:
                        self.on_status(str(status), getattr(status, 'input_overflow', False))
                    pcm = bytes(indata)
                    if resampler is None:
                        self.on_block(pcm)
                        return
                    output = resampler.resample_chunk(np.frombuffer(pcm, dtype='<i2'))
                    converted.extend(output.astype('<i2', copy=False).tobytes())
                    block_bytes = BLOCK_SAMPLES * 2
                    while len(converted) >= block_bytes:
                        self.on_block(bytes(converted[:block_bytes]))
                        del converted[:block_bytes]

                with sd.RawInputStream(
                    samplerate=device_rate,
                    blocksize=round(BLOCK_SAMPLES * device_rate / SAMPLE_RATE),
                    device=device,
                    channels=1,
                    dtype='int16',
                    callback=callback,
                ) as stream:
                    opened_at = time.monotonic()
                    self.stream = stream
                    self.device = {
                        'index': device,
                        'name': str(details['name']),
                        'hostApi': str(host_api['name']),
                        'sampleRate': device_rate,
                    }
                    self._control(b'R', self.device)
                    backoff = 1.0
                    while not self.closed:
                        time.sleep(0.25)
                        if not getattr(stream, 'active', True):
                            raise RuntimeError('microphone stream became inactive')
                        last = self.last_input if self.last_input is not None and self.last_input >= opened_at \
                            else opened_at
                        if time.monotonic() - last > self.INPUT_STALL_SECONDS:
                            raise RuntimeError('microphone input callbacks stalled')
            except Exception as error:
                self.stream = None
                self.device = None
                if self.closed:
                    break
                self.last_error = f'{type(error).__name__}: {error}'[:500]
                self._control(b'F', {'error': self.last_error})
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    def _read_token(self, connection: socket.socket) -> str:
        data = b''
        while not data.endswith(b'\n') and len(data) < 256:
            chunk = connection.recv(256 - len(data))
            if not chunk:
                break
            data += chunk
        return data.strip().decode('utf-8', 'replace')

    def _serve_client(self, connection: socket.socket) -> None:
        try:
            connection.settimeout(3.0)
            if not hmac.compare_digest(self._read_token(connection), self.token):
                return
            connection.settimeout(None)
            with self.client_lock:
                previous, self.client = self.client, connection
                # A new consumer starts at now; everything earlier is on disk.
                self.live.clear()
            if previous is not None:
                try:
                    previous.close()
                except OSError:
                    pass
            if self.device is not None:
                connection.sendall(encode_frame(b'R', json.dumps(self.device).encode('utf-8')))
            last_telemetry = 0.0
            while not self.closed and self.client is connection:
                sent = False
                while self.live and self.client is connection:
                    connection.sendall(self.live.popleft())
                    sent = True
                now = time.monotonic()
                if now - last_telemetry >= 1.0:
                    connection.sendall(encode_frame(b'T', json.dumps(self.telemetry()).encode('utf-8')))
                    last_telemetry = now
                self.last_client = now
                if not sent:
                    time.sleep(0.005)
        except OSError:
            pass
        finally:
            with self.client_lock:
                if self.client is connection:
                    self.client = None
                    self.last_client = time.monotonic()
            try:
                connection.close()
            except OSError:
                pass

    def serve(self) -> None:
        while not self.closed:
            try:
                connection, _address = self.listener.accept()
            except socket.timeout:
                if self.client is None and time.monotonic() - self.last_client > self.IDLE_EXIT_SECONDS:
                    self.close()
                continue
            except OSError:
                if self.closed:
                    break
                raise
            threading.Thread(target=self._serve_client, args=(connection,), name='recorder-client',
                             daemon=True).start()

    def run(self) -> None:
        threading.Thread(target=self._capture, name='recorder-capture', daemon=True).start()
        self.serve()

    def close(self) -> None:
        self.closed = True
        stream = self.stream
        if stream is not None:
            try:
                stream.abort()
            except Exception:
                pass
        if self.recorder is not None:
            self.recorder.close()
        if self.listener is not None:
            try:
                self.listener.close()
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description='Microphone recorder for the claude-ui-mod voice companion')
    parser.add_argument('--state-root', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    root = args.state_root.resolve()
    log = (root / 'recorder.log').open('a', encoding='utf-8', buffering=1)
    sys.stdout = log
    sys.stderr = log
    recorder = Recorder(root, args.config.resolve(), args.port)
    try:
        recorder.bind()
    except OSError as error:
        print(json.dumps({'exit': 'port in use; another recorder owns this state root', 'error': str(error)}),
              flush=True)
        return
    recorder.residency = hold_audio_residency(64 * 1024 * 1024)
    print(json.dumps({'listening': recorder.port, 'pid': os.getpid(), 'recovered': recorder.recovered,
                      'residency': recorder.residency}), flush=True)
    try:
        recorder.run()
    finally:
        recorder.close()


if __name__ == '__main__':
    main()
