import { describe, expect, it } from "vitest";
import { applyOp } from "../src/core/reducer.js";
import { ground, quoteMatches } from "../src/core/grounding.js";
import { Harness, TRANSCRIPT, decision } from "./helpers.js";

describe("record_item", () => {
  it("records a grounded item with evidence attributed to the speaker", () => {
    const h = new Harness().apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis"));
    const it = h.state.items["dec-redis"]!;
    expect(it.status).toBe("proposed");
    expect(it.evidence).toEqual([{ ts: "00:00:30", speaker: "Ben", quote: "What if we used Redis", idx: 1 }]);
    expect(it.pinned).toBe(false);
    expect(h.state.order.items).toEqual(["dec-redis"]);
    expect(h.events[0]!.op).toBe("record_item");
    expect(h.events[0]!.ts).toBe("00:00:30");
  });

  it("validates status per kind", () => {
    const h = new Harness();
    const bad = [
      { kind: "action_item", status: "accepted" },
      { kind: "open_question", status: "accepted" },
      { kind: "decision", status: "open" },
      { kind: "fact", status: "proposed" },
      { kind: "decision", status: "done" },
    ] as const;
    for (const b of bad) {
      const r = h.try("record_item", { id: "x-item", kind: b.kind, title: "Thing", detail: "Detail.", status: b.status, ts: "00:00:30", quote: "What if we used Redis" });
      expect(r.ok, `${b.kind}/${b.status}`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not valid for a/);
    }
    const ok = h.try("record_item", { id: "act-plan", kind: "action_item", title: "Migration plan", detail: "Write the migration plan.", status: "open", owner: "Cara", due: "Friday", ts: "00:08:20", quote: "I'll write the migration plan by Friday" });
    expect(ok.ok).toBe(true);
  });

  it("rejects duplicate ids, superseded-on-create, unknown related ids and malformed input", () => {
    const h = new Harness().apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis"));
    expect(h.try("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis")).ok).toBe(false);
    expect(h.try("record_item", decision("dec-other", "superseded", "00:01:30", "we're going with Redis")).ok).toBe(false);
    expect(h.try("record_item", decision("dec-other", "accepted", "00:01:30", "we're going with Redis", { related: ["q-nope"] })).ok).toBe(false);
    const r = h.try("record_item", decision("Bad Id!", "accepted", "00:01:30", "we're going with Redis"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid input/);
    expect(applyOp(h.state, { name: "nope" as never, input: {} as never }, h.ctx()).ok).toBe(false);
  });
});

describe("grounding", () => {
  it("rejects an agent op whose quote is not in the transcript and leaves state untouched", () => {
    const h = new Harness();
    const before = structuredClone(h.state);
    const r = h.try("record_item", decision("dec-kafka", "accepted", "00:01:30", "we're going with Kafka for everything"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
    expect(h.state).toEqual(before);
  });

  it("rejects ops without a quote and ops quoting the future", () => {
    const early = TRANSCRIPT.slice(0, 4);
    const h = new Harness(early);
    expect(h.try("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions")).ok).toBe(false);
  });

  it("tolerates punctuation/case differences and a slightly wrong timestamp", () => {
    expect(quoteMatches("ok we're going with redis", "OK, we're going with Redis. Sessions expire after 7 days.")).toBe(true);
    const g = ground("00:01:20", "we’re going with Redis", TRANSCRIPT);
    expect(g.ok).toBe(true);
    expect(g.utterance!.idx).toBe(3);
    // A wrong timestamp is tolerated only for an exact quote of 5+ words.
    expect(ground("00:00:01", "write the migration plan by Friday", TRANSCRIPT).utterance?.idx).toBe(9);
    expect(ground("00:00:01", "migration plan by Friday", TRANSCRIPT).ok).toBe(false);
    expect(ground("00:08:20", "we going", TRANSCRIPT).ok).toBe(false);
    expect(ground("00:00:01", "completely invented sentence here", TRANSCRIPT).ok).toBe(false);
  });

  it("human ops need no quote and are attributed to the UI at the meeting time", () => {
    const h = new Harness().apply(
      "record_item",
      { id: "req-sso", kind: "requirement", title: "SSO", detail: "Support SSO.", status: "accepted", ts: "", quote: "n/a" } as never,
      "human",
      125,
    );
    const it = h.state.items["req-sso"]!;
    expect(it.pinned).toBe(true);
    expect(it.evidence[0]).toMatchObject({ ts: "00:02:05", speaker: "(edited in UI)" });
  });
});

describe("update_item", () => {
  it("accepts a proposal and records history and reason", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis"))
      .apply("update_item", { id: "dec-redis", status: "accepted", reason: "Already run it", ts: "00:01:30", quote: "we're going with Redis" });
    const it = h.state.items["dec-redis"]!;
    expect(it.status).toBe("accepted");
    expect(it.reason).toBeNull(); // the change reason goes to history; rationale only when given
    expect(it.history).toEqual([
      { ts: "00:01:30", field: "status", from: "proposed", to: "accepted", reason: "Already run it", source: "agent" },
    ]);
    expect(it.evidence.map((e) => e.ts)).toEqual(["00:00:30", "00:01:30"]);
    expect(it.updatedAt).toBe("00:01:30");
  });

  it("rejects an option with the team's reason", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis"))
      .apply("update_item", { id: "dec-redis", status: "rejected", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    expect(h.state.items["dec-redis"]).toMatchObject({ status: "rejected", reason: "One less system" });
  });

  it("keeps the old value in history when a value is revised", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", { detail: "Sessions expire after 7 days." }))
      .apply("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", reason: "Customers asked for longer sessions", ts: "00:03:35", quote: "Fine, 14 days" });
    const it = h.state.items["dec-ttl"]!;
    expect(it.detail).toBe("Sessions expire after 14 days.");
    expect(it.history).toHaveLength(1);
    expect(it.history[0]).toMatchObject({ field: "detail", from: "Sessions expire after 7 days.", to: "Sessions expire after 14 days." });
    expect(h.events.at(-1)!.summary).toContain("7 days");
  });

  it("validates status against the item's kind and refuses no-op or superseded updates", () => {
    const h = new Harness()
      .apply("record_item", { id: "act-plan", kind: "action_item", title: "Migration plan", detail: "Write the plan.", status: "open", ts: "00:08:20", quote: "migration plan by Friday" });
    expect(h.try("update_item", { id: "act-plan", status: "accepted", reason: "because", ts: "00:08:20", quote: "migration plan by Friday" }).ok).toBe(false);
    expect(h.try("update_item", { id: "act-plan", status: "superseded", reason: "because", ts: "00:08:20", quote: "migration plan by Friday" }).ok).toBe(false);
    expect(h.try("update_item", { id: "act-plan", status: "open", reason: "because", ts: "00:08:20", quote: "migration plan by Friday" }).ok).toBe(false);
    expect(h.try("update_item", { id: "act-missing", status: "done", reason: "because", ts: "00:08:20", quote: "migration plan by Friday" }).ok).toBe(false);
    expect(h.try("update_item", { id: "act-plan", status: "done", reason: "Plan written", ts: "00:08:20", quote: "migration plan by Friday" }).ok).toBe(true);
  });
});

describe("supersede_item", () => {
  function redisThenPostgres() {
    return new Harness()
      .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis"))
      .apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions"));
  }

  it("marks the old item superseded and links both ways", () => {
    const h = redisThenPostgres().apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    const old = h.state.items["dec-redis"]!;
    expect(old).toMatchObject({ status: "superseded", supersededBy: "dec-postgres", reason: "One less system" });
    expect(old.history.at(-1)).toMatchObject({ field: "status", from: "accepted", to: "superseded" });
    expect(h.state.items["dec-postgres"]!.supersedes).toEqual(["dec-redis"]);
  });

  it("refuses invalid supersessions", () => {
    const h = redisThenPostgres();
    expect(h.try("supersede_item", { old_id: "dec-redis", new_id: "dec-redis", reason: "x x", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
    // A proposed replacement is promoted by the supersession (tested below); a rejected one is refused.
    h.apply("record_item", decision("dec-memcached", "proposed", "00:00:30", "What if we used Redis"));
    // Rejected items cannot be superseded.
    h.apply("update_item", { id: "dec-memcached", status: "rejected", reason: "nope", ts: "00:05:00", quote: "let's drop Redis" });
    expect(h.try("supersede_item", { old_id: "dec-memcached", new_id: "dec-postgres", reason: "x x", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
    // Open questions cannot be superseded.
    h.apply("record_item", { id: "q-region", kind: "open_question", title: "First region", detail: "Which region first.", status: "open", ts: "00:06:40", quote: "Which region do we deploy to first" });
    expect(h.try("supersede_item", { old_id: "q-region", new_id: "dec-postgres", reason: "x x", ts: "00:06:40", quote: "Which region do we deploy" }).ok).toBe(false);
    // Twice is an error, and a superseded item can only be changed by an explicit status change.
    h.apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    expect(h.try("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "again", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
    expect(h.try("update_item", { id: "dec-redis", detail: "Changed detail.", reason: "edit", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
  });
});

describe("pinned (human-edited) items", () => {
  function pinnedAt(meetingTime: number) {
    return new Harness()
      .apply("record_item", decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", { detail: "Sessions expire after 7 days." }))
      .apply("update_item", { id: "dec-ttl", detail: "Sessions expire after 10 days.", reason: "Corrected by facilitator", ts: "", quote: "edited in UI" }, "human", meetingTime);
  }

  it("a human edit pins the item and is recorded as a human history entry", () => {
    const h = pinnedAt(250);
    const it = h.state.items["dec-ttl"]!;
    expect(it.pinned).toBe(true);
    expect(it.history.at(-1)).toMatchObject({ source: "human", ts: "00:04:10", from: "Sessions expire after 7 days.", to: "Sessions expire after 10 days." });
  });

  it("rejects agent changes grounded at or before the human edit", () => {
    const h = pinnedAt(250);
    const r = h.try("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", reason: "Customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/by a human/);
    const s = h.try("supersede_item", { old_id: "dec-ttl", new_id: "dec-ttl", reason: "x x", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(s.ok).toBe(false);
  });

  it("allows agent changes grounded after the human edit", () => {
    const h = pinnedAt(210);
    const r = h.try("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", reason: "Customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.items["dec-ttl"]!.detail).toBe("Sessions expire after 14 days.");
  });

  it("blocks supersession of a pinned item grounded before the human edit", () => {
    const h = pinnedAt(320).apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions"));
    expect(h.try("supersede_item", { old_id: "dec-ttl", new_id: "dec-postgres", reason: "x x", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
    expect(h.try("supersede_item", { old_id: "dec-ttl", new_id: "dec-postgres", reason: "x x", ts: "00:05:30", quote: "Agreed, Postgres for sessions" }).ok).toBe(true);
  });
});

describe("components and edges", () => {
  function arch() {
    return new Harness()
      .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis"))
      .apply("upsert_component", { id: "cmp-api", name: "API", type: "service", description: "Serves requests.", basis: ["dec-redis"] })
      .apply("upsert_component", { id: "cmp-redis", name: "Redis", type: "datastore", description: "Session store.", basis: ["dec-redis"] })
      .apply("upsert_component", { id: "cmp-web", name: "Web", type: "client", description: "Browser.", basis: ["dec-redis"] })
      .apply("upsert_edge", { from: "cmp-api", to: "cmp-redis", label: "read sessions", basis: ["dec-redis"] })
      .apply("upsert_edge", { from: "cmp-web", to: "cmp-api", label: "calls", basis: ["dec-redis"] });
  }

  it("requires existing basis items and components", () => {
    const h = arch();
    expect(h.try("upsert_component", { id: "cmp-x", name: "X", type: "service", description: "X thing.", basis: ["dec-missing"] }).ok).toBe(false);
    expect(h.try("upsert_edge", { from: "cmp-api", to: "cmp-missing", label: "x", basis: ["dec-redis"] }).ok).toBe(false);
  });

  it("remove_component removes the component and every edge touching it", () => {
    const h = arch().apply("remove_component", { id: "cmp-redis", reason: "Sessions moved to Postgres", ts: "00:05:00", quote: "let's drop Redis" });
    expect(h.state.components["cmp-redis"]).toMatchObject({ removed: true, removedReason: "Sessions moved to Postgres" });
    expect(h.state.edges["cmp-api->cmp-redis"]!.removed).toBe(true);
    expect(h.state.edges["cmp-web->cmp-api"]!.removed).toBe(false);
    expect(h.try("remove_component", { id: "cmp-redis", reason: "again", ts: "00:05:00", quote: "let's drop Redis" }).ok).toBe(false);
    expect(h.try("upsert_edge", { from: "cmp-api", to: "cmp-redis", label: "x", basis: ["dec-redis"] }).ok).toBe(false);
  });

  it("remove_component must be grounded", () => {
    expect(arch().try("remove_component", { id: "cmp-redis", reason: "gone", ts: "00:05:00", quote: "nobody said this at all" }).ok).toBe(false);
  });

  it("upsert_component on a removed component restores it and replaces its basis", () => {
    const h = arch()
      .apply("remove_component", { id: "cmp-redis", reason: "gone", ts: "00:05:00", quote: "let's drop Redis" })
      .apply("record_item", decision("dec-cache", "accepted", "00:05:30", "Agreed, Postgres for sessions"))
      .apply("upsert_component", { id: "cmp-redis", name: "Redis", type: "datastore", description: "Cache.", basis: ["dec-cache"] });
    expect(h.state.components["cmp-redis"]).toMatchObject({ removed: false, basis: ["dec-cache"] });
    expect(h.events.at(-1)!.summary).toMatch(/Restored/);
  });

  it("remove_edge removes only that edge", () => {
    const h = arch().apply("remove_edge", { from: "cmp-web", to: "cmp-api", reason: "not needed" });
    expect(h.state.edges["cmp-web->cmp-api"]!.removed).toBe(true);
    expect(h.state.edges["cmp-api->cmp-redis"]!.removed).toBe(false);
    expect(h.try("remove_edge", { from: "cmp-web", to: "cmp-api", reason: "again" }).ok).toBe(false);
  });
});

describe("rationale on revisions", () => {
  const base = () =>
    new Harness().apply(
      "record_item",
      decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", {
        detail: "Sessions expire after 7 days.",
        reason: "7 days matches the mobile app",
      }),
    );

  it("drops a rationale that may quote the old value when only the detail changes", () => {
    const h = base().apply("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", reason: "Changed from 7 to 14 days: customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    const it = h.state.items["dec-ttl"]!;
    expect(it.reason).toBeNull();
    expect(it.history.at(-1)).toMatchObject({ field: "detail", from: "Sessions expire after 7 days.", reason: "Changed from 7 to 14 days: customers asked" });
  });

  it("uses the restated rationale when given", () => {
    const h = base().apply("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", rationale: "Customers asked for longer sessions", reason: "Changed from 7 to 14", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(h.state.items["dec-ttl"]!.reason).toBe("Customers asked for longer sessions");
  });

  it("refuses to revive a superseded item in place", () => {
    const h = base()
      .apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions"))
      .apply("supersede_item", { old_id: "dec-ttl", new_id: "dec-postgres", reason: "one less system", ts: "00:05:30", quote: "Agreed, Postgres for sessions" });
    expect(h.try("update_item", { id: "dec-ttl", status: "accepted", reason: "back again", ts: "00:08:20", quote: "Not deciding that today" }).ok).toBe(false);
    expect(h.try("update_item", { id: "dec-ttl", status: "accepted", reason: "back again" , ts: "", quote: "edited in UI" }, "human").ok).toBe(false);
  });
});

describe("stale-value guard", () => {
  const base = () =>
    new Harness().apply(
      "record_item",
      decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", { title: "Session lifetime: 7 days", detail: "Sessions expire after 7 days." }),
    );

  it("refuses a revision that leaves the old number in the title", () => {
    const r = base().try("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", reason: "customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/replaced value 7 still appears in the title/);
    const ok = base().try("update_item", { id: "dec-ttl", title: "Session lifetime: 14 days", detail: "Sessions expire after 14 days.", reason: "customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(ok.ok).toBe(true);
  });

  it("catches number words in the rationale", () => {
    const r = new Harness()
      .apply("record_item", decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", { title: "Session lifetime", detail: "Sessions expire after 7 days." }))
      .try("update_item", { id: "dec-ttl", detail: "Sessions expire after 14 days.", rationale: "seven felt too short", reason: "customers asked", ts: "00:03:35", quote: "Fine, 14 days" });
    expect(r.ok).toBe(false);
  });

  it("ignores numbers that did not change", () => {
    const h = new Harness().apply("record_item", decision("dec-r", "accepted", "00:01:30", "Sessions expire after 7 days", { title: "Retries for 24 hours", detail: "Retry for 24 hours, 3 attempts." }));
    expect(h.try("update_item", { id: "dec-r", detail: "Retry for 24 hours, 5 attempts.", reason: "more attempts", ts: "00:03:35", quote: "Fine, 14 days" }).ok).toBe(true);
  });
});

describe("topics", () => {
  const withTopic = () =>
    new Harness()
      .apply("upsert_topic", { id: "top-session-store", title: "Session store", question: "Where do sessions live?", ts: "00:00:30", quote: "What if we used Redis" })
      .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis", { topic: "top-session-store" }));

  it("keeps one live decision per topic: a second accepted answer is refused", () => {
    const r = withTopic().try("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions", { topic: "top-session-store" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already has a live decision 'dec-redis'.*supersede_item/);
  });

  it("supersede promotes a proposed replacement and keeps it in the topic", () => {
    const h = withTopic()
      .apply("record_item", decision("dec-postgres", "proposed", "00:05:00", "keep sessions in Postgres instead", { topic: "top-session-store" }))
      .apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "one less system", ts: "00:05:30", quote: "Agreed, Postgres for sessions" });
    expect(h.state.items["dec-postgres"]).toMatchObject({ status: "accepted", topic: "top-session-store" });
    expect(h.state.items["dec-redis"]!.status).toBe("superseded");
    expect(h.events.at(-1)!.kind).toBe("replaced");
  });

  it("supersede can make the replacement tentative and pulls an untopiced replacement into the topic", () => {
    const h = withTopic()
      .apply("record_item", decision("dec-postgres", "proposed", "00:05:00", "keep sessions in Postgres instead"))
      .apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", new_status: "tentative", reason: "one less system", ts: "00:05:30", quote: "Agreed, Postgres for sessions" });
    expect(h.state.items["dec-postgres"]).toMatchObject({ status: "tentative", topic: "top-session-store" });
  });

  it("refuses unknown topics and classifies events", () => {
    const h = withTopic();
    expect(h.try("record_item", decision("dec-x", "proposed", "00:05:00", "keep sessions in Postgres instead", { topic: "top-missing" })).ok).toBe(false);
    expect(h.events.map((e) => e.kind)).toEqual(["noted", "decided"]);
  });

  it("confirms low-confidence items", () => {
    const h = new Harness().apply("record_item", decision("dec-cache", "accepted", "00:01:30", "we're going with Redis", { confidence: "low" }));
    expect(h.state.items["dec-cache"]!.confidence).toBe("low");
    h.apply("confirm_item", { id: "dec-cache" }, "human");
    expect(h.state.items["dec-cache"]!.confidence).toBe("high");
    expect(h.events.at(-1)!.kind).toBe("confirmed");
  });
});
