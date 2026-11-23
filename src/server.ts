/**
 * HTTP server for the live whiteboard UI.
 *
 *   pnpm dev    -> this file under `tsx watch` + Vite dev server (proxies /api here)
 *   pnpm start  -> builds the web app into dist/ and serves it from here
 *
 * One meeting session is active at a time; creating a new one disposes the old one.
 * The UI receives one full snapshot over SSE when it connects, then small deltas (new
 * transcript lines, new change events, the state when it changed; see src/wire.ts), and
 * sends human edits back as the same operations the agent uses.
 */
import "dotenv/config";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { emptyUsage, type AgentRuntime } from "./agent/index.js";
import { isOpName, type Op } from "./core/ops.js";
import { applyOp } from "./core/reducer.js";
import { emptyState, formatTs, parseTs, type ChangeEvent, type ChangeKind, type DocState, type Utterance } from "./core/types.js";
import { parseTranscriptDetailed, TranscriptParseError, type ParseResult } from "./ingest/transcript.js";
import { attachAudioRelay } from "./live/audioRelay.js";
import { apiGuard } from "./live/guard.js";
import { WEBHOOK_PATH } from "./live/recall.js";
import { registerLiveRoutes } from "./live/routes.js";
import { ensurePublicUrl, stopTunnel } from "./live/tunnel.js";
import { MeetingSession, percentile } from "./session.js";
import { statePatch, type LiveDelta, type LiveHeader, type LiveSnapshot, type SavedSessionInfo } from "./wire.js";

const ROOT = process.cwd();
const TRANSCRIPTS_DIR = resolve(ROOT, "transcripts");
const DIST_DIR = resolve(ROOT, "dist");
const OUT_DIR = "out";
const PORT = Number(process.env.PORT ?? 8787);
const TRANSCRIPT_EXT = /\.(jsonl|json|txt|md|vtt|srt)$/i;

const sessions = new Map<string, MeetingSession>();
/** Per-session facts the session itself does not keep. */
const sessionMeta = new Map<string, { createdAt: number; readOnly: boolean }>();

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
    sessionMeta.delete(id);
  }
}

function newSession(title: string, live: boolean): MeetingSession {
  disposeAll();
  const slug = (title || "live").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  const id = `${slug}-${Date.now()}`;
  const session = new MeetingSession({ id, outDir: OUT_DIR, title: title || "Live meeting" });
  sessions.set(id, session);
  sessionMeta.set(id, { createdAt: Date.now(), readOnly: false });
  // Keep the transcript next to state.json / events.jsonl so a past session can be reopened.
  const transcriptFile = join(OUT_DIR, id, "transcript.jsonl");
  session.on("utterance", (u: Utterance) => {
    try {
      appendFileSync(transcriptFile, JSON.stringify({ time: u.ts, speaker: u.speaker, text: u.text }) + "\n");
    } catch {
      /* best effort */
    }
  });
  if (live) session.startLive();
  return session;
}

// ---------- saved sessions (out/<id>/), opened for viewing ----------

/** An agent that never calls a model: a reopened session is a fixed record. */
const NO_AGENT: AgentRuntime = {
  config: { model: "recorded run" },
  step: async () => ({ applied: 0, errors: [], note: "", usage: emptyUsage() }),
};

function savedDir(name: string): string | null {
  if (basename(name) !== name || name.startsWith(".")) return null;
  const dir = join(OUT_DIR, name);
  return existsSync(join(dir, "state.json")) ? dir : null;
}

/** The transcript a saved session ran on: its own copy, else the transcripts/ file its name points at. */
function savedTranscript(name: string, dir: string): Utterance[] {
  const own = join(dir, "transcript.jsonl");
  const candidates = [own];
  const base = name.replace(/^eval-/, "").replace(/-(\d{13}|\d{4}-\d{2}-\d{2}T[\d-]+Z(-r\d+)?)$/, "");
  for (const ext of [".jsonl", ".json", ".txt", ".vtt", ".srt", ".md"]) candidates.push(join(TRANSCRIPTS_DIR, base + ext));
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      return parseTranscriptDetailed(readFileSync(f, "utf8")).utterances;
    } catch {
      /* try the next */
    }
  }
  return [];
}

/** Saved states may predate topics / confidence / event kinds. */
function normalizeState(raw: DocState): DocState {
  const s = raw as DocState & Partial<Pick<DocState, "topics">>;
  const items = Object.fromEntries(
    Object.entries(s.items ?? {}).map(([id, i]) => [id, { ...i, topic: i.topic ?? null, confidence: i.confidence ?? "high" }]),
  );
  return {
    ...s,
    topics: s.topics ?? {},
    items,
    order: { ...s.order, topics: s.order?.topics ?? [] },
  };
}

function inferKind(e: ChangeEvent): ChangeKind {
  if (e.kind) return e.kind;
  const input = (e.input ?? {}) as { kind?: string; status?: string; detail?: string };
  switch (e.op) {
    case "supersede_item":
      return "replaced";
    case "confirm_item":
      return "confirmed";
    case "set_meeting_info":
    case "upsert_topic":
      return "noted";
    case "upsert_component":
    case "remove_component":
    case "upsert_edge":
    case "remove_edge":
    case "set_overview":
      return "diagram";
    case "record_item":
      if (input.kind === "action_item") return "action";
      if (input.kind === "open_question") return "opened";
      if (input.kind === "decision") return input.status === "proposed" ? "proposed" : input.status === "rejected" ? "rejected" : "decided";
      return "noted";
    case "update_item":
      if (input.status === "rejected") return "rejected";
      if (input.status === "resolved") return "resolved";
      if (input.status === "accepted" || input.status === "tentative") return "decided";
      return "revised";
    default:
      return "other";
  }
}

function listSaved(): SavedSessionInfo[] {
  if (!existsSync(OUT_DIR)) return [];
  const out: SavedSessionInfo[] = [];
  for (const name of readdirSync(OUT_DIR)) {
    const dir = savedDir(name);
    if (!dir) continue;
    try {
      const st = statSync(join(dir, "state.json"));
      const state = normalizeState(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as DocState);
      const own = join(dir, "transcript.jsonl");
      out.push({
        name,
        title: state.meeting?.title || name,
        items: Object.keys(state.items).length,
        topics: Object.keys(state.topics).length,
        components: Object.keys(state.components ?? {}).length,
        lines: existsSync(own) ? readFileSync(own, "utf8").split("\n").filter(Boolean).length : -1,
        modifiedAt: st.mtime.toISOString(),
      });
    } catch {
      /* unreadable: skip */
    }
  }
  return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1)).slice(0, 60);
}

async function openSaved(name: string): Promise<MeetingSession | null> {
  const dir = savedDir(name);
  if (!dir) return null;
  const state = normalizeState(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as DocState);
  const eventsFile = join(dir, "events.jsonl");
  const events: ChangeEvent[] = existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ChangeEvent)
        .map((e) => ({ ...e, kind: inferKind(e) }))
    : [];
  disposeAll();
  const id = `saved-${name}`.slice(0, 120);
  const s = new MeetingSession({ id, title: state.meeting.title || name, agent: NO_AGENT, manual: true, reviewOnFinish: false });
  s.transcript = savedTranscript(name, dir);
  s.state = state;
  s.events = events;
  sessions.set(id, s);
  sessionMeta.set(id, { createdAt: statSync(join(dir, "state.json")).mtimeMs, readOnly: true });
  await s.finish(); // marks every line processed (the no-op agent) and stops the clock
  return s;
}

/**
 * Development: re-run a saved session's recorded operations against its transcript on the
 * meeting clock, without calling a model, to watch the live UI (highlights, diagram moves).
 */
function replaySaved(name: string, speed: number): MeetingSession | null {
  const dir = savedDir(name);
  if (!dir) return null;
  const eventsFile = join(dir, "events.jsonl");
  if (!existsSync(eventsFile)) return null;
  const recorded = readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ChangeEvent);
  const lines = savedTranscript(name, dir);
  const title = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as DocState).meeting?.title || name;
  disposeAll();
  const id = `replay-${name}-${Date.now()}`.slice(0, 120);
  const s = new MeetingSession({ id, title, agent: NO_AGENT, manual: true, reviewOnFinish: false });
  s.state = emptyState();
  s.mode = "replay";
  s.speed = speed;
  s.status = "running";
  sessions.set(id, s);
  sessionMeta.set(id, { createdAt: Date.now(), readOnly: false });
  const LAG = 3; // meeting seconds between a line and the change it causes
  const steps: { t: number; run: () => void }[] = [];
  for (const u of lines) {
    steps.push({ t: u.t, run: () => s.addUtterance({ speaker: u.speaker, text: u.text, t: u.t }) });
  }
  for (const e of recorded) {
    const t = (Number.isNaN(parseTs(e.ts)) ? 0 : parseTs(e.ts)) + LAG;
    steps.push({
      t,
      run: () => {
        s.setClock(t);
        const r = applyOp(s.state, { name: e.op, input: e.input } as Op, {
          source: e.source,
          transcript: s.transcript,
          meetingTime: t,
          seq: s.events.length + 1,
        });
        if (!r.ok) return;
        s.state = r.state;
        s.events.push(r.event);
        void s.runTurn(); // the no-op agent marks the lines as processed
        s.emit("change");
      },
    });
  }
  steps.sort((a, b) => a.t - b.t);
  const timers: NodeJS.Timeout[] = [];
  for (const st of steps) {
    timers.push(
      setTimeout(() => {
        if (sessions.get(id) !== s) return;
        s.setClock(Math.max(st.t, 0));
        st.run();
      }, (st.t / speed) * 1000),
    );
  }
  const end = (steps.at(-1)?.t ?? 0) / speed + 1;
  timers.push(
    setTimeout(() => {
      if (sessions.get(id) === s) void s.finish();
    }, end * 1000),
  );
  return s;
}

// ---------- what the UI receives ----------

function liveHeader(s: MeetingSession): LiveHeader {
  const meta = sessionMeta.get(s.id);
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    agentBusy: s.agentBusy,
    editorBusy: s.editorBusy,
    meetingTime: formatTs(s.meetingTime()),
    mode: s.mode,
    speed: s.speed,
    processedCount: s.transcript.length - s.pendingCount(),
    usage: s.usage,
    model: s.agent.config.model,
    editorModel: s.agent.config.editorModel ?? s.agent.config.model,
    latency: { p50: percentile(s.metrics.lineLatency, 50), p90: percentile(s.metrics.lineLatency, 90) },
    readOnly: meta?.readOnly ?? false,
    createdAt: meta?.createdAt ?? Date.now(),
  };
}

function liveSnapshot(s: MeetingSession): LiveSnapshot {
  return { ...liveHeader(s), transcript: s.transcript, state: s.state, events: s.events, log: s.log.slice(-200) };
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

/** Saved sessions in out/ (development and review: open a past meeting without spending API). */
app.get("/api/saved", (c) => c.json(listSaved()));

app.post("/api/saved/open", async (c) => {
  const body = await readJson<{ name: string; replay: number }>(c.req.raw);
  const name = String(body.name ?? "");
  const s = Number(body.replay) > 0 ? replaySaved(name, Number(body.replay)) : await openSaved(name);
  if (!s) return c.json({ error: `no saved session '${body.name}'` }, 404);
  return c.json({ id: s.id });
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
    // What this client already has.
    let sentState: DocState | null = null;
    const seen = new Map<string, string>();
    let sentLines = 0;
    let sentEvents = 0;
    let sentLog = 0;

    const write = async (event: string, data: unknown) => {
      try {
        await stream.writeSSE({ event, id: String(++eventId), data: JSON.stringify(data) });
      } catch {
        closed = true;
      }
    };
    const sendFull = async () => {
      const snap = liveSnapshot(s);
      sentState = s.state;
      seen.clear();
      statePatch(s.state, seen);
      sentLines = s.transcript.length;
      sentEvents = s.events.length;
      sentLog = s.log.length;
      lastSent = Date.now();
      await write("full", snap);
    };
    const sendDelta = async () => {
      pending = null;
      if (closed) return;
      lastSent = Date.now();
      const delta: LiveDelta = {
        ...liveHeader(s),
        patch: s.state !== sentState ? statePatch(s.state, seen) : undefined,
        transcriptFrom: sentLines,
        transcript: s.transcript.slice(sentLines),
        eventsFrom: sentEvents,
        events: s.events.slice(sentEvents),
        logFrom: sentLog,
        log: s.log.slice(sentLog),
      };
      sentState = s.state;
      sentLines = s.transcript.length;
      sentEvents = s.events.length;
      sentLog = s.log.length;
      await write("delta", delta);
    };
    // Throttle with a trailing send so the last change is always delivered.
    const onChange = () => {
      if (closed || pending) return;
      const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastSent));
      pending = setTimeout(() => void sendDelta(), wait);
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
      void sendFull();
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
