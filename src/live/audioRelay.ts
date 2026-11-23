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
 * Client -> server also: {"type":"rename","from":"Speaker 1","to":"Lena"} renames a detected
 *                   speaker for future lines and rewrites past transcript lines.
 *
 * Speaker labels (see diarize.ts): realtime transcription has no diarization, so when DIARIZE is on
 * (the default with an OpenAI key) each completed turn's audio is sliced from a rolling buffer and
 * sent to gpt-4o-transcribe-diarize; voices are enrolled as "Speaker 1", "Speaker 2", ... and kept
 * consistent for the meeting. The line is added once that returns (or after a timeout, in order).
 * A speaker the user picks in the UI ("Speaking now", with 1 s of grace for a late click) always
 * wins; with neither, the line gets the source name ("Mic" / "Meeting").
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { isForwarded, originAllowed } from "./guard.js";
import { diarizeConfig, openaiDiarize, PcmRing, SpeakerRegistry, withTimeout, type DiarizeFn, type LabelResult } from "./diarize.js";
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
  /** Rewrite past lines' speaker (MeetingSession.renameSpeaker). */
  renameSpeaker?(from: string, to: string): number;
}

export interface RelayDeps {
  getSession(id: string): LiveSession | undefined;
  /** Defaults to OPENAI_API_KEY. */
  apiKey?: () => string | undefined;
  /** Inject a fake transcriber in tests. */
  makeTranscriber?: (opts: { model: string; language?: string; prompt?: string }) => TranscriberLike;
  log?: (msg: string) => void;
  /** Speaker diarization: false disables; a function replaces the OpenAI call (tests). Default: DIARIZE env + key. */
  diarize?: false | DiarizeFn;
  diarizeTimeoutMs?: number;
}

/** One registry of known voices per session, shared by its audio sources. */
const registries = new Map<string, SpeakerRegistry>();
export function speakerRegistry(sessionId: string): SpeakerRegistry | undefined {
  return registries.get(sessionId);
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

  const dcfg = diarizeConfig(apiKey);
  const diarizeFn: DiarizeFn | null =
    deps.diarize === false ? null : deps.diarize ? deps.diarize : dcfg.enabled ? openaiDiarize(apiKey!, dcfg.model) : null;
  const timeoutMs = deps.diarizeTimeoutMs ?? dcfg.timeoutMs;
  let registry: SpeakerRegistry | null = null;
  if (diarizeFn) {
    registry = registries.get(session.id) ?? null;
    if (!registry) {
      registry = new SpeakerRegistry(diarizeFn, { log, mode: dcfg.mode });
      registries.set(session.id, registry);
      if (registries.size > 50) registries.delete(registries.keys().next().value!);
    }
  }
  const ring = new PcmRing(180_000);

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
  // `manual`: picked by the user (a chip, or a mic label), which beats diarization.
  const initial = cleanName(params.get("label"), sourceName);
  const labels: { atMs: number; name: string; manual: boolean }[] = [{ atMs: 0, name: initial, manual: initial !== sourceName }];
  const labelAt = (ms: number) => {
    let l0 = labels[0]!;
    for (const l of labels) if (l.atMs <= ms + SPEAKER_GRACE_MS) l0 = l;
    return l0;
  };

  // Turns waiting for their speaker, emitted strictly in order.
  type Turn = { text: string; startMs: number; label: Promise<{ speaker: string; diarizeMs?: number; via: string }> ; done?: { speaker: string; diarizeMs?: number; via: string } };
  const queue: Turn[] = [];
  let drained: (() => void) | null = null;
  const emitTurn = (turn: Turn) => {
    const { speaker, diarizeMs, via } = turn.done!;
    const now = session.meetingTime();
    const last = session.transcript.at(-1)?.t ?? 0;
    const est = (baseMeetingSec ?? now) + turn.startMs / 1000;
    const utt = session.addUtterance({ speaker, text: turn.text, t: Math.min(now, Math.max(last, est)) });
    sendJson(ws, { type: "final", speaker, text: turn.text, ts: utt.ts, via, diarizeMs });
  };
  const pump = () => {
    while (queue.length && queue[0]!.done) emitTurn(queue.shift()!);
    if (!queue.length && drained) drained();
  };
  const enqueue = (text: string, startMs: number, endMs: number) => {
    const pick = labelAt(startMs);
    let label: Turn["label"];
    if (!registry || pick.manual) {
      label = Promise.resolve({ speaker: pick.name, via: pick.manual ? "manual" : "source" });
    } else {
      const reg = registry;
      const pcm = ring.slice(Math.max(0, startMs - 200), endMs + 200);
      const t0 = Date.now();
      const timedOut: LabelResult = { speaker: null, ms: -1 };
      label = withTimeout(reg.label(pcm), timeoutMs, timedOut).then((r) => {
        const ms = Date.now() - t0;
        if (r.ms < 0) log(`live audio (${source}): diarization timed out after ${ms} ms, using "${pick.name}"`);
        return r.speaker ? { speaker: reg.resolve(r.speaker), diarizeMs: ms, via: "diarize" } : { speaker: pick.name, diarizeMs: ms, via: r.ms < 0 ? "timeout" : "source" };
      });
    }
    const turn: Turn = { text, startMs, label };
    queue.push(turn);
    void label.then((d) => {
      // A rename may have happened while waiting.
      turn.done = registry ? { ...d, speaker: registry.resolve(d.speaker) } : d;
      pump();
    });
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
      const endMs = info.audioEndMs !== undefined ? baseMs + info.audioEndMs : streamMs;
      enqueue(text, startMs, Math.max(startMs, endMs));
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
        sendJson(ws, { type: "ready", model: t.model, source, diarize: !!registry });
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
      if (registry) ring.append(buf);
      tr.append(buf);
      return;
    }
    let msg: { type?: string; name?: unknown; from?: unknown; to?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "speaker") {
      const name = cleanName(msg.name, sourceName);
      labels.push({ atMs: streamMs, name, manual: String(msg.name ?? "").trim() !== "" && name !== sourceName });
      if (labels.length > 500) labels.splice(1, labels.length - 500);
    } else if (msg.type === "stop") {
      tr.flush();
      // Give the last turn a moment to come back (and get its speaker) before closing.
      setTimeout(() => {
        const close = () => ws.close(1000, "stopped");
        if (!queue.length) return close();
        drained = close;
        setTimeout(close, timeoutMs + 1000);
      }, 3000);
    } else if (msg.type === "rename") {
      const from = cleanName(msg.from, "");
      const to = cleanName(msg.to, "");
      if (!from || !to || from === to) return;
      registry?.rename(from, to);
      const n = session.renameSpeaker?.(from, to) ?? 0;
      log(`live audio: renamed "${from}" -> "${to}" (${n} past lines)`);
      sendJson(ws, { type: "renamed", from, to, lines: n });
    }
  });

  ws.on("close", () => {
    closed = true;
    active--;
    tr.close();
  });
}
