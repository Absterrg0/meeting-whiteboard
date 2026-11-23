import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ATTENDEE_WEBHOOK_PATH,
  attendeeBotStatus,
  attendeeConfig,
  attendeeCreateBotPayload,
  canonicalJson,
  mapAttendeeParticipant,
  mapAttendeeStateChange,
  mapAttendeeTranscript,
  signAttendeeWebhook,
  verifyAttendeeSignature,
} from "../src/live/attendee.js";
import { AttendeeClient } from "../src/live/attendee.js";
import { BOT_WEBHOOK_PATHS, botNeedsTunnel, selectedProviderId } from "../src/live/bots.js";
import { apiGuard } from "../src/live/guard.js";
import { WEBHOOK_PATH } from "../src/live/recall.js";
import { registerLiveRoutes, type LiveSession } from "../src/live/routes.js";

// Envelope and data fields as Attendee v1.98.1 sends them (docs.attendee.dev/guides/webhooks,
// bots/webhook_payloads.py, bots/tasks/deliver_webhook_task.py).
const transcriptUpdate = (botId: string, name: string | null, text: string | null, timestampMs: number, durationMs = 2400, uuid = "16778240") => ({
  idempotency_key: "5c0e7b1e-7a0e-4b8e-9d64-0a7f6f3c2b11",
  bot_id: botId,
  bot_metadata: { source: "meeting-whiteboard" },
  trigger: "transcript.update",
  data: {
    speaker_name: name,
    speaker_uuid: uuid,
    speaker_user_uuid: null,
    speaker_is_host: true,
    timestamp_ms: timestampMs,
    duration_ms: durationMs,
    transcription: text === null ? null : { transcript: text },
  },
});

const participantEvent = (botId: string, name: string, eventType: string) => ({
  idempotency_key: "0b7c7d0e-1111-4b8e-9d64-0a7f6f3c2b11",
  bot_id: botId,
  bot_metadata: null,
  trigger: "participant_events.join_leave",
  data: {
    id: "pe_1",
    participant_name: name,
    participant_uuid: "16778241",
    participant_user_uuid: null,
    participant_is_host: false,
    event_type: eventType,
    event_data: {},
    timestamp_ms: 1732385000000,
  },
});

const stateChange = (botId: string, newState: string, eventType = "bot_joined_meeting") => ({
  idempotency_key: "9d2e3f4a-2222-4b8e-9d64-0a7f6f3c2b11",
  bot_id: botId,
  bot_metadata: null,
  trigger: "bot.state_change",
  data: { new_state: newState, old_state: "joining", created_at: "2026-11-23T10:00:00Z", event_type: eventType, event_sub_type: null },
});

describe("Attendee event mapping", () => {
  it("maps transcript.update to one utterance with the speaker's real name and epoch times", () => {
    const u = mapAttendeeTranscript(transcriptUpdate("bot_1", "Priya Raman", "  Let's use   SQS. ", 1732385000123, 2400));
    expect(u).toMatchObject({ botId: "bot_1", speaker: "Priya Raman", text: "Let's use SQS.", start: 1732385000.123, key: "16778240:1732385000123" });
    expect(u!.end).toBeCloseTo(1732385002.523, 3);
  });

  it("falls back when the name is missing, and ignores empty transcripts and other triggers", () => {
    expect(mapAttendeeTranscript(transcriptUpdate("b", null, "hi", 1))!.speaker).toBe("Participant 16778240");
    expect(mapAttendeeTranscript(transcriptUpdate("b", "A", null, 1))).toBeNull();
    expect(mapAttendeeTranscript(transcriptUpdate("b", "A", "   ", 1))).toBeNull();
    expect(mapAttendeeTranscript(stateChange("b", "joined_recording"))).toBeNull();
    expect(mapAttendeeParticipant(participantEvent("b", "Marcus Lee", "join"))).toEqual({ kind: "join", name: "Marcus Lee", botId: "b" });
    expect(mapAttendeeParticipant(participantEvent("b", "Marcus Lee", "speech_start"))).toBeNull();
    expect(mapAttendeeStateChange(stateChange("b", "waiting_room"))).toEqual({ state: "waiting_room", eventType: "bot_joined_meeting", subType: null });
  });

  it("labels bot states like the Recall statuses", () => {
    expect(attendeeBotStatus({ id: "b", state: "joined_recording" })).toMatchObject({ code: "joined_recording", label: "In the call, transcribing" });
    expect(attendeeBotStatus({ id: "b", state: "waiting_room" }).label).toMatch(/admit the bot/);
    expect(attendeeBotStatus({ id: "b", state: "fatal_error", events: [{ type: "fatal_error", sub_type: "bot_not_launched", created_at: "" }] })).toMatchObject({
      label: "Failed",
      subCode: "bot_not_launched",
    });
  });

  it("builds a create-bot payload that transcribes from meeting captions and records nothing", () => {
    const p = attendeeCreateBotPayload({ meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Scribe", webhookUrl: "https://t.example/x" });
    expect(p).toMatchObject({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "Scribe",
      transcription_settings: { meeting_closed_captions: {} },
      recording_settings: { format: "none" },
      webhooks: [{ url: "https://t.example/x", triggers: ["transcript.update", "participant_events.join_leave", "bot.state_change"] }],
    });
    expect(p).not.toHaveProperty("zoom_settings");
    const zoom = attendeeCreateBotPayload({ meetingUrl: "https://us02web.zoom.us/j/123?pwd=x", botName: "S", webhookUrl: "u", language: "en-US" });
    expect(zoom).toMatchObject({ zoom_settings: { sdk: "web" }, transcription_settings: { meeting_closed_captions: { google_meet_language: "en-US", teams_language: "en-us" } } });
    const dg = attendeeCreateBotPayload({ meetingUrl: "https://zoom.us/j/1", botName: "S", webhookUrl: "u", transcription: "deepgram" });
    expect(dg.transcription_settings).toEqual({ deepgram: { language: "en" } });
    expect(dg).not.toHaveProperty("zoom_settings");
  });
});

describe("Attendee webhook signature", () => {
  // Reference signature computed with Attendee's own Python sign_payload():
  // json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")), HMAC-SHA256, base64.
  const secret = Buffer.from("s".repeat(32)).toString("base64");
  const payload = transcriptUpdate("bot_3hfP0PXEsNinIZmh", "Zoë Müller", 'Let\'s use "SQS" — it\'s fine/ok.', 1732385000123);
  const PY_SIGNATURE = "Q7N2naBO9cbsFq7LlwaCYswdCofxP4SJoutGqgJghmg=";

  it("matches Python's canonical JSON byte for byte", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "é/\""], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"é/\\""],"b":1,"c":{"y":2,"z":1}}');
    expect(signAttendeeWebhook(secret, payload)).toBe(PY_SIGNATURE);
    // Key order in the received body does not matter.
    const reordered = JSON.parse(JSON.stringify({ data: payload.data, trigger: payload.trigger, bot_id: payload.bot_id, bot_metadata: payload.bot_metadata, idempotency_key: payload.idempotency_key }));
    expect(() => verifyAttendeeSignature(secret, PY_SIGNATURE, reordered)).not.toThrow();
  });

  it("rejects tampered payloads, wrong secrets and missing headers", () => {
    expect(() => verifyAttendeeSignature(secret, PY_SIGNATURE, { ...payload, bot_id: "other" })).toThrow(/does not match/);
    expect(() => verifyAttendeeSignature(Buffer.from("x".repeat(32)).toString("base64"), PY_SIGNATURE, payload)).toThrow();
    expect(() => verifyAttendeeSignature(secret, undefined, payload)).toThrow(/missing/);
  });
});

describe("bot provider selection", () => {
  it("uses BOT_PROVIDER, else whichever has a key (Recall first)", () => {
    expect(selectedProviderId({})).toBe("recall");
    expect(selectedProviderId({ ATTENDEE_API_KEY: "a" })).toBe("attendee");
    expect(selectedProviderId({ ATTENDEE_API_KEY: "a", RECALL_API_KEY: "r" })).toBe("recall");
    expect(selectedProviderId({ BOT_PROVIDER: "attendee", RECALL_API_KEY: "r" })).toBe("attendee");
    expect(BOT_WEBHOOK_PATHS).toEqual([WEBHOOK_PATH, ATTENDEE_WEBHOOK_PATH]);
    expect(attendeeConfig({})).toMatchObject({ baseUrl: "http://localhost:8000", transcription: "captions", apiKey: null });
    // Attendee on this machine is polled, so no tunnel; a remote one uses webhooks too.
    expect(botNeedsTunnel({ ATTENDEE_API_KEY: "a" })).toBe(false);
    expect(botNeedsTunnel({ ATTENDEE_API_KEY: "a", ATTENDEE_BASE_URL: "https://attendee.example.com" })).toBe(true);
    expect(botNeedsTunnel({ ATTENDEE_API_KEY: "a", ATTENDEE_BASE_URL: "https://attendee.example.com", ATTENDEE_WEBHOOKS: "off" })).toBe(false);
    expect(botNeedsTunnel({ ATTENDEE_API_KEY: "a", ATTENDEE_WEBHOOK_BASE_URL: "http://host.docker.internal:8787" })).toBe(false);
    expect(botNeedsTunnel({})).toBe(false);
  });
});

class FakeSession implements LiveSession {
  id = "s1";
  status = "running";
  transcript: { t: number; speaker: string; text: string; ts: string }[] = [];
  now = 100;
  meetingTime() {
    return this.now;
  }
  addUtterance(u: { speaker: string; text: string; t?: number }) {
    const t = u.t ?? this.now;
    const ts = `t${t.toFixed(1)}`;
    this.transcript.push({ t, speaker: u.speaker, text: u.text, ts });
    return { ts };
  }
}

describe("live routes with a fake Attendee API", () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));
  process.env.CAPTION_SETTLE_MS = "5";
  process.env.ATTENDEE_RETRY_MS = "1,1,1";
  process.env.BOT_POLL_MS = "600000";
  const transcriptRows: unknown[] = [];
  function setup(env: NodeJS.ProcessEnv = { BOT_PROVIDER: "attendee", ATTENDEE_API_KEY: "att-key", ATTENDEE_BASE_URL: "http://attendee.local:8000/" }) {
    const session = new FakeSession();
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/api/v1/bots") && init.method === "POST")
        return new Response(JSON.stringify({ id: "bot_abc", meeting_url: "x", state: "joining", transcription_state: "not_started" }), { status: 201 });
      if (url.includes("/transcript")) return new Response(JSON.stringify(transcriptRows));
      if (url.endsWith("/leave")) return new Response(JSON.stringify({ id: "bot_abc", state: "leaving" }));
      return new Response(JSON.stringify({ id: "bot_abc", state: "joined_recording", transcription_state: "in_progress" }));
    }) as typeof fetch;
    const app = new Hono();
    app.use("/api/*", apiGuard(BOT_WEBHOOK_PATHS));
    const { bots } = registerLiveRoutes(app, {
      port: 8787,
      env,
      fetchImpl,
      publicUrl: async () => "https://tunnel.example",
      getSession: (id) => (id === session.id ? session : undefined),
      createLiveSession: () => session,
    });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json", host: "localhost:8787", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { app, session, calls, bots, post };
  }
  const tunnel = { "cf-connecting-ip": "1.2.3.4", host: "x.trycloudflare.com" };

  it("creates a bot with a tokenised webhook, maps events, drops re-sent utterances, reports status and leaves", async () => {
    const { app, session, calls, bots, post } = setup();
    const cfg = (await (await app.request("/api/live/config", { headers: { host: "localhost:8787" } })).json()) as Record<string, unknown>;
    expect(cfg).toMatchObject({ botProvider: "attendee", botReady: true, recall: false });

    const res = await post("/api/bot", { meeting_url: "https://meet.google.com/abc-defg-hij", bot_name: "Scribe" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bot: { id: "bot_abc", provider: "attendee", status: { code: "joining" } }, sessionId: "s1" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://attendee.local:8000/api/v1/bots", auth: "Token att-key" });
    const webhookUrl = (calls[0]!.body as ReturnType<typeof attendeeCreateBotPayload>).webhooks![0]!.url;
    expect(webhookUrl).toMatch(/^https:\/\/tunnel\.example\/api\/attendee\/webhook\/\?token=/);
    const token = new URL(webhookUrl).searchParams.get("token")!;
    expect(bots.get("bot_abc")!.token).toBe(token);
    const hook = `${ATTENDEE_WEBHOOK_PATH}?token=${encodeURIComponent(token)}`;

    expect((await post(hook, participantEvent("bot_abc", "Marcus Lee", "join"), tunnel)).status).toBe(200);
    // A caption line grows under one key: only the settled, newest text is added.
    expect((await post(hook, transcriptUpdate("bot_abc", "Priya Raman", "Let's", 1732385000000, 500), tunnel)).status).toBe(200);
    expect((await post(hook, transcriptUpdate("bot_abc", "Priya Raman", "Let's use SQS.", 1732385000000, 2000), tunnel)).status).toBe(200);
    expect(session.transcript).toHaveLength(0);
    await settle();
    expect((await post(hook, transcriptUpdate("bot_abc", "Marcus Lee", "Fine by me.", 1732385003000, 1000, "16778241"), tunnel)).status).toBe(200);
    await settle();
    // The same line re-sent after it was added (a retried delivery): dropped.
    expect((await post(hook, transcriptUpdate("bot_abc", "Priya Raman", "Let's use SQS!", 1732385000000, 2500), tunnel)).status).toBe(200);
    await settle();
    // First utterance ends "now" (t=100 -> start 98); the second keeps Attendee's spacing, clamped to the clock.
    expect(session.transcript.map(({ t, speaker, text }) => ({ t, speaker, text }))).toEqual([
      { t: 98, speaker: "Priya Raman", text: "Let's use SQS." },
      { t: 100, speaker: "Marcus Lee", text: "Fine by me." },
    ]);

    // Wrong token, unknown bot, or an Attendee event on the Recall path -> 401.
    const ev = transcriptUpdate("bot_abc", "X", "x", 1);
    expect((await post(`${ATTENDEE_WEBHOOK_PATH}?token=nope`, ev)).status).toBe(401);
    expect((await post(ATTENDEE_WEBHOOK_PATH, ev)).status).toBe(401);
    expect((await post(hook, transcriptUpdate("other", "X", "x", 1))).status).toBe(401);
    expect((await post(`${WEBHOOK_PATH}?token=${token}`, ev)).status).toBe(401);
    expect(session.transcript).toHaveLength(2);

    // A state-change webhook refreshes the status without a round trip.
    await post(hook, stateChange("bot_abc", "waiting_room"), tunnel);
    const st1 = (await (await app.request("/api/bot/bot_abc", { headers: { host: "localhost:8787" } })).json()) as { status: { code: string }; participants: string[]; utterances: number };
    expect(st1).toMatchObject({ status: { code: "waiting_room" }, utterances: 2 });
    expect(st1.participants).toEqual(["Marcus Lee", "Priya Raman"]);
    expect(calls).toHaveLength(1);

    const del = await app.request("/api/bot/bot_abc", { method: "DELETE", headers: { host: "localhost:8787" } });
    expect(await del.json()).toMatchObject({ left: true, status: { code: "leaving" } });
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "http://attendee.local:8000/api/v1/bots/bot_abc/leave" });
  });

  it("pulls the transcript when webhooks don't arrive (tunnel down), without duplicating pushed lines", async () => {
    process.env.BOT_POLL_MS = "10";
    try {
      const { session, bots, post } = setup({ BOT_PROVIDER: "attendee", ATTENDEE_API_KEY: "k", ATTENDEE_BASE_URL: "http://attendee.local:8000", ATTENDEE_TRANSCRIPTION: "openai" });
      transcriptRows.length = 0;
      await post("/api/bot", { meeting_url: "https://meet.google.com/abc-defg-hij" });
      const hook = `${ATTENDEE_WEBHOOK_PATH}?token=${bots.get("bot_abc")!.token}`;
      // One line arrives by webhook; the poll returns it again plus one the webhook never delivered.
      await post(hook, transcriptUpdate("bot_abc", "Priya Raman", "Let's use SQS.", 1732385000000, 2000), tunnel);
      transcriptRows.push(transcriptUpdate("bot_abc", "Priya Raman", "Let's use SQS.", 1732385000000, 2000).data, transcriptUpdate("bot_abc", "Marcus Lee", "Fine by me.", 1732385003000, 1000, "16778241").data);
      await new Promise((r) => setTimeout(r, 60));
      expect(session.transcript.map((u) => `${u.speaker}: ${u.text}`)).toEqual(["Priya Raman: Let's use SQS.", "Marcus Lee: Fine by me."]);
      bots.get("bot_abc")!.left = true; // stops the poller
    } finally {
      process.env.BOT_POLL_MS = "600000";
      transcriptRows.length = 0;
    }
  });

  it("verifies X-Webhook-Signature when ATTENDEE_WEBHOOK_SECRET is set", async () => {
    const secret = Buffer.from("w".repeat(32)).toString("base64");
    const { session, bots, post } = setup({ BOT_PROVIDER: "attendee", ATTENDEE_API_KEY: "k", ATTENDEE_WEBHOOK_SECRET: secret });
    await post("/api/bot", { meeting_url: "https://teams.microsoft.com/l/meetup-join/abc" });
    const hook = `${ATTENDEE_WEBHOOK_PATH}?token=${bots.get("bot_abc")!.token}`;
    const ev = transcriptUpdate("bot_abc", "Ana", "hello", 1732385000000);
    expect((await post(hook, ev)).status).toBe(401);
    expect((await post(hook, ev, { "x-webhook-signature": signAttendeeWebhook(secret, { ...ev, trigger: "x" }) })).status).toBe(401);
    expect(session.transcript).toHaveLength(0);
    expect((await post(hook, ev, { "x-webhook-signature": signAttendeeWebhook(secret, ev) })).status).toBe(200);
    await settle();
    expect(session.transcript.map((u) => u.speaker)).toEqual(["Ana"]);
  });

  it("uses ATTENDEE_WEBHOOK_BASE_URL instead of the tunnel, and explains a missing key", async () => {
    const { calls, post } = setup({ BOT_PROVIDER: "attendee", ATTENDEE_API_KEY: "k", ATTENDEE_WEBHOOK_BASE_URL: "http://host.docker.internal:8787/" });
    await post("/api/bot", { meeting_url: "https://zoom.us/j/1" });
    const body = calls[0]!.body as ReturnType<typeof attendeeCreateBotPayload>;
    expect(body.webhooks![0]!.url).toMatch(/^http:\/\/host\.docker\.internal:8787\/api\/attendee\/webhook\/\?token=/);
    expect(body).toMatchObject({ zoom_settings: { sdk: "web" } });

    const { post: post2 } = setup({ BOT_PROVIDER: "attendee" });
    const noKey = await post2("/api/bot", { meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toMatch(/ATTENDEE_API_KEY/);
  });

  it("reports an unreachable Attendee as a 502 with a hint", async () => {
    const app = new Hono();
    registerLiveRoutes(app, {
      port: 1,
      env: { BOT_PROVIDER: "attendee", ATTENDEE_API_KEY: "k" },
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      publicUrl: async () => "https://t.example",
      getSession: () => undefined,
      createLiveSession: () => new FakeSession(),
    });
    const r = await app.request("/api/bot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_url: "https://zoom.us/j/1" }) });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toMatch(/docker compose/);
  });
});

describe("AttendeeClient failover", () => {
  it("moves to the next base URL when a tunnel returns an error page, and stays there", async () => {
    process.env.ATTENDEE_RETRY_MS = "1,1,1";
    const hits: string[] = [];
    const fetchImpl = (async (url: string) => {
      hits.push(new URL(url).host);
      if (url.startsWith("https://a.example")) return new Response("<!DOCTYPE html><html>tunnel error</html>", { status: 530 });
      return new Response(JSON.stringify({ id: "bot_1", state: "joined_recording" }));
    }) as typeof fetch;
    const client = new AttendeeClient(attendeeConfig({ ATTENDEE_API_KEY: "k", ATTENDEE_BASE_URL: "https://a.example, https://b.example/" }), fetchImpl);
    expect(await client.getBot("bot_1")).toMatchObject({ state: "joined_recording" });
    await client.getBot("bot_1");
    expect(hits).toEqual(["a.example", "b.example", "b.example"]);
  });
});
