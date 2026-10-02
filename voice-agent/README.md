# Local Voice Agent

This subsystem replaces Claude Desktop Code dictation with a local, durable path:

```text
microphone -> recorder -> raw 5-minute chunks -> SSH tunnel -> compute-host FLAC archive (permanent)
                  \-> loopback frames -> workstation companion -> SSH loopback tunnel
                        -> faster-whisper + emotion2vec -> Desktop composer/session
                                    \-> bounded VoiceNet -> speaker-relative delivery context

Claude transcript -> local summarizer -> Kokoro -> workstation speakers
```

The workstation owns the audio device because a Windows service runs in Session 0 and cannot reliably share the interactive user's microphone or speakers. The compute service binds only to loopback. The companion supervises an SSH local-forward instead of opening a new LAN listener.

A small recorder process, not the companion, holds the microphone. The companion carries torch, a dozen threads and heavy disk I/O, and under memory pressure it lost up to 48% of the stream to whole-process stalls while a minimal capture process on the same device lost nothing. The recorder writes every block to `raw/` before any consumer sees it, streams the same blocks to the companion over authenticated loopback, and keeps recording while the companion restarts. The companion starts it on demand, detached from the scheduled task's job, and it exits after 15 minutes without a consumer.

Raw chunks are moved, not copied: the companion ships each finished chunk to the compute service, which stores bit-verified FLAC under `~/.local/share/cuimod-voice/archive/YYYY/MM/DD/`, and the workstation copy is deleted only after the archive confirms the same checksum and sample count. While the compute host is unreachable the chunks wait in `raw/`. The archive refuses new chunks while its volume is below `archiveMinFreeGb` (20 GB).

Everything else leaves the workstation the same way through `outbox/<collection>/`, which mirrors the archive's layout. An utterance moves there with its transcript once it has no pending job and has not been written for two minutes; the audio becomes verified FLAC under `archive/utterances/<day>/` and the transcript is kept byte for byte beside it. When `events.jsonl` passes 32 MB, its history is compressed into `archive/events/events-<first>-<last>.jsonl.gz` and the file keeps only the 4,000-event window the companion reads; successive segments overlap by that window. The workstation therefore holds only audio still being transcribed and files the archive has not yet confirmed.

## Guarantees and boundaries

- Every accepted speech segment is closed as a valid 16 kHz mono WAV before it is submitted to ASR.
- A crash during capture leaves a `.pcm.part` file. Startup wraps it as `.recovered.wav` without discarding samples.
- Failed ASR leaves the WAV plus a durable `.job.json`. The companion retries with bounded backoff and never queues the same job twice.
- A wake command stays pending across VAD endpoints and hard-length segments. Its pending state also keeps spoken stop enabled in a fresh continuation probe. It is released only after capture is idle, all recognition jobs finish, and the continuation grace period expires. Grace runs from capture becoming idle, overlapping ASR rather than adding a second full wait after recognition.
- The configurable spoken stop phrase defaults to `green apple`. It truncates the open spool at the partial recognizer's first-word estimate, ends manual dictation, and immediately flushes a wake command; samples after it are suppressed until normal VAD silence.
- A failed continuation holds the whole command until its durable retry succeeds. The pending command itself survives companion restarts without replaying a final event.
- A wake-mode job older than two minutes is transcribed into the archive but cannot execute as a delayed command.
- Raw ASR and acoustic emotion scores are stored together in a `.transcript.json` sidecar. The ASR text is authoritative from recognition through dispatch.
- Emotion is inferred from audio by emotion2vec+, never from transcript wording. Low-confidence and low-margin classifications remain evidence but are not presented as reliable context.
- VoiceNet starts beside ASR and gets at most a 150 ms tail after ASR plus emotion finish. Failure, overload and timeout omit detailed context without failing transcription.
- All 57 sanitized numeric VoiceNet dimensions remain in the retained sidecar. Prompt text can use only 19 code-owned delivery axes normalized against a 500-clip local speaker baseline; model strings and sensitive demographic/cognitive dimensions never enter the prompt.
- Retention removes each completed WAV and its transcript sidecar together. A WAV with a durable pending job is preserved. Transcribed utterances normally reach the archive long before retention applies; files in `outbox/` are never pruned.
- Manual dictation is segmented internally, so its duration is not bounded by one inference request.
- Event IDs and Desktop dispatch state survive process restarts. An outcome that crosses a process boundary and then loses its acknowledgement is held as uncertain instead of being sent twice.
- A prompt that cannot resolve its Desktop target before any send boundary is copied to the Windows clipboard, accompanied by the system alert sound and an in-app toast. Failures after the boundary remain uncertain and are never copied automatically because the prompt may already have been delivered.
- Wake commands become ordinary Claude user prompts. Claude Desktop's existing permission system remains authoritative for tools, files, shell commands, connectors, publishing and destructive actions.
- The microphone, archive, ASR, summary generation and TTS remain local. A prompt submitted into an ordinary Claude chat still uses that chat's configured model provider.

Wake detection snapshots the still-open PCM spool and runs a dedicated `distil-small.en` faster-whisper lane while capture continues. Final recognition starts with `medium.en`. A result below 0.50 confidence is checked with `small.en`, which replaces it only when its confidence is at least 0.10 higher; this catches catastrophic decoder hallucinations without rewriting merely uncertain speech. Endpoint-time recognition is the fallback for short segments or failed partial requests. Continuous journal mode additionally writes rolling WAV chunks containing the complete microphone stream.

Background wake probes retain a 500 ms cadence. Active dictation, an acknowledged wake, and pending-command continuations use a 200 ms cadence, still allowing only one probe request in flight. Compute latency can extend that interval; lowering it does not queue overlapping inference.

The `/v1/wake` response also carries validated, ordered word spans. Whisper point-aligned words are retained instead of invalidating the entire response; a matched stop phrase must still span positive time. The companion uses those spans only for the stop phrase: the first matched word's estimated start is converted to a 16 kHz sample boundary and the open spool is truncated there. Faster-whisper word timestamps are estimates, so the resulting file boundary is exact at that estimate, not at an acoustic phoneme boundary. Missing, stale, malformed, or incomplete spans never trigger a partial stop. Final ASR is a separate fallback: an exact stop phrase in an owned dictation or wake command removes the phrase and its tail from delivered text and finalizes the interaction immediately. That fallback preserves the complete captured WAV and raw transcript; it cannot retroactively stop capture at an acoustic timestamp.

## Components

- `recorder.py` — sounddevice/WASAPI capture, soxr conversion, the raw spool, and the loopback frame stream.
- `workstation.py` — Silero VAD, durable utterance spool, retry queue, archive shipping, SSH supervision, TTS playback, and token-protected loopback API.
- `compute_server.py` — precision-tuned faster-whisper, emotion2vec+ acoustic classification, local Gemma summarization, Kokoro TTS, and the FLAC archive.
- `prosody_server.py` — isolated CPU VoiceNet inference on a second authenticated loopback port.
- `common.py` — durable events, audio recovery, retention and command state machine.
- `src/plugins/voice-agent/` — capture-phase replacement of the native dictation control, TipTap insertion, background-session delivery, settings and status.

The acoustic classifier is Alibaba DAMO Academy's `emotion2vec_plus_large`, loaded through FunASR from `emotion2vec/emotion2vec_plus_large`. Its model source is <https://huggingface.co/emotion2vec/emotion2vec_plus_large> and its license is the [FunASR Model Open Source License Agreement](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE). Keep this attribution and the model name with any redistributed model configuration or weights.

The optional detailed prosody analyzer uses LAION's `voicenet-dimension-predictors-commercial`, including its bundled `voiceclap-commercial` encoder, under CC-BY-4.0. The deployment pins audited revision `cdafe5170561eaadb09f012ed5ae48e4f82b7b91`; the source and attribution live at <https://huggingface.co/laion/voicenet-dimension-predictors-commercial>. It predicts perceived delivery characteristics, not a speaker's internal state.

## Installation

### Compute host

Requirements:

- Linux with Python 3.10 or newer
- `espeak-ng`
- a local OpenAI-compatible text model endpoint for spoken conversation summaries
- SSH key access from the workstation

Run as the unprivileged account that will own the process:

```bash
./install-compute.sh
```

The installer creates:

```text
~/.local/share/cuimod-voice/venv
~/.local/share/cuimod-voice/app
~/.local/share/cuimod-voice/models
~/.config/cuimod-voice/compute.json
~/.config/cuimod-voice/token
~/.config/systemd/user/cuimod-voice.service
```

For detailed local prosody on the compute host, install the isolated VoiceNet sidecar after the compute service:

```bash
./install-prosody.sh
```

This creates a separate CPU-only virtual environment and `cuimod-prosody.service`, binds it to authenticated loopback port 8766, and downloads only the audited revision's production encoder and best-per-dimension heads. It does not replace or mutate the ASR environment. On the measured 16-core desktop CPU deployment, warm inference over 500 retained microphone clips had a 291 ms median and 348 ms p95; the live integration starts it alongside ASR and gives it only a bounded post-ASR tail.

Speaker-relative prompt context additionally requires `~/.config/cuimod-voice/prosody-baseline.json`. The production baseline is derived from 500 deterministically sampled retained microphone clips and records robust per-dimension centers and spreads without transcript text or audio. A missing baseline leaves raw VoiceNet inference available for calibration but fails closed for prompt enrichment.

The installers enable user systemd units. An administrator can enable user lingering when the services must start before interactive login:

```bash
loginctl enable-linger <user>
```

Keep `host` set to `127.0.0.1`. Copy the token file to the workstation's `.state/voice-agent/compute-token`; never put it in source, settings, logs, a URL, or renderer RPC. Disable the compute process without deleting models or configuration with `systemctl --user disable --now cuimod-voice.service`.

### Workstation

From PowerShell:

```powershell
.\voice-agent\install-workstation.ps1 -ComputeHost <host> -ComputeUser <user> -SshIdentity <key-path>
```

The installer creates an ignored virtual environment and runtime state under `.state/voice-agent/`, then registers the limited interactive-user scheduled task `ClaudeUiMod-Voice`.

List PortAudio/WASAPI device indices before selecting a non-default microphone:

```powershell
.\.state\voice-agent\venv\Scripts\python.exe .\voice-agent\workstation.py --list-devices
```

With `inputDevice` unset on Windows, the companion maps the OS default microphone onto its WASAPI instance. It opens shared mode at the device's supported rate and uses streaming soxr conversion to produce the 16 kHz blocks ASR and Silero require. Set `inputDevice` in `.state/voice-agent/workstation.json` and restart the scheduled task to override that selection. Other voice settings are hot through the Desktop Insert settings panel.

Remove the scheduled task without deleting recordings:

```powershell
.\voice-agent\install-workstation.ps1 -Remove
```

## Operation

- Click the existing microphone button once to start local dictation. This also stops active TTS playback for manual barge-in.
- Click again to finish. Completed segments are appended to the main TipTap composer as they arrive.
- Press Escape during local dictation to stop and suppress the active segment. Segments already inserted remain in the composer, and captured source audio remains recoverable.
- Say `Hey Agent, <prompt>` to submit a prompt to the most recently focused Claude Code session. The default phrase also accepts `Hey Agents`, since partial and final recognition can disagree on the plural for the same audio. Custom wake phrases still match exactly. The ready cue plays from partial local recognition while the segment remains open; the accepted cue plays after final recognition and delivery.
- Say `green apple` (or the configured stop phrase) while a wake command is active to end the command immediately. In manual dictation it ends the complete dictation interaction, exactly like Stop.
- Say `Hey Agent`, wait for the same ready cue, then speak the prompt.
- Say `Hey Agent, summarize this chat` to summarize the local transcript through the configured local text model and speak it with Kokoro.
- Say `Hey Agent, stop the agent` to interrupt the current turn.

The compact indicator beside the microphone keeps the persistent surface graphical: a health dot and live level meter. Speech state, segment duration, delivery, processor backlog, and cumulative PortAudio overflows remain visible in the Insert panel's Voice Agent status view.

The Insert panel controls whether wake commands send immediately or remain as composer drafts, acoustic delivery context, local cues, continuous journaling, retention, TTS voice/speed, and the local API port. Set retention to zero to keep audio until it is removed manually.

Capture is deliberately half-duplex while synthesized speech is playing so the speakers cannot wake the agent through microphone echo. The microphone button stops playback immediately; wake-phrase barge-in during TTS requires an acoustic echo canceller and is not claimed by this implementation.

Optional `cues/start.wav` and `cues/accepted.wav` files live under ignored workstation state. They are played locally without pausing capture, so a cue cannot hide simultaneous speech. The repository does not contain or redistribute licensed cue audio.

## Runtime files

```text
.state/voice-agent/token                         companion API token
.state/voice-agent/compute-token                 compute API token
.state/voice-agent/workstation.json              transport and capture configuration
.state/voice-agent/companion.log                 startup and fatal-error log
.state/voice-agent/recorder.log                  recorder startup log
.state/voice-agent/raw/YYYY-MM-DD/raw-*.wav      finished chunks not yet confirmed by the archive
.state/voice-agent/raw/YYYY-MM-DD/raw-*.pcm.part the chunk being recorded
.state/voice-agent/outbox/<collection>/...        verified-on-arrival files awaiting the archive
.state/voice-agent/events.jsonl                  recent companion events; history rotates to the archive
.state/voice-agent/event-state.json              next event sequence
.state/voice-agent/plugin-state.json             Desktop at-most-once cursor
.state/voice-agent/pending-command.json           crash-safe command accumulation
.state/voice-agent/cues/{start,accepted}.wav       optional licensed local cues
.state/voice-agent/audio/YYYY-MM-DD/*.wav         utterance audio until it is transcribed
.state/voice-agent/audio/**/*.wav.job.json        pending/retrying ASR
.state/voice-agent/audio/**/*.transcript.json     ASR + acoustic evidence
```

All runtime files are ignored. The dashboard's tracked `.state/settings.json` carries only non-secret UI preferences and is excluded from public publishing.

## Health and recovery

The companion and compute APIs require bearer tokens even on loopback. Their health responses contain no token or credential values.

```powershell
Get-ScheduledTask -TaskName ClaudeUiMod-Voice | Get-ScheduledTaskInfo
```

```bash
systemctl --user status cuimod-voice.service
```

If the compute host or tunnel is unavailable, capture continues and closes WAV files locally. Retry jobs stay beside those files and are reprocessed after connectivity returns. If the microphone disappears, the capture thread reconnects with exponential backoff while the API and retry worker remain alive.

## Tests

```bash
npm run check:voice
```

The Python suite verifies event restart recovery, PCM crash recovery, open-spool snapshots, partial-wake ownership and exactly-once cueing, endpoint fallback, journal rollover, wake/arming semantics, VAD and hard-length continuation, pending-command durability, typed intents, acoustic-confidence guards, and durable failed jobs. The Node suite verifies composer insertion deduplication, separate emotion context, running-session priority, and uncertain-dispatch recovery.
