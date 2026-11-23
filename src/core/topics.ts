/**
 * Derived views of the state, organised by topic. Pure functions with no Node
 * dependencies: the server renders markdown from them and the web UI renders the
 * document from them, so both always agree.
 */
import type { DocState, Item, Topic } from "./types.js";

export type TopicStatus =
  | "decided" // has an accepted decision
  | "tentative" // has a tentative decision (agreed for now)
  | "open" // explicitly undecided (open question, no decision)
  | "discussing" // options on the table, nothing agreed yet
  | "closed"; // nothing live left (everything rejected/resolved)

export interface TopicView {
  topic: Topic;
  status: TopicStatus;
  /** The current answer: the live (accepted or tentative) decision, if any. */
  decision: Item | null;
  /** Other live decisions in the topic (normally none; the reducer keeps one per topic). */
  extraDecisions: Item[];
  /** Options floated, not agreed yet. */
  proposals: Item[];
  /** Options turned down. */
  rejected: Item[];
  /** Earlier decisions replaced by a later one. */
  replaced: Item[];
  /** Open questions. */
  questions: Item[];
  /** Questions answered during the meeting. */
  resolved: Item[];
  /** Open action items. */
  actions: Item[];
  /** Live requirements, non-goals and facts filed under the topic. */
  notes: Item[];
  /** Items the agent marked low-confidence. */
  needsReview: Item[];
  firstTs: string;
  lastTs: string;
}

const LIVE = new Set(["accepted", "tentative"]);

export function isLive(i: Item): boolean {
  return LIVE.has(i.status);
}

function lastTs(items: Item[], fallback: string): string {
  return items.reduce((m, i) => (i.updatedAt > m ? i.updatedAt : m), fallback);
}

function view(topic: Topic, items: Item[]): TopicView {
  const decisions = items.filter((i) => i.kind === "decision");
  const live = decisions.filter(isLive);
  // The most recently changed live decision is the current answer.
  const sortedLive = [...live].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const decision = sortedLive[0] ?? null;
  const questions = items.filter((i) => i.kind === "open_question" && i.status === "open");
  const proposals = decisions.filter((i) => i.status === "proposed");
  let status: TopicStatus;
  if (decision) status = decision.status === "tentative" ? "tentative" : "decided";
  else if (questions.length) status = "open";
  else if (proposals.length) status = "discussing";
  else status = "closed";
  return {
    topic,
    status,
    decision,
    extraDecisions: sortedLive.slice(1),
    proposals,
    rejected: decisions.filter((i) => i.status === "rejected"),
    replaced: decisions.filter((i) => i.status === "superseded"),
    questions,
    resolved: items.filter((i) => i.kind === "open_question" && i.status === "resolved"),
    actions: items.filter((i) => i.kind === "action_item" && i.status === "open"),
    notes: items.filter((i) => ["requirement", "non_goal", "fact"].includes(i.kind) && (isLive(i) || i.status === "accepted")),
    needsReview: items.filter((i) => i.confidence === "low" && !["rejected", "superseded", "dropped"].includes(i.status)),
    firstTs: topic.createdAt,
    lastTs: lastTs(items, topic.updatedAt),
  };
}

/** All topics in the order they were first discussed. */
export function topicViews(state: DocState): TopicView[] {
  const byTopic = new Map<string, Item[]>();
  for (const id of state.order.items) {
    const i = state.items[id]!;
    if (i.topic && state.topics[i.topic]) {
      const list = byTopic.get(i.topic) ?? [];
      list.push(i);
      byTopic.set(i.topic, list);
    }
  }
  return state.order.topics.map((id) => view(state.topics[id]!, byTopic.get(id) ?? []));
}

/** Items not filed under a topic, grouped for the meeting-wide sections. */
export function meetingWide(state: DocState) {
  const items = state.order.items.map((id) => state.items[id]!).filter((i) => !i.topic || !state.topics[i.topic]);
  return {
    requirements: items.filter((i) => i.kind === "requirement" && isLive(i)),
    nonGoals: items.filter((i) => i.kind === "non_goal" && isLive(i)),
    facts: items.filter((i) => i.kind === "fact" && i.status === "accepted"),
    decisions: items.filter((i) => i.kind === "decision" && isLive(i)),
    proposals: items.filter((i) => i.kind === "decision" && i.status === "proposed"),
    questions: items.filter((i) => i.kind === "open_question" && i.status === "open"),
    actions: items.filter((i) => i.kind === "action_item" && i.status === "open"),
  };
}

/** Every open action item in the meeting, topic or not (for the action table). */
export function allOpenActions(state: DocState): Item[] {
  return state.order.items.map((id) => state.items[id]!).filter((i) => i.kind === "action_item" && i.status === "open");
}

export interface DocCounts {
  decided: number;
  tentative: number;
  open: number;
  actions: number;
  needsReview: number;
}

export function docCounts(state: DocState): DocCounts {
  const items = Object.values(state.items);
  return {
    decided: items.filter((i) => i.kind === "decision" && i.status === "accepted").length,
    tentative: items.filter((i) => i.kind === "decision" && i.status === "tentative").length,
    open: items.filter((i) => i.kind === "open_question" && i.status === "open").length,
    actions: items.filter((i) => i.kind === "action_item" && i.status === "open").length,
    needsReview: items.filter((i) => i.confidence === "low" && !["rejected", "superseded", "dropped", "resolved", "done"].includes(i.status)).length,
  };
}
