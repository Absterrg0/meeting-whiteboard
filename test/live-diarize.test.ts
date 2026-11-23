import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachAudioRelay, type LiveSession, type TranscriberLike } from "../src/live/audioRelay.js";
import { contextFile, cutSegments, mapContextSegments, PcmRing, pcmToWav, SpeakerRegistry, type DiarizedSegment, type DiarizeFn } from "../src/live/diarize.js";

const ms = (n: number, v = 0) => {
  const b = Buffer.alloc(n * 48);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(v, i * 2);
  return b;
};

describe("WAV + PCM slicing", () => {
  it("writes a valid 24 kHz mono PCM16 header", () => {
    const wav = pcmToWav(ms(1000));
    expect(wav.length).toBe(44 + 48_000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(36 + 48_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(48_000);
  });

  it("slices a time range across chunks and drops audio older than the window", () => {
    const ring = new PcmRing(1000);
    ring.append(ms(300, 1));
    ring.append(ms(300, 2));
    ring.append(ms(300, 3));
    const s = ring.slice(250, 650); // 50 ms of 1, 300 of 2, 50 of 3
    expect(s.length).toBe(400 * 48);
    expect(s.readInt16LE(0)).toBe(1);
    expect(s.readInt16LE(50 * 48)).toBe(2);
    expect(s.readInt16LE(s.length - 2)).toBe(3);
    ring.append(ms(900, 4));
    expect(ring.endMs).toBe(1800);
    expect(ring.slice(0, 300).length).toBe(0); // gone
    expect(ring.slice(900, 1800).length).toBe(900 * 48);
  });

  it("cuts segment ranges up to a maximum length", () => {
    const pcm = Buffer.concat([ms(1000, 1), ms(1000, 2), ms(1000, 3)]);
    const c = cutSegments(pcm, [{ start: 0.5, end: 1.5 }, { start: 2, end: 3 }], 1500);
    expect(c.length).toBe(1500 * 48);
    expect(c.readInt16LE(0)).toBe(1);
    expect(c.readInt16LE(c.length - 2)).toBe(3);
  });
});

describe("speaker enrolment and naming", () => {
  const seg = (speaker: string, start: number, end: number): DiarizedSegment => ({ speaker, start, end });

  it("enrols new voices as Speaker N, picks the majority, reuses known names", () => {
    const reg = new SpeakerRegistry(async () => []);
    const pcm = ms(8000);
    expect(reg.assign(pcm, [seg("A", 0, 5), seg("B", 5, 6)])).toMatchObject({ speaker: "Speaker 1", raw: "A", enrolled: ["Speaker 1"] });
    // B had only 1 s: too short for a reference, not enrolled.
    expect(reg.known.map((k) => k.name)).toEqual(["Speaker 1"]);
    expect(reg.known[0]!.ref.length).toBe(5000 * 48);
    expect(reg.assign(pcm, [seg("A", 0, 4)])).toMatchObject({ speaker: "Speaker 2", enrolled: ["Speaker 2"] });
    expect(reg.assign(pcm, [seg("Speaker 1", 0, 1), seg("Speaker 2", 1, 6)]).speaker).toBe("Speaker 2");
    // Unknown but too short: no decision (caller falls back).
    expect(reg.assign(pcm, [seg("C", 0, 1)]).speaker).toBeNull();
  });

  it("stops enrolling at 4 known speakers and caps references at 10 s", () => {
    const reg = new SpeakerRegistry(async () => []);
    const pcm = ms(15_000);
    for (let i = 0; i < 4; i++) reg.assign(pcm, [seg("A", 0, 14)]);
    expect(reg.known.map((k) => k.name)).toEqual(["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"]);
    expect(reg.known[0]!.ref.length).toBe(10_000 * 48);
    expect(reg.assign(pcm, [seg("A", 0, 5)]).speaker).toBeNull();
  });

  it("renames for future calls and for turns diarized before the rename", async () => {
    const calls: string[][] = [];
    const answers = [[seg("A", 0, 3)], [seg("Lena", 0, 3)]];
    const fn: DiarizeFn = async (_wav, known) => (calls.push(known.map((k) => k.name)), answers.shift()!);
    const reg = new SpeakerRegistry(fn, { mode: "refs" });
    expect((await reg.label(ms(4000))).speaker).toBe("Speaker 1");
    reg.rename("Speaker 1", "Lena");
    expect(reg.resolve("Speaker 1")).toBe("Lena");
    expect((await reg.label(ms(4000))).speaker).toBe("Lena");
    expect(calls).toEqual([[], ["Lena"]]);
    // The next new voice does not reuse a renamed slot.
    expect(reg.assign(ms(4000), [seg("B", 0, 3)]).speaker).toBe("Speaker 2");
  });

  it("context mode maps reference spans to names and keeps only the turn", () => {
    const known = [
      { name: "Speaker 1", ref: ms(3000) },
      { name: "Speaker 2", ref: ms(3000) },
    ];
    const { file, spans, turnStart } = contextFile(known, ms(2000));
    expect(spans).toEqual([
      { name: "Speaker 1", start: 0, end: 3 },
      { name: "Speaker 2", start: 3.6, end: 6.6 },
    ]);
    expect(turnStart).toBeCloseTo(7.2);
    expect(file.length).toBe((3000 + 600 + 3000 + 600 + 2000) * 48);
    const out = mapContextSegments([seg("A", 0, 3), seg("B", 3.6, 6.6), seg("B", 7.3, 8.5), seg("C", 8.5, 9)], spans, turnStart);
    expect(out.map((s) => s.speaker)).toEqual(["Speaker 2", "C"]);
    expect(out[0]!.start).toBeCloseTo(0.1);
  });

  it("retries once when another call enrolled a voice meanwhile, so it is not enrolled twice", async () => {
    const resolvers: ((s: DiarizedSegment[]) => void)[] = [];
    const reg = new SpeakerRegistry(() => new Promise((r) => resolvers.push(r)), { mode: "refs" });
    const a = reg.label(ms(4000));
    const b = reg.label(ms(4000));
    await Promise.resolve();
    resolvers[0]!([seg("A", 0, 3)]); // enrols Speaker 1
    expect((await a).speaker).toBe("Speaker 1");
    resolvers[1]!([seg("A", 0, 3)]); // started before the enrolment: retried
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvers.length).toBe(3);
    resolvers[2]!([seg("Speaker 1", 0, 3)]);
    expect((await b).speaker).toBe("Speaker 1");
    expect(reg.known.length).toBe(1);
  });

  it("a failing API call yields no label instead of throwing", async () => {
    const reg = new SpeakerRegistry(async () => {
      throw new Error("boom");
    });
    expect((await reg.label(ms(3000))).speaker).toBeNull();
  });
});

describe("relay with diarization", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  class Tr extends EventEmitter implements TranscriberLike {
    model = "fake";
    positionMs = 0;
    async connect() {}
    append() {}
    flush() {}
    close() {}
  }
  class Sess implements LiveSession {
    id = "d1";
    status = "running";
    transcript: { t: number; speaker: string; text: string }[] = [];
    meetingTime() {
      return 100;
    }
    addUtterance(u: { speaker: string; text: string; t?: number }) {
      this.transcript.push({ t: u.t ?? 100, speaker: u.speaker, text: u.text });
      return { ts: "x" };
    }
    renameSpeaker(from: string, to: string) {
      let n = 0;
      for (const u of this.transcript) if (u.speaker === from) (u.speaker = to), n++;
      return n;
    }
  }

  it("labels turns in order, falls back on timeout, lets a manual pick win, renames past lines", async () => {
    const session = new Sess();
    let tr: Tr | null = null;
    const pending: ((s: DiarizedSegment[]) => void)[] = [];
    const seen: number[] = [];
    server = createServer();
    attachAudioRelay(server, {
      getSession: () => session,
      makeTranscriber: () => (tr = new Tr()),
      diarize: (wav) => (seen.push(wav.length), new Promise((r) => pending.push(r))),
      diarizeTimeoutMs: 300,
      log: () => {},
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live/audio?session=d1&source=meeting`, { headers: { origin: `http://localhost:${port}` } });
    await new Promise((r) => ws.on("open", r));
    for (let i = 0; i < 100; i++) ws.send(ms(100));
    await new Promise((r) => setTimeout(r, 50));
    tr!.emit("final", "first", { audioStartMs: 0, audioEndMs: 4000 });
    tr!.emit("final", "second", { audioStartMs: 5000, audioEndMs: 9000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0]).toBe(44 + 4200 * 48); // turn + 200 ms padding at the end (none before 0)
    // Calls run in parallel.
    expect(pending.length).toBe(2);
    pending.shift()!([{ speaker: "A", start: 0, end: 3.5 }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(session.transcript.map((u) => u.speaker)).toEqual(["Speaker 1"]);
    // The second call never answers: falls back to the source label after the timeout.
    await new Promise((r) => setTimeout(r, 400));
    expect(session.transcript.map((u) => `${u.speaker}: ${u.text}`)).toEqual(["Speaker 1: first", "Meeting: second"]);
    pending.shift()!([]);
    // A manual pick skips diarization.
    ws.send(JSON.stringify({ type: "speaker", name: "Marcus" }));
    await new Promise((r) => setTimeout(r, 20));
    tr!.emit("final", "third", { audioStartMs: 9500, audioEndMs: 9900 });
    await new Promise((r) => setTimeout(r, 20));
    expect(session.transcript.at(-1)!.speaker).toBe("Marcus");
    ws.send(JSON.stringify({ type: "rename", from: "Speaker 1", to: "Lena" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(session.transcript.map((u) => u.speaker)).toEqual(["Lena", "Meeting", "Marcus"]);
    ws.close();
  });
});
