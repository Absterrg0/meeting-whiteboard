/**
 * A stand-in for a self-hosted Attendee API, to exercise the Attendee bot path without Docker.
 *
 * Implements POST /api/v1/bots, GET /api/v1/bots/:id, POST /api/v1/bots/:id/leave and, after a bot
 * is created, delivers bot.state_change, participant_events.join_leave and transcript.update
 * webhooks (envelope and fields as in Attendee v1.98.1) to the bot's webhook URL, signed with
 * X-Webhook-Signature when ATTENDEE_WEBHOOK_SECRET is set.
 *
 *   pnpm attendee:sim                                  # listens on :9912
 *   BOT_PROVIDER=attendee ATTENDEE_API_KEY=sim ATTENDEE_BASE_URL=http://127.0.0.1:9912 pnpm start
 *   then "Join a meeting" with any Meet/Zoom/Teams link.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { signAttendeeWebhook } from "../src/live/attendee.js";

const PORT = Number(process.env.SIM_PORT ?? 9912);
const SECRET = process.env.ATTENDEE_WEBHOOK_SECRET;

const SCRIPT: [string, string][] = [
  ["Priya Raman", "Okay, let's get going. We need to pick the queue for the webhook workers."],
  ["Marcus Lee", "I'd go with SQS, we already run it for billing."],
  ["Priya Raman", "Agreed, SQS. Retries: five with exponential backoff."],
  ["Marcus Lee", "I'll write the retry policy doc by Friday."],
];

interface SimBot {
  id: string;
  state: string;
  webhook: string;
  triggers: string[];
  left: boolean;
}
const bots = new Map<string, SimBot>();

async function deliver(b: SimBot, trigger: string, data: unknown) {
  if (!b.triggers.includes(trigger)) return;
  const payload = { idempotency_key: randomUUID(), bot_id: b.id, bot_metadata: { source: "meeting-whiteboard" }, trigger, data };
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Attendee-Webhook/1.0" };
  if (SECRET) headers["x-webhook-signature"] = signAttendeeWebhook(SECRET, payload);
  // Attendee retries 3 times with backoff; a fresh quick tunnel can take a few seconds to resolve.
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const res = await fetch(b.webhook, { method: "POST", headers, body: JSON.stringify(payload) });
      console.log(`  -> ${trigger}: HTTP ${res.status}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      if (res.ok || res.status === 401) return;
    } catch (e) {
      if (attempt === 1 || attempt % 5 === 0) console.log(`  -> delivery failed (${(e as Error).message}), retrying`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function setState(b: SimBot, state: string, eventType: string) {
  const old = b.state;
  b.state = state;
  await deliver(b, "bot.state_change", { new_state: state, old_state: old, created_at: new Date().toISOString(), event_type: eventType, event_sub_type: null });
}

async function run(b: SimBot) {
  await new Promise((r) => setTimeout(r, 1500));
  await setState(b, "joined_recording", "bot_joined_meeting");
  const names = [...new Set(SCRIPT.map(([n]) => n))];
  for (const [i, name] of names.entries()) {
    await deliver(b, "participant_events.join_leave", {
      id: `pe_${i}`,
      participant_name: name,
      participant_uuid: String(16778240 + i),
      participant_user_uuid: null,
      participant_is_host: i === 0,
      event_type: "join",
      event_data: {},
      timestamp_ms: Date.now(),
    });
  }
  for (const [name, text] of SCRIPT) {
    if (b.left) break;
    const durationMs = text.split(" ").length * 350;
    await new Promise((r) => setTimeout(r, durationMs / 2));
    await deliver(b, "transcript.update", {
      speaker_name: name,
      speaker_uuid: String(16778240 + names.indexOf(name)),
      speaker_user_uuid: null,
      speaker_is_host: names.indexOf(name) === 0,
      timestamp_ms: Date.now() - durationMs,
      duration_ms: durationMs,
      transcription: { transcript: text },
    });
    await new Promise((r) => setTimeout(r, 1500));
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
  const view = (b: SimBot) => ({ id: b.id, state: b.state, transcription_state: b.state === "joining" ? "not_started" : "in_progress", recording_state: "not_started", events: [] });
  if (req.method === "POST" && url.pathname === "/api/v1/bots") {
    const p = JSON.parse(body) as { meeting_url: string; bot_name: string; webhooks?: { url: string; triggers: string[] }[] };
    const hook = p.webhooks?.[0];
    if (!p.meeting_url || !p.bot_name || !hook) return send(400, { error: "meeting_url, bot_name and webhooks are required" });
    const b: SimBot = { id: `bot_${randomUUID().replace(/-/g, "").slice(0, 16)}`, state: "joining", webhook: hook.url, triggers: hook.triggers, left: false };
    bots.set(b.id, b);
    console.log(`  bot ${b.id} for ${p.meeting_url}; webhook ${hook.url.replace(/token=[^&]+/, "token=…")} triggers ${hook.triggers.join(",")}`);
    void run(b);
    return send(201, view(b));
  }
  const m = /^\/api\/v1\/bots\/([^/]+)(\/leave)?\/?$/.exec(url.pathname);
  const b = m ? bots.get(m[1]!) : undefined;
  if (!b) return send(404, { detail: "Not found." });
  if (req.method === "POST" && m![2]) {
    b.left = true;
    void setState(b, "ended", "bot_left_meeting");
    return send(200, { ...view(b), state: "leaving" });
  }
  return send(200, view(b));
}).listen(PORT, "127.0.0.1", () => console.log(`Attendee simulator on http://127.0.0.1:${PORT}`));
