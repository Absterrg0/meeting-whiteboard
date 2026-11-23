/**
 * The reducer: validates one operation against the current state and applies it.
 * Pure apart from the clock. Every applied operation yields a ChangeEvent, so the
 * full history of the document is an append-only event log.
 */
import { ground } from "./grounding.js";
import {
  OPS,
  type Op,
  type OpName,
  type RecordItem,
  type RemoveComponent,
  type RemoveEdge,
  type ConfirmItem,
  type SetMeetingInfo,
  type SetOverview,
  type UpsertTopic,
  type SupersedeItem,
  type UpdateItem,
  type UpsertComponent,
  type UpsertEdge,
} from "./ops.js";
import {
  ALLOWED_STATUSES,
  type ChangeEvent,
  type ChangeKind,
  emptyState,
  type DocState,
  type Evidence,
  type HistoryEntry,
  type Item,
  type Source,
  type Utterance,
  formatTs,
  parseTs,
} from "./types.js";

export interface ApplyContext {
  source: Source;
  /** Transcript so far; used for grounding agent operations. */
  transcript: Utterance[];
  /** Current meeting time in seconds (used for human edits, which have no quote). */
  meetingTime: number;
  seq: number;
  now?: () => string;
  /**
   * Rebuilding from the event log: the agent-only guards (stale values, pinning) already
   * ran when the event was recorded, and links to items that no longer exist are dropped
   * instead of failing the whole event.
   */
  replaying?: boolean;
}

export type ApplyResult =
  | { ok: true; state: DocState; event: ChangeEvent }
  | { ok: false; error: string };

class OpError extends Error {}

function fail(msg: string): never {
  throw new OpError(msg);
}

/**
 * Rebuild the state as a fold over the event log, skipping reverted events. Each event is
 * re-validated by the same reducer; an event that no longer applies (it depended on one
 * that was undone) is returned in `dropped`. This is what makes undo exact.
 */
export function replay(
  events: ChangeEvent[],
  transcript: Utterance[],
  skip: Set<number>,
): { state: DocState; dropped: ChangeEvent[] } {
  let state = emptyState();
  const dropped: ChangeEvent[] = [];
  // Undo events name what they undid (also when reloaded from events.jsonl, without flags).
  const undone = new Set(skip);
  for (const e of events) {
    if (e.op !== "undo") continue;
    const input = e.input as { seq?: number; dependents?: number[] };
    if (typeof input.seq === "number") undone.add(input.seq);
    for (const d of input.dependents ?? []) undone.add(d);
  }
  for (const e of events) {
    if (e.reverted || undone.has(e.seq) || e.op === "undo") continue;
    const t = parseTs(e.ts);
    // Links to items that no longer exist are dropped rather than failing the event.
    const input = { ...(e.input as Record<string, unknown>) };
    for (const key of ["related", "basis"] as const) {
      if (Array.isArray(input[key])) {
        const kept = (input[key] as string[]).filter((id) => !!state.items[id]);
        if (key === "basis" && kept.length === 0) continue; // nothing left to justify it: the component goes
        input[key] = kept;
      }
    }
    const r = applyOp(state, { name: e.op, input } as Op, {
      source: e.source,
      // A human edit only "knows" the transcript said up to its time (for pinning).
      transcript: e.source === "human" ? transcript.filter((u) => u.t <= t) : transcript,
      meetingTime: t,
      seq: e.seq,
      now: () => e.at,
      replaying: true,
    });
    if (r.ok) state = r.state;
    else dropped.push(e);
  }
  return { state, dropped };
}

export function applyOp(prev: DocState, op: Op, ctx: ApplyContext): ApplyResult {
  const schema = OPS[op.name as OpName];
  if (!schema) return { ok: false, error: `unknown operation '${op.name}'` };
  const parsed = schema.safeParse(op.input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid input for ${op.name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const state = structuredClone(prev);
  try {
    const { ts, targets, summary, kind } = HANDLERS[op.name as OpName](state, parsed.data as never, ctx);
    const event: ChangeEvent = {
      seq: ctx.seq,
      kind,
      ts,
      at: (ctx.now ?? (() => new Date().toISOString()))(),
      source: ctx.source,
      op: op.name,
      targets,
      summary,
      input: parsed.data,
    };
    return { ok: true, state, event };
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    throw e;
  }
}

interface HandlerResult {
  ts: string;
  targets: string[];
  summary: string;
  kind: ChangeKind;
}
type Handler<T> = (state: DocState, input: T, ctx: ApplyContext) => HandlerResult;

/** Resolve evidence for an operation; agents must quote, humans are attributed to the UI. */
function evidenceFor(ctx: ApplyContext, ts: string | undefined, quote: string | undefined): Evidence {
  if (ctx.source === "human") {
    return { ts: formatTs(ctx.meetingTime), speaker: "(edited in UI)", quote: quote ?? "" };
  }
  if (ctx.source === "editor") {
    return { ts: formatTs(ctx.meetingTime), speaker: "(editor)", quote: quote ?? "" };
  }
  if (!ts || !quote) fail("ts and quote are required");
  const g = ground(ts, quote, ctx.transcript);
  if (!g.ok || !g.utterance) fail(g.error ?? "quote not found");
  return { ts: g.utterance.ts, speaker: g.utterance.speaker, quote, idx: g.utterance.idx };
}

function getItem(state: DocState, id: string): Item {
  const it = state.items[id];
  if (!it) fail(`no item with id '${id}'. Existing ids: ${Object.keys(state.items).join(", ") || "(none)"}`);
  return it;
}

function checkRelated(state: DocState, related: string[] | undefined) {
  for (const r of related ?? []) if (!state.items[r]) fail(`related id '${r}' does not exist`);
}

/** Statuses the model reaches for that mean the same as an allowed one. */
function normalizeStatus(kind: Item["kind"], status: Item["status"]): Item["status"] {
  if (kind === "decision" && status === "dropped") return "rejected";
  return status;
}

function checkStatus(kind: Item["kind"], status: Item["status"]) {
  if (!ALLOWED_STATUSES[kind].includes(status)) {
    fail(`status '${status}' is not valid for a ${kind}; use one of: ${ALLOWED_STATUSES[kind].join(", ")}`);
  }
}

/**
 * A human edit pins an item. The agent may still change it, but only based on
 * something said after the human edit (i.e. the team revisited it).
 */
function checkPinned(item: Item, ctx: ApplyContext, ev: Evidence) {
  if (ctx.replaying || ctx.source !== "agent" || !item.pinned || item.pinnedAfterIdx === null) return;
  if ((ev.idx ?? -1) < item.pinnedAfterIdx) {
    fail(
      `item '${item.id}' was set by a human after the line at index ${item.pinnedAfterIdx - 1}; only change it if the discussion revisits it after that`,
    );
  }
}

function pin(item: Item, ctx: ApplyContext) {
  if (ctx.source !== "human") return;
  item.pinned = true;
  item.pinnedAfterIdx = ctx.transcript.length;
}

// "one" and "zero" are left out: "one queue per tenant" is not a value.
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

/** The numbers a text states, digits or words ("5", "five", "1.5"). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  // Digits may carry a unit suffix: 24h, 200ms, 10k, 5s, 3x, 99.9%.
  for (const m of text.toLowerCase().matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?=[a-z%]*\b)|\b([a-z]+)\b/g)) {
    if (m[1]) out.add(Number(m[1]));
    else if (m[2] && m[2] in NUMBER_WORDS) out.add(NUMBER_WORDS[m[2]]!);
  }
  return out;
}

/**
 * Stale-value guard. When a value is revised (3 days -> 5 days), the numbers that left
 * the statement must not survive in the item's title or rationale, where the doc would
 * still show them. Deterministic, so an old value can't linger whatever the model writes.
 */
function checkRetiredValues(before: string, after: string, places: { title: string; rationale: string | null }, ctx?: ApplyContext) {
  if (ctx?.replaying) return;
  const now = numbersIn(after);
  const retired = [...numbersIn(before)].filter((n) => !now.has(n));
  if (!retired.length) return;
  for (const [where, text] of [["title", places.title], ["rationale", places.rationale ?? ""]] as const) {
    const left = retired.filter((n) => numbersIn(text).has(n));
    if (left.length) {
      fail(
        `the replaced value ${left.join(", ")} still appears in the ${where} ("${text}"); state only the current value there (the old value is kept in the changelog automatically)`,
      );
    }
  }
}

function checkTopic(state: DocState, topic: string | null | undefined) {
  if (topic && !state.topics[topic]) {
    fail(`no topic '${topic}'. Create it with upsert_topic first. Existing topics: ${Object.keys(state.topics).join(", ") || "(none)"}`);
  }
}

/**
 * One live answer per topic: a topic can't have two accepted/tentative decisions at once,
 * so changing an answer is always an explicit supersede (or a rejection first).
 */
function checkOneLiveDecision(state: DocState, item: Pick<Item, "id" | "kind" | "status" | "topic">, except: string[] = []) {
  if (item.kind !== "decision" || !item.topic || !["accepted", "tentative"].includes(item.status)) return;
  const other = Object.values(state.items).find(
    (i) =>
      i.id !== item.id &&
      !except.includes(i.id) &&
      i.kind === "decision" &&
      i.topic === item.topic &&
      ["accepted", "tentative"].includes(i.status),
  );
  if (other) {
    fail(
      `topic '${item.topic}' already has a live decision '${other.id}' ("${other.title}"). If this replaces it, record this one as proposed and call supersede_item ${other.id} -> ${item.id}; if it is a separate choice, put it in its own topic`,
    );
  }
}

function itemKind(item: Item, statusChanged: boolean, detailChanged: boolean): ChangeKind {
  if (item.kind === "action_item") return "action";
  if (item.kind === "open_question") return item.status === "resolved" ? "resolved" : "opened";
  if (item.kind === "decision") {
    if (statusChanged || !detailChanged) {
      if (item.status === "accepted" || item.status === "tentative") return statusChanged ? "decided" : "revised";
      if (item.status === "proposed") return "proposed";
      if (item.status === "rejected") return "rejected";
      if (item.status === "superseded") return "replaced";
    }
    return "revised";
  }
  return detailChanged ? "revised" : "noted";
}

const upsertTopic: Handler<UpsertTopic> = (state, input, ctx) => {
  const ev = evidenceFor(ctx, input.ts, input.quote);
  const existing = state.topics[input.id];
  if (existing) {
    if (existing.title === input.title && existing.question === input.question) fail(`upsert_topic on '${input.id}' changes nothing`);
    existing.title = input.title;
    existing.question = input.question;
    existing.updatedAt = ev.ts;
    existing.evidence.push(ev);
    return { ts: ev.ts, targets: [input.id], summary: `Renamed topic to "${input.title}".`, kind: "noted" };
  }
  state.topics[input.id] = {
    id: input.id,
    title: input.title,
    question: input.question,
    createdAt: ev.ts,
    updatedAt: ev.ts,
    evidence: [ev],
  };
  state.order.topics.push(input.id);
  return { ts: ev.ts, targets: [input.id], summary: `New topic "${input.title}": ${input.question}`, kind: "noted" };
};

const confirmItem: Handler<ConfirmItem> = (state, input, ctx) => {
  const item = getItem(state, input.id);
  if (item.confidence === "high") fail(`'${item.id}' is not marked low-confidence`);
  const ev = evidenceFor(ctx, input.ts ?? formatTs(ctx.meetingTime), input.quote ?? (ctx.source === "agent" ? undefined : "confirmed"));
  item.confidence = "high";
  item.history.push({ ts: ev.ts, field: "confidence", from: "low", to: "high", reason: "confirmed", source: ctx.source });
  item.updatedAt = ev.ts;
  pin(item, ctx);
  return { ts: ev.ts, targets: [item.id], summary: `Confirmed "${item.title}".`, kind: "confirmed" };
};

const recordItem: Handler<RecordItem> = (state, input, ctx) => {
  if (state.items[input.id]) fail(`id '${input.id}' already exists; use update_item to change it`);
  checkStatus(input.kind, input.status);
  checkRelated(state, input.related);
  if (input.status === "superseded") fail("record the replacement and use supersede_item instead");
  const ev = evidenceFor(ctx, input.ts, input.quote);
  // A new topic can be created by its first item (saves a round-trip on the hot path).
  let createdTopic = false;
  if (input.topic && !state.topics[input.topic] && /^top-/.test(input.topic)) {
    // Title from topic_title, or from the slug itself ("top-delivery-queue" -> "Delivery queue").
    const fromSlug = input.topic.replace(/^top-/, "").replace(/-/g, " ");
    const title = input.topic_title ?? fromSlug.charAt(0).toUpperCase() + fromSlug.slice(1);
    state.topics[input.topic] = {
      id: input.topic,
      title,
      // No invented question: an item title is not one. Empty until the scribe gives one.
      question: input.topic_question ?? "",
      createdAt: ev.ts,
      updatedAt: ev.ts,
      evidence: [ev],
    };
    state.order.topics.push(input.topic);
    createdTopic = true;
  }
  checkTopic(state, input.topic);
  const item: Item = {
    id: input.id,
    kind: input.kind,
    topic: input.topic ?? null,
    confidence: input.confidence ?? "high",
    title: input.title,
    detail: input.detail,
    status: input.status,
    reason: input.reason ?? null,
    owner: input.owner ?? null,
    due: input.due ?? null,
    supersedes: [],
    supersededBy: null,
    related: input.related ?? [],
    evidence: [ev],
    history: [],
    createdAt: ev.ts,
    updatedAt: ev.ts,
    pinned: false,
    pinnedAfterIdx: null,
  };
  pin(item, ctx);
  if (input.revised_from && ctx.source === "agent") {
    checkRetiredValues(input.revised_from, item.detail, { title: item.title, rationale: item.reason }, ctx);
  }
  if (input.revised_from) {
    item.history.push({
      ts: ev.ts,
      field: "detail",
      from: input.revised_from,
      to: item.detail,
      reason: "revised during the discussion",
      source: ctx.source,
    });
  }
  // A reversal in one call: record as proposed, then supersede the old answer with it.
  const finalStatus = item.status;
  // A second live answer in a topic is never created. Without `replaces`, the new decision
  // is kept as a proposal (and the tool result says so), so the usual "record, then
  // supersede" sequence in one response works first time instead of costing a retry.
  let downgraded: string | null = null;
  if (!input.replaces && item.kind === "decision" && item.topic && ["accepted", "tentative"].includes(item.status)) {
    const live = Object.values(state.items).find(
      (i) => i.kind === "decision" && i.topic === item.topic && ["accepted", "tentative"].includes(i.status),
    );
    if (live) {
      item.status = "proposed";
      downgraded = live.id;
    }
  }
  if (input.replaces) {
    if (item.kind !== "decision") fail("replaces is only for decisions");
    item.status = "proposed";
  }
  checkOneLiveDecision(state, item);
  state.items[item.id] = item;
  state.order.items.push(item.id);
  if (input.replaces) {
    const old = getItem(state, input.replaces);
    // A replacement answers the same question: it belongs in the old answer's topic, even if
    // the model filed it under a new one (which is then left empty and not shown).
    if (old.topic) item.topic = old.topic;
    const r = supersedeItem(
      state,
      {
        old_id: input.replaces,
        new_id: item.id,
        new_status: finalStatus === "tentative" ? "tentative" : "accepted",
        reason: input.reason ?? "replaced by a later decision",
        ts: input.ts,
        quote: input.quote,
      },
      ctx,
    );
    return { ts: r.ts, targets: [input.replaces, item.id], summary: r.summary, kind: "replaced" };
  }
  const owner = item.owner ? ` (owner: ${item.owner}${item.due ? `, due ${item.due}` : ""})` : "";
  return {
    ts: ev.ts,
    targets: [item.id],
    summary: `Added ${item.kind.replace("_", " ")} "${item.title}" as ${item.status}${owner}.${
      input.revised_from ? ` Revised during the discussion from: "${input.revised_from}".` : ""
    }${
      downgraded
        ? ` Recorded as PROPOSED because topic '${item.topic}' already has the live answer '${downgraded}'. If this replaces it, call supersede_item ${downgraded} -> ${item.id}; if it is a separate choice, move it to its own topic (update_item topic).`
        : ""
    }`,
    kind: createdTopic ? (item.kind === "decision" && ["accepted", "tentative"].includes(item.status) ? "decided" : itemKind(item, false, false)) : input.revised_from ? "revised" : item.kind === "decision" && ["accepted", "tentative"].includes(item.status) ? "decided" : itemKind(item, false, false),
  };
};

const updateItem: Handler<UpdateItem> = (state, input, ctx) => {
  const item = getItem(state, input.id);
  const ev = evidenceFor(ctx, input.ts, input.quote);
  checkPinned(item, ctx, ev);
  if (input.status === "superseded") fail("use supersede_item to supersede an item");
  if (input.status) input.status = normalizeStatus(item.kind, input.status);
  if (input.status) checkStatus(item.kind, input.status);
  checkRelated(state, input.related);
  if (item.status === "superseded" && input.status !== undefined) {
    // Reviving a superseded item would leave both old and new values "decided".
    fail(
      `'${item.id}' was superseded by '${item.supersededBy}'; to go back to it, record the reversal as a new item and supersede '${item.supersededBy}'`,
    );
  }
  if (ctx.source === "agent" && item.status === "superseded") {
    fail(`item '${item.id}' is superseded by '${item.supersededBy}'; update that item instead`);
  }

  const changes: HistoryEntry[] = [];
  const fields = ["title", "detail", "status", "owner", "due"] as const;
  for (const f of fields) {
    const next = input[f];
    if (next === undefined) continue;
    const cur = item[f];
    if ((next ?? null) === (cur ?? null)) continue;
    changes.push({
      ts: ev.ts,
      field: f,
      from: cur ?? null,
      to: next ?? null,
      reason: input.reason,
      source: ctx.source,
    });
    (item as unknown as Record<string, unknown>)[f] = next ?? null;
  }
  if (input.topic !== undefined && (input.topic ?? null) !== item.topic) {
    // Moving an item into a topic that doesn't exist yet creates it (titled from its slug).
    if (input.topic && !state.topics[input.topic] && /^top-/.test(input.topic)) {
      const fromSlug = input.topic.replace(/^top-/, "").replace(/-/g, " ");
      state.topics[input.topic] = {
        id: input.topic,
        title: fromSlug.charAt(0).toUpperCase() + fromSlug.slice(1),
        question: "",
        createdAt: ev.ts,
        updatedAt: ev.ts,
        evidence: [ev],
      };
      state.order.topics.push(input.topic);
    }
    checkTopic(state, input.topic);
    changes.push({ ts: ev.ts, field: "topic", from: item.topic, to: input.topic ?? null, reason: input.reason, source: ctx.source });
    item.topic = input.topic ?? null;
  }
  if (input.confidence && input.confidence !== item.confidence) {
    changes.push({ ts: ev.ts, field: "confidence", from: item.confidence, to: input.confidence, reason: input.reason, source: ctx.source });
    item.confidence = input.confidence;
  }
  checkOneLiveDecision(state, item);
  if (input.related) item.related = [...new Set([...item.related, ...input.related])];
  // A rationale on its own is a real change (e.g. the reason for a fast-path rejection).
  const rationaleChanged = input.rationale !== undefined && (input.rationale ?? null) !== item.reason;
  if (rationaleChanged) {
    changes.push({ ts: ev.ts, field: "reason", from: item.reason, to: input.rationale ?? null, reason: input.reason, source: ctx.source });
  }
  if (changes.length === 0 && !input.related) fail(`update_item on '${item.id}' changes nothing`);

  // item.reason is the rationale shown in the doc. A status change (accept, reject,
  // resolve...) carries the rationale for the new status. A revised detail replaces the
  // rationale with the one given, or drops it: an old rationale may quote the old value.
  // The change reason itself always goes to history and the changelog.
  const statusChanged = changes.some((c) => c.field === "status");
  const detailChanged = changes.some((c) => c.field === "detail");
  if (ctx.source === "human") {
    if (input.rationale !== undefined) item.reason = input.rationale;
    else if (!item.reason && input.reason !== "edited in UI") item.reason = input.reason;
  } else if (input.rationale !== undefined) {
    item.reason = input.rationale;
  } else if (statusChanged && ["rejected", "dropped", "resolved"].includes(item.status)) {
    // Why it was turned down / closed is exactly what the doc should say.
    item.reason = input.reason;
  } else if (detailChanged) {
    item.reason = null;
  }
  // Accepting something keeps its rationale: "Priya agreed" is the reason for the
  // change (it goes to the changelog), not a reason the design is right.
  const detailChange = changes.find((c) => c.field === "detail");
  if (detailChange && ctx.source === "agent") {
    checkRetiredValues(detailChange.from ?? "", item.detail, { title: item.title, rationale: item.reason }, ctx);
  }
  item.history.push(...changes);
  item.evidence.push(ev);
  item.updatedAt = ev.ts;
  pin(item, ctx);

  const parts = changes.map((c) =>
    c.field === "detail" ? `detail: "${c.from}" → "${c.to}"` : `${c.field}: ${c.from ?? "—"} → ${c.to ?? "—"}`,
  );
  return {
    ts: ev.ts,
    targets: [item.id],
    summary: `Updated "${item.title}" (${parts.join("; ") || "links"}). Reason: ${input.reason}`,
    kind: itemKind(item, statusChanged, detailChanged),
  };
};

const supersedeItem: Handler<SupersedeItem> = (state, input, ctx) => {
  if (input.old_id === input.new_id) fail("old_id and new_id must differ");
  const oldItem = getItem(state, input.old_id);
  const newItem = getItem(state, input.new_id);
  const ev = evidenceFor(ctx, input.ts, input.quote);
  checkPinned(oldItem, ctx, ev);
  if (oldItem.status === "superseded") fail(`'${oldItem.id}' is already superseded by '${oldItem.supersededBy}'`);
  if (oldItem.status === "rejected") fail(`'${oldItem.id}' was rejected; it cannot also be superseded`);
  if (!["accepted", "tentative", "open", "proposed"].includes(newItem.status)) {
    fail(`replacement '${newItem.id}' is ${newItem.status}; it must be proposed, accepted or tentative`);
  }
  if (ctx.source === "agent") {
    checkRetiredValues(oldItem.detail, newItem.detail, { title: newItem.title, rationale: newItem.reason }, ctx);
  }
  if (!ALLOWED_STATUSES[oldItem.kind].includes("superseded")) {
    fail(`a ${oldItem.kind} cannot be superseded; resolve or drop it with update_item`);
  }
  oldItem.history.push({
    ts: ev.ts,
    field: "status",
    from: oldItem.status,
    to: "superseded",
    reason: input.reason,
    source: ctx.source,
  });
  oldItem.status = "superseded";
  oldItem.supersededBy = newItem.id;
  // The replacement answers the same question: same topic, and it becomes the live answer.
  if (oldItem.topic) newItem.topic = oldItem.topic;
  if (newItem.kind === "decision" && (newItem.status === "proposed" || input.new_status)) {
    const to = input.new_status ?? "accepted";
    if (newItem.status !== to) {
      newItem.history.push({ ts: ev.ts, field: "status", from: newItem.status, to, reason: input.reason, source: ctx.source });
      newItem.status = to;
      newItem.updatedAt = ev.ts;
    }
  } else if (newItem.status === "proposed") {
    newItem.status = "accepted";
  }
  checkOneLiveDecision(state, newItem, [oldItem.id]);
  oldItem.reason = input.reason;
  oldItem.evidence.push(ev);
  oldItem.updatedAt = ev.ts;
  if (!newItem.supersedes.includes(oldItem.id)) newItem.supersedes.push(oldItem.id);
  pin(oldItem, ctx);
  return {
    ts: ev.ts,
    targets: [oldItem.id, newItem.id],
    summary: `"${oldItem.title}" superseded by "${newItem.title}". Reason: ${input.reason}`,
    kind: "replaced",
  };
};

const upsertComponent: Handler<UpsertComponent> = (state, input, ctx) => {
  for (const b of input.basis) if (!state.items[b]) fail(`basis id '${b}' does not exist; record the item first`);
  const ts = formatTs(ctx.meetingTime);
  const existing = state.components[input.id];
  if (existing) {
    const wasRemoved = existing.removed;
    Object.assign(existing, {
      name: input.name,
      type: input.type,
      description: input.description,
      basis: [...new Set(input.basis)],
      removed: false,
      removedReason: null,
      updatedAt: ts,
    });
    return {
      ts,
      targets: [input.id],
      summary: `${wasRemoved ? "Restored" : "Updated"} component "${input.name}".`,
      kind: "diagram",
    };
  }
  state.components[input.id] = {
    id: input.id,
    name: input.name,
    type: input.type,
    description: input.description,
    basis: input.basis,
    removed: false,
    removedReason: null,
    createdAt: ts,
    updatedAt: ts,
  };
  state.order.components.push(input.id);
  return { ts, targets: [input.id], summary: `Added component "${input.name}" (${input.type}).` , kind: "diagram" };
};

const removeComponent: Handler<RemoveComponent> = (state, input, ctx) => {
  const c = state.components[input.id];
  if (!c) fail(`no component '${input.id}'`);
  if (c.removed) fail(`component '${input.id}' is already removed`);
  const ev = evidenceFor(ctx, input.ts, input.quote);
  c.removed = true;
  c.removedReason = input.reason;
  c.updatedAt = ev.ts;
  for (const e of Object.values(state.edges)) {
    if (!e.removed && (e.from === c.id || e.to === c.id)) {
      e.removed = true;
      e.updatedAt = ev.ts;
    }
  }
  return { ts: ev.ts, targets: [c.id], summary: `Removed component "${c.name}". Reason: ${input.reason}` , kind: "diagram" };
};

const upsertEdge: Handler<UpsertEdge> = (state, input, ctx) => {
  for (const end of [input.from, input.to]) {
    const c = state.components[end];
    if (!c) fail(`no component '${end}'; add it with upsert_component first`);
    if (c.removed) fail(`component '${end}' was removed`);
  }
  for (const b of input.basis) if (!state.items[b]) fail(`basis id '${b}' does not exist`);
  const ts = formatTs(ctx.meetingTime);
  const eid = `${input.from}->${input.to}`;
  const existing = state.edges[eid];
  if (existing) {
    Object.assign(existing, {
      label: input.label,
      basis: [...new Set(input.basis)],
      removed: false,
      updatedAt: ts,
    });
  } else {
    state.edges[eid] = {
      id: eid,
      from: input.from,
      to: input.to,
      label: input.label,
      basis: input.basis,
      removed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    state.order.edges.push(eid);
  }
  const a = state.components[input.from]!.name;
  const b = state.components[input.to]!.name;
  return { ts, targets: [eid], summary: `Connected ${a} → ${b} (${input.label}).` , kind: "diagram" };
};

const removeEdge: Handler<RemoveEdge> = (state, input, ctx) => {
  const eid = `${input.from}->${input.to}`;
  const e = state.edges[eid];
  if (!e || e.removed) fail(`no active edge ${eid}`);
  const ts = formatTs(ctx.meetingTime);
  e.removed = true;
  e.updatedAt = ts;
  return { ts, targets: [eid], summary: `Removed connection ${eid}. Reason: ${input.reason}` , kind: "diagram" };
};

const setMeetingInfo: Handler<SetMeetingInfo> = (state, input, ctx) => {
  const ev = evidenceFor(ctx, input.ts, input.quote);
  state.meeting = { ...state.meeting, title: input.title, context: input.context };
  return { ts: ev.ts, targets: [], summary: `Set doc title to "${input.title}".`, kind: "noted" };
};

const setOverview: Handler<SetOverview> = (state, input, ctx) => {
  if (ctx.source === "agent") fail("the overview is maintained by the editor");
  state.meeting.overview = input.overview.trim();
  return { ts: formatTs(ctx.meetingTime), targets: [], summary: "Updated the overview." , kind: "diagram" };
};

const HANDLERS: { [N in OpName]: Handler<never> } = {
  upsert_topic: upsertTopic as Handler<never>,
  confirm_item: confirmItem as Handler<never>,
  set_overview: setOverview as Handler<never>,
  set_meeting_info: setMeetingInfo as Handler<never>,
  record_item: recordItem as Handler<never>,
  update_item: updateItem as Handler<never>,
  supersede_item: supersedeItem as Handler<never>,
  upsert_component: upsertComponent as Handler<never>,
  remove_component: removeComponent as Handler<never>,
  upsert_edge: upsertEdge as Handler<never>,
  remove_edge: removeEdge as Handler<never>,
};
