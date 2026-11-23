# Live sources

Every input reaches the agent the same way: `MeetingSession.addUtterance({ speaker, text, t })`. Four sources feed it:

| Source | Speaker names | Needs |
|---|---|---|
| Transcript file (replay) | from the file | nothing |
| Microphone | Detected speakers ("Speaker 1", ... renamable), or the name picked in **Speaking now**; "Mic" when neither | `OPENAI_API_KEY` |
| Meeting tab audio (Meet / Zoom web / Teams web in Chrome or Edge) | Detected speakers, or the name picked in **Speaking now**; "Meeting" when neither; with "tab + my mic", your own lines are labelled with your name | `OPENAI_API_KEY` |
| Meeting bot (Recall.ai) | real participant names from the meeting platform | `RECALL_API_KEY`, a public URL |
| Meeting bot (Attendee, self-hosted) | real participant names; per-person speech-to-text | Attendee in Docker on the same machine, `ATTENDEE_API_KEY`, an OpenAI key in Attendee's Credentials; no tunnel |

## Transcript files

Paste or upload in the UI, or put the file in `transcripts/`. The format is detected from the content. Accepted formats:

- Zoom `.vtt` (`Name: text` cues), Microsoft Teams `.vtt` (`<v Name>` voice tags), other WebVTT captions
- `.srt` subtitles (speakers from `Name:`, `[Name]`, `- Name:` prefixes when present)
- Zoom chat export (`10:02:33 From Ana to Everyone: ...`, old and new layouts; private messages are skipped)
- Otter.ai `.txt` (`Ana Lima  0:03` then the paragraph), Fireflies / Rev style (`Ana - 00:03`, `Ana (00:00:03):`), name and time on separate lines
- Google Meet transcript (Docs export: `00:05:00` markers and `Ana: ...` lines)
- `[00:01:10] Ana: ...` lines, JSONL / JSON (including wrapped exports and Recall word lists), markdown tables
- Plain `Ana: ...` lines with no times

Caption cues from the same speaker less than 2 s apart are merged into one utterance. When a source has no times, or only coarse markers (Google Meet), times are estimated at about 2.5 words per second. Those utterances carry `synthetic: true`, and the UI shows "times estimated". If nothing parses, the error lists the supported formats.

## Live audio from the browser

Choose **Microphone**, **Meeting tab audio** or **Meeting tab + my mic** next to **Go live**. For tab audio, pick the meeting's tab in Chrome's share dialog and turn on **Also share tab audio**. Use headphones with "tab + my mic", or the mic will pick up the meeting a second time.

```
browser: getUserMedia / getDisplayMedia
  -> AudioWorklet: mono, resampled to 24 kHz PCM16, 100 ms chunks
  -> ws://localhost:8787/api/live/audio?session=…&source=mic|meeting   (Origin checked)
server (src/live/audioRelay.ts)
  -> wss://api.openai.com/v1/realtime?intent=transcription          (key stays on the server)
     session.update { type: "transcription", model gpt-4o-transcribe, server_vad, 700 ms silence }
  <- conversation.item.input_audio_transcription.delta / .completed
  -> session.addUtterance({ speaker, text, t })
```

Realtime transcription does not tell speakers apart, so the server adds automatic speaker labels (next section). The **Speaking now** chips override them: click a name or press keys 1–9, and 0 to go back to automatic ("Auto", or the source label when diarization is off). A line gets the name that was selected when the line started, with 1 s of grace for a late click. Each source has its own transcription stream, so in "tab + my mic" mode your lines and the meeting's lines are always told apart. If OpenAI closes a session (sessions have a maximum length), the server opens a new one on the same audio clock.

**Model choice.** I compared five models on synthesized meeting speech, clean and with pink noise, streamed in real time:

| Model | Turn detection | Clean audio | Noisy audio | Delay after speech ends |
|---|---|---|---|---|
| gpt-4o-transcribe | server VAD | verbatim | verbatim, whole sentences | ~0.8 s |
| gpt-4o-mini-transcribe | server VAD | verbatim | verbatim, whole sentences | ~0.7 s |
| gpt-transcribe | server VAD | verbatim | (not tested) | similar |
| gpt-live-transcribe | local VAD (the model takes no server VAD) | verbatim | splits sentences, one misheard phrase | ~1.4 s |
| gpt-realtime-whisper | local VAD | verbatim | (not tested) | similar |

The default is `gpt-4o-transcribe` with server VAD: it was as fast as the others and held sentence boundaries in noise. `TRANSCRIBE_MODEL` overrides it. `gpt-4o-mini-transcribe` costs half as much. For `gpt-live-transcribe` and `gpt-realtime-whisper`, the server runs its own energy VAD and commits turns itself.

### Automatic speaker labels (diarization)

On by default when `OPENAI_API_KEY` is set; `DIARIZE=0` turns it off. Code: `src/live/diarize.ts`, used by `src/live/audioRelay.ts`.

1. The relay keeps the last 3 minutes of each source's audio (24 kHz PCM16) and the span of each turn from the realtime server VAD (`speech_started.audio_start_ms` / `speech_stopped.audio_end_ms`).
2. When a turn's transcript completes, its audio (±200 ms) is wrapped as WAV and sent to `POST /v1/audio/transcriptions` with `model=gpt-4o-transcribe-diarize`, `response_format=diarized_json`, `chunking_strategy=auto`. The text still comes from the realtime transcript; only the segments' speakers are used, and the turn gets the speaker with the most speaking time.
3. Enrolment: the first time a voice comes back that is not a known speaker, 2–10 s of it from that turn is saved as its reference and named "Speaker 1", "Speaker 2", ... (max 4 per session, shared by the session's sources). Known voices are passed on every later call so labels stay the same for the whole meeting.
4. Two ways to pass known voices (`DIARIZE_MODE`):
   - `refs` (default): the API's `known_speaker_names[]` + `known_speaker_references[]` (data URLs). In the TTS demo it passed 2 of 3 full runs; the failure was a new voice's first line being matched to an existing similar voice (nova labelled as alloy's "Speaker 1").
   - `context`: the first 4 s of each reference is put ahead of the turn in the same file (600 ms gaps) and the labels the model gives the reference spans are mapped back to names. It separated the voices correctly in every labelled line we saw, but re-sends the references every turn: 7–11 s per call with 3 speakers, so many lines hit the timeout.
5. The line is added once diarization answers, in order. If it takes longer than `DIARIZE_TIMEOUT_MS` (default 8 s) or fails, the line gets the **Speaking now** / source label so lines never get stuck. Calls run in parallel; a call that returns an unknown voice after another call enrolled someone is retried once with the new references, so one voice is not enrolled twice.
6. Renaming: detected speakers appear as chips; the pencil on a chip renames it ("Speaker 1" -> "Lena"). The name is used for future lines (it replaces the known speaker's name) and past transcript lines are rewritten (`MeetingSession.renameSpeaker`); doc items keep their text. Over the WebSocket: `{"type":"rename","from","to"}`.
7. A name picked in **Speaking now** wins over detection (and that turn is not sent for diarization).

Latency and cost: diarization adds about 4–5 s per turn in `refs` mode (measured median 4.6 s, max 5.3 s; the API's own processing time, so a 4 s timeout would drop most labels) and 7–11 s in `context` mode, on top of the realtime transcript. gpt-4o-transcribe-diarize is billed per audio minute like gpt-4o-transcribe; `context` mode re-sends up to 4 × 10 s of references per turn, so it costs up to a few times the meeting's audio length.

Limits: at most 4 enrolled speakers (a fifth voice gets the fallback label); a turn whose new voice speaks less than 2 s is not enrolled and gets the fallback label; overlapping speech and short interjections inside one turn are attributed to the turn's majority speaker; similar voices can still be merged; the per-session voice registry lives in memory (a server restart starts from "Speaker 1" again); renames are not written back to the saved `transcript.jsonl`.

### Testing without a microphone

`pnpm live:demo` synthesizes a six-line, three-voice meeting with OpenAI TTS (alloy, onyx, nova; cached in `out/live-demo-audio`), streams it through the real relay (in-process; `--server URL` uses a running server instead) over the same WebSocket the browser uses, renames the first detected speaker, and checks that every line was transcribed, each voice kept one label, different voices got different labels and the rename rewrote past lines. `--chips` runs the older check that switches the "speaking now" label instead. About $0.02 per run.

## Meeting bot (Recall.ai)

1. Put `RECALL_API_KEY` and `RECALL_REGION` (the region the key was created in) in `.env`.
2. Recall must reach this server over HTTPS. Choose one:
   - leave `PUBLIC_URL` unset. If `cloudflared` is installed, the server starts a quick tunnel when it boots and logs `public tunnel for Recall webhooks: https://….trycloudflare.com`;
   - or run `cloudflared tunnel --url http://localhost:8787` yourself and set `PUBLIC_URL` to the URL it prints.

   To install cloudflared: on macOS, `brew install cloudflared`. On Linux, use the package or binary from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.
3. In the UI, choose **Bot joins a meeting**, then **Go live**, paste a Meet / Zoom / Teams link and click **Send bot**. Admit the bot if the meeting has a waiting room.

The server creates the bot with `recording_config.transcript.provider.recallai_streaming` (`prioritize_low_latency`, English) and a `realtime_endpoints` webhook for `transcript.data` and `participant_events.join/leave`. Each finalized utterance becomes one transcript line with the participant's name. Recall's relative timestamps are aligned to the meeting clock. The UI polls `GET /api/bot/:id` for status: joining, waiting room, in call, ended. **Remove bot** calls `leave_call`.

API:

```
POST   /api/bot        {meeting_url, bot_name?, session_id?}  -> {bot, sessionId}
GET    /api/bot/:id    status from Recall + lines received + participants
DELETE /api/bot/:id    the bot leaves the call
POST   /api/recall/webhook/?token=…   Recall realtime events
```

**Webhook security.** Each bot gets a random 192-bit token in its webhook URL, compared in constant time. If `RECALL_WEBHOOK_SECRET` (`whsec_…`) is set, the `webhook-id` / `webhook-timestamp` / `webhook-signature` headers must also verify: HMAC-SHA256 over `id.timestamp.body`, with a 5-minute window. While a tunnel is open, any request that came through it (detected by forwarding headers or a non-loopback Host) can reach only the webhook. The UI, the API, the static files and the audio WebSocket answer 403.

Test without a Recall account: `pnpm recall:sim` (a stand-in for Recall's API on :9911), then start the server with `RECALL_API_KEY=sim RECALL_BASE_URL=http://127.0.0.1:9911 pnpm start` and send a bot to any meeting link. The simulator delivers `participant_events.join` and `transcript.data` events, with the payload shapes from Recall's docs, to the webhook URL, through the real tunnel.

## Meeting bot (self-hosted Attendee)

Instead of Recall.ai, a bot can come from [Attendee](https://github.com/attendee-labs/attendee), which you run yourself in Docker, **on the same machine as this app**. The bot joins the call as a guest and transcribes each participant's own audio, so every line has the speaker's real name. The app **pulls** the transcript from Attendee every 2.5 s, so with Attendee on the same machine no tunnel or public URL is needed.

Pick the provider with `BOT_PROVIDER=recall|attendee` in `.env`. When `BOT_PROVIDER` is unset, the server uses whichever provider has a key, trying Recall first. The **Join a meeting** panel shows which one is active.

**Licence.** Attendee is source-available under the Elastic License 2.0, not an OSI open-source licence. You may self-host it for your own use. You may not offer it to others as a hosted service.

### Set it up on this machine (about 15 minutes, mostly the build)

You need Docker with Compose and about 8 GB of free RAM (each bot runs a Chrome instance). Attendee publishes no image, so build it from the tag this was tested against, v1.98.1:

```bash
git clone --depth 1 --branch v1.98.1 https://github.com/attendee-labs/attendee.git && cd attendee
# Fix for Docker Compose: when Google refuses a guest join, retry the bot instead of
# calling Attendee's Kubernetes-only pod restart (which crashes under Compose).
git apply ../meeting-whiteboard/docs/attendee/compose-blocked-retry.patch   # path to this repo
docker compose -f dev.docker-compose.yaml build                                         # ~5 min
docker compose -f dev.docker-compose.yaml run --rm attendee-app-local python init_env.py > .env
docker compose -f dev.docker-compose.yaml up -d                     # app on :8000, worker, scheduler, Postgres, Redis
docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
```

Then, in Attendee's UI:

1. Open http://localhost:8000 and sign up. The confirmation link is printed in the app log: `docker compose -f dev.docker-compose.yaml logs attendee-app-local | grep confirm-email`.
2. **API Keys** → create a key. Put it in this project's `.env` as `ATTENDEE_API_KEY`.
3. **Settings → Credentials → OpenAI** → paste an OpenAI API key. Attendee uses it to transcribe each participant with `gpt-4o-transcribe` (about $0.006 per minute). The key is stored encrypted in Attendee's database.

And in this project's `.env`:

```bash
BOT_PROVIDER=attendee
ATTENDEE_API_KEY=...                      # from step 2
ATTENDEE_TRANSCRIPTION=openai             # or deepgram (key in Attendee's Credentials), or captions (free, rougher)
# ATTENDEE_BASE_URL=http://localhost:8000 # the default
```

Restart `pnpm start`, open **Join a meeting**, paste a Google Meet link and press **Send bot**. Admit the bot when Meet asks (it joins as a guest). Lines appear a second or two after each speaker pauses.

Platforms:

- **Google Meet and Teams** work as they are.
- **Zoom** bots need Zoom app (Meeting SDK) OAuth credentials, entered under Attendee's **Settings**. See Attendee's README.

### How the app talks to Attendee

- **Create / status / leave:** `POST /api/v1/bots`, `GET /api/v1/bots/{id}`, `POST /api/v1/bots/{id}/leave`. A bot stuck joining is recreated once after `BOT_JOIN_TIMEOUT_MS` (5 min), then marked failed with the reason.
- **Transcript (source of truth):** `GET /api/v1/bots/{id}/transcript?updated_after=...` every `BOT_POLL_MS` (2.5 s). Lines are keyed by speaker and start time, so overlapping polls and webhooks never duplicate a line, and a missed poll is caught up by the next.
- **Webhooks (optional fast path):** on by default only when Attendee is on another machine (`ATTENDEE_WEBHOOKS=on|off` overrides). Attendee requires https webhook URLs, so they go through `PUBLIC_URL` or an automatic cloudflared quick tunnel, to `https://<public>/api/attendee/webhook/?token=<per-bot token>`.
- **Failures:** calls retry when the request certainly never reached Attendee (no connection, or a tunnel error page), so a bot is never created twice. `ATTENDEE_BASE_URL` may list several comma-separated routes to the same Attendee; the client fails over between them. That is how the author ran Attendee on a separate server through quick tunnels; on one machine you need none of it.

**Events → transcript.** One `transcript.update` becomes one transcript line: `data.speaker_name` and `data.transcription.transcript`, with `timestamp_ms` (epoch) aligned to the meeting clock like Recall's timestamps. With speech-to-text, each line arrives once, final. In captions mode a line grows under one key, so the app keeps the newest text and adds the line once it settles (`CAPTION_SETTLE_MS`, 1.8 s) or the speaker starts a new one. A repeat of a line already added (same speaker uuid and `timestamp_ms`) is dropped.

**Webhook security.** The per-bot 192-bit token in the URL is always checked, the same as for Recall. If `ATTENDEE_WEBHOOK_SECRET` is set, `X-Webhook-Signature` must also equal base64(HMAC-SHA256(base64-decoded secret, canonical JSON)). Canonical JSON is Python's `json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`. Attendee signs a re-serialization, not the raw body, and there is no timestamp. A test checks the signature byte for byte against Attendee's own Python signer. `/api/attendee/webhook/` is the only other path reachable through the tunnel.

**Test without Docker:**

```bash
pnpm attendee:sim     # stand-in for Attendee's API on :9912
BOT_PROVIDER=attendee ATTENDEE_API_KEY=sim ATTENDEE_BASE_URL=http://127.0.0.1:9912 pnpm start
```

Then send a bot to any meeting link. The simulator delivers `bot.state_change`, `participant_events.join_leave` and `transcript.update` with Attendee's envelope. It signs them when `ATTENDEE_WEBHOOK_SECRET` is set in both processes.

**Why Attendee over Vexa.** [Vexa](https://github.com/Vexa-ai/vexa) is Apache-2.0 and publishes images. As of v0.12.28 it has no realtime transcript push: its WebSocket feed is "planned", and clients poll `GET /transcripts/{platform}/{id}`. It also needs a Whisper service, on a GPU, a slow CPU box, or a hosted token. Attendee pushes each utterance as it is finalized and can use free meeting captions. The `BotProvider` interface in `src/live/bots.ts` leaves room for a Vexa adapter, which would poll.

## Server rules

- The server binds to 127.0.0.1.
- `/api/*` POSTs must be JSON and same-origin when an Origin is sent. DELETE is origin-checked too.
- The audio WebSocket requires a same-origin (or localhost) `Origin` and an existing session.
- At most 4 audio streams run at once.
- The Recall and Attendee webhooks are the only paths exempt from the JSON and origin checks. They are protected as described above.
