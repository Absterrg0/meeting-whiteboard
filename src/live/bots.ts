/**
 * Meeting-bot providers behind one interface, so the routes do not care whether the bot is
 * Recall.ai (hosted, paid) or Attendee (self-hosted). Selected with BOT_PROVIDER=recall|attendee;
 * unset, it is whichever has a key (Recall first).
 *
 * Each provider maps its own webhook payloads to BotEvents, which routes.ts turns into
 * session.addUtterance({ speaker, text, t }).
 */
import {
  ATTENDEE_WEBHOOK_PATH,
  AttendeeClient,
  attendeeBotStatus,
  attendeeConfig,
  AttendeeError,
  attendeeEventBotId,
  mapAttendeeParticipant,
  mapAttendeeStateChange,
  mapAttendeeTranscript,
  verifyAttendeeSignature,
} from "./attendee.js";
import {
  botStatus,
  eventBotId,
  mapParticipantEvent,
  mapTranscriptEvent,
  RecallClient,
  recallConfig,
  RecallError,
  verifyRecallSignature,
  WEBHOOK_PATH,
} from "./recall.js";

export const BOT_PROVIDERS = ["recall", "attendee"] as const;
export type BotProviderId = (typeof BOT_PROVIDERS)[number];

/** Every webhook path; the only paths reachable through the tunnel (see guard.ts). */
export const BOT_WEBHOOK_PATHS = [WEBHOOK_PATH, ATTENDEE_WEBHOOK_PATH];

export interface BotStatus {
  code: string;
  label: string;
  subCode: string | null;
  message: string | null;
}

export type BotEvent =
  | {
      kind: "utterance";
      speaker: string;
      text: string;
      /** Provider clock, seconds (Recall: since recording start; Attendee: epoch). */
      start: number | null;
      end: number | null;
      /** Set when a provider can re-send the same utterance; duplicates are dropped. */
      key?: string;
      /** The text can still grow or be revised under the same key (live captions). */
      partial?: boolean;
    }
  | { kind: "participant"; action: "join" | "leave"; name: string }
  | { kind: "status"; status: BotStatus };

export class BotProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status from the provider (0 when unreachable). */
    readonly status: number,
  ) {
    super(message);
  }
}

type Headers = (name: string) => string | undefined;

export interface BotProvider {
  id: BotProviderId;
  label: string;
  configured: boolean;
  /** What to set when not configured. */
  setupHint: string;
  webhookPath: string;
  /** Base URL the provider posts webhooks to, when it differs from the public tunnel URL. */
  webhookBaseUrl?: string | null;
  /** Shown in /api/live/config. */
  info: Record<string, unknown>;
  createBot(opts: { meetingUrl: string; botName: string; webhookUrl: string }): Promise<{ id: string; status: BotStatus }>;
  status(id: string): Promise<BotStatus>;
  leave(id: string): Promise<BotStatus>;
  /** Throws when the request must be rejected (bad signature). */
  verifyWebhook(header: Headers, rawBody: string, body: unknown): void;
  botIdOf(body: unknown): string | null;
  mapEvent(body: unknown): BotEvent[];
  /** Transcript lines updated since `since` (ISO time; null = all), when the provider can be polled. */
  pollTranscript?(id: string, since: string | null): Promise<BotEvent[]>;
}

const wrap = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof RecallError || e instanceof AttendeeError) throw new BotProviderError(e.message, e.status);
    throw e;
  }
};

export function recallProvider(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): BotProvider {
  const cfg = recallConfig(env);
  const client = new RecallClient(cfg, fetchImpl);
  return {
    id: "recall",
    label: "Recall.ai",
    configured: !!cfg.apiKey,
    setupHint: "Set RECALL_API_KEY (and RECALL_REGION) in .env and restart the server to use a meeting bot.",
    webhookPath: WEBHOOK_PATH,
    info: { region: cfg.region, signature: !!cfg.webhookSecret },
    async createBot(opts) {
      const bot = await wrap(client.createBot(opts));
      return { id: bot.id, status: botStatus(bot) };
    },
    status: async (id) => botStatus(await wrap(client.getBot(id))),
    leave: async (id) => botStatus(await wrap(client.leaveCall(id))),
    verifyWebhook(header, raw) {
      if (!cfg.webhookSecret) return;
      verifyRecallSignature(
        cfg.webhookSecret,
        {
          id: header("webhook-id") ?? header("svix-id"),
          timestamp: header("webhook-timestamp") ?? header("svix-timestamp"),
          signature: header("webhook-signature") ?? header("svix-signature"),
        },
        raw,
      );
    },
    botIdOf: eventBotId,
    mapEvent(body) {
      const out: BotEvent[] = [];
      const u = mapTranscriptEvent(body);
      if (u) out.push({ kind: "utterance", speaker: u.speaker, text: u.text, start: u.start, end: u.end });
      const p = mapParticipantEvent(body);
      if (p) out.push({ kind: "participant", action: p.kind, name: p.name });
      return out;
    },
  };
}

export function attendeeProvider(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): BotProvider {
  const cfg = attendeeConfig(env);
  const client = new AttendeeClient(cfg, fetchImpl);
  return {
    id: "attendee",
    label: "Attendee (self-hosted)",
    configured: !!cfg.apiKey,
    setupHint:
      "Set ATTENDEE_API_KEY (and ATTENDEE_BASE_URL if Attendee is not on http://localhost:8000) in .env and restart the server. See docs/live-sources.md.",
    webhookPath: ATTENDEE_WEBHOOK_PATH,
    webhookBaseUrl: cfg.webhookBaseUrl,
    info: { baseUrl: cfg.baseUrl, transcription: cfg.transcription, signature: !!cfg.webhookSecret },
    async createBot(opts) {
      const bot = await wrap(client.createBot(opts));
      return { id: bot.id, status: attendeeBotStatus(bot) };
    },
    status: async (id) => attendeeBotStatus(await wrap(client.getBot(id))),
    leave: async (id) => attendeeBotStatus(await wrap(client.leave(id))),
    verifyWebhook(header, _raw, body) {
      if (!cfg.webhookSecret) return;
      verifyAttendeeSignature(cfg.webhookSecret, header("x-webhook-signature"), body);
    },
    botIdOf: attendeeEventBotId,
    async pollTranscript(id, since) {
      const rows = await wrap(client.transcript(id, since));
      const out: BotEvent[] = [];
      for (const data of rows) {
        // Same shape as a transcript.update webhook's data, so it maps (and dedupes) the same way.
        const u = mapAttendeeTranscript({ trigger: "transcript.update", bot_id: id, data });
        if (u) out.push({ kind: "utterance", speaker: u.speaker, text: u.text, start: u.start, end: u.end, key: u.key, partial: cfg.transcription === "captions" });
      }
      return out;
    },
    mapEvent(body) {
      const out: BotEvent[] = [];
      const u = mapAttendeeTranscript(body);
      if (u) out.push({ kind: "utterance", speaker: u.speaker, text: u.text, start: u.start, end: u.end, key: u.key, partial: cfg.transcription === "captions" });
      const p = mapAttendeeParticipant(body);
      if (p) out.push({ kind: "participant", action: p.kind, name: p.name });
      const s = mapAttendeeStateChange(body);
      if (s) out.push({ kind: "status", status: attendeeBotStatus({ id: "", state: s.state, events: [{ type: s.eventType ?? "", sub_type: s.subType, created_at: "" }] }) });
      return out;
    },
  };
}

export function botProviders(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Record<BotProviderId, BotProvider> {
  return { recall: recallProvider(env, fetchImpl), attendee: attendeeProvider(env, fetchImpl) };
}

/** BOT_PROVIDER wins; otherwise the first provider with a key; otherwise Recall (its setup hint is shown). */
export function selectedProviderId(env: NodeJS.ProcessEnv = process.env): BotProviderId {
  const want = env.BOT_PROVIDER?.trim().toLowerCase();
  if (want && (BOT_PROVIDERS as readonly string[]).includes(want)) return want as BotProviderId;
  if (env.RECALL_API_KEY?.trim()) return "recall";
  if (env.ATTENDEE_API_KEY?.trim()) return "attendee";
  return "recall";
}

/** True when the selected provider needs our public (tunnel) URL to deliver webhooks. */
export function botNeedsTunnel(env: NodeJS.ProcessEnv = process.env): boolean {
  const p = botProviders(env)[selectedProviderId(env)];
  return p.configured && !p.webhookBaseUrl;
}
