/**
 * The document as the page shows it: one block per topic. Real topics come from the agent
 * (topicViews); decisions the agent has not filed under a topic are grouped into blocks by
 * their subject ("Delivery queue: SQS" and "Delivery queue: Kafka" are one block) and by
 * their supersede chain, so a reversal reads the same either way.
 */
import { docCounts, isLive, meetingWide, topicViews, type DocCounts, type TopicStatus } from "../../src/core/topics.js";
import type { DocState, Item } from "../../src/core/types.js";
import { splitTitle } from "./format.js";

export interface Block {
  key: string;
  /** Real topic id, or null for a block grouped from unfiled decisions. */
  topicId: string | null;
  title: string;
  question: string | null;
  status: TopicStatus;
  decision: Item | null;
  extraDecisions: Item[];
  proposals: Item[];
  /** Rejected and replaced options, oldest first. */
  considered: Item[];
  questions: Item[];
  resolved: Item[];
  actions: Item[];
  notes: Item[];
  needsReview: Item[];
  firstTs: string;
  lastTs: string;
  /** Every item id in the block (for highlight and scroll targets). */
  ids: string[];
}

export interface DocModel {
  blocks: Block[];
  questions: Item[];
  requirements: Item[];
  nonGoals: Item[];
  facts: Item[];
  actions: Item[];
  counts: DocCounts;
  /** Items to confirm, in document order. */
  needsReview: Item[];
}

const byTime = (a: Item, b: Item) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0);

function lowConfidence(i: Item): boolean {
  return i.confidence === "low" && !["rejected", "superseded", "dropped", "resolved", "done"].includes(i.status);
}

function finalOf(state: DocState, item: Item): Item {
  let cur = item;
  const seen = new Set<string>();
  while (cur.supersededBy && state.items[cur.supersededBy] && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = state.items[cur.supersededBy]!;
  }
  return cur;
}

function autoBlocks(state: DocState, decisions: Item[]): Block[] {
  const groups = new Map<string, Item[]>();
  for (const d of decisions) {
    const fin = finalOf(state, d);
    const subject = splitTitle(fin.title).subject ?? splitTitle(d.title).subject;
    const key = subject ? `s:${subject.toLowerCase()}` : `i:${fin.id}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  const blocks: Block[] = [];
  for (const [key, items] of groups) {
    const live = items.filter(isLive).sort(byTime).reverse();
    const decision = live[0] ?? null;
    const proposals = items.filter((i) => i.status === "proposed");
    const considered = items.filter((i) => i.status === "rejected" || i.status === "superseded").sort(byTime);
    const lead = decision ?? proposals[0] ?? items[0]!;
    const subject = splitTitle(lead.title).subject;
    let status: TopicStatus = "closed";
    if (decision) status = decision.status === "tentative" ? "tentative" : "decided";
    else if (proposals.length) status = "discussing";
    const times = items.map((i) => i.createdAt).sort();
    const updates = items.map((i) => i.updatedAt).sort();
    blocks.push({
      key: `auto:${key}`,
      topicId: null,
      title: subject ?? lead.title,
      question: null,
      status,
      decision,
      extraDecisions: live.slice(1),
      proposals,
      considered,
      questions: [],
      resolved: [],
      actions: [],
      notes: [],
      needsReview: items.filter(lowConfidence),
      firstTs: times[0] ?? "",
      lastTs: updates.at(-1) ?? "",
      ids: items.map((i) => i.id),
    });
  }
  return blocks;
}

export function buildDoc(state: DocState): DocModel {
  // Topics with no items (e.g. left empty when a replacement moved into the original topic) aren't shown.
  const views = topicViews(state).filter((v) => state.order.items.some((id) => state.items[id]?.topic === v.topic.id));
  const wide = meetingWide(state);
  const blocks: Block[] = views.map((v) => {
    const items = state.order.items.map((id) => state.items[id]!).filter((i) => i.topic === v.topic.id);
    return {
      key: v.topic.id,
      topicId: v.topic.id,
      title: v.topic.title,
      question: v.topic.question || null,
      status: v.status,
      decision: v.decision,
      extraDecisions: v.extraDecisions,
      proposals: v.proposals,
      considered: [...v.rejected, ...v.replaced].sort(byTime),
      questions: v.questions,
      resolved: v.resolved,
      actions: v.actions,
      notes: v.notes,
      needsReview: v.needsReview,
      firstTs: v.firstTs,
      lastTs: v.lastTs,
      ids: items.map((i) => i.id),
    };
  });
  const unfiled = state.order.items
    .map((id) => state.items[id]!)
    .filter((i) => i.kind === "decision" && (!i.topic || !state.topics[i.topic]));
  const auto = autoBlocks(state, unfiled);
  const all = [...blocks, ...auto].sort((a, b) => (a.firstTs < b.firstTs ? -1 : a.firstTs > b.firstTs ? 1 : 0));

  const order = state.order.items.map((id) => state.items[id]!);
  return {
    blocks: all,
    questions: wide.questions,
    requirements: wide.requirements,
    nonGoals: wide.nonGoals,
    facts: wide.facts,
    actions: order.filter((i) => i.kind === "action_item" && i.status === "open"),
    counts: docCounts(state),
    needsReview: order.filter(lowConfidence),
  };
}

export const STATUS_LABEL: Record<TopicStatus, string> = {
  decided: "Decided",
  tentative: "Tentative",
  open: "Open",
  discussing: "Discussing",
  closed: "Closed",
};
