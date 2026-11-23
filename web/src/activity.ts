/**
 * The activity feed: change events phrased for people ("Secret storage changed —
 * secrets manager → KMS in Postgres"), newest first, with diagram edits folded together.
 */
import type { ChangeEvent, ChangeKind, DocState, Item, Utterance } from "../../src/core/types.js";
import { capitalize, splitTitle } from "./format.js";

export type Tone = "decided" | "proposed" | "rejected" | "replaced" | "open" | "resolved" | "action" | "note" | "diagram" | "human";

export interface ActivityEntry {
  key: string;
  seq: number;
  ts: string;
  tone: Tone;
  headline: string;
  detail: string | null;
  /** Old -> new, for reversals. */
  from: string | null;
  to: string | null;
  quote: { speaker: string | null; text: string; ts: string } | null;
  /** Where clicking takes you: an item or topic id in the doc. */
  target: string | null;
  human: boolean;
  count: number;
}

const KIND_FALLBACK: Record<string, ChangeKind> = {
  supersede_item: "replaced",
  confirm_item: "confirmed",
  upsert_topic: "noted",
  set_meeting_info: "noted",
  set_overview: "diagram",
  upsert_component: "diagram",
  remove_component: "diagram",
  upsert_edge: "diagram",
  remove_edge: "diagram",
};

export function eventKind(e: ChangeEvent): ChangeKind {
  return e.kind ?? KIND_FALLBACK[e.op] ?? "other";
}

function choice(i: Item | undefined): string {
  if (!i) return "";
  return capitalize(splitTitle(i.title).choice);
}

function subjectOf(state: DocState, i: Item | undefined): string | null {
  if (!i) return null;
  if (i.topic && state.topics[i.topic]) return state.topics[i.topic]!.title;
  return splitTitle(i.title).subject;
}

function quoteOf(e: ChangeEvent, transcript: Utterance[]): ActivityEntry["quote"] {
  const input = (e.input ?? {}) as { quote?: unknown; ts?: unknown };
  const text = typeof input.quote === "string" ? input.quote : null;
  if (!text || text === "edited in UI") return null;
  const ts = typeof input.ts === "string" ? input.ts : e.ts;
  const line = transcript.find((u) => u.ts === ts) ?? null;
  return { speaker: line?.speaker ?? null, text, ts };
}

const KIND_NOUN: Record<Item["kind"], string> = {
  requirement: "Requirement",
  non_goal: "Non-goal",
  fact: "Context",
  decision: "Decision",
  open_question: "Question",
  action_item: "Action",
};

function describe(e: ChangeEvent, state: DocState): Omit<ActivityEntry, "key" | "seq" | "ts" | "quote" | "human" | "count"> | null {
  const kind = eventKind(e);
  const items = e.targets.map((t) => state.items[t]).filter((x): x is Item => !!x);
  const item = items.at(-1);
  const subject = subjectOf(state, item);
  const target = item?.id ?? e.targets.find((t) => state.topics[t]) ?? null;
  switch (kind) {
    case "replaced": {
      const input = (e.input ?? {}) as { old_id?: string; new_id?: string; reason?: string };
      const oldI = state.items[input.old_id ?? e.targets[0] ?? ""];
      const newI = state.items[input.new_id ?? e.targets[1] ?? ""];
      const subj = subjectOf(state, newI ?? oldI);
      return {
        tone: "replaced",
        headline: subj ? `${subj} changed` : "Decision changed",
        detail: input.reason ?? null,
        from: choice(oldI) || null,
        to: choice(newI) || null,
        target: newI?.id ?? target,
      };
    }
    case "decided":
      return {
        tone: "decided",
        headline: item?.status === "tentative" ? `${subject ?? "Decision"}: agreed for now` : subject ? `${subject} decided` : "Decided",
        detail: choice(item),
        from: null,
        to: null,
        target,
      };
    case "proposed":
      return { tone: "proposed", headline: subject ? `Proposed for ${subject.toLowerCase()}` : "Proposed", detail: choice(item), from: null, to: null, target };
    case "rejected":
      return {
        tone: "rejected",
        headline: `${capitalize(choice(item) || "Option")} rejected`,
        detail: item?.reason ?? null,
        from: null,
        to: null,
        target,
      };
    case "revised":
      return {
        tone: "note",
        headline: subject ? `${subject} revised` : `${KIND_NOUN[item?.kind ?? "decision"]} revised`,
        detail: capitalize(choice(item)) || e.summary,
        from: null,
        to: null,
        target,
      };
    case "opened":
      return { tone: "open", headline: "Open question", detail: item?.title ?? e.summary, from: null, to: null, target };
    case "resolved":
      return { tone: "resolved", headline: "Question resolved", detail: item?.title ?? e.summary, from: null, to: null, target };
    case "action":
      if (item?.status === "done") return { tone: "resolved", headline: "Action done", detail: item.title, from: null, to: null, target };
      if (item?.status === "dropped") return { tone: "note", headline: "Action removed", detail: item.title, from: null, to: null, target: null };
      return { tone: "action", headline: item?.owner ? `Action for ${item.owner}` : "Action item", detail: item?.title ?? e.summary, from: null, to: null, target };
    case "confirmed":
      return { tone: "decided", headline: "Confirmed", detail: item?.title ?? e.summary, from: null, to: null, target };
    case "noted": {
      if (e.op === "upsert_topic") {
        const t = state.topics[e.targets[0] ?? ""];
        return { tone: "note", headline: "New topic", detail: t?.title ?? e.summary, from: null, to: null, target: t?.id ?? null };
      }
      if (e.op === "set_meeting_info") return { tone: "note", headline: "Meeting titled", detail: state.meeting.title || e.summary, from: null, to: null, target: null };
      return { tone: "note", headline: item ? `${KIND_NOUN[item.kind]} noted` : "Noted", detail: item?.title ?? e.summary, from: null, to: null, target };
    }
    case "diagram":
      return null; // folded separately
    default:
      return { tone: "note", headline: "Updated", detail: e.summary, from: null, to: null, target };
  }
}

function diagramPhrase(events: ChangeEvent[], state: DocState): string {
  const added: string[] = [];
  const removed: string[] = [];
  let edges = 0;
  let overview = false;
  for (const e of events) {
    if (e.op === "upsert_component") {
      const c = state.components[e.targets[0] ?? ""];
      const name = c?.name ?? ((e.input as { name?: string })?.name || "component");
      if (!added.includes(name)) added.push(name);
    } else if (e.op === "remove_component") {
      const c = state.components[e.targets[0] ?? ""];
      if (c && !removed.includes(c.name)) removed.push(c.name);
    } else if (e.op === "upsert_edge" || e.op === "remove_edge") edges++;
    else if (e.op === "set_overview") overview = true;
  }
  const parts: string[] = [];
  if (added.length) parts.push(`${added.slice(0, 3).join(", ")}${added.length > 3 ? ` +${added.length - 3}` : ""}`);
  if (removed.length) parts.push(`removed ${removed.slice(0, 2).join(", ")}${removed.length > 2 ? ` +${removed.length - 2}` : ""}`);
  if (edges && !parts.length) parts.push(`${edges} connection${edges === 1 ? "" : "s"}`);
  if (overview && !parts.length) parts.push("summary rewritten");
  return parts.join(" · ");
}

export function buildActivity(events: ChangeEvent[], state: DocState, transcript: Utterance[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  let run: ChangeEvent[] = [];
  const flush = () => {
    if (!run.length) return;
    const last = run.at(-1)!;
    const first = run[0]!;
    const detail = diagramPhrase(run, state);
    const onlyOverview = run.every((e) => e.op === "set_overview");
    out.push({
      key: `d${first.seq}`,
      seq: last.seq,
      ts: last.ts,
      tone: "diagram",
      headline: onlyOverview ? "Summary updated" : "Diagram",
      detail: onlyOverview ? null : detail || null,
      from: null,
      to: null,
      quote: null,
      target: onlyOverview ? "doc-summary" : "doc-diagram",
      human: run.some((e) => e.source === "human"),
      count: run.length,
    });
    run = [];
  };
  for (const e of events) {
    if (eventKind(e) === "diagram") {
      run.push(e);
      continue;
    }
    flush();
    const d = describe(e, state);
    if (!d) continue;
    const prev = out.at(-1);
    // The same item touched twice in a row reads as one change.
    if (prev && prev.headline === d.headline && prev.detail === d.detail && prev.target === d.target) {
      prev.seq = e.seq;
      prev.count++;
      prev.quote = quoteOf(e, transcript) ?? prev.quote;
      continue;
    }
    out.push({ ...d, key: `e${e.seq}`, seq: e.seq, ts: e.ts, quote: quoteOf(e, transcript), human: e.source === "human", count: 1 });
  }
  flush();
  return out.reverse();
}
