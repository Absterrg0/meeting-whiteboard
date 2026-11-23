/**
 * HTTP routes for live sources:
 *
 *   GET    /api/live/config          what is configured (OpenAI key, bot provider, public URL, models)
 *   POST   /api/bot                  {meeting_url, bot_name?, session_id?, provider?} -> a bot joins the call
 *   GET    /api/bots                 bots of this server run
 *   GET    /api/bot/:id              bot status (from the provider) + local counters
 *   DELETE /api/bot/:id              the bot leaves the call
 *   POST   /api/recall/webhook/      Recall realtime events (token in the URL + optional signature)
 *   POST   /api/attendee/webhook/    Attendee webhooks (token in the URL + optional signature)
 *
 * The bot provider (Recall.ai or self-hosted Attendee) is picked by BOT_PROVIDER; see bots.ts.
 */
import type { Context, Hono } from "hono";
import { transcribeConfig, type LiveSession } from "./audioRelay.js";
import { BOT_PROVIDERS, BotProviderError, botProviders, selectedProviderId, type BotProvider, type BotEvent, type BotProviderId, type BotStatus } from "./bots.js";
import { meetingPlatform, meetingTimeFor, newToken, recallConfig, tokensEqual, type BotRecord, type MappedUtterance } from "./recall.js";
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

/** A bot of any provider. `offset` aligns the provider's clock to the session clock. */
export type LiveBotRecord = BotRecord & {
  provider: BotProviderId;
  seen: Set<string>;
  /** Caption lines still growing, by key; added to the session once they settle. */
  pending?: Map<string, { ev: UtteranceEvent; timer: ReturnType<typeof setTimeout> }>;
  /** Join attempts so far (the watchdog retries a stuck bot once). */
  attempts?: number;
  /** Why the bot could not get into the call, shown in the UI with the fallback. */
  failure?: string | null;
  /** The bot that replaced this one after a stuck join. */
  replacedBy?: string | null;
};

const MAX_WEBHOOK_BYTES = 1_000_000;
const STATUS_CACHE_MS = 2000;
const MAX_SEEN_KEYS = 5000;
/** A caption line counts as finished after this long without an update. */
const captionSettleMs = () => Number(process.env.CAPTION_SETTLE_MS ?? 1800);
type UtteranceEvent = Extract<BotEvent, { kind: "utterance" }>;

export function registerLiveRoutes(app: Hono, deps: LiveRouteDeps) {
  const env = deps.env ?? process.env;
  const bots = new Map<string, LiveBotRecord>();
  const statusCache = new Map<string, { at: number; status: BotStatus | null; error: string | null }>();
  const providers = () => botProviders(env, deps.fetchImpl ?? fetch);
  const publicUrl = deps.publicUrl ?? (() => ensurePublicUrl(deps.port));
  let cloudflared: boolean | null = null;

  const view = (rec: LiveBotRecord, remote?: { status: BotStatus | null; error: string | null }) => ({
    id: rec.id,
    provider: rec.provider,
    sessionId: rec.sessionId,
    meetingUrl: rec.meetingUrl,
    botName: rec.botName,
    createdAt: rec.createdAt,
    utterances: rec.utterances,
    participants: rec.participants,
    lastEventAt: rec.lastEventAt,
    left: rec.left,
    status: remote?.status ?? null,
    error: remote?.error ?? null,
    attempts: rec.attempts ?? 1,
    failure: rec.failure ?? null,
    replacedBy: rec.replacedBy ?? null,
  });

  /**
   * Join watchdog. A bot that is still "joining" (not in the waiting room, not in the call)
   * after BOT_JOIN_TIMEOUT_MS is stuck on the provider side: it is removed and created again
   * once; if that one sticks too, the bot is marked failed with a reason the UI shows,
   * together with the fallback (capture the meeting tab's audio). A bot never just hangs.
   */
  // Long enough for a host to admit the bot from the waiting room (some providers report
  // the waiting room as "joining").
  const JOIN_TIMEOUT_MS = Number(env.BOT_JOIN_TIMEOUT_MS ?? 300_000);
  const STUCK = new Set(["joining", "ready", "staged", "scheduled", "created", "joining_call"]);
  const FATAL = /fatal|denied|could_not|cannot|can_t|rejected|kicked|failed/;
  function watchJoin(rec: LiveBotRecord, webhookUrl: string) {
    const t = setTimeout(async () => {
      if (rec.left || rec.replacedBy || rec.lastEventAt) return;
      statusCache.delete(rec.id);
      const st = await remoteStatus(rec);
      const code = st.status?.code ?? "joining";
      if (FATAL.test(code) || FATAL.test(st.status?.subCode ?? "")) {
        rec.failure = `The bot couldn't join (${st.status?.label ?? code}${st.status?.subCode ? `: ${st.status.subCode}` : ""}). Capture the meeting tab's audio instead.`;
        return;
      }
      if (!STUCK.has(code)) return; // waiting room or in the call: fine
      const provider = providers()[rec.provider];
      try {
        await provider.leave(rec.id).catch(() => undefined);
      } catch {
        /* best effort */
      }
      if ((rec.attempts ?? 1) >= 2) {
        rec.left = true;
        rec.failure = `The bot didn't get into the call within ${Math.round(JOIN_TIMEOUT_MS / 1000)} s twice (the bot server may be down or the meeting blocks guests). Capture the meeting tab's audio instead.`;
        console.log(`bot ${rec.id}: stuck joining after retry; giving up`);
        return;
      }
      try {
        const bot = await provider.createBot({ meetingUrl: rec.meetingUrl, botName: rec.botName, webhookUrl });
        const next: LiveBotRecord = { ...rec, id: bot.id, attempts: (rec.attempts ?? 1) + 1, seen: new Set(), createdAt: new Date().toISOString(), failure: null, replacedBy: null };
        bots.set(bot.id, next);
        rec.replacedBy = bot.id;
        rec.left = true;
        console.log(`bot ${rec.id}: stuck joining; retried as ${bot.id}`);
        watchJoin(next, webhookUrl);
        startPolling(next);
      } catch (e) {
        rec.left = true;
        rec.failure = `The bot couldn't be restarted: ${(e as Error).message}. Capture the meeting tab's audio instead.`;
      }
    }, JOIN_TIMEOUT_MS);
    t.unref?.();
  }

  async function remoteStatus(rec: LiveBotRecord) {
    const cached = statusCache.get(rec.id);
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached;
    let entry: { at: number; status: BotStatus | null; error: string | null };
    try {
      entry = { at: Date.now(), status: await providers()[rec.provider].status(rec.id), error: null };
    } catch (e) {
      entry = { at: Date.now(), status: cached?.status ?? null, error: (e as Error).message };
    }
    statusCache.set(rec.id, entry);
    return entry;
  }

  app.get("/api/live/config", (c) => {
    cloudflared ??= cloudflaredInstalled();
    const rc = recallConfig(env);
    const all = providers();
    const selected = all[selectedProviderId(env)];
    return c.json({
      openai: !!env.OPENAI_API_KEY,
      transcribeModel: transcribeConfig().model,
      recall: !!rc.apiKey,
      recallRegion: rc.region,
      recallSignature: !!rc.webhookSecret,
      publicUrl: currentPublicUrl(),
      cloudflared,
      // Provider-neutral fields (the UI falls back to `recall` when these are absent).
      botProvider: selected.id,
      botProviderLabel: selected.label,
      botReady: selected.configured,
      botSetupHint: selected.configured ? null : selected.setupHint,
      botProviders: BOT_PROVIDERS.map((id) => ({ id, label: all[id].label, configured: all[id].configured, ...all[id].info })),
    });
  });

  app.post("/api/bot", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { meeting_url?: unknown; bot_name?: unknown; session_id?: unknown; provider?: unknown };
    const meetingUrl = String(body.meeting_url ?? "").trim();
    if (!meetingPlatform(meetingUrl)) {
      return c.json({ error: "meeting_url must be an https Google Meet, Zoom, Teams or Webex link" }, 400);
    }
    const all = providers();
    const providerId =
      typeof body.provider === "string" && (BOT_PROVIDERS as readonly string[]).includes(body.provider)
        ? (body.provider as BotProviderId)
        : selectedProviderId(env);
    const provider: BotProvider = all[providerId];
    if (!provider.configured) return c.json({ error: provider.setupHint }, 400);
    const botName = String(body.bot_name ?? "").trim().slice(0, 100) || "Meeting Whiteboard";

    let base: string | null;
    try {
      base = provider.webhookBaseUrl ?? (await publicUrl());
    } catch (e) {
      // A provider we can poll still works without a public URL (pull only, a little slower).
      if (!provider.pollTranscript) return c.json({ error: (e as Error).message }, 400);
      console.warn(`no public URL for webhooks (${(e as Error).message}); ${provider.id} bot will be polled only`);
      base = null;
    }

    let session = typeof body.session_id === "string" ? deps.getSession(body.session_id) : undefined;
    // Join the current meeting only if it is a live one still running; never a replay.
    if (session && (session.status === "done" || (session.mode !== undefined && session.mode !== "live"))) session = undefined;
    session ??= deps.createLiveSession(`Meeting (${meetingPlatform(meetingUrl)!.replace("_", " ")})`);

    const token = newToken();
    const webhookUrl = base ? `${base}${provider.webhookPath}?token=${encodeURIComponent(token)}` : "";
    try {
      const bot = await provider.createBot({ meetingUrl, botName, webhookUrl });
      const rec: LiveBotRecord = {
        id: bot.id,
        provider: provider.id,
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
        seen: new Set(),
        attempts: 1,
        failure: null,
        replacedBy: null,
      };
      bots.set(bot.id, rec);
      watchJoin(rec, webhookUrl);
      startPolling(rec);
      console.log(`${provider.id} bot ${bot.id} -> ${meetingUrl} (session ${session.id}, webhook ${base}${provider.webhookPath})`);
      return c.json({ bot: view(rec, { status: bot.status, error: null }), sessionId: session.id });
    } catch (e) {
      const status = e instanceof BotProviderError && e.status >= 400 && e.status < 500 ? 400 : 502;
      return c.json({ error: (e as Error).message }, status);
    }
  });

  app.get("/api/bots", (c) => c.json([...bots.values()].map((b) => view(b))));

  app.get("/api/bot/:id", async (c) => {
    const rec = bots.get(c.req.param("id"));
    if (!rec) return c.json({ error: "no such bot" }, 404);
    return c.json(view(rec, await remoteStatus(rec)));
  });

  app.delete("/api/bot/:id", async (c) => {
    const rec = bots.get(c.req.param("id"));
    if (!rec) return c.json({ error: "no such bot" }, 404);
    try {
      const status = await providers()[rec.provider].leave(rec.id);
      rec.left = true;
      statusCache.delete(rec.id);
      return c.json(view(rec, { status, error: null }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /** Adds one finished line to the bot's session. */
  function emitUtterance(r: LiveBotRecord, ev: UtteranceEvent) {
    const s = deps.getSession(r.sessionId);
    if (!s) return;
    const u = { start: ev.start, end: ev.end } as MappedUtterance;
    const t = meetingTimeFor(r, u, s.meetingTime(), s.transcript.at(-1)?.t ?? 0);
    s.addUtterance({ speaker: ev.speaker, text: ev.text, t });
    r.utterances++;
    if (!r.participants.includes(ev.speaker)) r.participants.push(ev.speaker);
  }

  function markSeen(r: LiveBotRecord, key: string) {
    if (r.seen.size >= MAX_SEEN_KEYS) r.seen.clear();
    r.seen.add(key);
  }

  function flushPending(r: LiveBotRecord, key: string) {
    const p = r.pending?.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    r.pending!.delete(key);
    markSeen(r, key);
    emitUtterance(r, p.ev);
  }

  /**
   * The one way bot events enter a session, whether pushed (webhook) or pulled (poller).
   * Lines are deduplicated by key, so the two paths can overlap freely.
   */
  function ingest(rec: LiveBotRecord, events: BotEvent[]) {
    rec.lastEventAt = new Date().toISOString();
    for (const ev of events) {
      if (ev.kind === "utterance") {
        if (!ev.key) {
          emitUtterance(rec, ev);
          continue;
        }
        if (rec.seen.has(ev.key)) continue; // already added (the other path, or a retried delivery)
        if (!ev.partial) {
          // Final text (speech-to-text on the participant's audio): add it at once.
          markSeen(rec, ev.key);
          emitUtterance(rec, ev);
          continue;
        }
        // Captions arrive as a growing, revised line under one key ("How are you?" -> "How are
        // you? Okay, so let's start..."). Keep the newest text and add the line once it settles:
        // when the same speaker starts a new line, or after captionSettleMs() without an update.
        const pending = (rec.pending ??= new Map());
        for (const [k, p] of pending) if (k !== ev.key && p.ev.speaker === ev.speaker) flushPending(rec, k);
        const prev = pending.get(ev.key);
        if (prev) clearTimeout(prev.timer);
        pending.set(ev.key, { ev, timer: setTimeout(() => flushPending(rec, ev.key!), captionSettleMs()) });
      } else if (ev.kind === "participant") {
        if (ev.action === "join" && !rec.participants.includes(ev.name)) rec.participants.push(ev.name);
      } else if (ev.kind === "status") {
        statusCache.set(rec.id, { at: Date.now(), status: ev.status, error: null });
      }
    }
  }

  /**
   * Pull loop: webhooks need the provider to reach this machine through a tunnel, and a tunnel
   * can drop. Polling the provider's transcript makes the pull the source of truth and the
   * webhook only a fast path, so a dropped tunnel delays lines instead of losing them.
   */
  function startPolling(rec: LiveBotRecord) {
    const provider = providers()[rec.provider];
    if (!provider.pollTranscript) return;
    const every = Number(process.env.BOT_POLL_MS ?? 2500);
    let since: string | null = null;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      const done = rec.left || !!rec.replacedBy || !!rec.failure || !deps.getSession(rec.sessionId) || deps.getSession(rec.sessionId)!.status === "done";
      const st = statusCache.get(rec.id)?.status;
      if (done || (st && ["ended", "fatal_error", "left"].includes(st.code))) {
        clearInterval(timer);
        return;
      }
      busy = true;
      const started = new Date(Date.now() - 30_000).toISOString(); // overlap absorbs clock skew; keys dedupe
      try {
        const events = await provider.pollTranscript!(rec.id, since);
        if (events.length) ingest(rec, events);
        since = started;
      } catch {
        // Unreachable for now: keep `since`, so the next successful poll catches up.
      } finally {
        busy = false;
      }
    }, every);
    timer.unref?.();
  }

  const webhook = (providerId: BotProviderId) => async (c: Context) => {
    const provider = providers()[providerId];
    const raw = await c.req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) return c.json({ error: "too large" }, 413);
    let body: unknown;
    let parsed = true;
    try {
      body = JSON.parse(raw);
    } catch {
      parsed = false;
    }
    try {
      provider.verifyWebhook((n) => c.req.header(n), raw, body);
    } catch (e) {
      return c.json({ error: `signature check failed: ${(e as Error).message}` }, 401);
    }
    if (!parsed) return c.json({ error: "invalid JSON" }, 400);
    const rec = bots.get(provider.botIdOf(body) ?? "");
    const token = c.req.query("token") ?? "";
    if (!rec || rec.provider !== providerId || !token || !tokensEqual(token, rec.token)) return c.json({ error: "unknown bot or bad token" }, 401);

    ingest(rec, provider.mapEvent(body));
    // Always 2xx for an authenticated event, even if the session is gone, so the provider does not retry.
    return c.json({ ok: true });
  };
  for (const id of BOT_PROVIDERS) {
    const path = providers()[id].webhookPath;
    app.post(path, webhook(id));
    app.post(path.replace(/\/$/, ""), webhook(id));
  }

  return { bots };
}
