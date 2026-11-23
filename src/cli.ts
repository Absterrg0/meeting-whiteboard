/**
 * Headless replay: `pnpm replay transcripts/foo.jsonl [--model claude-opus-5-5] [--effort low]`
 * Prints each batch's changes and writes out/<id>/design-doc.md, state.json, events.jsonl.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULT_CONFIG, ScribeAgent } from "./agent/agent.js";
import { parseTranscript } from "./ingest/transcript.js";
import { runHeadless } from "./session.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: pnpm replay <transcript.jsonl|.txt|.md> [--model id] [--effort low|medium|high]");
  process.exit(1);
}
const utterances = parseTranscript(readFileSync(file, "utf8"));
const agent = new ScribeAgent({
  ...DEFAULT_CONFIG,
  model: arg("model") ?? DEFAULT_CONFIG.model,
  effort: (arg("effort") as typeof DEFAULT_CONFIG.effort) ?? DEFAULT_CONFIG.effort,
});
const id = `${basename(file).replace(/\.[^.]+$/, "")}-${Date.now()}`;
console.log(`Replaying ${utterances.length} utterances from ${file} with ${agent.config.model} (${agent.config.effort})`);

let shown = 0;
let shownEvents = 0;
const s = await runHeadless(utterances, {
  id,
  agent,
  outDir: "out",
  onBatch: (sess) => {
    for (const l of sess.log.slice(shown)) console.log(`${l.kind === "error" ? "  ! " : ""}${l.message}`);
    for (const e of sess.events.slice(shownEvents)) console.log(`    [${e.ts}] ${e.op}: ${e.summary}`);
    shown = sess.log.length;
    shownEvents = sess.events.length;
  },
});

for (const l of s.log.slice(shown)) console.log(`${l.kind === "error" ? "  ! " : ""}${l.message}`);
for (const e of s.events.slice(shownEvents)) console.log(`    [${e.ts}] ${e.op}: ${e.summary}`);
console.log(`\nDone. ${s.events.length} changes, ${s.usage.calls} model calls, $${s.usage.costUsd.toFixed(3)}`);
console.log(`Output: out/${id}/design-doc.md`);
