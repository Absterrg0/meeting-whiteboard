/**
 * HTTP server for the live whiteboard UI.
 *
 *   pnpm dev    -> this file under `tsx watch` + Vite dev server (proxies /api here)
 *   pnpm start  -> builds the web app into dist/ and serves it from here
 *
 * One meeting session is active at a time; creating a new one disposes the old one.
 * The UI receives full snapshots over SSE (they are small) and sends human edits back
 * as the same operations the agent uses.
 */
import "dotenv/config";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isOpName, type Op } from "./core/ops.js";
import { formatTs } from "./core/types.js";
import { parseTranscriptDetailed, TranscriptParseError, type ParseResult } from "./ingest/transcript.js";
import { attachAudioRelay } from "./live/audioRelay.js";
import { apiGuard } from "./live/guard.js";
import { WEBHOOK_PATH } from "./live/recall.js";
import { registerLiveRoutes } from "./live/routes.js";
import { ensurePublicUrl, stopTunnel } from "./live/tunnel.js";
import { MeetingSession } from "./session.js";

const ROOT = process.cwd();
const TRANSCRIPTS_DIR = resolve(ROOT, "transcripts");
const DIST_DIR = resolve(ROOT, "dist");
const OUT_DIR = "out";
const PORT = Number(process.env.PORT ?? 8787);
const TRANSCRIPT_EXT = /\.(jsonl|json|txt|md|vtt|srt)$/i;

const sessions = new Map<string, MeetingSession>();

function listTranscripts(): { name: string; utterances: number }[] {
  if (!existsSync(TRANSCRIPTS_DIR)) return [];
  return readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => TRANSCRIPT_EXT.test(f) && !/^readme/i.test(f))
    .sort()
    .map((name) => {
      try {
        return { name, utterances: parseTranscriptDetailed(readFileSync(join(TRANSCRIPTS_DIR, name), "utf8")).utterances.length };
      } catch {
        return { name, utterances: 0 };
      }
    })
    .filter((t) => t.utterances > 0);
}

/** Summary of a parse for the UI (format, count, timing, warnings, first lines). */
function parseInfo(r: ParseResult) {
  return {
    format: r.format,
    formatLabel: r.formatLabel,
    utterances: r.utterances.length,
    timing: r.timing,
    warnings: r.warnings,
    preview: r.utterances.slice(0, 3).map((u) => ({ ts: u.ts, speaker: u.speaker, text: u.text.slice(0, 120) })),
    speakers: [...new Set(r.utterances.map((u) => u.speaker))].slice(0, 30),
  };
}

function disposeAll() {
  for (const [id, old] of sessions) {
    old.dispose();
    sessions.delete(id);
  }
}

function newSession(title: string, live: boolean): MeetingSession {
  disposeAll();
  const slug = (title || "live").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  const id = `${slug}-${Date.now()}`;
  const session = new MeetingSession({ id, outDir: OUT_DIR, title: title || "Live meeting" });
  sessions.set(id, session);
  if (live) session.startLive();
  return session;
}

async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

const app = new Hono();

// The server spends API budget, so other web pages must not be able to drive it:
// POSTs must be JSON (forces a CORS preflight cross-origin) and same-origin when an Origin is sent.
// Requests that arrive through a tunnel (for Recall) can only reach the Recall webhook, which is
// protected by a per-bot token and, if configured, Recall's signature (src/live/recall.ts).
app.use("*", apiGuard([WEBHOOK_PATH]));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY }));

app.get("/api/transcripts", (c) => c.json(listTranscripts()));

/** Detect the format of pasted / uploaded content without starting a session. */
app.post("/api/transcript/parse", async (c) => {
  const body = await readJson<{ content: string }>(c.req.raw);
  try {
    return c.json(parseInfo(parseTranscriptDetailed(String(body.content ?? ""))));
  } catch (e) {
    if (e instanceof TranscriptParseError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** The active session, so a reloaded page can reattach. */
app.get("/api/current", (c) => {
  const last = [...sessions.keys()].at(-1);
  return c.json({ id: last ?? null });
});

app.post("/api/session", async (c) => {
  const body = await readJson<{ transcript: string; content: string; speed: number; live: boolean; title: string }>(
    c.req.raw,
  );
  const live = !!body.live;
  let content: string | null = null;
  let title = body.title?.trim() || "";

  if (typeof body.transcript === "string" && body.transcript) {
    const name = basename(body.transcript);
    const path = join(TRANSCRIPTS_DIR, name);
    if (name !== body.transcript || !TRANSCRIPT_EXT.test(name) || !existsSync(path)) {
      return c.json({ error: `unknown transcript '${body.transcript}'` }, 400);
    }
    content = readFileSync(path, "utf8");
    title ||= name.replace(TRANSCRIPT_EXT, "");
  } else if (typeof body.content === "string" && body.content.trim()) {
    content = body.content;
    title ||= "Pasted transcript";
  }

  let parsed: ParseResult | null = null;
  if (content) {
    try {
      parsed = parseTranscriptDetailed(content);
    } catch (e) {
      if (e instanceof TranscriptParseError) return c.json({ error: e.message }, 400);
      throw e;
    }
  }
  const utterances = parsed?.utterances ?? [];
  if (!live && utterances.length === 0) {
    return c.json({ error: "no utterances found; pass a transcript, transcript content, or live: true" }, 400);
  }

  const session = newSession(title, live);
  const speed = Number(body.speed) > 0 ? Number(body.speed) : 1;
  if (!live) session.replay(utterances, speed);
  console.log(
    `session ${session.id}: ${live ? "live" : `replay ${utterances.length} lines (${parsed!.formatLabel}, times ${parsed!.timing}) at ${speed}x`}`,
  );
  return c.json({ id: session.id, parse: parsed ? parseInfo(parsed) : null });
});

registerLiveRoutes(app, {
  port: PORT,
  getSession: (id) => sessions.get(id),
  createLiveSession: (title) => {
    const s = newSession(title, true);
    console.log(`session ${s.id}: live (meeting bot)`);
    return s;
  },
});

app.get("/api/session/:id", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  return c.json(s.snapshot());
});

app.post("/api/session/:id/control", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const body = await readJson<{ action: string; speed: number }>(c.req.raw);
  if (body.speed !== undefined) {
    const speed = Number(body.speed);
    if (!(speed > 0)) return c.json({ error: "speed must be > 0" }, 400);
    s.setSpeed(speed);
  }
  switch (body.action) {
    case "pause":
      s.pause();
      break;
    case "resume":
      s.resume();
      break;
    case "finish":
      s.finish();
      break;
    case "flush":
      s.flush();
      break;
    case undefined:
      if (body.speed === undefined) return c.json({ error: "action or speed required" }, 400);
      break;
    default:
      return c.json({ error: `unknown action '${body.action}'` }, 400);
  }
  return c.json({ ok: true, status: s.status });
});

app.post("/api/session/:id/utterance", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const body = await readJson<{ speaker: string; text: string }>(c.req.raw);
  const speaker = String(body.speaker ?? "").trim() || "Guest";
  const text = String(body.text ?? "").trim();
  if (!text) return c.json({ error: "text is required" }, 400);
  const utt = s.addUtterance({ speaker, text });
  return c.json({ ok: true, utterance: utt });
});

app.post("/api/session/:id/edit", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const body = await readJson<{ op: { name: string; input: Record<string, unknown> } }>(c.req.raw);
  const op = body.op;
  if (!op || typeof op.name !== "string" || !isOpName(op.name)) {
    return c.json({ error: `unknown operation '${op?.name}'` }, 400);
  }
  // The op schemas require grounding (ts + quote) on several ops; human edits are
  // attributed to the UI at the current meeting time instead.
  const input: Record<string, unknown> = { ...(op.input ?? {}) };
  input.ts ??= formatTs(s.meetingTime());
  input.quote ??= "edited in UI";
  if (op.name === "update_item" || op.name === "supersede_item" || op.name === "remove_component" || op.name === "remove_edge") {
    input.reason ??= "edited in UI";
  }
  const r = s.humanEdit({ name: op.name, input } as Op);
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({ ok: true });
});

app.get("/api/session/:id/doc.md", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  const name = (s.state.meeting.title || s.title || "design-doc").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${name || "design-doc"}.md"`);
  return c.body(s.markdown());
});

app.get("/api/session/:id/events", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "no such session" }, 404);
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let closed = false;
    let lastSent = 0;
    let pending: NodeJS.Timeout | null = null;
    let eventId = 0;
    const MIN_GAP_MS = 250;

    const send = async () => {
      pending = null;
      if (closed) return;
      lastSent = Date.now();
      try {
        await stream.writeSSE({ event: "snapshot", id: String(++eventId), data: JSON.stringify(s.snapshot()) });
      } catch {
        closed = true;
      }
    };
    // Throttle with a trailing send so the last change is always delivered.
    const onChange = () => {
      if (closed || pending) return;
      const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastSent));
      pending = setTimeout(() => void send(), wait);
    };
    s.on("change", onChange);
    const heartbeat = setInterval(() => {
      if (!closed) void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => (closed = true));
    }, 15_000);

    await new Promise<void>((done) => {
      let finished = false;
      let watch: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        closed = true;
        s.off("change", onChange);
        clearInterval(heartbeat);
        clearInterval(watch);
        if (pending) clearTimeout(pending);
        pending = null;
        done();
      };
      // A replaced (disposed) session, or a failed write, ends the stream too.
      watch = setInterval(() => {
        if (closed || sessions.get(s.id) !== s) cleanup();
      }, 1000);
      stream.onAbort(cleanup);
      void send();
    });
  });
});

// Production: serve the built web app with SPA fallback.
if (existsSync(DIST_DIR)) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    return c.html(readFileSync(join(DIST_DIR, "index.html"), "utf8"));
  });
} else {
  app.get("/", (c) =>
    c.text("Web app not built. Run `pnpm dev` (UI on the Vite port) or `pnpm start`.", 200),
  );
}

if (!process.env.ANTHROPIC_API_KEY) console.warn("warning: ANTHROPIC_API_KEY is not set; agent calls will fail");

// Local tool: listen on loopback only (set HOST=0.0.0.0 to expose it deliberately).
const HOST = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`meeting-whiteboard server on http://localhost:${info.port}`);
});
// Browser audio for live transcription (WebSocket on the same port).
attachAudioRelay(server as unknown as import("node:http").Server, { getSession: (id) => sessions.get(id) });
// With a Recall key and no PUBLIC_URL, open the quick tunnel now so it is reachable by the time a bot is sent.
if (process.env.RECALL_API_KEY && !process.env.PUBLIC_URL && process.env.AUTO_TUNNEL !== "0") {
  ensurePublicUrl(PORT).catch((e: Error) => console.warn(`tunnel not started: ${e.message.split("\n")[0]}`));
}

const shutdown = () => {
  stopTunnel();
  for (const s of sessions.values()) s.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
