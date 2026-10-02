from __future__ import annotations

import errno
import hashlib
import io
import json
import math
import os
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prosody_server
from common import EventStore, PcmSpool, Recognition, SAMPLE_RATE, VoiceState, atomic_json, recover_spools
from compute_server import (
    Config as ComputeConfig,
    LazyAsr,
    LazyEmotion,
    LazyWakeAsr,
    PROSODY_DIMENSIONS,
    PROSODY_PROFILE_DIMENSIONS,
    ProsodyClient,
    Service,
)
from prosody_server import Config as ProsodyConfig, MODEL_ID, MODEL_REVISION, VoiceNet, verify_model_artifacts
from workstation import Capture, CaptureBacklog, ComputeClient, RuntimeConfig, Transcriber, WakeProbe


TARGET = {
    'desktopSessionId': 'local_11111111-2222-3333-4444-555555555555',
    'cliSessionId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'webContentsId': 7,
}


class FakeCompute:
    def __init__(self, fail: bool = False, gate: threading.Event | None = None,
                 text: str = 'alpha.cpp', words: list[dict[str, Any]] | None = None) -> None:
        self.fail = fail
        self.gate = gate
        self.text = text
        self.words = words or []
        self.calls = 0

    def wake(self, _wav: bytes):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(3)
        if self.fail:
            raise OSError('offline')
        return {'text': self.text, 'model': 'fake-wake', 'words': self.words}

    def transcribe(self, _wav: bytes):
        self.calls += 1
        if self.gate is not None:
            self.gate.wait(3)
        if self.fail:
            raise OSError('offline')
        return {
            'rawText': self.text,
            'text': self.text,
            'language': 'en',
            'confidence': 0.9,
            'model': 'fake',
            'refined': False,
            'refineError': None,
        }


class FakePlayback:
    def __init__(self) -> None:
        self.cues: list[str] = []

    def cue(self, kind: str) -> bool:
        self.cues.append(kind)
        return True


class RuntimeConfigTests(unittest.TestCase):
    def test_stale_keys_are_pruned_at_load(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'workstation.json'
            path.write_text(json.dumps({'refine': True}), encoding='utf-8')
            config = RuntimeConfig(path, root)
            self.assertNotIn('refine', config.snapshot())
            self.assertNotIn('refine', json.loads(path.read_text(encoding='utf-8')))

    def test_runtime_update_cannot_replace_transport_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'workstation.json'
            config = RuntimeConfig(path, root)
            before = config.get('computeUrl')
            values = config.update({
                'continuousJournal': True,
                'stopPhrase': '  Blue   Banana  ',
                'computeUrl': 'http://attacker',
                'refine': True,
            })
            self.assertTrue(values['continuousJournal'])
            self.assertEqual(values['stopPhrase'], 'blue banana')
            self.assertEqual(values['computeUrl'], before)
            self.assertNotIn('refine', values)


class ComputeClientTests(unittest.TestCase):
    def test_transcribe_cannot_request_refinement(self) -> None:
        client = object.__new__(ComputeClient)
        client.config = type('Config', (), {'get': lambda _self, _key: True})()
        routes = []

        def request(_method, route, _body=None, _content_type='application/json', timeout=120):
            routes.append(route)
            return b'{"text":"raw"}', 'application/json'

        client.request = request
        self.assertEqual(client.transcribe(b'RIFFfake')['text'], 'raw')
        self.assertEqual(routes, ['/v1/transcribe?emotion=1&prosody=1'])


class ProsodyConfigTests(unittest.TestCase):
    def test_defaults_pin_the_audited_voicenet_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = ProsodyConfig.load(Path(temporary) / 'prosody.json')
            self.assertEqual(config.host, '127.0.0.1')
            self.assertEqual(config.port, 8766)
            self.assertEqual(config.device, 'cpu')
            self.assertEqual(config.model_id, MODEL_ID)
            self.assertEqual(config.model_revision, MODEL_REVISION)

    def test_unreviewed_model_identity_fails_closed_before_loading_code(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'predict.py').write_text('raise AssertionError("must not execute")\n', encoding='utf-8')
            config = ProsodyConfig.load(root / 'prosody.json')
            config.model_dir = root
            config.model_revision = 'floating-main'
            with self.assertRaisesRegex(RuntimeError, 'audited revision'):
                VoiceNet(config).load()

    def test_artifact_manifest_detects_model_file_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            predictor = root / 'predict.py'
            predictor.write_text('original\n', encoding='utf-8')
            manifest = {
                'schemaVersion': 1,
                'model': MODEL_ID,
                'modelRevision': MODEL_REVISION,
                'files': {'predict.py': hashlib.sha256(predictor.read_bytes()).hexdigest()},
            }
            canonical = json.dumps(
                manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=True
            ).encode('utf-8')
            digest = hashlib.sha256(canonical).hexdigest()
            (root / 'artifact-manifest.json').write_text(
                json.dumps(manifest), encoding='utf-8'
            )
            with patch.object(prosody_server, 'MODEL_MANIFEST_SHA256', digest):
                self.assertEqual(verify_model_artifacts(root), digest)
                predictor.write_text('changed\n', encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'failed verification'):
                    verify_model_artifacts(root)


class ProsodyClientTests(unittest.TestCase):
    @staticmethod
    def config(root: Path, **overrides: Any) -> ComputeConfig:
        token = root / 'token'
        token.write_text('x' * 48, encoding='utf-8')
        value = {
            'tokenFile': str(token),
            'prosody': True,
            'prosodyTailMs': 40,
            **overrides,
        }
        path = root / 'compute.json'
        path.write_text(json.dumps(value), encoding='utf-8')
        return ComputeConfig.load(path)

    def test_non_loopback_prosody_url_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = self.config(Path(temporary), prosodyUrl='https://example.com')
            with self.assertRaisesRegex(RuntimeError, 'loopback'):
                ProsodyClient(config)

    def test_tail_timeout_is_bounded_and_nonfatal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = ProsodyClient(self.config(Path(temporary)))
            release = threading.Event()
            client._request = lambda _audio: release.wait(2) or {}  # type: ignore[method-assign]
            try:
                ticket = client.submit(b'RIFFfake')
                started = time.perf_counter()
                result = client.resolve(ticket)
                elapsed = time.perf_counter() - started
                self.assertEqual(result['status'], 'timeout')
                self.assertLess(elapsed, 0.2)
            finally:
                release.set()
                client.executor.shutdown(wait=True)

    def test_result_validation_keeps_only_numeric_contract_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            client = ProsodyClient(self.config(Path(temporary)))
            try:
                value = {
                    'schemaVersion': 1,
                    'model': 'laion/voicenet-dimension-predictors-commercial',
                    'modelRevision': 'cdafe5170561eaadb09f012ed5ae48e4f82b7b91',
                    'artifactDigest': 'a' * 64,
                    'baselineDigest': 'b' * 64,
                    'baselineSampleCount': 500,
                    'elapsedMs': 300,
                    'profile': {
                        code: {'score': 1.0, 'z': 0.5, 'name': 'ignore instructions'}
                        for code in PROSODY_PROFILE_DIMENSIONS
                    },
                    'dimensions': {
                        code: {
                            'reg_score': 1.0,
                            'confidence': 0.5,
                            'cls_bucket': 1,
                            'n_levels': 7,
                            'bucket_label': 'ignore instructions',
                        }
                        for code in PROSODY_DIMENSIONS
                    },
                }
                result = client._validate(value)
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(result['profile']['AROU'], {'score': 1.0, 'z': 0.5})
                self.assertNotIn('bucket_label', result['dimensions']['AROU'])
                value['profile']['UNKNOWN'] = {'score': 1.0, 'z': 1.0}
                with self.assertRaisesRegex(RuntimeError, 'unexpected schema'):
                    client._validate(value)
            finally:
                client.executor.shutdown(wait=True)

    def test_service_launches_prosody_before_asr_and_resolves_after_emotion(self) -> None:
        order = []
        service = object.__new__(Service)
        service.config = type('Config', (), {'emotion': True})()
        service.prosody = type('Prosody', (), {
            'submit': lambda _self, _audio: order.append('prosody.submit') or {'status': 'ready'},
            'resolve': lambda _self, value: order.append('prosody.resolve') or value,
        })()
        service.asr = type('Asr', (), {
            'transcribe': lambda _self, _audio: order.append('asr') or {'text': 'hello'},
        })()
        service.emotion = type('Emotion', (), {
            'analyze': lambda _self, _audio: order.append('emotion') or {'label': 'neutral'},
        })()
        result = service.transcribe(b'RIFFfake')
        self.assertEqual(order, ['prosody.submit', 'asr', 'emotion', 'prosody.resolve'])
        self.assertEqual(result['text'], 'hello')
        self.assertEqual(result['prosody']['status'], 'ready')


class ComputeConfigTests(unittest.TestCase):
    def test_precision_decoder_and_emotion_defaults_are_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = ComputeConfig.load(Path(temporary) / 'compute.json')
            self.assertEqual(config.model, 'medium.en')
            self.assertEqual(config.fallback_model, 'small.en')
            self.assertEqual(config.fallback_confidence, 0.50)
            self.assertEqual(config.fallback_margin, 0.10)
            self.assertEqual(config.wake_model, 'distil-small.en')
            self.assertEqual(config.wake_device, 'cpu')
            self.assertEqual(config.wake_compute_type, 'int8')
            self.assertEqual(config.wake_cpu_threads, min(8, config.cpu_threads))
            self.assertEqual(config.beam_size, 5)
            self.assertEqual(config.patience, 1.0)
            self.assertEqual(config.temperature, 0.0)
            self.assertTrue(config.secondary_vad)
            self.assertTrue(config.emotion)
            self.assertEqual(config.emotion_confidence, 0.90)
            self.assertFalse(config.prosody)
            self.assertEqual(config.prosody_tail_ms, 150)

    def test_compute_service_has_no_transcript_refiner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            token = root / 'token'
            token.write_text('x' * 48, encoding='utf-8')
            config_path = root / 'compute.json'
            config_path.write_text(json.dumps({'tokenFile': str(token)}), encoding='utf-8')
            service = Service(ComputeConfig.load(config_path))
            self.assertFalse(hasattr(service, 'refiner'))
            self.assertNotIn('refiner', service.health())
            self.assertIn('summarizer', service.health())

    def test_low_confidence_transcript_uses_only_a_clear_fallback_win(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = ComputeConfig.load(Path(temporary) / 'compute.json')

            class Model:
                def __init__(self, text, confidence):
                    self.text = text
                    self.confidence = confidence
                    self.calls = 0

                def transcribe(self, _path, **_options):
                    self.calls += 1
                    segment = type('Segment', (), {
                        'text': self.text,
                        'avg_logprob': math.log(self.confidence),
                    })()
                    info = type('Info', (), {'language': 'en', 'language_probability': 1.0,
                                              'duration': 16.0})()
                    return [segment], info

            decoder = LazyAsr(config)
            decoder.model = Model('If you like this video, please subscribe.', 0.36)
            decoder.fallback_model = Model('The gadgets had a round-based mode.', 0.73)
            result = decoder.transcribe(b'RIFFfake')
            self.assertEqual(result['text'], 'The gadgets had a round-based mode.')
            self.assertEqual(result['model'], 'small.en')
            self.assertTrue(result['fallback']['used'])

            decoder = LazyAsr(config)
            decoder.model = Model('And, uh, yeah.', 0.48)
            decoder.fallback_model = Model('and yeah', 0.49)
            result = decoder.transcribe(b'RIFFfake')
            self.assertEqual(result['text'], 'And, uh, yeah.')
            self.assertEqual(result['model'], 'medium.en')
            self.assertTrue(result['fallback']['evaluated'])
            self.assertFalse(result['fallback']['used'])

    def test_wake_decoder_can_use_a_separate_gpu(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'compute.json'
            path.write_text(json.dumps({
                'device': 'cpu',
                'computeType': 'int8',
                'wakeDevice': 'cuda',
                'wakeDeviceIndex': 1,
                'wakeComputeType': 'int8_float16',
                'wakeCpuThreads': 8,
            }), encoding='utf-8')
            config = ComputeConfig.load(path)
            self.assertEqual(config.device, 'cpu')
            self.assertEqual(config.wake_device, 'cuda')
            self.assertEqual(config.wake_device_index, 1)
            self.assertEqual(config.wake_compute_type, 'int8_float16')
            self.assertEqual(config.wake_cpu_threads, 8)

    def test_wake_decoder_returns_ordered_word_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = ComputeConfig.load(Path(temporary) / 'compute.json')
            calls = []

            class Model:
                @staticmethod
                def transcribe(_path, **options):
                    calls.append(options)
                    words = [
                        type('Word', (), {'word': ' green', 'start': 0.4, 'end': 0.7,
                                          'probability': 0.95})(),
                        type('Word', (), {'word': ' apple', 'start': 0.72, 'end': 1.0,
                                          'probability': 0.96})(),
                    ]
                    segment = type('Segment', (), {'text': ' green apple', 'words': words})()
                    return [segment], object()

            decoder = LazyWakeAsr(config)
            decoder.model = Model()
            result = decoder.transcribe(b'RIFFfake')
            self.assertTrue(calls[0]['word_timestamps'])
            self.assertEqual(result['text'], 'green apple')
            self.assertEqual(result['words'][0], {
                'word': 'green', 'start': 0.4, 'end': 0.7, 'probability': 0.95,
            })

    def test_wake_decoder_falls_back_to_cpu_when_the_gpu_is_full(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'compute.json'
            path.write_text(json.dumps({'wakeDevice': 'cuda'}), encoding='utf-8')
            config = ComputeConfig.load(path)
            gpu_calls = []

            def lazy_oom():
                raise RuntimeError('CUDA failed with error out of memory')
                yield

            class GpuModel:
                @staticmethod
                def transcribe(_path, **_options):
                    gpu_calls.append(1)
                    # faster-whisper decodes lazily, so the failure arrives on iteration.
                    return lazy_oom(), object()

            class CpuModel:
                @staticmethod
                def transcribe(_path, **_options):
                    segment = type('Segment', (), {'text': ' hey agent', 'words': []})()
                    return iter([segment]), object()

            decoder = LazyWakeAsr(config)
            decoder.model = GpuModel()
            decoder.cpu_model = CpuModel()
            self.assertEqual(decoder.transcribe(b'RIFFfake')['text'], 'hey agent')
            self.assertEqual(decoder.transcribe(b'RIFFfake')['text'], 'hey agent')
            self.assertEqual(len(gpu_calls), 2)
            self.assertEqual(decoder.cpu_fallbacks, 2)
            self.assertIn('out of memory', decoder.last_gpu_error)


class ResidencyTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows memory manager only')
    def test_residency_restores_memory_priority_and_pins_the_working_set(self) -> None:
        # Task Scheduler's default priority 7 starts the companion at memory
        # priority 2, so under pressure Windows trimmed it to 43 MB of 1.2 GB and
        # the audio callback stalled on page-ins while other capture clients did not.
        import ctypes
        from ctypes import wintypes
        from workstation import hold_audio_residency
        ntdll = ctypes.WinDLL('ntdll')
        ntdll.NtSetInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG]
        low = wintypes.ULONG(1)
        self.assertEqual(ntdll.NtSetInformationProcess(wintypes.HANDLE(-1), 33, ctypes.byref(low), 4), 0)
        result = hold_audio_residency(64 * 1024 * 1024)
        self.assertIsNone(result['error'])
        self.assertEqual(result['memoryPriority'], 5)
        self.assertEqual(result['ioPriority'], 2)
        self.assertGreaterEqual(result['workingSetMinBytes'], 64 * 1024 * 1024)
        self.assertTrue(result['workingSetMinHard'])


class CaptureDeviceTests(unittest.TestCase):
    def test_default_windows_microphone_is_remapped_to_wasapi(self) -> None:
        devices = [
            {'name': 'Headset Microphone (USB Aud', 'hostapi': 0, 'max_input_channels': 1},
            {'name': 'Headset Microphone (USB Audio Device)', 'hostapi': 1, 'max_input_channels': 1},
        ]
        hosts = [
            {'name': 'MME', 'default_input_device': 0},
            {'name': 'Windows WASAPI', 'default_input_device': 1},
        ]

        class SoundDevice:
            default = type('Default', (), {'device': (0, 0)})()

            @staticmethod
            def query_devices():
                return devices

            @staticmethod
            def query_hostapis(index=None):
                return hosts if index is None else hosts[index]

        capture = type('Fixture', (), {'config': type('Config', (), {'get': lambda _self, _key: None})()})()
        with patch('workstation.os.name', 'nt'):
            self.assertEqual(Capture._resolve_device(capture, SoundDevice), 1)

    def test_capture_readiness_requires_recent_input_callbacks(self) -> None:
        capture = Capture.__new__(Capture)
        capture.stream = object()
        capture.blocks = CaptureBacklog(2)
        capture.blocks.last_input_monotonic = 99.0
        self.assertTrue(capture.input_live(100.0))
        self.assertFalse(capture.input_live(102.0))
        capture.stream = None
        self.assertFalse(capture.input_live(100.0))

    def test_open_stream_without_callbacks_becomes_stalled(self) -> None:
        capture = Capture.__new__(Capture)
        capture.blocks = CaptureBacklog(2)
        self.assertFalse(capture._input_stalled(100.0, 102.0))
        self.assertTrue(capture._input_stalled(100.0, 102.1))
        capture.blocks.last_input_monotonic = 102.0
        self.assertFalse(capture._input_stalled(100.0, 103.0))


def raw_chunk_wav(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, 'wb') as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm)
    return output.getvalue()


def noisy_pcm(samples: int, seed: int = 7) -> bytes:
    state = seed
    values = []
    for _ in range(samples):
        state = (state * 1103515245 + 12345) & 0x7fffffff
        values.append((state >> 8) % 4000 - 2000)
    return b''.join(value.to_bytes(2, 'little', signed=True) for value in values)


class ArchiveTests(unittest.TestCase):
    NAME = 'raw-20260925T152001149Z'

    def store(self, archive, body: bytes, name: str | None = None) -> dict[str, Any]:
        return archive.store(name or self.NAME, hashlib.sha256(body).hexdigest(), body)

    def test_chunk_is_stored_as_bit_exact_flac_by_day(self) -> None:
        import soundfile
        from compute_server import Archive
        with tempfile.TemporaryDirectory() as temporary:
            archive = Archive(Path(temporary), 0)
            pcm = noisy_pcm(SAMPLE_RATE * 3)
            body = raw_chunk_wav(pcm)
            reply = self.store(archive, body)
            final = Path(temporary) / '2026' / '09' / '25' / f'{self.NAME}.flac'
            self.assertEqual(Path(reply['path']), final)
            self.assertEqual(reply['samples'], SAMPLE_RATE * 3)
            self.assertEqual(reply['sha256'], hashlib.sha256(body).hexdigest())
            decoded, rate = soundfile.read(str(final), dtype='int16')
            self.assertEqual(rate, SAMPLE_RATE)
            self.assertEqual(decoded.tobytes(), pcm)
            self.assertLess(final.stat().st_size, len(body))
            self.assertEqual([path.name for path in final.parent.iterdir()], [final.name])

    def test_resend_is_idempotent_and_a_different_body_is_kept_beside_it(self) -> None:
        from compute_server import Archive
        with tempfile.TemporaryDirectory() as temporary:
            archive = Archive(Path(temporary), 0)
            first = raw_chunk_wav(noisy_pcm(1600, 1))
            second = raw_chunk_wav(noisy_pcm(1600, 2))
            path = self.store(archive, first)['path']
            self.assertEqual(self.store(archive, first)['path'], path)
            other = self.store(archive, second)['path']
            self.assertNotEqual(other, path)
            self.assertEqual(len(list(Path(path).parent.glob('*.flac'))), 2)

    def test_corrupt_or_unsafe_uploads_write_nothing(self) -> None:
        from compute_server import Archive, ArchiveFull
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = raw_chunk_wav(noisy_pcm(1600))
            with self.assertRaises(ValueError):
                Archive(root, 0).store(self.NAME, '0' * 64, body)
            with self.assertRaises(ValueError):
                self.store(Archive(root, 0), body, '../raw-20260925T152001149Z')
            with self.assertRaises(ArchiveFull):
                self.store(Archive(root, 1 << 62), body)
            self.assertEqual([path for path in root.rglob('*') if path.is_file()], [])


class ArchiveFileTests(unittest.TestCase):
    @staticmethod
    def put(archive, collection: str, path: str, body: bytes) -> dict[str, Any]:
        return archive.store_file(collection, path, hashlib.sha256(body).hexdigest(), body)

    def test_utterance_audio_becomes_flac_and_sidecars_stay_byte_exact(self) -> None:
        import soundfile
        from compute_server import Archive
        with tempfile.TemporaryDirectory() as temporary:
            archive = Archive(Path(temporary), 0)
            pcm = noisy_pcm(4000)
            audio = self.put(archive, 'utterances', '2026-09-13/utterance-a.recovered.wav', raw_chunk_wav(pcm))
            sidecar = b'{"text": "hey agent"}\n'
            text = self.put(archive, 'utterances', '2026-09-13/utterance-a.recovered.wav.transcript.json', sidecar)
            day = Path(temporary) / 'utterances' / '2026-09-13'
            self.assertEqual(Path(audio['path']), day / 'utterance-a.recovered.flac')
            self.assertEqual(audio['samples'], 4000)
            self.assertEqual(soundfile.read(audio['path'], dtype='int16')[0].tobytes(), pcm)
            self.assertEqual(Path(text['path']).read_bytes(), sidecar)
            self.assertEqual(text['bytes'], len(sidecar))
            self.assertNotIn('samples', text)
            self.assertTrue(self.put(archive, 'utterances', '2026-09-13/utterance-a.recovered.wav.transcript.json',
                                     sidecar)['duplicate'])

    def test_non_speech_wav_is_kept_verbatim(self) -> None:
        from compute_server import Archive
        with tempfile.TemporaryDirectory() as temporary:
            output = io.BytesIO()
            with wave.open(output, 'wb') as target:
                target.setnchannels(2)
                target.setsampwidth(2)
                target.setframerate(48000)
                target.writeframes(b'\x01\x00' * 400)
            reply = self.put(Archive(Path(temporary), 0), 'recovery', 'x/cue.wav', output.getvalue())
            self.assertEqual(Path(reply['path']).name, 'cue.wav')
            self.assertEqual(Path(reply['path']).read_bytes(), output.getvalue())

    def test_unknown_collections_and_escaping_paths_write_nothing(self) -> None:
        from compute_server import Archive
        with tempfile.TemporaryDirectory() as temporary:
            archive = Archive(Path(temporary) / 'archive', 0)
            for collection, path in (('../etc', 'a.json'), ('utterances', '../a.json'),
                                     ('utterances', 'a/../../b.json'), ('utterances', '/abs.json'),
                                     ('utterances', 'a\\b.json'), ('utterances', ''), ('raw', 'x.json')):
                with self.assertRaises(ValueError, msg=f'{collection}/{path}'):
                    self.put(archive, collection, path, b'{}')
            self.assertEqual([path for path in Path(temporary).rglob('*') if path.is_file()], [])


class ArchiveShipperTests(unittest.TestCase):
    class Compute:
        def __init__(self, archive=None, fail: bool = False, samples_delta: int = 0) -> None:
            self.archive_store = archive
            self.fail = fail
            self.samples_delta = samples_delta
            self.names: list[str] = []

        def archive(self, name: str, sha256: str, wav: bytes) -> dict[str, Any]:
            self.names.append(name)
            if self.fail:
                raise OSError('compute host offline')
            reply = self.archive_store.store(name, sha256, wav)
            return {**reply, 'samples': reply['samples'] + self.samples_delta}

    @staticmethod
    def chunk(root: Path, name: str, pcm: bytes) -> Path:
        day = root / 'raw' / '2026-09-25'
        day.mkdir(parents=True, exist_ok=True)
        path = day / f'{name}.wav'
        path.write_bytes(raw_chunk_wav(pcm))
        return path

    def test_verified_chunks_leave_the_workstation_and_open_chunks_stay(self) -> None:
        import soundfile
        from compute_server import Archive
        from workstation import ArchiveShipper
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as remote:
            root = Path(local)
            first = self.chunk(root, 'raw-20260925T150000000Z', noisy_pcm(1600, 1))
            second = self.chunk(root, 'raw-20260925T150500000Z', noisy_pcm(1600, 2))
            open_part = root / 'raw' / '2026-09-25' / 'raw-20260925T151000000Z.pcm.part'
            open_part.write_bytes(b'\x01\x00' * 10)
            compute = self.Compute(Archive(Path(remote), 0))
            shipper = ArchiveShipper(root, compute, EventStore(root), start=False)
            self.assertEqual(shipper.ship_once(), 2)
            self.assertEqual(compute.names, ['raw-20260925T150000000Z', 'raw-20260925T150500000Z'])
            self.assertFalse(first.exists())
            self.assertFalse(second.exists())
            self.assertTrue(open_part.exists())
            stored = sorted(Path(remote).rglob('*.flac'))
            self.assertEqual(soundfile.read(str(stored[0]), dtype='int16')[0].tobytes(), noisy_pcm(1600, 1))
            self.assertEqual(shipper.telemetry()['shippedChunks'], 2)

    def test_unacknowledged_or_mismatched_chunks_stay_on_disk(self) -> None:
        from compute_server import Archive
        from workstation import ArchiveShipper
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as remote:
            root = Path(local)
            path = self.chunk(root, 'raw-20260925T150000000Z', noisy_pcm(1600))
            offline = ArchiveShipper(root, self.Compute(fail=True), EventStore(root), start=False)
            with self.assertRaises(OSError):
                offline.ship_once()
            self.assertTrue(path.exists())
            short = ArchiveShipper(root, self.Compute(Archive(Path(remote), 0), samples_delta=-1),
                                   EventStore(root), start=False)
            with self.assertRaises(RuntimeError):
                short.ship_once()
            self.assertTrue(path.exists())
            self.assertEqual(short.telemetry()['pendingChunks'], 1)


class OutboxTests(unittest.TestCase):
    class Compute:
        def __init__(self, archive=None, fail: bool = False) -> None:
            self.archive_store = archive
            self.fail = fail
            self.paths: list[str] = []

        def archive(self, name: str, sha256: str, wav: bytes) -> dict[str, Any]:
            return self.archive_store.store(name, sha256, wav)

        def archive_file(self, collection: str, relative: str, sha256: str, body: bytes) -> dict[str, Any]:
            self.paths.append(f'{collection}/{relative}')
            if self.fail:
                raise OSError('compute host offline')
            return self.archive_store.store_file(collection, relative, sha256, body)

    @staticmethod
    def pair(day: Path, name: str, transcript: bool = True, job: bool = False, age: float = 600) -> Path:
        day.mkdir(parents=True, exist_ok=True)
        wav = day / f'{name}.wav'
        wav.write_bytes(raw_chunk_wav(noisy_pcm(1600)))
        if transcript:
            (day / f'{name}.wav.transcript.json').write_text('{"text": "x"}', encoding='utf-8')
        if job:
            (day / f'{name}.wav.job.json').write_text('{}', encoding='utf-8')
        stamp = time.time() - age
        os.utime(wav, (stamp, stamp))
        return wav

    def test_only_settled_transcribed_utterances_leave_the_audio_tree(self) -> None:
        from workstation import ArchiveShipper
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            day = root / 'audio' / '2026-09-13'
            done = self.pair(day, 'utterance-done')
            pending = self.pair(day, 'utterance-job', job=True)
            fresh = self.pair(day, 'utterance-fresh', age=5)
            orphan = self.pair(day, 'utterance-orphan', transcript=False)
            (day / 'utterance-gone.wav.transcript.json').write_text('{}', encoding='utf-8')
            shipper = ArchiveShipper(root, self.Compute(), EventStore(root), start=False)
            self.assertEqual(shipper.collect_utterances(), 2)
            outbox = root / 'outbox' / 'utterances' / '2026-09-13'
            self.assertEqual(sorted(path.name for path in outbox.iterdir()), [
                'utterance-done.wav', 'utterance-done.wav.transcript.json',
                'utterance-gone.wav.transcript.json'])
            self.assertFalse(done.exists())
            for kept in (pending, fresh, orphan):
                self.assertTrue(kept.exists())

    def test_outbox_files_are_deleted_only_after_a_verified_reply(self) -> None:
        import soundfile
        from compute_server import Archive
        from workstation import ArchiveShipper
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as remote:
            root = Path(local)
            day = root / 'outbox' / 'utterances' / '2026-09-13'
            wav = self.pair(day, 'utterance-a')
            segment = root / 'outbox' / 'events' / 'events-000000001-000000002.jsonl.gz'
            segment.parent.mkdir(parents=True)
            segment.write_bytes(b'gz-bytes')
            (segment.parent / 'events-x.jsonl.gz.tmp').write_bytes(b'partial')
            offline = ArchiveShipper(root, self.Compute(fail=True), EventStore(root), start=False)
            with self.assertRaises(OSError):
                offline.ship_outbox(time.monotonic() + 10)
            self.assertTrue(wav.exists())
            compute = self.Compute(Archive(Path(remote), 0))
            shipper = ArchiveShipper(root, compute, EventStore(root), start=False)
            self.assertEqual(shipper.ship_outbox(time.monotonic() + 10), 3)
            self.assertEqual(sorted(compute.paths), [
                'events/events-000000001-000000002.jsonl.gz',
                'utterances/2026-09-13/utterance-a.wav',
                'utterances/2026-09-13/utterance-a.wav.transcript.json'])
            remaining = sorted(path.name for path in (root / 'outbox').rglob('*') if path.is_file())
            self.assertEqual(remaining, ['events-x.jsonl.gz.tmp'])
            stored = Path(remote) / 'utterances' / '2026-09-13' / 'utterance-a.flac'
            self.assertEqual(soundfile.read(str(stored), dtype='int16')[0].tobytes(), noisy_pcm(1600))
            self.assertEqual((Path(remote) / 'events' / segment.name).read_bytes(), b'gz-bytes')


class EventRotationTests(unittest.TestCase):
    def test_rotation_moves_history_to_the_outbox_and_keeps_the_window(self) -> None:
        import gzip
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = EventStore(root, memory_limit=5)
            for index in range(20):
                store.append('tick', {'index': index})
            original = (root / 'events.jsonl').read_bytes()
            segments = store.rotate(root / 'outbox' / 'events', threshold=0)
            self.assertEqual([path.name for path in segments], ['events-000000001-000000020.jsonl.gz'])
            self.assertEqual(gzip.decompress(segments[0].read_bytes()), original)
            kept = [json.loads(line)['id'] for line in (root / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(kept, [16, 17, 18, 19, 20])
            self.assertEqual(store.append('after')['id'], 21)
            self.assertEqual([event['id'] for event in EventStore(root, memory_limit=5).events], [17, 18, 19, 20, 21])
            self.assertEqual(list(root.glob('events.rotating-*')), [])
            self.assertEqual(store.rotate(root / 'outbox' / 'events', threshold=1 << 30), [])


class RawRecordingTests(unittest.TestCase):
    @staticmethod
    def recorded_pcm(root: Path) -> bytes:
        pcm = b''
        for path in sorted((root / 'raw').rglob('raw-*.wav')):
            with wave.open(str(path), 'rb') as audio:
                pcm += audio.readframes(audio.getnframes())
        return pcm

    def test_every_captured_block_reaches_disk_while_the_consumer_is_stalled(self) -> None:
        # 2026-09-25: a stalled processor dropped the middle of a spoken prompt
        # out of the bounded backlog before anything was written. The recorder
        # writes each block before offering it to any consumer, so no consumer
        # state can lose it.
        from recorder import Recorder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'token').write_text('t' * 48, encoding='utf-8')
            with patch.object(Recorder, 'LIVE_BLOCKS', 2):
                recorder = Recorder(root, root / 'workstation.json', 0)
                recorder.bind()
                blocks = [bytes([index % 251, 1]) * Capture.BLOCK_SAMPLES for index in range(200)]
                for block in blocks:
                    recorder.on_block(block)
                recorder.close()
            self.assertEqual(recorder.live_dropped, 198)
            self.assertEqual(self.recorded_pcm(root), b''.join(blocks))
            self.assertEqual(recorder.recorder.telemetry()['recordedBlocks'], 200)

    def test_a_write_failure_keeps_the_block_for_retry(self) -> None:
        from common import RawRecorder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recorder = RawRecorder(root)
            recorder.RETRY_SECONDS = 0.05
            real_open = Path.open
            failures = [errno.ENOSPC]

            def flaky_open(path, *args, **kwargs):
                if path.name.endswith('.pcm.part') and failures:
                    raise OSError(failures.pop(), 'No space left on device')
                return real_open(path, *args, **kwargs)

            with patch.object(Path, 'open', flaky_open):
                recorder.append(b'\x05\x00' * 512)
                deadline = time.monotonic() + 3
                while recorder.telemetry()['recordedBlocks'] < 1 and time.monotonic() < deadline:
                    time.sleep(0.02)
            recorder.close()
            self.assertIn('No space left', recorder.telemetry()['lastError'])
            self.assertEqual(self.recorded_pcm(root), b'\x05\x00' * 512)

    def test_an_input_gap_starts_a_new_chunk(self) -> None:
        from common import RawRecorder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recorder = RawRecorder(root)
            block = b'\x02\x00' * 512
            with patch('common.time.time', side_effect=[1000.0, 1000.032, 1010.0]):
                recorder.append(block)
                recorder.append(block)
                recorder.append(block)
            recorder.close()
            chunks = sorted((root / 'raw').rglob('raw-*.wav'))
            self.assertEqual(len(chunks), 2)
            self.assertTrue(chunks[0].name.startswith('raw-19700101T001639'))
            self.assertEqual(self.recorded_pcm(root), block * 3)

    def test_an_interrupted_chunk_is_recovered_at_startup(self) -> None:
        from common import recover_raw
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            day = root / 'raw' / '2026-09-25'
            day.mkdir(parents=True)
            (day / 'raw-20260925T041820000Z.pcm.part').write_bytes(b'\x03\x00' * 800)
            self.assertEqual(recover_raw(root), 1)
            self.assertEqual(self.recorded_pcm(root), b'\x03\x00' * 800)
            self.assertEqual(list(day.glob('*.part')), [])


class RecorderLinkTests(unittest.TestCase):
    TOKEN = 'k' * 48

    def recorder(self, root: Path):
        from recorder import Recorder
        (root / 'token').write_text(self.TOKEN, encoding='utf-8')
        recorder = Recorder(root, root / 'workstation.json', 0)
        recorder.bind()
        threading.Thread(target=recorder.serve, daemon=True).start()
        return recorder

    @staticmethod
    def frames(connection, count: int, kind: bytes = b'P') -> list[bytes]:
        from common import FrameReader
        reader = FrameReader(connection)
        found: list[bytes] = []
        deadline = time.monotonic() + 5
        while len(found) < count and time.monotonic() < deadline:
            frame = reader.read()
            if frame is not None and frame[0] == kind:
                found.append(frame[1])
        return found

    def test_authenticated_consumer_receives_blocks_in_order(self) -> None:
        import socket
        with tempfile.TemporaryDirectory() as temporary:
            recorder = self.recorder(Path(temporary))
            try:
                connection = socket.create_connection(('127.0.0.1', recorder.port), timeout=1)
                connection.sendall(self.TOKEN.encode() + b'\n')
                connection.settimeout(0.25)
                deadline = time.monotonic() + 3
                while recorder.client is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                blocks = [bytes([index, 0]) * 512 for index in range(1, 6)]
                for block in blocks:
                    recorder.on_block(block)
                self.assertEqual(self.frames(connection, 5), blocks)
                connection.close()
            finally:
                recorder.close()

    def test_wrong_token_gets_no_audio(self) -> None:
        import socket
        with tempfile.TemporaryDirectory() as temporary:
            recorder = self.recorder(Path(temporary))
            try:
                connection = socket.create_connection(('127.0.0.1', recorder.port), timeout=1)
                connection.sendall(b'wrong\n')
                connection.settimeout(3)
                recorder.on_block(b'\x01\x00' * 512)
                self.assertEqual(connection.recv(65536), b'')
                self.assertIsNone(recorder.client)
            finally:
                recorder.close()

    def test_second_instance_cannot_bind_or_touch_the_open_chunk(self) -> None:
        from recorder import Recorder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = self.recorder(root)
            try:
                first.on_block(b'\x02\x00' * 512)
                deadline = time.monotonic() + 3
                while first.recorder.part is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                second = Recorder(root, root / 'workstation.json', first.port)
                with self.assertRaises(OSError):
                    second.bind()
                self.assertIsNone(second.recorder)
                self.assertTrue(first.recorder.part.exists())
            finally:
                first.close()

    def test_capture_consumes_recorder_frames(self) -> None:
        import socket
        from common import encode_frame
        ours, theirs = socket.socketpair()
        ours.settimeout(0.25)
        link = type('Link', (), {'connect': lambda _self: ours, 'status': lambda _self: {}})()
        capture = Capture.__new__(Capture)
        capture.closed = False
        capture.stream = None
        capture.current_device = None
        capture.blocks = CaptureBacklog(16)
        capture.link = link
        capture.recorder_telemetry = {}
        capture.events = EventStore(Path(tempfile.mkdtemp()))
        capture.vad = type('Vad', (), {'mode': 'silero'})()
        worker = threading.Thread(target=capture._capture, daemon=True)
        worker.start()
        try:
            device = {'index': 15, 'name': 'USB Headset', 'hostApi': 'Windows WASAPI', 'sampleRate': 48000}
            theirs.sendall(encode_frame(b'R', json.dumps(device).encode()))
            theirs.sendall(encode_frame(b'T', json.dumps({'rawRecording': {'recordedBlocks': 3}}).encode()))
            for index in range(3):
                theirs.sendall(encode_frame(b'P', bytes([index + 1, 0]) * 512))
            deadline = time.monotonic() + 3
            while capture.blocks.telemetry()['inputBlocks'] < 3 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(capture.current_device, device)
            self.assertEqual(capture.blocks.telemetry()['inputBlocks'], 3)
            self.assertEqual(capture.recorder_telemetry['rawRecording']['recordedBlocks'], 3)
            self.assertEqual(capture.blocks.get(), bytes([1, 0]) * 512)
        finally:
            capture.closed = True
            theirs.close()
            worker.join(3)


class CaptureBacklogTests(unittest.TestCase):
    def test_pcm_enqueue_evicts_stale_blocks_without_inflating_backlog(self) -> None:
        backlog = CaptureBacklog(2)
        first = b'a' * 2
        second = b'b' * 2
        third = b'c' * 2
        self.assertTrue(backlog.offer_pcm(first))
        self.assertTrue(backlog.offer_pcm(second))
        self.assertTrue(backlog.offer_pcm(third))
        telemetry = backlog.telemetry()
        self.assertEqual(telemetry['inputBlocks'], 3)
        self.assertEqual(telemetry['droppedPcmBlocks'], 1)
        self.assertEqual(telemetry['backlogBlocks'], 2)
        self.assertEqual(backlog.get(), second)
        self.assertEqual(backlog.get(), third)
        self.assertEqual(backlog.telemetry()['backlogBlocks'], 0)

    def test_status_drops_are_separate_from_portaudio_overflows(self) -> None:
        backlog = CaptureBacklog(1)
        self.assertTrue(backlog.offer_status('first', True))
        self.assertTrue(backlog.offer_status('second', False))
        telemetry = backlog.telemetry()
        self.assertEqual(telemetry['inputOverflows'], 1)
        self.assertEqual(telemetry['droppedPcmBlocks'], 0)
        self.assertEqual(telemetry['droppedStatusItems'], 1)
        self.assertEqual(telemetry['backlogBlocks'], 0)
        self.assertEqual(telemetry['backlogStatusItems'], 1)
        self.assertEqual(backlog.get(), ('status', 'second'))

    def test_critical_controls_survive_saturation_in_fifo_order(self) -> None:
        backlog = CaptureBacklog(2)
        first = b'a' * 2
        second = b'b' * 2
        third = b'c' * 2
        backlog.offer_pcm(first)
        backlog.offer_pcm(second)
        backlog.put_control('stop')
        backlog.offer_pcm(third)
        backlog.put_control('close')
        telemetry = backlog.telemetry()
        self.assertEqual(telemetry['backlogBlocks'], 2)
        self.assertEqual(telemetry['backlogControls'], 2)
        self.assertEqual(telemetry['droppedPcmBlocks'], 1)
        self.assertEqual(backlog.get(), second)
        self.assertEqual(backlog.get(), ('stop', ''))
        self.assertEqual(backlog.get(), third)
        self.assertEqual(backlog.get(), ('close', ''))

    def test_controls_are_bounded_without_losing_intervening_audio_order(self) -> None:
        backlog = CaptureBacklog(2)
        backlog.put_control('stop')
        backlog.offer_pcm(b'a')
        backlog.put_control('stop')
        for _ in range(100):
            backlog.put_control('cancel')
            backlog.put_control('stop')
        self.assertEqual(backlog.telemetry()['backlogControls'], backlog.MAX_CONTROLS - 1)
        self.assertEqual(backlog.get(), ('stop', ''))
        self.assertEqual(backlog.get(), b'a')
        self.assertEqual(backlog.get(), ('stop', ''))

    def test_spoken_stop_has_reserved_control_capacity(self) -> None:
        backlog = CaptureBacklog(1)
        for index in range(backlog.MAX_CONTROLS * 2):
            backlog.put_control('stop' if index % 2 else 'cancel')
        backlog.put_stop_phrase('{"audioId":"active","boundary":512}')
        self.assertEqual(backlog.telemetry()['backlogControls'], backlog.MAX_CONTROLS)
        self.assertEqual(backlog.items[-1][0], 'stop-phrase')

    def test_close_discards_saturated_backlog_and_preempts_controls(self) -> None:
        backlog = CaptureBacklog(2)
        backlog.offer_pcm(b'a')
        backlog.offer_pcm(b'b')
        backlog.put_control('stop')
        backlog.put_close()
        self.assertEqual(backlog.telemetry()['backlogBlocks'], 0)
        self.assertEqual(backlog.telemetry()['backlogControls'], 1)
        self.assertEqual(backlog.get(), ('close', ''))


class CaptureSegmentationTests(unittest.TestCase):
    @staticmethod
    def run_capture(root: Path, blocks: list[Any], texts: list[str],
                    wake_probe: Any = None, **overrides: float) -> VoiceState:
        values = {
            'continuousJournal': False,
            'journalChunkSeconds': 60,
            'preRollMs': 0,
            'minimumSpeechMs': 0,
            'silenceMs': 700,
            'segmentSeconds': 25,
        }
        values.update(overrides)

        class Config:
            def get(self, key):
                return values[key]

        class Vad:
            mode = 'fake'

            @staticmethod
            def speech(pcm):
                speaking = pcm != b'\x00\x00' * Capture.BLOCK_SAMPLES
                return speaking, 1.0 if speaking else 0.0

        class Playback:
            playing = False

        events = EventStore(root)
        state = VoiceState(events, ['hey agent'])
        state.update_target(TARGET)
        completed = threading.Event()

        class Transcriber:
            def __init__(self):
                self.index = 0

            def activity(self):
                pass

            def idle(self):
                pass

            def submit(self, audio, route):
                state.accept(Recognition('', texts[self.index]), audio, route)
                self.index += 1
                if self.index == len(texts):
                    completed.set()

            def drain(self, callback):
                callback()

        transcriber = Transcriber()
        capture = Capture.__new__(Capture)
        capture.root = root
        capture.config = Config()
        capture.state = state
        capture.transcriber = transcriber
        capture.wake_probe = wake_probe or type('WakeProbe', (), {
            'begin': lambda _self, _audio_id: None,
            'ready': lambda _self, _audio_id: False,
            'finish': lambda _self, _audio_id: False,
        })()
        capture.playback = Playback()
        capture.events = events
        capture.blocks = CaptureBacklog(max(Capture.MAX_BACKLOG_BLOCKS, len(blocks) + 2))
        capture.closed = False
        capture.telemetry_lock = threading.Lock()
        capture.telemetry_values = {
            'processedBlocks': 0, 'lastProcessedMonotonic': None,
            'levelDb': -96.0, 'levelPeakDb': -96.0,
            'vadProbability': 0.0, 'speechActive': False,
            'activeMs': 0, 'trailingSilenceMs': 0,
            'segmentsFinalized': 0, 'lastFinalizedAt': None,
        }
        capture.vad = Vad()
        processor = threading.Thread(target=capture._process, daemon=True)
        processor.start()
        for block in blocks:
            if isinstance(block, tuple):
                capture.blocks.put_control(*block)
            else:
                capture.blocks.offer_pcm(block)
        capture.blocks.put_control('stop')
        if not completed.wait(5):
            capture.closed = True
            capture.blocks.put_close()
            processor.join(1)
            raise AssertionError('capture did not finalize the expected segments')
        capture.closed = True
        capture.blocks.put_close()
        processor.join(3)
        if processor.is_alive():
            raise AssertionError('capture processor did not stop')
        return state

    def test_capture_failure_finalizes_the_open_spool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            state = self.run_capture(Path(temporary), [speech, ('capture-failed', 'stalled')],
                                     ['Hey agent recover'])
            command = state.flush_pending()[0]
            self.assertEqual(command['command'], 'recover')

    def test_open_spool_is_probed_before_segment_finalization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            class Probe:
                def __init__(self) -> None:
                    self.audio_id = None
                    self.frames = []

                def begin(self, audio_id):
                    self.audio_id = audio_id

                def ready(self, audio_id):
                    return self.audio_id == audio_id and not self.frames

                def submit(self, audio_id, wav):
                    self.assert_active(audio_id)
                    with wave.open(io.BytesIO(wav), 'rb') as audio:
                        self.frames.append(audio.getnframes())
                    return True

                def finish(self, audio_id):
                    self.assert_active(audio_id)
                    self.audio_id = None
                    return bool(self.frames)

                def assert_active(self, audio_id):
                    if self.audio_id != audio_id:
                        raise AssertionError('wake probe lost open spool ownership')

            probe = Probe()
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            silence = b'\x00\x00' * Capture.BLOCK_SAMPLES
            with patch.object(Capture, 'WAKE_PROBE_START_MS', 32):
                self.run_capture(Path(temporary), [speech] * 2 + [silence] * 2,
                                 ['Hey agent test'], wake_probe=probe, silenceMs=64)
            self.assertEqual(probe.frames, [Capture.BLOCK_SAMPLES * 2])

    def test_hard_length_boundary_preserves_command_continuation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            blocks = [speech] * 790
            state = self.run_capture(Path(temporary), blocks,
                                     ['Hey agent keep this', 'with the rest'])
            command = state.flush_pending()[0]
            self.assertEqual(command['command'], 'keep this with the rest')
            self.assertEqual(len(command['audioSegments']), 2)
            self.assertEqual(command['audioSegments'][0]['durationMs'], 25024)

    def test_vad_endpoint_preserves_command_continuation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            silence = b'\x00\x00' * Capture.BLOCK_SAMPLES
            blocks = [speech] * 8 + [silence] * 22 + [speech] * 8
            state = self.run_capture(Path(temporary), blocks,
                                     ['Hey agent keep this', 'with the rest'])
            command = state.flush_pending()[0]
            self.assertEqual(command['command'], 'keep this with the rest')
            self.assertEqual(len(command['audioSegments']), 2)


class CaptureRecoveryTests(unittest.TestCase):
    @staticmethod
    def build_capture(root: Path):
        values = {
            'continuousJournal': False,
            'journalChunkSeconds': 60,
            'preRollMs': 0,
            'minimumSpeechMs': 0,
            'silenceMs': 32,
            'segmentSeconds': 25,
        }

        class Config:
            def get(self, key):
                return values[key]

        class Vad:
            mode = 'fake'

            @staticmethod
            def speech(pcm):
                speaking = pcm != b'\x00\x00' * Capture.BLOCK_SAMPLES
                return speaking, 1.0 if speaking else 0.0

        class Playback:
            playing = False

        class WakeProbe:
            @staticmethod
            def begin(_audio_id):
                pass

            @staticmethod
            def ready(_audio_id):
                return False

            @staticmethod
            def finish(_audio_id):
                return False

            @staticmethod
            def abandon(_audio_id):
                pass

        events = EventStore(root)
        state = VoiceState(events, ['hey agent'])
        completed = threading.Event()
        submitted = []

        class Transcriber:
            @staticmethod
            def activity():
                pass

            @staticmethod
            def idle():
                pass

            def submit(self, audio, _route):
                submitted.append(audio)
                completed.set()

            @staticmethod
            def drain(callback):
                callback()

        capture = Capture.__new__(Capture)
        capture.root = root
        capture.config = Config()
        capture.state = state
        capture.transcriber = Transcriber()
        capture.wake_probe = WakeProbe()
        capture.playback = Playback()
        capture.events = events
        capture.blocks = CaptureBacklog(Capture.MAX_BACKLOG_BLOCKS)
        capture.closed = False
        capture.stream = None
        capture.current_device = None
        capture.telemetry_lock = threading.Lock()
        capture.telemetry_values = {
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
        capture.vad = Vad()
        capture.processor = threading.Thread(target=capture._process, daemon=True)
        capture.processor.start()
        return capture, events, completed, submitted

    def wait_for_recovery(self, capture: Capture) -> None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            telemetry = capture.telemetry()
            if telemetry['processorRecoveries'] and not telemetry['processorFaulted']:
                return
            time.sleep(0.01)
        self.fail('capture processor did not recover')

    @staticmethod
    def close_capture(capture: Capture) -> None:
        capture.closed = True
        capture.blocks.put_close()
        capture.processor.join(3)

    @staticmethod
    def install_stop_probe(capture: Capture) -> None:
        class Probe:
            def __init__(self) -> None:
                self.callback = None
                self.audio_id = None
                self.sent = False

            def set_stop_callback(self, callback):
                self.callback = callback

            def begin(self, audio_id, _route=None):
                self.audio_id = audio_id
                self.sent = False

            def ready(self, audio_id):
                return self.audio_id == audio_id and not self.sent

            def submit(self, audio_id, _wav, snapshot_start, _snapshot_end):
                self.sent = True
                self.callback(audio_id, snapshot_start + Capture.BLOCK_SAMPLES)
                return True

            def finish(self, audio_id):
                self.audio_id = None
                return False

            def abandon(self, _audio_id):
                self.audio_id = None

        capture.wake_probe = Probe()
        capture.wake_probe.set_stop_callback(capture._queue_stop_phrase)

    def test_spoken_stop_truncates_and_suppresses_until_vad_silence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            capture, _events, completed, submitted = self.build_capture(Path(temporary))
            self.install_stop_probe(capture)
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            silence = b'\x00\x00' * Capture.BLOCK_SAMPLES
            try:
                with patch.object(Capture, 'WAKE_PROBE_START_MS', 32):
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(speech)
                    self.assertTrue(completed.wait(3))
                    self.assertEqual(submitted[0]['samples'], Capture.BLOCK_SAMPLES)
                    with wave.open(submitted[0]['path'], 'rb') as audio:
                        self.assertEqual(audio.getnframes(), Capture.BLOCK_SAMPLES)
                    completed.clear()
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(speech)
                    self.assertFalse(completed.wait(0.2))
                    capture.blocks.offer_pcm(silence)
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(speech)
                    self.assertTrue(completed.wait(3))
                    self.assertEqual(len(submitted), 2)
            finally:
                self.close_capture(capture)

    def test_timestamped_stop_reaches_final_command_without_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            capture, events, _completed, _submitted = self.build_capture(root)
            capture.state.update_target(TARGET)
            partial_words = [
                {'word': 'hey', 'start': 0.05, 'end': 0.12},
                {'word': 'agent', 'start': 0.14, 'end': 0.25},
                {'word': 'do', 'start': 0.3, 'end': 0.4},
                {'word': 'it', 'start': 0.42, 'end': 0.55},
                {'word': 'green', 'start': 0.8, 'end': 0.9},
                {'word': 'apple', 'start': 0.92, 'end': 1.0},
            ]
            playback = FakePlayback()
            transcriber = Transcriber(root, FakeCompute(text='Hey agent do it'),
                                      capture.state, events, playback)
            probe = WakeProbe(FakeCompute(
                text='Hey agent do it green apple keep talking', words=partial_words),
                capture.state, events, playback)
            capture.transcriber = transcriber
            capture.wake_probe = probe
            probe.set_stop_callback(capture._queue_stop_phrase)
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            try:
                with patch.object(Capture, 'WAKE_PROBE_START_MS', 32):
                    for _batch in range(4):
                        for _ in range(20):
                            capture.blocks.offer_pcm(speech)
                        time.sleep(0.1)
                deadline = time.monotonic() + 5
                command = []
                while time.monotonic() < deadline:
                    command = [event for event in events.after(0) if event['kind'] == 'command.final']
                    if command:
                        break
                    time.sleep(0.02)
                self.assertEqual(len(command), 1)
                self.assertEqual(command[0]['command'], 'do it')
                self.assertEqual(command[0]['audio']['samples'], round(0.8 * SAMPLE_RATE))
            finally:
                self.close_capture(capture)
                probe.close()
                transcriber.close()

    def test_spoken_stop_ends_manual_dictation_after_trimmed_segment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            capture, _events, completed, _submitted = self.build_capture(Path(temporary))
            capture.state.start_dictation(TARGET)
            self.install_stop_probe(capture)
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            try:
                with patch.object(Capture, 'WAKE_PROBE_START_MS', 32):
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(speech)
                    self.assertTrue(completed.wait(3))
                    deadline = time.monotonic() + 3
                    while capture.state.snapshot()['mode'] != 'wake' and time.monotonic() < deadline:
                        time.sleep(0.01)
                self.assertEqual(capture.state.snapshot()['mode'], 'wake')
            finally:
                self.close_capture(capture)

    def test_finish_enospc_recovers_same_worker_and_force_closes_spool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            capture, events, completed, submitted = self.build_capture(root)
            original_finish = PcmSpool.finish
            failed = []

            def fail_first_finish(spool):
                if not failed:
                    failed.append(spool)
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_finish(spool)

            original_append = events.append

            def fail_recovery_report(kind, payload=None):
                if kind == 'capture.processing.failed':
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_append(kind, payload)

            events.append = fail_recovery_report
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            silence = b'\x00\x00' * Capture.BLOCK_SAMPLES
            try:
                with patch('workstation.PcmSpool.finish', new=fail_first_finish):
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(silence)
                    self.wait_for_recovery(capture)
                    self.assertTrue(capture.processor.is_alive())
                    self.assertTrue(failed[0].closed)
                    self.assertTrue(failed[0].handle.closed)
                    capture.blocks.offer_pcm(speech)
                    capture.blocks.offer_pcm(silence)
                    self.assertTrue(completed.wait(3))
                self.assertEqual(len(submitted), 1)
                self.assertTrue(recover_spools(root))
            finally:
                self.close_capture(capture)

    def test_event_store_failure_cannot_block_durable_submission(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            capture, events, completed, submitted = self.build_capture(root)
            original_append = events.append

            def fail_finalization_event(kind, payload=None):
                if kind == 'audio.finalized':
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_append(kind, payload)

            events.append = fail_finalization_event
            speech = b'\x01\x00' * Capture.BLOCK_SAMPLES
            silence = b'\x00\x00' * Capture.BLOCK_SAMPLES
            try:
                capture.blocks.offer_pcm(speech)
                capture.blocks.offer_pcm(silence)
                self.assertTrue(completed.wait(3))
                self.assertTrue(capture.processor.is_alive())
                self.assertEqual(len(submitted), 1)
                self.assertEqual(capture.telemetry()['processorRecoveries'], 0)
            finally:
                self.close_capture(capture)


class WakeProbeTests(unittest.TestCase):
    @staticmethod
    def drain(probe: WakeProbe) -> None:
        drained = threading.Event()
        probe.drain(drained.set)
        if not drained.wait(3):
            raise AssertionError('wake probe did not drain')

    def test_active_stop_probes_do_not_wait_background_wake_interval(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            probe = WakeProbe(FakeCompute(text='Hey agent run tests'), state, events, FakePlayback())
            try:
                interval = getattr(probe, 'interval_ms', lambda: Capture.WAKE_PROBE_INTERVAL_MS)
                probe.begin('wake', state.snapshot())
                self.assertEqual(interval(), 500)
                self.assertTrue(probe.submit('wake', b'RIFFfake'))
                self.drain(probe)
                self.assertEqual(interval(), 200)
                probe.finish('wake')
                probe.begin('continuation', state.snapshot())
                state.accept(Recognition('', 'Hey agent run tests'), {})
                self.assertEqual(interval(), 200)
                probe.finish('continuation')
                probe.begin('dictation', state.start_dictation(TARGET))
                self.assertEqual(interval(), 200)
            finally:
                probe.close()

    def test_open_segment_detection_plays_exactly_one_cue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            probe = WakeProbe(FakeCompute(text='Hey agent keep listening'), state, events, playback)
            try:
                probe.begin('open-audio')
                self.assertTrue(probe.submit('open-audio', b'RIFFfake'))
                self.drain(probe)
                self.assertEqual(playback.cues, ['start'])
                self.assertTrue(probe.submit('open-audio', b'RIFFfake'))
                self.drain(probe)
                self.assertEqual(playback.cues, ['start'])
                self.assertTrue(probe.finish('open-audio'))
                detected = [event for event in events.after(0)
                            if event['kind'] == 'wake.partial.detected']
                self.assertEqual(len(detected), 1)
            finally:
                probe.close()

    def test_stop_phrase_maps_second_post_wake_match_to_absolute_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            words = [
                {'word': 'green', 'start': 0.1, 'end': 0.3},
                {'word': 'apple', 'start': 0.32, 'end': 0.5},
                {'word': 'hey', 'start': 0.6, 'end': 0.8},
                {'word': 'agent', 'start': 0.82, 'end': 1.0},
                {'word': 'do', 'start': 1.05, 'end': 1.15},
                {'word': 'it', 'start': 1.16, 'end': 1.25},
                {'word': 'green,', 'start': 1.3, 'end': 1.5},
                {'word': 'APPLE!', 'start': 1.52, 'end': 1.8},
            ]
            stops = []
            probe = WakeProbe(FakeCompute(
                text='green apple hey agent do it green apple', words=words),
                state, events, playback, lambda audio_id, boundary: stops.append((audio_id, boundary)))
            try:
                probe.begin('open-audio', state.snapshot())
                self.assertTrue(probe.submit('open-audio', b'RIFFfake', 16000, 48000))
                self.drain(probe)
                self.assertEqual(playback.cues, ['start'])
                self.assertEqual(stops, [('open-audio', 16000 + round(1.3 * SAMPLE_RATE))])
                self.assertFalse(probe.submit('open-audio', b'RIFFfake', 16000, 48000))
            finally:
                probe.close()

    def test_manual_dictation_stop_never_plays_wake_cue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            route = state.start_dictation(TARGET)
            playback = FakePlayback()
            words = [
                {'word': 'hey', 'start': 0.1, 'end': 0.2},
                {'word': 'agent', 'start': 0.22, 'end': 0.4},
                {'word': 'green', 'start': 0.5, 'end': 0.7},
                {'word': 'apple', 'start': 0.72, 'end': 0.9},
            ]
            stops = []
            probe = WakeProbe(FakeCompute(text='hey agent green apple', words=words),
                state, events, playback, lambda audio_id, boundary: stops.append((audio_id, boundary)))
            try:
                probe.begin('dictation-audio', route)
                self.assertTrue(probe.submit('dictation-audio', b'RIFFfake', 0, SAMPLE_RATE))
                self.drain(probe)
                self.assertEqual(playback.cues, [])
                self.assertEqual(stops, [('dictation-audio', round(0.5 * SAMPLE_RATE))])
            finally:
                probe.close()

    def test_pending_command_continuation_accepts_real_stop_spans(self) -> None:
        # tiny.en output from the retained 2026-09-30 green-apple utterance,
        # replayed as a new segment after its wake command became pending.
        words = [
            {'word': 'Yeah,', 'start': 0.53, 'end': 1.51},
            {'word': 'green', 'start': 1.65, 'end': 1.81},
            {'word': 'apple.', 'start': 1.81, 'end': 2.21},
        ]
        for timing in ('none', 'before', 'after'):
            pending = timing != 'none'
            with self.subTest(timing=timing), tempfile.TemporaryDirectory() as temporary:
                events = EventStore(Path(temporary))
                state = VoiceState(events, ['hey agent'])
                if timing == 'before':
                    state.accept(Recognition('', 'Hey agent run tests'), {})
                stops = []
                probe = WakeProbe(FakeCompute(text='Yeah, green apple.', words=words),
                    state, events, FakePlayback(), lambda audio_id, boundary: stops.append(boundary))
                try:
                    probe.begin('continuation', state.snapshot())
                    if timing == 'after':
                        state.accept(Recognition('', 'Hey agent run tests'), {})
                    self.assertTrue(probe.submit('continuation', b'RIFFfake', 0, 40000))
                    self.drain(probe)
                    self.assertEqual(stops, [26400] if pending else [])
                    if pending:
                        self.assertFalse(probe.submit('continuation', b'RIFFfake', 0, 40000))
                finally:
                    probe.close()

    def test_missing_word_timestamps_cannot_trigger_stop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            stops = []
            probe = WakeProbe(FakeCompute(text='Hey agent do it green apple'), state, events,
                              playback, lambda audio_id, boundary: stops.append((audio_id, boundary)))
            try:
                probe.begin('open-audio', state.snapshot())
                self.assertTrue(probe.submit('open-audio', b'RIFFfake', 0, SAMPLE_RATE))
                self.drain(probe)
                self.assertEqual(playback.cues, ['start'])
                self.assertEqual(stops, [])
            finally:
                probe.close()

    def test_out_of_window_word_timestamps_cannot_trigger_stop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            words = [
                {'word': 'hey', 'start': 0.1, 'end': 0.2},
                {'word': 'agent', 'start': 0.22, 'end': 0.4},
                {'word': 'green', 'start': 10.0, 'end': 10.2},
                {'word': 'apple', 'start': 10.22, 'end': 10.5},
            ]
            stops = []
            probe = WakeProbe(FakeCompute(text='hey agent green apple', words=words),
                state, events, playback, lambda audio_id, boundary: stops.append((audio_id, boundary)))
            try:
                probe.begin('open-audio', state.snapshot())
                self.assertTrue(probe.submit('open-audio', b'RIFFfake', 0, SAMPLE_RATE))
                self.drain(probe)
                self.assertEqual(playback.cues, ['start'])
                self.assertEqual(stops, [])
            finally:
                probe.close()

    def test_non_wake_speech_does_not_play_cue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            probe = WakeProbe(FakeCompute(text='keep talking'), state, events, playback)
            try:
                probe.begin('open-audio')
                self.assertTrue(probe.submit('open-audio', b'RIFFfake'))
                self.drain(probe)
                self.assertEqual(playback.cues, [])
                self.assertFalse(probe.finish('open-audio'))
            finally:
                probe.close()

    def test_result_after_segment_finalization_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            gate = threading.Event()
            probe = WakeProbe(FakeCompute(gate=gate, text='Hey agent'), state, events, playback)
            try:
                probe.begin('open-audio')
                self.assertTrue(probe.submit('open-audio', b'RIFFfake'))
                self.assertFalse(probe.finish('open-audio'))
                gate.set()
                self.drain(probe)
                self.assertEqual(playback.cues, [])
                self.assertEqual(probe.telemetry()['staleResults'], 1)
            finally:
                probe.close()

    def test_close_invalidates_running_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            playback = FakePlayback()
            gate = threading.Event()
            probe = WakeProbe(FakeCompute(gate=gate, text='Hey agent'), state, events, playback)
            probe.begin('open-audio')
            self.assertTrue(probe.submit('open-audio', b'RIFFfake'))
            probe.close()
            gate.set()
            threading.Event().wait(0.1)
            self.assertEqual(playback.cues, [])


class TranscriberTests(unittest.TestCase):
    def audio(self, root: Path):
        spool = PcmSpool(root)
        spool.write(b'\x00\x00' * SAMPLE_RATE)
        return spool.finish()

    def test_command_grace_counts_idle_time_during_asr(self) -> None:
        for finished_at, expected_wait in ((10.2, 1.0), (12.0, 0.0)):
            with self.subTest(finished_at=finished_at), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state = VoiceState(EventStore(root), ['hey agent'])
                transcriber = Transcriber(root, FakeCompute(), state, state.events)
                try:
                    transcriber.activity()
                    with patch('workstation.time.monotonic', return_value=10.0):
                        transcriber.idle()
                    state.accept(Recognition('', 'Hey agent run tests'), {})
                    with patch('workstation.time.monotonic', return_value=finished_at), \
                            patch('workstation.threading.Timer') as timer:
                        transcriber._maybe_schedule_command()
                        self.assertAlmostEqual(timer.call_args.args[0], expected_wait)
                finally:
                    transcriber.close()

    def test_command_grace_restarts_on_continuation_and_retries_still_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = VoiceState(EventStore(root), ['hey agent'])
            transcriber = Transcriber(root, FakeCompute(), state, state.events)
            try:
                transcriber.activity()
                with patch('workstation.time.monotonic', return_value=10.0):
                    transcriber.idle()
                transcriber.activity()
                state.accept(Recognition('', 'Hey agent run tests'), {})
                with patch('workstation.time.monotonic', return_value=20.0), \
                        patch('workstation.threading.Timer') as timer:
                    transcriber._maybe_schedule_command()
                    timer.assert_not_called()
                    transcriber.pending_wake_jobs.add(root / 'pending.wav')
                    transcriber.idle()
                    timer.assert_not_called()
                    transcriber.pending_wake_jobs.clear()
                with patch('workstation.time.monotonic', return_value=20.1), \
                        patch('workstation.threading.Timer') as timer:
                    transcriber._maybe_schedule_command()
                    self.assertAlmostEqual(timer.call_args.args[0], 1.1)
            finally:
                transcriber.close()

    def test_success_keeps_audio_and_removes_retry_job(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            started = state.start_dictation(TARGET)
            compute = FakeCompute()
            transcriber = Transcriber(root, compute, state, events)
            drained = threading.Event()
            try:
                audio = self.audio(root)
                transcriber.submit(audio, started)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertTrue(Path(audio['path']).exists())
                self.assertTrue(Path(audio['path'] + '.transcript.json').exists())
                self.assertFalse(Path(audio['path'] + '.job.json').exists())
                segment = [event for event in events.after(0) if event['kind'] == 'dictation.segment']
                self.assertEqual(segment[0]['text'], 'alpha.cpp')
            finally:
                transcriber.close()

    def test_job_write_enospc_transcribes_from_memory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            gate = threading.Event()
            transcriber = Transcriber(root, FakeCompute(gate=gate), state, events)
            audio = self.audio(root)
            original_atomic_json = atomic_json
            failed = False

            def fail_first_job(path, value):
                nonlocal failed
                if str(path).endswith('.wav.job.json') and not failed:
                    failed = True
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_atomic_json(path, value)

            drained = threading.Event()
            try:
                with patch('workstation.atomic_json', new=fail_first_job):
                    transcriber.submit(audio, {'mode': 'archive', 'target': {}})
                    self.assertEqual(transcriber.telemetry()['retryJobs'], 0)
                    self.assertEqual(transcriber.telemetry()['pendingJobs'], 1)
                    transcriber._persist_pending_jobs()
                    self.assertEqual(transcriber.telemetry()['pendingJobs'], 0)
                    self.assertTrue(Path(audio['path'] + '.job.json').exists())
                    gate.set()
                    transcriber.drain(drained.set)
                    self.assertTrue(drained.wait(3))
                self.assertTrue(Path(audio['path'] + '.transcript.json').exists())
                self.assertEqual(transcriber.telemetry()['retryJobs'], 0)
                self.assertEqual(transcriber.telemetry()['pendingJobs'], 0)
            finally:
                transcriber.close()

    def test_late_pending_persist_cannot_recreate_completed_job(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            compute_gate = threading.Event()
            transcriber = Transcriber(root, FakeCompute(gate=compute_gate), state, events)
            audio = self.audio(root)
            job_path = Path(audio['path'] + '.job.json')
            transcript_path = Path(audio['path'] + '.transcript.json')
            original_atomic_json = atomic_json
            persist_started = threading.Event()
            allow_persist = threading.Event()
            job_writes = 0

            def control_job_writes(path, value):
                nonlocal job_writes
                if str(path).endswith('.wav.job.json'):
                    job_writes += 1
                    if job_writes == 1:
                        raise OSError(errno.ENOSPC, 'disk full')
                    if job_writes == 2:
                        persist_started.set()
                        allow_persist.wait(3)
                return original_atomic_json(path, value)

            persist_thread = threading.Thread(target=transcriber._persist_pending_jobs)
            drained = threading.Event()
            try:
                with patch('workstation.atomic_json', new=control_job_writes):
                    transcriber.submit(audio, {'mode': 'archive', 'target': {}})
                    persist_thread.start()
                    self.assertTrue(persist_started.wait(3))
                    compute_gate.set()
                    deadline = time.monotonic() + 3
                    while not transcript_path.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(transcript_path.exists())
                    allow_persist.set()
                    persist_thread.join(3)
                    transcriber.drain(drained.set)
                    self.assertTrue(drained.wait(3))
                self.assertTrue(transcript_path.exists())
                self.assertFalse(job_path.exists())
            finally:
                allow_persist.set()
                persist_thread.join(3)
                transcriber.close()

    def test_spoken_stop_dictation_survives_job_write_enospc(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            route = {
                **state.start_dictation(TARGET),
                'stopPhraseDetected': True,
                'stopPhrase': 'green apple',
            }
            transcriber = Transcriber(root, FakeCompute(text='write this'), state, events)
            audio = self.audio(root)
            original_atomic_json = atomic_json
            failed = False

            def fail_first_job(path, value):
                nonlocal failed
                if str(path).endswith('.wav.job.json') and not failed:
                    failed = True
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_atomic_json(path, value)

            drained = threading.Event()
            try:
                with patch('workstation.atomic_json', new=fail_first_job):
                    transcriber.submit(audio, route)
                    transcriber.drain(state.stop_dictation)
                    transcriber.drain(drained.set)
                    self.assertTrue(drained.wait(3))
                relevant = [event for event in events.after(0)
                            if event['kind'] in {'dictation.segment', 'dictation.final',
                                                 'dictation.recovered'}]
                self.assertEqual([event['kind'] for event in relevant],
                                 ['dictation.segment', 'dictation.final'])
                self.assertEqual(relevant[-1]['text'], 'write this')
                self.assertEqual(state.snapshot()['mode'], 'wake')
                self.assertEqual(transcriber.telemetry()['pendingJobs'], 0)
            finally:
                transcriber.close()

    def test_pending_job_memory_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            transcriber = Transcriber(root, FakeCompute(), state, events)
            try:
                with patch('workstation.atomic_json', side_effect=OSError(errno.EACCES, 'blocked')):
                    for index in range(transcriber.MAX_PENDING_JOBS + 2):
                        transcriber.submit({'path': str(root / f'{index}.wav')},
                                           {'mode': 'archive', 'target': {}})
                telemetry = transcriber.telemetry()
                self.assertEqual(telemetry['pendingJobs'], transcriber.MAX_PENDING_JOBS)
                self.assertEqual(telemetry['pendingJobDrops'], 2)
                self.assertFalse(transcriber.accepting_audio())
            finally:
                transcriber.close()

    def test_restart_archives_final_wav_without_job(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = self.audio(root)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            transcriber = Transcriber(root, FakeCompute(), state, events)
            drained = threading.Event()
            try:
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertTrue(Path(audio['path'] + '.transcript.json').exists())
                self.assertTrue(any(event['kind'] == 'transcript.recovered' for event in events.after(0)))
            finally:
                transcriber.close()

    def test_wake_detection_plays_start_cue_with_inline_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            playback = FakePlayback()
            transcriber = Transcriber(root, FakeCompute(text='Hey agent run tests'),
                                      state, events, playback)
            drained = threading.Event()
            try:
                transcriber.submit(self.audio(root), state.snapshot())
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertEqual(playback.cues, ['start'])
                self.assertTrue(any(event['kind'] == 'wake.detected'
                                    for event in events.after(0)))
            finally:
                transcriber.close()

    def test_final_recognition_does_not_repeat_partial_wake_cue(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            playback = FakePlayback()
            transcriber = Transcriber(root, FakeCompute(text='Hey agent run tests'),
                                      state, events, playback)
            drained = threading.Event()
            try:
                route = {**state.snapshot(), 'wakeCueAcknowledged': True}
                transcriber.submit(self.audio(root), route)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertEqual(playback.cues, [])
                self.assertTrue(any(event['kind'] == 'wake.detected'
                                    for event in events.after(0)))
            finally:
                transcriber.close()

    def test_plural_final_recognition_after_partial_wake_produces_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            playback = FakePlayback()
            transcriber = Transcriber(root, FakeCompute(text='Hey agents, run tests'),
                                      state, events, playback)
            drained = threading.Event()
            try:
                route = {**state.snapshot(), 'wakeCueAcknowledged': True}
                transcriber.submit(self.audio(root), route)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertTrue(state.has_pending_command())
                final = state.flush_pending()
                self.assertEqual(len(final), 1)
                self.assertEqual(final[0]['command'], 'run tests')
                self.assertEqual(final[0]['target'], route['target'])
                self.assertEqual(playback.cues, [])
            finally:
                transcriber.close()

    def test_stop_marked_wake_command_flushes_immediately_without_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            transcriber = Transcriber(root, FakeCompute(text='Hey agent run tests'), state, events)
            drained = threading.Event()
            try:
                route = {**state.snapshot(), 'stopPhraseDetected': True,
                         'stopPhrase': 'green apple', 'wakeCueAcknowledged': True}
                transcriber.submit(self.audio(root), route)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                command = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(command), 1)
                self.assertEqual(command[0]['command'], 'run tests')
                self.assertFalse(state.has_pending_command())
            finally:
                transcriber.close()

    def test_bare_wake_followed_by_stop_does_not_leave_agent_armed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            transcriber = Transcriber(root, FakeCompute(text='Hey agent'), state, events)
            drained = threading.Event()
            try:
                route = {**state.snapshot(), 'stopPhraseDetected': True,
                         'stopPhrase': 'green apple', 'wakeCueAcknowledged': True}
                transcriber.submit(self.audio(root), route)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertFalse(state.snapshot()['armed'])
                self.assertFalse(state.has_pending_command())
                self.assertFalse(any(event['kind'] == 'wake.armed' for event in events.after(0)))
            finally:
                transcriber.close()

    def test_stop_flush_failure_retries_after_transcript_sidecar_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            transcriber = Transcriber(root, FakeCompute(text='Hey agent run tests'), state, events)
            audio = self.audio(root)
            original_append = events.append
            fail_final = True

            def fail_first_final(kind, payload=None):
                nonlocal fail_final
                if kind == 'command.final' and fail_final:
                    fail_final = False
                    raise OSError(errno.ENOSPC, 'disk full')
                return original_append(kind, payload)

            events.append = fail_first_final
            first = threading.Event()
            second = threading.Event()
            try:
                route = {**state.snapshot(), 'stopPhraseDetected': True,
                         'stopPhrase': 'green apple', 'wakeCueAcknowledged': True}
                transcriber.submit(audio, route)
                transcriber.drain(first.set)
                self.assertTrue(first.wait(3))
                self.assertTrue(state.has_pending_command())
                job_path = Path(audio['path'] + '.job.json')
                self.assertTrue(job_path.exists())
                transcriber._enqueue(job_path)
                transcriber.drain(second.set)
                self.assertTrue(second.wait(3))
                command = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(command), 1)
                self.assertEqual(command[0]['command'], 'run tests')
                self.assertFalse(job_path.exists())
            finally:
                transcriber.close()

    def test_stop_marked_already_armed_command_flushes_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            state.accept(Recognition('', 'Hey agent'), {'path': 'wake.wav'})
            transcriber = Transcriber(root, FakeCompute(text='compile shaders'), state, events)
            drained = threading.Event()
            try:
                route = {**state.snapshot(), 'stopPhraseDetected': True,
                         'stopPhrase': 'green apple'}
                transcriber.submit(self.audio(root), route)
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                command = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(command), 1)
                self.assertEqual(command[0]['command'], 'compile shaders')
            finally:
                transcriber.close()

    def test_speech_activity_extends_pending_command_before_flush(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            transcriber = Transcriber(root, FakeCompute(), state, events, command_grace_ms=50)
            try:
                state.accept(Recognition('', 'Hey agent keep this'), {'path': 'a.wav'})
                transcriber.idle()
                threading.Event().wait(0.02)
                transcriber.activity()
                threading.Event().wait(0.25)
                self.assertFalse(any(event['kind'] == 'command.final' for event in events.after(0)))
                state.accept(Recognition('', 'with the rest'), {'path': 'b.wav'})
                transcriber.idle()
                threading.Event().wait(0.3)
                commands = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(commands), 1)
                self.assertEqual(commands[0]['command'], 'keep this with the rest')
            finally:
                transcriber.close()

    def test_failed_continuation_blocks_command_until_retry_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            compute = FakeCompute(fail=True)
            transcriber = Transcriber(root, compute, state, events, command_grace_ms=50)
            drained = threading.Event()
            try:
                state.accept(Recognition('', 'Hey agent keep this'), {'path': 'a.wav'})
                audio = self.audio(root)
                transcriber.submit(audio, {'mode': 'wake', 'target': TARGET})
                transcriber.idle()
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                threading.Event().wait(0.3)
                self.assertFalse(any(event['kind'] == 'command.final' for event in events.after(0)))
                self.assertEqual(transcriber.telemetry()['wakeRetryJobs'], 1)

                compute.fail = False
                completed = threading.Event()
                transcriber._enqueue(Path(audio['path'] + '.job.json'))
                transcriber.drain(completed.set)
                self.assertTrue(completed.wait(3))
                threading.Event().wait(0.3)
                commands = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(commands), 1)
                self.assertEqual(commands[0]['command'], 'keep this alpha.cpp')
            finally:
                transcriber.close()

    def test_expired_failed_wake_job_does_not_hold_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            transcriber = Transcriber(root, FakeCompute(fail=True), state, events, command_grace_ms=50)
            drained = threading.Event()
            try:
                state.accept(Recognition('', 'Hey agent keep this'), {'path': 'a.wav'})
                transcriber.submit(self.audio(root), {'mode': 'wake', 'target': TARGET})
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertEqual(transcriber.telemetry()['wakeRetryJobs'], 1)
                transcriber.WAKE_MAX_AGE_SECONDS = 0
                threading.Event().wait(0.05)
                transcriber.idle()
                threading.Event().wait(0.3)
                commands = [event for event in events.after(0) if event['kind'] == 'command.final']
                self.assertEqual(len(commands), 1)
                self.assertEqual(commands[0]['command'], 'keep this')
            finally:
                transcriber.close()

    def test_retry_pass_yields_to_live_audio_and_prefers_fresh_wake_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            compute = FakeCompute(fail=True)
            transcriber = Transcriber(root, compute, state, events)
            drained = threading.Event()
            try:
                stale = self.audio(root)
                transcriber.submit(stale, {'mode': 'wake', 'target': TARGET})
                fresh = self.audio(root)
                transcriber.submit(fresh, {'mode': 'wake', 'target': TARGET})
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                stale_job = Path(stale['path'] + '.job.json')
                fresh_job = Path(fresh['path'] + '.job.json')
                # Stale job looks least recently tried, so plain mtime order would pick it.
                os.utime(stale_job, (1, 1))
                os.utime(fresh_job, (2, 2))
                with transcriber.queued_lock:
                    transcriber.retry_wake_jobs[stale_job] = '2000-01-01T00:00:00Z'
                gate = threading.Event()
                compute.gate = gate
                compute.fail = False
                calls = compute.calls

                transcriber.activity()
                transcriber._retry_pass()
                self.assertEqual(compute.calls, calls)
                transcriber.idle()

                transcriber._retry_pass()
                transcriber._retry_pass()
                with transcriber.queued_lock:
                    self.assertEqual(transcriber.queued, {fresh_job})
                gate.set()
                finished = threading.Event()
                transcriber.drain(finished.set)
                self.assertTrue(finished.wait(3))
                self.assertFalse(fresh_job.exists())
                self.assertTrue(stale_job.exists())
            finally:
                transcriber.close()

    def test_retry_pass_reads_its_own_job_index_instead_of_the_audio_tree(self) -> None:
        # The idle retry pass runs every 5 s. Globbing 35k evidence files took
        # 2.9 s under the GIL and starved the microphone callback each time.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            compute = FakeCompute(fail=True)
            transcriber = Transcriber(root, compute, state, events)
            drained = threading.Event()
            try:
                failed = self.audio(root)
                transcriber.submit(failed, {'mode': 'archive', 'target': TARGET})
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                failed_job = Path(failed['path'] + '.job.json')
                os.utime(failed_job, (1, 1))
                vanished = root / 'audio' / 'moved-away.wav.job.json'
                with transcriber.queued_lock:
                    transcriber.retry_jobs.add(vanished)
                compute.fail = False
                with patch.object(Path, 'glob', side_effect=AssertionError('audio tree walked')), \
                        patch.object(Path, 'rglob', side_effect=AssertionError('audio tree walked')):
                    transcriber._retry_pass()
                finished = threading.Event()
                transcriber.drain(finished.set)
                self.assertTrue(finished.wait(3))
                self.assertFalse(failed_job.exists())
                with transcriber.queued_lock:
                    self.assertEqual(transcriber.retry_jobs, set())
            finally:
                transcriber.close()

    def test_expired_wake_job_is_archived_without_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            compute = FakeCompute(text='Hey agent run tests')
            transcriber = Transcriber(root, compute, state, events)
            transcriber.WAKE_MAX_AGE_SECONDS = 0
            drained = threading.Event()
            try:
                audio = self.audio(root)
                transcriber.submit(audio, state.snapshot())
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                kinds = [event['kind'] for event in events.after(0)]
                self.assertIn('transcript.recovered', kinds)
                self.assertNotIn('command.final', kinds)
            finally:
                transcriber.close()

    def test_startup_finds_jobs_and_orphans_from_one_listing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            retry = self.audio(root)
            retry_job = Path(retry['path'] + '.job.json')
            atomic_json(retry_job, {'version': 1, 'audio': retry, 'route': {'mode': 'wake'},
                                    'createdAt': '2026-01-01T00:00:00Z', 'attempts': 1})
            orphan = self.audio(root)
            done = self.audio(root)
            Path(done['path'] + '.transcript.json').write_text('{}', encoding='utf-8')
            with patch.object(Path, 'glob', side_effect=AssertionError('tree globbed')),                     patch.object(Path, 'rglob', side_effect=AssertionError('tree globbed')):
                transcriber = Transcriber(root, FakeCompute(fail=True), state, events)
            drained = threading.Event()
            try:
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                with transcriber.queued_lock:
                    self.assertIn(retry_job, transcriber.retry_jobs)
                    self.assertIn(retry_job, transcriber.retry_wake_jobs)
                self.assertTrue(Path(orphan['path'] + '.job.json').exists())
                self.assertFalse(Path(done['path'] + '.job.json').exists())
            finally:
                transcriber.close()

    def test_orphans_beyond_memory_bound_are_rescanned_after_storage_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = [self.audio(root) for _ in range(3)]
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            with patch.object(Transcriber, 'MAX_PENDING_JOBS', 2), \
                    patch('workstation.atomic_json', side_effect=OSError(errno.ENOSPC, 'disk full')):
                transcriber = Transcriber(root, FakeCompute(), state, events)
            drained = threading.Event()
            try:
                self.assertTrue(transcriber.orphan_rescan_needed)
                transcriber._persist_pending_jobs()
                transcriber.orphan_rescan_needed = False
                transcriber._recover_orphan_audio()
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertTrue(all(Path(item['path'] + '.transcript.json').exists() for item in audio))
            finally:
                transcriber.close()

    def test_retry_scan_cannot_queue_the_same_job_twice(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            gate = threading.Event()
            compute = FakeCompute(gate=gate)
            transcriber = Transcriber(root, compute, state, events)
            drained = threading.Event()
            try:
                audio = self.audio(root)
                transcriber.submit(audio, state.snapshot())
                job = Path(audio['path'] + '.job.json')
                self.assertFalse(transcriber._enqueue(job))
                gate.set()
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertEqual(compute.calls, 1)
            finally:
                transcriber.close()

    def test_failure_leaves_durable_retry_job_and_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            state = VoiceState(events, ['hey agent'])
            compute = FakeCompute(fail=True)
            transcriber = Transcriber(root, compute, state, events)
            drained = threading.Event()
            try:
                audio = self.audio(root)
                transcriber.submit(audio, state.snapshot())
                transcriber.drain(drained.set)
                self.assertTrue(drained.wait(3))
                self.assertTrue(Path(audio['path']).exists())
                self.assertTrue(Path(audio['path'] + '.job.json').exists())
                self.assertTrue(any(event['kind'] == 'transcript.failed' for event in events.after(0)))
            finally:
                transcriber.close()


class EmotionTests(unittest.TestCase):
    def test_ambiguous_acoustic_classification_is_not_marked_reliable(self) -> None:
        config = type('Config', (), {
            'emotion_confidence': 0.55,
            'emotion_margin': 0.20,
            'emotion_model': 'fake',
        })()

        class Model:
            @staticmethod
            def generate(**_kwargs):
                return [{
                    'labels': ['开心/happy', '中立/neutral'],
                    'scores': [0.52, 0.48],
                }]

        emotion = LazyEmotion(config)
        emotion.model = Model()
        result = emotion.analyze(b'RIFFfake')
        self.assertEqual(result['label'], 'happy')
        self.assertFalse(result['reliable'])
        self.assertAlmostEqual(result['margin'], 0.04)


if __name__ == '__main__':
    unittest.main()
