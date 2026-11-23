/**
 * Streaming speech-to-text through the OpenAI Realtime API in transcription mode.
 *
 *   wss://api.openai.com/v1/realtime?intent=transcription
 *   -> session.update { type: "transcription", audio.input: { format, transcription, turn_detection } }
 *   -> input_audio_buffer.append (base64 PCM16, 24 kHz mono)
 *   <- input_audio_buffer.speech_started / committed
 *   <- conversation.item.input_audio_transcription.delta / .completed
 *
 * Two ways to cut the audio into utterances:
 *  - "server": OpenAI's server VAD decides turns (models that support it: gpt-4o-transcribe,
 *    gpt-4o-mini-transcribe, gpt-transcribe, whisper-1).
 *  - "local": our own energy VAD commits the buffer at pauses (required for gpt-live-transcribe and
 *    gpt-realtime-whisper, which take turn_detection: null). Only speech (plus a short pre-roll)
 *    is sent, so silence is not billed.
 *
 * The API key never leaves the server.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** Models that need turn_detection: null (we segment locally). */
const LOCAL_VAD_MODELS = new Set(["gpt-live-transcribe", "gpt-realtime-whisper"]);

export interface TranscriberOptions {
  apiKey: string;
  model: string;
  /** ISO-639-1 code, e.g. "en". */
  language?: string;
  /** Vocabulary hint (names, product terms). Ignored by models that do not take it. */
  prompt?: string;
  vad?: "server" | "local";
  /** Server VAD tuning. Longer silence gives sentence-length segments instead of fragments. */
  silenceMs?: number;
  noiseReduction?: "near_field" | "far_field" | null;
  url?: string;
}

export interface SegmentInfo {
  itemId: string;
  /** Start / end of the speech within this stream's audio, in ms. */
  audioStartMs: number;
  audioEndMs?: number;
}

/**
 * Events:
 *  - "speech" (info: SegmentInfo)               a turn started
 *  - "delta"  (itemId, text)                     partial transcript
 *  - "final"  (text, info: SegmentInfo)          completed transcript for one turn
 *  - "error"  (message)                          API or transport error (non-fatal unless followed by "close")
 *  - "ready" / "close"
 */
export class RealtimeTranscriber extends EventEmitter {
  readonly model: string;
  readonly vad: "server" | "local";
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private queue: Buffer[] = [];
  /** Total audio received from the client (ms), the clock that turn offsets refer to. */
  private receivedMs = 0;
  private starts = new Map<string, number>();
  private ends = new Map<string, number>();
  private local: LocalVad | null = null;
  /** Local VAD: start offsets of committed turns, matched to `committed` events in order. */
  private pendingCommits: { startMs: number; endMs: number }[] = [];

  constructor(private opts: TranscriberOptions) {
    super();
    this.model = opts.model;
    this.vad = opts.vad ?? (LOCAL_VAD_MODELS.has(opts.model) ? "local" : "server");
    if (this.vad === "local") this.local = new LocalVad();
  }

  connect(): Promise<void> {
    const url = this.opts.url ?? "wss://api.openai.com/v1/realtime?intent=transcription";
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        }
      };
      ws.on("open", () => {
        this.send({ type: "session.update", session: this.sessionConfig() });
      });
      ws.on("message", (data) => {
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(String(data));
        } catch {
          return;
        }
        if (ev.type === "session.updated" && !this.ready) {
          this.ready = true;
          for (const b of this.queue) this.sendAudio(b);
          this.queue = [];
          settled = true;
          resolve();
          this.emit("ready");
        }
        if (ev.type === "error" && !this.ready) fail(ev.error?.message ?? "realtime session error");
        this.onEvent(ev);
      });
      ws.on("error", (err) => {
        fail(err.message);
        this.emit("error", err.message);
      });
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c));
        res.on("end", () => fail(`OpenAI realtime: HTTP ${res.statusCode} ${body.slice(0, 300)}`));
      });
      ws.on("close", (code, reason) => {
        this.ready = false;
        fail(`OpenAI realtime closed (${code} ${String(reason)})`);
        if (!this.closed) this.emit("error", `OpenAI connection closed (${code} ${String(reason) || "no reason"})`);
        this.closed = true;
        this.emit("close");
      });
    });
  }

  private sessionConfig() {
    const transcription: Record<string, unknown> = { model: this.model };
    if (this.model === "gpt-live-transcribe") {
      if (this.opts.language) transcription.languages = [this.opts.language];
    } else if (this.opts.language) {
      transcription.language = this.opts.language;
    }
    if (this.opts.prompt && this.model !== "gpt-realtime-whisper") transcription.prompt = this.opts.prompt;
    const input: Record<string, unknown> = {
      format: { type: "audio/pcm", rate: SAMPLE_RATE },
      transcription,
      turn_detection:
        this.vad === "server"
          ? { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: this.opts.silenceMs ?? 700 }
          : null,
    };
    if (this.opts.noiseReduction !== undefined) {
      input.noise_reduction = this.opts.noiseReduction ? { type: this.opts.noiseReduction } : null;
    }
    return { type: "transcription", audio: { input } };
  }

  private onEvent(ev: Record<string, any>) {
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        this.starts.set(ev.item_id, ev.audio_start_ms ?? this.receivedMs);
        this.emit("speech", { itemId: ev.item_id, audioStartMs: ev.audio_start_ms ?? this.receivedMs });
        break;
      case "input_audio_buffer.speech_stopped":
        this.ends.set(ev.item_id, ev.audio_end_ms ?? this.receivedMs);
        break;
      case "input_audio_buffer.committed":
        if (this.vad === "local") {
          const c = this.pendingCommits.shift();
          if (c) {
            this.starts.set(ev.item_id, c.startMs);
            this.ends.set(ev.item_id, c.endMs);
          }
        }
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (ev.delta) this.emit("delta", ev.item_id, ev.delta);
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(ev.transcript ?? "").trim();
        const info: SegmentInfo = {
          itemId: ev.item_id,
          audioStartMs: this.starts.get(ev.item_id) ?? this.receivedMs,
          audioEndMs: this.ends.get(ev.item_id),
        };
        this.starts.delete(ev.item_id);
        this.ends.delete(ev.item_id);
        if (text) this.emit("final", text, info);
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.emit("error", `transcription failed: ${ev.error?.message ?? "unknown error"}`);
        break;
      case "error":
        // Committing an empty buffer is harmless (local VAD edge case); everything else is reported.
        if (!/buffer too small|empty/i.test(ev.error?.message ?? "")) this.emit("error", ev.error?.message ?? "error");
        break;
    }
  }

  /** Feed PCM16 LE mono 24 kHz audio. */
  append(pcm: Buffer) {
    if (this.closed) return;
    const startMs = this.receivedMs;
    this.receivedMs += pcm.length / BYTES_PER_MS;
    if (this.local) {
      for (const action of this.local.push(pcm, startMs)) {
        if (action.type === "audio") this.sendOrQueue(action.pcm);
        else if (action.type === "start") this.emit("speech", { itemId: "", audioStartMs: action.atMs });
        else {
          this.pendingCommits.push({ startMs: action.startMs, endMs: action.endMs });
          this.sendOrQueueCommit();
        }
      }
      return;
    }
    this.sendOrQueue(pcm);
  }

  /** Audio received so far, in ms. */
  get positionMs() {
    return this.receivedMs;
  }

  /** Flush the current turn (local VAD) so the last words are not lost when the stream stops. */
  flush() {
    if (this.local) {
      const c = this.local.end(this.receivedMs);
      if (c) {
        this.pendingCommits.push(c);
        this.sendOrQueueCommit();
      }
    } else if (this.ready) {
      this.send({ type: "input_audio_buffer.commit" });
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private commitQueued = 0;
  private sendOrQueueCommit() {
    if (this.ready) this.send({ type: "input_audio_buffer.commit" });
    else this.commitQueued++;
  }

  private sendOrQueue(pcm: Buffer) {
    if (this.ready) this.sendAudio(pcm);
    else if (this.queue.length < 1500) this.queue.push(pcm); // ~30 s of 20 ms frames while connecting
  }

  private sendAudio(pcm: Buffer) {
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    while (this.commitQueued > 0) {
      this.commitQueued--;
      this.send({ type: "input_audio_buffer.commit" });
    }
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------------------
// Local energy VAD (used with models that do not do turn detection)

type VadAction =
  | { type: "audio"; pcm: Buffer }
  | { type: "start"; atMs: number }
  | { type: "commit"; startMs: number; endMs: number };

const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;

/**
 * Adaptive-threshold energy VAD over 20 ms frames: speech starts after 100 ms above the
 * threshold (with 300 ms pre-roll), and ends after `silenceMs` below it or at `maxTurnMs`.
 */
export class LocalVad {
  private buf: Buffer = Buffer.alloc(0);
  private noise = 0.003;
  private inSpeech = false;
  private loudRun = 0;
  private quietRun = 0;
  private turnStart = 0;
  private preroll: Buffer[] = [];

  constructor(
    private silenceMs = 700,
    private maxTurnMs = 25_000,
    private prerollMs = 300,
  ) {}

  push(pcm: Buffer, atMs: number): VadAction[] {
    const out: VadAction[] = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, pcm]) : pcm;
    let pos = atMs - this.buf.length / BYTES_PER_MS + pcm.length / BYTES_PER_MS;
    while (this.buf.length >= FRAME_BYTES) {
      const frame = this.buf.subarray(0, FRAME_BYTES);
      this.buf = this.buf.subarray(FRAME_BYTES);
      const level = rms(frame);
      const threshold = Math.max(0.012, this.noise * 3);
      const loud = level > threshold;
      if (!this.inSpeech) {
        this.noise = loud ? this.noise : this.noise * 0.95 + level * 0.05;
        this.preroll.push(Buffer.from(frame));
        if (this.preroll.length > this.prerollMs / FRAME_MS) this.preroll.shift();
        this.loudRun = loud ? this.loudRun + FRAME_MS : 0;
        if (this.loudRun >= 100) {
          this.inSpeech = true;
          this.quietRun = 0;
          this.turnStart = pos + FRAME_MS - this.preroll.length * FRAME_MS;
          out.push({ type: "start", atMs: this.turnStart });
          out.push({ type: "audio", pcm: Buffer.concat(this.preroll) });
          this.preroll = [];
        }
      } else {
        out.push({ type: "audio", pcm: Buffer.from(frame) });
        this.quietRun = loud ? 0 : this.quietRun + FRAME_MS;
        const end = pos + FRAME_MS;
        if (this.quietRun >= this.silenceMs || end - this.turnStart >= this.maxTurnMs) {
          out.push({ type: "commit", startMs: this.turnStart, endMs: end - this.quietRun });
          this.inSpeech = false;
          this.loudRun = 0;
        }
      }
      pos += FRAME_MS;
    }
    return out;
  }

  /** End of stream: commit an unfinished turn. */
  end(atMs: number): { startMs: number; endMs: number } | null {
    if (!this.inSpeech) return null;
    this.inSpeech = false;
    return { startMs: this.turnStart, endMs: atMs };
  }
}

function rms(frame: Buffer): number {
  let sum = 0;
  const n = frame.length / 2;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
