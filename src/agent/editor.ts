/**
 * The editor: keeps the architecture diagram and the overview consistent with the items.
 *
 * Unlike the scribe, it is declarative: given all items and the current diagram, the
 * model returns the COMPLETE intended diagram and overview. Code diffs that against the
 * current diagram and applies only the difference (upserts and removals) through the
 * reducer. Same decisions in, same diagram out: this is what keeps the diagram stable
 * across updates and across runs, instead of accumulating incremental edits.
 *
 * It runs off the hot path (debounced, after item changes) and once at the end.
 */
import { generateText, Output } from "ai";
import { z } from "zod";
import type { Op } from "../core/ops.js";
import { COMPONENT_TYPES, type DocState, type Item } from "../core/types.js";
import { componentVisibility, edgeVisibility } from "../core/render.js";
import {
  CACHE_BREAKPOINT,
  addUsage,
  emptyUsage,
  languageModel,
  parseModel,
  providerOptions,
  type Effort,
  type ModelRef,
} from "./llm.js";
import { EDITOR_PROMPT } from "./prompt.js";
import type { ApplyFn, StepResult } from "./scribe.js";

export interface EditorConfig {
  model: string;
  effort: Effort;
}

const Plan = z.object({
  components: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(COMPONENT_TYPES),
      description: z.string(),
      basis: z.array(z.string()),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      basis: z.array(z.string()),
    }),
  ),
  overview: z.string(),
});
export type Plan = z.infer<typeof Plan>;

export interface EditInput {
  state: DocState;
  apply: ApplyFn;
  signal?: AbortSignal;
}

function describeForEditor(state: DocState): string {
  const out: string[] = [];
  out.push(`Title: ${state.meeting.title || "(not set)"}`);
  if (state.meeting.context) out.push(`Context: ${state.meeting.context}`);
  out.push("", "ITEMS (id | kind | status | title — detail):");
  for (const id of state.order.items) {
    const i = state.items[id]!;
    if (i.kind === "action_item") continue;
    const rationale = i.reason && ["accepted", "tentative"].includes(i.status) ? ` (why: ${i.reason})` : "";
    out.push(`- ${i.id} | ${i.kind} | ${i.status} | ${i.title} — ${i.detail}${rationale}`);
  }
  out.push("", "CURRENT DIAGRAM COMPONENTS (id | type | name | basis | shown as | description):");
  const comps = state.order.components.map((id) => state.components[id]!).filter((c) => !c.removed);
  if (comps.length === 0) out.push("(none yet)");
  for (const c of comps) {
    out.push(`- ${c.id} | ${c.type} | ${c.name} | [${c.basis.join(", ")}] | ${componentVisibility(state, c)} | ${c.description}`);
  }
  out.push("", "CURRENT DIAGRAM EDGES (from -> to | label | basis | shown as):");
  const edges = state.order.edges.map((id) => state.edges[id]!).filter((e) => !e.removed);
  if (edges.length === 0) out.push("(none yet)");
  for (const e of edges) out.push(`- ${e.from} -> ${e.to} | ${e.label} | [${e.basis.join(", ")}] | ${edgeVisibility(state, e)}`);
  out.push("", `CURRENT OVERVIEW: ${state.meeting.overview || "(none yet)"}`);
  return out.join("\n");
}

function slug(id: string): string {
  const s = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return s.startsWith("cmp-") ? s : `cmp-${s}`;
}

const STOP = new Set(
  "the and for with from into that this then than when what which while will would should could their there about after before over under using used only also each every more most less such same other between through without within design option options".split(
    " ",
  ),
);

/**
 * Terms that only belong to options the team turned down: words from the titles of
 * rejected/superseded/dropped items that appear in no live item's title. The overview
 * must not mention them, whatever the model wrote.
 */
export function staleTerms(state: DocState): string[] {
  const words = (s: string) => s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  const live = new Set<string>();
  for (const i of Object.values(state.items)) {
    if (["accepted", "tentative", "open", "proposed", "resolved", "done"].includes(i.status)) {
      for (const w of words(i.title)) live.add(w);
    }
  }
  const stale = new Set<string>();
  for (const i of Object.values(state.items)) {
    if (!["rejected", "superseded", "dropped"].includes(i.status)) continue;
    for (const w of words(i.title)) if (!live.has(w) && !STOP.has(w)) stale.add(w);
  }
  return [...stale];
}

/** Drops overview sentences that mention a stale term. */
export function screenOverview(overview: string, stale: string[]): string {
  if (!stale.length) return overview.trim();
  const re = new RegExp(`\\b(${stale.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  return (overview.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [overview])
    .map((s) => s.trim())
    .filter((s) => s && !re.test(s))
    .join(" ");
}

/** Keeps at most `n` sentences and `maxChars` characters, cutting at a sentence boundary. */
export function firstSentences(text: string, n: number, maxChars: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const p of parts.slice(0, n)) {
    if ((out + p).length > maxChars && out) break;
    out += p;
  }
  return out.trim();
}

/** Turns the editor's plan into reducer operations against the current state. */
export function reconcile(state: DocState, plan: Plan): Op[] {
  const ops: Op[] = [];
  const exists = (id: string) => !!state.items[id];
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  const wanted = new Map<string, Plan["components"][number]>();
  for (const c of plan.components) {
    const id = slug(c.id);
    const basis = [...new Set(c.basis.filter(exists))];
    if (!basis.length || !c.name.trim()) continue;
    wanted.set(id, { ...c, id, basis });
  }
  for (const c of wanted.values()) {
    const cur = state.components[c.id];
    if (
      !cur ||
      cur.removed ||
      cur.name !== c.name ||
      cur.type !== c.type ||
      cur.description !== c.description ||
      !sameSet(cur.basis, c.basis)
    ) {
      ops.push({ name: "upsert_component", input: { id: c.id, name: c.name.slice(0, 60), type: c.type, description: c.description, basis: c.basis } });
    }
  }
  for (const id of state.order.components) {
    const cur = state.components[id]!;
    if (!cur.removed && !wanted.has(id)) {
      ops.push({ name: "remove_component", input: { id, reason: "no longer part of the agreed design" } });
    }
  }

  const wantedEdges = new Map<string, Plan["edges"][number]>();
  for (const e of plan.edges) {
    const from = slug(e.from);
    const to = slug(e.to);
    const basis = [...new Set(e.basis.filter(exists))];
    if (from === to || !wanted.has(from) || !wanted.has(to) || !basis.length) continue;
    wantedEdges.set(`${from}->${to}`, { ...e, from, to, basis });
  }
  for (const [key, e] of wantedEdges) {
    const cur = state.edges[key];
    if (!cur || cur.removed || cur.label !== e.label || !sameSet(cur.basis, e.basis)) {
      ops.push({ name: "upsert_edge", input: { from: e.from, to: e.to, label: e.label.slice(0, 40), basis: e.basis } });
    }
  }
  for (const id of state.order.edges) {
    const cur = state.edges[id]!;
    // Edges of removed components are removed with them by the reducer.
    if (!cur.removed && !wantedEdges.has(id) && wanted.has(cur.from) && wanted.has(cur.to)) {
      ops.push({ name: "remove_edge", input: { from: cur.from, to: cur.to, reason: "no longer part of the agreed design" } });
    }
  }

  const overview = firstSentences(screenOverview(plan.overview, staleTerms(state)), 3, 700);
  if (overview !== state.meeting.overview) ops.push({ name: "set_overview", input: { overview } });
  return ops;
}

export class Editor {
  readonly ref: ModelRef;
  constructor(public config: EditorConfig) {
    this.ref = parseModel(config.model);
  }

  async run(input: EditInput): Promise<StepResult> {
    const usage = emptyUsage();
    const meaningful = Object.values(input.state.items).some((i: Item) => i.kind !== "action_item");
    if (!meaningful) return { applied: 0, errors: [], note: "nothing to draw yet", usage };

    const res = await generateText({
      model: languageModel(this.ref),
      instructions: { role: "system", content: EDITOR_PROMPT, providerOptions: CACHE_BREAKPOINT },
      prompt: describeForEditor(input.state),
      output: Output.object({ schema: Plan }),
      providerOptions: providerOptions(this.ref, this.config.effort),
      maxOutputTokens: 16000,
      abortSignal: input.signal,
    });
    addUsage(usage, res.usage, this.ref);
    const plan = res.output;

    let applied = 0;
    const errors: string[] = [];
    // Apply against the state as it is now (the scribe may have moved on meanwhile).
    for (const op of reconcile(input.state, plan)) {
      const r = input.apply(op);
      if (r.ok) applied++;
      else errors.push(`${op.name}: ${r.error}`);
    }
    return { applied, errors, note: `diagram: ${plan.components.length} components, ${plan.edges.length} edges`, usage };
  }
}
