/**
 * Live audio capture in the browser.
 *
 * Microphone (getUserMedia) and/or a meeting tab's audio (getDisplayMedia with "share tab audio")
 * are each resampled to 24 kHz mono PCM16 in an AudioWorklet and streamed over a WebSocket to our
 * server, which relays them to OpenAI's realtime transcription. Each source has its own stream.
 * With diarization on (server default), lines get detected speakers ("Speaker 1", ...) that can be
 * renamed; otherwise they are labelled by source ("Mic" / "Meeting"). Picking who is speaking wins.
 */

export type LiveMode = "type" | "mic" | "tab" | "tab+mic";
export type Source = "mic" | "meeting";

export interface SourceState {
  source: Source;
  status: "connecting" | "listening" | "stopped" | "error";
  model: string | null;
  level: number;
  partial: string;
  error: string | null;
  label: string;
  /** The server labels speakers automatically. */
  diarize: boolean;
}

export interface CaptureState {
  sources: SourceState[];
  speaker: string | null;
  /** The source the "speaking now" choice applies to. */
  target: Source;
}

// Runs in the audio thread: mono mixdown, linear resampling to 24 kHz, 100 ms Int16 chunks.
const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 24000;
    this.t = 0;
    this.last = 0;
    this.out = new Int16Array(2400);
    this.n = 0;
    this.sq = 0;
  }
  emit(v) {
    v = v < -1 ? -1 : v > 1 ? 1 : v;
    this.sq += v * v;
    this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.n === this.out.length) {
      const rms = Math.sqrt(this.sq / this.n);
      this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
      this.out = new Int16Array(2400);
      this.n = 0;
      this.sq = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const len = input[0].length;
    const mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / input.length;
    }
    let t = this.t;
    while (t < len - 1) {
      const i = Math.floor(t);
      const f = t - i;
      const s0 = i < 0 ? this.last : mono[i];
      const s1 = mono[i + 1];
      this.emit(s0 + (s1 - s0) * f);
      t += this.ratio;
    }
    this.t = t - len;
    this.last = mono[len - 1];
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

let workletUrl: string | null = null;

/** Streams one MediaStream's audio to the server. */
class SourceStreamer {
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private closedByUs = false;

  constructor(
    readonly source: Source,
    private stream: MediaStream,
    private onUpdate: (patch: Partial<SourceState>) => void,
  ) {}

  async start(sessionId: string, label: string) {
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfOutputs: 1 });
    // Keep the graph pulled without playing anything back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ session: sessionId, source: this.source, label });
    const ws = new WebSocket(`${proto}://${location.host}/api/live/audio?${q}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let lastLevel = 0;
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data.pcm);
      const now = performance.now();
      if (now - lastLevel > 150) {
        lastLevel = now;
        this.onUpdate({ level: Math.min(1, e.data.rms * 6) });
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data) as { type: string; text?: string; message?: string; model?: string; diarize?: boolean };
      if (m.type === "ready") this.onUpdate({ status: "listening", model: m.model ?? null, error: null, diarize: !!m.diarize });
      else if (m.type === "partial") this.onUpdate({ partial: m.text ?? "" });
      else if (m.type === "final") this.onUpdate({ partial: "" });
      else if (m.type === "error") this.onUpdate({ error: m.message ?? "error" });
    };
    ws.onclose = (e) => {
      this.stopCapture();
      if (this.closedByUs) this.onUpdate({ status: "stopped", partial: "", level: 0 });
      else this.onUpdate({ status: "error", level: 0, error: e.reason ? `connection closed: ${e.reason}` : "connection to the server closed" });
    };
    // A track can end from the browser UI ("Stop sharing").
    for (const t of this.stream.getAudioTracks()) t.addEventListener("ended", () => void this.stop());
  }

  /** Returns false when the stream is not connected. */
  rename(from: string, to: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "rename", from, to }));
    return true;
  }

  setSpeaker(name: string | null) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "speaker", name: name ?? "" }));
  }

  private stopCapture() {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    for (const t of this.stream.getTracks()) t.stop();
  }

  /** Flush the last turn on the server, then close. */
  async stop() {
    if (this.closedByUs) return;
    this.closedByUs = true;
    this.stopCapture();
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
      // The server closes after the final transcript; don't wait forever.
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          ws.close();
          r();
        }, 4000);
        ws.addEventListener("close", () => {
          clearTimeout(t);
          r();
        });
      });
    } else {
      ws.close();
    }
  }
}

export async function getMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot capture audio (needs https or localhost).");
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

/** Ask the user to share a tab (Meet / Zoom web / Teams web) with its audio. */
export async function getTabAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot capture tab audio; use Chrome or Edge.");
  const opts = {
    video: true, // required by Chrome; not used
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    systemAudio: "include",
    surfaceSwitching: "include",
  } as DisplayMediaStreamOptions;
  const display = await navigator.mediaDevices.getDisplayMedia(opts);
  const audio = display.getAudioTracks();
  if (audio.length === 0) {
    for (const t of display.getTracks()) t.stop();
    throw new Error('No audio was shared. Pick the meeting\'s browser tab and turn on "Also share tab audio".');
  }
  // The video track stays alive (unused): stopping it can end the whole share in some browsers.
  // All tracks are stopped together when the capture stops.
  return display;
}

/** One live capture: one or two sources, a shared "speaking now" choice. */
export class LiveCapture {
  private streamers: SourceStreamer[] = [];
  private state: CaptureState;
  private listeners = new Set<() => void>();

  private constructor(
    private streams: { source: Source; stream: MediaStream; label: string }[],
  ) {
    this.state = {
      sources: streams.map((s) => ({ source: s.source, status: "connecting", model: null, level: 0, partial: "", error: null, label: s.label, diarize: false })),
      speaker: null,
      target: streams.some((s) => s.source === "meeting") ? "meeting" : "mic",
    };
  }

  /** Must run inside a click handler (getDisplayMedia needs a user gesture). */
  static async acquire(mode: Exclude<LiveMode, "type">, micLabel: string): Promise<LiveCapture> {
    const streams: { source: Source; stream: MediaStream; label: string }[] = [];
    try {
      if (mode === "tab" || mode === "tab+mic") streams.push({ source: "meeting", stream: await getTabAudio(), label: "Meeting" });
      if (mode === "mic" || mode === "tab+mic")
        streams.push({ source: "mic", stream: await getMic(), label: mode === "tab+mic" ? micLabel || "Mic" : "Mic" });
    } catch (e) {
      for (const s of streams) for (const t of s.stream.getTracks()) t.stop();
      throw e instanceof DOMException && e.name === "NotAllowedError" ? new Error("Permission to capture audio was denied.") : e;
    }
    return new LiveCapture(streams);
  }

  async start(sessionId: string) {
    for (const s of this.streams) {
      const st = new SourceStreamer(s.source, s.stream, (patch) => this.patch(s.source, patch));
      this.streamers.push(st);
      await st.start(sessionId, s.label);
    }
  }

  setSpeaker(name: string | null) {
    this.state = { ...this.state, speaker: name };
    this.streamers.find((s) => s.source === this.state.target)?.setSpeaker(name);
    this.notify();
  }

  /** "Speaker 1" -> "Lena": future lines and past transcript lines (the server's voice registry is per session). */
  renameSpeaker(from: string, to: string) {
    for (const s of this.streamers) if (s.rename(from, to)) return;
  }

  async stop() {
    await Promise.all(this.streamers.map((s) => s.stop()));
  }

  get active() {
    return this.state.sources.some((s) => s.status === "connecting" || s.status === "listening");
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private patch(source: Source, patch: Partial<SourceState>) {
    this.state = { ...this.state, sources: this.state.sources.map((s) => (s.source === source ? { ...s, ...patch } : s)) };
    this.notify();
  }

  private notify() {
    for (const l of this.listeners) l();
  }
}
