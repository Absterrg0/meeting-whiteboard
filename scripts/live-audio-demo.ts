/**
 * End-to-end check of the live audio path without a human or a microphone:
 *
 *   synthesized speech (OpenAI TTS, or espeak-ng) -> PCM16 24 kHz
 *   -> ws://server/api/live/audio (exactly what the browser sends)
 *   -> OpenAI realtime transcription -> session.addUtterance -> session snapshot
 *
 * Usage: start the server (pnpm start), then
 *   pnpm live:demo [--server http://localhost:8787] [--speed 1]
 *
 * It switches the "speaking now" label between lines, like a user clicking the chips.
 * Cost: ~30 s of TTS + ~30 s of transcription, well under $0.01.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const SERVER = arg("server", `http://localhost:${process.env.PORT ?? 8787}`);
const SPEED = Number(arg("speed", "1")); // >1 streams faster than real time
const CACHE = join("out", "live-demo-audio");

const LINES: { speaker: string; voice: string; text: string }[] = [
  { speaker: "Priya", voice: "alloy", text: "Okay, let's get going. Today we need to agree on the queue for the webhook delivery workers." },
  { speaker: "Marcus", voice: "onyx", text: "I'd go with SQS. We already run it for billing, and the dead letter queue comes for free." },
  { speaker: "Priya", voice: "alloy", text: "What about retries? Earlier we said three attempts." },
  { speaker: "Marcus", voice: "onyx", text: "Let's change that to five retries with exponential backoff, capped at one hour." },
];

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
  const wav = execFileSync("espeak-ng", ["-v", voice === "onyx" ? "en-us+m3" : "en-us+f3", "--stdout", text]);
  const pcm = execFileSync("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"], { input: wav });
  writeFileSync(file, pcm);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const clips: Buffer[] = [];
  for (const [i, l] of LINES.entries()) {
    const f = join(CACHE, `line${i}.pcm`);
    await tts(l.text, l.voice, f);
    clips.push(readFileSync(f));
  }

  const res = await fetch(`${SERVER}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ live: true, title: "Live audio demo" }),
  });
  const { id } = (await res.json()) as { id: string };
  console.log(`session ${id}`);

  const url = new URL(`/api/live/audio?session=${encodeURIComponent(id)}&source=meeting`, SERVER);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, { headers: { origin: SERVER } });
  const t0 = Date.now();
  const finals: string[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d)) as { type: string; text?: string; speaker?: string; ts?: string; message?: string; model?: string };
    if (m.type === "ready") console.log(`ready (${m.model})`);
    if (m.type === "final") {
      finals.push(`${m.speaker}: ${m.text}`);
      console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s  [${m.ts}] ${m.speaker}: ${m.text}`);
    }
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
    ws.send(JSON.stringify({ type: "speaker", name: LINES[i]!.speaker })); // the user clicks a chip
    for (let o = 0; o < clip.length; o += CHUNK) {
      ws.send(clip.subarray(o, Math.min(clip.length, o + CHUNK)));
      await sleep(100);
    }
    await silence(1500);
  }
  ws.send(JSON.stringify({ type: "stop" }));
  await new Promise((r) => ws.once("close", r));

  const snap = (await (await fetch(`${SERVER}/api/session/${encodeURIComponent(id)}`)).json()) as {
    transcript: { ts: string; speaker: string; text: string }[];
  };
  console.log("\nsession transcript:");
  for (const u of snap.transcript) console.log(`  [${u.ts}] ${u.speaker}: ${u.text}`);
  const ok = snap.transcript.length === LINES.length && snap.transcript.every((u, i) => u.speaker === LINES[i]!.speaker);
  console.log(ok ? "\nOK: every line transcribed and attributed" : "\nMISMATCH: see above");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
