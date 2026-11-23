/**
 * Browser audio -> our server (WebSocket) -> OpenAI Realtime transcription -> session.addUtterance.
 *
 *   GET /api/live/audio?session=<id>&source=mic|meeting&label=<name>   (WebSocket upgrade)
 *
 * Client -> server: binary frames of PCM16 LE mono 24 kHz audio;
 *                   text frames {"type":"speaker","name":"Alice"} to set who is talking now,
 *                   {"type":"stop"} to flush the last turn and close.
 * Server -> client: {"type":"ready","model"} | {"type":"partial","text"} |
 *                   {"type":"final","speaker","text","ts"} | {"type":"error","message"}
 *
 * Realtime transcription has no diarization, so a segment is labelled with the speaker the
 * user picked in the UI at the moment the segment started (with 1 s of grace for a late click),
 * or the source name ("Mic" / "Meeting") when nobody was picked.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isForwarded, originAllowed } from "./guard.js";
import { RealtimeTranscriber } from "./openaiRealtime.js";

export const AUDIO_PATH = "/api/live/audio";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
const MAX_RELAYS = 4;
const SPEAKER_GRACE_MS = 1000;

/** What live sources need from a meeting session (MeetingSession satisfies it). */
export interface LiveSession {
  id: string;
  status: string;
  /** "live" for sessions fed by live sources (MeetingSession.mode). */
  mode?: string;
  transcript: readonly { t: number }[];
  meetingTime(): number;
  addUtterance(u: { speaker: string; text: string; t?: number }): { ts: string };
}

export interface RelayDeps {
  getSession(id: string): LiveSession | undefined;
  /** Defaults to OPENAI_API_KEY. */
  apiKey?: () => string | undefined;
  /** Inject a fake transcriber in tests. */
  makeTranscriber?: (opts: { model: string; language?: string; prompt?: string }) => TranscriberLike;
  log?: (msg: string) => void;
}

/** The subset of RealtimeTranscriber the relay uses. */
export interface TranscriberLike {
  readonly model: string;
  on(event: "final", fn: (text: string, info: { audioStartMs: number; audioEndMs?: number }) => void): unknown;
  on(event: "delta", fn: (itemId: string, text: string) => void): unknown;
  on(event: "speech", fn: (info: { audioStartMs: number }) => void): unknown;
  on(event: "error", fn: (message: string) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  connect(): Promise<void>;
  append(pcm: Buffer): void;
  flush(): void;
  close(): void;
  readonly positionMs: number;
}

export function transcribeConfig() {
  return {
    model: process.env.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
    language: process.env.TRANSCRIBE_LANGUAGE || "en",
  };
}

let active = 0;

/** Attach the audio WebSocket endpoint to the HTTP server. */
export function attachAudioRelay(server: Server, deps: RelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const log = deps.log ?? ((m: string) => console.log(m));

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== AUDIO_PATH) {
      // Not ours (e.g. Vite HMR is on another port); refuse.
      socket.destroy();
      return;
    }
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (isForwarded(header)) return reject(403, "Forbidden");
    if (!originAllowed(header("origin"), header("host"))) return reject(403, "Forbidden");
    const session = deps.getSession(url.searchParams.get("session") ?? "");
    if (!session) return reject(404, "Not Found");
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleClient(ws, session, url.searchParams, deps, log);
    });
  });
  return wss;
}

function sendJson(ws: WebSocket, obj: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export function cleanName(s: unknown, fallback: string): string {
  const n = String(s ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 60);
  return n || fallback;
}

function handleClient(ws: WebSocket, session: LiveSession, params: URLSearchParams, deps: RelayDeps, log: (m: string) => void) {
  const source = params.get("source") === "meeting" ? "meeting" : "mic";
  const sourceName = source === "meeting" ? "Meeting" : "Mic";
  const apiKey = (deps.apiKey ?? (() => process.env.OPENAI_API_KEY))();
  if (!apiKey && !deps.makeTranscriber) {
    sendJson(ws, { type: "error", message: "OPENAI_API_KEY is not set on the server; live audio needs it." });
    ws.close(1011, "no api key");
    return;
  }
  if (active >= MAX_RELAYS) {
    sendJson(ws, { type: "error", message: `too many live audio streams (max ${MAX_RELAYS})` });
    ws.close(1013, "busy");
    return;
  }
  active++;

  const cfg = transcribeConfig();
  const prompt = "A technical design meeting about software architecture.";
  const make = (): TranscriberLike =>
    deps.makeTranscriber
      ? deps.makeTranscriber({ model: cfg.model, language: cfg.language, prompt })
      : new RealtimeTranscriber({ apiKey: apiKey!, model: cfg.model, language: cfg.language, prompt });

  // One clock for the whole browser stream: ms of audio received. Transcriber offsets are
  // relative to when that transcriber started, so they are shifted onto this clock.
  let streamMs = 0;
  // Speaker timeline on the stream clock.
  const labels: { atMs: number; name: string }[] = [{ atMs: 0, name: cleanName(params.get("label"), sourceName) }];
  const labelAt = (ms: number) => {
    let name = labels[0]!.name;
    for (const l of labels) if (l.atMs <= ms + SPEAKER_GRACE_MS) name = l.name;
    return name;
  };
  // Meeting time at which the stream clock started (set on the first audio frame).
  let baseMeetingSec: number | null = null;
  let closed = false;
  let partial = "";
  let reconnects = 0;
  let tr: TranscriberLike;

  /**
   * (Re)start transcription. Realtime sessions have a maximum duration and can drop; while the
   * browser is still connected, a new one is opened transparently on the same stream clock.
   */
  const startTranscriber = (isRetry: boolean) => {
    const t = make();
    const baseMs = streamMs;
    tr = t;
    t.on("delta", (_id, text) => {
      partial += text;
      sendJson(ws, { type: "partial", text: partial });
    });
    t.on("speech", () => {
      partial = "";
    });
    t.on("final", (text, info) => {
      partial = "";
      const startMs = baseMs + info.audioStartMs;
      const speaker = labelAt(startMs);
      const now = session.meetingTime();
      const last = session.transcript.at(-1)?.t ?? 0;
      const est = (baseMeetingSec ?? now) + startMs / 1000;
      const utt = session.addUtterance({ speaker, text, t: Math.min(now, Math.max(last, est)) });
      sendJson(ws, { type: "final", speaker, text, ts: utt.ts });
    });
    t.on("error", (message) => sendJson(ws, { type: "error", message }));
    t.on("close", () => {
      if (closed || t !== tr) return;
      if (reconnects >= 20) {
        ws.close(1011, "transcription connection lost");
        return;
      }
      reconnects++;
      log(`live audio (${source}): transcription connection closed, reconnecting (${reconnects})`);
      setTimeout(() => !closed && startTranscriber(true), Math.min(5000, 500 * reconnects));
    });
    t.connect().then(
      () => {
        log(`live audio (${source}) -> ${t.model} for session ${session.id}${isRetry ? " (reconnected)" : ""}`);
        sendJson(ws, { type: "ready", model: t.model, source });
      },
      (err: Error) => {
        if (isRetry) return; // the close handler retries
        sendJson(ws, { type: "error", message: `could not start transcription: ${err.message}` });
        ws.close(1011, "transcriber failed");
      },
    );
  };
  startTranscriber(false);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (buf.length % 2 !== 0) return; // PCM16 frames only
      if (baseMeetingSec === null) baseMeetingSec = session.meetingTime();
      streamMs += buf.length / 48; // 24 kHz * 2 bytes = 48 bytes per ms
      tr.append(buf);
      return;
    }
    let msg: { type?: string; name?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "speaker") {
      labels.push({ atMs: streamMs, name: cleanName(msg.name, sourceName) });
      if (labels.length > 500) labels.splice(1, labels.length - 500);
    } else if (msg.type === "stop") {
      tr.flush();
      // Give the last turn a moment to come back before closing.
      setTimeout(() => ws.close(1000, "stopped"), 3000);
    }
  });

  ws.on("close", () => {
    closed = true;
    active--;
    tr.close();
  });
}
