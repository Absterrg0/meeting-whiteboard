/**
 * A Recall.ai bot that joins a real Zoom / Google Meet / Teams call and streams the
 * transcript back to us, one finalized utterance per webhook, with real participant names.
 *
 *   POST {region}.recall.ai/api/v1/bot/                 create (recording_config.transcript + realtime_endpoints)
 *   GET  {region}.recall.ai/api/v1/bot/{id}/            status (status_changes[])
 *   POST {region}.recall.ai/api/v1/bot/{id}/leave_call/ leave
 *   Authorization: Token <RECALL_API_KEY>
 *
 * Webhook authenticity, two layers:
 *  1. Every bot gets its own random token in the realtime endpoint URL (?token=...), compared
 *     in constant time. This needs no dashboard setup.
 *  2. If RECALL_WEBHOOK_SECRET (the workspace verification secret, whsec_...) is set, the
 *     webhook-id / webhook-timestamp / webhook-signature headers are verified as well
 *     (HMAC-SHA256 over "id.timestamp.body", base64), with a 5-minute replay window.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RECALL_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"] as const;
export const WEBHOOK_PATH = "/api/recall/webhook/";
const REPLAY_WINDOW_SEC = 5 * 60;

export interface RecallConfig {
  apiKey: string | null;
  region: string;
  baseUrl: string;
  webhookSecret: string | null;
}

export function recallConfig(env: NodeJS.ProcessEnv = process.env): RecallConfig {
  const region = (env.RECALL_REGION || "us-east-1").trim();
  return {
    apiKey: env.RECALL_API_KEY?.trim() || null,
    region,
    baseUrl: (env.RECALL_BASE_URL?.trim() || `https://${region}.recall.ai`).replace(/\/+$/, ""),
    webhookSecret: env.RECALL_WEBHOOK_SECRET?.trim() || null,
  };
}

/** Meeting links Recall can join. */
export function meetingPlatform(url: string): "google_meet" | "zoom" | "teams" | "webex" | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "meet.google.com") return "google_meet";
  if (h === "zoom.us" || h.endsWith(".zoom.us") || h.endsWith(".zoomgov.com")) return "zoom";
  if (h === "teams.microsoft.com" || h === "teams.live.com" || h.endsWith(".teams.microsoft.com")) return "teams";
  if (h.endsWith(".webex.com")) return "webex";
  return null;
}

export function createBotPayload(opts: { meetingUrl: string; botName: string; webhookUrl: string; language?: string }) {
  return {
    meeting_url: opts.meetingUrl,
    bot_name: opts.botName,
    recording_config: {
      transcript: {
        provider: {
          // Low-latency streaming is English-only; other languages need prioritize_accuracy (minutes of delay).
          recallai_streaming: { mode: "prioritize_low_latency", language_code: opts.language ?? "en" },
        },
        diarization: { use_separate_streams_when_available: true },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: opts.webhookUrl,
          events: ["transcript.data", "participant_events.join", "participant_events.leave"],
        },
      ],
    },
  };
}

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class RecallClient {
  constructor(
    private cfg: RecallConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.cfg.apiKey) throw new RecallError("RECALL_API_KEY is not set", 400);
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Token ${this.cfg.apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      const hint =
        res.status === 401
          ? " (check RECALL_API_KEY, and that RECALL_REGION matches the region the key was created in)"
          : res.status === 507
            ? " (Recall has no bot available right now; retry in 30 s)"
            : "";
      throw new RecallError(`Recall API ${method} ${path} -> ${res.status}: ${detail.slice(0, 400)}${hint}`, res.status);
    }
    return data as T;
  }

  createBot(opts: { meetingUrl: string; botName: string; webhookUrl: string }) {
    return this.call<RecallBot>("POST", "/bot/", createBotPayload(opts));
  }

  getBot(id: string) {
    return this.call<RecallBot>("GET", `/bot/${encodeURIComponent(id)}/`);
  }

  leaveCall(id: string) {
    return this.call<RecallBot>("POST", `/bot/${encodeURIComponent(id)}/leave_call/`);
  }
}

export interface RecallBot {
  id: string;
  meeting_url?: unknown;
  status_changes?: { code: string; message?: string | null; sub_code?: string | null; created_at: string }[];
}

/** Latest status of a bot, with a human label. */
export function botStatus(bot: RecallBot): { code: string; label: string; subCode: string | null; message: string | null } {
  const last = bot.status_changes?.at(-1);
  const code = last?.code ?? "created";
  return { code, label: STATUS_LABELS[code] ?? code.replace(/_/g, " "), subCode: last?.sub_code ?? null, message: last?.message ?? null };
}

const STATUS_LABELS: Record<string, string> = {
  created: "Created, waiting to join",
  ready: "Ready",
  joining_call: "Joining the call…",
  in_waiting_room: "In the waiting room: admit the bot",
  in_call_not_recording: "In the call (not recording yet)",
  recording_permission_allowed: "Recording permitted",
  recording_permission_denied: "Recording permission denied by the host",
  in_call_recording: "In the call, transcribing",
  call_ended: "Call ended",
  done: "Done",
  fatal: "Failed",
};

// ---------------------------------------------------------------------------------
// Realtime webhook events

export interface RecallParticipant {
  id: number | string | null;
  name: string | null;
  is_host?: boolean | null;
  platform?: string | null;
}

export interface MappedUtterance {
  botId: string | null;
  speaker: string;
  text: string;
  /** Seconds since the bot started recording. */
  start: number | null;
  end: number | null;
  /** Wall-clock ISO time of the first word, if given. */
  absolute: string | null;
  participantId: number | string | null;
}

interface Word {
  text?: string;
  start_timestamp?: { relative?: number | null; absolute?: string | null } | null;
  end_timestamp?: { relative?: number | null; absolute?: string | null } | null;
}

/** transcript.data -> one utterance (null for anything else or an empty transcript). */
export function mapTranscriptEvent(body: unknown): MappedUtterance | null {
  const b = body as { event?: string; data?: { data?: { words?: Word[]; participant?: RecallParticipant }; bot?: { id?: string } } };
  if (b?.event !== "transcript.data") return null;
  const words = b.data?.data?.words ?? [];
  const text = words
    .map((w) => (typeof w.text === "string" ? w.text.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
  if (!text) return null;
  const p = b.data?.data?.participant;
  const name = p?.name?.trim();
  const speaker = name || (p?.id !== undefined && p?.id !== null ? `Participant ${p.id}` : "Unknown speaker");
  const first = words.find((w) => typeof w.start_timestamp?.relative === "number");
  const last = [...words].reverse().find((w) => typeof w.end_timestamp?.relative === "number");
  return {
    botId: b.data?.bot?.id ?? null,
    speaker,
    text,
    start: first?.start_timestamp?.relative ?? null,
    end: last?.end_timestamp?.relative ?? null,
    absolute: first?.start_timestamp?.absolute ?? null,
    participantId: p?.id ?? null,
  };
}

/** participant_events.join / leave -> {kind, name}. */
export function mapParticipantEvent(body: unknown): { kind: "join" | "leave"; name: string; botId: string | null } | null {
  const b = body as { event?: string; data?: { data?: { participant?: RecallParticipant }; bot?: { id?: string } } };
  const kind = b?.event === "participant_events.join" ? "join" : b?.event === "participant_events.leave" ? "leave" : null;
  const name = b?.data?.data?.participant?.name?.trim();
  if (!kind || !name) return null;
  return { kind, name, botId: b.data?.bot?.id ?? null };
}

/** The bot id of any realtime event. */
export function eventBotId(body: unknown): string | null {
  return (body as { data?: { bot?: { id?: string } } })?.data?.bot?.id ?? null;
}

// ---------------------------------------------------------------------------------
// Webhook verification

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verify Recall's webhook signature headers (Standard Webhooks / Svix scheme).
 * Throws with a reason when the request must be rejected.
 */
export function verifyRecallSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  if (!secret.startsWith("whsec_")) throw new Error("RECALL_WEBHOOK_SECRET must start with whsec_");
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new Error("missing webhook signature headers");
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > REPLAY_WINDOW_SEC) throw new Error("webhook timestamp outside the allowed window");
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return;
  }
  throw new Error("no matching signature");
}

/** Sign like Recall does (used by tests and the local webhook simulator). */
export function signRecallWebhook(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
}

// ---------------------------------------------------------------------------------
// Bot registry: which bot feeds which session, and the timing offset

export interface BotRecord {
  id: string;
  sessionId: string;
  token: string;
  meetingUrl: string;
  botName: string;
  createdAt: string;
  utterances: number;
  participants: string[];
  /** meetingTime = offset + Recall relative seconds; fixed on the first transcript event. */
  offset: number | null;
  lastEventAt: string | null;
  left: boolean;
}

/**
 * Meeting time for a Recall utterance: aligned to the session clock on the first event (that
 * utterance lands "now"), then Recall's own relative timestamps keep the spacing. Clamped so the
 * transcript stays ordered and never runs ahead of the clock.
 */
export function meetingTimeFor(rec: BotRecord, u: MappedUtterance, now: number, lastT: number): number {
  if (u.start === null) return Math.max(lastT, now);
  if (rec.offset === null) rec.offset = now - (u.end ?? u.start);
  return Math.min(now, Math.max(lastT, rec.offset + u.start));
}
