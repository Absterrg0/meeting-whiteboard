# Live sources

Every input reaches the agent the same way: `MeetingSession.addUtterance({ speaker, text, t })`. Four sources feed it:

| Source | Speaker names | Needs |
|---|---|---|
| Transcript file (replay) | from the file | nothing |
| Microphone | "Mic", or the name picked in **Speaking now** | `OPENAI_API_KEY` |
| Meeting tab audio (Meet / Zoom web / Teams web in Chrome or Edge) | "Meeting", or the name picked in **Speaking now**; with "tab + my mic", your own lines are labelled with your name | `OPENAI_API_KEY` |
| Meeting bot (Recall.ai) | real participant names from the meeting platform | `RECALL_API_KEY`, a public URL |
| Meeting bot (Attendee, self-hosted) | real participant names from the meeting platform | an Attendee instance in Docker, `ATTENDEE_API_KEY`, a public URL (or `ATTENDEE_WEBHOOK_BASE_URL`) |

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

Realtime transcription does not tell speakers apart. The **Speaking now** chips set the speaker for the next lines: click a name or press keys 1–9, and 0 to go back to the source label. A line gets the name that was selected when the line started, with 1 s of grace for a late click. Each source has its own transcription stream, so in "tab + my mic" mode your lines and the meeting's lines are always told apart. If OpenAI closes a session (sessions have a maximum length), the server opens a new one on the same audio clock.

**Model choice.** I compared five models on synthesized meeting speech, clean and with pink noise, streamed in real time:

| Model | Turn detection | Clean audio | Noisy audio | Delay after speech ends |
|---|---|---|---|---|
| gpt-4o-transcribe | server VAD | verbatim | verbatim, whole sentences | ~0.8 s |
| gpt-4o-mini-transcribe | server VAD | verbatim | verbatim, whole sentences | ~0.7 s |
| gpt-transcribe | server VAD | verbatim | (not tested) | similar |
| gpt-live-transcribe | local VAD (the model takes no server VAD) | verbatim | splits sentences, one misheard phrase | ~1.4 s |
| gpt-realtime-whisper | local VAD | verbatim | (not tested) | similar |

The default is `gpt-4o-transcribe` with server VAD: it was as fast as the others and held sentence boundaries in noise. `TRANSCRIBE_MODEL` overrides it. `gpt-4o-mini-transcribe` costs half as much. For `gpt-live-transcribe` and `gpt-realtime-whisper`, the server runs its own energy VAD and commits turns itself.

Test without a microphone: `pnpm start`, then `pnpm live:demo`. It synthesizes a four-line meeting with OpenAI TTS (or espeak-ng), streams it through the same WebSocket the browser uses while switching the "speaking now" label, and checks the session transcript. It costs under $0.01.

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

Instead of Recall.ai, a bot can come from [Attendee](https://github.com/attendee-labs/attendee), which you run yourself in Docker. Its REST API is close to Recall's: it posts one webhook per finished utterance, with the speaker's name. By default it transcribes from the meeting's own closed captions, so you need no speech-to-text key.

Pick the provider with `BOT_PROVIDER=recall|attendee` in `.env`. When `BOT_PROVIDER` is unset, the server uses whichever provider has a key, trying Recall first. The **Join a meeting** panel shows which one is active. A `POST /api/bot` body can also pass `"provider": "attendee"` for one bot.

**Licence.** Attendee is source-available under the Elastic License 2.0, not an OSI open-source licence. You may self-host it for your own use. You may not offer it to others as a hosted service.

### Run Attendee

Attendee publishes no Docker image, so build it from a pinned tag. This was written against v1.98.1, released 2026-11-20. The build takes about 5 minutes, and each bot runs a Chrome instance, so use a machine with at least 8 GB of RAM.

```bash
git clone --depth 1 --branch v1.98.1 https://github.com/attendee-labs/attendee.git && cd attendee
docker compose -f dev.docker-compose.yaml build
docker compose -f dev.docker-compose.yaml run --rm attendee-app-local python init_env.py > .env   # CREDENTIALS_ENCRYPTION_KEY, DJANGO_SECRET_KEY
docker compose -f dev.docker-compose.yaml up -d                     # app on :8000, Celery worker, scheduler, Postgres 15.3, Redis 7
docker compose -f dev.docker-compose.yaml exec attendee-app-local python manage.py migrate
```

1. Open http://localhost:8000 and sign up. The confirmation link is printed in the app log: `docker compose -f dev.docker-compose.yaml logs attendee-app-local | grep confirm-email`.
2. Under **API Keys**, create a key and put it in this project's `.env` as `ATTENDEE_API_KEY`.
3. Optional: copy the secret from **Settings → Webhooks** into `ATTENDEE_WEBHOOK_SECRET` so signatures are checked too.
4. You do not need the AWS variables in Attendee's `.env`. Bots are created with `recording_settings.format: "none"`, so nothing is uploaded.

Platforms:

- **Google Meet and Teams** work with captions as they are.
- **Zoom** bots need Zoom app (Meeting SDK) OAuth credentials, entered under Attendee's **Settings**. See Attendee's README. For captions on Zoom, the server sends `zoom_settings.sdk: "web"`.
- **Other providers.** `ATTENDEE_TRANSCRIPTION=deepgram` uses a Deepgram key stored in Attendee's Settings instead of captions. It has a free tier.

### Connect this server

```bash
# .env of this project
BOT_PROVIDER=attendee
ATTENDEE_API_KEY=...                      # from Attendee's UI
ATTENDEE_BASE_URL=http://localhost:8000   # default
# ATTENDEE_WEBHOOK_SECRET=...             # optional, Settings -> Webhooks
# ATTENDEE_LANGUAGE=en-US                 # optional caption language (Meet code; lower-cased for Teams)
```

Attendee requires https webhook URLs. It also runs inside Docker, so it cannot reach this server's loopback port. For both reasons, webhooks use the same public URL as Recall: `PUBLIC_URL`, or the automatic cloudflared quick tunnel. Each bot is created with:

- `transcription_settings.meeting_closed_captions`;
- one per-bot webhook, `https://<public>/api/attendee/webhook/?token=<per-bot token>`, for `transcript.update`, `participant_events.join_leave` and `bot.state_change`.

The status, waiting-room and **Remove bot** behaviour is the same as for Recall. **Remove bot** calls `POST /api/v1/bots/{id}/leave`.

To skip the tunnel, Attendee needs a way to reach this server directly. For example:

1. Set `REQUIRE_HTTPS_WEBHOOKS=false` in Attendee's `.env`.
2. Run this server with `HOST=0.0.0.0`.
3. Set `ATTENDEE_WEBHOOK_BASE_URL=http://host.docker.internal:8787`. On Linux, also add `extra_hosts: ["host.docker.internal:host-gateway"]` to Attendee's worker service.

Only do this on a trusted network. With `HOST=0.0.0.0`, the whole UI is reachable from the LAN.

**Events → transcript.** One `transcript.update` becomes one transcript line: `data.speaker_name` and `data.transcription.transcript`, with `timestamp_ms` (epoch) aligned to the meeting clock like Recall's timestamps. Attendee sends caption utterances only once they are final. If it sends an utterance again, the duplicate is dropped. That covers a retried delivery, or a caption revised after it was final. A duplicate is the same speaker uuid with the same `timestamp_ms`.

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
