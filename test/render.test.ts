import { describe, expect, it } from "vitest";
import { componentVisibility, toMarkdown, toMermaid } from "../src/core/render.js";
import { currentSections } from "../src/eval.js";
import { Harness, decision } from "./helpers.js";

function count(haystack: string, re: RegExp): number {
  return (haystack.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
}

describe("toMarkdown: revised values", () => {
  it("shows a value revised via update_item once in the current sections and the old value only in the changelog", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-ttl", "accepted", "00:01:30", "Sessions expire after 7 days", {
        title: "Session lifetime",
        detail: "Sessions expire after 7 days.",
      }))
      .apply("update_item", {
        id: "dec-ttl",
        detail: "Sessions expire after 14 days.",
        reason: "Customers asked for longer sessions",
        ts: "00:03:35",
        quote: "Fine, 14 days",
      });
    const md = toMarkdown(h.state, { events: h.events });
    const current = currentSections(md);
    expect(count(current, /14 days/)).toBe(1);
    expect(current).not.toMatch(/7 days/);
    const changelog = md.slice(md.indexOf("## Changelog"));
    expect(changelog).toMatch(/7 days/);
    expect(changelog).toMatch(/14 days/);
    // No decision-log entry: the item was revised, not replaced.
    expect(md).not.toMatch(/## Decision log/);
  });
});

describe("toMarkdown: sections by status", () => {
  it("puts rejected and superseded items in the decision log with reasons, not in Decisions", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis", { title: "Session store: Redis" }))
      .apply("record_item", decision("dec-memcached", "proposed", "00:00:30", "What if we used Redis", { title: "Session store: Memcached" }))
      .apply("update_item", { id: "dec-memcached", status: "rejected", reason: "No persistence", ts: "00:01:00", quote: "Redis works for me" })
      .apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions", { title: "Session store: Postgres" }))
      .apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    const md = toMarkdown(h.state);
    const current = currentSections(md);
    expect(current).toMatch(/Session store: Postgres/);
    expect(current).not.toMatch(/Memcached/);
    expect(current).not.toMatch(/Session store: Redis/);
    const log = md.slice(md.indexOf("## Decision log"));
    expect(log).toMatch(/~~Session store: Redis~~ \(superseded by "Session store: Postgres"\)/);
    expect(log).toMatch(/~~Session store: Memcached~~ \(rejected\)/);
    expect(log).toMatch(/Why: No persistence/);
    // The replacement links back to what it replaced (filtered out of "current" by the eval).
    expect(md).toMatch(/- Replaces: Session store: Redis/);
  });

  it("lists proposals as under discussion, tentative decisions as tentative, open questions and open actions", () => {
    const h = new Harness()
      .apply("record_item", decision("dec-redis", "proposed", "00:00:30", "What if we used Redis", { title: "Redis sessions" }))
      .apply("record_item", decision("dec-ttl", "tentative", "00:01:30", "Sessions expire after 7 days", { title: "Session lifetime" }))
      .apply("record_item", { id: "q-region", kind: "open_question", title: "First region", detail: "Which region first.", status: "open", ts: "00:06:40", quote: "Which region do we deploy to first" })
      .apply("record_item", { id: "act-plan", kind: "action_item", title: "Migration plan", detail: "Write the migration plan.", status: "open", owner: "Cara", due: "Friday", ts: "00:08:20", quote: "migration plan by Friday" });
    const md = toMarkdown(h.state);
    expect(md).toMatch(/## Under discussion \(not decided\)\n\n- \*\*Redis sessions\*\*/);
    expect(md).toMatch(/\*\*Session lifetime\*\* \(tentative, to revisit\)/);
    expect(md).toMatch(/## Open questions\n\n- \*\*First region\*\*/);
    expect(md).toMatch(/- \[ \] \*\*Cara\*\*: Write the migration plan\. \(due Friday\)/);
    expect(md).not.toMatch(/## Decisions\n\n- \*\*Redis sessions/);
  });
});

describe("toMermaid / architecture visibility", () => {
  function arch() {
    return new Harness()
      .apply("record_item", decision("dec-redis", "accepted", "00:01:30", "we're going with Redis"))
      .apply("record_item", decision("dec-api", "accepted", "00:01:30", "we're going with Redis"))
      .apply("upsert_component", { id: "cmp-api", name: "Session API", type: "service", description: "Serves sessions.", basis: ["dec-api"] })
      .apply("upsert_component", { id: "cmp-redis", name: "Redis", type: "datastore", description: "Session store.", basis: ["dec-redis"] })
      .apply("upsert_edge", { from: "cmp-api", to: "cmp-redis", label: "read sessions", basis: ["dec-redis"] });
  }

  it("draws accepted components and edges", () => {
    const m = toMermaid(arch().state);
    expect(m).toMatch(/^flowchart LR/);
    expect(m).toContain('cmp_api["Session API"]');
    expect(m).toContain('cmp_redis[("Redis")]');
    expect(m).toContain('cmp_api -->|"read sessions"| cmp_redis');
  });

  it("hides a component and its edges when its only basis is superseded", () => {
    const h = arch()
      .apply("record_item", decision("dec-postgres", "accepted", "00:05:30", "Agreed, Postgres for sessions"))
      .apply("supersede_item", { old_id: "dec-redis", new_id: "dec-postgres", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    const m = toMermaid(h.state);
    expect(m).toContain("Session API");
    expect(m).not.toMatch(/Redis/);
    expect(m).not.toMatch(/-->/);
    expect(componentVisibility(h.state, h.state.components["cmp-redis"]!)).toBe("retired");
    expect(toMarkdown(h.state)).not.toMatch(/\*\*Redis\*\*: Session store/);
  });

  it("hides a component and its edges when its only basis is rejected", () => {
    const h = arch().apply("update_item", { id: "dec-redis", status: "rejected", reason: "One less system", ts: "00:05:00", quote: "let's drop Redis" });
    const m = toMermaid(h.state);
    expect(m).not.toMatch(/Redis/);
    expect(m).not.toMatch(/-->/);
  });

  it("keeps a component visible while any basis item is still live", () => {
    const h = arch()
      .apply("upsert_component", { id: "cmp-redis", name: "Redis", type: "datastore", description: "Session store.", basis: ["dec-api"] })
      .apply("update_item", { id: "dec-redis", status: "rejected", reason: "x x x", ts: "00:05:00", quote: "let's drop Redis" });
    const m = toMermaid(h.state);
    expect(m).toContain("Redis");
    // The edge's own basis is rejected, so the edge goes even though both ends stay.
    expect(m).not.toMatch(/-->/);
  });

  it("renders open-question-only basis as TBD (dashed) in the diagram and doc", () => {
    const h = arch()
      .apply("record_item", { id: "q-log-store", kind: "open_question", title: "Log store", detail: "Where logs go.", status: "open", ts: "00:06:40", quote: "Which region do we deploy to first" })
      .apply("upsert_component", { id: "cmp-log-store", name: "Log store", type: "datastore", description: "Holds logs; choice open.", basis: ["q-log-store"] })
      .apply("upsert_edge", { from: "cmp-api", to: "cmp-log-store", label: "write logs", basis: ["q-log-store"] });
    const m = toMermaid(h.state);
    expect(m).toContain('cmp_log_store[("Log store (TBD)")]');
    expect(m).toContain("class cmp_log_store tbd;");
    expect(m).toContain('cmp_api -.->|"write logs"| cmp_log_store');
    expect(toMarkdown(h.state)).toMatch(/- \*\*Log store\*\* \(TBD\): Holds logs/);
    // Resolving the question without a live basis retires it.
    const r = h.apply("update_item", { id: "q-log-store", status: "resolved", reason: "Decided", ts: "00:06:40", quote: "Which region do we deploy to first" });
    expect(toMermaid(r.state)).not.toContain("Log store");
  });

  it("hides proposed-only components unless includeProposed", () => {
    const h = arch()
      .apply("record_item", decision("dec-kafka", "proposed", "00:00:30", "What if we used Redis"))
      .apply("upsert_component", { id: "cmp-kafka", name: "Kafka", type: "queue", description: "Event bus.", basis: ["dec-kafka"] })
      .apply("upsert_edge", { from: "cmp-api", to: "cmp-kafka", label: "publish", basis: ["dec-kafka"] });
    expect(toMermaid(h.state)).not.toContain("Kafka");
    expect(toMarkdown(h.state)).not.toMatch(/\*\*Kafka\*\*: Event bus/);
    const draft = toMermaid(h.state, { includeProposed: true });
    expect(draft).toContain('cmp_kafka[/"Kafka (proposed)"/]');
    expect(draft).toContain("class cmp_kafka proposed;");
    expect(draft).toContain('cmp_api -.->|"publish"| cmp_kafka');
  });

  it("returns an empty diagram when nothing is live, and omits removed components", () => {
    const h = arch().apply("remove_component", { id: "cmp-redis", reason: "gone", ts: "00:05:00", quote: "let's drop Redis" });
    expect(toMermaid(h.state)).not.toContain("Redis");
    const empty = new Harness().apply("record_item", decision("dec-xyz", "proposed", "00:00:30", "What if we used Redis"));
    expect(toMermaid(empty.state)).toBe("");
    expect(toMarkdown(empty.state)).not.toMatch(/## Architecture/);
  });
});
