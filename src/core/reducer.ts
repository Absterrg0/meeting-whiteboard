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
  type SetMeetingInfo,
  type SupersedeItem,
  type UpdateItem,
  type UpsertComponent,
  type UpsertEdge,
} from "./ops.js";
import {
  ALLOWED_STATUSES,
  type ChangeEvent,
  type DocState,
  type Evidence,
  type HistoryEntry,
  type Item,
  type Utterance,
  formatTs,
  parseTs,
} from "./types.js";

export interface ApplyContext {
  source: "agent" | "human";
  /** Transcript so far; used for grounding agent operations. */
  transcript: Utterance[];
  /** Current meeting time in seconds (used for human edits, which have no quote). */
  meetingTime: number;
  seq: number;
  now?: () => string;
}

export type ApplyResult =
  | { ok: true; state: DocState; event: ChangeEvent }
  | { ok: false; error: string };

class OpError extends Error {}

function fail(msg: string): never {
  throw new OpError(msg);
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
    const { ts, targets, summary } = HANDLERS[op.name as OpName](state, parsed.data as never, ctx);
    const event: ChangeEvent = {
      seq: ctx.seq,
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
}
type Handler<T> = (state: DocState, input: T, ctx: ApplyContext) => HandlerResult;

/** Resolve evidence for an operation; agents must quote, humans are attributed to the UI. */
function evidenceFor(ctx: ApplyContext, ts: string | undefined, quote: string | undefined): Evidence {
  if (ctx.source === "human") {
    return { ts: formatTs(ctx.meetingTime), speaker: "(edited in UI)", quote: quote ?? "" };
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
  if (ctx.source !== "agent" || !item.pinned || item.pinnedAfterIdx === null) return;
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

const recordItem: Handler<RecordItem> = (state, input, ctx) => {
  if (state.items[input.id]) fail(`id '${input.id}' already exists; use update_item to change it`);
  checkStatus(input.kind, input.status);
  checkRelated(state, input.related);
  if (input.status === "superseded") fail("record the replacement and use supersede_item instead");
  const ev = evidenceFor(ctx, input.ts, input.quote);
  const item: Item = {
    id: input.id,
    kind: input.kind,
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
  state.items[item.id] = item;
  state.order.items.push(item.id);
  const owner = item.owner ? ` (owner: ${item.owner}${item.due ? `, due ${item.due}` : ""})` : "";
  return {
    ts: ev.ts,
    targets: [item.id],
    summary: `Added ${item.kind.replace("_", " ")} "${item.title}" as ${item.status}${owner}.${
      input.revised_from ? ` Revised during the discussion from: "${input.revised_from}".` : ""
    }`,
  };
};

const updateItem: Handler<UpdateItem> = (state, input, ctx) => {
  const item = getItem(state, input.id);
  const ev = evidenceFor(ctx, input.ts, input.quote);
  checkPinned(item, ctx, ev);
  if (input.status === "superseded") fail("use supersede_item to supersede an item");
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
  if (input.related) item.related = [...new Set([...item.related, ...input.related])];
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
  } else if (statusChanged) {
    item.reason = input.reason;
  } else if (detailChanged) {
    item.reason = null;
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
  if (!["accepted", "tentative", "open"].includes(newItem.status)) {
    fail(`replacement '${newItem.id}' must be accepted, tentative or open (it is ${newItem.status}); update it first`);
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
  oldItem.reason = input.reason;
  oldItem.evidence.push(ev);
  oldItem.updatedAt = ev.ts;
  if (!newItem.supersedes.includes(oldItem.id)) newItem.supersedes.push(oldItem.id);
  pin(oldItem, ctx);
  return {
    ts: ev.ts,
    targets: [oldItem.id, newItem.id],
    summary: `"${oldItem.title}" superseded by "${newItem.title}". Reason: ${input.reason}`,
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
  return { ts, targets: [input.id], summary: `Added component "${input.name}" (${input.type}).` };
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
  return { ts: ev.ts, targets: [c.id], summary: `Removed component "${c.name}". Reason: ${input.reason}` };
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
  return { ts, targets: [eid], summary: `Connected ${a} → ${b} (${input.label}).` };
};

const removeEdge: Handler<RemoveEdge> = (state, input, ctx) => {
  const eid = `${input.from}->${input.to}`;
  const e = state.edges[eid];
  if (!e || e.removed) fail(`no active edge ${eid}`);
  const ts = formatTs(ctx.meetingTime);
  e.removed = true;
  e.updatedAt = ts;
  return { ts, targets: [eid], summary: `Removed connection ${eid}. Reason: ${input.reason}` };
};

const setMeetingInfo: Handler<SetMeetingInfo> = (state, input, ctx) => {
  const ev = evidenceFor(ctx, input.ts, input.quote);
  state.meeting = { title: input.title, context: input.context };
  return { ts: ev.ts, targets: [], summary: `Set doc title to "${input.title}".` };
};

const HANDLERS: { [N in OpName]: Handler<never> } = {
  set_meeting_info: setMeetingInfo as Handler<never>,
  record_item: recordItem as Handler<never>,
  update_item: updateItem as Handler<never>,
  supersede_item: supersedeItem as Handler<never>,
  upsert_component: upsertComponent as Handler<never>,
  remove_component: removeComponent as Handler<never>,
  upsert_edge: upsertEdge as Handler<never>,
  remove_edge: removeEdge as Handler<never>,
};
