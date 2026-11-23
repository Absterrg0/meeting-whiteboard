import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachAudioRelay, cleanName, type LiveSession, type TranscriberLike } from "../src/live/audioRelay.js";
import { apiGuard, isForwarded, originAllowed } from "../src/live/guard.js";
import { LocalVad } from "../src/live/openaiRealtime.js";
import {
  botStatus,
  createBotPayload,
  mapParticipantEvent,
  mapTranscriptEvent,
  meetingPlatform,
  meetingTimeFor,
  recallConfig,
  signRecallWebhook,
  verifyRecallSignature,
  WEBHOOK_PATH,
  type BotRecord,
} from "../src/live/recall.js";
import { registerLiveRoutes } from "../src/live/routes.js";

// Shape of a transcript.data realtime event, per docs.recall.ai "Real-time event payloads".
const transcriptEvent = (botId: string, name: string | null, words: [string, number, number][]) => ({
  event: "transcript.data",
  data: {
    data: {
      words: words.map(([text, s, e]) => ({
        text,
        start_timestamp: { relative: s, absolute: new Date(1_700_000_000_000 + s * 1000).toISOString() },
        end_timestamp: { relative: e, absolute: new Date(1_700_000_000_000 + e * 1000).toISOString() },
      })),
      language_code: "en",
      participant: { id: 100, name, is_host: true, platform: "desktop", extra_data: {}, email: null },
    },
    realtime_endpoint: { id: "re_1", metadata: {} },
    transcript: { id: "tr_1", metadata: {} },
    recording: { id: "rec_1", metadata: {} },
    bot: { id: botId, metadata: {} },
  },
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

describe("Recall event mapping", () => {
  it("joins words into one utterance with the participant's real name and relative times", () => {
    const u = mapTranscriptEvent(
      transcriptEvent("bot-1", "Priya Raman", [
        ["Let's", 12.4, 12.7],
        ["use", 12.7, 12.9],
        ["SQS", 12.9, 13.3],
        [".", 13.3, 13.4],
      ]),
    );
    expect(u).toMatchObject({ botId: "bot-1", speaker: "Priya Raman", text: "Let's use SQS.", start: 12.4, end: 13.4 });
    expect(u!.absolute).toMatch(/^2023-/);
  });

  it("falls back to the participant id when the name is missing, and ignores other events", () => {
    expect(mapTranscriptEvent(transcriptEvent("b", null, [["hi", 1, 2]]))!.speaker).toBe("Participant 100");
    expect(mapTranscriptEvent(transcriptEvent("b", "A", []))).toBeNull();
    expect(mapTranscriptEvent({ event: "transcript.partial_data", data: {} })).toBeNull();
    expect(
      mapParticipantEvent({
        event: "participant_events.join",
        data: { data: { participant: { id: 2, name: "Wei" }, timestamp: { relative: 3 } }, bot: { id: "b" } },
      }),
    ).toEqual({ kind: "join", name: "Wei", botId: "b" });
  });

  it("aligns Recall's clock to the session clock on the first event and keeps spacing after", () => {
    const rec = { offset: null } as BotRecord;
    const u1 = mapTranscriptEvent(transcriptEvent("b", "A", [["one", 30, 31]]))!;
    expect(meetingTimeFor(rec, u1, 500, 0)).toBe(499); // landed "now", started 1 s before its end
    const u2 = mapTranscriptEvent(transcriptEvent("b", "B", [["two", 40, 41]]))!;
    expect(meetingTimeFor(rec, u2, 512, 499)).toBe(509);
    // Never ahead of the clock, never before the previous line.
    expect(meetingTimeFor(rec, mapTranscriptEvent(transcriptEvent("b", "C", [["x", 90, 91]]))!, 520, 509)).toBe(520);
    expect(meetingTimeFor(rec, mapTranscriptEvent(transcriptEvent("b", "C", [["x", 10, 11]]))!, 520, 515)).toBe(515);
  });

  it("builds the create-bot payload with low-latency streaming transcription and a webhook endpoint", () => {
    const p = createBotPayload({ meetingUrl: "https://meet.google.com/abc-defg-hij", botName: "Scribe", webhookUrl: "https://x.test/api/recall/webhook/?token=t" });
    expect(p.recording_config.transcript.provider).toEqual({ recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } });
    expect(p.recording_config.realtime_endpoints[0]).toMatchObject({ type: "webhook", events: expect.arrayContaining(["transcript.data"]) });
    expect(p.recording_config.realtime_endpoints[0]!.url).toContain("/webhook/?token=");
  });

  it("recognises meeting links and region config", () => {
    expect(meetingPlatform("https://meet.google.com/abc-defg-hij")).toBe("google_meet");
    expect(meetingPlatform("https://us02web.zoom.us/j/123?pwd=x")).toBe("zoom");
    expect(meetingPlatform("https://teams.microsoft.com/l/meetup-join/19%3a...")).toBe("teams");
    expect(meetingPlatform("https://teams.live.com/meet/123")).toBe("teams");
    expect(meetingPlatform("http://meet.google.com/x")).toBeNull();
    expect(meetingPlatform("https://evil.example/zoom.us")).toBeNull();
    expect(recallConfig({ RECALL_API_KEY: "k", RECALL_REGION: "eu-central-1" }).baseUrl).toBe("https://eu-central-1.recall.ai");
    expect(recallConfig({}).apiKey).toBeNull();
    expect(botStatus({ id: "b", status_changes: [{ code: "joining_call", created_at: "" }, { code: "in_waiting_room", created_at: "" }] }).label).toMatch(/waiting room/);
  });
});

describe("Recall webhook signature", () => {
  const secret = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  const body = '{"event":"transcript.data"}';
  const now = 1_731_705_121;

  it("accepts a valid signature (also among several, after rotation)", () => {
    const sig = signRecallWebhook(secret, "msg_1", String(now), body);
    expect(() => verifyRecallSignature(secret, { id: "msg_1", timestamp: String(now), signature: sig }, body, now)).not.toThrow();
    expect(() =>
      verifyRecallSignature(secret, { id: "msg_1", timestamp: String(now), signature: `v1,AAAA ${sig}` }, body, now),
    ).not.toThrow();
  });

  it("rejects tampered bodies, wrong ids, stale timestamps, missing headers and bad secrets", () => {
    const sig = signRecallWebhook(secret, "msg_1", String(now), body);
    expect(() => verifyRecallSignature(secret, { id: "msg_1", timestamp: String(now), signature: sig }, body + " ", now)).toThrow(/signature/);
    expect(() => verifyRecallSignature(secret, { id: "msg_2", timestamp: String(now), signature: sig }, body, now)).toThrow();
    expect(() => verifyRecallSignature(secret, { id: "msg_1", timestamp: String(now), signature: sig }, body, now + 3600)).toThrow(/window/);
    expect(() => verifyRecallSignature(secret, { id: "msg_1", timestamp: String(now) }, body, now)).toThrow(/missing/);
    expect(() => verifyRecallSignature("nope", { id: "msg_1", timestamp: String(now), signature: sig }, body, now)).toThrow(/whsec_/);
  });
});

describe("live routes (Recall bot + webhook) with a fake Recall API", () => {
  function setup(env: NodeJS.ProcessEnv = { RECALL_API_KEY: "test-key", RECALL_REGION: "us-west-2" }) {
    const session = new FakeSession();
    const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/bot/") && init.method === "POST")
        return new Response(JSON.stringify({ id: "bot-123", status_changes: [] }), { status: 201 });
      if (url.endsWith("/leave_call/")) return new Response(JSON.stringify({ id: "bot-123", status_changes: [{ code: "call_ended", created_at: "" }] }));
      return new Response(JSON.stringify({ id: "bot-123", status_changes: [{ code: "in_call_recording", created_at: "" }] }));
    }) as typeof fetch;
    const app = new Hono();
    app.use("/api/*", apiGuard([WEBHOOK_PATH]));
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

  it("creates a bot against the configured region with a tokenised webhook URL, then maps events into the session", async () => {
    const { app, session, calls, bots, post } = setup();
    const res = await post("/api/bot", { meeting_url: "https://meet.google.com/abc-defg-hij", bot_name: "Scribe" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bot: { id: string }; sessionId: string };
    expect(json).toMatchObject({ bot: { id: "bot-123" }, sessionId: "s1" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://us-west-2.recall.ai/api/v1/bot/", auth: "Token test-key" });
    const webhookUrl = (calls[0]!.body as ReturnType<typeof createBotPayload>).recording_config.realtime_endpoints[0]!.url;
    expect(webhookUrl).toMatch(/^https:\/\/tunnel\.example\/api\/recall\/webhook\/\?token=/);
    const token = new URL(webhookUrl).searchParams.get("token")!;
    expect(bots.get("bot-123")!.token).toBe(token);

    // Through the tunnel (forwarded headers), with the right token -> utterance added.
    const ev = transcriptEvent("bot-123", "Priya Raman", [["Let's", 12, 12.3], ["use", 12.3, 12.5], ["SQS.", 12.5, 13]]);
    const ok = await post(`${WEBHOOK_PATH}?token=${encodeURIComponent(token)}`, ev, { "cf-connecting-ip": "1.2.3.4", host: "x.trycloudflare.com" });
    expect(ok.status).toBe(200);
    expect(session.transcript).toEqual([{ t: 99, speaker: "Priya Raman", text: "Let's use SQS.", ts: "t99.0" }]);

    // Wrong token / unknown bot -> 401 and nothing added.
    expect((await post(`${WEBHOOK_PATH}?token=nope`, ev)).status).toBe(401);
    expect((await post(WEBHOOK_PATH, ev)).status).toBe(401);
    expect((await post(`${WEBHOOK_PATH}?token=${token}`, transcriptEvent("other-bot", "X", [["x", 1, 2]]))).status).toBe(401);
    expect(session.transcript).toHaveLength(1);

    // Status and leave.
    const st = (await (await app.request("/api/bot/bot-123", { headers: { host: "localhost:8787" } })).json()) as { status: { code: string }; utterances: number };
    expect(st).toMatchObject({ status: { code: "in_call_recording" }, utterances: 1 });
    const del = await app.request("/api/bot/bot-123", { method: "DELETE", headers: { host: "localhost:8787" } });
    expect(del.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "https://us-west-2.recall.ai/api/v1/bot/bot-123/leave_call/" });
  });

  it("checks the signature too when RECALL_WEBHOOK_SECRET is set", async () => {
    const secret = "whsec_" + Buffer.from("k".repeat(32)).toString("base64");
    const { session, bots, post } = setup({ RECALL_API_KEY: "k", RECALL_WEBHOOK_SECRET: secret });
    await post("/api/bot", { meeting_url: "https://zoom.us/j/1" });
    const token = bots.get("bot-123")!.token;
    const raw = JSON.stringify(transcriptEvent("bot-123", "Ana", [["hello", 1, 2]]));
    const ts = String(Math.floor(Date.now() / 1000));
    const good = { "webhook-id": "msg_9", "webhook-timestamp": ts, "webhook-signature": signRecallWebhook(secret, "msg_9", ts, raw) };
    expect((await post(`${WEBHOOK_PATH}?token=${token}`, raw, { ...good, "webhook-id": "msg_other" })).status).toBe(401);
    expect((await post(`${WEBHOOK_PATH}?token=${token}`, raw)).status).toBe(401);
    expect(session.transcript).toHaveLength(0);
    expect((await post(`${WEBHOOK_PATH}?token=${token}`, raw, good)).status).toBe(200);
    expect(session.transcript.map((u) => u.speaker)).toEqual(["Ana"]);
  });

  it("adds the bot to the current session only if it is live and running", async () => {
    const { post, session } = setup();
    const created: string[] = [];
    // setup() returns the same fake for create; mark it as a replay first.
    (session as FakeSession & { mode?: string }).mode = "replay";
    const app2 = new Hono();
    const fresh = new FakeSession();
    fresh.id = "s2";
    registerLiveRoutes(app2, {
      port: 1,
      env: { RECALL_API_KEY: "k" },
      fetchImpl: (async () => new Response(JSON.stringify({ id: "b9", status_changes: [] }), { status: 201 })) as typeof fetch,
      publicUrl: async () => "https://t.example",
      getSession: (id) => (id === "s1" ? session : undefined),
      createLiveSession: () => (created.push("new"), fresh),
    });
    const r = await app2.request("/api/bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meeting_url: "https://zoom.us/j/1", session_id: "s1" }),
    });
    expect(((await r.json()) as { sessionId: string }).sessionId).toBe("s2");
    (session as FakeSession & { mode?: string }).mode = "live";
    const r2 = await app2.request("/api/bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meeting_url: "https://zoom.us/j/1", session_id: "s1" }),
    });
    expect(((await r2.json()) as { sessionId: string }).sessionId).toBe("s1");
    expect(created).toEqual(["new"]);
    void post;
  });

  it("explains what is missing: no key, bad link", async () => {
    const { post } = setup({});
    const noKey = await post("/api/bot", { meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toMatch(/RECALL_API_KEY/);
    const bad = await post("/api/bot", { meeting_url: "https://example.com/meeting" });
    expect(((await bad.json()) as { error: string }).error).toMatch(/Google Meet, Zoom, Teams/);
  });

  it("guard: tunnelled requests reach only the webhook; foreign-origin and non-JSON POSTs are refused", async () => {
    const { app, post } = setup();
    expect((await app.request("/api/bots", { headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "1.2.3.4" } })).status).toBe(403);
    expect((await app.request("/api/bots", { headers: { host: "localhost:8787" } })).status).toBe(200);
    expect((await post("/api/bot", { meeting_url: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    const form = await app.request("/api/bot", { method: "POST", headers: { host: "localhost:8787", "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
    const del = await app.request("/api/bot/bot-123", { method: "DELETE", headers: { host: "localhost:8787", origin: "https://evil.example" } });
    expect(del.status).toBe(403);
  });
});

describe("guard helpers", () => {
  it("detects forwarded requests and checks origins", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(isForwarded(h({ host: "localhost:8787" }))).toBe(false);
    expect(isForwarded(h({ host: "127.0.0.1:8787" }))).toBe(false);
    expect(isForwarded(h({ host: "abc.trycloudflare.com" }))).toBe(true);
    expect(isForwarded(h({ host: "localhost:8787", "x-forwarded-for": "1.1.1.1" }))).toBe(true);
    expect(originAllowed("http://localhost:5173", "localhost:8787")).toBe(true);
    expect(originAllowed("https://evil.example", "localhost:8787")).toBe(false);
    expect(originAllowed(undefined, "localhost:8787")).toBe(false);
  });

  it("cleans speaker names", () => {
    expect(cleanName("  Alice <b>\n", "Mic")).toBe("Alice b");
    expect(cleanName("", "Mic")).toBe("Mic");
    expect(cleanName("x".repeat(100), "Mic")).toHaveLength(60);
  });
});

describe("LocalVad", () => {
  const tone = (ms: number, amp: number) => {
    const n = (24 * ms) | 0;
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amp * 32767), i * 2);
    return b;
  };
  it("emits start, audio and a commit after a pause; nothing for silence", () => {
    const vad = new LocalVad(700);
    const acts = [
      ...vad.push(tone(1000, 0), 0),
      ...vad.push(tone(1500, 0.3), 1000),
      ...vad.push(tone(1000, 0), 2500),
    ];
    const kinds = acts.map((a) => a.type).filter((k, i, arr) => k !== arr[i - 1]);
    expect(kinds).toEqual(["start", "audio", "commit"]);
    const start = acts.find((a) => a.type === "start") as { atMs: number };
    expect(start.atMs).toBeGreaterThanOrEqual(600);
    expect(start.atMs).toBeLessThanOrEqual(1000);
    const commit = acts.find((a) => a.type === "commit") as { startMs: number; endMs: number };
    expect(commit.endMs).toBeGreaterThan(2400);
    expect(commit.endMs).toBeLessThan(2700);
    expect(new LocalVad().push(tone(3000, 0.001), 0)).toEqual([]);
  });
});

describe("audio relay WebSocket", () => {
  let server: Server | null = null;
  let made = 0;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  class FakeTranscriber extends EventEmitter implements TranscriberLike {
    model = "fake-model";
    positionMs = 0;
    appended = 0;
    flushed = false;
    async connect() {}
    append(pcm: Buffer) {
      this.appended += pcm.length;
      this.positionMs += pcm.length / 48;
    }
    flush() {
      this.flushed = true;
    }
    close() {}
  }

  async function start(session: FakeSession) {
    let tr: FakeTranscriber | null = null;
    server = createServer();
    attachAudioRelay(server, {
      getSession: (id) => (id === session.id ? session : undefined),
      makeTranscriber: () => {
        made++;
        return (tr = new FakeTranscriber());
      },
      log: () => {},
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return { port, tr: () => tr! };
  }

  const open = (url: string, origin?: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, origin ? { headers: { origin } } : {});
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", (_q, res) => reject(new Error(String(res.statusCode))));
      ws.on("error", reject);
    });

  it("refuses foreign origins and unknown sessions", async () => {
    const { port } = await start(new FakeSession());
    await expect(open(`ws://127.0.0.1:${port}/api/live/audio?session=s1`, "https://evil.example")).rejects.toThrow("403");
    await expect(open(`ws://127.0.0.1:${port}/api/live/audio?session=s1`)).rejects.toThrow("403");
    await expect(open(`ws://127.0.0.1:${port}/api/live/audio?session=nope`, `http://localhost:${port}`)).rejects.toThrow("404");
  });

  it("relays audio, labels segments with the speaker picked at segment start, adds utterances", async () => {
    const session = new FakeSession();
    const { port, tr } = await start(session);
    const ws = await open(`ws://127.0.0.1:${port}/api/live/audio?session=s1&source=meeting`, `http://localhost:${port}`);
    const msgs: { type: string; [k: string]: unknown }[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => msgs.some((m) => m.type === "ready"));

    ws.send(Buffer.alloc(48_000)); // 1 s of audio
    await until(() => tr().positionMs >= 1000);
    ws.send(JSON.stringify({ type: "speaker", name: "Grace" })); // picked at 1 s
    ws.send(Buffer.alloc(48_000 * 5)); // up to 6 s
    await until(() => tr().positionMs >= 6000);

    tr().emit("delta", "item1", "Change data");
    tr().emit("final", "Change data capture it is.", { audioStartMs: 200 }); // started before the pick, within grace
    tr().emit("final", "Debezium into Kafka.", { audioStartMs: 4000 });
    await until(() => msgs.filter((m) => m.type === "final").length === 2);

    expect(msgs.find((m) => m.type === "partial")).toMatchObject({ text: "Change data" });
    expect(session.transcript.map((u) => [u.speaker, u.text])).toEqual([
      ["Grace", "Change data capture it is."],
      ["Grace", "Debezium into Kafka."],
    ]);
    // Times: base = meeting time at first audio (100) + offset, clamped to the clock.
    expect(session.transcript[0]!.t).toBeCloseTo(100, 0);

    ws.send(JSON.stringify({ type: "speaker", name: "" })); // cleared -> source label
    ws.send(Buffer.alloc(48_000));
    await until(() => tr().positionMs >= 7000);
    session.now = 200;
    tr().emit("final", "Unlabelled line.", { audioStartMs: 6500 });
    await until(() => session.transcript.length === 3);
    expect(session.transcript[2]).toMatchObject({ speaker: "Meeting", t: 106.5 });

    // The transcription connection drops (session limit): a new one continues on the same clock.
    const first = tr();
    const before = made;
    first.emit("close");
    await until(() => made === before + 1 && tr() !== first);
    ws.send(Buffer.alloc(48_000)); // stream 7 s -> 8 s, new transcriber starts at 7 s
    await until(() => tr().positionMs >= 1000);
    session.now = 300;
    tr().emit("final", "After the reconnect.", { audioStartMs: 500 });
    await until(() => session.transcript.length === 4);
    expect(session.transcript[3]).toMatchObject({ speaker: "Meeting", text: "After the reconnect.", t: 107.5 });

    ws.send(JSON.stringify({ type: "stop" }));
    await until(() => tr().flushed);
    expect(tr().flushed).toBe(true);
    ws.close();
  });
});
