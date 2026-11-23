/**
 * Projections of the doc state. No model calls here: the document and the
 * diagram are deterministic functions of the state and the event log, so a
 * value that was replaced can never linger in the doc.
 */
import type { ChangeEvent, Component, DocState, Edge, Item } from "./types.js";

export type ComponentVisibility = "active" | "tbd" | "proposed" | "retired";

const LIVE = new Set(["accepted", "tentative"]);

/**
 * Which items can put something on the diagram. A fact ("today a nightly job rebuilds
 * the index") describes the current world, not the design, so it never does on its own.
 */
function isLiveBasis(i: Item): boolean {
  return i.kind !== "fact" && LIVE.has(i.status);
}

/**
 * Visibility from a basis. If the basis contains decisions, only the decisions count:
 * a component that exists because of a decision goes away when that decision is
 * rejected or superseded, even if a requirement it also served is still live.
 */
export function basisVisibility(state: DocState, ids: string[]): ComponentVisibility {
  const all = ids.map((b) => state.items[b]).filter((x): x is Item => !!x);
  const decisions = all.filter((i) => i.kind === "decision");
  const basis = decisions.length ? decisions : all;
  // An open question in the basis means "agreed that it exists, not yet what it is".
  const openQuestion = all.some((b) => b.kind === "open_question" && b.status === "open");
  if (basis.some(isLiveBasis)) return openQuestion ? "tbd" : "active";
  if (openQuestion) return "tbd";
  if (basis.some((b) => b.status === "proposed")) return "proposed";
  return "retired";
}

export function componentVisibility(state: DocState, c: Component): ComponentVisibility {
  if (c.removed) return "retired";
  return basisVisibility(state, c.basis);
}

export function edgeVisibility(state: DocState, e: Edge): ComponentVisibility {
  if (e.removed) return "retired";
  const a = state.components[e.from];
  const b = state.components[e.to];
  if (!a || !b) return "retired";
  const va = componentVisibility(state, a);
  const vb = componentVisibility(state, b);
  if (va === "retired" || vb === "retired") return "retired";
  const own = basisVisibility(state, e.basis);
  if (own === "retired") return "retired";
  if (va === "proposed" || vb === "proposed" || own === "proposed") return "proposed";
  if (va === "tbd" || vb === "tbd" || own === "tbd") return "tbd";
  return "active";
}

function mermaidId(id: string): string {
  // Prefix so an id can never be a Mermaid keyword such as "end".
  return "n_" + id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidText(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "").replace(/[\r\n]+/g, " ");
}

const SHAPES: Record<Component["type"], [string, string]> = {
  service: ["[", "]"],
  worker: ["[[", "]]"],
  queue: ["[/", "/]"],
  datastore: ["[(", ")]"],
  external: ["([", "])"],
  client: ["([", "])"],
  infra: ["{{", "}}"],
  other: ["[", "]"],
};

/**
 * Mermaid flowchart of the current architecture.
 * `includeProposed` also draws things under discussion (dashed, greyed) for the live view;
 * the design doc itself only ever shows what was agreed, plus TBD placeholders.
 */
export function toMermaid(state: DocState, opts: { includeProposed?: boolean } = {}): string {
  const lines = ["flowchart LR"];
  const shown = new Map<string, ComponentVisibility>();
  for (const id of state.order.components) {
    const c = state.components[id]!;
    const v = componentVisibility(state, c);
    if (v === "retired" || (v === "proposed" && !opts.includeProposed)) continue;
    shown.set(id, v);
    const [l, r] = SHAPES[c.type];
    const suffix = v === "tbd" ? " (TBD)" : v === "proposed" ? " (proposed)" : "";
    lines.push(`  ${mermaidId(id)}${l}"${mermaidText(c.name + suffix)}"${r}`);
  }
  for (const id of state.order.edges) {
    const e = state.edges[id]!;
    const v = edgeVisibility(state, e);
    if (v === "retired" || (v === "proposed" && !opts.includeProposed)) continue;
    if (!shown.has(e.from) || !shown.has(e.to)) continue;
    const arrow = v === "active" ? "-->" : "-.->";
    const label = e.label ? `|"${mermaidText(e.label)}"|` : "";
    lines.push(`  ${mermaidId(e.from)} ${arrow}${label} ${mermaidId(e.to)}`);
  }
  lines.push("  classDef tbd stroke-dasharray: 5 5,stroke:#b7791f,color:#7b5a12,fill:#fffaf0;");
  lines.push("  classDef proposed stroke-dasharray: 3 3,stroke:#999,color:#777,fill:#f4f4f4;");
  for (const [id, v] of shown) {
    if (v === "tbd") lines.push(`  class ${mermaidId(id)} tbd;`);
    if (v === "proposed") lines.push(`  class ${mermaidId(id)} proposed;`);
  }
  if (shown.size === 0) return "";
  return lines.join("\n");
}

function itemsOf(state: DocState, pred: (i: Item) => boolean): Item[] {
  return state.order.items.map((id) => state.items[id]!).filter(pred);
}

/** "(00:10:05)" or "(00:04:12, updated 00:07:00)". */
function cite(i: Item): string {
  const first = i.evidence[0]?.ts;
  const last = i.evidence.at(-1)?.ts;
  if (!first) return "";
  return last && last !== first ? ` _(${first}, updated ${last})_` : ` _(${first})_`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

function why(i: Item): string {
  return i.reason ? ` Why: ${sentence(i.reason)}` : "";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

export interface RenderOptions {
  /** Include the event log as a changelog section. */
  events?: ChangeEvent[];
}

/**
 * The design doc. Sections hold only the current truth; everything that was replaced,
 * turned down or settled lives in the decision log and the changelog below it.
 */
export function toMarkdown(state: DocState, opts: RenderOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${state.meeting.title || "Design doc (in progress)"}`, "");
  if (state.meeting.context) out.push(state.meeting.context, "");

  const decisions = itemsOf(state, (i) => i.kind === "decision" && LIVE.has(i.status));
  const tentative = decisions.filter((d) => d.status === "tentative").length;
  const questions = itemsOf(state, (i) => i.kind === "open_question" && i.status === "open");
  const actions = itemsOf(state, (i) => i.kind === "action_item" && i.status === "open");
  const lastTs = opts.events?.length ? opts.events.at(-1)!.ts : null;
  if (state.order.items.length) {
    const parts = [
      `${decisions.length} decision${decisions.length === 1 ? "" : "s"}${tentative ? ` (${tentative} tentative)` : ""}`,
      `${questions.length} open question${questions.length === 1 ? "" : "s"}`,
      `${actions.length} action item${actions.length === 1 ? "" : "s"}`,
    ];
    out.push(`> **Status${lastTs ? ` at ${lastTs}` : ""}:** ${parts.join(" · ")}`, "");
  }

  if (state.meeting.overview) out.push("## Summary", "", state.meeting.overview, "");

  const reqs = itemsOf(state, (i) => i.kind === "requirement" && LIVE.has(i.status));
  const nongoals = itemsOf(state, (i) => i.kind === "non_goal" && LIVE.has(i.status));
  const facts = itemsOf(state, (i) => i.kind === "fact" && i.status === "accepted");
  if (reqs.length || nongoals.length || facts.length) {
    out.push("## Requirements and constraints", "");
    const line = (i: Item, tag = "") => `- ${tag}${sentence(i.detail)}${cite(i)}`;
    if (reqs.length) out.push("**Goals**", "", ...reqs.map((i) => line(i, i.status === "tentative" ? "(Tentative) " : "")), "");
    if (nongoals.length) out.push("**Non-goals**", "", ...nongoals.map((i) => line(i)), "");
    if (facts.length) out.push("**Context**", "", ...facts.map((i) => line(i)), "");
  }

  const mermaid = toMermaid(state);
  const comps = state.order.components
    .map((id) => state.components[id]!)
    .map((c) => ({ c, v: componentVisibility(state, c) }))
    .filter(({ v }) => v === "active" || v === "tbd");
  if (mermaid || comps.length) {
    out.push("## Architecture", "");
    if (mermaid) out.push("```mermaid", mermaid, "```", "");
    for (const { c, v } of comps) out.push(`- **${c.name}**${v === "tbd" ? " (TBD)" : ""}: ${sentence(c.description)}`);
    out.push("");
  }

  if (decisions.length) {
    out.push("## Decisions", "");
    for (const d of decisions) {
      const tag = d.status === "tentative" ? " _(tentative)_" : "";
      out.push(`- **${d.title}**${tag}: ${sentence(d.detail)}${why(d)}${cite(d)}`);
    }
    out.push("");
  }

  if (questions.length) {
    out.push("## Open questions", "");
    for (const q of questions) out.push(`- **${q.title}**: ${sentence(q.detail)}${cite(q)}`);
    out.push("");
  }

  if (actions.length) {
    out.push("## Action items", "", "| Owner | Action | Due | Raised |", "|---|---|---|---|");
    for (const a of actions) {
      out.push(`| ${cell(a.owner ?? "Unassigned")} | ${cell(sentence(a.detail))} | ${cell(a.due ?? "—")} | ${a.evidence[0]?.ts ?? ""} |`);
    }
    out.push("");
  }

  const proposed = itemsOf(state, (i) => i.status === "proposed");
  if (proposed.length) {
    out.push("## Under discussion (not decided)", "");
    for (const p of proposed) out.push(`- **${p.title}**: ${sentence(p.detail)}${cite(p)}`);
    out.push("");
  }

  const closed = itemsOf(state, (i) => ["rejected", "superseded", "resolved"].includes(i.status) || (i.status === "dropped" && i.kind !== "action_item"));
  if (closed.length) {
    out.push("## Decision log", "", "Options considered and not kept, and questions settled during the meeting.", "");
    for (const i of closed) {
      const when = i.history.findLast((h) => h.field === "status")?.ts ?? i.evidence.at(-1)?.ts ?? "";
      let what: string = i.status;
      if (i.status === "superseded" && i.supersededBy) what = `superseded by "${state.items[i.supersededBy]?.title ?? i.supersededBy}"`;
      const reason = i.reason ? `: ${sentence(i.reason)}` : ".";
      out.push(`- **${i.title}**: ${what}${when ? ` at ${when}` : ""}${reason}`);
    }
    out.push("");
  }

  const log = (opts.events ?? []).filter(isNotable);
  if (log.length) {
    out.push("## Changelog", "");
    for (const e of log) out.push(`- \`${e.ts}\`${e.source === "human" ? " (edited in UI)" : ""} ${e.summary}`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * Changes worth a changelog line: how items moved (status changes, revisions,
 * supersessions, values revised during the discussion) and every human edit.
 * New items and diagram churn are visible in the doc itself.
 */
export function isNotable(e: ChangeEvent): boolean {
  if (e.source === "editor") return false;
  if (e.source === "human") return true;
  if (e.op === "update_item" || e.op === "supersede_item") return true;
  return e.op === "record_item" && /Revised during the discussion/.test(e.summary);
}
