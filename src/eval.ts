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
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, ScribeAgent } from "./agent/agent.js";
import { componentVisibility, edgeVisibility, toMarkdown, toMermaid } from "./core/render.js";
import type { DocState, Utterance } from "./core/types.js";
import { parseTranscript } from "./ingest/transcript.js";
import { runHeadless } from "./session.js";

const JUDGE_MODEL = "claude-sonnet-5-5";
/** $ per million tokens: input, output, cache read, cache write. */
const JUDGE_PRICE = [2, 10, 0.1, 2.5] as const;

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
  return head
    .split("\n")
    .filter((l) => !/^\s*- Replaces:/.test(l))
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
  client: Anthropic,
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

  const res = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 8000,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: zodOutputFormat(JudgeOutput) },
  });
  const u = res.usage;
  const costUsd =
    ((u.input_tokens ?? 0) * JUDGE_PRICE[0] +
      (u.output_tokens ?? 0) * JUDGE_PRICE[1] +
      (u.cache_read_input_tokens ?? 0) * JUDGE_PRICE[2] +
      (u.cache_creation_input_tokens ?? 0) * JUDGE_PRICE[3]) /
    1e6;
  const parsed = res.parsed_output;
  const byId = new Map((parsed?.results ?? []).map((r) => [r.id, r]));
  const results = checks.map((c): CheckResult => {
    const r = byId.get(c.id);
    if (!r) return { id: c.id, type: "llm", desc: c.desc, pass: false, reason: "judge returned no verdict" };
    return { id: c.id, type: "llm", desc: c.desc, pass: r.pass, reason: r.reason };
  });
  return { results, costUsd };
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
  error?: string;
}

async function evalOne(name: string, agent: ScribeAgent, client: Anthropic, stamp: string): Promise<TranscriptReport> {
  const started = Date.now();
  const expected = ExpectedFile.parse(JSON.parse(readFileSync(join("expected", `${name}.json`), "utf8")));
  const file = findTranscript(name);
  if (!file) throw new Error(`no transcript for '${name}' in transcripts/`);
  const utterances = parseTranscript(readFileSync(file, "utf8"));
  const sessionId = `eval-${name}-${stamp}`;
  const s = await runHeadless(utterances, { id: sessionId, agent, outDir: "out" });

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
    const j = await judge(client, llmChecks, utterances, s.state, markdown);
    results.unshift(...j.results);
    judgeCostUsd = j.costUsd;
  } catch (e) {
    const msg = `judge call failed: ${(e as Error).message}`;
    results.unshift(...llmChecks.map((c) => ({ id: c.id, type: c.type, desc: c.desc, pass: false, reason: msg })));
  }
  const agentErrors = s.log.filter((l) => l.kind === "error").map((l) => `${l.ts} ${l.message}`);
  s.dispose();
  return {
    name,
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
  };
}

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

  const config = {
    ...DEFAULT_CONFIG,
    model: arg("model") ?? DEFAULT_CONFIG.model,
    effort: (arg("effort") as typeof DEFAULT_CONFIG.effort) ?? DEFAULT_CONFIG.effort,
  };
  const client = new Anthropic();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`Evaluating ${selected.join(", ")} with ${config.model} (${config.effort}); judge ${JUDGE_MODEL}\n`);

  // Transcripts are independent; run them concurrently, each with its own agent instance.
  const reports = await Promise.all(
    selected.map((n) =>
      evalOne(n, new ScribeAgent(config, client), client, stamp).catch(
        (e): TranscriptReport => ({
          name: n,
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
          error: (e as Error).stack ?? String(e),
        }),
      ),
    ),
  );

  let passed = 0;
  let total = 0;
  let agentCost = 0;
  let judgeCost = 0;
  for (const r of reports) {
    console.log(`=== ${r.name} — ${r.passed}/${r.total} passed (agent $${r.agentCostUsd.toFixed(3)} over ${r.agentCalls} calls, judge $${r.judgeCostUsd.toFixed(3)}, ${r.durationSec.toFixed(0)}s)`);
    if (r.error) console.log(`  ERROR: ${r.error}`);
    if (r.sessionId) console.log(`  output: out/${r.sessionId}/design-doc.md`);
    for (const c of r.results) {
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${pad(c.id, 28)} ${pad(c.desc, 50)} ${c.reason}`);
    }
    if (r.agentErrors.length) {
      console.log(`  agent tool errors (${r.agentErrors.length}, self-corrected or dropped):`);
      for (const e of r.agentErrors.slice(0, 20)) console.log(`    ${e}`);
    }
    console.log("");
    passed += r.passed;
    total += r.total;
    agentCost += r.agentCostUsd;
    judgeCost += r.judgeCostUsd;
  }
  console.log(`TOTAL ${passed}/${total} passed. Agent $${agentCost.toFixed(3)}, judge $${judgeCost.toFixed(3)}, total $${(agentCost + judgeCost).toFixed(3)}`);

  mkdirSync("out", { recursive: true });
  const outFile = join("out", `eval-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      { model: config.model, effort: config.effort, judge: JUDGE_MODEL, passed, total, agentCost, judgeCost, reports },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outFile}`);
  process.exit(passed === total ? 0 : 1);
}

// Only run when executed directly (tests import the grading helpers).
if (process.argv[1] && /eval\.[cm]?[jt]s$/.test(process.argv[1])) {
  await main();
}
