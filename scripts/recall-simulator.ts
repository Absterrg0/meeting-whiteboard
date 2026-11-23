/**
 * A stand-in for the Recall.ai API, to exercise the meeting-bot path without a Recall account.
 *
 * Implements POST /api/v1/bot/, GET /api/v1/bot/:id/, POST /api/v1/bot/:id/leave_call/ and, after a
 * bot is created, delivers participant_events.join and transcript.data events (shapes from
 * docs.recall.ai) to the realtime webhook URL in the create request, signed like Recall when
 * RECALL_WEBHOOK_SECRET is set. Because it posts to whatever URL it was given, with PUBLIC_URL unset
 * the events travel through the real cloudflared tunnel and back.
 *
 *   pnpm tsx scripts/recall-simulator.ts            # listens on :9911
 *   RECALL_API_KEY=sim RECALL_BASE_URL=http://127.0.0.1:9911 pnpm start
 *   then "Bot joins a meeting" with any Meet/Zoom/Teams link.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { signRecallWebhook } from "../src/live/recall.js";

const PORT = Number(process.env.SIM_PORT ?? 9911);
const SECRET = process.env.RECALL_WEBHOOK_SECRET;

const SCRIPT: [string, string][] = [
  ["Priya Raman", "Okay, let's get going. We need to pick the queue for the webhook workers."],
  ["Marcus Lee", "I'd go with SQS, we already run it for billing."],
  ["Priya Raman", "Agreed, SQS. Retries: five with exponential backoff."],
  ["Marcus Lee", "I'll write the retry policy doc by Friday."],
];

interface SimBot {
  id: string;
  status_changes: { code: string; message: null; sub_code: null; created_at: string }[];
  webhook: string;
  events: string[];
  left: boolean;
}
const bots = new Map<string, SimBot>();
const status = (b: SimBot, code: string) => b.status_changes.push({ code, message: null, sub_code: null, created_at: new Date().toISOString() });

async function deliver(b: SimBot, body: unknown) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (SECRET) {
    const id = `msg_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    Object.assign(headers, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signRecallWebhook(SECRET, id, ts, raw) });
  }
  // Recall retries non-2xx up to 60 times, 1 s apart; a quick tunnel can take a few seconds to resolve.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await fetch(b.webhook, { method: "POST", headers, body: raw });
      console.log(`  -> ${(body as { event: string }).event}: HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      if (res.ok || res.status === 401) return res.status;
    } catch (e) {
      if (attempt === 1 || attempt % 5 === 0) console.log(`  -> delivery failed (${(e as Error).message}), retrying`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}

async function run(b: SimBot) {
  await new Promise((r) => setTimeout(r, 1500));
  status(b, "joining_call");
  await new Promise((r) => setTimeout(r, 1500));
  status(b, "in_call_recording");
  const names = [...new Set(SCRIPT.map(([n]) => n))];
  for (const [i, name] of names.entries()) {
    await deliver(b, {
      event: "participant_events.join",
      data: {
        data: { participant: { id: 100 + i, name, is_host: i === 0, platform: "desktop", extra_data: {} }, timestamp: { absolute: new Date().toISOString(), relative: 1 }, data: null },
        realtime_endpoint: { id: "re_sim", metadata: {} },
        participant_events: { id: "pe_sim", metadata: {} },
        recording: { id: "rec_sim", metadata: {} },
        bot: { id: b.id, metadata: {} },
      },
    });
  }
  let rel = 3;
  for (const [name, text] of SCRIPT) {
    if (b.left) break;
    const words = text.split(" ").map((w) => {
      const s = rel;
      rel += 0.35;
      return { text: w, start_timestamp: { relative: s, absolute: new Date().toISOString() }, end_timestamp: { relative: rel, absolute: new Date().toISOString() } };
    });
    await deliver(b, {
      event: "transcript.data",
      data: {
        data: { words, language_code: "en", participant: { id: 100 + names.indexOf(name), name, is_host: false, platform: "desktop", extra_data: {}, email: null } },
        realtime_endpoint: { id: "re_sim", metadata: {} },
        transcript: { id: "tr_sim", metadata: {} },
        recording: { id: "rec_sim", metadata: {} },
        bot: { id: b.id, metadata: {} },
      },
    });
    rel += 1.5;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  console.log(`${req.method} ${url.pathname} (auth: ${req.headers.authorization ? "yes" : "no"})`);
  if (!req.headers.authorization?.startsWith("Token ")) return send(401, { detail: "Invalid token." });
  if (req.method === "POST" && url.pathname === "/api/v1/bot/") {
    const p = JSON.parse(body) as { meeting_url: string; recording_config: { realtime_endpoints: { url: string; events: string[] }[] } };
    const ep = p.recording_config.realtime_endpoints[0]!;
    const b: SimBot = { id: randomUUID(), status_changes: [], webhook: ep.url, events: ep.events, left: false };
    bots.set(b.id, b);
    console.log(`  bot ${b.id} for ${p.meeting_url}; webhook ${ep.url.replace(/token=[^&]+/, "token=…")} events ${ep.events.join(",")}`);
    void run(b);
    return send(201, { id: b.id, meeting_url: p.meeting_url, status_changes: b.status_changes });
  }
  const m = /^\/api\/v1\/bot\/([^/]+)\/(leave_call\/)?$/.exec(url.pathname);
  const b = m ? bots.get(m[1]!) : undefined;
  if (!b) return send(404, { detail: "Not found." });
  if (req.method === "POST" && m![2]) {
    b.left = true;
    status(b, "call_ended");
    status(b, "done");
  }
  return send(200, { id: b.id, status_changes: b.status_changes });
}).listen(PORT, "127.0.0.1", () => console.log(`Recall simulator on http://127.0.0.1:${PORT}`));
