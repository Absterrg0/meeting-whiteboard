/**
 * End-to-end check of the live audio path without a human or a microphone:
 *
 *   synthesized speech (OpenAI TTS, 3 voices) -> PCM16 24 kHz
 *   -> ws://.../api/live/audio (exactly what the browser sends)
 *   -> OpenAI realtime transcription + gpt-4o-transcribe-diarize -> session.addUtterance
 *
 * Usage:
 *   pnpm live:demo                 in-process relay + a minimal session (no scribe agent, no server needed)
 *   pnpm live:demo --server URL    against a running server (pnpm start); the scribe agent runs too
 *   pnpm live:demo --chips         old mode: switch the "speaking now" label per line, no diarization needed
 *   [--speed 1]                    >1 streams faster than real time
 *
 * Default (auto) mode asserts that every line is transcribed, each voice got one label, labels of
 * different voices differ, and a rename ("Speaker 1" -> "Priya") rewrites past lines.
 * Cost: ~45 s of TTS (cached in out/live-demo-audio) + ~45 s transcription + ~45 s diarization
 * (plus references), about $0.02.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { attachAudioRelay, type LiveSession } from "../src/live/audioRelay.js";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const CHIPS = args.includes("--chips");
const SPEED = Number(arg("speed", "1"));
const CACHE = join("out", "live-demo-audio");

const LINES: { speaker: string; voice: string; text: string }[] = [
  { speaker: "Priya", voice: "alloy", text: "Okay, let's get going. Today we need to agree on the queue for the webhook delivery workers." },
  { speaker: "Marcus", voice: "onyx", text: "I'd go with SQS. We already run it for billing, and the dead letter queue comes for free." },
  { speaker: "Lena", voice: "nova", text: "Before we pick, how many events per second are we expecting at peak? Kafka might be simpler for replay." },
  { speaker: "Priya", voice: "alloy", text: "Around two thousand at peak. What about retries? Earlier we said three attempts." },
  { speaker: "Marcus", voice: "onyx", text: "Let's change that to five retries with exponential backoff, capped at one hour." },
  { speaker: "Lena", voice: "nova", text: "Fine by me. Then SQS it is, and I'll write up the replay story separately." },
];

/** In-process stand-in for MeetingSession (what the relay needs). */
class DemoSession implements LiveSession {
  id = "demo";
  status = "running";
  mode = "live";
  transcript: { t: number; ts: string; speaker: string; text: string }[] = [];
  private t0 = Date.now();
  meetingTime() {
    return (Date.now() - this.t0) / 1000;
  }
  addUtterance(u: { speaker: string; text: string; t?: number }) {
    const t = u.t ?? this.meetingTime();
    const ts = new Date(t * 1000).toISOString().slice(14, 19);
    this.transcript.push({ t, ts, speaker: u.speaker, text: u.text });
    return { ts };
  }
  renameSpeaker(from: string, to: string) {
    let n = 0;
    for (const u of this.transcript) if (u.speaker === from) (u.speaker = to), n++;
    return n;
  }
}

async function tts(text: string, voice: string, file: string) {
  if (existsSync(file)) return;
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text, response_format: "pcm" }), // 24 kHz PCM16 mono
    });
    if (res.ok) {
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return;
    }
    console.warn(`OpenAI TTS failed (${res.status}); falling back to espeak-ng`);
  }
  const wav = execFileSync("espeak-ng", ["-v", voice === "onyx" ? "en-us+m3" : voice === "nova" ? "en-us+f5" : "en-us+f3", "--stdout", text]);
  const pcm = execFileSync("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"], { input: wav });
  writeFileSync(file, pcm);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const clips: Buffer[] = [];
  for (const l of LINES) {
    const f = join(CACHE, `${l.voice}-${createHash("sha1").update(l.text).digest("hex").slice(0, 10)}.pcm`);
    await tts(l.text, l.voice, f);
    clips.push(readFileSync(f));
  }

  // Either a running server, or the real relay in-process on a random port.
  let SERVER = arg("server", "");
  let local: DemoSession | null = null;
  let id: string;
  if (SERVER) {
    const res = await fetch(`${SERVER}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: true, title: "Live audio demo" }),
    });
    id = ((await res.json()) as { id: string }).id;
  } else {
    local = new DemoSession();
    id = local.id;
    const http = createServer();
    attachAudioRelay(http, { getSession: (sid) => (sid === local!.id ? local! : undefined), log: (m) => console.log(`  relay: ${m}`) });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    SERVER = `http://localhost:${(http.address() as AddressInfo).port}`;
  }
  console.log(`session ${id} via ${SERVER}`);

  const url = new URL(`/api/live/audio?session=${encodeURIComponent(id)}&source=meeting`, SERVER);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { origin: SERVER } });
  const t0 = Date.now();
  const delays: number[] = [];
  let diarizing = false;
  let renamed = -1;
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { type: string; text?: string; speaker?: string; ts?: string; message?: string; model?: string; diarize?: boolean; via?: string; diarizeMs?: number; lines?: number };
    if (m.type === "ready") {
      diarizing = !!m.diarize;
      console.log(`ready (${m.model}, diarize ${m.diarize ? "on" : "off"})`);
    }
    if (m.type === "final") {
      if (m.diarizeMs !== undefined) delays.push(m.diarizeMs);
      console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s  [${m.ts}] ${m.speaker}: ${m.text}   (${m.via}${m.diarizeMs !== undefined ? `, +${m.diarizeMs} ms` : ""})`);
    }
    if (m.type === "renamed") renamed = m.lines ?? 0;
    if (m.type === "error") console.error(`error: ${m.message}`);
  });
  await new Promise<void>((r, j) => {
    ws.once("open", () => r());
    ws.once("error", j);
    ws.once("unexpected-response", (_q, resp) => j(new Error(`HTTP ${resp.statusCode}`)));
  });

  const CHUNK = 4800; // 100 ms
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / SPEED));
  const silence = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      ws.send(Buffer.alloc(CHUNK));
      await sleep(100);
    }
  };
  await silence(800);
  for (const [i, clip] of clips.entries()) {
    if (CHIPS) ws.send(JSON.stringify({ type: "speaker", name: LINES[i]!.speaker })); // the user clicks a chip
    for (let o = 0; o < clip.length; o += CHUNK) {
      ws.send(clip.subarray(o, Math.min(clip.length, o + CHUNK)));
      await sleep(100);
    }
    await silence(1500);
  }
  // Let the last turns get their speakers, then rename the first detected speaker like the UI does.
  await silence(7000);
  const transcriptNow = async () =>
    local
      ? local.transcript
      : ((await (await fetch(`${SERVER}/api/session/${encodeURIComponent(id)}`)).json()) as { transcript: { ts: string; speaker: string; text: string }[] }).transcript;
  const before = (await transcriptNow()).map((u) => u.speaker);
  if (!CHIPS && before[0]) ws.send(JSON.stringify({ type: "rename", from: before[0], to: "Priya" }));
  ws.send(JSON.stringify({ type: "stop" }));
  await new Promise((r) => ws.once("close", r));

  const transcript = await transcriptNow();
  console.log("\nsession transcript:");
  for (const u of transcript) console.log(`  [${u.ts}] ${u.speaker}: ${u.text}`);
  let ok = transcript.length === LINES.length;
  if (CHIPS) {
    ok &&= transcript.every((u, i) => u.speaker === LINES[i]!.speaker);
  } else {
    // One label per voice (before the rename), and distinct voices -> distinct labels.
    const byVoice = new Map<string, Set<string>>();
    before.forEach((sp, i) => {
      const v = LINES[i]?.voice ?? "?";
      byVoice.set(v, (byVoice.get(v) ?? new Set()).add(sp));
    });
    const labels = [...byVoice.values()].map((s) => [...s]);
    console.log(`\nlabels per voice: ${[...byVoice.entries()].map(([v, s]) => `${v}=${[...s].join("|")}`).join(", ")}`);
    const consistent = labels.every((l) => l.length === 1);
    const distinct = new Set(labels.map((l) => l[0])).size === labels.length;
    const renameOk = transcript.filter((u) => u.speaker === "Priya").length === before.filter((s) => s === before[0]).length && renamed > 0;
    console.log(`diarize ${diarizing ? "on" : "OFF"}; consistent ${consistent}; distinct ${distinct}; rename rewrote ${renamed} lines (${renameOk ? "ok" : "MISMATCH"})`);
    if (delays.length) {
      const sorted = [...delays].sort((a, b) => a - b);
      console.log(`added latency per turn: median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`);
    }
    ok &&= diarizing && consistent && distinct && renameOk;
  }
  console.log(ok ? "\nOK" : "\nMISMATCH: see above");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
