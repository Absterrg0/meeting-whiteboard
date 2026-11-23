/**
 * Projections of the doc state. No model calls here: the document and the
 * diagram are deterministic functions of the state and the event log, so a
 * value that was replaced can never linger in the doc.
 */
import type { ChangeEvent, Component, DocState, Edge, Item } from "./types.js";

export type ComponentVisibility = "active" | "tbd" | "proposed" | "retired";

const LIVE = new Set(["accepted", "tentative"]);

export function componentVisibility(state: DocState, c: Component): ComponentVisibility {
  if (c.removed) return "retired";
  const basis = c.basis.map((b) => state.items[b]).filter((x): x is Item => !!x);
  if (basis.some((b) => LIVE.has(b.status))) return "active";
  if (basis.some((b) => b.kind === "open_question" && b.status === "open")) return "tbd";
  if (basis.some((b) => b.status === "proposed")) return "proposed";
  return "retired";
}

export function edgeVisibility(state: DocState, e: Edge): ComponentVisibility {
  if (e.removed) return "retired";
  const a = state.components[e.from];
  const b = state.components[e.to];
  if (!a || !b) return "retired";
  const va = componentVisibility(state, a);
  const vb = componentVisibility(state, b);
  if (va === "retired" || vb === "retired") return "retired";
  const basis = e.basis.map((id) => state.items[id]).filter((x): x is Item => !!x);
  const own: ComponentVisibility = basis.some((x) => LIVE.has(x.status))
    ? "active"
    : basis.some((x) => x.kind === "open_question" && x.status === "open")
      ? "tbd"
      : basis.some((x) => x.status === "proposed")
        ? "proposed"
        : "retired";
  if (own === "retired") return "retired";
  if (va === "proposed" || vb === "proposed" || own === "proposed") return "proposed";
  if (va === "tbd" || vb === "tbd" || own === "tbd") return "tbd";
  return "active";
}

function mermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidText(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "");
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
  let edgeIndex = 0;
  const dashed: number[] = [];
  for (const id of state.order.edges) {
    const e = state.edges[id]!;
    const v = edgeVisibility(state, e);
    if (v === "retired" || (v === "proposed" && !opts.includeProposed)) continue;
    if (!shown.has(e.from) || !shown.has(e.to)) continue;
    const arrow = v === "active" ? "-->" : "-.->";
    const label = e.label ? `|"${mermaidText(e.label)}"|` : "";
    lines.push(`  ${mermaidId(e.from)} ${arrow}${label} ${mermaidId(e.to)}`);
    if (v !== "active") dashed.push(edgeIndex);
    edgeIndex++;
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

function cite(i: Item): string {
  const first = i.evidence[0];
  const last = i.evidence[i.evidence.length - 1];
  if (!first) return "";
  if (!last || last.ts === first.ts) return ` _(${first.ts})_`;
  return ` _(${first.ts}; updated ${last.ts})_`;
}

function bullet(i: Item, extra = ""): string {
  return `- **${i.title}**${extra}: ${i.detail}${cite(i)}`;
}

export interface RenderOptions {
  /** Include the event log as a changelog section. */
  events?: ChangeEvent[];
  /** Optional narrative overview, generated separately from accepted state only. */
  overview?: string | null;
}

export function toMarkdown(state: DocState, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const title = state.meeting.title || "Design doc (in progress)";
  out.push(`# ${title}`, "");
  if (state.meeting.context) out.push(state.meeting.context, "");

  if (opts.overview) out.push("## Overview", "", opts.overview, "");

  const reqs = itemsOf(state, (i) => i.kind === "requirement" && LIVE.has(i.status));
  const nongoals = itemsOf(state, (i) => i.kind === "non_goal" && LIVE.has(i.status));
  const facts = itemsOf(state, (i) => i.kind === "fact" && i.status === "accepted");
  if (reqs.length || nongoals.length || facts.length) {
    out.push("## Requirements and constraints", "");
    if (reqs.length) out.push("**Goals**", "", ...reqs.map((i) => bullet(i, i.status === "tentative" ? " (tentative)" : "")), "");
    if (nongoals.length) out.push("**Non-goals**", "", ...nongoals.map((i) => bullet(i)), "");
    if (facts.length) out.push("**Context and numbers**", "", ...facts.map((i) => bullet(i)), "");
  }

  const mermaid = toMermaid(state);
  const comps = state.order.components
    .map((id) => state.components[id]!)
    .map((c) => ({ c, v: componentVisibility(state, c) }))
    .filter(({ v }) => v === "active" || v === "tbd");
  if (mermaid || comps.length) {
    out.push("## Architecture", "");
    if (mermaid) out.push("```mermaid", mermaid, "```", "");
    for (const { c, v } of comps) {
      out.push(`- **${c.name}**${v === "tbd" ? " (TBD)" : ""}: ${c.description}`);
    }
    out.push("");
  }

  const decisions = itemsOf(state, (i) => i.kind === "decision" && LIVE.has(i.status));
  if (decisions.length) {
    out.push("## Decisions", "");
    for (const d of decisions) {
      const tag = d.status === "tentative" ? " (tentative, to revisit)" : "";
      out.push(bullet(d, tag));
      if (d.reason) out.push(`  - Why: ${d.reason}`);
      for (const sid of d.supersedes) {
        const s = state.items[sid];
        if (s) out.push(`  - Replaces: ${s.title}`);
      }
    }
    out.push("");
  }

  const proposed = itemsOf(state, (i) => i.status === "proposed");
  if (proposed.length) {
    out.push("## Under discussion (not decided)", "", ...proposed.map((i) => bullet(i)), "");
  }

  const questions = itemsOf(state, (i) => i.kind === "open_question" && i.status === "open");
  if (questions.length) {
    out.push("## Open questions", "", ...questions.map((i) => bullet(i)), "");
  }

  const actions = itemsOf(state, (i) => i.kind === "action_item" && i.status === "open");
  if (actions.length) {
    out.push("## Action items", "");
    for (const a of actions) {
      const who = a.owner ?? "Unassigned";
      out.push(`- [ ] **${who}**: ${a.detail}${a.due ? ` (due ${a.due})` : ""}${cite(a)}`);
    }
    out.push("");
  }

  const log = itemsOf(state, (i) => ["rejected", "superseded", "dropped"].includes(i.status) || i.status === "resolved");
  if (log.length) {
    out.push("## Decision log", "", "Options that were considered and not kept, and questions that were settled.", "");
    for (const i of log) {
      let what: string = i.status;
      if (i.status === "superseded" && i.supersededBy) {
        const by = state.items[i.supersededBy];
        what = `superseded by "${by?.title ?? i.supersededBy}"`;
      }
      out.push(`- ~~${i.title}~~ (${what}): ${i.detail}${cite(i)}`);
      if (i.reason) out.push(`  - Why: ${i.reason}`);
    }
    out.push("");
  }

  if (opts.events?.length) {
    out.push("## Changelog", "");
    for (const e of opts.events) {
      if (!isNotable(e)) continue;
      out.push(`- \`${e.ts}\`${e.source === "human" ? " (human edit)" : ""} ${e.summary}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** Changes worth listing in the changelog (status changes, revisions, supersessions, removals). */
export function isNotable(e: ChangeEvent): boolean {
  return ["update_item", "supersede_item", "remove_component", "remove_edge", "record_item"].includes(e.op);
}
