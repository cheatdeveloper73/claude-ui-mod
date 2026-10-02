from __future__ import annotations

import io
import os
import sys
import tempfile
import time
import unittest
import wave
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import (
    ContinuousJournal,
    EventStore,
    PcmSpool,
    Recognition,
    SAMPLE_RATE,
    VoiceState,
    match_stop_phrase_words,
    prune_audio,
    recover_spools,
    safe_target,
)


TARGET = {
    'desktopSessionId': 'local_11111111-2222-3333-4444-555555555555',
    'cliSessionId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'webContentsId': 7,
    'viewId': None,
}


class EventStoreTests(unittest.TestCase):
    def test_ids_survive_restart_and_malformed_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = EventStore(root)
            self.assertEqual(first.append('one')['id'], 1)
            with (root / 'events.jsonl').open('a', encoding='utf-8') as handle:
                handle.write('{bad\n')
            second = EventStore(root)
            self.assertEqual(second.append('two')['id'], 2)
            self.assertEqual([event['kind'] for event in second.after(0)], ['one', 'two'])

    def test_cursor_inside_memory_window_never_reads_the_journal(self) -> None:
        # The companion polls every 250 ms with a caught-up cursor. Scanning the
        # journal for that empty answer held the GIL long enough to stall the
        # PortAudio callback once events.jsonl reached 134 MB.
        with tempfile.TemporaryDirectory() as temporary:
            store = EventStore(Path(temporary), memory_limit=3)
            for kind in ('one', 'two', 'three', 'four'):
                store.append(kind)
            with mock.patch.object(Path, 'open', side_effect=AssertionError('journal scanned')):
                self.assertEqual(store.after(4), [])
                self.assertEqual(store.after(9), [])
                self.assertEqual([event['kind'] for event in store.after(1)], ['two', 'three', 'four'])
            self.assertEqual([event['kind'] for event in store.after(0)], ['one', 'two', 'three', 'four'])


    def test_startup_parses_only_the_retained_tail(self) -> None:
        # A 134 MB journal took 3.5 s to parse on every restart for 4,000 events.
        import common
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = EventStore(root, memory_limit=10)
            for index in range(50):
                first.append('tick', {'index': index})
            calls = []
            real_loads = common.json.loads
            with mock.patch.object(common.json, 'loads', side_effect=lambda text: calls.append(1) or real_loads(text)):
                second = EventStore(root, memory_limit=10)
            self.assertLessEqual(len(calls), 11)
            self.assertEqual([event['id'] for event in second.events], list(range(41, 51)))
            self.assertEqual(second.append('next')['id'], 51)


class SpoolTests(unittest.TestCase):
    def test_spool_is_valid_wave_and_removes_part(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spool = PcmSpool(root)
            spool.write(b'\x00\x00' * SAMPLE_RATE)
            evidence = spool.finish()
            self.assertFalse(spool.part.exists())
            with wave.open(evidence['path'], 'rb') as audio:
                self.assertEqual(audio.getframerate(), SAMPLE_RATE)
                self.assertEqual(audio.getnframes(), SAMPLE_RATE)

    def test_open_spool_snapshot_keeps_only_requested_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spool = PcmSpool(root)
            spool.write(b'\x01\x00' * 400 + b'\x02\x00' * 600)
            snapshot = spool.snapshot(600)
            self.assertFalse(spool.closed)
            with wave.open(io.BytesIO(snapshot), 'rb') as audio:
                self.assertEqual(audio.getnframes(), 600)
                self.assertEqual(audio.readframes(1), b'\x02\x00')
            spool.finish()

    def test_open_spool_truncates_at_an_exact_sample_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            spool = PcmSpool(Path(temporary))
            spool.write(b'\x01\x00' * 400 + b'\x02\x00' * 600)
            self.assertEqual(spool.truncate(400), 400)
            evidence = spool.finish()
            self.assertEqual(evidence['samples'], 400)
            with wave.open(evidence['path'], 'rb') as audio:
                self.assertEqual(audio.getnframes(), 400)
                self.assertEqual(audio.readframes(400), b'\x01\x00' * 400)

    def test_crashed_part_is_recovered(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spool = PcmSpool(root)
            spool.write(b'\x01\x00' * 800)
            spool.abandon()
            recovered = recover_spools(root)
            self.assertEqual(len(recovered), 1)
            self.assertTrue(Path(recovered[0]['path']).exists())
            self.assertFalse(spool.part.exists())

    def test_continuous_journal_rolls_without_dropping_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            journal = ContinuousJournal(root, chunk_seconds=10)
            done = journal.write(b'\x00\x00' * (SAMPLE_RATE * 10 + 123))
            tail = journal.close()
            self.assertEqual(done[0]['samples'], SAMPLE_RATE * 10)
            self.assertEqual(tail['samples'], 123)


class RetentionTests(unittest.TestCase):
    def test_prune_removes_completed_evidence_and_preserves_pending_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            audio = Path(temporary) / 'audio' / '2026-01-01'
            audio.mkdir(parents=True)
            completed = audio / 'completed.wav'
            completed.write_bytes(b'RIFF')
            transcript = completed.with_suffix('.wav.transcript.json')
            transcript.write_text('{}', encoding='utf-8')
            pending = audio / 'pending.wav'
            pending.write_bytes(b'RIFF')
            job = pending.with_suffix('.wav.job.json')
            job.write_text('{}', encoding='utf-8')
            old = time.time() - 3 * 86_400
            for path in (completed, transcript, pending, job):
                os.utime(path, (old, old))
            self.assertEqual(prune_audio(Path(temporary), 1), 1)
            self.assertFalse(completed.exists())
            self.assertFalse(transcript.exists())
            self.assertTrue(pending.exists())
            self.assertTrue(job.exists())


    def test_evidence_scans_use_one_listing_instead_of_per_file_globs(self) -> None:
        # rglob plus two exists() per WAV took 70 s over 17,704 utterances.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / 'audio' / '2026-01-01'
            audio.mkdir(parents=True)
            completed = audio / 'utterance-a.wav'
            completed.write_bytes(b'RIFF')
            completed.with_suffix('.wav.transcript.json').write_text('{}', encoding='utf-8')
            pending = audio / 'utterance-b.wav'
            pending.write_bytes(b'RIFF')
            pending.with_suffix('.wav.job.json').write_text('{}', encoding='utf-8')
            (audio / 'utterance-c.pcm.part').write_bytes(b'\x01\x00' * 100)
            old = time.time() - 3 * 86_400
            for path in (completed, pending):
                os.utime(path, (old, old))
            with mock.patch.object(Path, 'rglob', side_effect=AssertionError('tree globbed')),                     mock.patch.object(Path, 'glob', side_effect=AssertionError('tree globbed')):
                self.assertEqual(len(recover_spools(root)), 1)
                self.assertEqual(prune_audio(root, 1), 1)
            self.assertFalse(completed.exists())
            self.assertTrue(pending.exists())
            self.assertTrue((audio / 'utterance-c.recovered.wav').exists())


    def test_retention_only_lists_expired_day_folders(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_day = root / 'audio' / '2020-01-01'
            new_day = root / 'audio' / time.strftime('%Y-%m-%d')
            for day in (old_day, new_day):
                day.mkdir(parents=True)
                (day / 'utterance-a.wav').write_bytes(b'RIFF')
            old = time.time() - 3 * 86_400
            os.utime(old_day / 'utterance-a.wav', (old, old))
            listed = []
            real_scandir = os.scandir
            with mock.patch('common.os.scandir', side_effect=lambda path: listed.append(Path(path)) or real_scandir(path)):
                self.assertEqual(prune_audio(root, 1), 1)
            self.assertNotIn(new_day, listed)
            self.assertTrue((new_day / 'utterance-a.wav').exists())


class StopPhraseTests(unittest.TestCase):
    def test_real_whisper_point_spans_do_not_discard_stop_phrase(self) -> None:
        cases = [
            [
                {'word': 'Yeah,', 'start': 0.02, 'end': 1.02},
                {'word': 'green', 'start': 1.3, 'end': 1.3},
                {'word': 'apple', 'start': 1.3, 'end': 1.74},
                {'word': 'is...', 'start': 1.74, 'end': 2.44},
            ],
            [
                {'word': 'green', 'start': 0.0, 'end': 0.76},
                {'word': 'apple', 'start': 0.76, 'end': 1.3},
                {'word': 'one', 'start': 2.98, 'end': 2.98},
            ],
        ]
        for words in cases:
            with self.subTest(words=words):
                match = match_stop_phrase_words(words, 'green apple')
                self.assertIsNotNone(match)
                self.assertGreater(match['phraseEnd'], match['start'])

    def test_point_spans_cannot_invent_a_phrase_duration(self) -> None:
        for words in (
            [{'word': 'green', 'start': 1.0, 'end': 1.0},
             {'word': 'apple', 'start': 1.0, 'end': 1.0}],
            [{'word': 'green', 'start': 1.0, 'end': 0.9},
             {'word': 'apple', 'start': 1.0, 'end': 1.5}],
            [{'word': 'green', 'start': float('nan'), 'end': 1.0},
             {'word': 'apple', 'start': 1.0, 'end': 1.5}],
        ):
            with self.subTest(words=words):
                self.assertIsNone(match_stop_phrase_words(words, 'green apple'))

    def test_timestamp_match_is_case_punctuation_and_boundary_safe(self) -> None:
        words = [
            {'word': 'Green,', 'start': 0.4, 'end': 0.7},
            {'word': 'APPLE!', 'start': 0.72, 'end': 1.0},
            {'word': 'tree', 'start': 1.02, 'end': 1.2},
        ]
        match = match_stop_phrase_words(words, 'green apple')
        self.assertEqual(match['start'], 0.4)
        self.assertEqual(match['phraseEnd'], 1.0)
        self.assertIsNone(match_stop_phrase_words(
            [{'word': 'greenapple', 'start': 0.0, 'end': 0.5}], 'green apple'))
        self.assertIsNone(match_stop_phrase_words(words, 'green apple', after=0.5))


class VoiceStateTests(unittest.TestCase):
    def test_fresh_view_identity_survives_target_sanitization(self) -> None:
        target = safe_target({'desktopSessionId': None, 'cliSessionId': 'stale',
                              'webContentsId': 7, 'viewId': 'fresh-12345678'})
        self.assertEqual(target, {'desktopSessionId': None, 'cliSessionId': None,
                                  'webContentsId': 7, 'viewId': 'fresh-12345678'})

    def test_wake_with_command_preserves_raw_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            emitted = state.accept(
                Recognition(raw='Hey agent open foo dot cpp', text='Hey Agent, open foo.cpp'),
                {'path': 'utterance.wav'},
            )
            self.assertEqual([event['kind'] for event in emitted], ['wake.detected', 'command.pending'])
            command = state.flush_pending()[0]
            self.assertEqual(command['kind'], 'command.final')
            self.assertEqual(command['command'], 'open foo.cpp')
            self.assertEqual(command['raw'], 'Hey agent open foo dot cpp')
            self.assertEqual(command['target'], TARGET)

    def test_partial_wake_cue_does_not_override_final_recognition(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            emitted = state.accept(Recognition('', 'background conversation'), {'path': 'a.wav'}, {
                **state.snapshot(), 'wakeCueAcknowledged': True,
            })
            self.assertEqual(emitted, [])

    def test_wake_command_collects_follow_on_segments_before_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            first = state.accept(Recognition('hey agent see if we can get', 'Hey Agent, see if we can get'),
                                 {'path': 'a.wav'})
            second = state.accept(Recognition('a complete long prompt', 'a complete long prompt'),
                                  {'path': 'b.wav'})
            self.assertEqual(first[-1]['kind'], 'command.pending')
            self.assertEqual(second[-1]['segmentCount'], 2)
            command = state.flush_pending()[0]
            self.assertEqual(command['command'], 'see if we can get a complete long prompt')
            self.assertEqual(len(command['audioSegments']), 2)

    def test_emotion_scores_are_duration_weighted_across_command_segments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            happy = {'scores': {'happy': 0.9, 'neutral': 0.1}, 'model': 'fake',
                     'confidenceThreshold': 0.55, 'marginThreshold': 0.2}
            neutral = {'scores': {'happy': 0.2, 'neutral': 0.8}, 'model': 'fake',
                       'confidenceThreshold': 0.55, 'marginThreshold': 0.2}
            state.accept(Recognition('', 'Hey agent keep this', emotion=happy),
                         {'path': 'a.wav', 'durationMs': 1000})
            state.accept(Recognition('', 'with the rest', emotion=neutral),
                         {'path': 'b.wav', 'durationMs': 3000})
            emotion = state.flush_pending()[0]['emotion']
            self.assertEqual(emotion['label'], 'neutral')
            self.assertAlmostEqual(emotion['confidence'], 0.625)
            self.assertTrue(emotion['reliable'])

    def test_prosody_aggregation_reports_missing_duration_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            prosody = {
                'schemaVersion': 1,
                'status': 'ready',
                'model': 'voicenet',
                'modelRevision': 'revision',
                'artifactDigest': 'a' * 64,
                'baselineDigest': 'b' * 64,
                'baselineSampleCount': 500,
                'profile': {'AROU': {'score': 2.5, 'z': 2.0}},
            }
            state.accept(Recognition('', 'Hey agent keep this', prosody=prosody),
                         {'path': 'a.wav', 'durationMs': 1000})
            state.accept(Recognition('', 'with the rest', prosody={'status': 'timeout'}),
                         {'path': 'b.wav', 'durationMs': 3000})
            aggregate = state.flush_pending()[0]['prosody']
            self.assertEqual(aggregate['status'], 'partial')
            self.assertEqual(aggregate['coverage'], 0.25)
            self.assertEqual(aggregate['profile']['AROU'], {'score': 2.5, 'z': 2.0})

    def test_command_continuation_keeps_wake_target_after_navigation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            state.accept(Recognition('', 'Hey agent keep this'), {'path': 'a.wav'})
            other = {**TARGET, 'webContentsId': 9,
                     'desktopSessionId': 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
            state.accept(Recognition('', 'with the rest'), {'path': 'b.wav'}, {
                'mode': 'wake', 'target': other,
            })
            command = state.flush_pending()[0]
            self.assertEqual(command['command'], 'keep this with the rest')
            self.assertEqual(command['target'], TARGET)

    def test_pending_command_survives_restart_without_replaying_a_final(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            events = EventStore(root)
            first = VoiceState(events, ['hey agent'])
            first.update_target(TARGET)
            first.accept(Recognition('', 'Hey agent keep this'), {'path': 'a.wav'})
            recovered = VoiceState(EventStore(root), ['hey agent'])
            self.assertTrue(recovered.has_pending_command())
            final = recovered.flush_pending()[0]
            self.assertEqual(final['command'], 'keep this')
            after_final = VoiceState(EventStore(root), ['hey agent'])
            self.assertFalse(after_final.has_pending_command())

    def test_plural_wake_keeps_recorded_command_and_continuations(self) -> None:
        parts = [
            "Hey agents, spawn some 6-1 soul fast mode sub-agents and make them extra high. Probably about four of them. Tell them to figure out what issues we've had.",
            "while doing the other phase two and phase three. And let's figure out if we can minimize the amount of reoccurrence of those issues for the next phase four, which I will want to do right now, actually. So we're in the preparation phase for that. So that's what I would like you to do. Read only output.",
            "I'll put it here in the chat and talk to me",
        ]
        with tempfile.TemporaryDirectory() as temporary:
            state = VoiceState(EventStore(Path(temporary)), ['hey agent'])
            state.update_target(TARGET)
            for index, text in enumerate(parts):
                state.accept(Recognition(text, text), {'path': f'{index}.wav'}, {
                    **state.snapshot(), 'wakeCueAcknowledged': index == 0,
                })
            final = state.flush_pending()
            self.assertEqual(len(final), 1)
            self.assertEqual(final[0]['command'], ' '.join([parts[0][12:], *parts[1:]]))
            self.assertEqual(final[0]['text'], ' '.join(parts))
            self.assertEqual(final[0]['target'], TARGET)
            self.assertEqual(len(final[0]['audioSegments']), 3)
            self.assertEqual(state.flush_pending(), [])

    def test_plural_wake_preserves_word_boundaries_and_custom_phrases(self) -> None:
        for text in ('Hey agency run tests', 'Hey agentic run tests',
                     'Hey agentsmith run tests', 'Hey agents_run tests'):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as temporary:
                state = VoiceState(EventStore(Path(temporary)), ['hey agent'])
                self.assertEqual(state.accept(Recognition(text, text), {}), [])
                self.assertFalse(state.has_pending_command())
        with tempfile.TemporaryDirectory() as temporary:
            state = VoiceState(EventStore(Path(temporary)), ['hey robot'])
            self.assertEqual(state.accept(Recognition('', 'Hey robots run tests'), {}), [])
            self.assertEqual(state.accept(Recognition('', 'Hey agents run tests'), {}), [])
            state.accept(Recognition('', 'Hey robot run tests'), {})
            self.assertEqual(state.flush_pending()[0]['command'], 'run tests')

    def test_bare_plural_wake_arms_followup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = VoiceState(EventStore(Path(temporary)), ['hey agent'])
            first = state.accept(Recognition('', 'Hey, agents!'), {})
            self.assertEqual([event['kind'] for event in first], ['wake.detected', 'wake.armed'])
            state.accept(Recognition('', 'run tests'), {})
            self.assertEqual(state.flush_pending()[0]['command'], 'run tests')

    def test_bare_wake_arms_exactly_one_followup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            first = state.accept(Recognition('Hey agent', 'Hey, Agent'), {'path': 'a.wav'})
            second = state.accept(Recognition('run tests', 'run tests'), {'path': 'b.wav'})
            self.assertEqual([event['kind'] for event in first], ['wake.detected', 'wake.armed'])
            self.assertEqual([event['kind'] for event in second], ['command.pending'])
            self.assertEqual(state.flush_pending()[0]['command'], 'run tests')
            third = state.accept(Recognition('delete everything', 'delete everything'), {'path': 'c.wav'})
            self.assertEqual(third, [])

    def test_dictation_segments_and_final_are_owned_by_interaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            started = state.start_dictation(TARGET)
            segment = state.accept(Recognition('alpha', 'Alpha.'), {'path': 'a.wav'})[-1]
            final = state.stop_dictation()
            stored = events.after(segment['id'])[-1]
            self.assertEqual(segment['interactionId'], started['interactionId'])
            self.assertEqual(stored['kind'], 'dictation.final')
            self.assertEqual(stored['text'], 'Alpha.')
            self.assertEqual(final['mode'], 'wake')

    def test_summary_and_cancel_are_typed_intents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.accept(Recognition('', 'Hey, Agent! Summarize this chat.'), {})
            summary = state.flush_pending()[0]
            state.accept(Recognition('', 'Hey agent stop the agent'), {})
            cancel = state.flush_pending()[0]
            self.assertEqual(summary['intent'], 'summary')
            self.assertEqual(cancel['intent'], 'cancel')

    def test_final_asr_stop_fallback_flushes_without_sending_phrase_or_tail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.update_target(TARGET)
            state.accept(Recognition('', 'Hey agent run tests green apple ignore this'), {})
            final = [event for event in events.after(0) if event['kind'] == 'command.final']
            self.assertEqual(len(final), 1)
            self.assertEqual(final[0]['command'], 'run tests')
            self.assertFalse(state.has_pending_command())
            self.assertEqual(state.flush_pending(), [])
            self.assertEqual(state.accept(Recognition('', 'green apple'), {}), [])

    def test_final_asr_stop_fallback_flushes_pending_and_disarms_bare_wake(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.accept(Recognition('', 'Hey agent keep this'), {})
            state.accept(Recognition('', 'and this GREEN, APPLE! discard tail'), {})
            final = [event for event in events.after(0) if event['kind'] == 'command.final']
            self.assertEqual([event['command'] for event in final], ['keep this and this'])
            state.accept(Recognition('', 'Hey agent green apple'), {})
            self.assertFalse(state.snapshot()['armed'])
            self.assertEqual(state.accept(Recognition('', 'unrelated speech'), {}), [])

    def test_final_asr_stop_fallback_honors_custom_phrase_and_word_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = VoiceState(EventStore(Path(temporary)), ['hey agent'], stop_phrase='blue orange')
            state.accept(Recognition('', 'Hey agent green apple green apples'), {})
            self.assertTrue(state.has_pending_command())
            final = state.accept(Recognition('', 'BLUE ORANGE discard tail'), {})[-1]
            self.assertEqual(final['command'], 'green apple green apples')
        with tempfile.TemporaryDirectory() as temporary:
            state = VoiceState(EventStore(Path(temporary)), ['hey agent'])
            state.accept(Recognition('', 'Hey agent green apples greenapple'), {})
            self.assertEqual(state.flush_pending()[0]['command'], 'green apples greenapple')

    def test_final_asr_stop_fallback_finishes_dictation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            route = state.start_dictation(TARGET)
            emitted = state.accept(Recognition('', 'keep these words green apple discard tail'), {}, route)
            self.assertEqual(emitted[0]['text'], 'keep these words')
            final = [event for event in events.after(0) if event['kind'] == 'dictation.final']
            self.assertEqual(len(final), 1)
            self.assertEqual(final[0]['text'], 'keep these words')
            self.assertEqual(state.snapshot()['mode'], 'wake')
            self.assertEqual(events.after(0)[1]['text'], 'keep these words green apple discard tail')

    def test_disabled_wake_only_archives_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            state.wake_enabled = False
            self.assertEqual(state.accept(Recognition('', 'Hey agent run tests'), {}), [])
            self.assertEqual([event['kind'] for event in events.after(0)], ['transcript.archived'])

    def test_cancelled_interaction_archives_late_result_without_insertion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            events = EventStore(Path(temporary))
            state = VoiceState(events, ['hey agent'])
            route = state.start_dictation(TARGET)
            state.cancel_dictation()
            emitted = state.accept(Recognition('late words', 'Late words.'), {'path': 'late.wav'}, route)
            self.assertEqual([event['kind'] for event in emitted], ['dictation.recovered'])


if __name__ == '__main__':
    unittest.main()
