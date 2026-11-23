/**
 * Attendee (github.com/attendee-labs/attendee): a self-hosted meeting bot with a Recall-like REST
 * API. It joins Zoom / Google Meet / Teams and posts one webhook per finalized utterance, with the
 * participant's real name. With `meeting_closed_captions` it transcribes from the platform's own
 * captions, so no speech-to-text key is needed.
 *
 *   POST {base}/api/v1/bots                 create (transcription_settings + per-bot webhooks)
 *   GET  {base}/api/v1/bots/{id}            status (state, transcription_state)
 *   POST {base}/api/v1/bots/{id}/leave      leave
 *   Authorization: Token <ATTENDEE_API_KEY>
 *
 * Webhooks (checked against Attendee v1.98.1 source, bots/webhook_payloads.py and
 * bots/tasks/deliver_webhook_task.py):
 *   {idempotency_key, bot_id, bot_metadata, trigger, data}
 *   transcript.update            data: {speaker_name, speaker_uuid, speaker_user_uuid, speaker_is_host,
 *                                       timestamp_ms (epoch), duration_ms, transcription: {transcript} | null}
 *   participant_events.join_leave data: {participant_name, participant_uuid, event_type: join|leave, timestamp_ms, ...}
 *   bot.state_change             data: {new_state, old_state, event_type, event_sub_type, created_at}
 * Signature: X-Webhook-Signature = base64(HMAC-SHA256(base64decode(project secret),
 *   json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")))).
 * It signs a canonical re-serialization, not the raw bytes, so we verify against the same.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ATTENDEE_WEBHOOK_PATH = "/api/attendee/webhook/";

export type AttendeeTranscription = "captions" | "openai" | "deepgram";

export interface AttendeeConfig {
  apiKey: string | null;
  baseUrl: string;
  /** Project webhook secret (Settings -> Webhooks in Attendee's UI), base64. Optional. */
  webhookSecret: string | null;
  /**
   * "captions" (free, the platform's own captions), or real speech-to-text on each
   * participant's own audio: "openai" (gpt-4o-transcribe) or "deepgram". The provider key is
   * stored in Attendee (Settings -> Credentials), not here. Names come from the call either way.
   */
  transcription: AttendeeTranscription;
  /** Overrides the base URL Attendee posts webhooks to (e.g. http://host.docker.internal:8787). */
  webhookBaseUrl: string | null;
  language: string | null;
}

export function attendeeConfig(env: NodeJS.ProcessEnv = process.env): AttendeeConfig {
  const t = env.ATTENDEE_TRANSCRIPTION?.trim().toLowerCase();
  return {
    apiKey: env.ATTENDEE_API_KEY?.trim() || null,
    baseUrl: (env.ATTENDEE_BASE_URL?.trim() || "http://localhost:8000").replace(/\/+$/, ""),
    webhookSecret: env.ATTENDEE_WEBHOOK_SECRET?.trim() || null,
    transcription: t === "deepgram" || t === "openai" ? t : "captions",
    webhookBaseUrl: env.ATTENDEE_WEBHOOK_BASE_URL?.trim().replace(/\/+$/, "") || null,
    language: env.ATTENDEE_LANGUAGE?.trim() || null,
  };
}

export const ATTENDEE_TRIGGERS = ["transcript.update", "participant_events.join_leave", "bot.state_change"] as const;

export function attendeeCreateBotPayload(opts: {
  meetingUrl: string;
  botName: string;
  webhookUrl: string;
  transcription?: AttendeeTranscription;
  language?: string | null;
}) {
  const isZoom = /(^|\.)zoom(gov)?\.(us|com)$/i.test(safeHost(opts.meetingUrl));
  const lang = opts.language ?? null;
  const transcription_settings =
    opts.transcription === "deepgram"
      ? { deepgram: { language: lang ?? "en" } }
      : opts.transcription === "openai"
        ? { openai: { model: process.env.ATTENDEE_OPENAI_MODEL?.trim() || "gpt-4o-transcribe", ...(lang ? { language: lang.split("-")[0]!.toLowerCase() } : {}) } }
        : {
          meeting_closed_captions: {
            // e.g. ATTENDEE_LANGUAGE=en-US -> google_meet_language "en-US", teams_language "en-us".
            ...(lang ? { google_meet_language: lang, teams_language: lang.toLowerCase() } : {}),
          },
        };
  return {
    meeting_url: opts.meetingUrl,
    bot_name: opts.botName,
    transcription_settings,
    // We only need the transcript; "none" also avoids needing S3/Azure storage on a self-hosted instance.
    recording_settings: { format: "none" },
    // Zoom closed captions need Attendee's web adapter (the native SDK needs Zoom app credentials).
    ...(isZoom && (opts.transcription ?? "captions") === "captions" ? { zoom_settings: { sdk: "web" } } : {}),
    webhooks: [{ url: opts.webhookUrl, triggers: [...ATTENDEE_TRIGGERS] }],
    metadata: { source: "meeting-whiteboard" },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export class AttendeeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AttendeeBot {
  id: string;
  meeting_url?: string;
  state?: string;
  transcription_state?: string;
  recording_state?: string;
  events?: { type: string; sub_type?: string | null; created_at: string }[];
}

export class AttendeeClient {
  constructor(
    private cfg: AttendeeConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cfg.apiKey) throw new AttendeeError("ATTENDEE_API_KEY is not set", 400);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Token ${this.cfg.apiKey}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new AttendeeError(`cannot reach Attendee at ${this.cfg.baseUrl} (${(e as Error).message}); is its docker compose stack up?`, 502);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      const hint = res.status === 401 || res.status === 403 ? " (check ATTENDEE_API_KEY: create one under API Keys in Attendee's UI)" : "";
      throw new AttendeeError(`Attendee API ${method} ${path} -> ${res.status}: ${detail.slice(0, 400)}${hint}`, res.status);
    }
    return data as T;
  }

  createBot(opts: { meetingUrl: string; botName: string; webhookUrl: string }) {
    return this.call<AttendeeBot>(
      "POST",
      "/bots",
      attendeeCreateBotPayload({ ...opts, transcription: this.cfg.transcription, language: this.cfg.language }),
    );
  }

  getBot(id: string) {
    return this.call<AttendeeBot>("GET", `/bots/${encodeURIComponent(id)}`);
  }

  leave(id: string) {
    return this.call<AttendeeBot>("POST", `/bots/${encodeURIComponent(id)}/leave`);
  }
}

const STATE_LABELS: Record<string, string> = {
  ready: "Ready",
  scheduled: "Scheduled",
  staged: "Staged, about to join",
  joining: "Joining the call…",
  waiting_room: "In the waiting room: admit the bot",
  joined_not_recording: "In the call (not transcribing yet)",
  joined_recording: "In the call, transcribing",
  joined_recording_paused: "In the call (paused)",
  joined_recording_permission_denied: "Recording permission denied by the host",
  joining_breakout_room: "Joining a breakout room…",
  leaving_breakout_room: "Leaving a breakout room…",
  leaving: "Leaving the call…",
  post_processing: "Call ended, finishing up",
  ended: "Call ended",
  fatal_error: "Failed",
  data_deleted: "Ended (data deleted)",
};

/** Same shape as Recall's botStatus so the UI does not care which provider it is. */
export function attendeeBotStatus(bot: AttendeeBot): { code: string; label: string; subCode: string | null; message: string | null } {
  const code = bot.state ?? "joining";
  const last = bot.events?.at(-1);
  return {
    code,
    label: STATE_LABELS[code] ?? code.replace(/_/g, " "),
    subCode: last?.sub_type ?? null,
    message: bot.transcription_state === "failed" ? "transcription failed" : null,
  };
}

// ---------------------------------------------------------------------------------
// Webhook events

interface AttendeeEnvelope {
  idempotency_key?: string;
  bot_id?: string;
  trigger?: string;
  data?: Record<string, unknown> | null;
}

export interface AttendeeUtterance {
  botId: string | null;
  speaker: string;
  text: string;
  /** Epoch seconds of the utterance start, and its end. */
  start: number | null;
  end: number | null;
  /** Stable per utterance: Attendee re-sends an utterance when a caption is revised. */
  key: string;
}

export function attendeeEventBotId(body: unknown): string | null {
  const id = (body as AttendeeEnvelope)?.bot_id;
  return typeof id === "string" ? id : null;
}

/** transcript.update -> one utterance (null for other triggers or an empty transcript). */
export function mapAttendeeTranscript(body: unknown): AttendeeUtterance | null {
  const b = body as AttendeeEnvelope;
  if (b?.trigger !== "transcript.update" || !b.data) return null;
  const d = b.data as {
    speaker_name?: string | null;
    speaker_uuid?: string | null;
    timestamp_ms?: number | null;
    duration_ms?: number | null;
    transcription?: { transcript?: string | null } | null;
  };
  const text = (d.transcription?.transcript ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const speaker = d.speaker_name?.trim() || (d.speaker_uuid ? `Participant ${String(d.speaker_uuid).slice(0, 8)}` : "Unknown speaker");
  const start = typeof d.timestamp_ms === "number" ? d.timestamp_ms / 1000 : null;
  const end = start !== null && typeof d.duration_ms === "number" ? start + d.duration_ms / 1000 : start;
  return {
    botId: attendeeEventBotId(body),
    speaker,
    text,
    start,
    end,
    key: `${d.speaker_uuid ?? speaker}:${d.timestamp_ms ?? b.idempotency_key ?? text}`,
  };
}

/** participant_events.join_leave -> {kind, name}. */
export function mapAttendeeParticipant(body: unknown): { kind: "join" | "leave"; name: string; botId: string | null } | null {
  const b = body as AttendeeEnvelope;
  if (!b?.trigger?.startsWith("participant_events.") || !b.data) return null;
  const d = b.data as { participant_name?: string | null; event_type?: string };
  const kind = d.event_type === "join" ? "join" : d.event_type === "leave" ? "leave" : null;
  const name = d.participant_name?.trim();
  if (!kind || !name) return null;
  return { kind, name, botId: attendeeEventBotId(body) };
}

/** bot.state_change -> the new state, to refresh the cached status without polling. */
export function mapAttendeeStateChange(body: unknown): { state: string; eventType: string | null; subType: string | null } | null {
  const b = body as AttendeeEnvelope;
  if (b?.trigger !== "bot.state_change" || !b.data) return null;
  const d = b.data as { new_state?: string; event_type?: string | null; event_sub_type?: string | null };
  if (!d.new_state) return null;
  return { state: d.new_state, eventType: d.event_type ?? null, subType: d.event_sub_type ?? null };
}

// ---------------------------------------------------------------------------------
// Signature

/** Python's json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return String(value);
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  // Python sorts by code point; JS default sort compares UTF-16 units, the same for BMP keys.
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function signAttendeeWebhook(secretB64: string, payload: unknown): string {
  return createHmac("sha256", Buffer.from(secretB64, "base64")).update(canonicalJson(payload), "utf8").digest("base64");
}

/** Throws with a reason when the request must be rejected. */
export function verifyAttendeeSignature(secretB64: string, signature: string | undefined, payload: unknown): void {
  if (!signature) throw new Error("missing X-Webhook-Signature header");
  const expected = Buffer.from(signAttendeeWebhook(secretB64, payload));
  const got = Buffer.from(signature.trim());
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error("signature does not match");
}
