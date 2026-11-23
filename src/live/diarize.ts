/**
 * Automatic speaker labels for live audio.
 *
 * Realtime transcription gives us text and turn timing but no speakers. For each completed turn
 * the relay slices that turn's audio out of a rolling PCM buffer and sends it as a WAV to
 * OpenAI's file transcription endpoint with the diarization model:
 *
 *   POST /v1/audio/transcriptions
 *     model=gpt-4o-transcribe-diarize, response_format=diarized_json, chunking_strategy=auto,
 *     known_speaker_names[]=..., known_speaker_references[]=data:audio/wav;base64,...  (max 4, 2–10 s)
 *   <- { segments: [{ speaker, start, end, text }, ...] }
 *
 * A turn's speaker is the label with the most speaking time in it. The first time a label comes
 * back that is not a known speaker (the model then answers "A", "B", ...), a 2–10 s clip of that
 * label from the turn is saved as a reference named "Speaker 1", "Speaker 2", ... and passed on
 * every later call, so the same voice keeps the same name for the whole meeting.
 */

export const DEFAULT_DIARIZE_MODEL = "gpt-4o-transcribe-diarize";
const SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 48

// ---------------------------------------------------------------------------------------
// Audio helpers

/** Wrap PCM16 LE mono samples in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer, rate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const msToByte = (ms: number) => Math.max(0, Math.round(ms * (BYTES_PER_MS / 2))) * 2; // sample-aligned

/** The last `maxMs` of a PCM16 24 kHz mono stream, addressable by stream time in ms. */
export class PcmRing {
  private chunks: { atMs: number; buf: Buffer }[] = [];
  private totalMs = 0;

  constructor(private maxMs = 180_000) {}

  /** Stream time (ms) just after the last appended sample. */
  get endMs() {
    return this.totalMs;
  }

  append(buf: Buffer) {
    this.chunks.push({ atMs: this.totalMs, buf });
    this.totalMs += buf.length / BYTES_PER_MS;
    while (this.chunks.length > 1 && this.chunks[1]!.atMs < this.totalMs - this.maxMs) this.chunks.shift();
  }

  /** Audio between two stream times (clamped to what is still buffered). */
  slice(startMs: number, endMs: number): Buffer {
    const out: Buffer[] = [];
    for (const c of this.chunks) {
      const cEnd = c.atMs + c.buf.length / BYTES_PER_MS;
      if (cEnd <= startMs || c.atMs >= endMs) continue;
      const from = msToByte(Math.max(0, startMs - c.atMs));
      const to = Math.min(c.buf.length, msToByte(endMs - c.atMs));
      if (to > from) out.push(c.buf.subarray(from, to));
    }
    return Buffer.concat(out);
  }
}

/** Cut [start, end) second ranges out of a PCM buffer and join them, up to `maxMs`. */
export function cutSegments(pcm: Buffer, ranges: { start: number; end: number }[], maxMs: number): Buffer {
  const parts: Buffer[] = [];
  let left = msToByte(maxMs);
  for (const r of ranges) {
    if (left <= 0) break;
    const from = Math.min(pcm.length, msToByte(r.start * 1000));
    const to = Math.min(pcm.length, msToByte(r.end * 1000), from + left);
    if (to > from) {
      parts.push(pcm.subarray(from, to));
      left -= to - from;
    }
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------
// The API call

export interface DiarizedSegment {
  speaker: string;
  /** Seconds from the start of the submitted audio. */
  start: number;
  end: number;
  text?: string;
}

export type DiarizeFn = (wav: Buffer, known: { name: string; wav: Buffer }[]) => Promise<DiarizedSegment[]>;

export function diarizeConfig(apiKey: string | undefined) {
  const flag = process.env.DIARIZE;
  return {
    enabled: !!apiKey && flag !== "0" && flag !== "false",
    model: process.env.DIARIZE_MODEL || DEFAULT_DIARIZE_MODEL,
    timeoutMs: Number(process.env.DIARIZE_TIMEOUT_MS) || 8000,
    mode: (process.env.DIARIZE_MODE === "context" ? "context" : "refs") as DiarizeMode,
  };
}

/** gpt-4o-transcribe-diarize through /v1/audio/transcriptions. */
export function openaiDiarize(apiKey: string, model = DEFAULT_DIARIZE_MODEL, baseUrl = "https://api.openai.com/v1"): DiarizeFn {
  return async (wav, known) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "turn.wav");
    form.append("model", model);
    form.append("response_format", "diarized_json");
    form.append("chunking_strategy", "auto");
    for (const k of known) {
      form.append("known_speaker_names[]", k.name);
      form.append("known_speaker_references[]", `data:audio/wav;base64,${k.wav.toString("base64")}`);
    }
    const res = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`diarize HTTP ${res.status}: ${body.slice(0, 300)}`);
    const json = JSON.parse(body) as { segments?: { speaker?: unknown; start?: unknown; end?: unknown; text?: unknown }[] };
    return (json.segments ?? [])
      .map((s) => ({ speaker: String(s.speaker ?? ""), start: Number(s.start) || 0, end: Number(s.end) || 0, text: typeof s.text === "string" ? s.text : undefined }))
      .filter((s) => s.speaker && s.end > s.start);
  };
}

// ---------------------------------------------------------------------------------------
// Enrolment and naming

/**
 * How known voices are given to the model:
 *  - "refs" (default): known_speaker_names[] + known_speaker_references[] (the API's enrolment feature).
 *  - "context": the reference clips are prepended to the turn in the same file and the labels the
 *    model gives the reference spans are mapped back to names. Re-sends the references on every
 *    call: about twice the latency (7–11 s with 3 speakers) and cost; an option if "refs" merges voices.
 */
export type DiarizeMode = "refs" | "context";

export interface RegistryOptions {
  mode?: DiarizeMode;
  maxKnown?: number;
  minRefMs?: number;
  maxRefMs?: number;
  log?: (msg: string) => void;
}

export interface LabelResult {
  /** The speaker for this turn, or null when diarization could not decide (caller falls back). */
  speaker: string | null;
  /** Raw majority label from the model. */
  raw?: string;
  enrolled?: string[];
  ms: number;
}

/**
 * Known speakers of one meeting. Calls run in parallel (serializing them made turns queue behind
 * slow calls and time out); a call that comes back with an unknown voice after another call
 * enrolled someone is retried once with the new references, so one voice is not enrolled twice.
 */
export class SpeakerRegistry {
  readonly known: { name: string; ref: Buffer }[] = [];
  /** Renames, so turns diarized before a rename still come out with the new name. */
  private aliases = new Map<string, string>();
  private next = 1;
  /** Bumped on every enrolment. */
  private version = 0;
  private maxKnown: number;
  private minRefMs: number;
  private maxRefMs: number;

  constructor(
    private diarize: DiarizeFn,
    opts: RegistryOptions = {},
  ) {
    this.maxKnown = opts.maxKnown ?? 4;
    this.minRefMs = opts.minRefMs ?? 2000;
    this.maxRefMs = opts.maxRefMs ?? 10_000;
    this.log = opts.log ?? (() => {});
    this.mode = opts.mode ?? "refs";
  }
  readonly mode: DiarizeMode;
  private log: (msg: string) => void;

  /** Label one turn's audio (PCM16 24 kHz mono). Never rejects. */
  async label(pcm: Buffer): Promise<LabelResult> {
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      const version = this.version;
      const segs = await this.call(pcm);
      if (!segs) return { speaker: null, ms: Date.now() - t0 };
      const unknown = segs.some((s) => !this.isKnown(this.resolve(s.speaker)));
      if (unknown && version !== this.version && attempt === 0) continue; // someone was enrolled meanwhile
      return { ...this.assign(pcm, segs), ms: Date.now() - t0 };
    }
  }

  /** The current display name for a label (follows renames). */
  resolve(name: string): string {
    const seen = new Set<string>();
    while (this.aliases.has(name) && !seen.has(name)) {
      seen.add(name);
      name = this.aliases.get(name)!;
    }
    return name;
  }

  /** "Speaker 1" -> "Lena": future calls pass the new name, so the model answers with it. */
  rename(from: string, to: string): boolean {
    if (!from || !to || from === to) return false;
    this.aliases.set(from, to);
    this.aliases.delete(to);
    const i = this.known.findIndex((k) => k.name === from);
    if (i < 0) return false;
    if (this.known.some((k) => k.name === to)) this.known.splice(i, 1); // merged into an existing speaker
    else this.known[i]!.name = to;
    return true;
  }

  private async call(pcm: Buffer): Promise<DiarizedSegment[] | null> {
    try {
      if (this.mode === "refs" || this.known.length === 0) {
        return await this.diarize(pcmToWav(pcm), this.known.map((k) => ({ name: k.name, wav: pcmToWav(k.ref) })));
      }
      // Context mode: the first 4 s of each reference is enough and keeps the file (and latency) small.
      const { file, spans, turnStart } = contextFile(
        this.known.map((k) => ({ name: k.name, ref: k.ref.subarray(0, msToByte(CONTEXT_REF_MS)) })),
        pcm,
      );
      return mapContextSegments(await this.diarize(pcmToWav(file), []), spans, turnStart);
    } catch (e) {
      this.log(`diarize failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Pick the majority label and enrol unknown voices. Exposed for tests. */
  assign(pcm: Buffer, segs: DiarizedSegment[]): Omit<LabelResult, "ms"> {
    const bySpeaker = new Map<string, { dur: number; ranges: { start: number; end: number }[] }>();
    for (const s0 of segs) {
      const s = { ...s0, speaker: this.resolve(s0.speaker) }; // a rename may have happened during the call
      const e = bySpeaker.get(s.speaker) ?? { dur: 0, ranges: [] };
      e.dur += s.end - s.start;
      e.ranges.push({ start: s.start, end: s.end });
      bySpeaker.set(s.speaker, e);
    }
    const ranked = [...bySpeaker.entries()].sort((a, b) => b[1].dur - a[1].dur);
    if (ranked.length === 0) return { speaker: null };
    const enrolled: string[] = [];
    const nameOf = new Map<string, string>();
    for (const [label, info] of ranked) {
      if (this.isKnown(label)) {
        nameOf.set(label, label);
        continue;
      }
      if (this.known.length >= this.maxKnown) continue;
      const ref = cutSegments(pcm, info.ranges, this.maxRefMs);
      if (ref.length / BYTES_PER_MS < this.minRefMs) continue;
      const name = this.freshName();
      this.known.push({ name, ref });
      this.version++;
      nameOf.set(label, name);
      enrolled.push(name);
      this.log(`diarize: enrolled ${name} (${(ref.length / BYTES_PER_MS / 1000).toFixed(1)} s reference)`);
    }
    const raw = ranked[0]![0];
    const picked = nameOf.get(raw);
    return { speaker: picked ? this.resolve(picked) : null, raw, enrolled };
  }

  private isKnown(label: string) {
    return this.known.some((k) => k.name === label);
  }

  private freshName() {
    let name: string;
    do name = `Speaker ${this.next++}`;
    while (this.isKnown(name) || this.aliases.has(name));
    return name;
  }
}

const GAP_MS = 600;
const CONTEXT_REF_MS = 4000;

/** [ref 1][gap][ref 2][gap]...[turn], with each reference's span in seconds. */
export function contextFile(known: { name: string; ref: Buffer }[], turn: Buffer) {
  const gap = Buffer.alloc(msToByte(GAP_MS));
  const parts: Buffer[] = [];
  const spans: { name: string; start: number; end: number }[] = [];
  let at = 0;
  for (const k of known) {
    const dur = k.ref.length / BYTES_PER_MS / 1000;
    spans.push({ name: k.name, start: at, end: at + dur });
    parts.push(k.ref, gap);
    at += dur + GAP_MS / 1000;
  }
  parts.push(turn);
  return { file: Buffer.concat(parts), spans, turnStart: at };
}

/**
 * Map the labels the model gave the reference spans to their names and keep only the turn's
 * segments (times shifted back to the turn). A label covering several references goes to the one
 * it overlaps most.
 */
export function mapContextSegments(segs: DiarizedSegment[], spans: { name: string; start: number; end: number }[], turnStart: number): DiarizedSegment[] {
  const overlap = new Map<string, Map<string, number>>(); // label -> name -> seconds
  for (const s of segs) {
    for (const sp of spans) {
      const o = Math.min(s.end, sp.end) - Math.max(s.start, sp.start);
      if (o <= 0) continue;
      const m = overlap.get(s.speaker) ?? new Map<string, number>();
      m.set(sp.name, (m.get(sp.name) ?? 0) + o);
      overlap.set(s.speaker, m);
    }
  }
  const nameOf = new Map<string, string>();
  for (const [label, m] of overlap) nameOf.set(label, [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
  return segs
    .filter((s) => s.end > turnStart + 0.05)
    .map((s) => ({ ...s, speaker: nameOf.get(s.speaker) ?? s.speaker, start: Math.max(0, s.start - turnStart), end: s.end - turnStart }));
}

/** Resolve `p` or `fallback` after `ms`, whichever comes first. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}
