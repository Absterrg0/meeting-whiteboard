/**
 * Evaluation: `pnpm eval [transcript names...] [--model id] [--effort low|medium|high]`
 *
 * For each transcript that has an expected/<name>.json, replay it headlessly through
 * the real agent, then grade the final state:
 *  - deterministic regex checks against the rendered design doc and the accepted-only diagram;
 *  - all "llm" checks for a transcript in one structured-output judge call.
 * Prints a table per transcript and writes out/eval-<timestamp>.json. Exit code 1 if any check fails.
 */
import "dotenv/config";
import { generateText, Output } from "ai";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { configFromEnv, MeetingAgent, type AgentConfig } from "./agent/index.js";
import { addUsage, emptyUsage, languageModel, parseModel, providerOptions } from "./agent/llm.js";
import { componentVisibility, edgeVisibility, HISTORY_LINE, toMarkdown, toMermaid } from "./core/render.js";
import type { DocState, Utterance } from "./core/types.js";
import { parseTranscript } from "./ingest/transcript.js";
import { percentile, runHeadless } from "./session.js";

/** The judge grades "llm" checks. Any provider works; default Sonnet 5.5. */
const JUDGE_MODEL = parseModel(process.env.JUDGE_MODEL ?? "anthropic/claude-sonnet-5-5");

const Check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("llm"), id: z.string(), desc: z.string(), expect: z.string() }),
  z.object({
    type: z.enum(["doc_includes", "doc_excludes"]),
    id: z.string(),
    desc: z.string(),
    pattern: z.string(),
    sections: z.enum(["current", "all"]).default("current"),
  }),
  z.object({
    type: z.enum(["diagram_includes", "diagram_excludes"]),
    id: z.string(),
    desc: z.string(),
    pattern: z.string(),
  }),
]);
type Check = z.infer<typeof Check>;
const ExpectedFile = z.object({ checks: z.array(Check) });

export interface CheckResult {
  id: string;
  type: Check["type"];
  desc: string;
  pass: boolean;
  reason: string;
}

// ---------- deterministic grading ----------

/**
 * The "current" part of the doc: everything before the decision log / changelog.
 * "- Replaces: <old title>" back-references under a decision are provenance, not
 * current content, so they are dropped too.
 */
export function currentSections(markdown: string): string {
  const cut = ["\n## Decision log", "\n## Changelog"]
    .map((h) => markdown.indexOf(h))
    .filter((i) => i >= 0);
  const head = cut.length ? markdown.slice(0, Math.min(...cut)) : markdown;
  // Labelled history lines inside a topic ("- Considered: ~~Kafka~~...", "- Replaced: ...")
  // record what was turned down; they are not part of the current design.
  return head
    .split("\n")
    .filter((l) => !/^\s*- Replaces:/.test(l) && !HISTORY_LINE.test(l.trim()))
    .join("\n");
}

function firstMatchLine(text: string, re: RegExp): string {
  const line = text.split("\n").find((l) => re.test(l)) ?? "";
  return line.trim().slice(0, 140);
}

export function gradeDeterministic(check: Exclude<Check, { type: "llm" }>, markdown: string, mermaid: string): CheckResult {
  const re = new RegExp(check.pattern, "i");
  let target: string;
  let where: string;
  if (check.type === "doc_includes" || check.type === "doc_excludes") {
    target = check.sections === "all" ? markdown : currentSections(markdown);
    where = check.sections === "all" ? "doc" : "current doc";
  } else {
    target = mermaid;
    where = "diagram";
  }
  const found = re.test(target);
  const wantFound = check.type.endsWith("_includes");
  const pass = found === wantFound;
  const reason = found
    ? `/${check.pattern}/ found in ${where}: "${firstMatchLine(target, re)}"`
    : `/${check.pattern}/ not found in ${where}`;
  return { id: check.id, type: check.type, desc: check.desc, pass, reason };
}

// ---------- LLM judge ----------

const JudgeOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      // Reason before verdict, so the verdict follows from the stated evidence.
      reason: z.string().describe("One line: the evidence, citing item ids or doc text."),
      pass: z.boolean().describe("Whether the check's expectation is met, consistent with the reason."),
    }),
  ),
});

function stateForJudge(state: DocState) {
  return {
    meeting: state.meeting,
    items: state.order.items.map((id) => {
      const i = state.items[id]!;
      return {
        id: i.id,
        kind: i.kind,
        status: i.status,
        title: i.title,
        detail: i.detail,
        reason: i.reason,
        owner: i.owner,
        due: i.due,
        supersedes: i.supersedes,
        supersededBy: i.supersededBy,
        related: i.related,
        firstSaid: i.evidence[0]?.ts,
        history: i.history.map((h) => ({ ts: h.ts, field: h.field, from: h.from, to: h.to, reason: h.reason })),
      };
    }),
    components: state.order.components.map((id) => {
      const c = state.components[id]!;
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        description: c.description,
        basis: c.basis,
        removed: c.removed,
        removedReason: c.removedReason,
        shownAs: componentVisibility(state, c),
      };
    }),
    edges: state.order.edges.map((id) => {
      const e = state.edges[id]!;
      return { from: e.from, to: e.to, label: e.label, basis: e.basis, shownAs: edgeVisibility(state, e) };
    }),
  };
}

const JUDGE_SYSTEM = `You grade the output of an AI scribe that listened to a technical design meeting and maintained a design doc.
You get the meeting transcript, the scribe's final structured state (items with status and change history, diagram components and edges with how they are shown), the rendered markdown doc, and a list of checks.
For each check decide pass or fail strictly according to its "expect" text, judging the final state and doc (not the transcript) and using the transcript only to understand what was said.
Status meanings: proposed = floated, not agreed; accepted = agreed; tentative = agreed for now, to revisit; rejected = turned down; superseded = replaced by another item; open = unresolved question / pending action; resolved/done/dropped = closed.
A component "shownAs" active/tbd is in the current architecture; proposed/retired is not.
Equivalent wording, merged items or different ids are fine as long as the substance matches. Return exactly one result per check id: first a one-line reason citing item ids or doc text, then the verdict that follows from it. Minor wording or extra detail is not a failure; fail only when the expectation's substance is not met.`;

async function judge(
  checks: Extract<Check, { type: "llm" }>[],
  transcript: Utterance[],
  state: DocState,
  markdown: string,
): Promise<{ results: CheckResult[]; costUsd: number }> {
  if (checks.length === 0) return { results: [], costUsd: 0 };
  const user = [
    "<transcript>",
    transcript.map((u) => `[${u.ts}] ${u.speaker}: ${u.text}`).join("\n"),
    "</transcript>",
    "",
    "<final_state>",
    JSON.stringify(stateForJudge(state), null, 1),
    "</final_state>",
    "",
    "<rendered_doc>",
    markdown,
    "</rendered_doc>",
    "",
    "<checks>",
    JSON.stringify(checks.map((c) => ({ id: c.id, desc: c.desc, expect: c.expect })), null, 1),
    "</checks>",
  ].join("\n");

  const res = await generateText({
    model: languageModel(JUDGE_MODEL),
    instructions: JUDGE_SYSTEM,
    prompt: user,
    output: Output.object({ schema: JudgeOutput }),
    providerOptions: providerOptions(JUDGE_MODEL, "low"),
    maxOutputTokens: 16000,
  });
  const usage = emptyUsage();
  addUsage(usage, res.usage, JUDGE_MODEL);
  const byId = new Map(res.output.results.map((r) => [r.id, r]));
  const results = checks.map((c): CheckResult => {
    const r = byId.get(c.id);
    if (!r) return { id: c.id, type: "llm", desc: c.desc, pass: false, reason: "judge returned no verdict" };
    return { id: c.id, type: "llm", desc: c.desc, pass: r.pass, reason: r.reason };
  });
  return { results, costUsd: usage.costUsd };
}

// ---------- runner ----------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positionalArgs(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith("--")) {
      i++;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

function findTranscript(name: string): string | null {
  for (const ext of [".jsonl", ".json", ".txt", ".md"]) {
    const p = join("transcripts", name + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

interface TranscriptReport {
  name: string;
  run: number;
  transcript: string;
  sessionId: string;
  results: CheckResult[];
  passed: number;
  total: number;
  agentCostUsd: number;
  agentCalls: number;
  judgeCostUsd: number;
  agentErrors: string[];
  durationSec: number;
  /** Seconds of meeting time from a line being said to the doc reflecting it. */
  latencyP50: number | null;
  latencyP90: number | null;
  diagramLagP50: number | null;
  /** Visible diagram components (by name) and edges, for cross-run stability. */
  diagramNodes: string[];
  diagramEdges: string[];
  error?: string;
}

async function evalOne(name: string, config: AgentConfig, stamp: string, run: number): Promise<TranscriptReport> {
  const started = Date.now();
  const expected = ExpectedFile.parse(JSON.parse(readFileSync(join("expected", `${name}.json`), "utf8")));
  const file = findTranscript(name);
  if (!file) throw new Error(`no transcript for '${name}' in transcripts/`);
  const utterances = parseTranscript(readFileSync(file, "utf8"));
  const sessionId = `eval-${name}-${stamp}-r${run}`;
  const s = await runHeadless(utterances, { id: sessionId, agent: new MeetingAgent(config), outDir: "out" });

  const markdown = toMarkdown(s.state, { events: s.events });
  const mermaid = toMermaid(s.state);
  const results: CheckResult[] = [];
  const llmChecks: Extract<Check, { type: "llm" }>[] = [];
  for (const c of expected.checks) {
    if (c.type === "llm") llmChecks.push(c);
    else results.push(gradeDeterministic(c, markdown, mermaid));
  }
  let judgeCostUsd = 0;
  try {
    const j = await judge(llmChecks, utterances, s.state, markdown);
    results.unshift(...j.results);
    judgeCostUsd = j.costUsd;
  } catch (e) {
    const msg = `judge call failed: ${(e as Error).message}`;
    results.unshift(...llmChecks.map((c) => ({ id: c.id, type: c.type, desc: c.desc, pass: false, reason: msg })));
  }
  const agentErrors = s.log.filter((l) => l.kind === "error").map((l) => `${l.ts} ${l.message}`);
  const visible = s.state.order.components
    .map((id) => s.state.components[id]!)
    .filter((c) => ["active", "tbd"].includes(componentVisibility(s.state, c)));
  const nameOf = (id: string) => normName(s.state.components[id]?.name ?? id);
  const diagramEdges = s.state.order.edges
    .map((id) => s.state.edges[id]!)
    .filter((e) => ["active", "tbd"].includes(edgeVisibility(s.state, e)))
    .map((e) => `${nameOf(e.from)}->${nameOf(e.to)}`);
  s.dispose();
  return {
    name,
    run,
    transcript: file,
    sessionId,
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    agentCostUsd: s.usage.costUsd,
    agentCalls: s.usage.calls,
    judgeCostUsd,
    agentErrors,
    durationSec: (Date.now() - started) / 1000,
    latencyP50: percentile(s.metrics.lineLatency, 50),
    latencyP90: percentile(s.metrics.lineLatency, 90),
    diagramLagP50: percentile(s.metrics.diagramLag, 50),
    diagramNodes: visible.map((c) => normName(c.name)),
    diagramEdges,
  };
}

/** Component names normalised for cross-run comparison ("Event queue (SQS)" ~ "event queue sqs"). */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter((t) => t.length > 1 && !["the", "and", "of", "for", "service", "store"].includes(t)));
}

function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const A = tokens(a);
  const B = tokens(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter > 0 && inter / Math.min(A.size, B.size) >= 0.5;
}

/**
 * Structural overlap of two diagrams: components are matched by name similarity
 * ("Event queue (SQS)" ~ "SQS queue"), then edges are compared through that matching.
 * Returns Jaccard-style overlaps for nodes and edges.
 */
function diagramOverlap(a: { nodes: string[]; edges: string[] }, b: { nodes: string[]; edges: string[] }) {
  const match = new Map<string, string>();
  const usedB = new Set<string>();
  for (const x of a.nodes) {
    const y = b.nodes.find((n) => !usedB.has(n) && similar(x, n));
    if (y) {
      match.set(x, y);
      usedB.add(y);
    }
  }
  const nodeUnion = a.nodes.length + b.nodes.length - match.size;
  const mappedA = a.edges.map((e) => {
    const [f, t] = e.split("->");
    return `${match.get(f!) ?? `a:${f}`}->${match.get(t!) ?? `a:${t}`}`;
  });
  const B = new Set(b.edges);
  const edgeInter = new Set(mappedA.filter((e) => B.has(e))).size;
  const edgeUnion = new Set([...mappedA, ...b.edges]).size;
  return { nodes: nodeUnion ? match.size / nodeUnion : 1, edges: edgeUnion ? edgeInter / edgeUnion : 1 };
}

function meanPairwise(runs: { nodes: string[]; edges: string[] }[]): { nodes: number; edges: number } | null {
  if (runs.length < 2) return null;
  let n = 0;
  let e = 0;
  let k = 0;
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const o = diagramOverlap(runs[i]!, runs[j]!);
    n += o.nodes;
    e += o.edges;
    k++;
  }
  return { nodes: n / k, edges: e / k };
}

/** Runs tasks with bounded concurrency (API rate limits; long meetings). */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

const fmt = (x: number | null, d = 1) => (x === null ? "n/a" : x.toFixed(d));

async function main() {
  const names = positionalArgs().map((n) => basename(n).replace(/\.[^.]+$/, ""));
  const all = readdirSync("expected")
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  const selected = names.length ? names : all;
  for (const n of selected) {
    if (!all.includes(n)) {
      console.error(`no expected/${n}.json (available: ${all.join(", ")})`);
      process.exit(2);
    }
  }
  const effortArg = (v: string | undefined) => (v === "low" || v === "medium" || v === "high" ? v : undefined);
  const config = configFromEnv({
    ...(arg("model") ? { model: arg("model")! } : {}),
    ...(arg("editor-model") ? { editorModel: arg("editor-model")! } : {}),
    ...(effortArg(arg("effort")) ? { effort: effortArg(arg("effort"))! } : {}),
    ...(effortArg(arg("editor-effort")) ? { editorEffort: effortArg(arg("editor-effort"))! } : {}),
  });
  const runs = Math.max(1, Number(arg("runs") ?? 1));
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 4));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(
    `Evaluating ${selected.join(", ")} x${runs} with scribe ${config.model} (${config.effort}), editor ${config.editorModel} (${config.editorEffort}); judge ${JUDGE_MODEL.spec}\n`,
  );

  const tasks = selected.flatMap((n) =>
    Array.from({ length: runs }, (_, r) => () =>
      evalOne(n, config, stamp, r + 1).catch(
        (e): TranscriptReport => ({
          name: n,
          run: r + 1,
          transcript: "",
          sessionId: "",
          results: [],
          passed: 0,
          total: 1,
          agentCostUsd: 0,
          agentCalls: 0,
          judgeCostUsd: 0,
          agentErrors: [],
          durationSec: 0,
          latencyP50: null,
          latencyP90: null,
          diagramLagP50: null,
          diagramNodes: [],
          diagramEdges: [],
          error: (e as Error).stack ?? String(e),
        }),
      ),
    ),
  );
  // Each finished run is printed and saved straight away, so a long benchmark that is
  // interrupted still leaves its completed results behind.
  mkdirSync("out", { recursive: true });
  const partialFile = join("out", `eval-${stamp}.partial.jsonl`);
  const reports = await pool(
    tasks.map((t) => async () => {
      const r = await t();
      const failed = r.results.filter((c) => !c.pass).map((c) => c.id);
      console.log(
        `[done] ${r.name} run ${r.run}: ${r.passed}/${r.total}, $${r.agentCostUsd.toFixed(3)}, p50 ${fmt(r.latencyP50)}s${failed.length ? `, failed: ${failed.join(", ")}` : ""}${r.error ? `, ERROR ${r.error.split("\n")[0]}` : ""}`,
      );
      appendFileSync(partialFile, JSON.stringify(r) + "\n");
      return r;
    }),
    concurrency,
  );

  let passed = 0;
  let total = 0;
  let agentCost = 0;
  let judgeCost = 0;
  const summary: Record<string, unknown>[] = [];
  for (const name of selected) {
    const rs = reports.filter((r) => r.name === name);
    for (const r of rs) {
      console.log(
        `=== ${r.name} run ${r.run} — ${r.passed}/${r.total} passed (agent $${r.agentCostUsd.toFixed(3)} over ${r.agentCalls} calls, judge $${r.judgeCostUsd.toFixed(3)}, ${r.durationSec.toFixed(0)}s; latency p50 ${fmt(r.latencyP50)}s p90 ${fmt(r.latencyP90)}s, diagram lag p50 ${fmt(r.diagramLagP50)}s)`,
      );
      if (r.error) console.log(`  ERROR: ${r.error}`);
      if (r.sessionId) console.log(`  output: out/${r.sessionId}/design-doc.md`);
      for (const c of r.results) if (!c.pass || runs === 1) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${pad(c.id, 28)} ${pad(c.desc, 50)} ${c.reason}`);
      if (r.agentErrors.length) {
        console.log(`  agent tool errors (${r.agentErrors.length}, self-corrected or dropped):`);
        for (const e of r.agentErrors.slice(0, 10)) console.log(`    ${e}`);
      }
      passed += r.passed;
      total += r.total;
      agentCost += r.agentCostUsd;
      judgeCost += r.judgeCostUsd;
    }
    if (runs > 1) {
      // Stability: does each check get the same verdict in every run?
      const ids = [...new Set(rs.flatMap((r) => r.results.map((c) => c.id)))];
      const stable = ids.filter((id) => new Set(rs.map((r) => r.results.find((c) => c.id === id)?.pass)).size === 1).length;
      const flaky = ids.filter((id) => new Set(rs.map((r) => r.results.find((c) => c.id === id)?.pass)).size > 1);
      const overlap = meanPairwise(rs.map((r) => ({ nodes: r.diagramNodes, edges: r.diagramEdges })));
      const nodeJ = overlap?.nodes ?? null;
      const edgeJ = overlap?.edges ?? null;
      const line = {
        name,
        runs: rs.length,
        passRate: rs.reduce((a, r) => a + r.passed, 0) / Math.max(1, rs.reduce((a, r) => a + r.total, 0)),
        checkStability: ids.length ? stable / ids.length : null,
        flakyChecks: flaky,
        diagramNodeJaccard: nodeJ,
        diagramEdgeJaccard: edgeJ,
        latencyP50: percentile(rs.map((r) => r.latencyP50 ?? 0), 50),
        latencyP90: percentile(rs.map((r) => r.latencyP90 ?? 0), 50),
        costPerRun: rs.reduce((a, r) => a + r.agentCostUsd, 0) / rs.length,
      };
      summary.push(line);
      console.log(
        `--- ${name}: pass ${(line.passRate * 100).toFixed(0)}%, check stability ${fmt(line.checkStability === null ? null : line.checkStability * 100, 0)}%, diagram overlap nodes ${fmt(nodeJ, 2)} edges ${fmt(edgeJ, 2)}, latency p50 ${fmt(line.latencyP50)}s, $${line.costPerRun.toFixed(3)}/run`,
      );
      if (flaky.length) console.log(`    flaky: ${flaky.join(", ")}`);
    }
    console.log("");
  }
  console.log(`TOTAL ${passed}/${total} passed. Agent $${agentCost.toFixed(3)}, judge $${judgeCost.toFixed(3)}, total $${(agentCost + judgeCost).toFixed(3)}`);

  mkdirSync("out", { recursive: true });
  const outFile = join("out", `eval-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify({ config, judge: JUDGE_MODEL.spec, runs, passed, total, agentCost, judgeCost, summary, reports }, null, 2),
  );
  console.log(`Wrote ${outFile}`);
  process.exit(passed === total ? 0 : 1);
}

// Only run when executed directly (tests import the grading helpers).
if (process.argv[1] && /eval\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
