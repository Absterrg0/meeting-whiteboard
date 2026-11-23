/**
 * HTTP routes for live sources:
 *
 *   GET    /api/live/config          what is configured (OpenAI key, Recall key, public URL, models)
 *   POST   /api/bot                  {meeting_url, bot_name?, session_id?} -> a Recall bot joins the call
 *   GET    /api/bots                 bots of this server run
 *   GET    /api/bot/:id              bot status (from Recall) + local counters
 *   DELETE /api/bot/:id              the bot leaves the call
 *   POST   /api/recall/webhook/      Recall realtime events (token in the URL + optional signature)
 */
import type { Context, Hono } from "hono";
import { transcribeConfig, type LiveSession } from "./audioRelay.js";
import {
  botStatus,
  eventBotId,
  mapParticipantEvent,
  mapTranscriptEvent,
  meetingPlatform,
  meetingTimeFor,
  newToken,
  RecallClient,
  recallConfig,
  RecallError,
  tokensEqual,
  verifyRecallSignature,
  WEBHOOK_PATH,
  type BotRecord,
  type RecallBot,
} from "./recall.js";
import { cloudflaredInstalled, currentPublicUrl, ensurePublicUrl } from "./tunnel.js";

export type { LiveSession };

export interface LiveRouteDeps {
  getSession(id: string): LiveSession | undefined;
  createLiveSession(title: string): LiveSession;
  port: number;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  publicUrl?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

const MAX_WEBHOOK_BYTES = 1_000_000;
const STATUS_CACHE_MS = 2000;

export function registerLiveRoutes(app: Hono, deps: LiveRouteDeps) {
  const env = deps.env ?? process.env;
  const bots = new Map<string, BotRecord>();
  const statusCache = new Map<string, { at: number; bot: RecallBot | null; error: string | null }>();
  const client = () => new RecallClient(recallConfig(env), deps.fetchImpl ?? fetch);
  const publicUrl = deps.publicUrl ?? (() => ensurePublicUrl(deps.port));
  let cloudflared: boolean | null = null;

  const view = (rec: BotRecord, remote?: { bot: RecallBot | null; error: string | null }) => ({
    id: rec.id,
    sessionId: rec.sessionId,
    meetingUrl: rec.meetingUrl,
    botName: rec.botName,
    createdAt: rec.createdAt,
    utterances: rec.utterances,
    participants: rec.participants,
    lastEventAt: rec.lastEventAt,
    left: rec.left,
    status: remote?.bot ? botStatus(remote.bot) : null,
    error: remote?.error ?? null,
  });

  async function remoteStatus(id: string) {
    const cached = statusCache.get(id);
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached;
    let entry: { at: number; bot: RecallBot | null; error: string | null };
    try {
      entry = { at: Date.now(), bot: await client().getBot(id), error: null };
    } catch (e) {
      entry = { at: Date.now(), bot: cached?.bot ?? null, error: (e as Error).message };
    }
    statusCache.set(id, entry);
    return entry;
  }

  app.get("/api/live/config", (c) => {
    cloudflared ??= cloudflaredInstalled();
    const rc = recallConfig(env);
    return c.json({
      openai: !!env.OPENAI_API_KEY,
      transcribeModel: transcribeConfig().model,
      recall: !!rc.apiKey,
      recallRegion: rc.region,
      recallSignature: !!rc.webhookSecret,
      publicUrl: currentPublicUrl(),
      cloudflared,
    });
  });

  app.post("/api/bot", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { meeting_url?: unknown; bot_name?: unknown; session_id?: unknown };
    const meetingUrl = String(body.meeting_url ?? "").trim();
    if (!meetingPlatform(meetingUrl)) {
      return c.json({ error: "meeting_url must be an https Google Meet, Zoom, Teams or Webex link" }, 400);
    }
    if (!recallConfig(env).apiKey) {
      return c.json({ error: "Set RECALL_API_KEY (and RECALL_REGION) in .env and restart the server to use a meeting bot." }, 400);
    }
    const botName = String(body.bot_name ?? "").trim().slice(0, 100) || "Meeting Whiteboard";

    let base: string;
    try {
      base = await publicUrl();
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    let session = typeof body.session_id === "string" ? deps.getSession(body.session_id) : undefined;
    // Join the current meeting only if it is a live one still running; never a replay.
    if (session && (session.status === "done" || (session.mode !== undefined && session.mode !== "live"))) session = undefined;
    session ??= deps.createLiveSession(`Meeting (${meetingPlatform(meetingUrl)!.replace("_", " ")})`);

    const token = newToken();
    const webhookUrl = `${base}${WEBHOOK_PATH}?token=${encodeURIComponent(token)}`;
    try {
      const bot = await client().createBot({ meetingUrl, botName, webhookUrl });
      const rec: BotRecord = {
        id: bot.id,
        sessionId: session.id,
        token,
        meetingUrl,
        botName,
        createdAt: new Date().toISOString(),
        utterances: 0,
        participants: [],
        offset: null,
        lastEventAt: null,
        left: false,
      };
      bots.set(bot.id, rec);
      console.log(`recall bot ${bot.id} -> ${meetingUrl} (session ${session.id}, webhook ${base}${WEBHOOK_PATH})`);
      return c.json({ bot: view(rec, { bot, error: null }), sessionId: session.id });
    } catch (e) {
      const status = e instanceof RecallError && e.status >= 400 && e.status < 500 ? 400 : 502;
      return c.json({ error: (e as Error).message }, status);
    }
  });

  app.get("/api/bots", (c) => c.json([...bots.values()].map((b) => view(b))));

  app.get("/api/bot/:id", async (c) => {
    const rec = bots.get(c.req.param("id"));
    if (!rec) return c.json({ error: "no such bot" }, 404);
    return c.json(view(rec, await remoteStatus(rec.id)));
  });

  app.delete("/api/bot/:id", async (c) => {
    const rec = bots.get(c.req.param("id"));
    if (!rec) return c.json({ error: "no such bot" }, 404);
    try {
      const bot = await client().leaveCall(rec.id);
      rec.left = true;
      statusCache.delete(rec.id);
      return c.json(view(rec, { bot, error: null }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  const webhook = async (c: Context) => {
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) return c.json({ error: "too large" }, 413);
    const secret = recallConfig(env).webhookSecret;
    if (secret) {
      try {
        verifyRecallSignature(
          secret,
          {
            id: c.req.header("webhook-id") ?? c.req.header("svix-id"),
            timestamp: c.req.header("webhook-timestamp") ?? c.req.header("svix-timestamp"),
            signature: c.req.header("webhook-signature") ?? c.req.header("svix-signature"),
          },
          raw,
        );
      } catch (e) {
        return c.json({ error: `signature check failed: ${(e as Error).message}` }, 401);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const rec = bots.get(eventBotId(body) ?? "");
    const token = c.req.query("token") ?? "";
    if (!rec || !token || !tokensEqual(token, rec.token)) return c.json({ error: "unknown bot or bad token" }, 401);

    rec.lastEventAt = new Date().toISOString();
    const session = deps.getSession(rec.sessionId);
    const u = mapTranscriptEvent(body);
    if (u && session) {
      const t = meetingTimeFor(rec, u, session.meetingTime(), session.transcript.at(-1)?.t ?? 0);
      session.addUtterance({ speaker: u.speaker, text: u.text, t });
      rec.utterances++;
      if (!rec.participants.includes(u.speaker)) rec.participants.push(u.speaker);
    }
    const p = mapParticipantEvent(body);
    if (p?.kind === "join" && !rec.participants.includes(p.name)) rec.participants.push(p.name);
    // Always 2xx for an authenticated event, even if the session is gone, so Recall does not retry.
    return c.json({ ok: true });
  };
  app.post(WEBHOOK_PATH, webhook);
  app.post(WEBHOOK_PATH.replace(/\/$/, ""), webhook);

  return { bots };
}
