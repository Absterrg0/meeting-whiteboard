/**
 * Headless replay: `pnpm replay transcripts/foo.jsonl [--model anthropic/claude-opus-5-5] [--effort low]
 *   [--editor-model openai/gpt-6-luna] [--editor-effort medium]`
 * Simulates the meeting in (meeting) real time, prints each change, and writes
 * out/<id>/design-doc.md, state.json, events.jsonl.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { configFromEnv, MeetingAgent } from "./agent/index.js";
import { parseTranscript } from "./ingest/transcript.js";
import { percentile, runHeadless } from "./session.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const effort = (v: string | undefined) => (v === "low" || v === "medium" || v === "high" ? v : undefined);

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: pnpm replay <transcript> [--model provider/id] [--effort low|medium|high] [--editor-model provider/id] [--editor-effort ...]");
  process.exit(1);
}
const utterances = parseTranscript(readFileSync(file, "utf8"));
const config = configFromEnv({
  ...(arg("model") ? { model: arg("model")! } : {}),
  ...(arg("editor-model") ? { editorModel: arg("editor-model")! } : {}),
  ...(effort(arg("effort")) ? { effort: effort(arg("effort"))! } : {}),
  ...(effort(arg("editor-effort")) ? { editorEffort: effort(arg("editor-effort"))! } : {}),
});
const id = `${basename(file).replace(/\.[^.]+$/, "")}-${Date.now()}`;
console.log(
  `Replaying ${utterances.length} utterances from ${file}: scribe ${config.model} (${config.effort}), editor ${config.editorModel} (${config.editorEffort})`,
);

let shownLog = 0;
let shownEvents = 0;
const print = (sess: { log: { kind: string; message: string }[]; events: { ts: string; source: string; op: string; summary: string }[] }) => {
  for (const l of sess.log.slice(shownLog)) console.log(`${l.kind === "error" ? "  ! " : l.kind === "editor" ? "  ~ " : ""}${l.message}`);
  for (const e of sess.events.slice(shownEvents)) console.log(`    [${e.ts}] ${e.source === "editor" ? "(editor) " : ""}${e.op}: ${e.summary}`);
  shownLog = sess.log.length;
  shownEvents = sess.events.length;
};
const s = await runHeadless(utterances, { id, agent: new MeetingAgent(config), outDir: "out", onBatch: print });
print(s);
const m = s.metrics;
console.log(
  `\nDone. ${s.events.length} changes, ${s.usage.calls} model calls, $${s.usage.costUsd.toFixed(3)}${s.usage.unpriced ? " (+ unpriced model)" : ""}`,
);
console.log(
  `Latency (said -> in doc): p50 ${percentile(m.lineLatency, 50)?.toFixed(1)}s, p90 ${percentile(m.lineLatency, 90)?.toFixed(1)}s; diagram lag p50 ${percentile(m.diagramLag, 50)?.toFixed(1)}s; ${m.turnLines.length} scribe turns, ${m.editorSeconds.length} editor runs`,
);
console.log(
  `Cost by role: ${Object.entries(s.usageByRole)
    .map(([r, u]) => `${r} $${u.costUsd.toFixed(3)} (${u.calls} calls)`)
    .join(", ")}`,
);
const tt = m.turnTiming.filter((t) => t.firstChangeMs !== null);
const p = (xs: number[], q: number) => (percentile(xs, q) ?? 0) / 1000;
console.log(
  `Turn timing (turns with changes, p50): first token ${p(tt.map((t) => t.firstTokenMs ?? 0), 50).toFixed(2)}s, first change applied ${p(tt.map((t) => t.firstChangeMs!), 50).toFixed(2)}s, turn done ${p(tt.map((t) => t.totalMs), 50).toFixed(2)}s; rounds p50 ${percentile(tt.map((t) => t.rounds), 50)}, >1 round in ${tt.filter((t) => t.rounds > 1).length}/${tt.length}; output tokens p50 ${percentile(tt.map((t) => t.outTokens), 50)}; input per turn p50 ${percentile(m.turnTiming.map((t) => t.inUncached), 50)} uncached / ${percentile(m.turnTiming.map((t) => t.inCached), 50)} cached; queue wait p50 ${percentile(m.queueWait, 50)?.toFixed(2)}s p90 ${percentile(m.queueWait, 90)?.toFixed(2)}s`,
);
console.log(`Output: out/${id}/design-doc.md`);
