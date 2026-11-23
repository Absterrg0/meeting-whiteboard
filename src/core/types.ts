/**
 * Core data model.
 *
 * The meeting's documentation is an explicit, typed state: a set of items
 * (decisions, open questions, action items, ...) plus the components and edges
 * of the architecture diagram. The agent never writes the document directly.
 * It emits operations; the reducer validates them and applies them, and the
 * design doc + diagram are pure projections of the resulting state.
 */

export interface Utterance {
  /** Seconds since meeting start. */
  t: number;
  /** "HH:MM:SS" as given in the transcript (or derived from t). */
  ts: string;
  speaker: string;
  text: string;
  /** Stable index in the transcript, assigned on ingest. */
  idx: number;
}

export const ITEM_KINDS = [
  "requirement", // goals / must-haves
  "non_goal",
  "fact", // constraints and numbers stated as context (e.g. expected volume)
  "decision", // a choice; may be proposed, accepted, tentative, rejected, superseded
  "open_question",
  "action_item",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = [
  "proposed", // floated, not agreed
  "accepted", // agreed by the group
  "tentative", // agreed for now, explicitly to be revisited
  "rejected", // considered and turned down
  "superseded", // was accepted, later replaced by another item
  "open", // open question / open action item
  "resolved", // open question answered
  "done", // action item completed
  "dropped", // no longer relevant (requirement removed, action cancelled)
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Which statuses make sense for which kind. Enforced by the reducer. */
export const ALLOWED_STATUSES: Record<ItemKind, readonly ItemStatus[]> = {
  requirement: ["accepted", "tentative", "proposed", "dropped", "superseded"],
  non_goal: ["accepted", "tentative", "proposed", "dropped", "superseded"],
  fact: ["accepted", "dropped", "superseded"],
  decision: ["proposed", "accepted", "tentative", "rejected", "superseded"],
  open_question: ["open", "resolved", "dropped"],
  action_item: ["open", "done", "dropped"],
};

export interface Evidence {
  ts: string;
  speaker: string;
  quote: string;
  /** Transcript index of the quoted utterance (absent for UI edits). */
  idx?: number;
}

/**
 * Who made a change: the scribe agent (items, from the transcript), the editor agent
 * (diagram and overview, from the items), or a human in the UI.
 */
export type Source = "agent" | "editor" | "human";

export interface HistoryEntry {
  /** Meeting timestamp at which the change happened. */
  ts: string;
  field: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  source: Source;
}

/**
 * A topic is one question the meeting is working on ("Which queue carries deliveries?").
 * Items hang off topics; a topic's status is derived from its items (see topics.ts),
 * and a topic can have at most one live (accepted/tentative) decision at a time, so a
 * reversal is always explicit: the new decision supersedes the old one.
 */
export interface Topic {
  id: string;
  title: string;
  /** The question the topic answers, in one line. */
  question: string;
  createdAt: string;
  updatedAt: string;
  evidence: Evidence[];
}

export interface Item {
  id: string;
  kind: ItemKind;
  /** Topic this item belongs to (null for meeting-wide requirements, facts, actions). */
  topic: string | null;
  /**
   * "low" when the agent was unsure (ambiguous agreement, unclear owner...). Shown as
   * "needs confirmation" until a human confirms it or the discussion makes it clear.
   */
  confidence: "high" | "low";
  title: string;
  /** Current statement of the item, written as documentation (1-3 sentences). */
  detail: string;
  status: ItemStatus;
  /** Why it was decided / rejected / superseded. */
  reason: string | null;
  owner: string | null;
  due: string | null;
  supersedes: string[];
  supersededBy: string | null;
  /** Item ids this one relates to (e.g. a question that blocks a decision). */
  related: string[];
  evidence: Evidence[];
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
  /** Set when a human edited the item; the agent should leave it alone unless the discussion revisits it. */
  pinned: boolean;
  /**
   * Transcript length at the last human edit. The agent may change a pinned item only
   * with evidence from an utterance at or after this index (i.e. said after the edit).
   */
  pinnedAfterIdx: number | null;
}

export const COMPONENT_TYPES = [
  "service",
  "worker",
  "queue",
  "datastore",
  "external", // third party or customer-owned system
  "client", // users, UIs
  "infra", // proxies, gateways, networks
  "other",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export interface Component {
  id: string;
  name: string;
  type: ComponentType;
  description: string;
  /** Item ids that justify this component being in the architecture. */
  basis: string[];
  removed: boolean;
  removedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: string; // `${from}->${to}`
  from: string;
  to: string;
  label: string;
  basis: string[];
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingInfo {
  title: string;
  context: string;
  /** Short summary of the agreed design, written by the editor from live items only. */
  overview: string;
}

export interface DocState {
  meeting: MeetingInfo;
  topics: Record<string, Topic>;
  items: Record<string, Item>;
  components: Record<string, Component>;
  edges: Record<string, Edge>;
  /** Insertion order, for stable rendering. */
  order: { topics: string[]; items: string[]; components: string[]; edges: string[] };
}

/** What a change means to a reader (drives the activity feed). */
export type ChangeKind =
  | "decided" // a decision accepted or made tentative
  | "proposed"
  | "rejected"
  | "replaced" // superseded by another decision
  | "revised" // detail/value changed
  | "opened" // open question raised
  | "resolved" // open question answered
  | "action" // action item added/changed
  | "noted" // requirement, non-goal, fact, topic, meeting info
  | "confirmed" // low-confidence item confirmed
  | "diagram" // editor: components, edges, overview
  | "undo" // a human undid a change
  | "other";

export interface ChangeEvent {
  seq: number;
  kind: ChangeKind;
  /** Meeting timestamp the change is attributed to. */
  ts: string;
  /** Wall-clock ISO time it was applied. */
  at: string;
  source: Source;
  op: string;
  /** Ids touched. */
  targets: string[];
  /** One-line human-readable description, used in the changelog. */
  summary: string;
  /** The raw operation input, for replay/audit. */
  input: unknown;
  /** Set when the change was undone (it is skipped when the state is rebuilt). */
  reverted?: { at: string; by: number };
}

export function emptyState(): DocState {
  return {
    meeting: { title: "", context: "", overview: "" },
    topics: {},
    items: {},
    components: {},
    edges: {},
    order: { topics: [], items: [], components: [], edges: [] },
  };
}

export function formatTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function parseTs(ts: string): number {
  const parts = ts.trim().split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
