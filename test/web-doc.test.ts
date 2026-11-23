import { describe, expect, it } from "vitest";
import { buildActivity } from "../web/src/activity.js";
import { buildDoc } from "../web/src/docModel.js";
import { Harness, decision } from "./helpers.js";

/** Redis, revised, then replaced by Postgres: the reversal the UI must read clearly. */
function reversal() {
  return new Harness()
    .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis", { title: "Session store: Redis" }))
    .apply("record_item", decision("dec-postgres", "proposed", "00:05:00", "keep sessions in Postgres", { title: "Session store: Postgres" }))
    .apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "One less system", ts: "00:05:30", quote: "Agreed, Postgres for sessions" });
}

describe("web doc model", () => {
  it("groups unfiled decisions into one block per subject, with the replaced option under Considered", () => {
    const h = reversal();
    const doc = buildDoc(h.state);
    expect(doc.blocks).toHaveLength(1);
    const b = doc.blocks[0]!;
    expect(b.title).toBe("Session store");
    expect(b.status).toBe("decided");
    expect(b.decision?.id).toBe("dec-postgres");
    expect(b.considered.map((i) => i.id)).toEqual(["dec-redis"]);
  });

  it("uses real topics when the agent files items under them", () => {
    const h = new Harness()
      .apply("upsert_topic", { id: "top-sessions", title: "Session storage", question: "Where do sessions live?", ts: "00:00:30", quote: "What if we used Redis" })
      .apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis", { title: "Session store: Redis", topic: "top-sessions" }))
      .apply("record_item", { id: "q-region", kind: "open_question", title: "Which region first?", detail: "Not decided today.", status: "open", ts: "00:06:40", quote: "Which region do we deploy to first?" });
    const doc = buildDoc(h.state);
    expect(doc.blocks.map((b) => [b.topicId, b.title, b.status])).toEqual([["top-sessions", "Session storage", "discussing"]]);
    expect(doc.questions.map((q) => q.id)).toEqual(["q-region"]);
  });
});

describe("web activity feed", () => {
  it("phrases a reversal as a change from the old option to the new one", () => {
    const h = reversal();
    const feed = buildActivity(h.events, h.state, h.transcript);
    const change = feed.find((e) => e.tone === "replaced")!;
    expect(change.headline).toBe("Session store changed");
    expect(change.from).toBe("Redis");
    expect(change.to).toBe("Postgres");
    expect(change.quote?.speaker).toBe("Ana");
    expect(feed[0]).toBe(change); // newest first
  });

  it("folds consecutive diagram edits into one entry", () => {
    const h = reversal()
      .apply("upsert_component", { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-postgres"] }, "editor")
      .apply("upsert_component", { id: "cmp-pg", name: "Postgres", type: "datastore", description: "Holds sessions.", basis: ["dec-postgres"] }, "editor")
      .apply("upsert_edge", { from: "cmp-api", to: "cmp-pg", label: "read sessions", basis: ["dec-postgres"] }, "editor");
    const feed = buildActivity(h.events, h.state, h.transcript);
    const diagram = feed.filter((e) => e.tone === "diagram");
    expect(diagram).toHaveLength(1);
    expect(diagram[0]!.count).toBe(3);
    expect(diagram[0]!.detail).toContain("API");
  });
});

describe("SSE state patches", () => {
  it("rebuilds the server's state from the previous one plus a patch of changed entities only", async () => {
    const { applyStatePatch, statePatch } = await import("../src/wire.js");
    const h = reversal();
    const seen = new Map<string, string>();
    statePatch(h.state, seen); // what a fresh client got in its full snapshot
    const before = h.state;
    h.apply("update_item", { id: "dec-postgres", detail: "Sessions live in Postgres.", reason: "clarified", ts: "00:05:30", quote: "Agreed, Postgres for sessions" });
    const patch = statePatch(h.state, seen)!;
    expect(Object.keys(patch.items ?? {})).toEqual(["dec-postgres"]);
    expect(patch.components).toBeUndefined();
    expect(applyStatePatch(before, patch)).toEqual(h.state);
    expect(statePatch(h.state, seen)).toBeUndefined();
  });
});
